import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
import { writeConventions } from "./conventions.ts";
import { runOpenCode } from "./opencode.ts";
import { validate, type ValidationResult } from "./validate.ts";
import { log } from "./log.ts";
import type { GameIdea } from "./ideate.ts";
import type { GameMeta } from "./games_index.ts";

export type StageName = "implement" | "critique" | "polish";

export type GenerateSuccess = {
  ok: true;
  sandbox: Sandbox;
  meta: GameMeta;
  shippedAfterStage: number;
  totalStages: number;
  stageHistory: StageRunResult[];
};

export type GenerateFailure = {
  ok: false;
  sandbox: Sandbox;
  errors: string[];
  stageHistory: StageRunResult[];
};

export type GenerateResult = GenerateSuccess | GenerateFailure;

export type StageRunResult = {
  stage: number;
  name: StageName;
  ok: boolean;
  attempts: number;
  errors: string[];
  durationMs: number;
};

export type GenerateOptions = {
  /** Override REFINE_STAGES from config (clamped to STAGE_DEFINITIONS.length). */
  maxStages?: number;
  /** Override STAGE_MAX_ATTEMPTS from config. */
  maxAttemptsPerStage?: number;
};

const STAGE_DEFINITIONS: { name: StageName; buildPrompt: (idea: GameIdea, attempt: number, lastErrors: string[]) => string }[] = [
  {
    name: "implement",
    buildPrompt: (idea, attempt, lastErrors) =>
      attempt === 1 ? buildImplementPrompt(idea) : buildRetryPrompt("implement", idea, lastErrors, attempt),
  },
  {
    name: "critique",
    buildPrompt: (idea, attempt, lastErrors) =>
      attempt === 1 ? buildCritiquePrompt(idea) : buildRetryPrompt("critique", idea, lastErrors, attempt),
  },
  {
    name: "polish",
    buildPrompt: (idea, attempt, lastErrors) =>
      attempt === 1 ? buildPolishPrompt(idea) : buildRetryPrompt("polish", idea, lastErrors, attempt),
  },
];

function buildImplementPrompt(idea: GameIdea): string {
  return [
    "Read the file CONVENTIONS.md in your working directory carefully before doing anything else.",
    "",
    "Then create the two required files (index.html and meta.json) for this game:",
    "",
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
    "",
    "Follow CONVENTIONS.md exactly, including the 'What makes a tiny canvas game feel good' rubric. Wrap your animation loop body in a try/catch so a stray bug does not crash the game.",
  ].join("\n");
}

function buildCritiquePrompt(idea: GameIdea): string {
  return [
    "You previously implemented this game in this directory. Now act as a player.",
    "",
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
    "",
    "Read your existing index.html in full. Mentally play the game from start to game-over.",
    "",
    "Identify exactly THREE specific gameplay weaknesses in your current implementation. Focus on:",
    "- Input feel: is the response immediate? Is movement smooth? Are controls intuitive?",
    "- Difficulty: is there a learning curve, or are you dropped straight into chaos? Can the player ever 'get good'?",
    "- Feedback: when the player succeeds or fails, do they SEE that happen via flash/particles/sound/screen-shake?",
    "- Win/lose state: is there a clear end? Can you restart without reloading the page (R key)?",
    "- Edge cases: what happens at boundaries, after losing, when objects pile up?",
    "- Dead time: is anything happening on screen while the player is just deciding what to do?",
    "",
    "Write a brief comment block at the top of index.html listing the 3 issues you found.",
    "",
    "Then fix all 3 issues by editing index.html in place. Do NOT recreate the file from scratch — preserve what works.",
    "If you change the game's controls or description significantly, also update meta.json so it stays consistent with the header in index.html.",
    "",
    "Re-read your updated file at the end to make sure it is complete and syntactically valid.",
  ].join("\n");
}

function buildPolishPrompt(idea: GameIdea): string {
  return [
    "Your game now plays well. Add a layer of 'juice' — the small touches that make it feel alive.",
    "",
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
    "",
    "Read your existing index.html, then EDIT IT IN PLACE to add (without breaking anything):",
    "",
    "1. **Clear win/lose screen** — overlay text on the canvas. Final score, restart instructions ('Press R to restart'). Add R-to-restart if missing.",
    "2. **Visual feedback on key events** — small flash, particle burst, or brief screen shake when the player scores, gets hit, or completes an objective.",
    "3. **Persistent score / progress UI** — drawn on canvas at top corner, always visible during play.",
    "4. **Subtle background animation** — if there is dead space on the canvas, add gentle motion (drifting stars, pulsing gradient, slow particle field).",
    "5. **WebAudio beeps** — short tones via OscillatorNode for hit/score/death events. CRITICAL: do not auto-start audio on page load. Initialize the AudioContext lazily inside the first keydown/click handler. Wrap audio code in try/catch so a failure never crashes the game.",
    "",
    "Apply ALL of these. After editing, re-read index.html to confirm the game still parses and runs. Update meta.json controls list if R-to-restart was added.",
  ].join("\n");
}

function buildRetryPrompt(stageName: StageName, idea: GameIdea, errors: string[], attempt: number): string {
  return [
    `Your previous ${stageName} attempt (attempt #${attempt - 1}) failed validation. Fix the issues by editing the existing files in place — do not start from scratch.`,
    "",
    "Validation errors:",
    ...errors.map((e) => `- ${e}`),
    "",
    "Game context (in case you need it):",
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
    "",
    "Re-read CONVENTIONS.md and your current files. Produce corrected index.html and meta.json that pass all validator checks.",
  ].join("\n");
}

async function snapshotStage(sandbox: Sandbox, stageNum: number): Promise<string> {
  const dir = join(sandbox.snapshotsDir, `stage-${stageNum}`);
  await mkdir(dir, { recursive: true });
  await copyFile(join(sandbox.dir, "index.html"), join(dir, "index.html"));
  await copyFile(join(sandbox.dir, "meta.json"), join(dir, "meta.json"));
  return dir;
}

async function restoreSnapshot(sandbox: Sandbox, snapshotDir: string): Promise<void> {
  await copyFile(join(snapshotDir, "index.html"), join(sandbox.dir, "index.html"));
  await copyFile(join(snapshotDir, "meta.json"), join(sandbox.dir, "meta.json"));
}

async function runStage(
  sandbox: Sandbox,
  idea: GameIdea,
  stageDef: (typeof STAGE_DEFINITIONS)[number],
  stageNum: number,
  maxAttempts: number,
): Promise<{ ok: boolean; meta?: GameMeta; errors: string[]; attempts: number; durationMs: number }> {
  const startedAt = Date.now();
  let lastErrors: string[] = [];
  let lastValidation: ValidationResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.info("stage: attempt starting", { stage: stageNum, name: stageDef.name, attempt, maxAttempts });

    const prompt = stageDef.buildPrompt(idea, attempt, lastErrors);
    const oc = await runOpenCode({ sandboxDir: sandbox.dir, prompt });
    if (oc.exitCode !== 0) {
      lastErrors = [
        `opencode exited with code ${oc.exitCode}${oc.timedOut ? " (TIMED OUT)" : ""}`,
        oc.stderr.slice(-800),
      ];
      log.warn("stage: opencode non-zero exit", { stage: stageNum, attempt, exitCode: oc.exitCode });
      continue;
    }

    lastValidation = await validate(sandbox.dir);
    if (lastValidation.ok && lastValidation.meta) {
      const durationMs = Date.now() - startedAt;
      log.info("stage: success", { stage: stageNum, name: stageDef.name, attempt, durationMs });
      return { ok: true, meta: lastValidation.meta, errors: [], attempts: attempt, durationMs };
    }
    lastErrors = lastValidation.errors;
    log.warn("stage: validation failed", { stage: stageNum, attempt, errorCount: lastErrors.length });
  }

  return {
    ok: false,
    errors: lastErrors,
    attempts: maxAttempts,
    durationMs: Date.now() - startedAt,
  };
}

export async function generateGame(idea: GameIdea, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const cfg = loadConfig();
  const totalStages = Math.min(opts.maxStages ?? cfg.REFINE_STAGES, STAGE_DEFINITIONS.length);
  const maxAttemptsPerStage = opts.maxAttemptsPerStage ?? cfg.STAGE_MAX_ATTEMPTS;

  const sandbox = await createSandbox(idea.slug);
  log.info("generate: sandbox created", { dir: sandbox.dir, slug: idea.slug, totalStages });

  await writeConventions(sandbox.dir, idea.slug);

  const stageHistory: StageRunResult[] = [];
  let lastGoodSnapshot: string | null = null;
  let lastGoodMeta: GameMeta | null = null;
  let shippedAfterStage = 0;

  for (let i = 0; i < totalStages; i++) {
    const stageDef = STAGE_DEFINITIONS[i]!;
    const stageNum = i + 1;
    const r = await runStage(sandbox, idea, stageDef, stageNum, maxAttemptsPerStage);
    stageHistory.push({
      stage: stageNum,
      name: stageDef.name,
      ok: r.ok,
      attempts: r.attempts,
      errors: r.errors,
      durationMs: r.durationMs,
    });

    if (r.ok && r.meta) {
      shippedAfterStage = stageNum;
      lastGoodMeta = r.meta;
      lastGoodSnapshot = await snapshotStage(sandbox, stageNum);
      log.info("generate: stage snapshot taken", { stage: stageNum, snapshot: lastGoodSnapshot });
      continue;
    }

    // Stage failed all retries
    if (lastGoodSnapshot && lastGoodMeta) {
      log.warn("generate: stage failed, restoring previous good snapshot", {
        failedStage: stageNum,
        restoringTo: shippedAfterStage,
      });
      await restoreSnapshot(sandbox, lastGoodSnapshot);
      // Stop refinement — don't try later stages on a known-broken pipeline
      break;
    }

    // First stage failed entirely — give up
    log.error("generate: first stage failed, no snapshot to restore", { errors: r.errors });
    return { ok: false, sandbox, errors: r.errors, stageHistory };
  }

  if (!lastGoodMeta) {
    return { ok: false, sandbox, errors: ["no stage succeeded"], stageHistory };
  }

  log.info("generate: success", {
    slug: idea.slug,
    shippedAfterStage,
    totalStages,
    history: stageHistory.map((s) => `${s.name}=${s.ok ? "ok" : "fail"}(${s.attempts}a, ${s.durationMs}ms)`).join(" -> "),
  });

  return {
    ok: true,
    sandbox,
    meta: lastGoodMeta,
    shippedAfterStage,
    totalStages,
    stageHistory,
  };
}

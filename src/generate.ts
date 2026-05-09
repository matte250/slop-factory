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
    "Read the file CONVENTIONS.md in your working directory carefully before doing anything else. Pay close attention to the 'Playable Contract' section — those rules are non-negotiable and the critique stage will explicitly check each one.",
    "",
    "Then create the two required files (index.html and meta.json) for this game:",
    "",
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
    "",
    "The mechanic described in the concept above MUST be the mechanic the player actually controls. Do not interpret loosely. Before you finish, re-read the concept and trace one frame mentally: does pressing the controls produce the effect the concept describes? If not, fix it.",
    "",
    "Follow CONVENTIONS.md exactly, including the dt-based physics example, the safe-spawn rule (no hazards on top of the player at t=0), the cancelAnimationFrame discipline on restart, and the visible Restart button.",
    "",
    "Wrap your animation loop body in a try/catch so a stray bug does not crash the game.",
  ].join("\n");
}

function buildCritiquePrompt(idea: GameIdea): string {
  return [
    "You previously implemented this game in this directory. Many past games have shipped with broken core mechanics that nobody caught. Your job in this stage is to verify the game is actually playable, then fix everything that isn't.",
    "",
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
    "",
    "Work through these four steps in order. Write your analysis as a JS comment block at the top of index.html so it is preserved with the code.",
    "",
    "## Step 1 — Trace the first 3 seconds with NO input",
    "",
    "Read the relevant code (player init, hazard spawn, update loop). Then write out the simulation as text:",
    "",
    "  t=0.0s: player position is X, hazards at [list], distances [list], time-to-impact for each [list]",
    "  t=1.0s: where will player be (no input)? where will each hazard be?",
    "  t=2.0s: same.",
    "  t=3.0s: same.",
    "",
    "Then answer: with NO INPUT from the player, would they die before t=2.0s?",
    "  - If YES: the spawn is too aggressive. Push hazards further away, define a SAFE_RADIUS, or skip spawns inside it for the first 3 seconds. Fix it.",
    "  - If the player can NEVER die regardless of input: the collision/end-condition is broken. Fix it.",
    "",
    "## Step 2 — Trace one frame of input",
    "",
    "For EACH control listed in meta.json:",
    "  - What state value does the keypress / click change? (be specific: ship.vx, ship.angle, isJumping, etc.)",
    "  - In the next frame, does that state change actually affect collision OR score outcomes?",
    "",
    "If any control is purely cosmetic (changes nothing collision-relevant), the game's mechanic is fundamentally broken — fix it so the input has a real gameplay effect that matches the concept.",
    "",
    "## Step 3 — Verify the playable contract",
    "",
    "For each item, write PASS or FAIL: <how>. Reference specific code:",
    "",
    "  1. Can the player lose? (collision/end condition that fires gameOver and stops the active loop)",
    "  2. Can the player score on discrete events? (not just elapsed time)",
    "  3. Does game-over draw final score on the canvas?",
    "  4. Does R-key reset state? Does the Restart button do the SAME thing?",
    "  5. Does restart cancelAnimationFrame the previous loop? (otherwise loops stack)",
    "  6. Are all physics scaled by dt (delta seconds)? Or are there per-frame constants like `x += 5`?",
    "  7. Is there visual feedback (flash/particle/shake) on death AND on score?",
    "  8. Does the implemented mechanic actually do what the concept describes?",
    "",
    "## Step 4 — Fix every FAIL",
    "",
    "Edit index.html in place to fix every FAIL from steps 1–3. Do NOT recreate the file from scratch — preserve what works. If you change controls or description, also update meta.json (the validator will reject mismatch).",
    "",
    "When done, re-read index.html to confirm it's syntactically valid. The next stage (polish) will assume the playable contract is met.",
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

    // Always validate, regardless of opencode's exit code. We proactively
    // kill opencode after seeing its terminal step_finish/stop event (workaround
    // for the upstream hang regression), so a non-zero exit is normal — what
    // matters is whether the files on disk are valid.
    lastValidation = await validate(sandbox.dir);
    if (lastValidation.ok && lastValidation.meta) {
      const durationMs = Date.now() - startedAt;
      log.info("stage: success", {
        stage: stageNum,
        name: stageDef.name,
        attempt,
        durationMs,
        exitCode: oc.exitCode,
        taskCompleted: oc.taskCompleted,
        timedOut: oc.timedOut,
      });
      return { ok: true, meta: lastValidation.meta, errors: [], attempts: attempt, durationMs };
    }

    lastErrors = lastValidation.errors;
    if (!oc.taskCompleted) {
      lastErrors = [
        `opencode did not signal task completion (exit ${oc.exitCode}${oc.timedOut ? ", HARD TIMEOUT" : ""})`,
        ...lastErrors,
      ];
    }
    log.warn("stage: validation failed", {
      stage: stageNum,
      attempt,
      exitCode: oc.exitCode,
      errorCount: lastErrors.length,
    });
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

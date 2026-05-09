import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
import { writeConventions } from "./conventions.ts";
import { runOpenCode } from "./opencode.ts";
import {
  consoleErrorCheck,
  validate,
  validateDesign,
  validateWithCritiqueBlock,
  type ValidationResult,
} from "./validate.ts";
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

type StageDef = {
  name: StageName;
  buildPrompt: (idea: GameIdea, attempt: number, lastErrors: string[]) => string;
  validate: (sandboxDir: string) => Promise<ValidationResult>;
  /**
   * If true, after the initial opencode run completes, load the page and
   * check for runtime/console errors. If any are found, resume the SAME
   * opencode session with the errors as a new turn and ask it to fix. Repeat
   * up to IMPLEMENT_CONSOLE_FIX_ITERATIONS times (from config). Only the
   * implement stage uses this — later stages have the full validate() loop
   * with retries that already covers regressions.
   */
  iterativeConsoleFix?: boolean;
};

const STAGE_DEFINITIONS: StageDef[] = [
  {
    name: "implement",
    buildPrompt: (idea, attempt, lastErrors) =>
      attempt === 1 ? buildImplementPrompt(idea) : buildRetryPrompt("implement", idea, lastErrors, attempt),
    validate,
    iterativeConsoleFix: true,
  },
  {
    name: "critique",
    buildPrompt: (idea, attempt, lastErrors) =>
      attempt === 1 ? buildCritiquePrompt(idea) : buildRetryPrompt("critique", idea, lastErrors, attempt),
    // critique must produce the analysis comment block as proof it actually ran
    validate: validateWithCritiqueBlock,
  },
  {
    name: "polish",
    buildPrompt: (idea, attempt, lastErrors) =>
      attempt === 1 ? buildPolishPrompt(idea) : buildRetryPrompt("polish", idea, lastErrors, attempt),
    // polish must preserve the critique block (forces it not to strip the comments)
    validate: validateWithCritiqueBlock,
  },
];

function buildDesignPrompt(idea: GameIdea): string {
  return [
    "Read the file CONVENTIONS.md in your working directory carefully before doing anything else.",
    "",
    "Then design the game described below. Do NOT write any HTML or JS code yet — only the design document.",
    "",
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
    "",
    "Write your design to a file called `DESIGN.md` in the working directory. It MUST contain these sections (use these exact headers; the validator checks for them):",
    "",
    "## Player",
    "- Starting position (e.g. canvas center, bottom edge)",
    "- Every state variable (position, velocity, rotation, score, lives, …)",
    "- For each control listed below, what state value it changes",
    "",
    "## Hazards",
    "- Each hazard type: appearance, where it spawns, when it spawns, how often, how it kills the player",
    "- Concrete numbers (spawn interval seconds, speeds in px/sec, sizes)",
    "",
    "## Score",
    "- The discrete event(s) that increase score (e.g. 'survived obstacle', 'collected pickup')",
    "- Win condition (if any) or 'survival only'",
    "",
    "## Game-over and restart",
    "- Exact end conditions",
    "- What state must the restart code path reset (everything)",
    "",
    "## Mechanic verification",
    "- Quote the concept verbatim",
    "- For the primary control, write: 'Press X → state change Y → next frame, collision/score check Z reads Y → outcome W'",
    "- Be honest. If the concept says 'mirrored gaps', the design must have TWO gaps per obstacle. If it says 'horizontal stretch fits narrow gaps', gaps must be horizontal. Confirm in writing that the design realizes the concept.",
    "",
    "## First 3 seconds (no input simulation)",
    "- t=0.0s: player at (X, Y). Hazards on screen: [list with positions]",
    "- t=1.0s: with NO INPUT, player at (X, Y). Hazards at [list]",
    "- t=2.0s: same",
    "- t=3.0s: same",
    "- Verdict: PASS (player still alive at t=3.0s with no input) or FAIL (must redesign — push hazards further away or define a SAFE_RADIUS)",
    "",
    "Keep DESIGN.md focused — the implement stage will read it and turn it into code, so be specific about numbers (px, seconds, sizes) but don't over-elaborate prose. After writing, do not start coding. The implement stage takes over from here.",
  ].join("\n");
}

function buildImplementPrompt(idea: GameIdea): string {
  return [
    "Read CONVENTIONS.md and then DESIGN.md (both in your working directory) carefully before doing anything else. The DESIGN.md was produced by the previous design stage and contains the agreed-upon mechanics, hazard rules, and first-3-seconds simulation.",
    "",
    "Now create the two required files (index.html and meta.json) for this game following both documents:",
    "",
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
    "",
    "Implement what DESIGN.md specifies. If something in DESIGN.md is missing or unclear, you may extend it, but you must not contradict the Mechanic verification section or the First 3 seconds simulation — those are the contract.",
    "",
    "Follow CONVENTIONS.md exactly: dt-based physics with the worked-example pattern, the safe-spawn rule (no hazards on top of the player at t=0 — match the simulation in DESIGN.md), cancelAnimationFrame discipline on restart, and the visible Restart button.",
    "",
    "Before you finish, re-read your code and confirm: pressing each control listed in meta.json actually changes a value that affects collision or score in the next frame. If not, fix it.",
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
    "Re-read DESIGN.md (in this directory) first — the implement stage was supposed to follow it.",
    "",
    "Work through the four steps below in order. You MUST wrap the entire analysis in a JS comment block at the top of index.html using these EXACT marker lines (the validator checks for them):",
    "",
    "  /* === CRITIQUE ANALYSIS — preserve through polish ===",
    "     Step 1: ...",
    "     Step 2: ...",
    "     Step 3: ...",
    "     Step 4: ...",
    "     === END CRITIQUE === */",
    "",
    "If those markers are missing the validator will reject the file and you will be retried.",
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
    "## Step 3 — Verify the playable contract AND the design match",
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
    "  9. Does the implementation match DESIGN.md? Specifically: hazard spawn rules, score event, mechanic verification, first-3-seconds simulation. Quote one mismatch if you find any.",
    "",
    "## Step 4 — Fix every FAIL",
    "",
    "Edit index.html in place to fix every FAIL from steps 1–3. Do NOT recreate the file from scratch — preserve what works. If you change controls or description, also update meta.json (the validator will reject mismatch).",
    "",
    "When done: re-read index.html to confirm it's syntactically valid AND that the `=== CRITIQUE ANALYSIS ===` / `=== END CRITIQUE ===` markers are present in your top-of-file comment block. The polish stage will preserve this block.",
  ].join("\n");
}

function buildPolishPrompt(idea: GameIdea): string {
  return [
    "Your game now plays well and the critique stage's analysis comment block is at the top of index.html. Add a layer of 'juice' — the small touches that make it feel alive — WITHOUT removing or rewriting the critique block.",
    "",
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
    "",
    "Read your existing index.html, then EDIT IT IN PLACE to add (without breaking anything):",
    "",
    "1. **Clear win/lose screen** — overlay text on the canvas. Final score, restart instructions ('Press R or click Restart').",
    "2. **Visual feedback on key events** — small flash, particle burst, or brief screen shake when the player scores, gets hit, or completes an objective.",
    "3. **Persistent score / progress UI** — drawn on canvas at top corner, always visible during play.",
    "4. **Subtle background animation** — if there is dead space on the canvas, add gentle motion (drifting stars, pulsing gradient, slow particle field).",
    "5. **WebAudio beeps** — short tones via OscillatorNode for hit/score/death events. CRITICAL: do not auto-start audio on page load. Initialize the AudioContext lazily inside the first keydown/click handler. Wrap audio code in try/catch so a failure never crashes the game.",
    "",
    "**CRITICAL: Preserve the `=== CRITIQUE ANALYSIS === ... === END CRITIQUE ===` comment block at the top of the file unchanged.** The validator will reject the file if those markers are missing.",
    "",
    "After editing, re-read index.html to confirm the game still parses, the critique block is intact, and the file is syntactically valid.",
  ].join("\n");
}

function buildRetryPrompt(stageName: StageName | "design", idea: GameIdea, errors: string[], attempt: number): string {
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

function buildConsoleFixPrompt(errors: string[], iter: number, maxIter: number): string {
  return [
    `Your previous output produced runtime errors when the page was loaded in a real browser. Fix them by editing the existing index.html in place — do not start over.`,
    "",
    "Console / runtime errors observed:",
    ...errors.map((e) => `- ${e}`),
    "",
    `This is fix iteration ${iter} of ${maxIter}. After editing, your output will be reloaded and re-checked. If errors persist after ${maxIter} iterations, this attempt will be abandoned.`,
    "",
    "Re-read your code, locate the line(s) responsible for each error above, and fix them. Pay particular attention to: undefined variables, accessing properties of null/undefined, async ordering, and AudioContext / canvas-context initialization timing.",
  ].join("\n");
}

async function runStage(
  sandbox: Sandbox,
  idea: GameIdea,
  stageDef: (typeof STAGE_DEFINITIONS)[number],
  stageNum: number,
  maxAttempts: number,
): Promise<{ ok: boolean; meta?: GameMeta; errors: string[]; attempts: number; durationMs: number }> {
  const cfg = loadConfig();
  const startedAt = Date.now();
  let lastErrors: string[] = [];
  let lastValidation: ValidationResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.info("stage: attempt starting", { stage: stageNum, name: stageDef.name, attempt, maxAttempts });

    const prompt = stageDef.buildPrompt(idea, attempt, lastErrors);
    const oc = await runOpenCode({ sandboxDir: sandbox.dir, prompt });

    // Iterative in-session fix loop: re-run the page, capture any console
    // errors, and resume the same opencode session asking the model to fix.
    // Only enabled for stages that opted in (currently: implement). Bounded
    // by IMPLEMENT_CONSOLE_FIX_ITERATIONS so a model that can't converge
    // doesn't burn forever.
    if (stageDef.iterativeConsoleFix && oc.sessionId) {
      const maxIter = cfg.IMPLEMENT_CONSOLE_FIX_ITERATIONS;
      let sid: string | undefined = oc.sessionId;
      for (let iter = 1; iter <= maxIter; iter++) {
        const errs = await consoleErrorCheck(sandbox.dir);
        if (errs.length === 0) {
          if (iter > 1) {
            log.info("stage: console-fix loop converged", {
              stage: stageNum, name: stageDef.name, attempt, iterationsUsed: iter - 1,
            });
          }
          break;
        }
        log.warn("stage: console errors found, resuming session to fix", {
          stage: stageNum, name: stageDef.name, attempt, iter, maxIter, errorCount: errs.length,
        });
        if (iter === maxIter) {
          log.warn("stage: console-fix budget exhausted; proceeding to validate anyway", {
            stage: stageNum, name: stageDef.name, attempt, maxIter,
          });
          break;
        }
        const fixPrompt = buildConsoleFixPrompt(errs, iter, maxIter);
        const ocFix = await runOpenCode({
          sandboxDir: sandbox.dir,
          prompt: fixPrompt,
          sessionId: sid,
        });
        sid = ocFix.sessionId ?? sid;
      }
    }

    // Always validate, regardless of opencode's exit code. We proactively
    // kill opencode after seeing its terminal step_finish/stop event (workaround
    // for the upstream hang regression), so a non-zero exit is normal — what
    // matters is whether the files on disk are valid.
    lastValidation = await stageDef.validate(sandbox.dir);
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

/**
 * Run the design stage. Always best-effort: if it fails after retries we log
 * and proceed without DESIGN.md. The implement prompt tolerates absence
 * (mentions DESIGN.md but still works on concept alone).
 */
async function runDesignStageBestEffort(
  sandbox: Sandbox,
  idea: GameIdea,
  maxAttempts: number,
): Promise<{ ok: boolean; durationMs: number; attempts: number }> {
  const startedAt = Date.now();
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.info("design: attempt starting", { attempt, maxAttempts });
    const prompt =
      attempt === 1
        ? buildDesignPrompt(idea)
        : buildRetryPrompt("design", idea, lastErrors, attempt);
    const oc = await runOpenCode({ sandboxDir: sandbox.dir, prompt });
    const v = await validateDesign(sandbox.dir);
    if (v.ok) {
      log.info("design: success", {
        attempt,
        durationMs: Date.now() - startedAt,
        taskCompleted: oc.taskCompleted,
      });
      return { ok: true, durationMs: Date.now() - startedAt, attempts: attempt };
    }
    lastErrors = v.errors;
    log.warn("design: validation failed", { attempt, errors: lastErrors });
  }

  // After exhausting attempts, remove any partial DESIGN.md so the implement
  // stage isn't misled by half-baked notes.
  try {
    await rm(join(sandbox.dir, "DESIGN.md"), { force: true });
  } catch {}

  log.warn("design: gave up; implement will work from concept alone", {
    durationMs: Date.now() - startedAt,
    attempts: maxAttempts,
  });
  return { ok: false, durationMs: Date.now() - startedAt, attempts: maxAttempts };
}

export async function generateGame(idea: GameIdea, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const cfg = loadConfig();
  const totalStages = Math.min(opts.maxStages ?? cfg.REFINE_STAGES, STAGE_DEFINITIONS.length);
  const maxAttemptsPerStage = opts.maxAttemptsPerStage ?? cfg.STAGE_MAX_ATTEMPTS;

  const sandbox = await createSandbox(idea.slug);
  log.info("generate: sandbox created", { dir: sandbox.dir, slug: idea.slug, totalStages });

  await writeConventions(sandbox.dir, idea.slug);

  // Design stage: think through the game on paper before writing any code.
  // Best-effort — if it fails after retries, implement still runs (without DESIGN.md).
  await runDesignStageBestEffort(sandbox, idea, Math.min(2, maxAttemptsPerStage));

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

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
import { formatExampleForPrompt, loadExampleFor } from "./examples.ts";
import { loadPrompt } from "./prompts.ts";
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
  /**
   * Async because the implement stage's first attempt loads a reference example
   * from disk to inject into the prompt; other stages return synchronously.
   */
  buildPrompt: (idea: GameIdea, attempt: number, lastErrors: string[]) => Promise<string>;
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
    buildPrompt: async (idea, attempt, lastErrors) =>
      attempt === 1 ? await buildImplementPrompt(idea) : buildRetryPrompt("implement", idea, lastErrors, attempt),
    validate,
    iterativeConsoleFix: true,
  },
  {
    name: "critique",
    buildPrompt: async (idea, attempt, lastErrors) =>
      attempt === 1 ? buildCritiquePrompt(idea) : buildRetryPrompt("critique", idea, lastErrors, attempt),
    // critique must produce the analysis comment block as proof it actually ran
    validate: validateWithCritiqueBlock,
  },
  {
    name: "polish",
    buildPrompt: async (idea, attempt, lastErrors) =>
      attempt === 1 ? buildPolishPrompt(idea) : buildRetryPrompt("polish", idea, lastErrors, attempt),
    // polish must preserve the critique block (forces it not to strip the comments)
    validate: validateWithCritiqueBlock,
  },
];

function buildDesignPrompt(idea: GameIdea): Promise<string> {
  return loadPrompt("design", { TITLE: idea.title, CONCEPT: idea.concept });
}

async function buildImplementPrompt(idea: GameIdea): Promise<string> {
  // Inject one genre-matched reference example as a structural anchor. The
  // example shows the LLM the exact section ordering and patterns to imitate;
  // critically, the prompt frames it as "imitate structure, not content."
  const example = await loadExampleFor(idea);
  log.info("implement: injecting reference example", { example: example.name });
  return loadPrompt("implement", {
    EXAMPLE_PRELUDE: formatExampleForPrompt(example),
    TITLE: idea.title,
    CONCEPT: idea.concept,
  });
}

function buildCritiquePrompt(idea: GameIdea): Promise<string> {
  return loadPrompt("critique", { TITLE: idea.title, CONCEPT: idea.concept });
}

function buildPolishPrompt(idea: GameIdea): Promise<string> {
  return loadPrompt("polish", { TITLE: idea.title, CONCEPT: idea.concept });
}

function buildRetryPrompt(
  stageName: StageName | "design",
  idea: GameIdea,
  errors: string[],
  attempt: number,
): Promise<string> {
  return loadPrompt("retry", {
    STAGE_NAME: stageName,
    ATTEMPT_PREVIOUS: String(attempt - 1),
    ERRORS_LIST: errors.map((e) => `- ${e}`).join("\n"),
    TITLE: idea.title,
    CONCEPT: idea.concept,
  });
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

function buildConsoleFixPrompt(errors: string[], iter: number, maxIter: number): Promise<string> {
  return loadPrompt("console-fix", {
    ERRORS_LIST: errors.map((e) => `- ${e}`).join("\n"),
    ITERATION: String(iter),
    MAX_ITERATIONS: String(maxIter),
  });
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

    const prompt = await stageDef.buildPrompt(idea, attempt, lastErrors);
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
        const fixPrompt = await buildConsoleFixPrompt(errs, iter, maxIter);
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
        ? await buildDesignPrompt(idea)
        : await buildRetryPrompt("design", idea, lastErrors, attempt);
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

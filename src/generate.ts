import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createSandbox, type Sandbox } from "./sandbox.ts";
import { writeConventions } from "./conventions.ts";
import { runOpenCode } from "./opencode.ts";
import {
  consoleErrorCheck,
  parseTasks,
  validate,
  validateDesign,
  validateTasks,
  type TaskItem,
} from "./validate/index.ts";
import { chooseExample, formatExampleForPrompt, loadExample } from "./examples.ts";
import { loadPrompt } from "./prompts.ts";
import { log } from "./log.ts";
import type { GameIdea } from "./ideate.ts";
import type { GameMeta } from "./games-index.ts";

export type GenerateSuccess = {
  ok: true;
  sandbox: Sandbox;
  meta: GameMeta;
  /** Number of implementation tasks completed. */
  taskCount: number;
};

export type GenerateFailure = {
  ok: false;
  sandbox: Sandbox;
  errors: string[];
  /** Phase where generation broke ("design" | "tasks" | "pick-example" | "implement"). */
  failedPhase?: string;
  /** Filled in once tasks phase completes. */
  taskCount?: number;
  /** Filled in once pick-example phase completes. */
  examplePick?: { name: string; reason: string };
};

export type GenerateResult = GenerateSuccess | GenerateFailure;

// === PROMPT BUILDERS =====================================================

function buildDesignPrompt(idea: GameIdea): Promise<string> {
  return loadPrompt("design", { TITLE: idea.title, CONCEPT: idea.concept });
}

function buildTasksPrompt(idea: GameIdea): Promise<string> {
  return loadPrompt("tasks", { TITLE: idea.title, CONCEPT: idea.concept });
}

async function buildImplementFirstPrompt(
  idea: GameIdea,
  task: TaskItem,
  taskTotal: number,
  exampleName: string,
): Promise<string> {
  const example = await loadExample(exampleName);
  log.info("implement: injecting reference example", { example: example.name });
  return loadPrompt("implement-first", {
    EXAMPLE_PRELUDE: formatExampleForPrompt(example),
    TITLE: idea.title,
    CONCEPT: idea.concept,
    TASK_TEXT: task.text,
    TASK_TOTAL: String(taskTotal),
  });
}

function buildImplementNextPrompt(
  task: TaskItem,
  taskNum: number,
  taskTotal: number,
): Promise<string> {
  return loadPrompt("implement-next", {
    TASK_NUM: String(taskNum),
    TASK_NUM_PREVIOUS: String(taskNum - 1),
    TASK_TOTAL: String(taskTotal),
    TASK_TEXT: task.text,
  });
}

/** What file the retry prompt should tell the model to produce. */
const STAGE_EXPECTED_OUTPUT: Record<"design" | "tasks", string> = {
  design:
    "DESIGN.md — a markdown file with the section headers required by the design prompt (## Concept, ## Player, ## Core loop, ## Hazards / Obstacles, ## Score, ## Win and lose, ## Feel, ## Why it's fun).",
  tasks:
    "TASKS.md — a numbered list of small implementation tasks, one per line, each line starting with '<number>.' (e.g. '1. HTML scaffold — ...'). At least 5 tasks; aim for 10–15.",
};

function buildRetryPrompt(
  stageName: "design" | "tasks",
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
    EXPECTED_OUTPUT: STAGE_EXPECTED_OUTPUT[stageName],
  });
}

function buildConsoleFixPrompt(errors: string[], iter: number, maxIter: number): Promise<string> {
  return loadPrompt("console-fix", {
    ERRORS_LIST: errors.map((e) => `- ${e}`).join("\n"),
    ITERATION: String(iter),
    MAX_ITERATIONS: String(maxIter),
  });
}

function buildValidateFixPrompt(errors: string[], iter: number, maxIter: number): Promise<string> {
  return loadPrompt("validate-fix", {
    ERRORS_LIST: errors.map((e) => `- ${e}`).join("\n"),
    ITERATION: String(iter),
    MAX_ITERATIONS: String(maxIter),
  });
}

function buildFileResumePrompt(file: string, errors: string[]): Promise<string> {
  return loadPrompt("file-resume", {
    FILE: file,
    ERRORS_LIST: errors.map((e) => `- ${e}`).join("\n"),
  });
}

// === DESIGN PHASE ========================================================

async function runDesignPhase(
  sandbox: Sandbox,
  idea: GameIdea,
  maxAttempts: number,
): Promise<{ ok: boolean; errors: string[]; attempts: number; durationMs: number }> {
  const startedAt = Date.now();
  let lastErrors: string[] = [];
  let sessionId: string | undefined = undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.info("design: attempt starting", { attempt, maxAttempts, resumingSession: sessionId });
    // Attempt 1: full prompt, fresh session.
    // Attempt 2+: if the previous attempt left an open session, RESUME it with
    //   a "you forgot to write the file" prompt — gpt-oss is documented to
    //   recover within an active agentic loop, but loses everything across a
    //   fresh session. Fall back to the cross-session retry prompt only if
    //   the prior attempt produced no session id.
    let prompt: string;
    if (attempt === 1) {
      prompt = await buildDesignPrompt(idea);
    } else if (sessionId) {
      prompt = await buildFileResumePrompt("DESIGN.md", lastErrors);
    } else {
      prompt = await buildRetryPrompt("design", idea, lastErrors, attempt);
    }
    const oc = await runOpenCode({
      sandboxDir: sandbox.dir,
      prompt,
      sessionId,
      transcriptDir: sandbox.transcriptsDir,
      transcriptLabel: `design-attempt-${attempt}`,
    });
    sessionId = oc.sessionId ?? sessionId;

    const v = await validateDesign(sandbox.dir);
    if (v.ok) {
      log.info("design: success", {
        attempt,
        durationMs: Date.now() - startedAt,
      });
      return { ok: true, errors: [], attempts: attempt, durationMs: Date.now() - startedAt };
    }
    lastErrors = v.errors;
    log.warn("design: validation failed", { attempt, errors: lastErrors });
  }

  return {
    ok: false,
    errors: lastErrors.length ? lastErrors : ["design: exhausted retries"],
    attempts: maxAttempts,
    durationMs: Date.now() - startedAt,
  };
}

// === TASKS PHASE =========================================================

async function runTasksPhase(
  sandbox: Sandbox,
  idea: GameIdea,
  maxAttempts: number,
): Promise<{ ok: boolean; errors: string[]; attempts: number; durationMs: number; tasks?: TaskItem[] }> {
  const startedAt = Date.now();
  let lastErrors: string[] = [];
  let sessionId: string | undefined = undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.info("tasks: attempt starting", { attempt, maxAttempts, resumingSession: sessionId });
    // See runDesignPhase for rationale: resume the same session on retry so
    // gpt-oss can recover within its active agentic loop instead of losing
    // all reasoning context to a fresh session.
    let prompt: string;
    if (attempt === 1) {
      prompt = await buildTasksPrompt(idea);
    } else if (sessionId) {
      prompt = await buildFileResumePrompt("TASKS.md", lastErrors);
    } else {
      prompt = await buildRetryPrompt("tasks", idea, lastErrors, attempt);
    }
    const oc = await runOpenCode({
      sandboxDir: sandbox.dir,
      prompt,
      sessionId,
      transcriptDir: sandbox.transcriptsDir,
      transcriptLabel: `tasks-attempt-${attempt}`,
    });
    sessionId = oc.sessionId ?? sessionId;

    const v = await validateTasks(sandbox.dir);
    if (v.ok) {
      const tasks = await parseTasks(sandbox.dir);
      log.info("tasks: success", {
        attempt,
        taskCount: tasks.length,
        durationMs: Date.now() - startedAt,
      });
      return {
        ok: true,
        errors: [],
        attempts: attempt,
        durationMs: Date.now() - startedAt,
        tasks,
      };
    }
    lastErrors = v.errors;
    log.warn("tasks: validation failed", { attempt, errors: lastErrors });
  }

  return {
    ok: false,
    errors: lastErrors.length ? lastErrors : ["tasks: exhausted retries"],
    attempts: maxAttempts,
    durationMs: Date.now() - startedAt,
  };
}

// === PICK-EXAMPLE PHASE ==================================================

/**
 * Ask the local LLM which reference template best matches the game we're
 * about to implement. The picker retries internally up to 6 times on
 * malformed/junk responses; if all attempts fail this throws and the phase
 * is reported as failed (no keyword-heuristic fallback by design).
 */
async function runPickExamplePhase(
  sandbox: Sandbox,
  idea: GameIdea,
): Promise<{ ok: true; name: string; reason: string; attempts: number } | { ok: false; errors: string[] }> {
  let designContent: string | null = null;
  try {
    designContent = await readFile(join(sandbox.dir, "DESIGN.md"), "utf-8");
  } catch {
    log.warn("pick-example: no DESIGN.md found, picking from concept alone");
  }
  try {
    const pick = await chooseExample(idea, designContent);
    log.info("pick-example: chosen", {
      name: pick.name,
      reason: pick.reason,
      attempts: pick.attempts,
    });
    return { ok: true, name: pick.name, reason: pick.reason, attempts: pick.attempts };
  } catch (err) {
    const e = err as Error;
    log.error("pick-example: all attempts failed", { error: e.message });
    return { ok: false, errors: [e.message] };
  }
}

// === IMPLEMENT PHASE =====================================================

async function runImplementPhase(
  sandbox: Sandbox,
  idea: GameIdea,
  tasks: TaskItem[],
  consoleFixIterations: number,
  exampleName: string,
): Promise<{ ok: boolean; errors: string[]; meta?: GameMeta; durationMs: number }> {
  const startedAt = Date.now();
  let sessionId: string | undefined = undefined;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const taskNum = i + 1;
    log.info("implement: task starting", {
      taskNum,
      taskTotal: tasks.length,
      text: task.text.slice(0, 120),
    });

    const prompt =
      i === 0
        ? await buildImplementFirstPrompt(idea, task, tasks.length, exampleName)
        : await buildImplementNextPrompt(task, taskNum, tasks.length);

    const oc = await runOpenCode({
      sandboxDir: sandbox.dir,
      prompt,
      sessionId,
      transcriptDir: sandbox.transcriptsDir,
      transcriptLabel: `implement-task-${String(taskNum).padStart(2, "0")}`,
    });
    sessionId = oc.sessionId ?? sessionId;

    if (!sessionId) {
      log.warn("implement: no sessionId observed; per-task fix loop will start fresh sessions", { taskNum });
    }

    // Per-task console-fix loop. Resume same session so the model has full
    // mental model of what it just did. Bounded so a model that can't converge
    // doesn't burn forever — after exhaustion, we move on to the next task
    // anyway and rely on the final validate to catch persistent problems.
    for (let iter = 1; iter <= consoleFixIterations; iter++) {
      const errs = await consoleErrorCheck(sandbox.dir);
      if (errs.length === 0) {
        if (iter > 1) {
          log.info("implement: console-fix loop converged", {
            taskNum, iterationsUsed: iter - 1,
          });
        }
        break;
      }
      if (iter === consoleFixIterations) {
        log.warn("implement: console-fix budget exhausted; moving on", {
          taskNum, errors: errs,
        });
        break;
      }
      log.warn("implement: console errors found, fixing in same session", {
        taskNum, iter, errorCount: errs.length, errors: errs,
      });
      const fixPrompt = await buildConsoleFixPrompt(errs, iter, consoleFixIterations);
      const ocFix = await runOpenCode({
        sandboxDir: sandbox.dir,
        prompt: fixPrompt,
        sessionId,
        transcriptDir: sandbox.transcriptsDir,
        transcriptLabel: `implement-task-${String(taskNum).padStart(2, "0")}-fix-${iter}`,
      });
      sessionId = ocFix.sessionId ?? sessionId;
    }
  }

  // Final validation: the full validate (static + browser + observable contract + playtest).
  // Wrap in a same-session fix loop: if validation fails, feed the errors back
  // into the implement session so the model can fix them in place. This catches
  // late-emerging issues like blank canvas (rendering wired but never invoked),
  // controls-list mismatch, hardcoded player.visible, etc. — without throwing
  // away all the implementation work to start over.
  let lastValidation: { ok: boolean; errors: string[]; meta?: GameMeta } = { ok: false, errors: [] };
  for (let iter = 1; iter <= consoleFixIterations; iter++) {
    const v = await validate(sandbox.dir);
    lastValidation = v;
    if (v.ok && v.meta) {
      if (iter > 1) {
        log.info("implement: validate-fix loop converged", {
          taskCount: tasks.length, iterationsUsed: iter - 1,
        });
      }
      log.info("implement: all tasks complete and final validation passed", {
        taskCount: tasks.length,
        durationMs: Date.now() - startedAt,
      });
      return {
        ok: true,
        errors: [],
        meta: v.meta,
        durationMs: Date.now() - startedAt,
      };
    }
    if (iter === consoleFixIterations) {
      log.error("implement: validate-fix budget exhausted, giving up", {
        errors: v.errors, iterationsUsed: iter,
      });
      break;
    }
    log.warn("implement: final validation failed, attempting in-session fix", {
      iter, maxIter: consoleFixIterations, errors: v.errors,
    });
    const fixPrompt = await buildValidateFixPrompt(v.errors, iter, consoleFixIterations);
    const ocFix = await runOpenCode({
      sandboxDir: sandbox.dir,
      prompt: fixPrompt,
      sessionId,
      transcriptDir: sandbox.transcriptsDir,
      transcriptLabel: `implement-final-fix-${iter}`,
    });
    sessionId = ocFix.sessionId ?? sessionId;
  }

  return {
    ok: false,
    errors: lastValidation.errors,
    durationMs: Date.now() - startedAt,
  };
}

// === ENTRY POINT =========================================================

export async function generateGame(idea: GameIdea): Promise<GenerateResult> {
  const cfg = loadConfig();
  const maxAttemptsPerStage = cfg.STAGE_MAX_ATTEMPTS;
  const consoleFixIterations = cfg.IMPLEMENT_CONSOLE_FIX_ITERATIONS;

  const sandbox = await createSandbox(idea.slug);
  log.info("generate: sandbox created", { dir: sandbox.dir, slug: idea.slug });
  await writeConventions(sandbox.dir, idea.slug);

  // ---- Phase: design ----
  log.phase("design");
  const design = await runDesignPhase(sandbox, idea, Math.min(3, maxAttemptsPerStage));
  if (!design.ok) {
    return { ok: false, sandbox, errors: design.errors, failedPhase: "design" };
  }

  // ---- Phase: tasks ----
  log.phase("tasks");
  const tasksOut = await runTasksPhase(sandbox, idea, Math.min(3, maxAttemptsPerStage));
  if (!tasksOut.ok || !tasksOut.tasks) {
    return { ok: false, sandbox, errors: tasksOut.errors, failedPhase: "tasks" };
  }

  // ---- Phase: pick-example ----
  // The LLM picks the structural template that best matches this game's code
  // shape. Internally retries up to 6 attempts on malformed responses; if all
  // attempts fail the phase fails — no keyword fallback by design.
  log.phase("pick-example");
  const example = await runPickExamplePhase(sandbox, idea);
  if (!example.ok) {
    return { ok: false, sandbox, errors: example.errors, failedPhase: "pick-example" };
  }

  // ---- Phase: implement ----
  log.phase(`implement (${tasksOut.tasks.length} tasks, example: ${example.name})`);
  const impl = await runImplementPhase(
    sandbox,
    idea,
    tasksOut.tasks,
    consoleFixIterations,
    example.name,
  );
  if (!impl.ok || !impl.meta) {
    return {
      ok: false,
      sandbox,
      errors: impl.errors,
      failedPhase: "implement",
      taskCount: tasksOut.tasks.length,
      examplePick: { name: example.name, reason: example.reason },
    };
  }

  log.info("generate: success", {
    slug: idea.slug,
    taskCount: tasksOut.tasks.length,
    durationMs: design.durationMs + tasksOut.durationMs + impl.durationMs,
  });

  return {
    ok: true,
    sandbox,
    meta: impl.meta,
    taskCount: tasksOut.tasks.length,
  };
}

// Re-exported for any external callers (snapshotStage was previously used by
// the multi-stage refinement pipeline; preserved as a no-op helper in case
// other modules still reference it).
export async function snapshotSandbox(sandbox: Sandbox, label: string): Promise<string> {
  const dir = join(sandbox.snapshotsDir, label);
  await mkdir(dir, { recursive: true });
  await copyFile(join(sandbox.dir, "index.html"), join(dir, "index.html"));
  await copyFile(join(sandbox.dir, "meta.json"), join(dir, "meta.json"));
  return dir;
}

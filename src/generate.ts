import { copyFile, mkdir } from "node:fs/promises";
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
import { formatExampleForPrompt, loadExampleFor } from "./examples.ts";
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
  /** Phase where generation broke ("design" | "tasks" | "implement"). */
  failedPhase?: string;
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
): Promise<string> {
  const example = await loadExampleFor(idea);
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
  });
}

function buildConsoleFixPrompt(errors: string[], iter: number, maxIter: number): Promise<string> {
  return loadPrompt("console-fix", {
    ERRORS_LIST: errors.map((e) => `- ${e}`).join("\n"),
    ITERATION: String(iter),
    MAX_ITERATIONS: String(maxIter),
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.info("design: attempt starting", { attempt, maxAttempts });
    const prompt =
      attempt === 1
        ? await buildDesignPrompt(idea)
        : await buildRetryPrompt("design", idea, lastErrors, attempt);
    await runOpenCode({ sandboxDir: sandbox.dir, prompt });
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.info("tasks: attempt starting", { attempt, maxAttempts });
    const prompt =
      attempt === 1
        ? await buildTasksPrompt(idea)
        : await buildRetryPrompt("tasks", idea, lastErrors, attempt);
    await runOpenCode({ sandboxDir: sandbox.dir, prompt });
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

// === IMPLEMENT PHASE =====================================================

async function runImplementPhase(
  sandbox: Sandbox,
  idea: GameIdea,
  tasks: TaskItem[],
  consoleFixIterations: number,
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
        ? await buildImplementFirstPrompt(idea, task, tasks.length)
        : await buildImplementNextPrompt(task, taskNum, tasks.length);

    const oc = await runOpenCode({ sandboxDir: sandbox.dir, prompt, sessionId });
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
      });
      sessionId = ocFix.sessionId ?? sessionId;
    }
  }

  // Final validation: the full validate (static + browser + observable contract + playtest).
  const v = await validate(sandbox.dir);
  if (!v.ok || !v.meta) {
    log.error("implement: final validation failed", { errors: v.errors });
    return {
      ok: false,
      errors: v.errors,
      durationMs: Date.now() - startedAt,
    };
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
  const design = await runDesignPhase(sandbox, idea, Math.min(2, maxAttemptsPerStage));
  if (!design.ok) {
    return { ok: false, sandbox, errors: design.errors, failedPhase: "design" };
  }

  // ---- Phase: tasks ----
  log.phase("tasks");
  const tasksOut = await runTasksPhase(sandbox, idea, Math.min(2, maxAttemptsPerStage));
  if (!tasksOut.ok || !tasksOut.tasks) {
    return { ok: false, sandbox, errors: tasksOut.errors, failedPhase: "tasks" };
  }

  // ---- Phase: implement ----
  log.phase(`implement (${tasksOut.tasks.length} tasks)`);
  const impl = await runImplementPhase(sandbox, idea, tasksOut.tasks, consoleFixIterations);
  if (!impl.ok || !impl.meta) {
    return { ok: false, sandbox, errors: impl.errors, failedPhase: "implement" };
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

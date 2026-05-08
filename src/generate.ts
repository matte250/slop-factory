import { createSandbox, type Sandbox } from "./sandbox.ts";
import { writeConventions } from "./conventions.ts";
import { runOpenCode } from "./opencode.ts";
import { validate, type ValidationResult } from "./validate.ts";
import { log } from "./log.ts";
import type { GameIdea } from "./ideate.ts";
import type { GameMeta } from "./games_index.ts";

export type GenerateSuccess = {
  ok: true;
  sandbox: Sandbox;
  meta: GameMeta;
  attempts: number;
};

export type GenerateFailure = {
  ok: false;
  sandbox: Sandbox;
  errors: string[];
  attempts: number;
};

export type GenerateResult = GenerateSuccess | GenerateFailure;

export type GenerateOptions = {
  maxAttempts?: number;
};

function buildInitialPrompt(idea: GameIdea): string {
  return [
    "Read the file CONVENTIONS.md in your working directory carefully before doing anything else.",
    "",
    "Then create the two required files (index.html and meta.json) for this game:",
    "",
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
    "",
    "The game must follow CONVENTIONS.md exactly. Keep the implementation simple and robust over flashy and fragile. Wrap your animation loop body in a try/catch so a stray bug does not crash the game.",
  ].join("\n");
}

function buildRetryPrompt(idea: GameIdea, errors: string[], attempt: number): string {
  return [
    `Your previous attempt (attempt #${attempt - 1}) failed validation. Fix the issues and write the corrected files. Do not start over from scratch unless necessary; edit the existing files in place.`,
    "",
    "Validation errors:",
    ...errors.map((e) => `- ${e}`),
    "",
    "Reminder of the game:",
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
    "",
    "Re-read CONVENTIONS.md if needed. Produce corrected index.html and meta.json that pass all validator checks.",
  ].join("\n");
}

export async function generateGame(
  idea: GameIdea,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const maxAttempts = opts.maxAttempts ?? 3;

  const sandbox = await createSandbox(idea.slug);
  log.info("generate: sandbox created", { dir: sandbox.dir, slug: idea.slug });

  await writeConventions(sandbox.dir, idea.slug);

  let lastErrors: string[] = [];
  let lastValidation: ValidationResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.info("generate: attempt starting", { attempt, maxAttempts, slug: idea.slug });

    const prompt = attempt === 1 ? buildInitialPrompt(idea) : buildRetryPrompt(idea, lastErrors, attempt);

    const oc = await runOpenCode({ sandboxDir: sandbox.dir, prompt });
    if (oc.exitCode !== 0) {
      lastErrors = [
        `opencode exited with code ${oc.exitCode}${oc.timedOut ? " (TIMED OUT)" : ""}`,
        oc.stderr.slice(-800),
      ];
      log.warn("generate: opencode non-zero exit", { attempt, exitCode: oc.exitCode, timedOut: oc.timedOut });
      continue;
    }

    lastValidation = await validate(sandbox.dir);
    if (lastValidation.ok && lastValidation.meta) {
      log.info("generate: success", { attempt, slug: idea.slug });
      return { ok: true, sandbox, meta: lastValidation.meta, attempts: attempt };
    }
    lastErrors = lastValidation.errors;
    log.warn("generate: validation failed", { attempt, errorCount: lastErrors.length, errors: lastErrors });
  }

  log.error("generate: gave up after max attempts", { slug: idea.slug, attempts: maxAttempts });
  return { ok: false, sandbox, errors: lastErrors, attempts: maxAttempts };
}

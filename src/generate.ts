import { readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Sandbox } from "./sandbox.ts";
import { runOpenCode } from "./opencode.ts";
import { validate } from "./validate/index.ts";
import { log } from "./log.ts";
import {
  GameMetaSchema,
  readGamesIndex,
  uniqueSlug,
  type GameMeta,
} from "./games-index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_TEMPLATE_PATH = join(here, "..", "prompts", "index.html.tmpl");

const IMPLEMENT_PROMPT =
  "Create a game based on @IDEA.md. " +
  "Do this by creating a game.js file, there is a canvas element in a HTML file you cannot see " +
  'that you can target in the game.js to implement the game. The canvas has id="game". Be concice.';

const EXTRACT_META_PROMPT = [
  "Read @IDEA.md and @game.js, then write a META.json file in this working directory.",
  "META.json must be valid JSON with exactly this shape:",
  '  { "title": string, "description": string, "controls": [string, ...] }',
  "- title: a short game title (3-80 chars)",
  '- description: one short sentence describing the game (20-400 chars)',
  '- controls: a non-empty array of short strings like "Arrow keys to move" or "Space to shoot", one per input the player uses',
  "Output only the file. No markdown fences inside the file.",
].join("\n");

const EXTRACT_META_MAX_ATTEMPTS = 3;
const VALIDATE_FIX_MAX_ATTEMPTS = 2;

// === VALIDATION FIX HINTS ================================================
//
// Each hint pattern-matches one class of validate() error against game.js.
// When validate fails, generateGame() collects matching hints and dispatches
// a single corrective opencode call (variant=low). Add new hints here as new
// failure modes appear in the wild — keep matchers narrow so unrelated
// errors don't get hijacked.
type FixHint = {
  name: string;
  /** True if `error` is something this hint knows how to fix. */
  matches: (error: string) => boolean;
  /** Sentence appended into the fix prompt when matched. */
  instruction: string;
};

const FIX_HINTS: FixHint[] = [
  {
    name: "wrong-canvas-id",
    matches: (e) =>
      /canvas.*(not found|is null|undefined)/i.test(e) ||
      /getContext.*\bnull\b/i.test(e) ||
      /Cannot read.*null.*getContext/i.test(e),
    instruction:
      'The canvas element in the HTML has id="game". Update game.js to target it via document.getElementById("game") (or an equivalent querySelector). Do not change the id; do not add an HTML file.',
  },
];

function collectMatchingHints(errors: string[]): { hint: FixHint; error: string }[] {
  const matches: { hint: FixHint; error: string }[] = [];
  for (const error of errors) {
    for (const hint of FIX_HINTS) {
      if (hint.matches(error) && !matches.some((m) => m.hint.name === hint.name)) {
        matches.push({ hint, error });
      }
    }
  }
  return matches;
}

async function runValidateFix(
  sandbox: Sandbox,
  matches: { hint: FixHint; error: string }[],
  iter: number,
): Promise<void> {
  const prompt = [
    "The game.js you wrote has problems. Fix them by editing game.js (do not create any HTML file).",
    "",
    "Problems and how to fix each:",
    ...matches.map(
      (m, i) => `${i + 1}. ${m.hint.instruction}\n   (validator reported: ${m.error})`,
    ),
    "",
    "Re-write the affected parts of game.js using the file-write tool. Be concise.",
  ].join("\n");

  log.info("validate-fix: dispatching", {
    iter,
    hints: matches.map((m) => m.hint.name),
  });

  await runOpenCode({
    sandboxDir: sandbox.dir,
    prompt,
    variant: "low",
    transcriptDir: sandbox.transcriptsDir,
    transcriptLabel: `validate-fix-${iter}`,
  });
}

export type GenerateSuccess = {
  ok: true;
  sandbox: Sandbox;
  meta: GameMeta;
  slug: string;
};

export type GenerateFailure = {
  ok: false;
  sandbox: Sandbox;
  errors: string[];
  failedPhase: "implement" | "extract-meta" | "materialize" | "validate";
  /** Set once extract-meta succeeds. */
  meta?: GameMeta;
};

export type GenerateResult = GenerateSuccess | GenerateFailure;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runImplement(sandbox: Sandbox): Promise<{ ok: boolean; errors: string[] }> {
  await runOpenCode({
    sandboxDir: sandbox.dir,
    prompt: IMPLEMENT_PROMPT,
    variant: "medium",
    transcriptDir: sandbox.transcriptsDir,
    transcriptLabel: "implement",
  });
  if (!(await fileExists(join(sandbox.dir, "game.js")))) {
    return { ok: false, errors: ["implement: game.js was not created by opencode"] };
  }
  return { ok: true, errors: [] };
}

/**
 * Read+validate META.json from disk. Returns the parsed meta or a list of
 * problems (used to drive same-session retries).
 */
async function tryReadMeta(
  sandbox: Sandbox,
): Promise<{ ok: true; meta: GameMeta } | { ok: false; errors: string[] }> {
  const metaPath = join(sandbox.dir, "META.json");
  if (!(await fileExists(metaPath))) {
    return { ok: false, errors: ["META.json was not created — write it using the file-write tool, not as chat text"] };
  }
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf-8");
  } catch (e) {
    return { ok: false, errors: [`failed to read META.json: ${(e as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`META.json is not valid JSON: ${(e as Error).message}`] };
  }
  const result = GameMetaSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return { ok: false, errors: [`META.json schema mismatch: ${issues.join("; ")}`] };
  }
  return { ok: true, meta: result.data };
}

async function runExtractMeta(
  sandbox: Sandbox,
): Promise<{ ok: true; meta: GameMeta } | { ok: false; errors: string[] }> {
  let lastErrors: string[] = [];
  let sessionId: string | undefined = undefined;

  for (let attempt = 1; attempt <= EXTRACT_META_MAX_ATTEMPTS; attempt++) {
    log.info("extract-meta: attempt starting", {
      attempt,
      maxAttempts: EXTRACT_META_MAX_ATTEMPTS,
      resumingSession: sessionId,
    });

    // First attempt: full prompt, fresh session.
    // Retry attempts: resume the same session with a corrective nudge — gpt-oss
    // recovers within an active loop but loses context across a fresh session.
    const prompt =
      attempt === 1
        ? EXTRACT_META_PROMPT
        : [
            "You did not produce a valid META.json file. Problems:",
            ...lastErrors.map((e) => `- ${e}`),
            "",
            "Please write META.json now using the file-write tool. Do not output the JSON as chat text — use the tool call to write the file to the working directory.",
          ].join("\n");

    const oc = await runOpenCode({
      sandboxDir: sandbox.dir,
      prompt,
      sessionId,
      variant: "low",
      transcriptDir: sandbox.transcriptsDir,
      transcriptLabel: `extract-meta-attempt-${attempt}`,
    });
    sessionId = oc.sessionId ?? sessionId;

    const r = await tryReadMeta(sandbox);
    if (r.ok) {
      if (attempt > 1) log.info("extract-meta: recovered on retry", { attempt });
      return r;
    }
    lastErrors = r.errors;
    log.warn("extract-meta: attempt failed", { attempt, errors: lastErrors });
  }

  return {
    ok: false,
    errors: lastErrors.map((e) => `extract-meta: ${e}`),
  };
}

async function materialize(sandbox: Sandbox, meta: GameMeta): Promise<void> {
  const tmpl = await readFile(INDEX_TEMPLATE_PATH, "utf-8");
  const controlsHtml = meta.controls
    .map((c) => `      <li>${escapeHtml(c)}</li>`)
    .join("\n");
  const html = tmpl
    .replaceAll("{TITLE}", escapeHtml(meta.title))
    .replace("{DESCRIPTION}", escapeHtml(meta.description))
    .replace("{CONTROLS_LIST_HTML}", controlsHtml);

  await writeFile(join(sandbox.dir, "index.html"), html, "utf-8");
  await writeFile(
    join(sandbox.dir, "meta.json"),
    JSON.stringify(meta, null, 2) + "\n",
    "utf-8",
  );
  log.info("materialize: wrote index.html and meta.json", {
    title: meta.title,
    controlsCount: meta.controls.length,
  });
}

export async function generateGame(sandbox: Sandbox): Promise<GenerateResult> {
  // ---- Phase: implement ----
  log.phase("implement");
  const impl = await runImplement(sandbox);
  if (!impl.ok) {
    return { ok: false, sandbox, errors: impl.errors, failedPhase: "implement" };
  }

  // ---- Phase: extract-meta ----
  log.phase("extract-meta");
  const meta = await runExtractMeta(sandbox);
  if (!meta.ok) {
    return { ok: false, sandbox, errors: meta.errors, failedPhase: "extract-meta" };
  }

  // ---- Phase: materialize ----
  log.phase("materialize");
  try {
    await materialize(sandbox, meta.meta);
  } catch (e) {
    return {
      ok: false,
      sandbox,
      errors: [`materialize: ${(e as Error).message}`],
      failedPhase: "materialize",
      meta: meta.meta,
    };
  }

  // ---- Phase: validate ----
  //
  // On failure, we consult FIX_HINTS for known-recoverable error patterns
  // (e.g. wrong canvas id). If any hints match, dispatch one opencode fix
  // call (variant=low) and re-validate. Bounded to avoid burning the loop
  // on a game we can't auto-recover.
  log.phase("validate");
  let lastValidate = await validate(sandbox.dir);
  for (let iter = 1; iter <= VALIDATE_FIX_MAX_ATTEMPTS && !lastValidate.ok; iter++) {
    const matches = collectMatchingHints(lastValidate.errors);
    if (matches.length === 0) {
      log.info("validate-fix: no known-recoverable patterns in errors, not retrying", {
        errors: lastValidate.errors,
      });
      break;
    }
    await runValidateFix(sandbox, matches, iter);
    lastValidate = await validate(sandbox.dir);
    if (lastValidate.ok) {
      log.info("validate-fix: recovered", { iter, hints: matches.map((m) => m.hint.name) });
    }
  }
  if (!lastValidate.ok) {
    return {
      ok: false,
      sandbox,
      errors: lastValidate.errors,
      failedPhase: "validate",
      meta: meta.meta,
    };
  }

  // Slug is decided here, after we know the title.
  const existing = await readGamesIndex();
  const slug = uniqueSlug(meta.meta.title, existing);

  log.info("generate: success", { slug, title: meta.meta.title });
  return { ok: true, sandbox, meta: meta.meta, slug };
}

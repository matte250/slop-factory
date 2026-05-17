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
  "that you can target in the game.js to implement the game. Be concice.";

const EXTRACT_META_PROMPT = [
  "Read @IDEA.md and @game.js, then write a META.json file in this working directory.",
  "META.json must be valid JSON with exactly this shape:",
  '  { "title": string, "description": string, "controls": [string, ...] }',
  "- title: a short game title (3-80 chars)",
  '- description: one short sentence describing the game (20-400 chars)',
  '- controls: a non-empty array of short strings like "Arrow keys to move" or "Space to shoot", one per input the player uses',
  "Output only the file. No markdown fences inside the file.",
].join("\n");

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

async function runExtractMeta(
  sandbox: Sandbox,
): Promise<{ ok: true; meta: GameMeta } | { ok: false; errors: string[] }> {
  await runOpenCode({
    sandboxDir: sandbox.dir,
    prompt: EXTRACT_META_PROMPT,
    variant: "low",
    transcriptDir: sandbox.transcriptsDir,
    transcriptLabel: "extract-meta",
  });

  const metaPath = join(sandbox.dir, "META.json");
  if (!(await fileExists(metaPath))) {
    return { ok: false, errors: ["extract-meta: META.json was not created by opencode"] };
  }
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf-8");
  } catch (e) {
    return { ok: false, errors: [`extract-meta: failed to read META.json: ${(e as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      errors: [`extract-meta: META.json is not valid JSON: ${(e as Error).message}`],
    };
  }
  const result = GameMetaSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return { ok: false, errors: [`extract-meta: META.json schema mismatch: ${issues.join("; ")}`] };
  }
  return { ok: true, meta: result.data };
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
  log.phase("validate");
  const v = await validate(sandbox.dir);
  if (!v.ok) {
    return {
      ok: false,
      sandbox,
      errors: v.errors,
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

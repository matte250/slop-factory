import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { GameMetaSchema, type GameMeta } from "../games-index.ts";
import type { ValidationResult } from "./types.ts";

const FORBIDDEN_URL_RE = /\b(src|href)\s*=\s*["']https?:\/\//i;

export async function staticChecks(sandboxDir: string): Promise<ValidationResult> {
  const errors: string[] = [];
  let meta: GameMeta | undefined;

  const indexPath = join(sandboxDir, "index.html");
  const metaPath = join(sandboxDir, "meta.json");
  const gameJsPath = join(sandboxDir, "game.js");

  for (const [path, label] of [
    [indexPath, "index.html"],
    [metaPath, "meta.json"],
    [gameJsPath, "game.js"],
  ] as const) {
    try {
      await stat(path);
    } catch {
      errors.push(`Required file missing: ${label}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const metaRaw = await readFile(metaPath, "utf-8");
  let metaJson: unknown;
  try {
    metaJson = JSON.parse(metaRaw);
  } catch (e) {
    errors.push(`meta.json is not valid JSON: ${(e as Error).message}`);
    return { ok: false, errors };
  }
  const metaParsed = GameMetaSchema.safeParse(metaJson);
  if (!metaParsed.success) {
    for (const issue of metaParsed.error.issues) {
      errors.push(`meta.json: ${issue.path.join(".")} - ${issue.message}`);
    }
    return { ok: false, errors };
  }
  meta = metaParsed.data;

  const html = await readFile(indexPath, "utf-8");
  if (FORBIDDEN_URL_RE.test(html)) {
    errors.push(
      "index.html: contains a src= or href= pointing to an external URL. The page must be self-contained.",
    );
  }

  return { ok: errors.length === 0, errors, meta };
}

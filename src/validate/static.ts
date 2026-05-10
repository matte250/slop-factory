import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { GameMetaSchema, type GameMeta } from "../games-index.ts";
import type { ValidationResult } from "./types.ts";

const FORBIDDEN_URL_RE = /\b(src|href)\s*=\s*["'](https?:)?\/\//i;

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function staticChecks(sandboxDir: string): Promise<ValidationResult> {
  const errors: string[] = [];
  let meta: GameMeta | undefined;

  // 1. file presence
  const indexPath = join(sandboxDir, "index.html");
  const metaPath = join(sandboxDir, "meta.json");
  try {
    await stat(indexPath);
  } catch {
    errors.push("Required file missing: index.html");
  }
  try {
    await stat(metaPath);
  } catch {
    errors.push("Required file missing: meta.json");
  }
  if (errors.length > 0) return { ok: false, errors };

  // 2. meta.json schema
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

  // 3. index.html structure
  const html = await readFile(indexPath, "utf-8");
  const root = parse(html);

  const canvases = root.querySelectorAll("canvas#game");
  if (canvases.length === 0) {
    errors.push('index.html: missing <canvas id="game">');
  } else if (canvases.length > 1) {
    errors.push(`index.html: found ${canvases.length} <canvas id="game"> elements; must be exactly 1`);
  }

  const restartButtons = root.querySelectorAll("button#restart");
  if (restartButtons.length === 0) {
    errors.push('index.html: missing <button id="restart" class="game-restart">Restart</button> after the canvas — required so players can restart without keyboard');
  } else if (restartButtons.length > 1) {
    errors.push(`index.html: found ${restartButtons.length} <button id="restart"> elements; must be exactly 1`);
  }

  const headers = root.querySelectorAll("header.game-header");
  if (headers.length === 0) {
    errors.push('index.html: missing <header class="game-header">');
  } else {
    const header = headers[0] as HTMLElement;
    const h1 = header.querySelector("h1");
    if (!h1) {
      errors.push("index.html: <header> missing <h1>");
    } else if (normalize(h1.text) !== normalize(meta.title)) {
      errors.push(
        `index.html: <h1> text "${normalize(h1.text)}" does not match meta.json title "${normalize(meta.title)}"`,
      );
    }
    const desc = header.querySelector("p.game-description");
    if (!desc) {
      errors.push('index.html: <header> missing <p class="game-description">');
    } else if (normalize(desc.text) !== normalize(meta.description)) {
      errors.push(
        `index.html: <p class="game-description"> text does not match meta.json description`,
      );
    }
    const controlList = header.querySelector("ul.game-controls");
    if (!controlList) {
      errors.push('index.html: <header> missing <ul class="game-controls">');
    } else {
      const items = controlList.querySelectorAll("li").map((li) => normalize(li.text));
      const expected = meta.controls.map(normalize);
      if (items.length !== expected.length || items.some((v, i) => v !== expected[i])) {
        errors.push(
          `index.html: controls list mismatch. Got [${items.join(" | ")}], expected [${expected.join(" | ")}]`,
        );
      }
    }
  }

  // 4. no external URLs in src/href
  if (FORBIDDEN_URL_RE.test(html)) {
    errors.push(
      "index.html: contains a src= or href= pointing to an external URL. The page must be self-contained.",
    );
  }

  return { ok: errors.length === 0, errors, meta };
}

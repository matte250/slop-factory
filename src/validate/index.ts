import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { staticChecks } from "./static.ts";
import { browserChecks } from "./browser.ts";
import type { ValidationResult } from "./types.ts";

export type { ValidationResult } from "./types.ts";
export { staticChecks } from "./static.ts";
export { browserChecks, consoleErrorCheck, type BrowserCheckOptions } from "./browser.ts";

export async function validate(sandboxDir: string): Promise<ValidationResult> {
  const sr = await staticChecks(sandboxDir);
  if (!sr.ok) return sr;

  const br = await browserChecks({ sandboxDir });
  if (!br.ok) return { ok: false, errors: br.errors, meta: sr.meta };

  return { ok: true, errors: [], meta: sr.meta };
}

const REQUIRED_DESIGN_SECTIONS = [
  "## Player",
  "## Hazards",
  "## Score",
  "## Game-over and restart",
  "## Mechanic verification",
  "## First 3 seconds",
];

export async function validateDesign(sandboxDir: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const designPath = join(sandboxDir, "DESIGN.md");
  let content = "";
  try {
    content = await readFile(designPath, "utf-8");
  } catch {
    errors.push("Required file missing: DESIGN.md");
    return { ok: false, errors };
  }
  for (const section of REQUIRED_DESIGN_SECTIONS) {
    if (!content.includes(section)) {
      errors.push(`DESIGN.md: missing required section header "${section}"`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const CRITIQUE_BLOCK_OPEN = "=== CRITIQUE ANALYSIS";
const CRITIQUE_BLOCK_CLOSE = "=== END CRITIQUE ===";

/**
 * After the critique stage (and through polish), the index.html must contain
 * the critique's structured analysis as an audit trail. This both proves
 * critique actually ran and gives us something to read when a game still
 * ships broken.
 */
export async function validateWithCritiqueBlock(sandboxDir: string): Promise<ValidationResult> {
  const r = await validate(sandboxDir);
  if (!r.ok) return r;

  const html = await readFile(join(sandboxDir, "index.html"), "utf-8");
  if (!html.includes(CRITIQUE_BLOCK_OPEN) || !html.includes(CRITIQUE_BLOCK_CLOSE)) {
    return {
      ok: false,
      errors: [
        `index.html: missing critique analysis block. The critique stage must wrap its analysis in a JS comment containing the exact markers "${CRITIQUE_BLOCK_OPEN}" and "${CRITIQUE_BLOCK_CLOSE}", and the polish stage must preserve them.`,
      ],
      meta: r.meta,
    };
  }
  return r;
}

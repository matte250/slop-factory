import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(here, "..", "prompts");

/**
 * Load a stage prompt from prompts/<name>.md and substitute {KEY} placeholders.
 * Same {KEY} convention conventions.ts uses for CONVENTIONS.md.tmpl.
 */
export async function loadPrompt(
  name: string,
  vars: Record<string, string> = {},
): Promise<string> {
  const path = join(PROMPTS_DIR, `${name}.md`);
  let content = await readFile(path, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{${key}}`, value);
  }
  return content;
}

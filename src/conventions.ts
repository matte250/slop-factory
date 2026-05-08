import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(here, "..", "prompts", "CONVENTIONS.md.tmpl");

export async function writeConventions(sandboxDir: string, slug: string): Promise<void> {
  const tmpl = await readFile(TEMPLATE_PATH, "utf-8");
  const rendered = tmpl.replaceAll("{SLUG}", slug);
  await writeFile(join(sandboxDir, "CONVENTIONS.md"), rendered, "utf-8");
}

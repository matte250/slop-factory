import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createSandbox } from "../sandbox.ts";
import { writeConventions } from "../conventions.ts";
import { runOpenCode } from "../opencode.ts";
import { log } from "../log.ts";

const slug = `smoke-${Date.now()}`;
const title = "Neon Dodger";
const concept =
  "A tiny game where the player controls a small triangle ship at the bottom of the canvas and dodges falling neon blocks with arrow keys. The blocks fall faster over time. Show a score that ticks up the longer you survive.";

const sandbox = await createSandbox(slug);
log.info("smoke-opencode: sandbox created", { dir: sandbox.dir });

await writeConventions(sandbox.dir, slug);
log.info("smoke-opencode: CONVENTIONS.md written");

const prompt = [
  "Read the file CONVENTIONS.md in your working directory carefully before doing anything else.",
  "",
  "Then create the two required files (index.html and meta.json) for this game:",
  "",
  `Title: ${title}`,
  `Concept: ${concept}`,
  "",
  "The game must follow CONVENTIONS.md exactly. Keep the implementation simple and robust.",
].join("\n");

const result = await runOpenCode({ sandboxDir: sandbox.dir, prompt });

process.stdout.write(`\n=== opencode exit ${result.exitCode} (${result.durationMs}ms, timedOut=${result.timedOut}) ===\n`);
process.stdout.write(`\n--- stdout (last 1000 chars) ---\n${result.stdout.slice(-1000)}\n`);
if (result.stderr.trim()) {
  process.stdout.write(`\n--- stderr (last 1000 chars) ---\n${result.stderr.slice(-1000)}\n`);
}

const files = await readdir(sandbox.dir);
process.stdout.write(`\n--- files in ${sandbox.dir} ---\n${files.join("\n")}\n`);

for (const f of ["index.html", "meta.json"]) {
  const p = join(sandbox.dir, f);
  try {
    const s = await stat(p);
    const content = await readFile(p, "utf-8");
    const preview = content.length > 1500 ? content.slice(0, 1500) + "\n...[truncated]" : content;
    process.stdout.write(`\n--- ${f} (${s.size} bytes) ---\n${preview}\n`);
  } catch {
    process.stdout.write(`\n--- ${f}: MISSING ---\n`);
  }
}

process.stdout.write(`\nSandbox preserved at: ${sandbox.dir}\n`);
process.stdout.write(`(rm -rf ${sandbox.dir} when done inspecting)\n`);

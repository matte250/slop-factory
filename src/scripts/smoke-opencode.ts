import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createSandbox } from "../sandbox.ts";
import { runOpenCode } from "../opencode.ts";
import { log } from "../log.ts";

const slug = `smoke-${Date.now()}`;
const sandbox = await createSandbox(slug);
log.info("smoke-opencode: sandbox created", { dir: sandbox.dir });

const prompt =
  "Come up with a random game idea that is possible to create in a HTML canvas. " +
  "Save the idea to a IDEA.md file in this working directory. " +
  "The game should have a lose condition. Be concice.";

const result = await runOpenCode({ sandboxDir: sandbox.dir, prompt, variant: "high" });

process.stdout.write(`\n=== opencode exit ${result.exitCode} (${result.durationMs}ms, timedOut=${result.timedOut}) ===\n`);
process.stdout.write(`\n--- stdout (last 1000 chars) ---\n${result.stdout.slice(-1000)}\n`);
if (result.stderr.trim()) {
  process.stdout.write(`\n--- stderr (last 1000 chars) ---\n${result.stderr.slice(-1000)}\n`);
}

const files = await readdir(sandbox.dir);
process.stdout.write(`\n--- files in ${sandbox.dir} ---\n${files.join("\n")}\n`);

for (const f of ["IDEA.md"]) {
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

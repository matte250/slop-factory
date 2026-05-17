import { randomBytes } from "node:crypto";
import { ideate } from "../ideate.ts";
import { generateGame } from "../generate.ts";
import { createSandbox } from "../sandbox.ts";
import { log } from "../log.ts";

const sandbox = await createSandbox(`smoke-${randomBytes(4).toString("hex")}`);
process.stdout.write(`sandbox: ${sandbox.dir}\n`);

log.info("smoke-generate: ideating");
const idea = await ideate(sandbox);
process.stdout.write(`\n--- idea ---\n${idea.concept}\n`);

log.info("smoke-generate: generating");
const result = await generateGame(sandbox);

process.stdout.write(`\n=== generate: ${result.ok ? "PASS" : "FAIL"} ===\n`);
process.stdout.write(`sandbox: ${result.sandbox.dir}\n`);

if (result.ok) {
  process.stdout.write(`\nslug: ${result.slug}\n`);
  process.stdout.write(`title: ${result.meta.title}\n`);
  process.stdout.write(`description: ${result.meta.description}\n`);
  process.stdout.write(`controls: ${JSON.stringify(result.meta.controls)}\n`);
} else {
  process.stdout.write(`\nfailed at phase: ${result.failedPhase}\n`);
  process.stdout.write("errors:\n");
  for (const e of result.errors) process.stdout.write(`  - ${e}\n`);
}

process.stdout.write(`\n(rm -rf ${result.sandbox.dir} when done inspecting)\n`);
process.exit(result.ok ? 0 : 1);

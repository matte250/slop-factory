import { ideate } from "../ideate.ts";
import { generateGame } from "../generate.ts";
import { log } from "../log.ts";

log.info("smoke-generate: ideating");
const idea = await ideate();
process.stdout.write(`\n--- idea ---\ntitle: ${idea.title}\nslug: ${idea.slug}\nconcept: ${idea.concept}\n`);

log.info("smoke-generate: generating");
const result = await generateGame(idea, { maxAttempts: 3 });

process.stdout.write(`\n=== generate: ${result.ok ? "PASS" : "FAIL"} (attempts=${result.attempts}) ===\n`);
process.stdout.write(`sandbox: ${result.sandbox.dir}\n`);

if (result.ok) {
  process.stdout.write(`title: ${result.meta.title}\n`);
  process.stdout.write(`description: ${result.meta.description}\n`);
  process.stdout.write(`controls: ${JSON.stringify(result.meta.controls)}\n`);
} else {
  process.stdout.write("\nerrors:\n");
  for (const e of result.errors) process.stdout.write(`  - ${e}\n`);
}

process.stdout.write(`\n(rm -rf ${result.sandbox.dir} when done inspecting)\n`);
process.exit(result.ok ? 0 : 1);

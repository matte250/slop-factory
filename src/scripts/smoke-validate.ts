import { validate } from "../validate/index.ts";
import { log } from "../log.ts";

const sandboxDir = process.argv[2];
if (!sandboxDir) {
  process.stderr.write("usage: bun run src/scripts/smoke-validate.ts <sandbox-dir>\n");
  process.exit(1);
}

log.info("smoke-validate: starting", { sandboxDir });
const result = await validate(sandboxDir);

process.stdout.write(`\n=== validation: ${result.ok ? "PASS" : "FAIL"} ===\n`);
if (result.meta) {
  process.stdout.write(`title: ${result.meta.title}\n`);
  process.stdout.write(`description: ${result.meta.description}\n`);
  process.stdout.write(`controls: ${JSON.stringify(result.meta.controls)}\n`);
}
if (result.errors.length > 0) {
  process.stdout.write("\nerrors:\n");
  for (const e of result.errors) process.stdout.write(`  - ${e}\n`);
}
process.exit(result.ok ? 0 : 1);

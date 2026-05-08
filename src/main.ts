import { runOnce, runForever } from "./loop.ts";
import { log } from "./log.ts";

const args = process.argv.slice(2);

if (args.includes("--once")) {
  const r = await runOnce();
  if (r.ok) {
    log.info("main: --once succeeded", { slug: r.slug, durationMs: r.durationMs });
    process.exit(0);
  } else {
    log.error("main: --once failed", { error: r.error, durationMs: r.durationMs });
    process.exit(1);
  }
} else {
  await runForever();
}

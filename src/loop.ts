import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { ideate } from "./ideate.ts";
import { generateGame } from "./generate.ts";
import { takeThumbnail } from "./screenshot.ts";
import { publishGame } from "./publish.ts";
import { notifyDiscord } from "./notify.ts";

export type TickResult =
  | { ok: true; slug: string; durationMs: number }
  | { ok: false; error: string; durationMs: number };

export async function runOnce(): Promise<TickResult> {
  const start = Date.now();
  try {
    const idea = await ideate();
    log.info("tick: idea picked", { slug: idea.slug, title: idea.title });

    const gen = await generateGame(idea, { maxAttempts: 3 });
    if (!gen.ok) {
      log.error("tick: generate failed (sandbox preserved for inspection)", {
        slug: idea.slug,
        sandbox: gen.sandbox.dir,
        errors: gen.errors,
      });
      return {
        ok: false,
        error: `generate failed for ${idea.slug}: ${gen.errors.join("; ")}`,
        durationMs: Date.now() - start,
      };
    }

    const thumbnailPath = join(gen.sandbox.dir, "thumbnail.png");
    await takeThumbnail({ sandboxDir: gen.sandbox.dir, thumbnailPath });

    const pub = await publishGame({
      slug: idea.slug,
      meta: gen.meta,
      sandboxDir: gen.sandbox.dir,
      thumbnailPath,
    });

    const totalMs = Date.now() - start;
    await notifyDiscord({
      meta: gen.meta,
      liveUrl: pub.liveUrl,
      thumbnailUrl: pub.thumbnailUrl,
      attempts: gen.attempts,
      durationMs: totalMs,
    });

    await gen.sandbox.cleanup();
    log.info("tick: success", { slug: idea.slug, durationMs: totalMs, attempts: gen.attempts });
    return { ok: true, slug: idea.slug, durationMs: totalMs };
  } catch (err) {
    const e = err as Error;
    log.error("tick: unhandled error", { error: e.message, stack: e.stack });
    return { ok: false, error: e.message, durationMs: Date.now() - start };
  }
}

const MAX_CONSECUTIVE_FAILURES = 5;

export async function runForever(): Promise<never> {
  const cfg = loadConfig();
  let consecutiveFailures = 0;
  let tickN = 0;

  log.info("loop: starting", { cooldownMs: cfg.LOOP_COOLDOWN_MS });

  while (true) {
    tickN++;
    log.info("loop: tick start", { tickN });
    const r = await runOnce();
    if (r.ok) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      log.warn("loop: tick failed", { tickN, consecutiveFailures, error: r.error });
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log.error("loop: too many consecutive failures, exiting (systemd will restart)", {
          consecutiveFailures,
        });
        process.exit(2);
      }
    }
    log.info("loop: cooldown", { ms: cfg.LOOP_COOLDOWN_MS });
    await new Promise((res) => setTimeout(res, cfg.LOOP_COOLDOWN_MS));
  }
}

import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { ideate } from "./ideate.ts";
import { generateGame } from "./generate.ts";
import { gitOrThrow } from "./git_repo.ts";
import { takeThumbnail } from "./screenshot.ts";
import { publishGame } from "./publish.ts";
import { notifyDiscord } from "./notify.ts";

export type TickResult =
  | { ok: true; slug: string; durationMs: number }
  | { ok: false; error: string; durationMs: number };

/**
 * Outer deadman: races a Promise against a timer that rejects. If the inner
 * work has its own kill/abort, this is belt-and-suspenders; if it doesn't
 * (e.g. a hang inside a 3rd-party module like playwright-core), this is the
 * only thing that lets the loop escape.
 */
async function withDeadline<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} exceeded deadline of ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withRetries<T>(
  label: string,
  attempts: number,
  fn: (attempt: number) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const e = err as Error;
      if (attempt < attempts) {
        log.warn(`${label}: failed, retrying`, {
          attempt,
          attempts,
          error: e.message,
        });
      } else {
        log.error(`${label}: failed after all attempts`, {
          attempts,
          error: e.message,
        });
      }
    }
  }
  throw lastErr;
}

export async function runOnce(): Promise<TickResult> {
  const start = Date.now();
  try {
    const idea = await ideate();
    log.info("tick: idea picked", { slug: idea.slug, title: idea.title });

    const gen = await generateGame(idea);
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
    await withRetries("thumbnail", 3, () =>
      withDeadline(
        "thumbnail",
        60_000,
        takeThumbnail({ sandboxDir: gen.sandbox.dir, thumbnailPath }),
      ),
    );

    const pub = await withRetries("publish", 3, () =>
      withDeadline(
        "publish",
        120_000,
        publishGame({
          slug: idea.slug,
          meta: gen.meta,
          sandboxDir: gen.sandbox.dir,
          thumbnailPath,
        }),
      ),
    );

    const totalMs = Date.now() - start;
    try {
      await withDeadline(
        "notify",
        20_000,
        notifyDiscord({
          meta: gen.meta,
          liveUrl: pub.liveUrl,
          thumbnailUrl: pub.thumbnailUrl,
          shippedAfterStage: gen.shippedAfterStage,
          totalStages: gen.totalStages,
          durationMs: totalMs,
        }),
      );
    } catch (err) {
      log.warn("notify: discord failed, continuing", { error: (err as Error).message });
    }

    await gen.sandbox.cleanup();
    log.info("tick: success", {
      slug: idea.slug,
      durationMs: totalMs,
      shippedAfterStage: gen.shippedAfterStage,
      totalStages: gen.totalStages,
    });
    return { ok: true, slug: idea.slug, durationMs: totalMs };
  } catch (err) {
    const e = err as Error;
    log.error("tick: unhandled error", { error: e.message, stack: e.stack });
    return { ok: false, error: e.message, durationMs: Date.now() - start };
  }
}

async function bunInstall(cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["install", "--frozen-lockfile"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf-8"); });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      reject(new Error(`bun install timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`bun install exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}

/**
 * Pull new commits between iterations. If anything is fetched and applied,
 * exit so systemd restarts the service with the new code. Failures are
 * logged but never break the loop — running on stale code beats halting.
 */
async function selfUpdateAndMaybeExit(): Promise<void> {
  const cwd = process.cwd();

  try {
    await gitOrThrow(cwd, ["fetch", "origin"], { timeoutMs: 30_000 });
  } catch (err) {
    log.warn("self-update: fetch failed, skipping", { error: (err as Error).message });
    return;
  }

  let local: string;
  let remote: string;
  try {
    local = (await gitOrThrow(cwd, ["rev-parse", "HEAD"], { timeoutMs: 10_000 })).stdout.trim();
    remote = (await gitOrThrow(cwd, ["rev-parse", "@{u}"], { timeoutMs: 10_000 })).stdout.trim();
  } catch (err) {
    log.warn("self-update: rev-parse failed, skipping", { error: (err as Error).message });
    return;
  }

  if (local === remote) {
    log.info("self-update: up to date", { commit: local.slice(0, 8) });
    return;
  }

  log.info("self-update: new commits available, pulling", {
    local: local.slice(0, 8),
    remote: remote.slice(0, 8),
  });

  try {
    await gitOrThrow(cwd, ["pull", "--ff-only"], { timeoutMs: 60_000 });
  } catch (err) {
    // --ff-only refuses if history diverged. Don't reset --hard automatically;
    // the deploy box may have local commits we shouldn't silently nuke.
    log.error("self-update: pull --ff-only failed; staying on old code", {
      error: (err as Error).message,
    });
    return;
  }

  try {
    await bunInstall(cwd, 120_000);
  } catch (err) {
    log.error("self-update: bun install failed; staying on old code", {
      error: (err as Error).message,
    });
    return;
  }

  log.info("self-update: applied, exiting so systemd restarts on new code", {
    from: local.slice(0, 8),
    to: remote.slice(0, 8),
  });
  process.exit(2);
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
    await selfUpdateAndMaybeExit();

    log.info("loop: cooldown", { ms: cfg.LOOP_COOLDOWN_MS });
    await new Promise((res) => setTimeout(res, cfg.LOOP_COOLDOWN_MS));
  }
}

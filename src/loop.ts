import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { ideate } from "./ideate.ts";
import { generateGame } from "./generate.ts";
import { gitOrThrow } from "./git-repo.ts";
import { takeThumbnail } from "./screenshot.ts";
import { publishGame } from "./publish.ts";
import { publishFailureLog } from "./publish-log.ts";
import { notifyDiscord } from "./notify.ts";
import { createSandbox } from "./sandbox.ts";
import { withDeadline } from "./deadline.ts";

export type TickResult =
  | { ok: true; slug: string; durationMs: number }
  | { ok: false; error: string; durationMs: number };

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
  // Slug is decided post-ideate, so the sandbox uses a random temp name.
  const tempSlug = `tick-${randomBytes(4).toString("hex")}`;
  const sandbox = await createSandbox(tempSlug);
  log.info("tick: sandbox created", { dir: sandbox.dir });

  try {
    log.phase("ideate");
    try {
      await ideate(sandbox);
    } catch (err) {
      const e = err as Error;
      log.error("tick: ideate failed (sandbox preserved for inspection)", {
        sandbox: sandbox.dir,
        error: e.message,
      });
      try {
        log.phase("publish-failure-log");
        await withDeadline(
          "publish-failure-log",
          120_000,
          publishFailureLog({
            tempSlug,
            sandboxDir: sandbox.dir,
            sandboxTranscriptsDir: sandbox.transcriptsDir,
            failedPhase: "ideate",
            errors: [e.message],
          }),
        );
      } catch (err2) {
        log.warn("publish-failure-log: failed, continuing", { error: (err2 as Error).message });
      }
      return {
        ok: false,
        error: `ideate failed: ${e.message}`,
        durationMs: Date.now() - start,
      };
    }

    const gen = await generateGame(sandbox);
    if (!gen.ok) {
      log.error("tick: generate failed (sandbox preserved for inspection)", {
        sandbox: gen.sandbox.dir,
        failedPhase: gen.failedPhase,
        errors: gen.errors,
      });
      try {
        log.phase("publish-failure-log");
        await withDeadline(
          "publish-failure-log",
          120_000,
          publishFailureLog({
            tempSlug,
            sandboxDir: gen.sandbox.dir,
            sandboxTranscriptsDir: gen.sandbox.transcriptsDir,
            failedPhase: gen.failedPhase,
            errors: gen.errors,
            meta: gen.meta,
          }),
        );
      } catch (err) {
        log.warn("publish-failure-log: failed, continuing", { error: (err as Error).message });
      }
      return {
        ok: false,
        error: `generate failed at phase ${gen.failedPhase}: ${gen.errors.join("; ")}`,
        durationMs: Date.now() - start,
      };
    }

    log.phase("screenshot");
    const thumbnailPath = join(gen.sandbox.dir, "thumbnail.png");
    await withRetries("thumbnail", 3, () =>
      withDeadline(
        "thumbnail",
        60_000,
        takeThumbnail({ sandboxDir: gen.sandbox.dir, thumbnailPath }),
      ),
    );

    log.phase("publish");
    const pub = await withRetries("publish", 3, () =>
      withDeadline(
        "publish",
        120_000,
        publishGame({
          slug: gen.slug,
          meta: gen.meta,
          sandboxDir: gen.sandbox.dir,
          thumbnailPath,
        }),
      ),
    );

    log.phase("notify");
    const totalMs = Date.now() - start;
    try {
      await withDeadline(
        "notify",
        20_000,
        notifyDiscord({
          meta: gen.meta,
          liveUrl: pub.liveUrl,
          thumbnailUrl: pub.thumbnailUrl,
          durationMs: totalMs,
        }),
      );
    } catch (err) {
      log.warn("notify: discord failed, continuing", { error: (err as Error).message });
    }

    await gen.sandbox.cleanup();
    log.info("tick: success", { slug: gen.slug, durationMs: totalMs });
    return { ok: true, slug: gen.slug, durationMs: totalMs };
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
  log.phase("self-update");
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

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withDeadline } from "../deadline.ts";
import { log } from "../log.ts";
import { runPlaytest } from "./playtest.ts";
import type { ValidationResult } from "./types.ts";

export type BrowserCheckOptions = {
  sandboxDir: string;
  watchMs?: number;
};

/**
 * Fast-path browser load that captures only runtime errors. Used by the
 * implement-stage console-fix iteration loop where running the full
 * browserChecks (with playtest) per iteration would be wasteful.
 */
export async function consoleErrorCheck(
  sandboxDir: string,
  watchMs = 3_000,
): Promise<string[]> {
  const errors: string[] = [];
  const { chromium } = await import("playwright-core");
  const browser = await withDeadline(
    "consoleCheck.launch",
    15_000,
    chromium.launch({ headless: true, timeout: 15_000 }),
  );
  try {
    return await withDeadline("consoleCheck.run", 25_000, (async (): Promise<string[]> => {
      const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
      });
      const url = pathToFileURL(join(sandboxDir, "index.html")).href;
      try {
        await page.goto(url, { waitUntil: "load", timeout: 10_000 });
      } catch (e) {
        errors.push(`failed to load page: ${(e as Error).message}`);
        return errors;
      }
      await page.waitForTimeout(watchMs);
      return errors;
    })());
  } catch (e) {
    errors.push(`consoleCheck failed: ${(e as Error).message}`);
    return errors;
  } finally {
    try {
      await withDeadline("consoleCheck.close", 5_000, browser.close());
    } catch (e) {
      log.warn("consoleCheck: browser.close timed out / failed", { error: (e as Error).message });
    }
  }
}

export async function browserChecks(opts: BrowserCheckOptions): Promise<ValidationResult> {
  // watchMs is the post-load init window before playtest begins. Kept short
  // because the playtest itself watches for ~8s on top.
  const watchMs = opts.watchMs ?? 2_000;
  const errors: string[] = [];

  const { chromium } = await import("playwright-core");
  // chromium.launch can hang if the binary can't be resolved — explicit cap.
  const browser = await withDeadline(
    "validate.browser.launch",
    15_000,
    chromium.launch({ headless: true, timeout: 15_000 }),
  );

  try {
    // Outer cap on all in-browser work below. A page misbehaving (infinite
    // sync loop, wedged WebAudio init, etc.) won't be cancelled by this
    // racing — but the finally below force-closes the browser, killing any
    // stuck script.
    return await withDeadline("validate.browser", 45_000, (async (): Promise<ValidationResult> => {
      const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);

      page.on("pageerror", (err) => {
        errors.push(`pageerror: ${err.message}`);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
      });

      const url = pathToFileURL(join(opts.sandboxDir, "index.html")).href;
      try {
        await page.goto(url, { waitUntil: "load", timeout: 10_000 });
      } catch (e) {
        errors.push(`failed to load page: ${(e as Error).message}`);
        return { ok: false, errors };
      }

      // Short post-load init window so the game can wire up window.__game and
      // start its RAF loop before we begin probing.
      await page.waitForTimeout(watchMs);

      // page.evaluate can hang if the page's JS thread is busy in an infinite
      // loop. Race it with our own timer.
      let drewSomething = false;
      try {
        drewSomething = await withDeadline(
          "validate.browser.evaluate",
          10_000,
          page.evaluate(() => {
            const c = document.getElementById("game") as HTMLCanvasElement | null;
            if (!c) return false;
            const ctx = c.getContext("2d");
            if (!ctx) return false;
            try {
              const { data } = ctx.getImageData(0, 0, c.width, c.height);
              const seen = new Set<number>();
              for (let i = 0; i < data.length; i += 4 * 256) {
                const v = (data[i]! << 24) | (data[i + 1]! << 16) | (data[i + 2]! << 8) | data[i + 3]!;
                seen.add(v);
                if (seen.size > 1) return true;
              }
              return seen.size > 1;
            } catch {
              return false;
            }
          }),
        );
      } catch (e) {
        errors.push(`page.evaluate stalled or threw: ${(e as Error).message}`);
      }
      if (!drewSomething && !errors.some((e) => e.startsWith("page.evaluate"))) {
        errors.push("canvas: appears blank (only one color) after watch window — game may not be drawing");
      }

      // Bail before playtest if there's already a fatal error — playtest
      // results would be noise on top of an already-broken page.
      if (errors.length > 0) return { ok: false, errors };

      try {
        await runPlaytest(page, errors);
      } catch (e) {
        errors.push(`playtest harness threw: ${(e as Error).message}`);
      }

      return { ok: errors.length === 0, errors };
    })());
  } catch (e) {
    // Outer deadline tripped, or a non-deadline throw. Either way, mark as fail.
    errors.push(`browserChecks failed: ${(e as Error).message}`);
    return { ok: false, errors };
  } finally {
    // Best-effort close. If close itself hangs (it can, on a stuck page),
    // race it with a short deadline — the browser process will be cleaned up
    // when the parent exits even if we leak the handle here.
    try {
      await withDeadline("validate.browser.close", 5_000, browser.close());
    } catch (e) {
      log.warn("validate: browser.close timed out / failed", { error: (e as Error).message });
    }
  }
}

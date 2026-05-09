import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, type HTMLElement } from "node-html-parser";
import { GameMetaSchema, type GameMeta } from "./games_index.ts";
import { withDeadline } from "./deadline.ts";
import { log } from "./log.ts";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  meta?: GameMeta;
};

const FORBIDDEN_URL_RE = /\b(src|href)\s*=\s*["'](https?:)?\/\//i;

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function staticChecks(sandboxDir: string): Promise<ValidationResult> {
  const errors: string[] = [];
  let meta: GameMeta | undefined;

  // 1. file presence
  const indexPath = join(sandboxDir, "index.html");
  const metaPath = join(sandboxDir, "meta.json");
  try {
    await stat(indexPath);
  } catch {
    errors.push("Required file missing: index.html");
  }
  try {
    await stat(metaPath);
  } catch {
    errors.push("Required file missing: meta.json");
  }
  if (errors.length > 0) return { ok: false, errors };

  // 2. meta.json schema
  const metaRaw = await readFile(metaPath, "utf-8");
  let metaJson: unknown;
  try {
    metaJson = JSON.parse(metaRaw);
  } catch (e) {
    errors.push(`meta.json is not valid JSON: ${(e as Error).message}`);
    return { ok: false, errors };
  }
  const metaParsed = GameMetaSchema.safeParse(metaJson);
  if (!metaParsed.success) {
    for (const issue of metaParsed.error.issues) {
      errors.push(`meta.json: ${issue.path.join(".")} - ${issue.message}`);
    }
    return { ok: false, errors };
  }
  meta = metaParsed.data;

  // 3. index.html structure
  const html = await readFile(indexPath, "utf-8");
  const root = parse(html);

  const canvases = root.querySelectorAll("canvas#game");
  if (canvases.length === 0) {
    errors.push('index.html: missing <canvas id="game">');
  } else if (canvases.length > 1) {
    errors.push(`index.html: found ${canvases.length} <canvas id="game"> elements; must be exactly 1`);
  }

  const headers = root.querySelectorAll("header.game-header");
  if (headers.length === 0) {
    errors.push('index.html: missing <header class="game-header">');
  } else {
    const header = headers[0] as HTMLElement;
    const h1 = header.querySelector("h1");
    if (!h1) {
      errors.push("index.html: <header> missing <h1>");
    } else if (normalize(h1.text) !== normalize(meta.title)) {
      errors.push(
        `index.html: <h1> text "${normalize(h1.text)}" does not match meta.json title "${normalize(meta.title)}"`,
      );
    }
    const desc = header.querySelector("p.game-description");
    if (!desc) {
      errors.push('index.html: <header> missing <p class="game-description">');
    } else if (normalize(desc.text) !== normalize(meta.description)) {
      errors.push(
        `index.html: <p class="game-description"> text does not match meta.json description`,
      );
    }
    const controlList = header.querySelector("ul.game-controls");
    if (!controlList) {
      errors.push('index.html: <header> missing <ul class="game-controls">');
    } else {
      const items = controlList.querySelectorAll("li").map((li) => normalize(li.text));
      const expected = meta.controls.map(normalize);
      if (items.length !== expected.length || items.some((v, i) => v !== expected[i])) {
        errors.push(
          `index.html: controls list mismatch. Got [${items.join(" | ")}], expected [${expected.join(" | ")}]`,
        );
      }
    }
  }

  // 4. no external URLs in src/href
  if (FORBIDDEN_URL_RE.test(html)) {
    errors.push(
      "index.html: contains a src= or href= pointing to an external URL. The page must be self-contained.",
    );
  }

  return { ok: errors.length === 0, errors, meta };
}

export type BrowserCheckOptions = {
  sandboxDir: string;
  watchMs?: number;
};

export async function browserChecks(opts: BrowserCheckOptions): Promise<ValidationResult> {
  const watchMs = opts.watchMs ?? 5_000;
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
    return await withDeadline("validate.browser", 30_000, (async (): Promise<ValidationResult> => {
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

      // Wait the watch window for runtime errors. If the page's RAF loop is
      // doing heavy work, this is fine — it's just sleeping our side.
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

export async function validate(sandboxDir: string): Promise<ValidationResult> {
  const sr = await staticChecks(sandboxDir);
  if (!sr.ok) return sr;

  const br = await browserChecks({ sandboxDir });
  if (!br.ok) return { ok: false, errors: br.errors, meta: sr.meta };

  return { ok: true, errors: [], meta: sr.meta };
}

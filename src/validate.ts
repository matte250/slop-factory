import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, type HTMLElement } from "node-html-parser";
import { GameMetaSchema, type GameMeta } from "./games-index.ts";
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

  const restartButtons = root.querySelectorAll("button#restart");
  if (restartButtons.length === 0) {
    errors.push('index.html: missing <button id="restart" class="game-restart">Restart</button> after the canvas — required so players can restart without keyboard');
  } else if (restartButtons.length > 1) {
    errors.push(`index.html: found ${restartButtons.length} <button id="restart"> elements; must be exactly 1`);
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

const PLAYTEST_KEYS = [
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Space", "KeyW", "KeyA", "KeyS", "KeyD",
];

const PLAY_DURATION_MS = 8_000;
const POLL_INTERVAL_MS = 250;
const VISIBLE_THRESHOLD = 0.95;
const VALID_STATES = new Set(["menu", "playing", "gameover"]);

type ObservedState = {
  present: boolean;
  state?: unknown;
  score?: unknown;
  player?: { x?: unknown; y?: unknown; visible?: unknown };
  objective?: unknown;
};

async function readGameState(page: import("playwright-core").Page): Promise<ObservedState> {
  return await withDeadline(
    "validate.browser.readState",
    5_000,
    page.evaluate(() => {
      const g = (window as unknown as { __game?: Record<string, unknown> }).__game;
      if (!g || typeof g !== "object") return { present: false };
      const p = g.player as Record<string, unknown> | undefined;
      return {
        present: true,
        state: g.state,
        score: g.score,
        player: p
          ? { x: p.x, y: p.y, visible: p.visible }
          : undefined,
        objective: g.objective,
      };
    }),
  );
}

function checkInitialContract(s: ObservedState, errors: string[]): boolean {
  if (!s.present) {
    errors.push(
      'playtest: window.__game is not exposed. Required shape: { state: "menu"|"playing"|"gameover", score: number, player: { x: number, y: number, visible: boolean }, objective: string }. Set this on the very first frame, before any input.',
    );
    return false;
  }
  let ok = true;
  if (typeof s.state !== "string" || !VALID_STATES.has(s.state)) {
    errors.push(`playtest: window.__game.state is ${JSON.stringify(s.state)}; must be exactly "menu", "playing", or "gameover"`);
    ok = false;
  }
  if (typeof s.score !== "number" || !Number.isFinite(s.score)) {
    errors.push(`playtest: window.__game.score is ${JSON.stringify(s.score)}; must be a finite number`);
    ok = false;
  }
  if (!s.player || typeof s.player !== "object") {
    errors.push("playtest: window.__game.player is missing; must be { x: number, y: number, visible: boolean }");
    ok = false;
  } else {
    if (typeof s.player.x !== "number" || !Number.isFinite(s.player.x)) {
      errors.push(`playtest: window.__game.player.x is ${JSON.stringify(s.player.x)}; must be a finite number`);
      ok = false;
    }
    if (typeof s.player.y !== "number" || !Number.isFinite(s.player.y)) {
      errors.push(`playtest: window.__game.player.y is ${JSON.stringify(s.player.y)}; must be a finite number`);
      ok = false;
    }
    if (typeof s.player.visible !== "boolean") {
      errors.push(`playtest: window.__game.player.visible is ${JSON.stringify(s.player.visible)}; must be a boolean`);
      ok = false;
    }
  }
  if (typeof s.objective !== "string" || s.objective.length < 10 || s.objective.length > 200) {
    errors.push(`playtest: window.__game.objective must be a 10-200 char single-sentence string describing what the player is trying to do; got ${JSON.stringify(s.objective)}`);
    ok = false;
  }
  return ok;
}

async function runPlaytest(page: import("playwright-core").Page, errors: string[]): Promise<void> {
  const initial = await readGameState(page);
  if (!checkInitialContract(initial, errors)) return;

  let invisibleFrames = 0;
  let totalFrames = 0;
  let scoreChanges = 0;
  let lastScore = initial.score as number;
  let reachedGameOver = (initial.state as string) === "gameover";
  const seenStates = new Set<string>([initial.state as string]);
  const invalidStates = new Set<string>();
  let keyIdx = 0;

  const startedAt = Date.now();
  while (Date.now() - startedAt < PLAY_DURATION_MS) {
    const key = PLAYTEST_KEYS[keyIdx % PLAYTEST_KEYS.length]!;
    keyIdx++;
    try {
      await page.keyboard.press(key);
    } catch {
      // page may have navigated/crashed — caught by next read
    }
    await page.waitForTimeout(POLL_INTERVAL_MS);

    let s: ObservedState;
    try {
      s = await readGameState(page);
    } catch (e) {
      errors.push(`playtest: failed to read window.__game during play (${(e as Error).message}). Likely a runtime error or wedged JS thread.`);
      return;
    }

    if (!s.present) {
      errors.push("playtest: window.__game disappeared during play. It must remain set for the lifetime of the page.");
      return;
    }
    totalFrames++;
    if (s.player && s.player.visible === false) invisibleFrames++;
    if (typeof s.score === "number" && Number.isFinite(s.score) && s.score !== lastScore) {
      scoreChanges++;
      lastScore = s.score;
    }
    if (typeof s.state === "string") {
      seenStates.add(s.state);
      if (s.state === "gameover") reachedGameOver = true;
      if (!VALID_STATES.has(s.state)) invalidStates.add(s.state);
    }
  }

  if (invalidStates.size > 0) {
    errors.push(
      `playtest: window.__game.state took invalid value(s) during play: ${[...invalidStates].map((s) => JSON.stringify(s)).join(", ")}. Allowed: "menu", "playing", "gameover".`,
    );
  }

  if (totalFrames > 0) {
    const visibleFrac = 1 - invisibleFrames / totalFrames;
    if (visibleFrac < VISIBLE_THRESHOLD) {
      errors.push(
        `playtest: player was off-screen for ${invisibleFrames}/${totalFrames} polled frames (${Math.round((1 - visibleFrac) * 100)}%). player.visible must be true for at least ${Math.round(VISIBLE_THRESHOLD * 100)}% of frames during play. If your camera follows the player, the camera math must keep the player inside the canvas viewport.`,
      );
    }
  }

  if (scoreChanges === 0 && !reachedGameOver) {
    errors.push(
      `playtest: in ${PLAY_DURATION_MS / 1000}s of synthetic input (arrow keys, WASD, space), score never changed AND state never reached "gameover". The game has no progress signal — either input doesn't affect the world, or scoring is never wired up. Verify that pressing controls actually moves/scores/dies.`,
    );
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

export async function validate(sandboxDir: string): Promise<ValidationResult> {
  const sr = await staticChecks(sandboxDir);
  if (!sr.ok) return sr;

  const br = await browserChecks({ sandboxDir });
  if (!br.ok) return { ok: false, errors: br.errors, meta: sr.meta };

  return { ok: true, errors: [], meta: sr.meta };
}

const REQUIRED_DESIGN_SECTIONS = [
  "## Player",
  "## Hazards",
  "## Score",
  "## Game-over and restart",
  "## Mechanic verification",
  "## First 3 seconds",
];

export async function validateDesign(sandboxDir: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const designPath = join(sandboxDir, "DESIGN.md");
  let content = "";
  try {
    content = await readFile(designPath, "utf-8");
  } catch {
    errors.push("Required file missing: DESIGN.md");
    return { ok: false, errors };
  }
  for (const section of REQUIRED_DESIGN_SECTIONS) {
    if (!content.includes(section)) {
      errors.push(`DESIGN.md: missing required section header "${section}"`);
    }
  }
  return { ok: errors.length === 0, errors };
}

const CRITIQUE_BLOCK_OPEN = "=== CRITIQUE ANALYSIS";
const CRITIQUE_BLOCK_CLOSE = "=== END CRITIQUE ===";

/**
 * After the critique stage (and through polish), the index.html must contain
 * the critique's structured analysis as an audit trail. This both proves
 * critique actually ran and gives us something to read when a game still
 * ships broken.
 */
export async function validateWithCritiqueBlock(sandboxDir: string): Promise<ValidationResult> {
  const r = await validate(sandboxDir);
  if (!r.ok) return r;

  const html = await readFile(join(sandboxDir, "index.html"), "utf-8");
  if (!html.includes(CRITIQUE_BLOCK_OPEN) || !html.includes(CRITIQUE_BLOCK_CLOSE)) {
    return {
      ok: false,
      errors: [
        `index.html: missing critique analysis block. The critique stage must wrap its analysis in a JS comment containing the exact markers "${CRITIQUE_BLOCK_OPEN}" and "${CRITIQUE_BLOCK_CLOSE}", and the polish stage must preserve them.`,
      ],
      meta: r.meta,
    };
  }
  return r;
}

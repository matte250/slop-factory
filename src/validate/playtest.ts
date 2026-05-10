import { withDeadline } from "../deadline.ts";
import type { Page } from "playwright-core";

export const PLAYTEST_KEYS = [
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Space", "KeyW", "KeyA", "KeyS", "KeyD",
];

export const PLAY_DURATION_MS = 8_000;
const POLL_INTERVAL_MS = 250;
const VISIBLE_THRESHOLD = 0.95;
const VALID_STATES = new Set(["menu", "playing", "gameover"]);

export type ObservedState = {
  present: boolean;
  state?: unknown;
  score?: unknown;
  player?: { x?: unknown; y?: unknown; visible?: unknown };
  objective?: unknown;
};

async function readGameState(page: Page): Promise<ObservedState> {
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

export async function runPlaytest(page: Page, errors: string[]): Promise<void> {
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

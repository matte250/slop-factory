import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { z } from "zod";
import { chat } from "./llm.ts";
import { log } from "./log.ts";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(here, "..", "prompts", "examples");

/**
 * Short structural fingerprints for each available reference template. These
 * are shown to the LLM in pickExampleViaLLM so it can pick by code-shape fit,
 * not by surface vocabulary. Keep each description focused on patterns the
 * example demonstrates, not on the specific game it implements.
 */
export const EXAMPLE_DESCRIPTIONS: Record<string, string> = {
  snake:
    "Grid-stepping game on fixed integer cells. Discrete time steps (~140 ms per step) instead of continuous physics. Snake stored as an array of {x,y} cells with the head at index 0; growth = unshift, movement = pop tail. Best fit when the game lives on a grid, an entity grows over time, or 'one move per tick' fits the mechanic.",
  breakout:
    "Continuous floating-point physics with elastic collisions. A single ball bounces among a paddle, four walls, and a wall of bricks. AABB sweep-test collision; bounce direction depends on which axis penetrated less. Best fit when there's a single projectile bouncing in bounds, paddle/wall reflection, or a target-clearing objective.",
  asteroids:
    "Free 2D motion with rotation + thrust + screen-wrap. Multiple entity types (ship, bullets, asteroids) each with their own update loops; circle-vs-circle collision; wave-based progression where clearing all asteroids spawns the next wave. Best fit when the player pilots through open space, especially shooters or vector-style freeflight.",
};

export const EXAMPLE_NAMES = Object.keys(EXAMPLE_DESCRIPTIONS);

export type Example = { name: string; indexHtml: string; metaJson: string };

export async function loadExample(name: string): Promise<Example> {
  const indexHtml = await readFile(join(EXAMPLES_DIR, name, "index.html"), "utf-8");
  const metaJson = await readFile(join(EXAMPLES_DIR, name, "meta.json"), "utf-8");
  return { name, indexHtml, metaJson };
}

/**
 * Format an example as a prompt prelude. The framing makes it clear the
 * example is structural — the LLM should imitate the layout/conventions, not
 * the game itself.
 */
export function formatExampleForPrompt(ex: Example): string {
  return [
    `## Reference example: "${ex.name}"`,
    "",
    "The following is a complete, validator-passing game. **Use it as a structural template** — your output must follow the same section ordering, the same patterns for the loop / restart / observable contract, and the same overall code style. Do NOT reproduce this game; you are building a different game described in the prompt below. The example exists only to anchor structure.",
    "",
    "Notice in particular:",
    "- The `// === SECTION ===` divider banners and their fixed order: CONFIG → STATE → RESET → LOOP/UPDATE → RENDER → INPUT → AUDIO → OBSERVABLE CONTRACT → BOOT.",
    "- Plain object literals for game state (no `class`).",
    "- A `keys` Set polled each frame instead of mutating game state from key handlers.",
    "- `if (loopId !== null) cancelAnimationFrame(loopId)` at the top of `startLoop()`.",
    "- The animation loop body wrapped in `try/catch`.",
    "- `publishState()` called once per frame at the end of the tick.",
    "- `window.__game` populated honestly (player.visible reflects actual viewport position).",
    "- AudioContext initialized lazily inside `beep()`, wrapped in try/catch.",
    "",
    "### Example `meta.json`",
    "```json",
    ex.metaJson.trim(),
    "```",
    "",
    "### Example `index.html`",
    "```html",
    ex.indexHtml.trim(),
    "```",
    "",
    "---",
    "",
  ].join("\n");
}

// === LLM-DRIVEN PICKER ===================================================

const PickResponseSchema = z.object({
  choice: z.string(),
  reason: z.string().optional().default(""),
});

export type ExamplePick = {
  name: string;
  reason: string;
  /** Number of attempts (1-based) the LLM took to produce a valid pick. */
  attempts: number;
};

const PICK_MAX_ATTEMPTS = 6;

/**
 * Single attempt at the LLM pick. Returns the pick on success, a string
 * describing the failure mode on failure (used for retry logging).
 */
async function attemptPick(
  idea: { title: string; concept: string },
  designContent: string | null,
): Promise<{ ok: true; name: string; reason: string } | { ok: false; reason: string }> {
  const system = [
    "You are picking a structural code template for a small canvas game implementation.",
    "Each template demonstrates a different code shape. Pick the one whose code structure most closely matches what the new game needs — not the one whose theme matches.",
    "Templates available:",
    ...EXAMPLE_NAMES.map((n) => `- ${n}: ${EXAMPLE_DESCRIPTIONS[n]}`),
    "",
    "Respond with strict JSON, one object: { \"choice\": \"<name>\", \"reason\": \"<one short sentence>\" }. No prose, no markdown fences, no extra fields.",
    "The \"choice\" value must be exactly one of: " + EXAMPLE_NAMES.join(", ") + ".",
  ].join("\n");

  const userParts = [
    `Title: ${idea.title}`,
    `Concept: ${idea.concept}`,
  ];
  if (designContent && designContent.trim().length > 0) {
    userParts.push("", "Design document for context:", designContent.trim());
  }
  const user = userParts.join("\n");

  let reply: string;
  try {
    reply = await chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.3, responseFormat: "json_object" },
    );
  } catch (e) {
    return { ok: false, reason: `chat failed: ${(e as Error).message}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(reply);
  } catch {
    return { ok: false, reason: `response not JSON (preview: ${reply.slice(0, 160)})` };
  }

  const parsed = PickResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `schema mismatch: ${parsed.error.issues.map((i) => i.message).join(", ")}` };
  }
  if (!EXAMPLE_NAMES.includes(parsed.data.choice)) {
    return {
      ok: false,
      reason: `unknown choice "${parsed.data.choice}"; allowed: ${EXAMPLE_NAMES.join(", ")}`,
    };
  }
  return { ok: true, name: parsed.data.choice, reason: parsed.data.reason };
}

/**
 * Pick a reference template via the local LLM, retrying up to
 * PICK_MAX_ATTEMPTS times on transient failures (network errors, malformed
 * JSON, off-list choices). Throws if all attempts fail — there is no
 * keyword/heuristic fallback by design; the pipeline either gets an LLM-
 * grounded pick or fails the phase.
 */
export async function chooseExample(
  idea: { title: string; concept: string },
  designContent: string | null,
): Promise<ExamplePick> {
  let lastReason = "";
  for (let attempt = 1; attempt <= PICK_MAX_ATTEMPTS; attempt++) {
    const r = await attemptPick(idea, designContent);
    if (r.ok) return { name: r.name, reason: r.reason, attempts: attempt };
    lastReason = r.reason;
    if (attempt < PICK_MAX_ATTEMPTS) {
      log.warn("pick-example: attempt failed, retrying", { attempt, max: PICK_MAX_ATTEMPTS, reason: r.reason });
    }
  }
  throw new Error(`pick-example: exhausted ${PICK_MAX_ATTEMPTS} attempts; last reason: ${lastReason}`);
}

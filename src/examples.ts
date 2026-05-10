import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(here, "..", "prompts", "examples");

/**
 * Examples ranked from most-specific to least-specific match. The first whose
 * keywords overlap the idea wins; "snake" sits at the end as the no-keyword
 * fallback because it's the simplest reference shape (grid + step + grow).
 */
const EXAMPLES: { name: string; keywords: string[] }[] = [
  {
    name: "asteroids",
    keywords: [
      "shoot", "shooter", "fire", "bullet", "laser", "missile",
      "rotate", "thrust", "ship", "asteroid", "spaceship", "space",
      "wrap", "wraparound",
    ],
  },
  {
    name: "breakout",
    keywords: [
      "paddle", "brick", "bounce", "rebound", "ball", "break-out", "breakout",
      "block", "blocks", "wall",
    ],
  },
  // Fallback — the simplest reference shape.
  { name: "snake", keywords: [] },
];

export type Example = { name: string; indexHtml: string; metaJson: string };

export function pickExampleName(idea: { title: string; concept: string }): string {
  const text = (idea.title + " " + idea.concept).toLowerCase();
  for (const ex of EXAMPLES) {
    if (ex.keywords.length === 0) continue;
    if (ex.keywords.some((k) => text.includes(k))) return ex.name;
  }
  return "snake";
}

export async function loadExample(name: string): Promise<Example> {
  const indexHtml = await readFile(join(EXAMPLES_DIR, name, "index.html"), "utf-8");
  const metaJson = await readFile(join(EXAMPLES_DIR, name, "meta.json"), "utf-8");
  return { name, indexHtml, metaJson };
}

export async function loadExampleFor(idea: { title: string; concept: string }): Promise<Example> {
  return loadExample(pickExampleName(idea));
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

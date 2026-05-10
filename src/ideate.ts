import { z } from "zod";
import { chat } from "./llm.ts";
import { log } from "./log.ts";
import { readGamesIndex, uniqueSlug, type GameIndexEntry } from "./games-index.ts";

export type GameIdea = {
  title: string;
  slug: string;
  concept: string;
};

const IdeaSchema = z.object({
  title: z.string().min(3).max(80),
  concept: z.string().min(20).max(600),
});

const IdeasResponseSchema = z.object({
  ideas: z.array(IdeaSchema).min(1),
});

function summarizeExisting(existing: GameIndexEntry[]): string {
  if (existing.length === 0) return "(none yet — this is the very first game)";
  return existing
    .slice(0, 30)
    .map((g) => `- "${g.title}": ${g.description}`)
    .join("\n");
}

export async function ideate(): Promise<GameIdea> {
  const existing = await readGamesIndex();
  log.info("ideate: existing games", { count: existing.length });

  const system = [
    "You are brainstorming for the Slop Factory, a continuously-updating gallery of tiny canvas-based browser games.",
    "Each game is a single self-contained HTML file rendering on a <canvas>.",
    "Good ideas are: a clear single gameplay loop, doable as a small canvas game, mechanically distinct from prior entries.",
    "Avoid: anything requiring assets, anything multiplayer, anything needing network calls, anything with text-heavy UI.",
    "Respond with JSON only. No prose, no markdown fences. Structure: { \"ideas\": [{\"title\": string, \"concept\": string}, ...] }.",
  ].join(" ");

  const user = [
    "Existing games in the gallery (do not thematically duplicate any of these):",
    summarizeExisting(existing),
    "",
    "Brainstorm 3 distinct fresh ideas. For each: a 2-5 word title and a 1-2 sentence concept describing the core gameplay loop.",
  ].join("\n");

  const reply = await chat(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.95, responseFormat: "json_object", reasoningEffort: "low" },
  );

  log.debug("ideate: raw reply", { reply: reply.slice(0, 600) });

  let json: unknown;
  try {
    json = JSON.parse(reply);
  } catch (e) {
    throw new Error(`ideate: model did not return JSON: ${(e as Error).message}\n--- reply ---\n${reply.slice(0, 600)}`);
  }
  const parsed = IdeasResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`ideate: response did not match schema: ${parsed.error.message}\n--- reply ---\n${reply.slice(0, 600)}`);
  }

  const picked = parsed.data.ideas[0]!;
  const slug = uniqueSlug(picked.title, existing);
  const idea: GameIdea = { title: picked.title, slug, concept: picked.concept };
  log.info("ideate: picked", { idea });
  return idea;
}

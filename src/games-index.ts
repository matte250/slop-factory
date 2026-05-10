import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "./config.ts";

export const GameMetaSchema = z.object({
  title: z.string().min(3).max(80),
  description: z.string().min(20).max(400),
  controls: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string()).optional(),
});
export type GameMeta = z.infer<typeof GameMetaSchema>;

export const GameIndexEntrySchema = GameMetaSchema.extend({
  slug: z.string().min(1),
  publishedAt: z.string(),
});
export type GameIndexEntry = z.infer<typeof GameIndexEntrySchema>;

export const GameIndexSchema = z.array(GameIndexEntrySchema);

export async function readGamesIndex(): Promise<GameIndexEntry[]> {
  const cfg = loadConfig();
  const path = join(cfg.GAMES_REPO_PATH, "games-index.json");
  try {
    const raw = await readFile(path, "utf-8");
    return GameIndexSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function uniqueSlug(title: string, existing: GameIndexEntry[]): string {
  const taken = new Set(existing.map((e) => e.slug));
  const base = slugify(title);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not find a unique slug for "${title}"`);
}

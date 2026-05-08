import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { gitOrThrow } from "./git_repo.ts";
import {
  GameIndexSchema,
  type GameIndexEntry,
  type GameMeta,
} from "./games_index.ts";
import { readGamesIndex } from "./games_index.ts";
import { log } from "./log.ts";

export type PublishInput = {
  slug: string;
  meta: GameMeta;
  sandboxDir: string;
  thumbnailPath: string;
};

export type PublishResult = {
  liveUrl: string;
  thumbnailUrl: string;
  commit: string;
  entry: GameIndexEntry;
};

export async function publishGame(input: PublishInput): Promise<PublishResult> {
  const cfg = loadConfig();
  const gamesDir = join(cfg.GAMES_REPO_PATH, "games", input.slug);
  await mkdir(gamesDir, { recursive: true });

  await copyFile(join(input.sandboxDir, "index.html"), join(gamesDir, "index.html"));
  await copyFile(join(input.sandboxDir, "meta.json"), join(gamesDir, "meta.json"));
  await copyFile(input.thumbnailPath, join(gamesDir, "thumbnail.png"));

  const existing = await readGamesIndex();
  const filtered = existing.filter((e) => e.slug !== input.slug);
  const entry: GameIndexEntry = {
    ...input.meta,
    slug: input.slug,
    publishedAt: new Date().toISOString(),
  };
  const next = [entry, ...filtered].sort((a, b) =>
    b.publishedAt.localeCompare(a.publishedAt),
  );
  GameIndexSchema.parse(next);

  await writeFile(
    join(cfg.GAMES_REPO_PATH, "games-index.json"),
    JSON.stringify(next, null, 2) + "\n",
    "utf-8",
  );
  log.info("publish: files copied", { slug: input.slug, gamesDir });

  await gitOrThrow(cfg.GAMES_REPO_PATH, [
    "add",
    `games/${input.slug}/`,
    "games-index.json",
  ]);

  const status = await gitOrThrow(cfg.GAMES_REPO_PATH, ["status", "--porcelain"]);
  if (!status.stdout.trim()) {
    log.warn("publish: nothing to commit", { slug: input.slug });
  } else {
    await gitOrThrow(cfg.GAMES_REPO_PATH, [
      "commit",
      "-m",
      `add: ${input.meta.title} (${input.slug})`,
    ]);
  }

  await gitOrThrow(cfg.GAMES_REPO_PATH, ["push", "origin", "HEAD"]);

  const headRev = (await gitOrThrow(cfg.GAMES_REPO_PATH, ["rev-parse", "HEAD"])).stdout.trim();
  const base = cfg.GAMES_PAGES_BASE_URL.replace(/\/$/, "");
  const liveUrl = `${base}/games/${input.slug}/`;
  const thumbnailUrl = `${base}/games/${input.slug}/thumbnail.png`;

  log.info("publish: pushed", { slug: input.slug, commit: headRev, liveUrl });

  return { liveUrl, thumbnailUrl, commit: headRev, entry };
}

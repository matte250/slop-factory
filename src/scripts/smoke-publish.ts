import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { GameMetaSchema } from "../games_index.ts";
import { takeThumbnail } from "../screenshot.ts";
import { publishGame } from "../publish.ts";
import { log } from "../log.ts";

const sandboxDir = process.argv[2];
const slugArg = process.argv[3];
if (!sandboxDir) {
  process.stderr.write("usage: bun run src/scripts/smoke-publish.ts <sandbox-dir> [slug]\n");
  process.exit(1);
}

const meta = GameMetaSchema.parse(JSON.parse(await readFile(join(sandboxDir, "meta.json"), "utf-8")));

// derive slug from sandbox dir name if not provided
const slug = slugArg ?? sandboxDir.split("/").pop()!.replace(/-[0-9a-f]{8}$/, "");
log.info("smoke-publish: starting", { slug, sandboxDir });

const thumbnailPath = join(sandboxDir, "thumbnail.png");
await takeThumbnail({ sandboxDir, thumbnailPath });

const result = await publishGame({ slug, meta, sandboxDir, thumbnailPath });

process.stdout.write(`\n=== published ===\n`);
process.stdout.write(`slug:        ${slug}\n`);
process.stdout.write(`title:       ${meta.title}\n`);
process.stdout.write(`commit:      ${result.commit}\n`);
process.stdout.write(`live URL:    ${result.liveUrl}\n`);
process.stdout.write(`thumbnail:   ${result.thumbnailUrl}\n`);

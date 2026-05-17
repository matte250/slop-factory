import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log.ts";
import { runOpenCode } from "./opencode.ts";
import type { Sandbox } from "./sandbox.ts";

export type GameIdea = {
  /** Raw IDEA.md contents — used for downstream prompts and failure logs. */
  concept: string;
};

const IDEATE_PROMPT =
  "Come up with a random game idea that is possible to create in a HTML canvas. " +
  "Save the idea to a IDEA.md file in this working directory. " +
  "The game should have a lose condition. Be concice.";

export async function ideate(sandbox: Sandbox): Promise<GameIdea> {
  await runOpenCode({
    sandboxDir: sandbox.dir,
    prompt: IDEATE_PROMPT,
    variant: "high",
    transcriptDir: sandbox.transcriptsDir,
    transcriptLabel: "ideate",
  });

  const ideaPath = join(sandbox.dir, "IDEA.md");
  try {
    await stat(ideaPath);
  } catch {
    throw new Error("ideate: IDEA.md was not created by opencode");
  }
  const concept = (await readFile(ideaPath, "utf-8")).trim();
  if (concept.length === 0) {
    throw new Error("ideate: IDEA.md is empty");
  }
  log.info("ideate: IDEA.md written", { bytes: concept.length });
  return { concept };
}

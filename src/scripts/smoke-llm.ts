import { chat } from "../llm.ts";
import { log } from "../log.ts";

const reply = await chat(
  [
    {
      role: "system",
      content:
        "You are a brainstormer for a tiny browser-game gallery. Reply with exactly three short, distinct, single-line game ideas, numbered 1-3. No prose around them.",
    },
    {
      role: "user",
      content: "Brainstorm three fresh tiny browser-game ideas. Existing titles: (none yet).",
    },
  ],
  { temperature: 0.9, maxTokens: 200 },
);

log.info("smoke-llm reply", { reply });
process.stdout.write("\n--- raw reply ---\n" + reply + "\n");

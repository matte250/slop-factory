import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import type { GameMeta } from "./games_index.ts";

export type NotifyInput = {
  meta: GameMeta;
  liveUrl: string;
  thumbnailUrl: string;
  attempts: number;
  durationMs: number;
};

export async function notifyDiscord(input: NotifyInput): Promise<void> {
  const cfg = loadConfig();

  const body = {
    embeds: [
      {
        title: `🎮 ${input.meta.title}`,
        description: input.meta.description,
        url: input.liveUrl,
        color: 0x7df9ff,
        image: { url: input.thumbnailUrl },
        fields: [
          {
            name: "Controls",
            value: input.meta.controls.map((c) => `• ${c}`).join("\n").slice(0, 1024),
            inline: false,
          },
        ],
        footer: {
          text: `attempt ${input.attempts} · ${(input.durationMs / 1000).toFixed(1)}s · ${cfg.OPENCODE_MODEL}`,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(cfg.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`Discord webhook ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }

  log.info("notify: posted to Discord", { slug: input.meta.title, status: res.status });
}

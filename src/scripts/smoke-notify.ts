import { notifyDiscord } from "../notify.ts";

await notifyDiscord({
  meta: {
    title: "Smoke Test",
    description: "If you see this in Discord, the webhook + embed formatting works. Ignore me.",
    controls: ["This is a test", "Not a real game"],
  },
  liveUrl: "https://matte250.github.io/slop-factory-site",
  thumbnailUrl: "https://matte250.github.io/slop-factory-site/games/gravity-flip/thumbnail.png",
  taskCount: 12,
  durationMs: 12345,
});

process.stdout.write("posted.\n");

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "./log.ts";

export type ScreenshotOptions = {
  sandboxDir: string;
  thumbnailPath: string;
  /** ms to wait after load before capturing (lets the game render some action) */
  warmupMs?: number;
  /** target dimensions (resized in-page via canvas to keep file small) */
  width?: number;
  height?: number;
};

export async function takeThumbnail(opts: ScreenshotOptions): Promise<void> {
  const warmupMs = opts.warmupMs ?? 3_000;
  const width = opts.width ?? 600;
  const height = opts.height ?? 400;

  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const page = await context.newPage();
    const url = pathToFileURL(join(opts.sandboxDir, "index.html")).href;
    await page.goto(url, { waitUntil: "load", timeout: 10_000 });
    await page.waitForTimeout(warmupMs);

    const dataUrl = await page.evaluate(
      ({ width, height }) => {
        const canvas = document.getElementById("game") as HTMLCanvasElement | null;
        if (!canvas) throw new Error("no canvas#game found at thumbnail time");
        const off = document.createElement("canvas");
        off.width = width;
        off.height = height;
        const ctx = off.getContext("2d");
        if (!ctx) throw new Error("could not get 2d context for offscreen canvas");
        ctx.drawImage(canvas, 0, 0, width, height);
        return off.toDataURL("image/png");
      },
      { width, height },
    );

    const base64 = dataUrl.split(",")[1];
    if (!base64) throw new Error("invalid data URL from canvas.toDataURL");
    await writeFile(opts.thumbnailPath, Buffer.from(base64, "base64"));
    log.info("screenshot saved", { path: opts.thumbnailPath, width, height });
  } finally {
    await browser.close();
  }
}

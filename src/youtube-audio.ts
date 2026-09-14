import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./types";

export interface ResolvedAudio {
  url: string;
  mimeType?: string;
  bitrate?: number;
  approxDurationMs?: number;
}

function parseNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolve a short-lived YouTube audio media URL by letting Cloudflare Browser Run
 * execute YouTube's own player code. This avoids doing player JS parsing / decipher
 * work inside the 10 ms CPU budget of a Free Worker.
 *
 * Resource filtering also executes inside Chromium (via PerformanceResourceTiming)
 * so the Worker does not receive a callback for every network request on YouTube.
 * The Worker never proxies media bytes; it returns the observed signed audio URL
 * directly to Groq.
 */
export async function resolveYouTubeAudioUrl(env: Env, videoId: string): Promise<ResolvedAudio> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    );

    await page.goto(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    // Trigger media loading if autoplay did not already do so.
    try {
      await page.waitForSelector("video", { timeout: 5_000 });
      await page.click(".ytp-play-button", { delay: 20 });
    } catch {
      try {
        await page.evaluate(() => {
          const video = document.querySelector("video") as HTMLVideoElement | null;
          if (video) void video.play().catch(() => undefined);
        });
      } catch {
        // The resource-timing probe below remains the source of truth.
      }
    }

    await page.waitForFunction(
      () =>
        performance.getEntriesByType("resource").some((entry) => {
          try {
            const url = new URL(entry.name);
            return (
              url.hostname.endsWith(".googlevideo.com") &&
              url.pathname.includes("videoplayback") &&
              (url.searchParams.get("mime") || "").startsWith("audio/")
            );
          } catch {
            return false;
          }
        }),
      { timeout: 20_000, polling: 250 },
    );

    const rawUrl = await page.evaluate(() => {
      for (const entry of performance.getEntriesByType("resource")) {
        try {
          const url = new URL(entry.name);
          if (
            url.hostname.endsWith(".googlevideo.com") &&
            url.pathname.includes("videoplayback") &&
            (url.searchParams.get("mime") || "").startsWith("audio/")
          ) {
            return entry.name;
          }
        } catch {
          // Ignore non-URL resource entries.
        }
      }
      return null;
    });

    if (!rawUrl) throw new Error("Chromium loaded the page but exposed no audio googlevideo resource");

    const url = new URL(rawUrl);
    const durationSeconds = parseNumber(url.searchParams.get("dur"));

    return {
      url: rawUrl,
      mimeType: url.searchParams.get("mime") || undefined,
      approxDurationMs: durationSeconds !== undefined ? durationSeconds * 1000 : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Browser Run did not observe a YouTube audio resource for ${videoId}: ${message}`);
  } finally {
    await browser.close();
  }
}

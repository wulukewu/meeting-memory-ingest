import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./types";

export interface ResolvedAudio {
  url: string;
  mimeType?: string;
  bitrate?: number;
  approxDurationMs?: number;
}

function isGoogleVideoAudioUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!url.hostname.endsWith(".googlevideo.com")) return false;
    if (!url.pathname.includes("videoplayback")) return false;
    return (url.searchParams.get("mime") || "").startsWith("audio/");
  } catch {
    return false;
  }
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
 * The Worker never proxies media bytes. It only observes the first anonymous
 * googlevideo audio request made by the browser and hands that signed URL to Groq.
 */
export async function resolveYouTubeAudioUrl(env: Env, videoId: string): Promise<ResolvedAudio> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    );

    const audioRequestPromise = page.waitForRequest(
      (request) => isGoogleVideoAudioUrl(request.url()),
      { timeout: 20_000 },
    );

    await page.goto(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    // YouTube commonly starts fetching media during page initialization. If it
    // does not, issue an explicit play gesture to trigger the first audio range.
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
        // The pending request promise below remains the source of truth.
      }
    }

    const request = await audioRequestPromise;
    const rawUrl = request.url();
    const url = new URL(rawUrl);
    const durationSeconds = parseNumber(url.searchParams.get("dur"));

    return {
      url: rawUrl,
      mimeType: url.searchParams.get("mime") || undefined,
      bitrate: parseNumber(url.searchParams.get("ratebypass")),
      approxDurationMs: durationSeconds !== undefined ? durationSeconds * 1000 : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Browser Run did not observe a YouTube audio request for ${videoId}: ${message}`);
  } finally {
    await browser.close();
  }
}

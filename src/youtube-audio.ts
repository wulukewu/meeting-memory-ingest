import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./types";

export interface ResolvedAudio {
  url: string;
  mimeType?: string;
  bitrate?: number;
  approxDurationMs?: number;
}

interface BrowserDiagnostic {
  finalUrl: string;
  title: string;
  hasVideo: boolean;
  currentTime?: number;
  duration?: number;
  body: string;
  mediaCount: number;
}

interface ProbeDiagnostic {
  status?: number;
  contentType?: string;
  error?: string;
}

function parseNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactBrowserDiagnostic(value: BrowserDiagnostic): string {
  const body = value.body.replace(/\s+/g, " ").trim().slice(0, 220);
  return `url=${value.finalUrl} title=${JSON.stringify(value.title)} video=${value.hasVideo} currentTime=${value.currentTime ?? "?"} duration=${value.duration ?? "?"} mediaCount=${value.mediaCount} body=${JSON.stringify(body)}`;
}

async function probeContentType(rawUrl: string): Promise<{ contentType?: string; status?: number; error?: string }> {
  try {
    const response = await fetch(rawUrl, {
      method: "GET",
      headers: {
        range: "bytes=0-0",
      },
      redirect: "follow",
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
    const status = response.status;
    await response.body?.cancel().catch(() => undefined);
    return { contentType, status };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve a short-lived YouTube audio media URL without parsing YouTube player JS
 * in the Worker isolate.
 *
 * Browser Run executes the real anonymous YouTube watch page and exposes the signed
 * googlevideo resource URLs through PerformanceResourceTiming. Those URLs do not
 * always expose `mime` or `itag` query parameters, so the Worker classifies only a
 * handful of candidate URLs with a one-byte HTTP Range request and selects the one
 * whose response Content-Type is audio/*.
 *
 * Browser work is kept short and all media bytes still bypass the Worker: the final
 * signed audio URL is handed directly to Groq.
 */
export async function resolveYouTubeAudioUrl(env: Env, videoId: string): Promise<ResolvedAudio> {
  const browser = await puppeteer.launch(env.BROWSER);
  let candidates: string[] = [];
  let browserDiagnostic: BrowserDiagnostic | undefined;

  try {
    const page = await browser.newPage();
    const target = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

    try {
      await page.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
    } catch {
      // A navigation timeout can still leave a fully usable player behind.
    }

    // Handle the common anonymous YouTube consent interstitial when present.
    await page
      .evaluate(() => {
        const labels = ["accept all", "i agree", "reject all", "accept", "agree"];
        const button = Array.from(document.querySelectorAll("button")).find((candidate) => {
          const text = (candidate.textContent || "").trim().toLowerCase();
          return labels.some((label) => text === label || text.includes(label));
        }) as HTMLButtonElement | undefined;
        if (button) button.click();
        return Boolean(button);
      })
      .catch(() => false);

    // Trigger playback. The watch page has already proven usable in Browser Run;
    // either the native play button or HTMLMediaElement.play() is sufficient.
    try {
      const button = await page.$(".ytp-play-button");
      if (button) await button.click();
    } catch {
      // Direct play() below is the fallback.
    }

    await page
      .evaluate(() => {
        const video = document.querySelector("video") as HTMLVideoElement | null;
        if (!video) return false;
        void video.play().catch(() => undefined);
        return true;
      })
      .catch(() => false);

    // Wait only for any googlevideo media resources. Classification happens later
    // using HTTP response headers because Resource Timing can omit mime/itag params.
    try {
      await page.waitForFunction(
        () =>
          performance.getEntriesByType("resource").some((entry) => {
            try {
              const url = new URL(entry.name);
              return url.hostname.endsWith(".googlevideo.com") && url.pathname.includes("videoplayback");
            } catch {
              return false;
            }
          }),
        { timeout: 10_000, polling: 250 },
      );
    } catch {
      // Diagnostics below will explain whether playback actually started.
    }

    candidates = await page
      .evaluate(() => {
        const urls: string[] = [];
        const seen = new Set<string>();
        for (const entry of performance.getEntriesByType("resource")) {
          try {
            const url = new URL(entry.name);
            if (!url.hostname.endsWith(".googlevideo.com") || !url.pathname.includes("videoplayback")) continue;
            if (seen.has(entry.name)) continue;
            seen.add(entry.name);
            urls.push(entry.name);
            if (urls.length >= 12) break;
          } catch {
            // Ignore non-URL entries.
          }
        }
        return urls;
      })
      .catch(() => [] as string[]);

    browserDiagnostic = await page
      .evaluate(() => {
        const video = document.querySelector("video") as HTMLVideoElement | null;
        const mediaCount = performance.getEntriesByType("resource").filter((entry) => {
          try {
            const url = new URL(entry.name);
            return url.hostname.endsWith(".googlevideo.com") && url.pathname.includes("videoplayback");
          } catch {
            return false;
          }
        }).length;
        return {
          finalUrl: location.href,
          title: document.title,
          hasVideo: Boolean(video),
          currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : undefined,
          duration: video && Number.isFinite(video.duration) ? video.duration : undefined,
          body: (document.body?.innerText || "").slice(0, 500),
          mediaCount,
        };
      })
      .catch(() => ({
        finalUrl: "unknown",
        title: "unknown",
        hasVideo: false,
        body: "diagnostic unavailable",
        mediaCount: candidates.length,
      }));
  } finally {
    await browser.close();
  }

  if (candidates.length === 0) {
    throw new Error(
      `Browser Run observed no googlevideo media resources for ${videoId}; ${
        browserDiagnostic ? compactBrowserDiagnostic(browserDiagnostic) : "browser diagnostic unavailable"
      }`,
    );
  }

  const probes: ProbeDiagnostic[] = [];
  for (const candidate of candidates) {
    const probe = await probeContentType(candidate);
    probes.push(probe);
    if (probe.contentType?.startsWith("audio/")) {
      const url = new URL(candidate);
      const durationSeconds = parseNumber(url.searchParams.get("dur"));
      return {
        url: candidate,
        mimeType: probe.contentType,
        approxDurationMs: durationSeconds !== undefined ? durationSeconds * 1000 : undefined,
      };
    }
  }

  const probeSummary = probes
    .slice(0, 12)
    .map((probe, index) =>
      probe.error
        ? `#${index + 1}:error=${JSON.stringify(probe.error.slice(0, 100))}`
        : `#${index + 1}:status=${probe.status ?? "?"};type=${probe.contentType || "?"}`,
    )
    .join(", ");

  throw new Error(
    `Browser Run found ${candidates.length} googlevideo media resources for ${videoId}, but none probed as audio; ${probeSummary}; ${
      browserDiagnostic ? compactBrowserDiagnostic(browserDiagnostic) : "browser diagnostic unavailable"
    }`,
  );
}

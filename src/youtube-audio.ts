import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./types";

export interface ResolvedAudio {
  url: string;
  mimeType?: string;
  bitrate?: number;
  approxDurationMs?: number;
}

interface BrowserAttemptDiagnostic {
  target: string;
  finalUrl: string;
  title: string;
  hasVideo: boolean;
  body: string;
  media: string[];
}

function parseNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactDiagnostic(value: BrowserAttemptDiagnostic): string {
  const body = value.body.replace(/\s+/g, " ").trim().slice(0, 220);
  const media = value.media.slice(0, 8).join(", ") || "none";
  return `${value.target} -> ${value.finalUrl} title=${JSON.stringify(value.title)} video=${value.hasVideo} media=[${media}] body=${JSON.stringify(body)}`;
}

/**
 * Resolve a short-lived YouTube audio media URL by letting Cloudflare Browser Run
 * execute YouTube's own player code. This avoids player parsing / decipher work
 * inside the Free Worker's small CPU budget.
 *
 * The resolver prefers the lightweight embed player, then falls back to the normal
 * watch page. Resource filtering executes inside Chromium. No signed media bytes
 * are proxied through the Worker; only the final URL is returned to Groq.
 */
export async function resolveYouTubeAudioUrl(env: Env, videoId: string): Promise<ResolvedAudio> {
  const browser = await puppeteer.launch(env.BROWSER);
  const diagnostics: BrowserAttemptDiagnostic[] = [];

  try {
    const page = await browser.newPage();

    // Keep Browser Run's native Chromium UA. Spoofing a newer/different Chrome UA
    // than the actual browser can make YouTube serve an incompatible player path.
    const targets = [
      `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&playsinline=1&rel=0`,
      `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?autoplay=1&playsinline=1&rel=0`,
      `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    ];

    for (const target of targets) {
      await page.evaluate(() => performance.clearResourceTimings()).catch(() => undefined);

      try {
        await page.goto(target, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
      } catch {
        // A navigation timeout does not necessarily mean the player is unusable.
        // Continue with the page state Chromium already has.
      }

      // Handle the common anonymous YouTube consent interstitial when it appears.
      await page
        .evaluate(() => {
          const labels = ["accept all", "i agree", "reject all", "accept", "agree"];
          const buttons = Array.from(document.querySelectorAll("button"));
          const button = buttons.find((candidate) => {
            const text = (candidate.textContent || "").trim().toLowerCase();
            return labels.some((label) => text === label || text.includes(label));
          }) as HTMLButtonElement | undefined;
          if (button) button.click();
          return Boolean(button);
        })
        .catch(() => false);

      // Trigger playback with a browser-side user gesture first, then a direct
      // HTMLMediaElement play() fallback. Embed pages often expose the large play
      // button while watch pages expose the normal control button.
      for (const selector of [".ytp-large-play-button", ".ytp-play-button"]) {
        try {
          const element = await page.$(selector);
          if (element) {
            await element.click();
            break;
          }
        } catch {
          // Try the next playback method.
        }
      }

      await page
        .evaluate(() => {
          const video = document.querySelector("video") as HTMLVideoElement | null;
          if (!video) return false;
          video.muted = false;
          video.volume = 1;
          void video.play().catch(() => undefined);
          return true;
        })
        .catch(() => false);

      // YouTube normally uses adaptive audio-only formats. Accept either an
      // explicit audio MIME type or a known audio-only itag because some playback
      // URLs omit the MIME query parameter.
      try {
        await page.waitForFunction(
          () => {
            const audioItags = new Set([
              "139",
              "140",
              "141",
              "249",
              "250",
              "251",
              "256",
              "258",
              "325",
              "328",
              "599",
              "600",
            ]);
            return performance.getEntriesByType("resource").some((entry) => {
              try {
                const url = new URL(entry.name);
                if (!url.hostname.endsWith(".googlevideo.com") || !url.pathname.includes("videoplayback")) return false;
                const mime = url.searchParams.get("mime") || "";
                const itag = url.searchParams.get("itag") || "";
                return mime.startsWith("audio/") || audioItags.has(itag);
              } catch {
                return false;
              }
            });
          },
          { timeout: 9_000, polling: 250 },
        );
      } catch {
        // Capture a safe diagnostic below and try the next page variant.
      }

      const rawUrl = await page
        .evaluate(() => {
          const audioItags = new Set([
            "139",
            "140",
            "141",
            "249",
            "250",
            "251",
            "256",
            "258",
            "325",
            "328",
            "599",
            "600",
          ]);
          for (const entry of performance.getEntriesByType("resource")) {
            try {
              const url = new URL(entry.name);
              if (!url.hostname.endsWith(".googlevideo.com") || !url.pathname.includes("videoplayback")) continue;
              const mime = url.searchParams.get("mime") || "";
              const itag = url.searchParams.get("itag") || "";
              if (mime.startsWith("audio/") || audioItags.has(itag)) return entry.name;
            } catch {
              // Ignore non-URL resource entries.
            }
          }
          return null;
        })
        .catch(() => null);

      if (rawUrl) {
        const url = new URL(rawUrl);
        const durationSeconds = parseNumber(url.searchParams.get("dur"));
        return {
          url: rawUrl,
          mimeType: url.searchParams.get("mime") || undefined,
          approxDurationMs: durationSeconds !== undefined ? durationSeconds * 1000 : undefined,
        };
      }

      const diagnostic = await page
        .evaluate((attemptTarget) => {
          const media = performance
            .getEntriesByType("resource")
            .map((entry) => entry.name)
            .filter((name) => {
              try {
                const url = new URL(name);
                return url.hostname.endsWith(".googlevideo.com") && url.pathname.includes("videoplayback");
              } catch {
                return false;
              }
            })
            .slice(0, 12)
            .map((name) => {
              const url = new URL(name);
              return `itag=${url.searchParams.get("itag") || "?"};mime=${url.searchParams.get("mime") || "?"}`;
            });
          return {
            target: attemptTarget,
            finalUrl: location.href,
            title: document.title,
            hasVideo: Boolean(document.querySelector("video")),
            body: (document.body?.innerText || "").slice(0, 500),
            media,
          };
        }, target)
        .catch(() => ({
          target,
          finalUrl: "unknown",
          title: "unknown",
          hasVideo: false,
          body: "diagnostic unavailable",
          media: [],
        }));
      diagnostics.push(diagnostic as BrowserAttemptDiagnostic);
    }

    throw new Error(`no audio media URL found; ${diagnostics.map(compactDiagnostic).join(" || ")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Browser Run did not observe a YouTube audio resource for ${videoId}: ${message}`);
  } finally {
    await browser.close();
  }
}

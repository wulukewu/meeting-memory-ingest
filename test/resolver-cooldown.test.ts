import { describe, expect, it } from "vitest";
import {
  GROQ_RATE_LIMIT_MARKER,
  groqTranscriptionCooldownUntil,
  YOUTUBE_BOT_BLOCK_MARKER,
  youtubeResolverCooldownUntil,
} from "../src/state";
import type { Manifest } from "../src/types";

function manifestWithVideos(videos: Manifest["videos"]): Manifest {
  return {
    version: 1,
    updatedAt: "2026-09-15T00:00:00.000Z",
    videos,
  };
}

describe("YouTube resolver cooldown", () => {
  it("uses an active anti-bot wait as a global resolver cooldown", () => {
    const now = Date.parse("2026-09-15T06:00:00.000Z");
    const manifest = manifestWithVideos({
      blocked: {
        status: "waiting",
        title: "Blocked meeting",
        youtubeUrl: "https://youtu.be/blocked",
        attempts: 2,
        retryAfterAt: "2026-09-15T08:00:00.000Z",
        lastError: `${YOUTUBE_BOT_BLOCK_MARKER} YouTube requested bot verification`,
      },
    });

    expect(youtubeResolverCooldownUntil(manifest, now)).toBe("2026-09-15T08:00:00.000Z");
  });

  it("ignores ordinary Groq waits and expired anti-bot waits", () => {
    const now = Date.parse("2026-09-15T09:00:00.000Z");
    const manifest = manifestWithVideos({
      quota: {
        status: "waiting",
        title: "Quota wait",
        youtubeUrl: "https://youtu.be/quota",
        attempts: 1,
        retryAfterAt: "2026-09-15T10:00:00.000Z",
        lastError: "Groq rate limit",
      },
      expiredBlock: {
        status: "waiting",
        title: "Expired block",
        youtubeUrl: "https://youtu.be/expired",
        attempts: 1,
        retryAfterAt: "2026-09-15T08:00:00.000Z",
        lastError: `${YOUTUBE_BOT_BLOCK_MARKER} old block`,
      },
    });

    expect(youtubeResolverCooldownUntil(manifest, now)).toBeUndefined();
  });

  it("keeps the latest active anti-bot retry window", () => {
    const now = Date.parse("2026-09-15T06:00:00.000Z");
    const manifest = manifestWithVideos({
      first: {
        status: "waiting",
        title: "First",
        youtubeUrl: "https://youtu.be/first",
        attempts: 1,
        retryAfterAt: "2026-09-15T07:00:00.000Z",
        lastError: `${YOUTUBE_BOT_BLOCK_MARKER} first block`,
      },
      second: {
        status: "waiting",
        title: "Second",
        youtubeUrl: "https://youtu.be/second",
        attempts: 1,
        retryAfterAt: "2026-09-15T08:30:00.000Z",
        lastError: `${YOUTUBE_BOT_BLOCK_MARKER} second block`,
      },
    });

    expect(youtubeResolverCooldownUntil(manifest, now)).toBe("2026-09-15T08:30:00.000Z");
  });
});


describe("Groq transcription cooldown", () => {
  it("uses an active Groq rate-limit wait as a global transcription cooldown", () => {
    const now = Date.parse("2026-09-23T07:00:00.000Z");
    const manifest = manifestWithVideos({
      quota: {
        status: "waiting",
        title: "Quota wait",
        youtubeUrl: "https://youtu.be/quota",
        attempts: 1,
        retryAfterAt: "2026-09-23T07:33:59.000Z",
        lastError: `${GROQ_RATE_LIMIT_MARKER}1779s] Groq audio/transcriptions failed (429)`,
      },
    });

    expect(groqTranscriptionCooldownUntil(manifest, now)).toBe("2026-09-23T07:33:59.000Z");
  });

  it("ignores non-rate-limit waits, expired waits, and non-waiting entries", () => {
    const now = Date.parse("2026-09-23T08:00:00.000Z");
    const manifest = manifestWithVideos({
      ordinary: {
        status: "waiting",
        title: "Ordinary wait",
        youtubeUrl: "https://youtu.be/ordinary",
        attempts: 1,
        retryAfterAt: "2026-09-23T09:00:00.000Z",
        lastError: "temporary upstream error",
      },
      expired: {
        status: "waiting",
        title: "Expired quota wait",
        youtubeUrl: "https://youtu.be/expired",
        attempts: 1,
        retryAfterAt: "2026-09-23T07:59:59.000Z",
        lastError: `${GROQ_RATE_LIMIT_MARKER}60s] Groq audio/transcriptions failed (429)`,
      },
      failed: {
        status: "failed",
        title: "Failed quota item",
        youtubeUrl: "https://youtu.be/failed",
        attempts: 1,
        retryAfterAt: "2026-09-23T09:30:00.000Z",
        lastError: `${GROQ_RATE_LIMIT_MARKER}5400s] Groq audio/transcriptions failed (429)`,
      },
    });

    expect(groqTranscriptionCooldownUntil(manifest, now)).toBeUndefined();
  });

  it("keeps the latest active Groq retry window across the backlog", () => {
    const now = Date.parse("2026-09-23T07:00:00.000Z");
    const manifest = manifestWithVideos({
      first: {
        status: "waiting",
        title: "First quota wait",
        youtubeUrl: "https://youtu.be/first",
        attempts: 1,
        retryAfterAt: "2026-09-23T07:20:00.000Z",
        lastError: `${GROQ_RATE_LIMIT_MARKER}1200s] first quota wait`,
      },
      second: {
        status: "waiting",
        title: "Second quota wait",
        youtubeUrl: "https://youtu.be/second",
        attempts: 1,
        retryAfterAt: "2026-09-23T07:45:00.000Z",
        lastError: `${GROQ_RATE_LIMIT_MARKER}2700s] second quota wait`,
      },
    });

    expect(groqTranscriptionCooldownUntil(manifest, now)).toBe("2026-09-23T07:45:00.000Z");
  });
});

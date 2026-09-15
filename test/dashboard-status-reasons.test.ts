import { describe, expect, it } from "vitest";
import { buildDashboardRow } from "../src/dashboard";
import type { Manifest, ManifestEntry, VideoRecord } from "../src/types";

const video: VideoRecord = {
  id: "_xigzQtD2F8",
  title: "20260422 AI人工智慧導論 互評 Meet",
  description: "",
  publishedAt: "2026-04-22T00:00:00Z",
  privacyStatus: "unlisted",
  durationSeconds: 3307,
};

function manifest(entry: ManifestEntry): Manifest {
  return {
    version: 1,
    updatedAt: "2026-09-15T06:30:00Z",
    videos: { [video.id]: entry },
  };
}

function entry(status: ManifestEntry["status"], lastError?: string): ManifestEntry {
  return {
    status,
    title: video.title,
    youtubeUrl: `https://youtu.be/${video.id}`,
    attempts: 2,
    totalChunks: 2,
    completedChunks: [],
    ...(status === "waiting" ? { retryAfterAt: "2026-09-15T08:30:00Z" } : {}),
    ...(status === "failed" ? { failedAt: "2026-09-15T06:11:00Z" } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

describe("dashboard reason-aware statuses", () => {
  it("labels a new YouTube anti-bot wait as a resolver cooldown", () => {
    const row = buildDashboardRow(
      video,
      manifest(entry("waiting", "youtube_bot_blocked: Sign in to confirm you’re not a bot")),
    );
    expect(row.group).toBe("waiting");
    expect(row.statusLabel).toBe("YouTube 冷卻中");
    expect(row.actionHint).toContain("YouTube");
    expect(row.actionHint).toContain("自動重試");
  });

  it("labels Groq waiting separately from YouTube access blocks", () => {
    const row = buildDashboardRow(video, manifest(entry("waiting", "Groq rate limit exceeded")));
    expect(row.statusLabel).toBe("等待 Groq 額度");
    expect(row.actionHint).toContain("額度恢復");
  });

  it("recognizes legacy failed anti-bot records instead of showing a generic failure", () => {
    const row = buildDashboardRow(
      video,
      manifest(entry("failed", "resolver failed: ERROR: Sign in to confirm you’re not a bot")),
    );
    expect(row.group).toBe("failed");
    expect(row.statusLabel).toBe("YouTube 阻擋");
    expect(row.actionHint).toContain("自動再試");
  });

  it("keeps unrelated failures generic and does not claim a special cooldown", () => {
    const row = buildDashboardRow(video, manifest(entry("failed", "ffmpeg could not split audio")));
    expect(row.statusLabel).toBe("失敗");
    expect(row.actionHint).toContain("錯誤資訊");
  });
});

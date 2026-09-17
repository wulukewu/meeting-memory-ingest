import { describe, expect, it } from "vitest";
import { buildDashboardRow } from "../src/dashboard";
import type { Manifest, VideoRecord } from "../src/types";

function video(privacyStatus: string): VideoRecord {
  return {
    id: "O7TSkeebTNk",
    title: "Meeting",
    description: "",
    publishedAt: "2026-09-12T00:00:00Z",
    privacyStatus,
    durationSeconds: 3600,
  };
}

function manifest(status?: "processing" | "waiting" | "finalizing" | "completed" | "failed"): Manifest {
  return {
    version: 1,
    updatedAt: "2026-09-15T00:00:00Z",
    videos: status
      ? {
          O7TSkeebTNk: {
            status,
            title: "Meeting",
            youtubeUrl: "https://youtu.be/O7TSkeebTNk",
            attempts: 1,
            ...(status === "completed" ? { completedAt: "2026-09-15T00:00:00Z", path: "reference/test.md" } : {}),
          },
        }
      : {},
  };
}

describe("dashboard status mapping", () => {
  it("marks a completed unlisted video as needing cleanup", () => {
    const row = buildDashboardRow(video("unlisted"), manifest("completed"));
    expect(row.group).toBe("action");
    expect(row.actionHint).toContain("Private");
  });

  it("shows an untracked unlisted video as ready", () => {
    const row = buildDashboardRow(video("unlisted"), manifest());
    expect(row.group).toBe("ready");
    expect(row.statusLabel).toBe("待處理");
  });

  it("shows an untracked private video as not queued", () => {
    const row = buildDashboardRow(video("private"), manifest());
    expect(row.group).toBe("private");
  });

  it("shows durable finalization as active without asking for a retry", () => {
    const row = buildDashboardRow(video("unlisted"), manifest("finalizing"));
    expect(row.group).toBe("processing");
    expect(row.statusLabel).toBe("整理摘要中");
  });

  it("preserves manifest waiting state even if video remains unlisted", () => {
    const row = buildDashboardRow(video("unlisted"), manifest("waiting"));
    expect(row.group).toBe("waiting");
    expect(row.actionHint).toContain("自動續跑");
  });
});

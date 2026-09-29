import { describe, expect, it } from "vitest";
import { normalizePlaylistQueueOrder, orderVideosByQueuePreference } from "../src/state";
import type { VideoRecord } from "../src/types";

function video(id: string): VideoRecord {
  return {
    id,
    title: id,
    description: "",
    publishedAt: "2026-09-29T00:00:00Z",
    privacyStatus: "unlisted",
  };
}

describe("playlist queue ordering", () => {
  it("normalizes invalid and duplicate video IDs", () => {
    expect(normalizePlaylistQueueOrder([
      "AAAAAA1",
      "BBBBBB2",
      "AAAAAA1",
      "",
      42,
      "bad id",
    ])).toEqual(["AAAAAA1", "BBBBBB2"]);
  });

  it("puts explicitly ordered videos first while preserving fallback order", () => {
    const videos = [video("AAAAAA1"), video("BBBBBB2"), video("CCCCCC3"), video("DDDDDD4")];
    expect(orderVideosByQueuePreference(videos, ["CCCCCC3", "AAAAAA1"]).map((item) => item.id))
      .toEqual(["CCCCCC3", "AAAAAA1", "BBBBBB2", "DDDDDD4"]);
  });

  it("ignores stale queue entries that are not in the current playlist scan", () => {
    const videos = [video("AAAAAA1"), video("BBBBBB2")];
    expect(orderVideosByQueuePreference(videos, ["ZZZZZZ9", "BBBBBB2"]).map((item) => item.id))
      .toEqual(["BBBBBB2", "AAAAAA1"]);
  });
});

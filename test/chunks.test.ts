import { describe, expect, it } from "vitest";
import { chunkCount, mergeTranscriptChunks, nextPendingChunk, normalizedCompletedChunks } from "../src/chunks";
import type { StoredTranscriptChunk } from "../src/types";

describe("transcript chunks", () => {
  it("computes chunk counts for short and long recordings", () => {
    expect(chunkCount(5152, 2700)).toBe(2);
    expect(chunkCount(8 * 3600 + 13 * 60 + 41, 2700)).toBe(11);
    expect(chunkCount(undefined, 2700)).toBe(1);
  });

  it("normalizes completed chunks and resumes at the first gap", () => {
    expect(normalizedCompletedChunks(5, [3, 1, 1, -1, 8, 0])).toEqual([0, 1, 3]);
    expect(nextPendingChunk(5, [0, 1, 3])).toBe(2);
    expect(nextPendingChunk(2, [0, 1])).toBe(1);
  });

  it("merges relative timestamps into whole-video timestamps", () => {
    const chunks: StoredTranscriptChunk[] = [
      {
        version: 1,
        videoId: "abc123",
        chunkIndex: 0,
        offsetSeconds: 0,
        transcript: {
          text: "first",
          duration: 2700,
          segments: [{ start: 10, end: 12, text: "first" }],
        },
      },
      {
        version: 1,
        videoId: "abc123",
        chunkIndex: 1,
        offsetSeconds: 2700,
        transcript: {
          text: "second",
          duration: 100,
          segments: [{ start: 5, end: 9, text: "second" }],
        },
      },
    ];

    const merged = mergeTranscriptChunks(chunks, 2800);
    expect(merged.duration).toBe(2800);
    expect(merged.text).toBe("first second");
    expect(merged.segments.map(({ start, end, text }) => ({ start, end, text }))).toEqual([
      { start: 10, end: 12, text: "first" },
      { start: 2705, end: 2709, text: "second" },
    ]);
  });
});

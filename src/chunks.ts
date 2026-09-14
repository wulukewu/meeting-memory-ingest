import type { StoredTranscriptChunk, TranscriptResult } from "./types";

export function chunkCount(durationSeconds: number | undefined, chunkSeconds: number): number {
  const duration = Math.max(1, Math.ceil(durationSeconds || chunkSeconds));
  return Math.max(1, Math.ceil(duration / chunkSeconds));
}

export function normalizedCompletedChunks(totalChunks: number, completed: number[] | undefined): number[] {
  return [...new Set(completed || [])]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < totalChunks)
    .sort((a, b) => a - b);
}

export function nextPendingChunk(totalChunks: number, completed: number[] | undefined): number {
  const done = new Set(normalizedCompletedChunks(totalChunks, completed));
  for (let index = 0; index < totalChunks; index += 1) {
    if (!done.has(index)) return index;
  }
  // When every chunk has already been transcribed but finalization failed, replay
  // the final chunk callback. The Worker will detect the cached chunk and retry
  // only merge/summary/finalization without spending transcription quota again.
  return Math.max(0, totalChunks - 1);
}

export function mergeTranscriptChunks(chunks: StoredTranscriptChunk[], durationSeconds?: number): TranscriptResult {
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const segments = ordered.flatMap((chunk) =>
    chunk.transcript.segments.map((segment) => ({
      ...segment,
      start: segment.start + chunk.offsetSeconds,
      end: segment.end + chunk.offsetSeconds,
    })),
  );

  return {
    text: segments.length > 0 ? segments.map((segment) => segment.text).join(" ") : ordered.map((x) => x.transcript.text).join("\n"),
    language: ordered.find((chunk) => chunk.transcript.language)?.transcript.language,
    duration: durationSeconds || ordered.reduce((max, chunk) => Math.max(max, chunk.offsetSeconds + (chunk.transcript.duration || 0)), 0),
    segments,
  };
}

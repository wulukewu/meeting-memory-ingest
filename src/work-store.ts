import type { Env, StoredTranscriptChunk } from "./types";

export function chunkObjectKey(videoId: string, chunkIndex: number): string {
  return `work/${videoId}/chunk-${String(chunkIndex).padStart(4, "0")}.json`;
}

export function mergedObjectKey(videoId: string): string {
  return `work/${videoId}/merged.json`;
}

export async function getStoredChunk(env: Env, videoId: string, chunkIndex: number): Promise<StoredTranscriptChunk | null> {
  const object = await env.TRANSCRIPT_WORK.get(chunkObjectKey(videoId, chunkIndex));
  if (!object) return null;
  const parsed = JSON.parse(await object.text()) as StoredTranscriptChunk;
  if (parsed.version !== 1 || parsed.videoId !== videoId || parsed.chunkIndex !== chunkIndex) {
    throw new Error(`invalid R2 transcript chunk ${videoId}#${chunkIndex}`);
  }
  return parsed;
}

export async function putStoredChunk(env: Env, chunk: StoredTranscriptChunk): Promise<string> {
  const key = chunkObjectKey(chunk.videoId, chunk.chunkIndex);
  await env.TRANSCRIPT_WORK.put(key, JSON.stringify(chunk), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      videoId: chunk.videoId,
      chunkIndex: String(chunk.chunkIndex),
    },
  });
  return key;
}

export async function putMergedTranscript(env: Env, videoId: string, value: unknown): Promise<string> {
  const key = mergedObjectKey(videoId);
  await env.TRANSCRIPT_WORK.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { videoId, kind: "merged-transcript" },
  });
  return key;
}

export async function readJsonObject<T>(env: Env, key: string): Promise<T> {
  const object = await env.TRANSCRIPT_WORK.get(key);
  if (!object) throw new Error(`R2 object ${key} is missing`);
  return JSON.parse(await object.text()) as T;
}

export async function cleanupVideoWork(env: Env, videoId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.TRANSCRIPT_WORK.list({ prefix: `work/${videoId}/`, cursor });
    if (listed.objects.length) await env.TRANSCRIPT_WORK.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

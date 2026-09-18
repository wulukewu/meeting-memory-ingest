import type { Env, StoredTranscriptChunk } from "./types";
import { ensureStateSchema } from "./state";

const MAX_D1_CHUNK_BYTES = 1_900_000;

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateChunk(chunk: StoredTranscriptChunk, videoId: string, chunkIndex: number): void {
  if (chunk.version !== 1 || chunk.videoId !== videoId || chunk.chunkIndex !== chunkIndex) {
    throw new Error(`invalid D1 transcript chunk ${videoId}#${chunkIndex}`);
  }
}

export async function getStoredChunk(
  env: Env,
  videoId: string,
  chunkIndex: number,
): Promise<StoredTranscriptChunk | null> {
  await ensureStateSchema(env);
  const row = await env.QUEUE_DB.prepare(
    "SELECT payload_json FROM transcript_chunks WHERE video_id = ? AND chunk_index = ?",
  ).bind(videoId, chunkIndex).first<{ payload_json: string }>();
  if (!row) return null;
  const parsed = JSON.parse(row.payload_json) as StoredTranscriptChunk;
  validateChunk(parsed, videoId, chunkIndex);
  return parsed;
}

export async function putStoredChunk(env: Env, chunk: StoredTranscriptChunk): Promise<void> {
  await ensureStateSchema(env);
  const payload = JSON.stringify(chunk);
  const payloadBytes = encodedBytes(payload);
  if (payloadBytes > MAX_D1_CHUNK_BYTES) {
    throw new Error(
      `transcript chunk ${chunk.videoId}#${chunk.chunkIndex} is ${payloadBytes} bytes; D1 chunk guard is ${MAX_D1_CHUNK_BYTES}`,
    );
  }

  const nowIso = new Date().toISOString();
  await env.QUEUE_DB.prepare(
    `INSERT INTO transcript_chunks (video_id,chunk_index,payload_json,payload_bytes,completed_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(video_id,chunk_index) DO UPDATE SET
       payload_json=excluded.payload_json,
       payload_bytes=excluded.payload_bytes,
       completed_at=excluded.completed_at`,
  ).bind(chunk.videoId, chunk.chunkIndex, payload, payloadBytes, nowIso).run();
}

export async function getStoredChunks(env: Env, videoId: string, totalChunks: number): Promise<StoredTranscriptChunk[]> {
  const chunks: StoredTranscriptChunk[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const chunk = await getStoredChunk(env, videoId, index);
    if (!chunk) throw new Error(`transcript chunk ${index}/${totalChunks} is missing for ${videoId}`);
    chunks.push(chunk);
  }
  return chunks;
}

export async function putSummaryInputs(env: Env, videoId: string, inputs: string[]): Promise<void> {
  await ensureStateSchema(env);
  const nowIso = new Date().toISOString();
  await env.QUEUE_DB.batch([
    env.QUEUE_DB.prepare("DELETE FROM summary_inputs WHERE video_id = ?").bind(videoId),
    ...inputs.map((input, index) =>
      env.QUEUE_DB.prepare(
        "INSERT INTO summary_inputs (video_id,part_index,input_text,created_at) VALUES (?,?,?,?)",
      ).bind(videoId, index, input, nowIso),
    ),
  ]);
}

export async function getSummaryInput(env: Env, videoId: string, index: number): Promise<string> {
  await ensureStateSchema(env);
  const row = await env.QUEUE_DB.prepare(
    "SELECT input_text FROM summary_inputs WHERE video_id = ? AND part_index = ?",
  ).bind(videoId, index).first<{ input_text: string }>();
  if (!row) throw new Error(`missing summary input ${index} for ${videoId}`);
  return row.input_text;
}

export async function cleanupVideoWork(env: Env, videoId: string): Promise<void> {
  await ensureStateSchema(env);
  await env.QUEUE_DB.batch([
    env.QUEUE_DB.prepare("DELETE FROM summary_inputs WHERE video_id = ?").bind(videoId),
    env.QUEUE_DB.prepare("DELETE FROM transcript_chunks WHERE video_id = ?").bind(videoId),
  ]);
}

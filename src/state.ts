import type { ClaimResult, Env, Manifest, ManifestEntry, VideoRecord } from "./types";
import { chunkCount, nextPendingChunk, normalizedCompletedChunks } from "./chunks";
import { errorMessage, parsePositiveInt, truncate } from "./util";

export const YOUTUBE_BOT_BLOCK_MARKER = "[youtube_bot_blocked]";

const STATE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS videos (
    video_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    youtube_url TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('processing','waiting','finalizing','completed','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    retry_after_at TEXT,
    path TEXT,
    last_error TEXT,
    transcription_model TEXT,
    summary_model TEXT,
    duration_seconds INTEGER,
    chunk_seconds INTEGER,
    total_chunks INTEGER,
    next_chunk_index INTEGER NOT NULL DEFAULT 0,
    finalization_id TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transcript_chunks (
    video_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (video_id, chunk_index),
    FOREIGN KEY (video_id) REFERENCES videos(video_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS summary_inputs (
    video_id TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    input_text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (video_id, part_index),
    FOREIGN KEY (video_id) REFERENCES videos(video_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS summary_outputs (
    video_id TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (video_id, part_index),
    FOREIGN KEY (video_id) REFERENCES videos(video_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS runtime_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_videos_status_updated ON videos(status, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_videos_retry_after ON videos(status, retry_after_at)",
  "CREATE INDEX IF NOT EXISTS idx_transcript_chunks_video ON transcript_chunks(video_id, chunk_index)",
  "CREATE INDEX IF NOT EXISTS idx_summary_inputs_video ON summary_inputs(video_id, part_index)",
  "CREATE INDEX IF NOT EXISTS idx_summary_outputs_video ON summary_outputs(video_id, part_index)",
] as const;


let schemaReady: Promise<void> | undefined;

export async function ensureStateSchema(env: Env): Promise<void> {
  if (!schemaReady) {
    schemaReady = env.QUEUE_DB.batch(
      STATE_SCHEMA_STATEMENTS.map((statement) => env.QUEUE_DB.prepare(statement)),
    ).then(() => undefined)
      .catch((error) => {
        schemaReady = undefined;
        throw error;
      });
  }
  await schemaReady;
}


type VideoRow = {
  video_id: string;
  title: string;
  youtube_url: string;
  status: ManifestEntry["status"];
  attempts: number;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  retry_after_at: string | null;
  path: string | null;
  last_error: string | null;
  transcription_model: string | null;
  summary_model: string | null;
  duration_seconds: number | null;
  chunk_seconds: number | null;
  total_chunks: number | null;
  next_chunk_index: number | null;
  finalization_id: string | null;
  updated_at: string;
};

type ChunkRow = { video_id: string; chunk_index: number; completed_at: string };

function rowToEntry(row: VideoRow, completedChunks: number[] = []): ManifestEntry {
  return {
    status: row.status,
    title: row.title,
    youtubeUrl: row.youtube_url,
    attempts: row.attempts,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    failedAt: row.failed_at || undefined,
    retryAfterAt: row.retry_after_at || undefined,
    path: row.path || undefined,
    lastError: row.last_error || undefined,
    transcriptionModel: row.transcription_model || undefined,
    summaryModel: row.summary_model || undefined,
    durationSeconds: row.duration_seconds ?? undefined,
    chunkSeconds: row.chunk_seconds ?? undefined,
    totalChunks: row.total_chunks ?? undefined,
    nextChunkIndex: row.next_chunk_index ?? undefined,
    completedChunks,
    finalizationId: row.finalization_id || undefined,
    updatedAt: row.updated_at,
  };
}

async function chunkIndexes(env: Env, videoId: string): Promise<number[]> {
  await ensureStateSchema(env);
  const result = await env.QUEUE_DB.prepare(
    "SELECT chunk_index FROM transcript_chunks WHERE video_id = ? ORDER BY chunk_index",
  ).bind(videoId).all<{ chunk_index: number }>();
  return result.results.map((row) => row.chunk_index);
}

export async function getManifestEntry(env: Env, videoId: string): Promise<ManifestEntry | undefined> {
  await ensureStateSchema(env);
  const row = await env.QUEUE_DB.prepare("SELECT * FROM videos WHERE video_id = ?")
    .bind(videoId)
    .first<VideoRow>();
  if (!row) return undefined;
  return rowToEntry(row, await chunkIndexes(env, videoId));
}

export async function loadManifest(env: Env): Promise<{ manifest: Manifest }> {
  await ensureStateSchema(env);
  const [videoResult, chunkResult] = await Promise.all([
    env.QUEUE_DB.prepare("SELECT * FROM videos ORDER BY updated_at DESC").all<VideoRow>(),
    env.QUEUE_DB.prepare("SELECT video_id, chunk_index, completed_at FROM transcript_chunks ORDER BY video_id, chunk_index")
      .all<ChunkRow>(),
  ]);
  const byVideo = new Map<string, number[]>();
  for (const chunk of chunkResult.results) {
    const list = byVideo.get(chunk.video_id) || [];
    list.push(chunk.chunk_index);
    byVideo.set(chunk.video_id, list);
  }

  const videos: Record<string, ManifestEntry> = {};
  let updatedAt = new Date(0).toISOString();
  for (const row of videoResult.results) {
    videos[row.video_id] = rowToEntry(row, byVideo.get(row.video_id) || []);
    if (Date.parse(row.updated_at) > Date.parse(updatedAt)) updatedAt = row.updated_at;
  }
  return { manifest: { version: 1, updatedAt, videos } };
}

export function youtubeResolverCooldownUntil(manifest: Manifest, now = Date.now()): string | undefined {
  let latestRetryAt = 0;
  for (const entry of Object.values(manifest.videos)) {
    if (entry.status !== "waiting" || !entry.retryAfterAt || !entry.lastError?.includes(YOUTUBE_BOT_BLOCK_MARKER)) continue;
    const retryAt = Date.parse(entry.retryAfterAt);
    if (Number.isFinite(retryAt) && retryAt > now && retryAt > latestRetryAt) latestRetryAt = retryAt;
  }
  return latestRetryAt > 0 ? new Date(latestRetryAt).toISOString() : undefined;
}

async function insertNewClaim(env: Env, video: VideoRecord, entry: ManifestEntry, nowIso: string): Promise<boolean> {
  await ensureStateSchema(env);
  const result = await env.QUEUE_DB.prepare(
    `INSERT OR IGNORE INTO videos (
      video_id,title,youtube_url,status,attempts,started_at,transcription_model,summary_model,
      duration_seconds,chunk_seconds,total_chunks,next_chunk_index,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    video.id,
    video.title,
    `https://youtu.be/${video.id}`,
    "processing",
    entry.attempts,
    entry.startedAt || nowIso,
    entry.transcriptionModel || null,
    entry.summaryModel || null,
    entry.durationSeconds || null,
    entry.chunkSeconds || null,
    entry.totalChunks || null,
    entry.nextChunkIndex || 0,
    nowIso,
  ).run();
  return Number(result.meta.changes || 0) === 1;
}

export async function claimVideo(env: Env, video: VideoRecord): Promise<ClaimResult> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const leaseMs = parsePositiveInt(env.PROCESSING_LEASE_MINUTES, 90) * 60_000;
  const retryMs = parsePositiveInt(env.RETRY_FAILED_AFTER_MINUTES, 30) * 60_000;

  const { manifest } = await loadManifest(env);
  const resolverCooldownUntil = youtubeResolverCooldownUntil(manifest, now);
  if (resolverCooldownUntil) {
    return { claimed: false, reason: `YouTube resolver cooldown is active until ${resolverCooldownUntil}` };
  }

  const existing = manifest.videos[video.id];
  const chunkSeconds = parsePositiveInt(env.TRANSCRIPTION_CHUNK_SECONDS, 2700);
  const durationSeconds = Math.max(1, Math.ceil(video.durationSeconds || existing?.durationSeconds || chunkSeconds));
  const totalChunks = chunkCount(durationSeconds, chunkSeconds);
  const completedChunks = normalizedCompletedChunks(totalChunks, existing?.completedChunks);
  const nextChunkIndex = nextPendingChunk(totalChunks, completedChunks);
  const attempts = (existing?.attempts || 0) + 1;

  const nextEntry: ManifestEntry = {
    ...(existing || {}),
    status: "processing",
    title: video.title,
    youtubeUrl: `https://youtu.be/${video.id}`,
    attempts,
    startedAt: nowIso,
    failedAt: undefined,
    retryAfterAt: undefined,
    lastError: undefined,
    transcriptionModel: env.GROQ_TRANSCRIPTION_MODEL,
    summaryModel: env.SUMMARY_ENABLED === "true" ? env.GROQ_SUMMARY_MODEL : undefined,
    durationSeconds,
    chunkSeconds,
    totalChunks,
    nextChunkIndex,
    completedChunks,
    finalizationId: undefined,
    updatedAt: nowIso,
  };

  if (!existing) {
    if (await insertNewClaim(env, video, nextEntry, nowIso)) return { claimed: true, attempts, entry: nextEntry };
    return { claimed: false, reason: "claim lost to another worker" };
  }

  if (existing.status === "completed") return { claimed: false, reason: "already completed" };
  if (existing.status === "finalizing") return { claimed: false, reason: "finalization workflow is active" };
  if (existing.status === "processing" && existing.startedAt && now - Date.parse(existing.startedAt) < leaseMs) {
    return { claimed: false, reason: "processing lease is still active" };
  }
  if (existing.status === "waiting" && existing.retryAfterAt && now < Date.parse(existing.retryAfterAt)) {
    return { claimed: false, reason: `waiting for retry window at ${existing.retryAfterAt}` };
  }
  if (existing.status === "failed" && existing.failedAt && now - Date.parse(existing.failedAt) < retryMs) {
    return { claimed: false, reason: "failure retry cooldown is still active" };
  }

  const result = await env.QUEUE_DB.prepare(
    `UPDATE videos SET
      title=?, youtube_url=?, status='processing', attempts=?, started_at=?,
      completed_at=NULL, failed_at=NULL, retry_after_at=NULL, path=path, last_error=NULL,
      transcription_model=?, summary_model=?, duration_seconds=?, chunk_seconds=?, total_chunks=?,
      next_chunk_index=?, finalization_id=NULL, updated_at=?
     WHERE video_id=? AND updated_at=?`,
  ).bind(
    video.title,
    `https://youtu.be/${video.id}`,
    attempts,
    nowIso,
    env.GROQ_TRANSCRIPTION_MODEL,
    env.SUMMARY_ENABLED === "true" ? env.GROQ_SUMMARY_MODEL : null,
    durationSeconds,
    chunkSeconds,
    totalChunks,
    nextChunkIndex,
    nowIso,
    video.id,
    existing.updatedAt || "",
  ).run();

  if (Number(result.meta.changes || 0) !== 1) return { claimed: false, reason: "claim lost to another worker" };
  return { claimed: true, attempts, entry: nextEntry };
}

export async function recordChunkCompleted(
  env: Env,
  videoId: string,
  chunkIndex: number,
): Promise<ManifestEntry> {
  const existing = await getManifestEntry(env, videoId);
  if (!existing || existing.status !== "processing") throw new Error(`video ${videoId} is not processing`);
  const totalChunks = existing.totalChunks || 1;
  if (chunkIndex < 0 || chunkIndex >= totalChunks) throw new Error(`invalid chunk index ${chunkIndex}/${totalChunks}`);

  const nowIso = new Date().toISOString();
  const completedChunks = normalizedCompletedChunks(totalChunks, [...(existing.completedChunks || []), chunkIndex]);
  const nextChunkIndex = nextPendingChunk(totalChunks, completedChunks);
  await env.QUEUE_DB.prepare(
    "UPDATE videos SET next_chunk_index=?, updated_at=? WHERE video_id=?",
  ).bind(nextChunkIndex, nowIso, videoId).run();

  return { ...existing, completedChunks, nextChunkIndex, updatedAt: nowIso };
}

export async function deferVideo(env: Env, video: VideoRecord, retryAfterSeconds: number, error: unknown): Promise<void> {
  const existing = await getManifestEntry(env, video.id);
  const nowIso = new Date().toISOString();
  const retryAt = new Date(Date.now() + Math.max(1, Math.ceil(retryAfterSeconds)) * 1000).toISOString();
  await env.QUEUE_DB.prepare(
    `UPDATE videos SET status='waiting', retry_after_at=?, last_error=?, failed_at=NULL,
       title=?, youtube_url=?, updated_at=? WHERE video_id=?`,
  ).bind(
    retryAt,
    truncate(errorMessage(error), 1200),
    video.title,
    `https://youtu.be/${video.id}`,
    nowIso,
    video.id,
  ).run();
  if (!existing) throw new Error(`video ${video.id} has no D1 state to defer`);
}

export async function makeRetryableNow(env: Env, videoId: string): Promise<boolean> {
  const existing = await getManifestEntry(env, videoId);
  if (!existing || (existing.status !== "failed" && existing.status !== "waiting")) return false;
  const nowIso = new Date().toISOString();
  await env.QUEUE_DB.prepare(
    "UPDATE videos SET failed_at=?, retry_after_at=?, updated_at=? WHERE video_id=?",
  ).bind(new Date(0).toISOString(), new Date(0).toISOString(), nowIso, videoId).run();
  return true;
}

export async function markFinalizing(env: Env, videoId: string, workflowId: string): Promise<ManifestEntry> {
  const existing = await getManifestEntry(env, videoId);
  if (!existing) throw new Error(`video ${videoId} has no D1 state`);
  const nowIso = new Date().toISOString();
  await env.QUEUE_DB.prepare(
    `UPDATE videos SET status='finalizing', finalization_id=?, failed_at=NULL,
       retry_after_at=NULL, last_error=NULL, updated_at=? WHERE video_id=?`,
  ).bind(workflowId, nowIso, videoId).run();
  return { ...existing, status: "finalizing", finalizationId: workflowId, updatedAt: nowIso };
}

export async function completeVideo(
  env: Env,
  video: VideoRecord,
  path: string,
  workflowId?: string,
): Promise<void> {
  await ensureStateSchema(env);
  const nowIso = new Date().toISOString();
  const statement = workflowId
    ? env.QUEUE_DB.prepare(
        `UPDATE videos SET status='completed', path=?, completed_at=?, failed_at=NULL,
           retry_after_at=NULL, last_error=NULL, finalization_id=NULL,
           title=?, youtube_url=?, transcription_model=?, summary_model=?, updated_at=?
         WHERE video_id=? AND status='finalizing' AND finalization_id=?`,
      ).bind(
        path,
        nowIso,
        video.title,
        `https://youtu.be/${video.id}`,
        env.GROQ_TRANSCRIPTION_MODEL,
        env.SUMMARY_ENABLED === "true" ? env.GROQ_SUMMARY_MODEL : null,
        nowIso,
        video.id,
        workflowId,
      )
    : env.QUEUE_DB.prepare(
        `UPDATE videos SET status='completed', path=?, completed_at=?, failed_at=NULL,
           retry_after_at=NULL, last_error=NULL, finalization_id=NULL,
           title=?, youtube_url=?, transcription_model=?, summary_model=?, updated_at=?
         WHERE video_id=?`,
      ).bind(
        path,
        nowIso,
        video.title,
        `https://youtu.be/${video.id}`,
        env.GROQ_TRANSCRIPTION_MODEL,
        env.SUMMARY_ENABLED === "true" ? env.GROQ_SUMMARY_MODEL : null,
        nowIso,
        video.id,
      );
  const result = await statement.run();
  if (workflowId && Number(result.meta.changes || 0) !== 1) {
    const current = await getManifestEntry(env, video.id);
    if (current?.status === "completed" && current.path === path) return;
    throw new Error(`finalization ${workflowId} no longer owns ${video.id}`);
  }
}

export async function failVideo(env: Env, video: VideoRecord, error: unknown): Promise<void> {
  await ensureStateSchema(env);
  const nowIso = new Date().toISOString();
  try {
    await env.QUEUE_DB.prepare(
      `UPDATE videos SET status='failed', failed_at=?, retry_after_at=NULL,
         last_error=?, finalization_id=NULL, title=?, youtube_url=?, updated_at=?
       WHERE video_id=? AND status != 'completed'`,
    ).bind(
      nowIso,
      truncate(errorMessage(error), 1200),
      video.title,
      `https://youtu.be/${video.id}`,
      nowIso,
      video.id,
    ).run();
  } catch (stateError) {
    console.error("Could not record pipeline failure in D1", stateError);
  }
}

export async function failVideoById(
  env: Env,
  videoId: string,
  error: unknown,
  workflowId?: string,
): Promise<void> {
  await ensureStateSchema(env);
  const nowIso = new Date().toISOString();
  if (workflowId) {
    await env.QUEUE_DB.prepare(
      `UPDATE videos SET status='failed', failed_at=?, retry_after_at=NULL,
         last_error=?, finalization_id=NULL, updated_at=?
       WHERE video_id=? AND status != 'completed' AND finalization_id=?`,
    ).bind(nowIso, truncate(errorMessage(error), 1200), nowIso, videoId, workflowId).run();
    return;
  }
  await env.QUEUE_DB.prepare(
    `UPDATE videos SET status='failed', failed_at=?, retry_after_at=NULL,
       last_error=?, finalization_id=NULL, updated_at=? WHERE video_id=? AND status != 'completed'`,
  ).bind(nowIso, truncate(errorMessage(error), 1200), nowIso, videoId).run();
}

export async function resetVideo(env: Env, videoId: string): Promise<boolean> {
  const existing = await getManifestEntry(env, videoId);
  if (!existing) return false;
  await env.QUEUE_DB.batch([
    env.QUEUE_DB.prepare("DELETE FROM summary_outputs WHERE video_id = ?").bind(videoId),
    env.QUEUE_DB.prepare("DELETE FROM summary_inputs WHERE video_id = ?").bind(videoId),
    env.QUEUE_DB.prepare("DELETE FROM transcript_chunks WHERE video_id = ?").bind(videoId),
    env.QUEUE_DB.prepare("DELETE FROM videos WHERE video_id = ?").bind(videoId),
  ]);
  return true;
}

export async function upsertLegacyEntry(env: Env, videoId: string, entry: ManifestEntry): Promise<void> {
  await ensureStateSchema(env);
  const nowIso = entry.updatedAt || entry.completedAt || entry.failedAt || entry.startedAt || new Date().toISOString();
  const wasProcessing = entry.status === "processing" || entry.status === "finalizing";
  const migratedStatus = wasProcessing ? "failed" : entry.status;
  const migratedFailedAt = wasProcessing ? new Date(0).toISOString() : entry.failedAt || null;
  const migratedLastError = wasProcessing
    ? "Migrated from legacy ai-memory runtime state; ready to resume."
    : entry.lastError || null;
  await env.QUEUE_DB.prepare(
    `INSERT INTO videos (
      video_id,title,youtube_url,status,attempts,started_at,completed_at,failed_at,retry_after_at,
      path,last_error,transcription_model,summary_model,duration_seconds,chunk_seconds,total_chunks,
      next_chunk_index,finalization_id,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(video_id) DO NOTHING`,
  ).bind(
    videoId,
    entry.title,
    entry.youtubeUrl || `https://youtu.be/${videoId}`,
    migratedStatus,
    entry.attempts || 0,
    entry.startedAt || null,
    entry.completedAt || null,
    migratedFailedAt,
    entry.retryAfterAt || null,
    entry.path || null,
    migratedLastError,
    entry.transcriptionModel || env.GROQ_TRANSCRIPTION_MODEL,
    entry.summaryModel || (env.SUMMARY_ENABLED === "true" ? env.GROQ_SUMMARY_MODEL : null),
    entry.durationSeconds || null,
    entry.chunkSeconds || parsePositiveInt(env.TRANSCRIPTION_CHUNK_SECONDS, 2700),
    entry.totalChunks || null,
    entry.nextChunkIndex || 0,
    null,
    nowIso,
  ).run();
}


export async function runtimeMeta(env: Env, key: string): Promise<string | undefined> {
  await ensureStateSchema(env);
  const row = await env.QUEUE_DB.prepare("SELECT value FROM runtime_meta WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value;
}

export async function setRuntimeMeta(env: Env, key: string, value: string): Promise<void> {
  await ensureStateSchema(env);
  const nowIso = new Date().toISOString();
  await env.QUEUE_DB.prepare(
    "INSERT INTO runtime_meta (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  ).bind(key, value, nowIso).run();
}

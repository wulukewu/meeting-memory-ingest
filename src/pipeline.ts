import type {
  Env,
  ManifestEntry,
  RunResult,
  StoredTranscriptChunk,
  StoredTranscriptWork,
  TranscriptResult,
  TriggerKind,
  VideoRecord,
} from "./types";
import { mergeTranscriptChunks, normalizedCompletedChunks } from "./chunks";
import {
  completeVideo,
  deferVideo,
  deleteTextFile,
  failVideo,
  getTextFile,
  loadManifest,
  recordChunkCompleted,
  upsertTextFile,
  YOUTUBE_BOT_BLOCK_MARKER,
} from "./github";
import { GroqRateLimitError, summarizeMeeting, transcribeAudioUpload, transcribeAudioUrl } from "./groq";
import { buildTranscriptPath, renderMeetingMarkdown } from "./markdown";
import { dispatchYouTubeResolver } from "./resolver-dispatch";
import { errorMessage, parsePositiveInt } from "./util";
import { getVideo, getYouTubeAccessToken, listPlaylistVideos } from "./youtube";

function validateResolvedAudioUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("resolved audio URL must use https");
  if (!(url.hostname === "googlevideo.com" || url.hostname.endsWith(".googlevideo.com"))) {
    throw new Error(`resolved audio URL has unexpected host: ${url.hostname}`);
  }
  return url.toString();
}

function workPath(env: Env, videoId: string): string {
  return `${env.TRANSCRIPT_ROOT.replace(/\/$/, "")}/_work/${videoId}.json`;
}

async function loadWork(env: Env, videoId: string): Promise<StoredTranscriptWork> {
  const file = await getTextFile(env, workPath(env, videoId));
  if (!file) return { version: 1, videoId, chunks: {} };
  const parsed = JSON.parse(file.text) as StoredTranscriptWork;
  if (parsed.version !== 1 || parsed.videoId !== videoId || !parsed.chunks || typeof parsed.chunks !== "object") {
    throw new Error(`invalid transcript work file for ${videoId}`);
  }
  return parsed;
}

async function storeChunk(
  env: Env,
  videoId: string,
  chunkIndex: number,
  offsetSeconds: number,
  transcript: TranscriptResult,
): Promise<void> {
  const work = await loadWork(env, videoId);
  work.chunks[String(chunkIndex)] = {
    version: 1,
    videoId,
    chunkIndex,
    offsetSeconds,
    transcript,
  };
  await upsertTextFile(
    env,
    workPath(env, videoId),
    `${JSON.stringify(work, null, 2)}\n`,
    `chore(meetings): store transcript chunk ${videoId}#${chunkIndex}`,
  );
}

async function cleanupWork(env: Env, videoId: string): Promise<void> {
  try {
    await deleteTextFile(env, workPath(env, videoId), `chore(meetings): clean transcript work ${videoId}`);
  } catch (error) {
    console.error(`Could not clean transcript work file for ${videoId}`, error);
  }
}

async function persistTranscript(env: Env, video: VideoRecord, transcript: TranscriptResult): Promise<string> {
  const summary = await summarizeMeeting(env, video, transcript);
  const path = buildTranscriptPath(env, video, summary);
  const markdown = renderMeetingMarkdown(env, video, transcript, summary);
  await upsertTextFile(env, path, markdown, `feat(meetings): ingest ${video.id}`);
  await completeVideo(env, video, path);
  return path;
}

async function finalizeFromWork(env: Env, video: VideoRecord, entry: ManifestEntry): Promise<string> {
  const totalChunks = entry.totalChunks || 1;
  const work = await loadWork(env, video.id);
  const chunks: StoredTranscriptChunk[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const chunk = work.chunks[String(index)];
    if (!chunk) throw new Error(`transcript chunk ${index}/${totalChunks} is missing for ${video.id}`);
    chunks.push(chunk);
  }
  const transcript = mergeTranscriptChunks(chunks, entry.durationSeconds || video.durationSeconds);
  const path = await persistTranscript(env, video, transcript);
  await cleanupWork(env, video.id);
  return path;
}

async function processResolvedVideo(env: Env, video: VideoRecord, audioUrl: string): Promise<string> {
  try {
    const safeAudioUrl = validateResolvedAudioUrl(audioUrl);
    const transcript = await transcribeAudioUrl(env, safeAudioUrl, video);
    return await persistTranscript(env, video, transcript);
  } catch (error) {
    await failVideo(env, video, error);
    throw error;
  }
}

async function dispatchClaimedVideo(env: Env, video: VideoRecord, entry: ManifestEntry): Promise<void> {
  try {
    await dispatchYouTubeResolver(env, video.id, entry);
  } catch (error) {
    await failVideo(env, video, error);
    throw error;
  }
}

function baseResult(trigger: TriggerKind): RunResult {
  return { trigger, scanned: 0, eligible: 0, claimed: 0, dispatched: [], completed: [], skipped: [], failed: [] };
}

export async function runPlaylist(env: Env, trigger: TriggerKind = "cron"): Promise<RunResult> {
  const result = baseResult(trigger);
  const accessToken = await getYouTubeAccessToken(env);
  const videos = await listPlaylistVideos(env, accessToken);
  result.scanned = videos.length;

  const eligible = videos.filter((video) => video.privacyStatus === "unlisted");
  result.eligible = eligible.length;
  const maxItems = parsePositiveInt(env.MAX_ITEMS_PER_RUN, 1);

  for (const video of eligible) {
    if (result.claimed >= maxItems) {
      result.skipped.push({ videoId: video.id, reason: "per-run processing limit reached" });
      continue;
    }

    const claim = await claimVideoWithProgress(env, video);
    if (!claim.entry) {
      result.skipped.push({ videoId: video.id, reason: claim.reason || "not claimable" });
      continue;
    }

    result.claimed += 1;
    try {
      await dispatchClaimedVideo(env, video, claim.entry);
      result.dispatched.push(video.id);
    } catch (error) {
      result.failed.push({ videoId: video.id, error: errorMessage(error) });
    }
  }

  return result;
}

async function claimVideoWithProgress(env: Env, video: VideoRecord): Promise<{ entry?: ManifestEntry; reason?: string }> {
  const { claimVideo } = await import("./github");
  const claim = await claimVideo(env, video);
  return { entry: claim.claimed ? claim.entry : undefined, reason: claim.reason };
}

export async function runSingleVideo(env: Env, videoId: string): Promise<RunResult> {
  const result = baseResult("single");
  const accessToken = await getYouTubeAccessToken(env);
  const video = await getVideo(env, accessToken, videoId);
  result.scanned = 1;

  if (video.privacyStatus !== "unlisted") {
    result.skipped.push({ videoId, reason: `video privacy is ${video.privacyStatus}; only unlisted is processed` });
    return result;
  }

  result.eligible = 1;
  const claim = await claimVideoWithProgress(env, video);
  if (!claim.entry) {
    result.skipped.push({ videoId, reason: claim.reason || "not claimable" });
    return result;
  }

  result.claimed = 1;
  try {
    await dispatchClaimedVideo(env, video, claim.entry);
    result.dispatched.push(video.id);
  } catch (error) {
    result.failed.push({ videoId, error: errorMessage(error) });
  }
  return result;
}

async function claimedVideo(env: Env, videoId: string): Promise<{ video: VideoRecord; entry: ManifestEntry }> {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) throw new Error("invalid video id");
  const { manifest } = await loadManifest(env);
  const entry = manifest.videos[videoId];
  if (!entry || entry.status !== "processing") throw new Error(`video ${videoId} is not currently claimed for processing`);
  const accessToken = await getYouTubeAccessToken(env);
  return { video: await getVideo(env, accessToken, videoId), entry };
}

export type ChunkTranscriptionResult = {
  videoId: string;
  status: "chunk_completed" | "completed" | "deferred" | "failed";
  chunkIndex?: number;
  nextChunkIndex?: number;
  completedChunks?: number;
  totalChunks?: number;
  retryAfterAt?: string;
  path?: string;
};

async function finalizeOrDefer(
  env: Env,
  video: VideoRecord,
  entry: ManifestEntry,
  chunkIndex: number,
): Promise<ChunkTranscriptionResult> {
  try {
    const path = await finalizeFromWork(env, video, entry);
    return { videoId: video.id, status: "completed", chunkIndex, path };
  } catch (error) {
    if (error instanceof GroqRateLimitError) {
      await deferVideo(env, video, error.retryAfterSeconds, error);
      const retryAfterAt = new Date(Date.now() + error.retryAfterSeconds * 1000).toISOString();
      return { videoId: video.id, status: "deferred", chunkIndex, retryAfterAt };
    }
    await failVideo(env, video, error);
    return { videoId: video.id, status: "failed", chunkIndex };
  }
}

export async function handleResolverTranscription(
  env: Env,
  videoId: string,
  chunkIndex: number,
  body: BodyInit,
  contentType: string,
): Promise<ChunkTranscriptionResult> {
  const { manifest } = await loadManifest(env);
  const manifestEntry = manifest.videos[videoId];
  if (manifestEntry?.status === "completed") {
    return { videoId, status: "completed", chunkIndex, path: manifestEntry.path };
  }

  const { video, entry } = await claimedVideo(env, videoId);
  const totalChunks = entry.totalChunks || 1;
  const chunkSeconds = entry.chunkSeconds || parsePositiveInt(env.TRANSCRIPTION_CHUNK_SECONDS, 2700);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
    throw new Error(`invalid chunk index ${chunkIndex}/${totalChunks}`);
  }

  const work = await loadWork(env, videoId);
  const cached = work.chunks[String(chunkIndex)];
  let updatedEntry = entry;

  if (cached) {
    if (!(entry.completedChunks || []).includes(chunkIndex)) {
      updatedEntry = await recordChunkCompleted(env, videoId, chunkIndex);
    }
  } else {
    const expected = entry.nextChunkIndex || 0;
    if (chunkIndex !== expected) throw new Error(`unexpected chunk ${chunkIndex}; next expected chunk is ${expected}`);

    try {
      const transcript = await transcribeAudioUpload(env, body, contentType);
      await storeChunk(env, videoId, chunkIndex, chunkIndex * chunkSeconds, transcript);
      updatedEntry = await recordChunkCompleted(env, videoId, chunkIndex);
    } catch (error) {
      if (error instanceof GroqRateLimitError) {
        await deferVideo(env, video, error.retryAfterSeconds, error);
        return {
          videoId,
          status: "deferred",
          chunkIndex,
          retryAfterAt: new Date(Date.now() + error.retryAfterSeconds * 1000).toISOString(),
        };
      }
      await failVideo(env, video, error);
      return { videoId, status: "failed", chunkIndex };
    }
  }

  const completedChunks = normalizedCompletedChunks(totalChunks, updatedEntry.completedChunks);
  if (completedChunks.length >= totalChunks) {
    return finalizeOrDefer(env, video, { ...updatedEntry, completedChunks }, chunkIndex);
  }

  return {
    videoId,
    status: "chunk_completed",
    chunkIndex,
    nextChunkIndex: updatedEntry.nextChunkIndex,
    completedChunks: completedChunks.length,
    totalChunks,
  };
}

export type ResolverCallbackPayload = {
  videoId: string;
  audioUrl?: string;
  error?: string;
  errorCode?: string;
  retryAfterSeconds?: number;
};

export type ResolverCallbackResult = {
  videoId: string;
  status: "completed" | "failed" | "deferred" | "ignored";
  path?: string;
  retryAfterAt?: string;
};

export async function handleResolverCallback(
  env: Env,
  payload: ResolverCallbackPayload,
): Promise<ResolverCallbackResult> {
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(payload.videoId)) throw new Error("invalid video id");

  const { manifest } = await loadManifest(env);
  const entry = manifest.videos[payload.videoId];
  if (entry?.status === "completed") {
    return { videoId: payload.videoId, status: "ignored", path: entry.path };
  }
  if (!entry || entry.status !== "processing") {
    throw new Error(`video ${payload.videoId} is not currently claimed for processing`);
  }

  const accessToken = await getYouTubeAccessToken(env);
  const video = await getVideo(env, accessToken, payload.videoId);

  if (payload.error) {
    if (payload.errorCode === "youtube_bot_blocked") {
      const requestedRetry = Number(payload.retryAfterSeconds);
      const retryAfterSeconds = Number.isFinite(requestedRetry)
        ? Math.min(24 * 60 * 60, Math.max(5 * 60, Math.ceil(requestedRetry)))
        : 2 * 60 * 60;
      const retryAfterAt = new Date(Date.now() + retryAfterSeconds * 1000).toISOString();
      await deferVideo(
        env,
        video,
        retryAfterSeconds,
        new Error(`${YOUTUBE_BOT_BLOCK_MARKER} YouTube requested bot verification: ${payload.error}`),
      );
      return { videoId: payload.videoId, status: "deferred", retryAfterAt };
    }

    await failVideo(env, video, new Error(`resolver failed: ${payload.error}`));
    return { videoId: payload.videoId, status: "failed" };
  }
  if (!payload.audioUrl) throw new Error("resolver callback did not include audioUrl or error");

  const path = await processResolvedVideo(env, video, payload.audioUrl);
  return { videoId: payload.videoId, status: "completed", path };
}

import type {
  Env,
  ManifestEntry,
  RunResult,
  StoredTranscriptChunk,
  TriggerKind,
  VideoRecord,
} from "./types";
import { normalizedCompletedChunks } from "./chunks";
import { GroqRateLimitError, transcribeAudioUpload } from "./groq";
import {
  claimVideo,
  deferVideo,
  failVideo,
  failVideoById,
  getManifestEntry,
  makeRetryableNow,
  markFinalizing,
  recordChunkCompleted,
  YOUTUBE_BOT_BLOCK_MARKER,
} from "./state";
import { dispatchYouTubeResolver } from "./resolver-dispatch";
import { errorMessage, parsePositiveInt } from "./util";
import { getVideo, getYouTubeAccessToken, listPlaylistVideos } from "./youtube";
import { getStoredChunk, putStoredChunk } from "./work-store";

async function dispatchFinalization(env: Env, videoId: string): Promise<string> {
  const existing = await getManifestEntry(env, videoId);
  if (!existing) throw new Error(`video ${videoId} has no D1 state`);
  if (existing.status === "completed") return existing.path || "completed";
  if (existing.status === "finalizing" && existing.finalizationId) return existing.finalizationId;

  const workflowId = `finalize-${videoId}-${crypto.randomUUID()}`;
  await markFinalizing(env, videoId, workflowId);
  try {
    await env.FINALIZE_WORKFLOW.create({
      id: workflowId,
      params: { videoId },
    });
    return workflowId;
  } catch (error) {
    await failVideoById(env, videoId, error);
    throw error;
  }
}

async function dispatchClaimedVideo(env: Env, video: VideoRecord, entry: ManifestEntry): Promise<void> {
  const totalChunks = entry.totalChunks || 1;
  const completed = normalizedCompletedChunks(totalChunks, entry.completedChunks);
  if (completed.length >= totalChunks || (entry.nextChunkIndex ?? 0) >= totalChunks) {
    await dispatchFinalization(env, video.id);
    return;
  }
  await dispatchYouTubeResolver(env, video.id, entry);
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

    const claim = await claimVideo(env, video);
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
  const claim = await claimVideo(env, video);
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
  const entry = await getManifestEntry(env, videoId);
  if (!entry || entry.status !== "processing") throw new Error(`video ${videoId} is not currently claimed for processing`);
  const accessToken = await getYouTubeAccessToken(env);
  return { video: await getVideo(env, accessToken, videoId), entry };
}

export type ChunkTranscriptionResult = {
  videoId: string;
  status: "chunk_completed" | "finalizing" | "completed" | "deferred" | "failed";
  chunkIndex?: number;
  nextChunkIndex?: number;
  completedChunks?: number;
  totalChunks?: number;
  retryAfterAt?: string;
  workflowId?: string;
  path?: string;
};

export async function handleResolverTranscription(
  env: Env,
  videoId: string,
  chunkIndex: number,
  body: BodyInit,
  contentType: string,
): Promise<ChunkTranscriptionResult> {
  const manifestEntry = await getManifestEntry(env, videoId);
  if (manifestEntry?.status === "completed") {
    return { videoId, status: "completed", chunkIndex, path: manifestEntry.path };
  }
  if (manifestEntry?.status === "finalizing") {
    return { videoId, status: "finalizing", chunkIndex, workflowId: manifestEntry.finalizationId };
  }

  const { video, entry } = await claimedVideo(env, videoId);
  const totalChunks = entry.totalChunks || 1;
  const chunkSeconds = entry.chunkSeconds || parsePositiveInt(env.TRANSCRIPTION_CHUNK_SECONDS, 2700);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
    throw new Error(`invalid chunk index ${chunkIndex}/${totalChunks}`);
  }

  const cached = await getStoredChunk(env, videoId, chunkIndex);
  let updatedEntry = entry;

  if (cached) {
    if (!(entry.completedChunks || []).includes(chunkIndex)) {
      updatedEntry = await recordChunkCompleted(env, videoId, chunkIndex, `work/${videoId}/chunk-${String(chunkIndex).padStart(4, "0")}.json`);
    }
  } else {
    const expected = entry.nextChunkIndex || 0;
    if (chunkIndex !== expected) throw new Error(`unexpected chunk ${chunkIndex}; next expected chunk is ${expected}`);

    try {
      const transcript = await transcribeAudioUpload(env, body, contentType);
      const chunk: StoredTranscriptChunk = {
        version: 1,
        videoId,
        chunkIndex,
        offsetSeconds: chunkIndex * chunkSeconds,
        transcript,
      };
      const key = await putStoredChunk(env, chunk);
      updatedEntry = await recordChunkCompleted(env, videoId, chunkIndex, key);
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
    try {
      const workflowId = await dispatchFinalization(env, videoId);
      return { videoId, status: "finalizing", chunkIndex, workflowId, completedChunks: completedChunks.length, totalChunks };
    } catch (error) {
      return { videoId, status: "failed", chunkIndex };
    }
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

  const entry = await getManifestEntry(env, payload.videoId);
  if (entry?.status === "completed") {
    return { videoId: payload.videoId, status: "ignored", path: entry.path };
  }
  if (entry?.status === "finalizing") {
    return { videoId: payload.videoId, status: "ignored" };
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

  if (payload.audioUrl) {
    await failVideo(env, video, new Error("legacy direct-audio resolver callbacks are no longer supported"));
    return { videoId: payload.videoId, status: "failed" };
  }

  throw new Error("resolver callback did not include an error diagnostic");
}

export { makeRetryableNow };

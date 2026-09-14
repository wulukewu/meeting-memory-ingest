import type { Env, RunResult, TriggerKind, VideoRecord } from "./types";
import { claimVideo, completeVideo, failVideo, loadManifest, upsertTextFile } from "./github";
import { summarizeMeeting, transcribeAudioUrl } from "./groq";
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

async function dispatchClaimedVideo(env: Env, video: VideoRecord): Promise<void> {
  try {
    await dispatchYouTubeResolver(env, video.id);
  } catch (error) {
    await failVideo(env, video, error);
    throw error;
  }
}

async function processResolvedVideo(env: Env, video: VideoRecord, audioUrl: string): Promise<string> {
  try {
    const safeAudioUrl = validateResolvedAudioUrl(audioUrl);
    const transcript = await transcribeAudioUrl(env, safeAudioUrl, video);
    const summary = await summarizeMeeting(env, video, transcript);
    const path = buildTranscriptPath(env, video, summary);
    const markdown = renderMeetingMarkdown(env, video, transcript, summary);
    await upsertTextFile(env, path, markdown, `feat(meetings): ingest ${video.id}`);
    await completeVideo(env, video, path);
    return path;
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

    const claim = await claimVideo(env, video);
    if (!claim.claimed) {
      result.skipped.push({ videoId: video.id, reason: claim.reason || "not claimable" });
      continue;
    }

    result.claimed += 1;
    try {
      await dispatchClaimedVideo(env, video);
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
  if (!claim.claimed) {
    result.skipped.push({ videoId, reason: claim.reason || "not claimable" });
    return result;
  }

  result.claimed = 1;
  try {
    await dispatchClaimedVideo(env, video);
    result.dispatched.push(video.id);
  } catch (error) {
    result.failed.push({ videoId, error: errorMessage(error) });
  }
  return result;
}

export async function handleResolverCallback(
  env: Env,
  payload: { videoId: string; audioUrl?: string; error?: string },
): Promise<{ videoId: string; status: "completed" | "failed" | "ignored"; path?: string }> {
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
    await failVideo(env, video, new Error(`resolver failed: ${payload.error}`));
    return { videoId: payload.videoId, status: "failed" };
  }
  if (!payload.audioUrl) throw new Error("resolver callback did not include audioUrl or error");

  const path = await processResolvedVideo(env, video, payload.audioUrl);
  return { videoId: payload.videoId, status: "completed", path };
}

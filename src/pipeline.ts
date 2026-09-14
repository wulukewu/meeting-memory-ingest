import type { Env, RunResult, TriggerKind, VideoRecord } from "./types";
import { claimVideo, completeVideo, failVideo, upsertTextFile } from "./github";
import { summarizeMeeting, transcribeAudioUrl } from "./groq";
import { buildTranscriptPath, renderMeetingMarkdown } from "./markdown";
import { errorMessage, parsePositiveInt } from "./util";
import { getVideo, getYouTubeAccessToken, listPlaylistVideos } from "./youtube";
import { resolveYouTubeAudioUrl } from "./youtube-audio";

async function processClaimedVideo(env: Env, video: VideoRecord): Promise<string> {
  try {
    const audio = await resolveYouTubeAudioUrl(env, video.id);
    const transcript = await transcribeAudioUrl(env, audio.url, video);
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
  return { trigger, scanned: 0, eligible: 0, claimed: 0, completed: [], skipped: [], failed: [] };
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
      await processClaimedVideo(env, video);
      result.completed.push(video.id);
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
    await processClaimedVideo(env, video);
    result.completed.push(video.id);
  } catch (error) {
    result.failed.push({ videoId, error: errorMessage(error) });
  }
  return result;
}

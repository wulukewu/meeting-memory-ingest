import { Innertube } from "youtubei.js/cf-worker";
import type { Env } from "./types";

export interface ResolvedAudio {
  url: string;
  mimeType?: string;
  bitrate?: number;
  approxDurationMs?: number;
}

type PlaybackClient = "VISIONOS" | "ANDROID_VR" | "ANDROID" | "IOS" | "WEB";

function playbackClients(env: Env): PlaybackClient[] {
  const preferred = (env.YOUTUBE_INNERTUBE_CLIENT || "VISIONOS").toUpperCase() as PlaybackClient;
  const known: PlaybackClient[] = ["VISIONOS", "ANDROID_VR", "ANDROID", "IOS", "WEB"];
  return [preferred, ...known].filter(
    (client, index, all): client is PlaybackClient => known.includes(client) && all.indexOf(client) === index,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve a short-lived, deciphered YouTube audio URL without proxying the media
 * through the Worker. The URL is handed directly to Groq.
 *
 * YouTube playback requirements change frequently, and a client that works one
 * day may temporarily stop returning streamingData. Try a small ordered set of
 * InnerTube clients before declaring the resolver unavailable. Optional PO-token
 * and visitor-data secrets remain supported for future YouTube restrictions.
 */
export async function resolveYouTubeAudioUrl(env: Env, videoId: string): Promise<ResolvedAudio> {
  const youtube = await Innertube.create({
    generate_session_locally: true,
    ...(env.YOUTUBE_PO_TOKEN ? { po_token: env.YOUTUBE_PO_TOKEN } : {}),
    ...(env.YOUTUBE_VISITOR_DATA ? { visitor_data: env.YOUTUBE_VISITOR_DATA } : {}),
  });

  const failures: string[] = [];
  for (const client of playbackClients(env)) {
    try {
      const format = await youtube.getStreamingData(videoId, {
        type: "audio",
        quality: "best",
        format: "any",
        client,
      });

      if (!format?.url) {
        failures.push(`${client}: no playable URL returned`);
        continue;
      }

      return {
        url: format.url,
        mimeType: format.mime_type,
        bitrate: format.bitrate,
        approxDurationMs: format.approx_duration_ms,
      };
    } catch (error) {
      failures.push(`${client}: ${errorMessage(error)}`);
    }
  }

  throw new Error(`YouTube audio resolver exhausted playback clients for ${videoId}: ${failures.join(" | ")}`);
}

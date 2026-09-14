import { Innertube } from "youtubei.js/cf-worker";
import type { Env } from "./types";

export interface ResolvedAudio {
  url: string;
  mimeType?: string;
  bitrate?: number;
  approxDurationMs?: number;
}

/**
 * Resolve a short-lived, deciphered YouTube audio URL without proxying the media
 * through the Worker. The URL is handed directly to Groq.
 *
 * YouTube playback requirements change frequently. Optional PO-token and visitor
 * data secrets are supported so the resolver can be hardened without changing
 * the rest of the pipeline.
 */
export async function resolveYouTubeAudioUrl(env: Env, videoId: string): Promise<ResolvedAudio> {
  const youtube = await Innertube.create({
    generate_session_locally: true,
    ...(env.YOUTUBE_PO_TOKEN ? { po_token: env.YOUTUBE_PO_TOKEN } : {}),
    ...(env.YOUTUBE_VISITOR_DATA ? { visitor_data: env.YOUTUBE_VISITOR_DATA } : {}),
  });

  const format = await youtube.getStreamingData(videoId, {
    type: "audio",
    quality: "best",
    format: "any",
  });

  if (!format?.url) throw new Error(`YouTube.js did not return a playable audio URL for ${videoId}`);

  return {
    url: format.url,
    mimeType: format.mime_type,
    bitrate: format.bitrate,
    approxDurationMs: format.approx_duration_ms,
  };
}

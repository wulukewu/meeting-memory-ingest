import type { Env, VideoRecord } from "./types";
import { parseIsoDuration, parsePositiveInt } from "./util";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_ROOT = "https://www.googleapis.com/youtube/v3";

interface PlaylistApiItem {
  id: string;
  snippet?: {
    publishedAt?: string;
    title?: string;
    description?: string;
    resourceId?: { videoId?: string };
  };
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
  status?: { privacyStatus?: string };
}

interface VideoApiItem {
  id: string;
  snippet?: {
    publishedAt?: string;
    title?: string;
    description?: string;
    channelTitle?: string;
  };
  contentDetails?: { duration?: string };
  status?: { privacyStatus?: string };
}

export async function getYouTubeAccessToken(env: Env): Promise<string> {
  const form = new URLSearchParams({
    client_id: env.YOUTUBE_CLIENT_ID,
    client_secret: env.YOUTUBE_CLIENT_SECRET,
    refresh_token: env.YOUTUBE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`YouTube OAuth refresh failed (${response.status}): ${await response.text()}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("YouTube OAuth response did not include access_token");
  return payload.access_token;
}

async function youtubeGet<T>(path: string, accessToken: string, params: URLSearchParams): Promise<T> {
  const response = await fetch(`${API_ROOT}/${path}?${params.toString()}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`YouTube API ${path} failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function listPlaylistVideos(env: Env, accessToken: string): Promise<VideoRecord[]> {
  if (!env.YOUTUBE_PLAYLIST_ID || env.YOUTUBE_PLAYLIST_ID === "REPLACE_ME") {
    throw new Error("YOUTUBE_PLAYLIST_ID is not configured");
  }

  const maxPages = parsePositiveInt(env.MAX_PLAYLIST_PAGES, 10);
  const playlistItems: PlaylistApiItem[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      part: "snippet,contentDetails,status",
      playlistId: env.YOUTUBE_PLAYLIST_ID,
      maxResults: "50",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const payload = await youtubeGet<{ items?: PlaylistApiItem[]; nextPageToken?: string }>(
      "playlistItems",
      accessToken,
      params,
    );
    playlistItems.push(...(payload.items || []));
    pageToken = payload.nextPageToken;
    if (!pageToken) break;
  }

  const byVideoId = new Map<string, PlaylistApiItem>();
  for (const item of playlistItems) {
    const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
    if (videoId) byVideoId.set(videoId, item);
  }

  const ids = [...byVideoId.keys()];
  const records: VideoRecord[] = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    const params = new URLSearchParams({
      part: "snippet,contentDetails,status",
      id: batch.join(","),
      maxResults: "50",
    });
    const payload = await youtubeGet<{ items?: VideoApiItem[] }>("videos", accessToken, params);
    for (const video of payload.items || []) {
      const playlistItem = byVideoId.get(video.id);
      const durationIso = video.contentDetails?.duration;
      records.push({
        id: video.id,
        title: video.snippet?.title || playlistItem?.snippet?.title || video.id,
        description: video.snippet?.description || playlistItem?.snippet?.description || "",
        publishedAt:
          video.snippet?.publishedAt || playlistItem?.contentDetails?.videoPublishedAt || new Date().toISOString(),
        playlistAddedAt: playlistItem?.snippet?.publishedAt,
        privacyStatus: video.status?.privacyStatus || playlistItem?.status?.privacyStatus || "unknown",
        durationIso,
        durationSeconds: parseIsoDuration(durationIso),
        channelTitle: video.snippet?.channelTitle,
      });
    }
  }

  return records.sort((a, b) => {
    const aTime = Date.parse(a.playlistAddedAt || a.publishedAt);
    const bTime = Date.parse(b.playlistAddedAt || b.publishedAt);
    return aTime - bTime;
  });
}

export async function getVideo(env: Env, accessToken: string, videoId: string): Promise<VideoRecord> {
  const params = new URLSearchParams({
    part: "snippet,contentDetails,status",
    id: videoId,
    maxResults: "1",
  });
  const payload = await youtubeGet<{ items?: VideoApiItem[] }>("videos", accessToken, params);
  const video = payload.items?.[0];
  if (!video) throw new Error(`YouTube video ${videoId} was not found or is not accessible`);
  const durationIso = video.contentDetails?.duration;
  return {
    id: video.id,
    title: video.snippet?.title || video.id,
    description: video.snippet?.description || "",
    publishedAt: video.snippet?.publishedAt || new Date().toISOString(),
    privacyStatus: video.status?.privacyStatus || "unknown",
    durationIso,
    durationSeconds: parseIsoDuration(durationIso),
    channelTitle: video.snippet?.channelTitle,
  };
}

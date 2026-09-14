import type { Env, ManifestEntry } from "./types";
import { truncate } from "./util";

function callbackUrl(env: Env): string {
  const base = env.WORKER_PUBLIC_URL.replace(/\/$/, "");
  return `${base}/resolver/callback`;
}

export async function dispatchYouTubeResolver(env: Env, videoId: string, entry: ManifestEntry): Promise<void> {
  const owner = encodeURIComponent(env.RESOLVER_GITHUB_OWNER);
  const repo = encodeURIComponent(env.RESOLVER_GITHUB_REPO);
  const workflow = encodeURIComponent(env.RESOLVER_GITHUB_WORKFLOW);
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.RESOLVER_GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "meeting-memory-ingest",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        video_id: videoId,
        callback_url: callbackUrl(env),
        transcription_model: env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3",
        start_chunk_index: String(entry.nextChunkIndex || 0),
        chunk_seconds: String(entry.chunkSeconds || 2700),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub resolver dispatch failed (${response.status}): ${truncate(await response.text(), 800)}`);
  }
}

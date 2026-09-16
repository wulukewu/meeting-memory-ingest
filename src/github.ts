import type { ClaimResult, Env, Manifest, ManifestEntry, VideoRecord } from "./types";
import { nextPendingChunk, normalizedCompletedChunks, chunkCount } from "./chunks";
import { base64ToUtf8, errorMessage, parsePositiveInt, truncate, utf8ToBase64 } from "./util";

const API_ROOT = "https://api.github.com";
const AI_MEMORY_AUTOMATION_IDENTITY = {
  name: "wulukewu",
  email: "luke@ai-memory.local",
};
export const YOUTUBE_BOT_BLOCK_MARKER = "[youtube_bot_blocked]";

interface ContentFile {
  sha: string;
  content?: string;
  encoding?: string;
}

export class GitHubConflictError extends Error {}

function repoPath(env: Env, path: string): string {
  return `/repos/${encodeURIComponent(env.AI_MEMORY_OWNER)}/${encodeURIComponent(env.AI_MEMORY_REPO)}/contents/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

async function githubFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "meeting-memory-ingest",
      ...(init.headers || {}),
    },
  });
}

export async function getTextFile(env: Env, path: string): Promise<{ text: string; sha: string } | null> {
  const url = `${repoPath(env, path)}?ref=${encodeURIComponent(env.AI_MEMORY_BRANCH)}`;
  const response = await githubFetch(env, url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub read ${path} failed (${response.status}): ${await response.text()}`);
  const payload = (await response.json()) as ContentFile;
  if (!payload.sha || payload.encoding !== "base64" || !payload.content) {
    throw new Error(`GitHub read ${path} returned unsupported content payload`);
  }
  return { text: base64ToUtf8(payload.content), sha: payload.sha };
}

export async function putTextFile(
  env: Env,
  path: string,
  text: string,
  message: string,
  sha?: string,
): Promise<string> {
  const response = await githubFetch(env, repoPath(env, path), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(text),
      branch: env.AI_MEMORY_BRANCH,
      author: AI_MEMORY_AUTOMATION_IDENTITY,
      committer: AI_MEMORY_AUTOMATION_IDENTITY,
      ...(sha ? { sha } : {}),
    }),
  });
  if (response.status === 409 || response.status === 422) {
    throw new GitHubConflictError(`GitHub write conflict for ${path}: ${truncate(await response.text(), 600)}`);
  }
  if (!response.ok) throw new Error(`GitHub write ${path} failed (${response.status}): ${await response.text()}`);
  const payload = (await response.json()) as { content?: { sha?: string } };
  return payload.content?.sha || "";
}

export async function upsertTextFile(env: Env, path: string, text: string, message: string): Promise<void> {
  const current = await getTextFile(env, path);
  await putTextFile(env, path, text, message, current?.sha);
}

export async function deleteTextFile(env: Env, path: string, message: string): Promise<boolean> {
  const current = await getTextFile(env, path);
  if (!current) return false;
  const response = await githubFetch(env, repoPath(env, path), {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      sha: current.sha,
      branch: env.AI_MEMORY_BRANCH,
      author: AI_MEMORY_AUTOMATION_IDENTITY,
      committer: AI_MEMORY_AUTOMATION_IDENTITY,
    }),
  });
  if (response.status === 404) return false;
  if (response.status === 409 || response.status === 422) {
    throw new GitHubConflictError(`GitHub delete conflict for ${path}: ${truncate(await response.text(), 600)}`);
  }
  if (!response.ok) throw new Error(`GitHub delete ${path} failed (${response.status}): ${await response.text()}`);
  return true;
}

export function manifestPath(env: Env): string {
  return `${env.TRANSCRIPT_ROOT.replace(/\/$/, "")}/_manifest.json`;
}

export async function loadManifest(env: Env): Promise<{ manifest: Manifest; sha?: string }> {
  const file = await getTextFile(env, manifestPath(env));
  if (!file) {
    return { manifest: { version: 1, updatedAt: new Date(0).toISOString(), videos: {} } };
  }
  try {
    const parsed = JSON.parse(file.text) as Manifest;
    if (parsed.version !== 1 || !parsed.videos || typeof parsed.videos !== "object") {
      throw new Error("unsupported manifest shape");
    }
    return { manifest: parsed, sha: file.sha };
  } catch (error) {
    throw new Error(`Cannot parse ${manifestPath(env)}: ${errorMessage(error)}`);
  }
}

async function saveManifest(env: Env, manifest: Manifest, sha?: string, message = "chore(meetings): update ingest manifest") {
  manifest.updatedAt = new Date().toISOString();
  await putTextFile(env, manifestPath(env), `${JSON.stringify(manifest, null, 2)}\n`, message, sha);
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

export async function claimVideo(env: Env, video: VideoRecord): Promise<ClaimResult> {
  const { manifest, sha } = await loadManifest(env);
  const existing = manifest.videos[video.id];
  const now = Date.now();
  const leaseMs = parsePositiveInt(env.PROCESSING_LEASE_MINUTES, 90) * 60_000;
  const retryMs = parsePositiveInt(env.RETRY_FAILED_AFTER_MINUTES, 30) * 60_000;

  if (existing?.status === "completed") return { claimed: false, reason: "already completed" };

  const resolverCooldownUntil = youtubeResolverCooldownUntil(manifest, now);
  if (resolverCooldownUntil) {
    return { claimed: false, reason: `YouTube resolver cooldown is active until ${resolverCooldownUntil}` };
  }

  if (existing?.status === "processing" && existing.startedAt && now - Date.parse(existing.startedAt) < leaseMs) {
    return { claimed: false, reason: "processing lease is still active" };
  }
  if (existing?.status === "waiting" && existing.retryAfterAt && now < Date.parse(existing.retryAfterAt)) {
    return { claimed: false, reason: `waiting for retry window at ${existing.retryAfterAt}` };
  }
  if (existing?.status === "failed" && existing.failedAt && now - Date.parse(existing.failedAt) < retryMs) {
    return { claimed: false, reason: "failure retry cooldown is still active" };
  }

  const chunkSeconds = parsePositiveInt(env.TRANSCRIPTION_CHUNK_SECONDS, 2700);
  const durationSeconds = Math.max(1, Math.ceil(video.durationSeconds || existing?.durationSeconds || chunkSeconds));
  const totalChunks = chunkCount(durationSeconds, chunkSeconds);
  const completedChunks = normalizedCompletedChunks(totalChunks, existing?.completedChunks);
  const nextChunkIndex = nextPendingChunk(totalChunks, completedChunks);
  const attempts = (existing?.attempts || 0) + 1;

  const entry: ManifestEntry = {
    ...(existing || {}),
    status: "processing",
    title: video.title,
    youtubeUrl: `https://youtu.be/${video.id}`,
    attempts,
    startedAt: new Date().toISOString(),
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
  };
  manifest.videos[video.id] = entry;

  try {
    await saveManifest(env, manifest, sha, `chore(meetings): claim ${video.id}`);
    return { claimed: true, attempts, entry };
  } catch (error) {
    if (error instanceof GitHubConflictError) return { claimed: false, reason: "claim lost to another worker" };
    throw error;
  }
}

export async function recordChunkCompleted(env: Env, videoId: string, chunkIndex: number): Promise<ManifestEntry> {
  const { manifest, sha } = await loadManifest(env);
  const existing = manifest.videos[videoId];
  if (!existing || existing.status !== "processing") throw new Error(`video ${videoId} is not processing`);
  const totalChunks = existing.totalChunks || 1;
  if (chunkIndex < 0 || chunkIndex >= totalChunks) throw new Error(`invalid chunk index ${chunkIndex}/${totalChunks}`);
  const completedChunks = normalizedCompletedChunks(totalChunks, [...(existing.completedChunks || []), chunkIndex]);
  const entry: ManifestEntry = {
    ...existing,
    completedChunks,
    nextChunkIndex: nextPendingChunk(totalChunks, completedChunks),
  };
  manifest.videos[videoId] = entry;
  await saveManifest(env, manifest, sha, `chore(meetings): complete chunk ${videoId}#${chunkIndex}`);
  return entry;
}

export async function deferVideo(env: Env, video: VideoRecord, retryAfterSeconds: number, error: unknown): Promise<void> {
  const { manifest, sha } = await loadManifest(env);
  const existing = manifest.videos[video.id];
  const delaySeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  manifest.videos[video.id] = {
    ...(existing || {
      title: video.title,
      youtubeUrl: `https://youtu.be/${video.id}`,
      attempts: 1,
    }),
    status: "waiting",
    retryAfterAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    lastError: truncate(errorMessage(error), 1200),
    failedAt: undefined,
  } as ManifestEntry;
  await saveManifest(env, manifest, sha, `chore(meetings): defer ${video.id}`);
}

export async function makeRetryableNow(env: Env, videoId: string): Promise<boolean> {
  const { manifest, sha } = await loadManifest(env);
  const existing = manifest.videos[videoId];
  if (!existing || (existing.status !== "failed" && existing.status !== "waiting")) return false;
  manifest.videos[videoId] = {
    ...existing,
    failedAt: existing.status === "failed" ? new Date(0).toISOString() : existing.failedAt,
    retryAfterAt: existing.status === "waiting" ? new Date(0).toISOString() : existing.retryAfterAt,
  };
  await saveManifest(env, manifest, sha, `chore(meetings): allow retry ${videoId}`);
  return true;
}

export async function completeVideo(env: Env, video: VideoRecord, path: string): Promise<void> {
  const { manifest, sha } = await loadManifest(env);
  const existing = manifest.videos[video.id];
  manifest.videos[video.id] = {
    ...(existing || {
      title: video.title,
      youtubeUrl: `https://youtu.be/${video.id}`,
      attempts: 1,
    }),
    status: "completed",
    path,
    completedAt: new Date().toISOString(),
    failedAt: undefined,
    retryAfterAt: undefined,
    lastError: undefined,
    transcriptionModel: env.GROQ_TRANSCRIPTION_MODEL,
    summaryModel: env.SUMMARY_ENABLED === "true" ? env.GROQ_SUMMARY_MODEL : undefined,
  } as ManifestEntry;
  await saveManifest(env, manifest, sha, `chore(meetings): complete ${video.id}`);
}

export async function failVideo(env: Env, video: VideoRecord, error: unknown): Promise<void> {
  try {
    const { manifest, sha } = await loadManifest(env);
    const existing = manifest.videos[video.id];
    manifest.videos[video.id] = {
      ...(existing || {
        title: video.title,
        youtubeUrl: `https://youtu.be/${video.id}`,
        attempts: 1,
      }),
      status: "failed",
      failedAt: new Date().toISOString(),
      retryAfterAt: undefined,
      lastError: truncate(errorMessage(error), 1200),
    } as ManifestEntry;
    await saveManifest(env, manifest, sha, `chore(meetings): mark ${video.id} failed`);
  } catch (manifestError) {
    console.error("Could not record pipeline failure in manifest", manifestError);
  }
}

export async function resetVideo(env: Env, videoId: string): Promise<boolean> {
  const { manifest, sha } = await loadManifest(env);
  if (!manifest.videos[videoId]) return false;
  delete manifest.videos[videoId];
  await saveManifest(env, manifest, sha, `chore(meetings): reset ${videoId}`);
  return true;
}

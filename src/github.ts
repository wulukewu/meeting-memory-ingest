import type { Env, Manifest } from "./types";
import { base64ToUtf8, truncate, utf8ToBase64 } from "./util";

const API_ROOT = "https://api.github.com";
const AI_MEMORY_AUTOMATION_IDENTITY = {
  name: "wulukewu",
  email: "luke@ai-memory.local",
};

interface ContentFile {
  sha: string;
  content?: string;
  encoding?: string;
}

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

async function readBlobBySha(env: Env, sha: string): Promise<string> {
  const owner = encodeURIComponent(env.AI_MEMORY_OWNER);
  const repo = encodeURIComponent(env.AI_MEMORY_REPO);
  const response = await githubFetch(env, `/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`);
  if (!response.ok) throw new Error(`GitHub blob read failed (${response.status}): ${truncate(await response.text(), 600)}`);
  const payload = (await response.json()) as { content?: string; encoding?: string };
  if (payload.encoding !== "base64" || !payload.content) {
    throw new Error("GitHub blob returned unsupported content payload");
  }
  return base64ToUtf8(payload.content);
}

export async function getTextFile(env: Env, path: string): Promise<{ text: string; sha: string } | null> {
  const url = `${repoPath(env, path)}?ref=${encodeURIComponent(env.AI_MEMORY_BRANCH)}`;
  const response = await githubFetch(env, url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub read ${path} failed (${response.status}): ${truncate(await response.text(), 600)}`);
  const payload = (await response.json()) as ContentFile;
  if (!payload.sha) throw new Error(`GitHub read ${path} returned no blob SHA`);

  if (payload.encoding === "base64" && payload.content) {
    return { text: base64ToUtf8(payload.content), sha: payload.sha };
  }

  // GitHub Contents API stops returning inline base64 content for files >1 MiB.
  // Read the same blob through the Git Data API so one-time legacy migration can
  // recover large _work files without keeping runtime state in Git afterward.
  return { text: await readBlobBySha(env, payload.sha), sha: payload.sha };
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
  if (!response.ok) throw new Error(`GitHub write ${path} failed (${response.status}): ${truncate(await response.text(), 600)}`);
  const payload = (await response.json()) as { content?: { sha?: string } };
  return payload.content?.sha || "";
}

export async function upsertTextFile(env: Env, path: string, text: string, message: string): Promise<void> {
  const current = await getTextFile(env, path);
  if (current?.text === text) return;
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
  if (!response.ok) throw new Error(`GitHub delete ${path} failed (${response.status}): ${truncate(await response.text(), 600)}`);
  return true;
}

export async function publishFinalMarkdown(env: Env, path: string, markdown: string, videoId: string): Promise<void> {
  await upsertTextFile(env, path, markdown, `feat(meetings): ingest ${videoId}`);
}

export function legacyManifestPath(env: Env): string {
  return `${env.TRANSCRIPT_ROOT.replace(/\/$/, "")}/_manifest.json`;
}

export function legacyWorkPath(env: Env, videoId: string): string {
  return `${env.TRANSCRIPT_ROOT.replace(/\/$/, "")}/_work/${videoId}.json`;
}

export async function loadLegacyManifest(env: Env): Promise<Manifest | null> {
  const file = await getTextFile(env, legacyManifestPath(env));
  if (!file) return null;
  const parsed = JSON.parse(file.text) as Manifest;
  if (parsed.version !== 1 || !parsed.videos || typeof parsed.videos !== "object") {
    throw new Error("legacy ai-memory manifest has unsupported shape");
  }
  return parsed;
}

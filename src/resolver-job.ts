import type { Env, ManifestEntry } from "./types";
import { ensureStateSchema, getManifestEntry } from "./state";
import { parsePositiveInt } from "./util";

const RESOLVER_JOB_PREFIX = "resolver_job:";
const RESOLVER_JOB_VERSION = 1;

type StoredResolverJob = {
  version: typeof RESOLVER_JOB_VERSION;
  videoId: string;
  claimStartedAt: string;
  expiresAt: string;
};

export type ResolverJob = {
  videoId: string;
  transcriptionModel: string;
  startChunkIndex: number;
  chunkSeconds: number;
  expiresAt: string;
};

export function isResolverJobToken(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function resolverJobKey(token: string): string {
  return `${RESOLVER_JOB_PREFIX}${token}`;
}

function publicWorkerUrl(env: Env): string {
  return env.WORKER_PUBLIC_URL.replace(/\/$/, "");
}

export function resolverWorkerUrl(env: Env): string {
  return publicWorkerUrl(env);
}

export async function createResolverJobTicket(
  env: Env,
  videoId: string,
  entry: ManifestEntry,
): Promise<{ token: string; expiresAt: string }> {
  if (!entry.startedAt) throw new Error(`resolver claim for ${videoId} has no startedAt`);

  await ensureStateSchema(env);

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const leaseMinutes = parsePositiveInt(env.PROCESSING_LEASE_MINUTES, 90);
  const ttlMinutes = Math.max(30, leaseMinutes + 15);
  const expiresAt = new Date(now + ttlMinutes * 60_000).toISOString();
  const token = crypto.randomUUID();

  const stored: StoredResolverJob = {
    version: RESOLVER_JOB_VERSION,
    videoId,
    claimStartedAt: entry.startedAt,
    expiresAt,
  };

  const staleCutoff = new Date(now - 24 * 60 * 60_000).toISOString();
  await env.QUEUE_DB.batch([
    env.QUEUE_DB.prepare(
      "DELETE FROM runtime_meta WHERE key LIKE 'resolver_job:%' AND updated_at < ?",
    ).bind(staleCutoff),
    env.QUEUE_DB.prepare(
      "INSERT OR REPLACE INTO runtime_meta (key,value,updated_at) VALUES (?,?,?)",
    ).bind(resolverJobKey(token), JSON.stringify(stored), nowIso),
  ]);

  return { token, expiresAt };
}

export async function deleteResolverJobTicket(env: Env, token: string): Promise<void> {
  if (!isResolverJobToken(token)) return;
  await ensureStateSchema(env);
  await env.QUEUE_DB.prepare("DELETE FROM runtime_meta WHERE key = ?")
    .bind(resolverJobKey(token))
    .run();
}

export async function getResolverJob(
  env: Env,
  token: string,
  now = Date.now(),
): Promise<ResolverJob | undefined> {
  if (!isResolverJobToken(token)) return undefined;

  await ensureStateSchema(env);
  const row = await env.QUEUE_DB.prepare(
    "SELECT value FROM runtime_meta WHERE key = ?",
  ).bind(resolverJobKey(token)).first<{ value: string }>();
  if (!row) return undefined;

  let stored: StoredResolverJob;
  try {
    stored = JSON.parse(row.value) as StoredResolverJob;
  } catch {
    return undefined;
  }

  if (
    stored.version !== RESOLVER_JOB_VERSION ||
    !stored.videoId ||
    !stored.claimStartedAt ||
    !stored.expiresAt ||
    Date.parse(stored.expiresAt) <= now
  ) {
    return undefined;
  }

  const entry = await getManifestEntry(env, stored.videoId);
  if (
    !entry ||
    entry.status !== "processing" ||
    entry.startedAt !== stored.claimStartedAt
  ) {
    return undefined;
  }

  return {
    videoId: stored.videoId,
    transcriptionModel: entry.transcriptionModel || env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3",
    startChunkIndex: entry.nextChunkIndex || 0,
    chunkSeconds: entry.chunkSeconds || parsePositiveInt(env.TRANSCRIPTION_CHUNK_SECONDS, 2700),
    expiresAt: stored.expiresAt,
  };
}

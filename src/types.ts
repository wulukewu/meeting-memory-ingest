export interface FinalizeWorkflowParams {
  videoId: string;
  workflowId: string;
}

export interface Env {
  // Cloudflare bindings
  QUEUE_DB: D1Database;
  FINALIZE_WORKFLOW: Workflow<FinalizeWorkflowParams>;

  // Worker secrets
  GROQ_API_KEY: string;
  YOUTUBE_CLIENT_ID: string;
  YOUTUBE_CLIENT_SECRET: string;
  YOUTUBE_REFRESH_TOKEN: string;
  GITHUB_TOKEN: string;
  ADMIN_TOKEN: string;
  RESOLVER_GITHUB_TOKEN: string;

  // Wrangler / Dashboard vars
  YOUTUBE_PLAYLIST_ID: string;
  WORKER_PUBLIC_URL: string;
  RESOLVER_GITHUB_OWNER: string;
  RESOLVER_GITHUB_REPO: string;
  RESOLVER_GITHUB_WORKFLOW: string;
  AI_MEMORY_OWNER: string;
  AI_MEMORY_REPO: string;
  AI_MEMORY_BRANCH: string;
  TRANSCRIPT_ROOT: string;
  GROQ_TRANSCRIPTION_MODEL: string;
  GROQ_SUMMARY_MODEL: string;
  SUMMARY_ENABLED: string;
  MAX_ITEMS_PER_RUN: string;
  MAX_PLAYLIST_PAGES: string;
  PROCESSING_LEASE_MINUTES: string;
  RETRY_FAILED_AFTER_MINUTES: string;
  TRANSCRIPTION_CHUNK_SECONDS: string;
}

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

export type TriggerKind = "cron" | "manual" | "single";

export interface VideoRecord {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  playlistAddedAt?: string;
  privacyStatus: string;
  durationIso?: string;
  durationSeconds?: number;
  channelTitle?: string;
}

export interface TranscriptSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
  avgLogprob?: number;
  noSpeechProb?: number;
  compressionRatio?: number;
}

export interface TranscriptResult {
  text: string;
  language?: string;
  duration?: number;
  segments: TranscriptSegment[];
}

export interface StoredTranscriptChunk {
  version: 1;
  videoId: string;
  chunkIndex: number;
  offsetSeconds: number;
  transcript: TranscriptResult;
}

export interface StoredTranscriptWork {
  version: 1;
  videoId: string;
  chunks: Record<string, StoredTranscriptChunk>;
}

export interface ActionItem {
  owner?: string;
  task: string;
}

export interface TopicItem {
  timestamp?: string;
  topic: string;
}

export interface MeetingSummary {
  title: string;
  category: string;
  summary: string;
  decisions: string[];
  actionItems: ActionItem[];
  topics: TopicItem[];
  tags: string[];
}

export type ManifestStatus = "processing" | "waiting" | "finalizing" | "completed" | "failed";

export interface ManifestEntry {
  status: ManifestStatus;
  title: string;
  youtubeUrl: string;
  attempts: number;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  retryAfterAt?: string;
  path?: string;
  lastError?: string;
  transcriptionModel?: string;
  summaryModel?: string;
  durationSeconds?: number;
  chunkSeconds?: number;
  totalChunks?: number;
  nextChunkIndex?: number;
  completedChunks?: number[];
  finalizationId?: string;
  updatedAt?: string;
}

export interface Manifest {
  version: 1;
  updatedAt: string;
  videos: Record<string, ManifestEntry>;
}

export interface ClaimResult {
  claimed: boolean;
  reason?: string;
  attempts?: number;
  entry?: ManifestEntry;
}

export interface RunResult {
  trigger: TriggerKind;
  scanned: number;
  eligible: number;
  claimed: number;
  dispatched: string[];
  completed: string[];
  skipped: Array<{ videoId: string; reason: string }>;
  failed: Array<{ videoId: string; error: string }>;
}

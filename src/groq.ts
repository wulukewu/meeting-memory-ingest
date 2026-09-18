import type { Env, MeetingSummary, TranscriptResult, TranscriptSegment, VideoRecord } from "./types";
import { toTaiwanTraditional } from "./traditional";
import {
  errorMessage,
  formatTimestamp,
  inferCategoryFromTitle,
  parseBoolean,
  sleep,
  splitByApproxChars,
  truncate,
} from "./util";

const GROQ_ROOT = "https://api.groq.com/openai/v1";

export class GroqRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(`[groq-retry-after=${Math.max(1, Math.ceil(retryAfterSeconds))}s] ${message}`);
    this.name = "GroqRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function parseRetryAfterSeconds(response: Response, body: string): number {
  const header = Number.parseFloat(response.headers.get("retry-after") || "");
  if (Number.isFinite(header) && header > 0) return header;

  const match = body.match(/try again in\s+(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?/i);
  if (match) {
    const minutes = Number.parseFloat(match[1] || "0");
    const seconds = Number.parseFloat(match[2] || "0");
    const total = minutes * 60 + seconds;
    if (total > 0) return total;
  }
  return 30 * 60;
}

async function groqFetch(env: Env, path: string, init: RequestInit, maxAttempts = 4): Promise<Response> {
  let lastError = "unknown Groq error";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`${GROQ_ROOT}/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${env.GROQ_API_KEY}`,
        ...(init.headers || {}),
      },
    });
    if (response.ok) return response;

    const body = await response.text();
    lastError = `Groq ${path} failed (${response.status}): ${truncate(body, 1200)}`;
    if (response.status !== 429) throw new Error(lastError);

    const retrySeconds = parseRetryAfterSeconds(response, body);
    if (attempt === maxAttempts) throw new GroqRateLimitError(lastError, retrySeconds);
    await sleep(Math.min(Math.max(retrySeconds, 1), 75) * 1000);
  }
  throw new Error(lastError);
}

function normalizeTranscript(raw: {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    id?: number;
    start?: number;
    end?: number;
    text?: string;
    avg_logprob?: number;
    no_speech_prob?: number;
    compression_ratio?: number;
  }>;
}): TranscriptResult {
  const rawSegments = raw.segments || [];
  const segments: TranscriptSegment[] = rawSegments
    .filter((segment) => typeof segment.start === "number" && typeof segment.end === "number" && segment.text)
    .map((segment) => ({
      id: segment.id,
      start: segment.start || 0,
      end: segment.end || 0,
      text: toTaiwanTraditional((segment.text || "").trim()),
      avgLogprob: segment.avg_logprob,
      noSpeechProb: segment.no_speech_prob,
      compressionRatio: segment.compression_ratio,
    }))
    .filter((segment) => segment.noSpeechProb == null || segment.noSpeechProb < 0.8);

  if (!raw.text && rawSegments.length === 0) throw new Error("Groq returned an empty transcript");
  return {
    text:
      rawSegments.length > 0
        ? segments.map((segment) => segment.text).join(" ")
        : toTaiwanTraditional(raw.text || ""),
    language: raw.language,
    duration: raw.duration,
    segments,
  };
}

export async function transcribeAudioUrl(
  env: Env,
  audioUrl: string,
  _video: VideoRecord,
): Promise<TranscriptResult> {
  const form = new FormData();
  form.set("url", audioUrl);
  form.set("model", env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3");
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.set("language", "zh");
  form.set("temperature", "0");

  const response = await groqFetch(env, "audio/transcriptions", { method: "POST", body: form }, 3);
  return normalizeTranscript(await response.json());
}

export async function transcribeAudioUpload(
  env: Env,
  body: BodyInit,
  contentType: string,
): Promise<TranscriptResult> {
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new Error("resolver transcription upload must use multipart/form-data");
  }

  const response = await groqFetch(
    env,
    "audio/transcriptions",
    {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    },
    1,
  );
  return normalizeTranscript(await response.json());
}

export interface PartialSummary {
  summary: string;
  decisions: string[];
  actionItems: Array<{ owner?: string; task: string }>;
  topics: Array<{ timestamp?: string; topic: string }>;
  tags: string[];
}

async function chatJson<T>(
  env: Env,
  instructions: string,
  user: string,
  maxTokens = 1600,
): Promise<T> {
  const model = env.SUMMARY_MODEL || "@cf/zai-org/glm-4.7-flash";
  const payload = (await env.AI.run(model, {
    temperature: 0.1,
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: `${instructions}\n\n${user}`,
      },
    ],
  })) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    response?: string;
  };

  const content = payload.choices?.[0]?.message?.content || payload.response;
  if (!content) throw new Error(`Workers AI summary model ${model} returned no content`);
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(
      `Workers AI summary JSON parse failed: ${errorMessage(error)}; output=${truncate(content, 800)}`,
    );
  }
}

function transcriptLines(transcript: TranscriptResult): string[] {
  if (transcript.segments.length > 0) {
    return transcript.segments.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`);
  }
  return transcript.text.split(/\n+/).filter(Boolean);
}

function normalizePartial(value: Partial<PartialSummary>): PartialSummary {
  return {
    summary: typeof value.summary === "string" ? toTaiwanTraditional(value.summary) : "",
    decisions: Array.isArray(value.decisions)
      ? value.decisions.filter((x): x is string => typeof x === "string").map(toTaiwanTraditional)
      : [],
    actionItems: Array.isArray(value.actionItems)
      ? value.actionItems
          .filter((x): x is { owner?: string; task: string } => Boolean(x && typeof x.task === "string"))
          .map((x) => ({
            owner: typeof x.owner === "string" ? toTaiwanTraditional(x.owner) : undefined,
            task: toTaiwanTraditional(x.task),
          }))
      : [],
    topics: Array.isArray(value.topics)
      ? value.topics
          .filter((x): x is { timestamp?: string; topic: string } => Boolean(x && typeof x.topic === "string"))
          .map((x) => ({ timestamp: typeof x.timestamp === "string" ? x.timestamp : undefined, topic: toTaiwanTraditional(x.topic) }))
      : [],
    tags: Array.isArray(value.tags)
      ? value.tags.filter((x): x is string => typeof x === "string").map(toTaiwanTraditional)
      : [],
  };
}

export function summaryInputChunks(transcript: TranscriptResult): string[] {
  return splitByApproxChars(transcriptLines(transcript), 5200);
}

export function fallbackMeetingSummary(video: VideoRecord): MeetingSummary {
  const category = inferCategoryFromTitle(video.title);
  return {
    title: toTaiwanTraditional(video.title),
    category,
    summary: "",
    decisions: [],
    actionItems: [],
    topics: [],
    tags: ["meeting", category],
  };
}

export async function summarizeTranscriptChunk(
  env: Env,
  video: VideoRecord,
  chunk: string,
  index: number,
  total: number,
): Promise<PartialSummary> {
  const partial = await chatJson<PartialSummary>(
    env,
    [
      "你正在整理會議逐字稿。只輸出有效 JSON，不要 Markdown。",
      "請以繁體中文為主；原本就是英文的技術名詞、人名、產品名、程式名稱可保留英文，不要強制翻譯。",
      "不要把不確定的內容補猜成事實。保留技術名詞、人名與時間戳。",
      "只有逐字稿中明確表達為決定或待辦的內容，才能列入 decisions/actionItems；討論中的可能性、建議與探索不要升格成待辦。",
      "JSON keys 必須是 summary, decisions, actionItems, topics, tags。",
      "actionItems 元素格式 {owner?: string, task: string}；topics 元素格式 {timestamp?: string, topic: string}。",
    ].join("\n"),
    `影片標題：${video.title}\n這是第 ${index + 1}/${total} 段逐字稿：\n\n${chunk}`,
    1400,
  );
  return normalizePartial(partial);
}

export async function combineMeetingSummaries(
  env: Env,
  video: VideoRecord,
  partials: PartialSummary[],
): Promise<MeetingSummary> {
  const fallbackCategory = inferCategoryFromTitle(video.title);
  const final = await chatJson<MeetingSummary>(
    env,
    [
      "你在將多段會議摘要合併成可長期查閱的會議索引。只輸出有效 JSON，不要 Markdown。",
      "請以繁體中文為主；原本就是英文的技術名詞、人名、產品名、程式名稱可保留英文，不要強制翻譯。",
      "避免重複；不要創造逐字稿中沒有的決定、分工或姓名。",
      "只有明確承諾、指派或確認的事項才保留在 decisions/actionItems。",
      "category 用簡短 kebab-case；若標題明顯是 campus-agent/資工專題、演算法、MCL，優先使用 campus-agent、algorithm、mcl。",
      "JSON keys 必須是 title, category, summary, decisions, actionItems, topics, tags。",
    ].join("\n"),
    `原始影片標題：${video.title}\n預設分類：${fallbackCategory}\n\n分段摘要：\n${JSON.stringify(partials)}`,
    2200,
  );

  return {
    title:
      typeof final.title === "string" && final.title.trim()
        ? toTaiwanTraditional(final.title.trim())
        : toTaiwanTraditional(video.title),
    category: typeof final.category === "string" && final.category.trim() ? final.category.trim() : fallbackCategory,
    summary:
      typeof final.summary === "string"
        ? toTaiwanTraditional(final.summary.trim())
        : toTaiwanTraditional(partials.map((x) => x.summary).join("\n\n")),
    decisions: Array.isArray(final.decisions)
      ? final.decisions.filter((x): x is string => typeof x === "string").map(toTaiwanTraditional)
      : [],
    actionItems: Array.isArray(final.actionItems)
      ? final.actionItems
          .filter((x): x is { owner?: string; task: string } => Boolean(x && typeof x.task === "string"))
          .map((x) => ({
            owner: typeof x.owner === "string" ? toTaiwanTraditional(x.owner) : undefined,
            task: toTaiwanTraditional(x.task),
          }))
      : [],
    topics: Array.isArray(final.topics)
      ? final.topics
          .filter((x): x is { timestamp?: string; topic: string } => Boolean(x && typeof x.topic === "string"))
          .map((x) => ({ timestamp: typeof x.timestamp === "string" ? x.timestamp : undefined, topic: toTaiwanTraditional(x.topic) }))
      : [],
    tags: Array.isArray(final.tags)
      ? final.tags.filter((x): x is string => typeof x === "string").map(toTaiwanTraditional)
      : ["meeting", fallbackCategory],
  };
}

export async function summarizeMeeting(
  env: Env,
  video: VideoRecord,
  transcript: TranscriptResult,
): Promise<MeetingSummary> {
  if (!parseBoolean(env.SUMMARY_ENABLED, true)) return fallbackMeetingSummary(video);
  const chunks = summaryInputChunks(transcript);
  const partials: PartialSummary[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    partials.push(await summarizeTranscriptChunk(env, video, chunks[i], i, chunks.length));
  }
  return combineMeetingSummaries(env, video, partials);
}

import type { Env, MeetingSummary, TranscriptResult, TranscriptSegment, VideoRecord } from "./types";
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
    if (response.status !== 429 || attempt === maxAttempts) throw new Error(lastError);

    const retryHeader = response.headers.get("retry-after");
    const retrySeconds = retryHeader ? Number.parseFloat(retryHeader) : 10 * attempt;
    await sleep(Math.min(Math.max(retrySeconds, 1), 75) * 1000);
  }
  throw new Error(lastError);
}

export async function transcribeAudioUrl(
  env: Env,
  audioUrl: string,
  video: VideoRecord,
): Promise<TranscriptResult> {
  const form = new FormData();
  form.set("url", audioUrl);
  form.set("model", env.GROQ_TRANSCRIPTION_MODEL || "whisper-large-v3");
  form.set("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.set(
    "prompt",
    truncate(`繁體中文會議，可能混用英文技術名詞。保留英文技術詞、程式名稱與人名原文。影片標題：${video.title}`, 180),
  );

  const response = await groqFetch(env, "audio/transcriptions", { method: "POST", body: form }, 3);
  const raw = (await response.json()) as {
    text?: string;
    language?: string;
    duration?: number;
    segments?: Array<{ id?: number; start?: number; end?: number; text?: string }>;
  };

  const segments: TranscriptSegment[] = (raw.segments || [])
    .filter((segment) => typeof segment.start === "number" && typeof segment.end === "number" && segment.text)
    .map((segment) => ({
      id: segment.id,
      start: segment.start || 0,
      end: segment.end || 0,
      text: (segment.text || "").trim(),
    }));

  if (!raw.text && segments.length === 0) throw new Error("Groq returned an empty transcript");
  return {
    text: raw.text || segments.map((segment) => segment.text).join(" "),
    language: raw.language,
    duration: raw.duration,
    segments,
  };
}

interface PartialSummary {
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
  const body = {
    model: env.GROQ_SUMMARY_MODEL || "openai/gpt-oss-120b",
    temperature: 0.1,
    max_completion_tokens: maxTokens,
    reasoning_effort: "low",
    reasoning_format: "hidden",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: `${instructions}\n\n${user}`,
      },
    ],
  };
  const response = await groqFetch(env, "chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq summary model returned no content");
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(`Groq summary JSON parse failed: ${errorMessage(error)}; output=${truncate(content, 800)}`);
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
    summary: typeof value.summary === "string" ? value.summary : "",
    decisions: Array.isArray(value.decisions) ? value.decisions.filter((x): x is string => typeof x === "string") : [],
    actionItems: Array.isArray(value.actionItems)
      ? value.actionItems
          .filter((x): x is { owner?: string; task: string } => Boolean(x && typeof x.task === "string"))
          .map((x) => ({ owner: typeof x.owner === "string" ? x.owner : undefined, task: x.task }))
      : [],
    topics: Array.isArray(value.topics)
      ? value.topics
          .filter((x): x is { timestamp?: string; topic: string } => Boolean(x && typeof x.topic === "string"))
          .map((x) => ({ timestamp: typeof x.timestamp === "string" ? x.timestamp : undefined, topic: x.topic }))
      : [],
    tags: Array.isArray(value.tags) ? value.tags.filter((x): x is string => typeof x === "string") : [],
  };
}

export async function summarizeMeeting(
  env: Env,
  video: VideoRecord,
  transcript: TranscriptResult,
): Promise<MeetingSummary> {
  const fallbackCategory = inferCategoryFromTitle(video.title);
  if (!parseBoolean(env.SUMMARY_ENABLED, true)) {
    return {
      title: video.title,
      category: fallbackCategory,
      summary: "",
      decisions: [],
      actionItems: [],
      topics: [],
      tags: ["meeting", fallbackCategory],
    };
  }

  // Keep each free-tier request comfortably below the 8K TPM ceiling. The
  // retry logic above honors Groq's Retry-After header between chunks.
  const chunks = splitByApproxChars(transcriptLines(transcript), 5200);
  const partials: PartialSummary[] = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const partial = await chatJson<PartialSummary>(
      env,
      [
        "你正在整理會議逐字稿。只輸出有效 JSON，不要 Markdown。",
        "不要把不確定的內容補猜成事實。保留技術名詞、人名與時間戳。",
        "JSON keys 必須是 summary, decisions, actionItems, topics, tags。",
        "actionItems 元素格式 {owner?: string, task: string}；topics 元素格式 {timestamp?: string, topic: string}。",
      ].join("\n"),
      `影片標題：${video.title}\n這是第 ${i + 1}/${chunks.length} 段逐字稿：\n\n${chunks[i]}`,
      1400,
    );
    partials.push(normalizePartial(partial));
  }

  const final = await chatJson<MeetingSummary>(
    env,
    [
      "你在將多段會議摘要合併成可長期查閱的會議索引。只輸出有效 JSON，不要 Markdown。",
      "避免重複；不要創造逐字稿中沒有的決定、分工或姓名。",
      "category 用簡短 kebab-case；若標題明顯是 campus-agent/資工專題、演算法、MCL，優先使用 campus-agent、algorithm、mcl。",
      "JSON keys 必須是 title, category, summary, decisions, actionItems, topics, tags。",
    ].join("\n"),
    `原始影片標題：${video.title}\n預設分類：${fallbackCategory}\n\n分段摘要：\n${JSON.stringify(partials)}`,
    2200,
  );

  return {
    title: typeof final.title === "string" && final.title.trim() ? final.title.trim() : video.title,
    category: typeof final.category === "string" && final.category.trim() ? final.category.trim() : fallbackCategory,
    summary: typeof final.summary === "string" ? final.summary.trim() : partials.map((x) => x.summary).join("\n\n"),
    decisions: Array.isArray(final.decisions) ? final.decisions.filter((x): x is string => typeof x === "string") : [],
    actionItems: Array.isArray(final.actionItems)
      ? final.actionItems.filter((x): x is { owner?: string; task: string } => Boolean(x && typeof x.task === "string"))
      : [],
    topics: Array.isArray(final.topics)
      ? final.topics.filter((x): x is { timestamp?: string; topic: string } => Boolean(x && typeof x.topic === "string"))
      : [],
    tags: Array.isArray(final.tags) ? final.tags.filter((x): x is string => typeof x === "string") : ["meeting", fallbackCategory],
  };
}

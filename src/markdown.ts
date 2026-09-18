import type { Env, MeetingSummary, TranscriptResult, VideoRecord } from "./types";
import { formatTimestamp, isoDate, safePathSegment, slugify } from "./util";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function listOrNone(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- （無明確紀錄）";
}

function renderActionItems(summary: MeetingSummary): string {
  if (!summary.actionItems.length) return "- （無明確紀錄）";
  return summary.actionItems
    .map((item) => `- ${item.owner ? `**${item.owner}**：` : ""}${item.task}`)
    .join("\n");
}

function renderTopics(summary: MeetingSummary): string {
  if (!summary.topics.length) return "- （無明確紀錄）";
  return summary.topics
    .map((item) => `- ${item.timestamp ? `${item.timestamp} — ` : ""}${item.topic}`)
    .join("\n");
}

function renderTranscript(transcript: TranscriptResult): string {
  if (transcript.segments.length > 0) {
    return transcript.segments.map((segment) => `[${formatTimestamp(segment.start)}] ${segment.text}`).join("\n\n");
  }
  return transcript.text.trim();
}

export function buildTranscriptPath(env: Env, video: VideoRecord, summary: MeetingSummary): string {
  const category = safePathSegment(summary.category || "general");
  const date = isoDate(video.publishedAt);
  const titleSlug = slugify(summary.title || video.title, "meeting").slice(0, 48);
  return `${env.TRANSCRIPT_ROOT.replace(/\/$/, "")}/${category}/${date}-${titleSlug}-${video.id}.md`;
}

export function renderMeetingMarkdown(
  env: Env,
  video: VideoRecord,
  transcript: TranscriptResult,
  summary: MeetingSummary,
): string {
  const tags = [...new Set(["meeting", "transcript", ...summary.tags])].map((tag) => safePathSegment(tag, "meeting"));
  const duration = transcript.duration || video.durationSeconds;

  return `---
type: meeting-transcript
source: youtube
youtube_id: ${yamlString(video.id)}
youtube_url: ${yamlString(`https://youtu.be/${video.id}`)}
video_title: ${yamlString(video.title)}
date: ${yamlString(isoDate(video.publishedAt))}
privacy_at_ingest: ${yamlString(video.privacyStatus)}
category: ${yamlString(safePathSegment(summary.category || "general"))}
transcription_model: ${yamlString(env.GROQ_TRANSCRIPTION_MODEL)}
summary_model: ${yamlString(env.SUMMARY_ENABLED === "true" ? env.SUMMARY_MODEL : "disabled")}
${duration != null ? `duration_seconds: ${Math.round(duration)}\n` : ""}tags: [${tags.map(yamlString).join(", ")}]
---

# ${summary.title || video.title}

> 來源：YouTube（${video.privacyStatus} at ingest）｜[原始影片](https://youtu.be/${video.id})  
> 逐字稿由 \`${env.GROQ_TRANSCRIPTION_MODEL}\` 自動產生；AI 摘要可能有誤，重要決定以逐字稿與原始錄音為準。

## Summary

${summary.summary || "（未產生摘要）"}

## Decisions

${listOrNone(summary.decisions)}

## Action Items

${renderActionItems(summary)}

## Topics

${renderTopics(summary)}

## Transcript

${renderTranscript(transcript)}
`;
}

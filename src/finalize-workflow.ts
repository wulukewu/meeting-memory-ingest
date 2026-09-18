import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import type {
  Env,
  FinalizeWorkflowParams,
  MeetingSummary,
  TranscriptResult,
} from "./types";
import type { PartialSummary } from "./groq";
import { mergeTranscriptChunks } from "./chunks";
import {
  combineMeetingSummaries,
  fallbackMeetingSummary,
  summarizeTranscriptChunk,
  summaryInputChunks,
} from "./groq";
import { publishFinalMarkdown } from "./github";
import { buildTranscriptPath, renderMeetingMarkdown } from "./markdown";
import { completeVideo, failVideoById, getManifestEntry } from "./state";
import { cleanupVideoWork, getStoredChunk, mergedObjectKey, putMergedTranscript, readJsonObject } from "./work-store";
import { getVideo, getYouTubeAccessToken } from "./youtube";
import { parseBoolean } from "./util";

const SUMMARY_STEP_OPTIONS = {
  retries: { limit: 8, delay: "1 minute" as const, backoff: "linear" as const },
  timeout: "10 minutes" as const,
} as const;

const PUBLISH_STEP_OPTIONS = {
  retries: { limit: 5, delay: "10 seconds" as const, backoff: "linear" as const },
  timeout: "5 minutes" as const,
} as const;

function summaryInputKey(videoId: string, index: number): string {
  return `work/${videoId}/summary-input-${String(index).padStart(4, "0")}.txt`;
}

export class FinalizeMeetingWorkflow extends WorkflowEntrypoint<Env, FinalizeWorkflowParams> {
  async run(event: WorkflowEvent<FinalizeWorkflowParams>, step: WorkflowStep) {
    const videoId = event.payload.videoId;

    try {
      const prepared = await step.do("prepare merged transcript", PUBLISH_STEP_OPTIONS, async () => {
        const entry = await getManifestEntry(this.env, videoId);
        if (!entry) throw new Error(`missing D1 state for ${videoId}`);
        if (entry.status === "completed" && entry.path) return { alreadyCompleted: true, path: entry.path, summaryParts: 0 };

        const totalChunks = entry.totalChunks || 1;
        const chunks = [];
        for (let index = 0; index < totalChunks; index += 1) {
          const chunk = await getStoredChunk(this.env, videoId, index);
          if (!chunk) throw new Error(`transcript chunk ${index}/${totalChunks} is missing for ${videoId}`);
          chunks.push(chunk);
        }

        const transcript = mergeTranscriptChunks(chunks, entry.durationSeconds);
        await putMergedTranscript(this.env, videoId, transcript);

        let summaryParts = 0;
        if (parseBoolean(this.env.SUMMARY_ENABLED, true)) {
          const inputs = summaryInputChunks(transcript);
          summaryParts = inputs.length;
          await Promise.all(
            inputs.map((input, index) =>
              this.env.TRANSCRIPT_WORK.put(summaryInputKey(videoId, index), input, {
                httpMetadata: { contentType: "text/plain; charset=utf-8" },
                customMetadata: { videoId, kind: "summary-input", index: String(index) },
              }),
            ),
          );
        }

        return { alreadyCompleted: false, path: "", summaryParts };
      });

      if (prepared.alreadyCompleted) return { videoId, status: "completed", path: prepared.path };

      const video = await step.do("load video metadata", PUBLISH_STEP_OPTIONS, async () => {
        const accessToken = await getYouTubeAccessToken(this.env);
        return getVideo(this.env, accessToken, videoId);
      });

      const partials: PartialSummary[] = [];
      if (parseBoolean(this.env.SUMMARY_ENABLED, true)) {
        for (let index = 0; index < prepared.summaryParts; index += 1) {
          const partial = await step.do(
            `summarize transcript part ${index + 1}`,
            SUMMARY_STEP_OPTIONS,
            async () => {
              const object = await this.env.TRANSCRIPT_WORK.get(summaryInputKey(videoId, index));
              if (!object) throw new Error(`missing summary input ${index} for ${videoId}`);
              return summarizeTranscriptChunk(
                this.env,
                video,
                await object.text(),
                index,
                prepared.summaryParts,
              );
            },
          );
          partials.push(partial);
        }
      }

      const summary: MeetingSummary = parseBoolean(this.env.SUMMARY_ENABLED, true)
        ? await step.do("combine meeting summary", SUMMARY_STEP_OPTIONS, async () =>
            combineMeetingSummaries(this.env, video, partials),
          )
        : fallbackMeetingSummary(video);

      const path = await step.do("publish durable meeting markdown", PUBLISH_STEP_OPTIONS, async () => {
        const transcript = await readJsonObject<TranscriptResult>(this.env, mergedObjectKey(videoId));
        const outputPath = buildTranscriptPath(this.env, video, summary);
        const markdown = renderMeetingMarkdown(this.env, video, transcript, summary);
        await publishFinalMarkdown(this.env, outputPath, markdown, videoId);
        return outputPath;
      });

      await step.do("mark meeting completed", PUBLISH_STEP_OPTIONS, async () => {
        await completeVideo(this.env, video, path);
      });

      await step.do("cleanup temporary R2 work", PUBLISH_STEP_OPTIONS, async () => {
        try {
          await cleanupVideoWork(this.env, videoId);
        } catch (error) {
          console.error("Meeting is completed but temporary R2 cleanup failed", videoId, error);
        }
      });

      return { videoId, status: "completed", path };
    } catch (error) {
      await failVideoById(this.env, videoId, error);
      throw error;
    }
  }
}

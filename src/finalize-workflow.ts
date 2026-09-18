import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import type { Env, FinalizeWorkflowParams, MeetingSummary } from "./types";
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
import {
  cleanupVideoWork,
  getStoredChunks,
  getSummaryInput,
  getSummaryOutputs,
  putSummaryInputs,
  putSummaryOutput,
} from "./work-store";
import { getVideo, getYouTubeAccessToken } from "./youtube";
import { parseBoolean } from "./util";

const SUMMARY_STEP_OPTIONS = {
  retries: { limit: 12, delay: "1 minute" as const, backoff: "linear" as const },
  timeout: "2 minutes" as const,
} as const;

const PUBLISH_STEP_OPTIONS = {
  retries: { limit: 5, delay: "10 seconds" as const, backoff: "linear" as const },
  timeout: "5 minutes" as const,
} as const;

export class FinalizeMeetingWorkflow extends WorkflowEntrypoint<Env, FinalizeWorkflowParams> {
  async run(event: WorkflowEvent<FinalizeWorkflowParams>, step: WorkflowStep) {
    const { videoId, workflowId } = event.payload;

    try {
      const prepared = await step.do("prepare summary inputs", PUBLISH_STEP_OPTIONS, async () => {
        const entry = await getManifestEntry(this.env, videoId);
        if (!entry) throw new Error(`missing D1 state for ${videoId}`);
        if (entry.status === "completed" && entry.path) {
          return { alreadyCompleted: true, path: entry.path, summaryParts: 0 };
        }
        if (entry.finalizationId !== workflowId) {
          throw new Error(`finalization ${workflowId} no longer owns ${videoId}`);
        }

        const transcript = mergeTranscriptChunks(
          await getStoredChunks(this.env, videoId, entry.totalChunks || 1),
          entry.durationSeconds,
        );

        let summaryParts = 0;
        if (parseBoolean(this.env.SUMMARY_ENABLED, true)) {
          const inputs = summaryInputChunks(transcript);
          summaryParts = inputs.length;
          await putSummaryInputs(this.env, videoId, inputs);
        }

        return { alreadyCompleted: false, path: "", summaryParts };
      });

      if (prepared.alreadyCompleted) {
        return { videoId, status: "completed", path: prepared.path };
      }

      const video = await step.do("load video metadata", PUBLISH_STEP_OPTIONS, async () => {
        const accessToken = await getYouTubeAccessToken(this.env);
        return getVideo(this.env, accessToken, videoId);
      });

      if (parseBoolean(this.env.SUMMARY_ENABLED, true)) {
        for (let index = 0; index < prepared.summaryParts; index += 1) {
          const input = await step.do(
            `load summary input ${index + 1}`,
            PUBLISH_STEP_OPTIONS,
            async () => getSummaryInput(this.env, videoId, index),
          );

          const partial = await step.do(
            `summarize transcript part ${index + 1}`,
            SUMMARY_STEP_OPTIONS,
            async () =>
              summarizeTranscriptChunk(
                this.env,
                video,
                input,
                index,
                prepared.summaryParts,
              ),
          );

          await step.do(
            `checkpoint summary part ${index + 1}`,
            PUBLISH_STEP_OPTIONS,
            async () => putSummaryOutput(this.env, videoId, index, partial),
          );
        }
      }

      const summary: MeetingSummary = parseBoolean(this.env.SUMMARY_ENABLED, true)
        ? await step.do("combine meeting summary", SUMMARY_STEP_OPTIONS, async () => {
            const partials = await getSummaryOutputs(this.env, videoId, prepared.summaryParts);
            return combineMeetingSummaries(this.env, video, partials);
          })
        : fallbackMeetingSummary(video);

      const path = await step.do("publish durable meeting markdown", PUBLISH_STEP_OPTIONS, async () => {
        const entry = await getManifestEntry(this.env, videoId);
        if (!entry) throw new Error(`missing D1 state for ${videoId}`);
        if (entry.finalizationId !== workflowId) {
          throw new Error(`finalization ${workflowId} no longer owns ${videoId}`);
        }

        const transcript = mergeTranscriptChunks(
          await getStoredChunks(this.env, videoId, entry.totalChunks || 1),
          entry.durationSeconds,
        );
        const outputPath = buildTranscriptPath(this.env, video, summary);
        const markdown = renderMeetingMarkdown(this.env, video, transcript, summary);
        await publishFinalMarkdown(this.env, outputPath, markdown, videoId);
        return outputPath;
      });

      await step.do("mark meeting completed", PUBLISH_STEP_OPTIONS, async () => {
        await completeVideo(this.env, video, path, workflowId);
      });

      await step.do("cleanup temporary D1 work", PUBLISH_STEP_OPTIONS, async () => {
        try {
          await cleanupVideoWork(this.env, videoId);
        } catch (error) {
          console.error("Meeting is completed but temporary D1 cleanup failed", videoId, error);
        }
      });

      return { videoId, status: "completed", path };
    } catch (error) {
      await failVideoById(this.env, videoId, error, workflowId);
      throw error;
    }
  }
}

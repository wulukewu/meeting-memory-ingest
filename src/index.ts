import type { Env, ScheduledController, WaitUntilContext } from "./types";
import { handleDashboardRequest } from "./dashboard";
import { loadManifest, makeRetryableNow } from "./github";
import { handleResolverCallback, handleResolverTranscription, runPlaylist, runSingleVideo } from "./pipeline";
import { jsonResponse } from "./util";

const PIPELINE_VERSION = "resumable-chunks-v1+dashboard-v1";

function isAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get("authorization");
  return Boolean(env.ADMIN_TOKEN && auth === `Bearer ${env.ADMIN_TOKEN}`);
}

function configStatus(env: Env) {
  const requiredSecrets = [
    "GROQ_API_KEY",
    "YOUTUBE_CLIENT_ID",
    "YOUTUBE_CLIENT_SECRET",
    "YOUTUBE_REFRESH_TOKEN",
    "GITHUB_TOKEN",
    "ADMIN_TOKEN",
    "RESOLVER_GITHUB_TOKEN",
  ] as const;
  const missingSecrets = requiredSecrets.filter((key) => !env[key]);
  const missingVars = [
    ...(env.YOUTUBE_PLAYLIST_ID ? [] : ["YOUTUBE_PLAYLIST_ID"]),
    ...(env.WORKER_PUBLIC_URL ? [] : ["WORKER_PUBLIC_URL"]),
  ];
  return { configured: missingSecrets.length === 0 && missingVars.length === 0, missingSecrets, missingVars };
}

function configError(env: Env): Response | null {
  const status = configStatus(env);
  return status.configured ? null : jsonResponse({ error: "service is not fully configured", ...status }, 503);
}

async function handleFetch(request: Request, env: Env, ctx: WaitUntilContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true, service: "meeting-memory-ingest", pipelineVersion: PIPELINE_VERSION, ...configStatus(env) });
  }

  const dashboard = await handleDashboardRequest(request, env);
  if (dashboard) return dashboard;

  if (!isAdmin(request, env)) return jsonResponse({ error: "unauthorized" }, 401);

  if (request.method === "GET" && url.pathname === "/status") {
    const { manifest } = await loadManifest(env);
    const entries = Object.entries(manifest.videos)
      .sort(([, a], [, b]) => Date.parse(b.completedAt || b.failedAt || b.startedAt || "1970-01-01") - Date.parse(a.completedAt || a.failedAt || a.startedAt || "1970-01-01"))
      .slice(0, 25)
      .map(([videoId, value]) => ({ videoId, ...value }));
    return jsonResponse({ pipelineVersion: PIPELINE_VERSION, ...configStatus(env), manifestUpdatedAt: manifest.updatedAt, recent: entries });
  }

  const notConfigured = configError(env);
  if (notConfigured) return notConfigured;

  if (request.method === "POST" && url.pathname === "/resolver/transcribe") {
    const videoId = request.headers.get("x-video-id")?.trim() || "";
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return jsonResponse({ error: "invalid or missing x-video-id" }, 400);
    const chunkIndex = Number.parseInt(request.headers.get("x-chunk-index") || "0", 10);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) return jsonResponse({ error: "invalid x-chunk-index" }, 400);
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
      return jsonResponse({ error: "resolver transcription upload must use multipart/form-data" }, 415);
    }
    if (!request.body) return jsonResponse({ error: "missing transcription upload body" }, 400);

    const result = await handleResolverTranscription(env, videoId, chunkIndex, request.body, contentType);
    const status = result.status === "failed" ? 500 : result.status === "deferred" ? 202 : 200;
    return jsonResponse(result, status);
  }

  if (request.method === "POST" && url.pathname === "/resolver/callback") {
    const payload = (await request.json()) as { videoId?: string; audioUrl?: string; error?: string };
    if (!payload.videoId) return jsonResponse({ error: "missing videoId" }, 400);
    const result = await handleResolverCallback(env, {
      videoId: payload.videoId,
      ...(payload.audioUrl ? { audioUrl: payload.audioUrl } : {}),
      ...(payload.error ? { error: payload.error } : {}),
    });
    return jsonResponse(result);
  }

  if (request.method === "POST" && url.pathname === "/run") {
    if (url.searchParams.get("wait") === "1") return jsonResponse(await runPlaylist(env, "manual"));
    ctx.waitUntil(runPlaylist(env, "manual").then(console.log).catch(console.error));
    return jsonResponse({ accepted: true }, 202);
  }

  if (request.method === "POST" && url.pathname.startsWith("/retry/")) {
    const videoId = url.pathname.slice("/retry/".length).trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return jsonResponse({ error: "invalid video id" }, 400);

    const { manifest } = await loadManifest(env);
    const existing = manifest.videos[videoId];
    if (existing?.status === "processing") {
      return jsonResponse(
        { error: "video is already processing; retry did not reset the active claim", videoId, status: existing.status },
        409,
      );
    }
    if (existing?.status === "completed") {
      return jsonResponse(
        { error: "video is already completed; retry only applies to failed, waiting, or untracked videos", videoId, status: existing.status, path: existing.path },
        409,
      );
    }
    if (existing?.status === "failed" || existing?.status === "waiting") await makeRetryableNow(env, videoId);

    if (url.searchParams.get("wait") === "1") return jsonResponse(await runSingleVideo(env, videoId));
    ctx.waitUntil(runSingleVideo(env, videoId).then(console.log).catch(console.error));
    return jsonResponse({ accepted: true, videoId, resumed: Boolean(existing) }, 202);
  }

  if (request.method === "POST" && url.pathname.startsWith("/process/")) {
    const videoId = url.pathname.slice("/process/".length).trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return jsonResponse({ error: "invalid video id" }, 400);
    if (url.searchParams.get("wait") === "1") return jsonResponse(await runSingleVideo(env, videoId));
    ctx.waitUntil(runSingleVideo(env, videoId).then(console.log).catch(console.error));
    return jsonResponse({ accepted: true, videoId }, 202);
  }

  return jsonResponse({ error: "not found" }, 404);
}

export default {
  fetch(request: Request, env: Env, ctx: WaitUntilContext): Promise<Response> {
    return handleFetch(request, env, ctx).catch((error) => {
      console.error(error);
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    });
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: WaitUntilContext): void {
    const status = configStatus(env);
    if (!status.configured) {
      console.warn("scheduled ingest skipped: service is not fully configured", JSON.stringify(status));
      return;
    }
    ctx.waitUntil(
      runPlaylist(env, "cron")
        .then((result) => console.log("scheduled ingest", JSON.stringify(result)))
        .catch((error) => console.error("scheduled ingest failed", error)),
    );
  },
};

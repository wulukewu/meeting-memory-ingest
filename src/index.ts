import type { Env, ScheduledController, WaitUntilContext } from "./types";
import { loadManifest, resetVideo } from "./github";
import { handleResolverCallback, runPlaylist, runSingleVideo } from "./pipeline";
import { jsonResponse } from "./util";

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

async function handleFetch(request: Request, env: Env, ctx: WaitUntilContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ ok: true, service: "meeting-memory-ingest", ...configStatus(env) });
  }

  if (!isAdmin(request, env)) return jsonResponse({ error: "unauthorized" }, 401);

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

  if (request.method === "GET" && url.pathname === "/status") {
    const { manifest } = await loadManifest(env);
    const entries = Object.entries(manifest.videos)
      .sort(([, a], [, b]) => Date.parse(b.completedAt || b.failedAt || b.startedAt || "1970-01-01") - Date.parse(a.completedAt || a.failedAt || a.startedAt || "1970-01-01"))
      .slice(0, 25)
      .map(([videoId, value]) => ({ videoId, ...value }));
    return jsonResponse({ ...configStatus(env), manifestUpdatedAt: manifest.updatedAt, recent: entries });
  }

  if (request.method === "POST" && url.pathname === "/run") {
    if (url.searchParams.get("wait") === "1") return jsonResponse(await runPlaylist(env, "manual"));
    ctx.waitUntil(runPlaylist(env, "manual").then(console.log).catch(console.error));
    return jsonResponse({ accepted: true }, 202);
  }

  if (request.method === "POST" && url.pathname.startsWith("/retry/")) {
    const videoId = url.pathname.slice("/retry/".length).trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return jsonResponse({ error: "invalid video id" }, 400);
    await resetVideo(env, videoId);
    if (url.searchParams.get("wait") === "1") return jsonResponse(await runSingleVideo(env, videoId));
    ctx.waitUntil(runSingleVideo(env, videoId).then(console.log).catch(console.error));
    return jsonResponse({ accepted: true, videoId, reset: true }, 202);
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
    ctx.waitUntil(
      runPlaylist(env, "cron")
        .then((result) => console.log("scheduled ingest", JSON.stringify(result)))
        .catch((error) => console.error("scheduled ingest failed", error)),
    );
  },
};

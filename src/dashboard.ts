import type { Env, Manifest, ManifestEntry, VideoRecord } from "./types";
import { getRuntimeMeta, loadManifest, makeRetryableNow } from "./state";
import { runPlaylist, runSingleVideo } from "./pipeline";
import { getYouTubeAccessToken, listPlaylistVideos } from "./youtube";

const SESSION_COOKIE = "meeting_dashboard_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;

export type DashboardGroup = "action" | "processing" | "waiting" | "failed" | "ready" | "private";

export interface DashboardRow {
  video: VideoRecord;
  entry?: ManifestEntry;
  group: DashboardGroup;
  statusLabel: string;
  actionHint: string;
  statusKey?: DashboardCopyKey;
  actionKey?: DashboardCopyKey;
  needsManualAction?: boolean;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlResponse(html: string, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      ...extraHeaders,
    },
  });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
    },
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): ArrayBuffer {
  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer as ArrayBuffer;
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function issueSession(secret: string): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = String(expiresAt);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await sessionKey(secret), new TextEncoder().encode(payload)),
  );
  return `${payload}.${base64Url(signature)}`;
}

async function verifySession(secret: string, token: string | undefined): Promise<boolean> {
  if (!secret || !token) return false;
  const [expiresRaw, signatureRaw, ...extra] = token.split(".");
  if (!expiresRaw || !signatureRaw || extra.length) return false;
  const expiresAt = Number.parseInt(expiresRaw, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await sessionKey(secret),
      decodeBase64Url(signatureRaw),
      new TextEncoder().encode(expiresRaw),
    );
  } catch {
    return false;
  }
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

async function dashboardAuthorized(request: Request, env: Env): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (env.ADMIN_TOKEN && authorization === `Bearer ${env.ADMIN_TOKEN}`) return true;
  return verifySession(env.ADMIN_TOKEN, cookieValue(request, SESSION_COOKIE));
}

function durationLabel(seconds?: number): string {
  if (!seconds || seconds < 1) return "—";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function taipeiTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function rowUpdatedAt(entry?: ManifestEntry): string | undefined {
  return entry?.completedAt || entry?.failedAt || entry?.retryAfterAt || entry?.startedAt;
}
function isYouTubeBotBlocked(entry?: ManifestEntry): boolean {
  const error = entry?.lastError?.toLowerCase() || "";
  return (
    error.includes("youtube_bot_blocked") ||
    error.includes("confirm you’re not a bot") ||
    error.includes("confirm you're not a bot") ||
    error.includes("login_required")
  );
}

export function buildDashboardRow(video: VideoRecord, manifest: Manifest): DashboardRow {
  const entry = manifest.videos[video.id];
  const privacy = video.privacyStatus.toLowerCase();

  if (entry?.status === "completed") {
    return {
      video,
      entry,
      group: "action",
      statusLabel: "已完成",
      actionHint: privacy === "private" ? "可移出 playlist" : "可改 Private 並移出 playlist",
      statusKey: "status.completed",
      actionKey: privacy === "private" ? "action.removePlaylist" : "action.privateAndRemove",
    };
  }
  if (entry?.status === "processing") {
    return { video, entry, group: "processing", statusLabel: "轉錄中", actionHint: "不用操作", statusKey: "status.processing", actionKey: "action.none" };
  }
  if (entry?.status === "finalizing") {
    return { video, entry, group: "processing", statusLabel: "整理摘要中", actionHint: "Cloudflare Workflow 正在摘要並發布", statusKey: "status.finalizing", actionKey: "action.finalizing" };
  }
  if (entry?.status === "waiting") {
    if (isYouTubeBotBlocked(entry)) {
      return {
        video,
        entry,
        group: "waiting",
        statusLabel: "YouTube 冷卻中",
        actionHint: "下載出口被 YouTube 暫時阻擋；到時間後自動重試",
        statusKey: "status.youtubeCooldown",
        actionKey: "action.youtubeCooldown",
      };
    }
    return {
      video,
      entry,
      group: "waiting",
      statusLabel: "等待 Groq 額度",
      actionHint: "額度恢復後自動續跑",
      statusKey: "status.groqCooldown",
      actionKey: "action.groqCooldown",
    };
  }
  if (entry?.status === "failed") {
    if (isYouTubeBotBlocked(entry)) {
      return {
        video,
        entry,
        group: "failed",
        statusLabel: "YouTube 阻擋",
        actionHint: "下載出口受阻；系統會依失敗冷卻時間自動再試，也可立即重試",
        statusKey: "status.youtubeBlocked",
        actionKey: "action.youtubeBlocked",
        needsManualAction: false,
      };
    }
    return {
      video,
      entry,
      group: "failed",
      statusLabel: "失敗",
      actionHint: "達失敗冷卻時間後會自動再試；可展開錯誤資訊確認原因，或立即重試",
      statusKey: "status.failed",
      actionKey: "action.failed",
      needsManualAction: false,
    };
  }
  if (privacy === "private") {
    return { video, entry, group: "private", statusLabel: "Private", actionHint: "尚未排入處理", statusKey: "status.private", actionKey: "action.private" };
  }
  if (privacy === "unlisted") {
    return { video, entry, group: "ready", statusLabel: "待處理", actionHint: "Cron 會自動處理", statusKey: "status.ready", actionKey: "action.ready" };
  }
  return { video, entry, group: "ready", statusLabel: "未追蹤", actionHint: "目前 pipeline 只自動處理 Unlisted", statusKey: "status.untracked", actionKey: "action.untracked" };
}

function progressLabel(entry?: ManifestEntry): string {
  if (!entry) return "—";
  if (entry.status === "completed") return "完成";
  if (entry.status === "finalizing") return "摘要 / 發佈";
  const total = entry.totalChunks || 1;
  const done = entry.completedChunks?.length || 0;
  if (total > 1 || done > 0) return `${done} / ${total} chunks`;
  return entry.status === "processing" ? "啟動中" : "—";
}

function progressPercent(entry?: ManifestEntry): number | undefined {
  if (!entry || entry.status !== "processing") return undefined;
  const total = entry.totalChunks || 0;
  if (total < 1) return undefined;
  const done = Math.min(total, entry.completedChunks?.length || 0);
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function stateRank(group: DashboardGroup): number {
  return { failed: 0, action: 1, processing: 2, waiting: 3, ready: 4, private: 5 }[group];
}

const DASHBOARD_COPY = {
  "header.subtitle": { en: "Monitor transcription, summaries, and cleanup · {count} videos visible", zh: "監看轉錄、摘要與收尾狀態 · 目前可見 {count} 支影片" },
  "header.auto": { en: "Auto-refreshing", zh: "自動更新中" },
  "header.refreshing": { en: "Refreshing…", zh: "更新中…" },
  "header.syncing": { en: "Syncing…", zh: "同步中…" },
  "header.synced": { en: "Synced", zh: "已同步" },
  "header.syncUnavailable": { en: "Sync unavailable", zh: "暫時無法同步" },
  "header.offline": { en: "Offline", zh: "網路已離線" },
  "header.scan": { en: "Scan playlist", zh: "掃描 Playlist" },
  "header.signOut": { en: "Sign out", zh: "登出" },
  "header.refreshTitle": { en: "Refresh now", zh: "立即重新整理" },
  "header.switchLanguage": { en: "Switch to Traditional Chinese", zh: "切換至英文" },
  "manifest.refresh": { en: "Manifest {time} · 60 sec refresh", zh: "Manifest {time} · 60 秒更新" },
  "attention.none": { en: "No action needed", zh: "目前沒有需要你介入的項目" },
  "attention.actionOnly": { en: "{count} completed · cleanup needed", zh: "{count} 支已完成待收回" },
  "attention.failureOnly": { en: "{count} failure needs attention", zh: "{count} 個失敗需要處理" },
  "attention.both": { en: "{failures} failures need attention · {completed} completed need cleanup", zh: "{failures} 個失敗需要處理 · {completed} 支已完成待收回" },
  "attention.detailIssues": { en: "Items needing manual review or cleanup are kept at the top. Automatic waits and retries stay out of this queue.", zh: "需要處理的項目已排在最前面；等待與自動重試不列入人工介入。" },
  "attention.detailActive": { en: "{count} videos are being handled automatically. No action is needed right now.", zh: "系統正在處理 {count} 支影片，可以先不用管它。" },
  "attention.detailClean": { en: "Pipeline is clear. No exceptions or cleanup are pending.", zh: "目前流程是乾淨的，沒有異常或待收尾項目。" },
  "overview.eyebrow": { en: "Overview", zh: "總覽" },
  "overview.title": { en: "Current status", zh: "目前狀態" },
  "overview.hint": { en: "Click a count to filter", zh: "點數字即可篩選" },
  "stat.action": { en: "Completed · cleanup", zh: "已完成，可收回" },
  "stat.active": { en: "Processing / waiting", zh: "處理中 / 等待" },
  "stat.failed": { en: "Failed", zh: "失敗" },
  "stat.ready": { en: "Queued", zh: "待處理" },
  "stat.private": { en: "Private", zh: "Private" },
  "stat.all": { en: "Visible", zh: "目前可見" },
  "search.placeholder": { en: "Search title or video ID", zh: "搜尋標題或 video ID" },
  "filter.all": { en: "All", zh: "全部" },
  "filter.action": { en: "Cleanup", zh: "可收回" },
  "filter.active": { en: "Active", zh: "處理中" },
  "filter.ready": { en: "Queued", zh: "待處理" },
  "filter.private": { en: "Private", zh: "Private" },
  "filter.failed": { en: "Failed", zh: "失敗" },
  "section.attention.eyebrow": { en: "Needs attention", zh: "需要處理" },
  "section.attention.title": { en: "Needs attention", zh: "需要處理" },
  "section.attention.description": { en: "Only items requiring manual review or cleanup appear here.", zh: "只有需要人工確認或收尾的項目會出現在這裡。" },
  "section.active.eyebrow": { en: "In progress", zh: "正在處理" },
  "section.active.title": { en: "In progress", zh: "正在處理" },
  "section.active.description": { en: "Transcription, summarization, and cooldown waits.", zh: "轉錄、摘要與冷卻等待中的工作。" },
  "section.queue.eyebrow": { en: "Queue", zh: "待處理" },
  "section.queue.title": { en: "Queue", zh: "待處理" },
  "section.queue.description": { en: "In the playlist and waiting for the automatic pipeline.", zh: "已進 Playlist、等待自動 pipeline 接手。" },
  "section.archive.eyebrow": { en: "Archive", zh: "其他影片" },
  "section.archive.title": { en: "Archive", zh: "其他影片" },
  "section.archive.description": { en: "Private or low-attention items, collapsed by default.", zh: "Private 或目前不需要關注的項目，預設收起。" },
  "section.expand": { en: "Expand", zh: "展開" },
  "section.collapse": { en: "Collapse", zh: "收起" },
  "empty.attention": { en: "Nothing needs your attention.", zh: "目前沒有需要你處理的項目。" },
  "empty.generic": { en: "No items.", zh: "目前沒有項目。" },
  "empty.playlist": { en: "No playlist videos to display.", zh: "目前沒有可顯示的 playlist 影片。" },
  "card.action": { en: "Action", zh: "建議" },
  "card.progress": { en: "Progress", zh: "進度" },
  "card.updated": { en: "Updated", zh: "更新" },
  "card.error": { en: "Error details", zh: "錯誤資訊" },
  "card.retryNow": { en: "Retry now", zh: "立即重試" },
  "card.retrying": { en: "Retrying…", zh: "重試中…" },
  "card.editStudio": { en: "Edit in Studio", zh: "Studio 編輯" },
  "status.completed": { en: "Completed", zh: "已完成" },
  "status.processing": { en: "Transcribing", zh: "轉錄中" },
  "status.finalizing": { en: "Finalizing", zh: "整理摘要中" },
  "status.youtubeCooldown": { en: "YouTube cooldown", zh: "YouTube 冷卻中" },
  "status.groqCooldown": { en: "Waiting for Groq quota", zh: "等待 Groq 額度" },
  "status.youtubeBlocked": { en: "YouTube blocked", zh: "YouTube 阻擋" },
  "status.failed": { en: "Failed", zh: "失敗" },
  "status.private": { en: "Private", zh: "Private" },
  "status.ready": { en: "Queued", zh: "待處理" },
  "status.untracked": { en: "Untracked", zh: "未追蹤" },
  "action.removePlaylist": { en: "Can be removed from the playlist", zh: "可移出 playlist" },
  "action.privateAndRemove": { en: "Set to Private and remove from the playlist", zh: "可改 Private 並移出 playlist" },
  "action.none": { en: "No action needed", zh: "不用操作" },
  "action.finalizing": { en: "Workflow is summarizing and publishing", zh: "Cloudflare Workflow 正在摘要並發布" },
  "action.youtubeCooldown": { en: "YouTube temporarily blocked the download route; retry is automatic", zh: "下載出口被 YouTube 暫時阻擋；到時間後自動重試" },
  "action.groqCooldown": { en: "Resumes automatically when quota recovers", zh: "額度恢復後自動續跑" },
  "action.youtubeBlocked": { en: "Download route blocked; automatic retry is scheduled, or retry now", zh: "下載出口受阻；系統會依失敗冷卻時間自動再試，也可立即重試" },
  "action.failed": { en: "Automatic retry follows the failure cooldown; inspect the error or retry now", zh: "達失敗冷卻時間後會自動再試；可展開錯誤資訊確認原因，或立即重試" },
  "action.private": { en: "Not queued", zh: "尚未排入處理" },
  "action.ready": { en: "Cron will process automatically", zh: "Cron 會自動處理" },
  "action.untracked": { en: "The pipeline only processes Unlisted videos automatically", zh: "目前 pipeline 只自動處理 Unlisted" },
  "progress.complete": { en: "Complete", zh: "完成" },
  "progress.finalizing": { en: "Summary / publish", zh: "摘要 / 發佈" },
  "progress.starting": { en: "Starting", zh: "啟動中" },
  "progress.chunks": { en: "{done} / {total} chunks", zh: "{done} / {total} 段" },
  "retry.retry": { en: "Retry", zh: "重試" },
  "retry.resume": { en: "Resume", zh: "續跑" },
  "retry.inMinutes": { en: "{verb} in {minutes} min · {time}", zh: "{minutes} 分鐘後{verb} · {time}" },
  "retry.inOneMinute": { en: "{verb} in about 1 min · {time}", zh: "約 1 分鐘後{verb} · {time}" },
  "retry.soon": { en: "{verb} shortly · {time}", zh: "即將{verb} · {time}" },
  "retry.now": { en: "{verb} due now · {time}", zh: "{verb}時間已到 · {time}" },
  "ops.lastScan": { en: "Last scan", zh: "上次掃描" },
  "ops.lastCompleted": { en: "Last completed", zh: "上次完成" },
  "ops.lastSync": { en: "Last sync", zh: "上次同步" },
  "ops.justNow": { en: "Just now", zh: "剛剛" },
  "ops.syncFailed": { en: "Sync failed", zh: "同步失敗" },
  "activity.eyebrow": { en: "Activity", zh: "動態" },
  "activity.title": { en: "Recent activity", zh: "最近事件" },
  "activity.latest": { en: "Latest 8", zh: "最近 8 筆" },
  "activity.empty": { en: "No recent activity.", zh: "還沒有近期事件。" },
  "activity.completed": { en: "Completed", zh: "處理完成" },
  "activity.failed": { en: "Failed", zh: "處理失敗" },
  "activity.autoRetry": { en: "Waiting for auto-retry", zh: "等待自動重試" },
  "activity.youtubeCooldown": { en: "YouTube cooldown", zh: "YouTube 冷卻" },
  "activity.groqCooldown": { en: "Groq cooldown", zh: "Groq 冷卻" },
  "activity.finalizing": { en: "Finalization started", zh: "開始整理摘要" },
  "activity.started": { en: "Processing started", zh: "開始處理" },
  "feedback.retryFailed": { en: "Retry failed: {error}", zh: "重試失敗：{error}" },
  "feedback.scanning": { en: "Scanning playlist…", zh: "正在掃描 Playlist…" },
  "feedback.scanComplete": { en: "Scan complete: {eligible} eligible · {claimed} started", zh: "掃描完成：發現 {eligible} 支可處理，觸發 {claimed} 支。" },
  "feedback.scanFailed": { en: "Scan failed: {error}", zh: "觸發失敗：{error}" },
} as const;

type DashboardCopyKey = keyof typeof DASHBOARD_COPY;
type DashboardLocale = keyof (typeof DASHBOARD_COPY)[DashboardCopyKey];

function copyText(
  key: DashboardCopyKey,
  locale: DashboardLocale = "en",
  values: Record<string, string | number> = {},
): string {
  let output: string = DASHBOARD_COPY[key][locale];
  for (const [name, value] of Object.entries(values)) output = output.replaceAll(`{${name}}`, String(value));
  return output;
}

function i18nText(key: DashboardCopyKey, values: Record<string, string | number> = {}): string {
  const dataValues = Object.entries(values)
    .map(([name, value]) => ` data-i18n-${escapeHtml(name)}="${escapeHtml(value)}"`)
    .join("");
  return `<span data-i18n="${key}"${dataValues}>${escapeHtml(copyText(key, "en", values))}</span>`;
}

function loginPage(message = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meeting Memory Dashboard</title><style>
  :root{color-scheme:dark;background:#0b0d10;color:#f5f7fa;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(420px,100%);background:#13171c;border:1px solid #29313a;border-radius:18px;padding:28px;box-shadow:0 18px 50px rgba(0,0,0,.32)}h1{font-size:22px;margin:0 0 8px}p{color:#9ca8b5;line-height:1.5}.error{color:#ff9e9e}label{display:block;font-size:13px;color:#b9c3cd;margin:20px 0 8px}input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #35404b;background:#0d1116;color:#fff;font:inherit}button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;background:#f5f7fa;color:#0b0d10;font-weight:700;cursor:pointer}</style></head><body><main class="card"><h1>Meeting Memory</h1><p>Enter your existing ADMIN_TOKEN to sign in. The token is never stored in the URL or localStorage.</p>${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}<form method="post" action="/dashboard/login"><label for="token">ADMIN_TOKEN</label><input id="token" name="token" type="password" autocomplete="current-password" required autofocus><button type="submit">Open Dashboard</button></form></main></body></html>`;
}

interface DashboardActivity {
  at: string;
  labelKey: DashboardCopyKey;
  detail: string;
  tone: "ok" | "info" | "warn" | "danger";
}

interface DashboardView {
  counts: {
    all: number;
    action: number;
    active: number;
    failed: number;
    ready: number;
    private: number;
  };
  manualFailures: number;
  attentionCount: number;
  attentionText: string;
  attentionDetail: string;
  sectionsHtml: string;
  revision: string;
  activity: DashboardActivity[];
  lastCompletedAt?: string;
}

function attentionTitle(
  counts: DashboardView["counts"],
  manualFailures: number,
  locale: DashboardLocale = "en",
): string {
  if (manualFailures > 0 && counts.action > 0) {
    return copyText("attention.both", locale, { failures: manualFailures, completed: counts.action });
  }
  if (manualFailures > 0) return copyText("attention.failureOnly", locale, { count: manualFailures });
  if (counts.action > 0) return copyText("attention.actionOnly", locale, { count: counts.action });
  return copyText("attention.none", locale);
}

function attentionDescription(
  counts: DashboardView["counts"],
  manualFailures: number,
  locale: DashboardLocale = "en",
): string {
  if (manualFailures + counts.action > 0) return copyText("attention.detailIssues", locale);
  if (counts.active > 0) return copyText("attention.detailActive", locale, { count: counts.active });
  return copyText("attention.detailClean", locale);
}

function progressMarkup(entry?: ManifestEntry): string {
  if (!entry) return "—";
  if (entry.status === "completed") return i18nText("progress.complete");
  if (entry.status === "finalizing") return i18nText("progress.finalizing");
  const total = entry.totalChunks || 1;
  const done = entry.completedChunks?.length || 0;
  if (total > 1 || done > 0) return i18nText("progress.chunks", { done, total });
  return entry.status === "processing" ? i18nText("progress.starting") : "—";
}

function renderDashboardView(env: Env, rows: DashboardRow[], manifest: Manifest): DashboardView {
  const counts = {
    all: rows.length,
    action: rows.filter((row) => row.group === "action").length,
    active: rows.filter((row) => row.group === "processing" || row.group === "waiting").length,
    failed: rows.filter((row) => row.group === "failed").length,
    ready: rows.filter((row) => row.group === "ready").length,
    private: rows.filter((row) => row.group === "private").length,
  };
  const manualFailures = rows.filter((row) => row.group === "failed" && row.needsManualAction).length;
  const attentionCount = counts.action + manualFailures;
  const activity: DashboardActivity[] = rows
    .flatMap((row): DashboardActivity[] => {
      const entry = row.entry;
      if (!entry) return [];
      if (entry.completedAt) return [{ at: entry.completedAt, labelKey: "activity.completed", detail: row.video.title, tone: "ok" }];
      if (entry.status === "failed" && entry.failedAt) {
        return [{
          at: entry.failedAt,
          labelKey: row.needsManualAction ? "activity.failed" : "activity.autoRetry",
          detail: row.video.title,
          tone: row.needsManualAction ? "danger" : "warn",
        }];
      }
      if (entry.status === "waiting" && entry.updatedAt) {
        return [{
          at: entry.updatedAt,
          labelKey: isYouTubeBotBlocked(entry) ? "activity.youtubeCooldown" : "activity.groqCooldown",
          detail: row.video.title,
          tone: "warn",
        }];
      }
      if (entry.status === "finalizing" && entry.updatedAt) {
        return [{ at: entry.updatedAt, labelKey: "activity.finalizing", detail: row.video.title, tone: "info" }];
      }
      if (entry.startedAt) return [{ at: entry.startedAt, labelKey: "activity.started", detail: row.video.title, tone: "info" }];
      return [];
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 8);
  const lastCompletedAt = rows
    .map((row) => row.entry?.completedAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

  const renderCard = (row: DashboardRow): string => {
    const { video, entry } = row;
    const studio = `https://studio.youtube.com/video/${encodeURIComponent(video.id)}/edit`;
    const playlist = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}&list=${encodeURIComponent(env.YOUTUBE_PLAYLIST_ID)}`;
    const watch = `https://youtu.be/${encodeURIComponent(video.id)}`;
    const transcript = entry?.path
      ? `https://github.com/${encodeURIComponent(env.AI_MEMORY_OWNER)}/${encodeURIComponent(env.AI_MEMORY_REPO)}/blob/${encodeURIComponent(env.AI_MEMORY_BRANCH)}/${entry.path.split("/").map(encodeURIComponent).join("/")}`
      : "";
    const privacy = video.privacyStatus.toLowerCase();
    const privacyClass = privacy === "private" ? "muted" : privacy === "unlisted" ? "warn" : "ok";
    const privacyLabel = privacy ? privacy[0].toUpperCase() + privacy.slice(1) : video.privacyStatus;
    const error = entry?.lastError
      ? `<details class="error-details"><summary data-i18n="card.error">${escapeHtml(copyText("card.error"))}</summary><pre>${escapeHtml(entry.lastError)}</pre></details>`
      : "";
    const retry = row.group === "failed"
      ? `<button class="retry-control motion-button" type="button" data-retry-video="${escapeHtml(video.id)}"><span class="motion-icon icon-default" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><path d="M15.8 6.6V3.8m0 0H13m2.8 0-2.1 2.1a6 6 0 1 0 1.35 6.45" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="motion-icon icon-busy" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="25 12"/></svg></span><span class="motion-label" data-i18n="card.retryNow">${escapeHtml(copyText("card.retryNow"))}</span></button>`
      : "";
    const retryKind = isYouTubeBotBlocked(entry) ? "retry" : "resume";
    const waiting = entry?.retryAfterAt
      ? `<span class="subtle retry-time" data-retry-at="${escapeHtml(entry.retryAfterAt)}" data-retry-kind="${retryKind}"></span>`
      : "";
    const percent = progressPercent(entry);
    const progress = percent !== undefined
      ? `<div class="progress-row"><div class="progress-track" data-progress-percent="${percent}" aria-label="Transcription progress ${percent}%"><span class="progress-fill" style="width:${percent}%"></span></div><span class="progress-value" data-progress-value="${percent}">${percent}%</span></div>`
      : "";
    const status = row.statusKey ? i18nText(row.statusKey) : escapeHtml(row.statusLabel);
    const action = row.actionKey ? i18nText(row.actionKey) : escapeHtml(row.actionHint);
    return `<article class="video-card" data-video-id="${escapeHtml(video.id)}" data-group="${row.group}" data-status-key="${escapeHtml(row.statusKey || row.group)}" data-search="${escapeHtml(`${video.title} ${video.id}`.toLowerCase())}">
      <div class="topline"><div class="title-wrap"><h3>${escapeHtml(video.title)}</h3><div class="meta"><span>${escapeHtml(durationLabel(video.durationSeconds))}</span><span class="badge ${privacyClass}">${escapeHtml(privacyLabel)}</span></div></div><span class="status status-${row.group}" data-status-pill>${status}</span></div>
      <div class="status-grid"><div><span class="label" data-i18n="card.action">${escapeHtml(copyText("card.action"))}</span><strong>${action}</strong></div><div><span class="label" data-i18n="card.progress">${escapeHtml(copyText("card.progress"))}</span><strong>${progressMarkup(entry)}</strong>${progress}${waiting}</div><div><span class="label" data-i18n="card.updated">${escapeHtml(copyText("card.updated"))}</span><strong>${escapeHtml(taipeiTime(rowUpdatedAt(entry)))}</strong></div></div>
      ${error}
      <div class="card-footer"><div class="links"><a class="primary" href="${studio}" target="_blank" rel="noreferrer" data-i18n="card.editStudio">${escapeHtml(copyText("card.editStudio"))}</a><a href="${playlist}" target="_blank" rel="noreferrer">Playlist</a><a href="${watch}" target="_blank" rel="noreferrer">YouTube</a>${transcript ? `<a href="${transcript}" target="_blank" rel="noreferrer">Transcript</a>` : ""}${retry}</div><span class="video-id" title="Video ID">${escapeHtml(video.id)}</span></div>
    </article>`;
  };

  const section = (
    id: "attention" | "active" | "queue" | "archive",
    groups: DashboardGroup[],
    collapsible = false,
  ): string => {
    const sectionRows = rows.filter((row) => groups.includes(row.group));
    const count = sectionRows.length;
    const eyebrowKey = `section.${id}.eyebrow` as DashboardCopyKey;
    const titleKey = `section.${id}.title` as DashboardCopyKey;
    const descriptionKey = `section.${id}.description` as DashboardCopyKey;
    const emptyKey: DashboardCopyKey = id === "attention" ? "empty.attention" : "empty.generic";
    return `<section class="flow-section${collapsible ? " collapsible collapsed" : ""}" data-section="${id}" data-groups="${groups.join(",")}">
      <div class="section-head"><div><div class="eyebrow" data-i18n="${eyebrowKey}">${escapeHtml(copyText(eyebrowKey))}</div><h2><span data-i18n="${titleKey}">${escapeHtml(copyText(titleKey))}</span><span class="section-count">${count}</span></h2><p data-i18n="${descriptionKey}">${escapeHtml(copyText(descriptionKey))}</p></div>${collapsible ? `<button class="section-toggle" type="button" aria-expanded="false" data-i18n="section.expand">${escapeHtml(copyText("section.expand"))}</button>` : ""}</div>
      <div class="section-body">${sectionRows.map(renderCard).join("") || `<div class="section-empty" data-i18n="${emptyKey}">${escapeHtml(copyText(emptyKey))}</div>`}</div>
    </section>`;
  };

  const attentionText = attentionTitle(counts, manualFailures);
  const attentionDetail = attentionDescription(counts, manualFailures);
  const sectionsHtml = [
    section("attention", ["failed", "action"]),
    section("active", ["processing", "waiting"]),
    section("queue", ["ready"]),
    section("archive", ["private"], true),
  ].join("");

  const revision = [
    manifest.updatedAt,
    ...rows.map((row) => [
      row.video.id,
      row.video.privacyStatus,
      row.group,
      row.entry?.status || "",
      rowUpdatedAt(row.entry) || "",
      row.entry?.completedChunks?.length || 0,
      row.entry?.totalChunks || 0,
      row.entry?.path || "",
    ].join(":")),
  ].join("|");

  return {
    counts,
    manualFailures,
    attentionCount,
    attentionText,
    attentionDetail,
    sectionsHtml,
    revision,
    activity,
    lastCompletedAt,
  };
}

async function loadDashboardState(env: Env): Promise<{ rows: DashboardRow[]; manifest: Manifest; lastScan?: { value: string; updatedAt: string } }> {
  const [accessToken, manifestResult, lastScan] = await Promise.all([getYouTubeAccessToken(env), loadManifest(env), getRuntimeMeta(env, "playlist_last_scan")]);
  const videos = await listPlaylistVideos(env, accessToken);
  const rows = videos
    .map((video) => buildDashboardRow(video, manifestResult.manifest))
    .sort((a, b) => {
      const rank = stateRank(a.group) - stateRank(b.group);
      if (rank !== 0) return rank;
      const aTime = Date.parse(a.video.playlistAddedAt || a.video.publishedAt || "1970-01-01");
      const bTime = Date.parse(b.video.playlistAddedAt || b.video.publishedAt || "1970-01-01");
      return bTime - aTime;
    });
  return { rows, manifest: manifestResult.manifest, lastScan };
}

function parseLastScan(lastScan?: { value: string; updatedAt: string }): { at?: string; trigger?: string; outcome?: string } {
  if (!lastScan) return {};
  try {
    const parsed = JSON.parse(lastScan.value) as { at?: string; trigger?: string; outcome?: string };
    return { at: parsed.at || lastScan.updatedAt, trigger: parsed.trigger, outcome: parsed.outcome };
  } catch {
    return { at: lastScan.updatedAt };
  }
}

function dashboardData(env: Env, rows: DashboardRow[], manifest: Manifest, lastScan?: { value: string; updatedAt: string }): Record<string, unknown> {
  const view = renderDashboardView(env, rows, manifest);
  return {
    revision: view.revision,
    counts: view.counts,
    manualFailures: view.manualFailures,
    attentionCount: view.attentionCount,
    attentionText: view.attentionText,
    attentionDetail: view.attentionDetail,
    manifestUpdatedAt: taipeiTime(manifest.updatedAt),
    sectionsHtml: view.sectionsHtml,
    activity: view.activity,
    lastCompletedAt: view.lastCompletedAt,
    lastScan: parseLastScan(lastScan),
  };
}

function renderDashboard(env: Env, rows: DashboardRow[], manifest: Manifest, lastScan?: { value: string; updatedAt: string }): string {
  const view = renderDashboardView(env, rows, manifest);
  const { counts, manualFailures, attentionCount, sectionsHtml, activity, lastCompletedAt } = view;
  const scan = parseLastScan(lastScan);
  const initialAttentionTitle = attentionTitle(counts, manualFailures);
  const initialAttentionDetail = attentionDescription(counts, manualFailures);
  const activityHtml = activity.map((item) =>
    `<div class="activity-item"><span class="activity-dot ${item.tone}"></span><div><strong data-i18n="${item.labelKey}">${escapeHtml(copyText(item.labelKey))}</strong><span>${escapeHtml(item.detail)}</span></div><time>${escapeHtml(taipeiTime(item.at))}</time></div>`,
  ).join("") || `<div class="activity-empty" data-i18n="activity.empty">${escapeHtml(copyText("activity.empty"))}</div>`;
  const clientCopy = JSON.stringify(DASHBOARD_COPY).replace(/</g, "\\u003c");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meeting Memory Dashboard</title><style>
  :root{color-scheme:dark;--bg:#090b0e;--panel:#101419;--panel-raised:#13181e;--panel-soft:#0c1014;--line:#232c35;--line-soft:#1b232b;--text:#f4f7f9;--muted:#8b98a5;--muted-2:#687683;--success:#83dfa5;--blue:#83c7ff;--warn:#edc96c;--danger:#ff9898;--violet:#c5b7ff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% -20%,#17202a 0,transparent 36rem),var(--bg);color:var(--text)}button,input{font:inherit}.shell{width:min(1180px,calc(100% - 36px));margin:0 auto;padding:30px 0 64px}.page-header{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"brand actions" "feedback feedback";gap:18px 28px;align-items:center;margin-bottom:22px}.brand{grid-area:brand;min-width:0}.eyebrow{font-size:10px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:#718090;margin-bottom:7px}h1{font-size:30px;line-height:1.05;letter-spacing:-.035em;margin:0}.subtitle{color:var(--muted);margin:8px 0 0;font-size:14px;line-height:1.5}.header-actions{grid-area:actions;display:flex;gap:9px;align-items:center;justify-content:flex-end;flex-wrap:wrap}.sync-panel{display:flex;align-items:center;gap:10px;min-height:42px;padding:6px 7px 6px 11px;border:1px solid var(--line);border-radius:12px;background:rgba(16,20,25,.82);box-shadow:0 8px 24px rgba(0,0,0,.14)}.sync-dot{width:7px;height:7px;border-radius:999px;background:var(--success);box-shadow:0 0 0 4px rgba(131,223,165,.08);flex:0 0 auto}.sync-copy{display:grid;gap:1px;min-width:128px}.sync-copy strong{font-size:12px;font-weight:650;color:#dbe4eb}.sync-copy span{font-size:10px;color:#73818e}.icon-control{width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:#98a5b1;cursor:pointer;transition:background .16s ease,color .16s ease,transform .16s ease}.icon-control:hover{background:#1b2229;color:#f3f6f8}.icon-control:active{transform:scale(.96)}.icon-control svg{width:15px;height:15px}.icon-control.spinning svg{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.control,.logout{border-radius:11px;cursor:pointer;font-size:13px;transition:transform .16s ease,background .16s ease,border-color .16s ease,color .16s ease}.control{min-height:42px;padding:0 15px;border:1px solid #e9eef2;background:#edf2f5;color:#0a0d10;font-weight:750;box-shadow:0 6px 20px rgba(0,0,0,.14)}.control:hover{background:#fff}.control:active{transform:translateY(1px)}.control:disabled{opacity:.55;cursor:wait}.logout{min-height:42px;padding:0 11px;border:1px solid transparent;background:transparent;color:#84919d}.language-toggle{min-height:34px;padding:0 10px;border:1px solid var(--line);border-radius:9px;background:#0f1419;color:#9eabb6;font-size:11px;font-weight:700;cursor:pointer}.language-toggle:hover{color:#eef3f6;background:#171e24}.logout:hover{background:#13191f;color:#d5dde4;border-color:#202932}.run-status{grid-area:feedback;font-size:12px;color:#8f9daa;min-height:0;text-align:right;margin-top:-8px}.run-status:not(:empty){min-height:18px}.run-status.error{color:var(--danger)}.attention-strip{display:flex;gap:13px;align-items:center;border:1px solid #21302a;border-radius:15px;background:linear-gradient(180deg,rgba(18,38,28,.66),rgba(13,25,19,.66));padding:14px 16px;margin-bottom:18px}.attention-strip.warn{border-color:#473026;background:linear-gradient(180deg,rgba(56,31,24,.72),rgba(35,22,19,.7))}.attention-icon{width:30px;height:30px;border-radius:10px;display:grid;place-items:center;flex:0 0 auto;background:#152c20;color:var(--success);font-weight:800}.attention-strip.warn .attention-icon{background:#3a211a;color:#ffb49a}.attention-copy{display:grid;gap:3px}.attention-copy strong{font-size:13px}.attention-copy span{font-size:11px;color:#8f9c97;line-height:1.45}.overview{margin-bottom:12px}.overview-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin:0 2px 10px}.overview-head h2{font-size:14px;margin:0;letter-spacing:-.01em}.overview-total{font-size:11px;color:#71808d}.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:9px}.stat{appearance:none;text-align:left;color:inherit;position:relative;overflow:hidden;background:linear-gradient(180deg,#11161b,#0f1318);border:1px solid var(--line-soft);border-radius:14px;padding:14px 14px 13px;min-height:78px;cursor:pointer;transition:border-color .16s ease,transform .16s ease,background .16s ease}.stat:hover{border-color:#33404b;background:#13191f}.stat:active{transform:translateY(1px)}.stat::before{content:"";position:absolute;inset:0 auto 0 0;width:2px;background:#44515d}.stat-action::before{background:var(--success)}.stat-active::before{background:var(--blue)}.stat-failed::before{background:var(--danger)}.stat-ready::before{background:var(--violet)}.stat-private::before{background:#788592}.stat.active{border-color:#45525d;background:#171e24}.stat b{font-size:23px;line-height:1;letter-spacing:-.025em;display:block;margin-bottom:8px}.stat span{font-size:11px;color:#7f8d99;line-height:1.3}.toolbar{position:sticky;top:0;z-index:5;padding:12px 0 14px;background:linear-gradient(180deg,rgba(9,11,14,.98) 0,rgba(9,11,14,.93) 76%,rgba(9,11,14,0) 100%);backdrop-filter:blur(14px)}.toolbar-surface{display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--line-soft);border-radius:14px;background:rgba(15,19,24,.94);box-shadow:0 10px 30px rgba(0,0,0,.16)}.search-wrap{position:relative;flex:1;min-width:180px}.search-wrap svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);width:15px;height:15px;color:#687783;pointer-events:none}.toolbar input{width:100%;height:38px;background:#0c1014;border:1px solid #202a33;color:#f4f7f9;border-radius:9px;padding:0 12px 0 34px;outline:none}.toolbar input:focus{border-color:#465563;box-shadow:0 0 0 3px rgba(123,147,169,.08)}.toolbar input::placeholder{color:#596672}.filters{display:flex;gap:5px;align-items:center;overflow-x:auto;scrollbar-width:none}.filters::-webkit-scrollbar{display:none}.filter{height:34px;background:transparent;border:1px solid transparent;color:#84929f;border-radius:8px;padding:0 10px;cursor:pointer;font-size:12px;white-space:nowrap}.filter:hover{background:#171d23;color:#c2ccd4}.filter.active{background:#202830;color:#f3f6f8;border-color:#29343e}.flow{display:grid;gap:26px}.flow-section{display:grid;gap:10px}.flow-section[hidden]{display:none}.section-head{display:flex;justify-content:space-between;align-items:end;gap:20px;padding:0 2px}.section-head h2{display:flex;align-items:center;gap:8px;font-size:17px;line-height:1.2;margin:0;letter-spacing:-.015em}.section-count{font-size:10px;color:#8795a1;border:1px solid #27313a;background:#11171c;border-radius:999px;padding:3px 7px;font-weight:650}.section-head p{margin:6px 0 0;color:#6e7b87;font-size:11px;line-height:1.45}.section-toggle{border:1px solid #28333d;background:#11171c;color:#9eabb6;border-radius:9px;padding:7px 10px;font-size:11px;cursor:pointer}.section-body{display:grid;gap:10px}.flow-section.collapsed .section-body{display:none}.section-empty{padding:22px 18px;border:1px dashed #21302a;border-radius:14px;background:#0d1210;color:#6f8378;font-size:12px}.video-card{position:relative;background:linear-gradient(180deg,#101419,#0f1317);border:1px solid #202932;border-radius:16px;padding:18px;box-shadow:0 8px 28px rgba(0,0,0,.09);transition:border-color .16s ease,background .16s ease}.video-card:hover{border-color:#2d3944;background:#11161b}.video-card[hidden]{display:none}.topline{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.title-wrap{min-width:0}h3{font-size:16px;margin:0 0 8px;line-height:1.45;letter-spacing:-.01em}.meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:11px;color:#71808d}.badge,.status{font-size:10px;border-radius:999px;padding:4px 8px;white-space:nowrap}.badge{background:#1a222a}.badge.warn{color:#e8c86d;background:#292416}.badge.ok{color:#82dba2;background:#14251b}.badge.muted{color:#9ba7b2;background:#1a2025}.status{height:max-content;font-weight:700;border:1px solid transparent}.status-action{background:#132b1d;color:#88e0a7;border-color:#1a4028}.status-processing{background:#11283a;color:#8bc8f5;border-color:#173b55}.status-waiting{background:#2a2413;color:#e8c86e;border-color:#443a1d}.status-failed{background:#301819;color:#ff9d9d;border-color:#4a2223}.status-ready{background:#242138;color:#c7baff;border-color:#373153}.status-private{background:#1c2227;color:#9ba8b2;border-color:#2b333a}.status-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;margin:15px 0}.status-grid>div{background:#0c1014;border:1px solid #1a2229;border-radius:10px;padding:10px 11px}.label{display:block;color:#61707d;font-size:10px;font-weight:650;letter-spacing:.04em;margin-bottom:5px}.status-grid strong{font-size:12px;line-height:1.45;color:#cdd6dd;font-weight:620}.subtle{display:block;color:#788692;font-size:10px;margin-top:5px}.progress-row{display:flex;align-items:center;gap:7px;margin-top:7px;color:#74828e;font-size:9px}.progress-track{height:4px;flex:1;overflow:hidden;border-radius:999px;background:#1b242c}.progress-fill{display:block;height:100%;border-radius:inherit;background:#72bdf1}.card-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.links{display:flex;gap:7px;flex-wrap:wrap}.links a{color:#9eabb6;text-decoration:none;border:1px solid #26313a;border-radius:9px;padding:7px 10px;font-size:11px;transition:background .15s ease,border-color .15s ease,color .15s ease}.links a:hover{background:#161d23;border-color:#35424d;color:#e4eaee}.links a.primary{background:#17202a;color:#d9e3ea;border-color:#2b3945;font-weight:650}.retry-control{color:#ffc0b6;border:1px solid #4b2b29;border-radius:9px;padding:7px 10px;font-size:11px;background:#251716;cursor:pointer}.retry-control:hover{background:#321d1b}.ops-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:0 0 18px}.ops-item{border:1px solid var(--line-soft);background:#0e1317;border-radius:12px;padding:10px 12px}.ops-item span{display:block;color:#667581;font-size:9px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}.ops-item strong{font-size:11px;color:#b9c5ce}.activity-panel{border:1px solid var(--line-soft);background:#0e1216;border-radius:15px;padding:15px;margin-top:2px}.activity-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:10px}.activity-head h2{font-size:14px;margin:0}.activity-list{display:grid}.activity-item{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 2px;border-top:1px solid #182027}.activity-item:first-child{border-top:0}.activity-dot{width:6px;height:6px;border-radius:999px;background:#7d8b96}.activity-dot.ok{background:var(--success)}.activity-dot.info{background:var(--blue)}.activity-dot.warn{background:var(--warn)}.activity-dot.danger{background:var(--danger)}.activity-item div{display:grid;gap:2px}.activity-item strong{font-size:11px}.activity-item span,.activity-item time{font-size:10px;color:#6f7d89}.activity-item time{white-space:nowrap}.activity-empty{font-size:11px;color:#6f7d89;padding:8px 2px}.sync-panel.stale .sync-dot{background:var(--warn);box-shadow:0 0 0 4px rgba(237,201,108,.08)}.sync-panel.offline .sync-dot{background:var(--danger);box-shadow:0 0 0 4px rgba(255,152,152,.08)}.video-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#46535e;font-size:9px;opacity:.72}.error-details{margin:10px 0 12px;color:#d9a3a3;font-size:11px}.error-details summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0a0d10;border:1px solid #241a1b;padding:10px;border-radius:9px;color:#c7a3a3}.empty{padding:44px 28px;text-align:center;color:#73808c;border:1px dashed #26313a;border-radius:15px;background:#0d1115}@media(max-width:900px){.page-header{grid-template-columns:1fr;grid-template-areas:"brand" "actions" "feedback";gap:14px}.header-actions{justify-content:flex-start}.run-status{text-align:left;margin-top:-4px}.stats{grid-template-columns:repeat(3,1fr)}.toolbar-surface{align-items:stretch;flex-direction:column}.search-wrap{width:100%}.filters{width:100%}}@media(max-width:620px){.ops-strip{grid-template-columns:1fr}.activity-item{grid-template-columns:8px minmax(0,1fr)}.activity-item time{grid-column:2}.shell{width:min(100% - 20px,1180px);padding-top:20px}.header-actions{display:grid;grid-template-columns:1fr auto auto;width:100%}.sync-panel{grid-column:1/-1}.control{width:100%}.stats{grid-template-columns:repeat(2,1fr)}.toolbar{margin:0 -2px}.status-grid{grid-template-columns:1fr 1fr}.status-grid>div:first-child{grid-column:1/-1}.topline{gap:10px}h1{font-size:27px}.video-card{padding:15px}.card-footer{align-items:flex-end}.video-id{display:none}.section-head p{max-width:290px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}.icon-control.spinning svg{animation:none}}
  
  .header-actions{gap:8px}.language-toggle{position:relative;width:38px;height:38px;min-height:38px;padding:0;display:grid;place-items:center;border:1px solid #27323b;border-radius:11px;background:#10161b;color:#98a7b3;cursor:pointer;transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s cubic-bezier(.2,.8,.2,1);box-shadow:none}.language-toggle:hover{background:#171e24;border-color:#3a4854;color:#eef3f6}.language-toggle:active{transform:scale(.94)}.language-toggle svg{width:17px;height:17px;transition:transform .32s cubic-bezier(.2,.8,.2,1),opacity .18s ease}.language-toggle.switching svg{transform:rotate(100deg) scale(.86);opacity:.72}.language-toggle::after{content:attr(data-tooltip);position:absolute;right:0;top:calc(100% + 9px);z-index:20;pointer-events:none;white-space:nowrap;padding:6px 8px;border:1px solid #27323b;border-radius:8px;background:#11171c;color:#c4ced6;font-size:10px;font-weight:600;opacity:0;transform:translateY(-3px) scale(.98);transition:opacity .14s ease,transform .14s ease;box-shadow:0 8px 24px rgba(0,0,0,.28)}.language-toggle:hover::after,.language-toggle:focus-visible::after{opacity:1;transform:translateY(0) scale(1)}.language-toggle:focus-visible,.icon-control:focus-visible,.control:focus-visible,.logout:focus-visible,.filter:focus-visible,.stat:focus-visible,.section-toggle:focus-visible,.retry-control:focus-visible{outline:2px solid #6db6ea;outline-offset:2px}.video-card{transition:border-color .18s ease,background .18s ease,transform .18s cubic-bezier(.2,.8,.2,1),box-shadow .18s ease}.video-card:hover{transform:translateY(-1px);box-shadow:0 12px 34px rgba(0,0,0,.14)}.attention-strip{transition:border-color .22s ease,background .22s ease,transform .22s ease}.sync-dot{transition:background .2s ease,box-shadow .2s ease}.sync-panel.sync-success .sync-dot{animation:syncPulse .52s ease}.stat b.count-pop{animation:countPop .24s cubic-bezier(.2,.8,.2,1)}.flow.content-updated{animation:contentRefresh .28s cubic-bezier(.2,.8,.2,1)}.section-body.archive-enter{animation:archiveEnter .2s cubic-bezier(.2,.8,.2,1)}@keyframes syncPulse{0%{transform:scale(1)}45%{transform:scale(1.55)}100%{transform:scale(1)}}@keyframes countPop{0%{transform:translateY(0);opacity:1}45%{transform:translateY(-2px);opacity:.7}100%{transform:translateY(0);opacity:1}}@keyframes contentRefresh{0%{opacity:.78;transform:translateY(3px)}100%{opacity:1;transform:none}}@keyframes archiveEnter{0%{opacity:0;transform:translateY(-5px)}100%{opacity:1;transform:none}}@media(max-width:620px){.language-toggle{width:36px;height:36px;min-height:36px}.language-toggle::after{display:none}}@media(prefers-reduced-motion:reduce){.language-toggle svg,.video-card,.attention-strip,.sync-dot{transition:none!important}.language-toggle.switching svg,.sync-panel.sync-success .sync-dot,.stat b.count-pop,.flow.content-updated,.section-body.archive-enter{animation:none!important}}

  </style></head><body><main class="shell"><header class="page-header"><div class="brand"><div class="eyebrow">AI Memory · Ingest</div><h1>Meeting Memory</h1><p class="subtitle" id="dashboard-subtitle" data-i18n="header.subtitle" data-i18n-count="${counts.all}">${escapeHtml(copyText("header.subtitle","en",{count:counts.all}))}</p></div><div class="header-actions"><div class="sync-panel"><span class="sync-dot" aria-hidden="true"></span><div class="sync-copy"><strong id="refresh-copy" data-i18n="header.auto">${escapeHtml(copyText("header.auto"))}</strong><span id="manifest-status" data-i18n="manifest.refresh" data-i18n-time="${escapeHtml(taipeiTime(manifest.updatedAt))}">${escapeHtml(copyText("manifest.refresh","en",{time:taipeiTime(manifest.updatedAt)}))}</span></div><button class="icon-control" id="refresh-now" type="button" aria-label="${escapeHtml(copyText("header.refreshTitle"))}" title="${escapeHtml(copyText("header.refreshTitle"))}"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 8.3A7 7 0 0 1 18.7 7L20 11M4 13l1.3 4A7 7 0 0 0 17.9 15.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div><button class="control motion-button scan-control" id="run-now" type="button"><span class="motion-icon icon-default" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><path d="M4 5.5h8.5M4 10h12M4 14.5h8.5M14.2 4.2 16 6l-1.8 1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="motion-icon icon-busy" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="25 12"/></svg></span><span class="motion-icon icon-success" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><path d="m5.5 10.2 2.8 2.8 6.2-6.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="motion-label" data-i18n="header.scan">${escapeHtml(copyText("header.scan"))}</span></button><button class="language-toggle" id="language-toggle" type="button" aria-label="${escapeHtml(copyText("header.switchLanguage"))}" title="${escapeHtml(copyText("header.switchLanguage"))}" data-tooltip="${escapeHtml(copyText("header.switchLanguage"))}"><svg class="language-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.7"/><path d="M3.8 9h16.4M3.8 15h16.4M12 3.5c2.1 2.25 3.15 5.08 3.15 8.5S14.1 18.25 12 20.5C9.9 18.25 8.85 15.42 8.85 12S9.9 5.75 12 3.5Z" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg></button><form method="post" action="/dashboard/logout"><button class="logout" type="submit"><span data-i18n="header.signOut">${escapeHtml(copyText("header.signOut"))}</span></button></form></div><div class="run-status" id="run-status" aria-live="polite"></div></header>
  <section class="attention-strip${attentionCount > 0 ? " warn" : ""}" id="attention-strip"><div class="attention-icon" id="attention-icon">${attentionCount > 0 ? "!" : "✓"}</div><div class="attention-copy"><strong id="attention-title">${escapeHtml(initialAttentionTitle)}</strong><span id="attention-detail">${escapeHtml(initialAttentionDetail)}</span></div></section>
  <section class="ops-strip"><div class="ops-item"><span data-i18n="ops.lastScan">${escapeHtml(copyText("ops.lastScan"))}</span><strong id="last-scan">${escapeHtml(taipeiTime(scan.at))}</strong></div><div class="ops-item"><span data-i18n="ops.lastCompleted">${escapeHtml(copyText("ops.lastCompleted"))}</span><strong id="last-completed">${escapeHtml(taipeiTime(lastCompletedAt))}</strong></div><div class="ops-item"><span data-i18n="ops.lastSync">${escapeHtml(copyText("ops.lastSync"))}</span><strong id="last-sync" data-i18n="ops.justNow">${escapeHtml(copyText("ops.justNow"))}</strong></div></section>
  <section class="overview"><div class="overview-head"><div><div class="eyebrow" data-i18n="overview.eyebrow">${escapeHtml(copyText("overview.eyebrow"))}</div><h2 data-i18n="overview.title">${escapeHtml(copyText("overview.title"))}</h2></div><span class="overview-total" data-i18n="overview.hint">${escapeHtml(copyText("overview.hint"))}</span></div><div class="stats"><button class="stat stat-action" data-filter-target="action"><b>${counts.action}</b><span data-i18n="stat.action">${escapeHtml(copyText("stat.action"))}</span></button><button class="stat stat-active" data-filter-target="active"><b>${counts.active}</b><span data-i18n="stat.active">${escapeHtml(copyText("stat.active"))}</span></button><button class="stat stat-failed" data-filter-target="failed"><b>${counts.failed}</b><span data-i18n="stat.failed">${escapeHtml(copyText("stat.failed"))}</span></button><button class="stat stat-ready" data-filter-target="ready"><b>${counts.ready}</b><span data-i18n="stat.ready">${escapeHtml(copyText("stat.ready"))}</span></button><button class="stat stat-private" data-filter-target="private"><b>${counts.private}</b><span data-i18n="stat.private">${escapeHtml(copyText("stat.private"))}</span></button><button class="stat" data-filter-target="all"><b>${counts.all}</b><span data-i18n="stat.all">${escapeHtml(copyText("stat.all"))}</span></button></div></section>
  <section class="toolbar"><div class="toolbar-surface"><div class="search-wrap"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><input id="search" type="search" placeholder="${escapeHtml(copyText("search.placeholder"))}" data-i18n-placeholder="search.placeholder" autocomplete="off"></div><div class="filters"><button class="filter active" data-filter="all" data-i18n="filter.all">${escapeHtml(copyText("filter.all"))}</button><button class="filter" data-filter="action" data-i18n="filter.action">${escapeHtml(copyText("filter.action"))}</button><button class="filter" data-filter="active" data-i18n="filter.active">${escapeHtml(copyText("filter.active"))}</button><button class="filter" data-filter="ready" data-i18n="filter.ready">${escapeHtml(copyText("filter.ready"))}</button><button class="filter" data-filter="private" data-i18n="filter.private">${escapeHtml(copyText("filter.private"))}</button><button class="filter" data-filter="failed" data-i18n="filter.failed">${escapeHtml(copyText("filter.failed"))}</button></div></div></section>
  <div class="flow" id="list" data-revision="${escapeHtml(view.revision)}">${sectionsHtml || `<div class="empty" data-i18n="empty.playlist">${escapeHtml(copyText("empty.playlist"))}</div>`}</div><section class="activity-panel"><div class="activity-head"><div><div class="eyebrow" data-i18n="activity.eyebrow">${escapeHtml(copyText("activity.eyebrow"))}</div><h2 data-i18n="activity.title">${escapeHtml(copyText("activity.title"))}</h2></div><span class="overview-total" data-i18n="activity.latest">${escapeHtml(copyText("activity.latest"))}</span></div><div class="activity-list" id="activity-list">${activityHtml}</div></section></main><script>
  const COPY=${clientCopy};
  const filters=[...document.querySelectorAll('.filter')],statButtons=[...document.querySelectorAll('[data-filter-target]')],search=document.getElementById('search'),runButton=document.getElementById('run-now'),refreshButton=document.getElementById('refresh-now'),refreshCopy=document.getElementById('refresh-copy'),manifestStatus=document.getElementById('manifest-status'),runStatus=document.getElementById('run-status'),flow=document.getElementById('list'),subtitle=document.getElementById('dashboard-subtitle'),attentionStrip=document.getElementById('attention-strip'),attentionIcon=document.getElementById('attention-icon'),attentionTitle=document.getElementById('attention-title'),attentionDetail=document.getElementById('attention-detail'),syncPanel=document.querySelector('.sync-panel'),lastScan=document.getElementById('last-scan'),lastCompleted=document.getElementById('last-completed'),lastSync=document.getElementById('last-sync'),activityList=document.getElementById('activity-list'),languageToggle=document.getElementById('language-toggle'),shell=document.querySelector('.shell');
  const languageKey='meeting-memory-dashboard-language-v2';let language=localStorage.getItem(languageKey)==='zh'?'zh':'en';const stateKey='meeting-memory-dashboard-view-v3';let active='all',archiveOpen=false,saved={},cards=[],sections=[],archive=null,refreshing=null,lastCounts={all:${counts.all},action:${counts.action},active:${counts.active},failed:${counts.failed},ready:${counts.ready},private:${counts.private}},lastManualFailures=${manualFailures};try{saved=JSON.parse(sessionStorage.getItem(stateKey)||'{}')||{};}catch{}
  if(typeof saved.query==='string')search.value=saved.query;if(typeof saved.active==='string'&&filters.some(x=>x.dataset.filter===saved.active))active=saved.active;if(typeof saved.archiveOpen==='boolean')archiveOpen=saved.archiveOpen;
  function t(key,values={}){let output=COPY[key]?.[language]??COPY[key]?.en??key;for(const [name,value] of Object.entries(values))output=output.split('{'+name+'}').join(String(value));return output;}
  function i18nValues(node){const values={};for(const [name,value] of Object.entries(node.dataset)){if(name.startsWith('i18n')&&name!=='i18n'&&name!=='i18nPlaceholder')values[name.slice(4,5).toLowerCase()+name.slice(5)]=value;}return values;}
  function applyElement(node){const key=node.dataset.i18n;if(key)node.textContent=t(key,i18nValues(node));const placeholderKey=node.dataset.i18nPlaceholder;if(placeholderKey)node.setAttribute('placeholder',t(placeholderKey));}
  function applyLocale(root=document){root.querySelectorAll?.('[data-i18n],[data-i18n-placeholder]').forEach(applyElement);document.documentElement.lang=language==='zh'?'zh-Hant':'en';const switchLabel=t('header.switchLanguage');languageToggle.setAttribute('aria-label',switchLabel);languageToggle.setAttribute('title',switchLabel);languageToggle.dataset.tooltip=switchLabel;refreshButton.setAttribute('aria-label',t('header.refreshTitle'));refreshButton.setAttribute('title',t('header.refreshTitle'));renderAttention();syncArchive();updateRelativeTimes();}
  function setLanguage(next){language=next==='zh'?'zh':'en';localStorage.setItem(languageKey,language);languageToggle.classList.add('switching');applyLocale();if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches)shell.animate([{opacity:.94,transform:'translateY(1px)'},{opacity:1,transform:'none'}],{duration:190,easing:'cubic-bezier(.2,.8,.2,1)'});setTimeout(()=>languageToggle.classList.remove('switching'),320);}
  function refreshDynamicRefs(){cards=[...flow.querySelectorAll('.video-card')];sections=[...flow.querySelectorAll('.flow-section')];archive=flow.querySelector('[data-section="archive"]');}
  function syncArchive(forceOpen=false){if(!archive)return;const toggle=archive.querySelector('.section-toggle');const shouldOpen=forceOpen||archiveOpen||active==='private'||Boolean((search.value||'').trim());archive.classList.toggle('collapsed',!shouldOpen);if(toggle){toggle.setAttribute('aria-expanded',String(shouldOpen));toggle.dataset.i18n=shouldOpen?'section.collapse':'section.expand';applyElement(toggle);}}
  function toggleArchiveAnimated(){if(!archive)return;const body=archive.querySelector('.section-body');const opening=archive.classList.contains('collapsed');archiveOpen=opening;if(opening){syncArchive();if(body&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){body.classList.remove('archive-enter');void body.offsetWidth;body.classList.add('archive-enter');}}else if(body&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){const animation=body.animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-4px)'}],{duration:135,easing:'ease-out'});animation.finished.then(()=>{syncArchive();saveView();}).catch(()=>syncArchive());return;}else syncArchive();saveView();}
  function apply(){const q=(search.value||'').trim().toLowerCase();cards.forEach(card=>{const group=card.dataset.group;const groupMatch=active==='all'||active===group||(active==='active'&&(group==='processing'||group==='waiting'));const searchMatch=!q||(card.dataset.search||'').includes(q);card.hidden=!(groupMatch&&searchMatch);});sections.forEach(section=>{const sectionCards=[...section.querySelectorAll('.video-card')];const visible=sectionCards.filter(card=>!card.hidden).length;const isAttention=section.dataset.section==='attention';const showEmpty=isAttention&&active==='all'&&!q&&sectionCards.length===0;section.hidden=visible===0&&!showEmpty;});filters.forEach(x=>x.classList.toggle('active',x.dataset.filter===active));statButtons.forEach(x=>x.classList.toggle('active',x.dataset.filterTarget===active));syncArchive();}
  function saveView(){try{sessionStorage.setItem(stateKey,JSON.stringify({active,query:search.value||'',scrollY:window.scrollY,archiveOpen}));}catch{}}
  function chooseFilter(next,clearSearch=false){active=next||'all';if(clearSearch)search.value='';if(active==='private')archiveOpen=true;apply();saveView();}
  function renderAttention(){attentionStrip.classList.toggle('warn',lastManualFailures+lastCounts.action>0);attentionIcon.textContent=lastManualFailures+lastCounts.action>0?'!':'✓';if(lastManualFailures>0&&lastCounts.action>0)attentionTitle.textContent=t('attention.both',{failures:lastManualFailures,completed:lastCounts.action});else if(lastManualFailures>0)attentionTitle.textContent=t('attention.failureOnly',{count:lastManualFailures});else if(lastCounts.action>0)attentionTitle.textContent=t('attention.actionOnly',{count:lastCounts.action});else attentionTitle.textContent=t('attention.none');if(lastManualFailures+lastCounts.action>0)attentionDetail.textContent=t('attention.detailIssues');else if(lastCounts.active>0)attentionDetail.textContent=t('attention.detailActive',{count:lastCounts.active});else attentionDetail.textContent=t('attention.detailClean');}
  function updateRelativeTimes(){const now=Date.now();document.querySelectorAll('.retry-time').forEach(node=>{const at=Date.parse(node.dataset.retryAt||'');if(!Number.isFinite(at))return;const minutes=Math.ceil((at-now)/60000);const verb=t(node.dataset.retryKind==='retry'?'retry.retry':'retry.resume');const absolute=new Intl.DateTimeFormat(language==='zh'?'zh-TW':'en-GB',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at));const key=minutes>1?'retry.inMinutes':minutes===1?'retry.inOneMinute':minutes===0?'retry.soon':'retry.now';node.textContent=t(key,{verb,minutes,time:absolute});});document.querySelectorAll('[data-progress-percent]').forEach(node=>{const percent=node.dataset.progressPercent||'0';node.setAttribute('aria-label',language==='zh'?'轉錄進度 '+percent+'%':'Transcription progress '+percent+'%');});}
  function activityMarkup(items){return (items||[]).map(item=>'<div class="activity-item"><span class="activity-dot '+item.tone+'"></span><div><strong data-i18n="'+escapeText(item.labelKey)+'">'+escapeText(t(item.labelKey))+'</strong><span>'+escapeText(item.detail)+'</span></div><time>'+formatTaipei(item.at)+'</time></div>').join('')||'<div class="activity-empty" data-i18n="activity.empty">'+escapeText(t('activity.empty'))+'</div>';}
  function escapeText(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
  function formatTaipei(value){if(!value)return '—';const date=new Date(value);if(Number.isNaN(date.getTime()))return '—';return new Intl.DateTimeFormat(language==='zh'?'zh-TW':'en-GB',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);}
  function animateCount(node){if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;node.classList.remove('count-pop');void node.offsetWidth;node.classList.add('count-pop');}
  function updateStaticState(data){lastCounts=data.counts;lastManualFailures=data.manualFailures||0;lastScan.textContent=formatTaipei(data.lastScan?.at);lastCompleted.textContent=formatTaipei(data.lastCompletedAt);lastSync.dataset.i18n='ops.justNow';applyElement(lastSync);activityList.innerHTML=activityMarkup(data.activity);subtitle.dataset.i18nCount=String(data.counts.all);applyElement(subtitle);manifestStatus.dataset.i18nTime=data.manifestUpdatedAt;applyElement(manifestStatus);renderAttention();statButtons.forEach(button=>{const key=button.dataset.filterTarget;const value=key==='all'?data.counts.all:data.counts[key];const number=button.querySelector('b');if(number&&typeof value==='number'&&number.textContent!==String(value)){number.textContent=String(value);animateCount(number);}});}
  async function refreshDashboard(manual=false){if(refreshing)return refreshing;refreshButton.classList.add('spinning');syncPanel.classList.remove('offline','stale');refreshButton.disabled=true;refreshCopy.textContent=t(manual?'header.refreshing':'header.syncing');refreshing=(async()=>{try{const response=await fetch('/dashboard/data',{headers:{accept:'application/json'},cache:'no-store'});if(response.status===401){location.href='/dashboard';return;}const data=await response.json();if(!response.ok)throw new Error(data.error||('HTTP '+response.status));updateStaticState(data);if(data.revision!==flow.dataset.revision){flow.innerHTML=data.sectionsHtml||'<div class="empty" data-i18n="empty.playlist">'+escapeText(t('empty.playlist'))+'</div>';flow.dataset.revision=data.revision;refreshDynamicRefs();applyLocale(flow);apply();flow.classList.remove('content-updated');void flow.offsetWidth;flow.classList.add('content-updated');}refreshCopy.textContent=t('header.synced');syncPanel.classList.remove('offline','stale');syncPanel.classList.add('sync-success');setTimeout(()=>syncPanel.classList.remove('sync-success'),560);setTimeout(()=>{if(!refreshing)refreshCopy.textContent=t('header.auto');},1400);}catch(error){refreshCopy.textContent=t(navigator.onLine?'header.syncUnavailable':'header.offline');syncPanel.classList.add(navigator.onLine?'stale':'offline');lastSync.dataset.i18n='ops.syncFailed';applyElement(lastSync);console.error('Dashboard refresh failed',error);}finally{refreshButton.classList.remove('spinning');refreshButton.disabled=false;refreshing=null;}})();return refreshing;}
  refreshDynamicRefs();applyLocale();apply();requestAnimationFrame(()=>{if(Number.isFinite(Number(saved.scrollY)))window.scrollTo(0,Number(saved.scrollY)||0);});
  filters.forEach(button=>button.addEventListener('click',()=>chooseFilter(button.dataset.filter||'all')));statButtons.forEach(button=>button.addEventListener('click',()=>chooseFilter(button.dataset.filterTarget||'all',true)));search.addEventListener('input',()=>{apply();saveView();});flow.addEventListener('click',async event=>{const retry=event.target.closest?.('[data-retry-video]');if(retry){const videoId=retry.dataset.retryVideo;if(!videoId||retry.disabled)return;retry.disabled=true;retry.dataset.i18n='card.retrying';applyElement(retry);try{const response=await fetch('/dashboard/retry/'+encodeURIComponent(videoId),{method:'POST',headers:{'x-dashboard-action':'retry'}});const data=await response.json();if(!response.ok)throw new Error(data.error||('HTTP '+response.status));await refreshDashboard(true);}catch(error){runStatus.classList.add('error');runStatus.textContent=t('feedback.retryFailed',{error:error instanceof Error?error.message:String(error)});retry.disabled=false;retry.dataset.i18n='card.retryNow';applyElement(retry);}return;}const toggle=event.target.closest?.('.section-toggle');if(!toggle||!archive?.contains(toggle))return;toggleArchiveAnimated();});window.addEventListener('pagehide',saveView);
  languageToggle.addEventListener('click',()=>setLanguage(language==='en'?'zh':'en'));refreshButton.addEventListener('click',()=>{void refreshDashboard(true);});setInterval(()=>{if(!document.hidden)void refreshDashboard(false);},60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshDashboard(false);});window.addEventListener('online',()=>{void refreshDashboard(false);});window.addEventListener('offline',()=>{refreshCopy.textContent=t('header.offline');syncPanel.classList.add('offline');});setInterval(updateRelativeTimes,30000);
  runButton.addEventListener('click',async()=>{runButton.disabled=true;runStatus.classList.remove('error');runStatus.textContent=t('feedback.scanning');try{const response=await fetch('/dashboard/run',{method:'POST',headers:{'x-dashboard-action':'run'}});const data=await response.json();if(!response.ok)throw new Error(data.error||('HTTP '+response.status));runStatus.textContent=t('feedback.scanComplete',{eligible:data.eligible,claimed:data.claimed});await refreshDashboard(false);}catch(error){runStatus.classList.add('error');runStatus.textContent=t('feedback.scanFailed',{error:error instanceof Error?error.message:String(error)});}finally{runButton.disabled=false;}});
  </script></body></html>`;
}

export async function handleDashboardRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/dashboard")) return null;

  if (request.method === "POST" && url.pathname === "/dashboard/login") {
    const form = await request.formData();
    const token = String(form.get("token") || "");
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return htmlResponse(loginPage("Incorrect ADMIN_TOKEN."), 401);
    const session = await issueSession(env.ADMIN_TOKEN);
    return new Response(null, {
      status: 303,
      headers: {
        location: "/dashboard",
        "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(session)}; Path=/dashboard; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
        "cache-control": "no-store",
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/dashboard/logout") {
    return new Response(null, {
      status: 303,
      headers: {
        location: "/dashboard",
        "set-cookie": `${SESSION_COOKIE}=; Path=/dashboard; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
        "cache-control": "no-store",
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/dashboard/run") {
    if (!(await dashboardAuthorized(request, env))) return jsonResponse({ error: "unauthorized" }, 401);
    if (request.headers.get("x-dashboard-action") !== "run") return jsonResponse({ error: "missing dashboard action header" }, 400);
    try {
      return jsonResponse(await runPlaylist(env, "manual"));
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (request.method === "POST" && url.pathname.startsWith("/dashboard/retry/")) {
    if (!(await dashboardAuthorized(request, env))) return jsonResponse({ error: "unauthorized" }, 401);
    if (request.headers.get("x-dashboard-action") !== "retry") return jsonResponse({ error: "missing dashboard action header" }, 400);
    const videoId = url.pathname.slice("/dashboard/retry/".length).trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return jsonResponse({ error: "invalid video id" }, 400);
    const { manifest } = await loadManifest(env);
    const existing = manifest.videos[videoId];
    if (!existing || existing.status !== "failed") return jsonResponse({ error: "retry only applies to failed videos" }, 409);
    await makeRetryableNow(env, videoId);
    try {
      return jsonResponse(await runSingleVideo(env, videoId));
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (request.method === "GET" && url.pathname === "/dashboard/data") {
    if (!(await dashboardAuthorized(request, env))) return jsonResponse({ error: "unauthorized" }, 401);
    try {
      const { rows, manifest, lastScan } = await loadDashboardState(env);
      return jsonResponse(dashboardData(env, rows, manifest, lastScan));
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  if (request.method !== "GET" || url.pathname !== "/dashboard") return htmlResponse("Not found", 404);
  if (!(await dashboardAuthorized(request, env))) return htmlResponse(loginPage());

  const { rows, manifest, lastScan } = await loadDashboardState(env);
  return htmlResponse(renderDashboard(env, rows, manifest, lastScan));
}

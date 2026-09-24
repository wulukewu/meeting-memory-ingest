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
    };
  }
  if (entry?.status === "processing") {
    return { video, entry, group: "processing", statusLabel: "轉錄中", actionHint: "不用操作" };
  }
  if (entry?.status === "finalizing") {
    return { video, entry, group: "processing", statusLabel: "整理摘要中", actionHint: "Cloudflare Workflow 正在摘要並發布" };
  }
  if (entry?.status === "waiting") {
    if (isYouTubeBotBlocked(entry)) {
      return {
        video,
        entry,
        group: "waiting",
        statusLabel: "YouTube 冷卻中",
        actionHint: "下載出口被 YouTube 暫時阻擋；到時間後自動重試",
      };
    }
    return {
      video,
      entry,
      group: "waiting",
      statusLabel: "等待 Groq 額度",
      actionHint: "額度恢復後自動續跑",
    };
  }
  if (entry?.status === "failed") {
    if (isYouTubeBotBlocked(entry)) {
      return {
        video,
        entry,
        group: "failed",
        statusLabel: "YouTube 阻擋",
        actionHint: "目前下載出口遭 YouTube 阻擋；達重試時間後會自動再試",
      };
    }
    return {
      video,
      entry,
      group: "failed",
      statusLabel: entry.retryAfterAt ? "等待自動重試" : "需要處理",
      actionHint: entry.retryAfterAt ? "已排定自動重試，不需要人工介入" : "自動流程已停止；可查看錯誤後手動重試",
      needsManualAction: !entry.retryAfterAt,
    };
  }
  if (privacy === "private") {
    return { video, entry, group: "private", statusLabel: "Private", actionHint: "尚未排入處理" };
  }
  if (privacy === "unlisted") {
    return { video, entry, group: "ready", statusLabel: "待處理", actionHint: "Cron 會自動處理" };
  }
  return { video, entry, group: "ready", statusLabel: "未追蹤", actionHint: "目前 pipeline 只自動處理 Unlisted" };
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

function loginPage(message = ""): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meeting Memory Dashboard</title><style>
  :root{color-scheme:dark;background:#0b0d10;color:#f5f7fa;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(420px,100%);background:#13171c;border:1px solid #29313a;border-radius:18px;padding:28px;box-shadow:0 18px 50px rgba(0,0,0,.32)}h1{font-size:22px;margin:0 0 8px}p{color:#9ca8b5;line-height:1.5}.error{color:#ff9e9e}label{display:block;font-size:13px;color:#b9c3cd;margin:20px 0 8px}input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #35404b;background:#0d1116;color:#fff;font:inherit}button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;background:#f5f7fa;color:#0b0d10;font-weight:700;cursor:pointer}</style></head><body><main class="card"><h1>Meeting Memory</h1><p>輸入現有的 ADMIN_TOKEN 登入。Token 不會寫入網址或 localStorage。</p>${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}<form method="post" action="/dashboard/login"><label for="token">ADMIN_TOKEN</label><input id="token" name="token" type="password" autocomplete="current-password" required autofocus><button type="submit">開啟 Dashboard</button></form></main></body></html>`;
}

interface DashboardActivity {
  at: string;
  label: string;
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
  attentionCount: number;
  attentionText: string;
  attentionDetail: string;
  sectionsHtml: string;
  revision: string;
  activity: DashboardActivity[];
  lastCompletedAt?: string;
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
      if (entry.completedAt) return [{ at: entry.completedAt, label: "處理完成", detail: row.video.title, tone: "ok" }];
      if (entry.status === "failed" && entry.failedAt) return [{ at: entry.failedAt, label: row.needsManualAction ? "處理失敗" : "等待重試", detail: row.video.title, tone: row.needsManualAction ? "danger" : "warn" }];
      if (entry.status === "waiting" && entry.updatedAt) return [{ at: entry.updatedAt, label: isYouTubeBotBlocked(entry) ? "YouTube 冷卻" : "Groq 冷卻", detail: row.video.title, tone: "warn" }];
      if (entry.status === "finalizing" && entry.updatedAt) return [{ at: entry.updatedAt, label: "開始整理摘要", detail: row.video.title, tone: "info" }];
      if (entry.startedAt) return [{ at: entry.startedAt, label: "開始處理", detail: row.video.title, tone: "info" }];
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
    const privacyClass = video.privacyStatus.toLowerCase() === "private" ? "muted" : video.privacyStatus.toLowerCase() === "unlisted" ? "warn" : "ok";
    const error = entry?.lastError ? `<details class="error-details"><summary>錯誤資訊</summary><pre>${escapeHtml(entry.lastError)}</pre></details>` : "";
    const retry = row.group === "failed" && row.needsManualAction
      ? `<button class="retry-control" type="button" data-retry-video="${escapeHtml(video.id)}">重新嘗試</button>`
      : "";
    const retryVerb = isYouTubeBotBlocked(entry) ? "重試" : "續跑";
    const waiting = entry?.retryAfterAt
      ? `<span class="subtle retry-time" data-retry-at="${escapeHtml(entry.retryAfterAt)}" data-retry-verb="${retryVerb}">${retryVerb} ${escapeHtml(taipeiTime(entry.retryAfterAt))}</span>`
      : "";
    const percent = progressPercent(entry);
    const progress = percent !== undefined
      ? `<div class="progress-row"><div class="progress-track" aria-label="轉錄進度 ${percent}%"><span class="progress-fill" style="width:${percent}%"></span></div><span>${percent}%</span></div>`
      : "";
    return `<article class="video-card" data-group="${row.group}" data-search="${escapeHtml(`${video.title} ${video.id}`.toLowerCase())}">
      <div class="topline"><div class="title-wrap"><h3>${escapeHtml(video.title)}</h3><div class="meta"><span>${escapeHtml(durationLabel(video.durationSeconds))}</span><span class="badge ${privacyClass}">${escapeHtml(video.privacyStatus)}</span></div></div><span class="status status-${row.group}">${escapeHtml(row.statusLabel)}</span></div>
      <div class="status-grid"><div><span class="label">建議</span><strong>${escapeHtml(row.actionHint)}</strong></div><div><span class="label">進度</span><strong>${escapeHtml(progressLabel(entry))}</strong>${progress}${waiting}</div><div><span class="label">更新</span><strong>${escapeHtml(taipeiTime(rowUpdatedAt(entry)))}</strong></div></div>
      ${error}
      <div class="card-footer"><div class="links"><a class="primary" href="${studio}" target="_blank" rel="noreferrer">Studio 編輯</a><a href="${playlist}" target="_blank" rel="noreferrer">Playlist</a><a href="${watch}" target="_blank" rel="noreferrer">YouTube</a>${transcript ? `<a href="${transcript}" target="_blank" rel="noreferrer">Transcript</a>` : ""}${retry}</div><span class="video-id" title="Video ID">${escapeHtml(video.id)}</span></div>
    </article>`;
  };

  const section = (
    id: string,
    eyebrow: string,
    title: string,
    description: string,
    groups: DashboardGroup[],
    collapsible = false,
  ): string => {
    const sectionRows = rows.filter((row) => groups.includes(row.group));
    const count = sectionRows.length;
    const empty = id === "attention"
      ? '<div class="section-empty">目前沒有需要你處理的項目。</div>'
      : '<div class="section-empty">目前沒有項目。</div>';
    return `<section class="flow-section${collapsible ? " collapsible collapsed" : ""}" data-section="${id}" data-groups="${groups.join(",")}">
      <div class="section-head"><div><div class="eyebrow">${eyebrow}</div><h2>${title}<span class="section-count">${count}</span></h2><p>${description}</p></div>${collapsible ? '<button class="section-toggle" type="button" aria-expanded="false">展開</button>' : ""}</div>
      <div class="section-body">${sectionRows.map(renderCard).join("") || empty}</div>
    </section>`;
  };

  const attentionText = attentionCount > 0
    ? `${manualFailures ? `${manualFailures} 個失敗需要處理` : ""}${manualFailures && counts.action ? " · " : ""}${counts.action ? `${counts.action} 支已完成待收回` : ""}`
    : "目前沒有需要你介入的項目";
  const attentionDetail = attentionCount > 0
    ? "需要處理的項目已排在最前面；等待與自動重試不列入人工介入。"
    : counts.active > 0 ? `系統正在處理 ${counts.active} 支影片，可以先不用管它。` : "目前流程是乾淨的，沒有異常或待收尾項目。";

  const sectionsHtml = [
    section("attention", "Needs attention", "需要處理", "只有需要人工確認或收尾的項目會出現在這裡。", ["failed", "action"]),
    section("active", "In progress", "正在處理", "轉錄、摘要與冷卻等待中的工作。", ["processing", "waiting"]),
    section("queue", "Queue", "待處理", "已進 Playlist、等待自動 pipeline 接手。", ["ready"]),
    section("archive", "Archive", "其他影片", "Private 或目前不需要關注的項目，預設收起。", ["private"], true),
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

  return { counts, attentionCount, attentionText, attentionDetail, sectionsHtml, revision, activity, lastCompletedAt };
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
  const { counts, attentionCount, attentionText, attentionDetail, sectionsHtml, activity, lastCompletedAt } = view;
  const scan = parseLastScan(lastScan);
  const activityHtml = activity.map((item) => `<div class="activity-item"><span class="activity-dot ${item.tone}"></span><div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail)}</span></div><time>${escapeHtml(taipeiTime(item.at))}</time></div>`).join("") || '<div class="activity-empty">還沒有近期事件。</div>';

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meeting Memory Dashboard</title><style>
  :root{color-scheme:dark;--bg:#090b0e;--panel:#101419;--panel-raised:#13181e;--panel-soft:#0c1014;--line:#232c35;--line-soft:#1b232b;--text:#f4f7f9;--muted:#8b98a5;--muted-2:#687683;--success:#83dfa5;--blue:#83c7ff;--warn:#edc96c;--danger:#ff9898;--violet:#c5b7ff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% -20%,#17202a 0,transparent 36rem),var(--bg);color:var(--text)}button,input{font:inherit}.shell{width:min(1180px,calc(100% - 36px));margin:0 auto;padding:30px 0 64px}.page-header{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"brand actions" "feedback feedback";gap:18px 28px;align-items:center;margin-bottom:22px}.brand{grid-area:brand;min-width:0}.eyebrow{font-size:10px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:#718090;margin-bottom:7px}h1{font-size:30px;line-height:1.05;letter-spacing:-.035em;margin:0}.subtitle{color:var(--muted);margin:8px 0 0;font-size:14px;line-height:1.5}.header-actions{grid-area:actions;display:flex;gap:9px;align-items:center;justify-content:flex-end;flex-wrap:wrap}.sync-panel{display:flex;align-items:center;gap:10px;min-height:42px;padding:6px 7px 6px 11px;border:1px solid var(--line);border-radius:12px;background:rgba(16,20,25,.82);box-shadow:0 8px 24px rgba(0,0,0,.14)}.sync-dot{width:7px;height:7px;border-radius:999px;background:var(--success);box-shadow:0 0 0 4px rgba(131,223,165,.08);flex:0 0 auto}.sync-copy{display:grid;gap:1px;min-width:128px}.sync-copy strong{font-size:12px;font-weight:650;color:#dbe4eb}.sync-copy span{font-size:10px;color:#73818e}.icon-control{width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:#98a5b1;cursor:pointer;transition:background .16s ease,color .16s ease,transform .16s ease}.icon-control:hover{background:#1b2229;color:#f3f6f8}.icon-control:active{transform:scale(.96)}.icon-control svg{width:15px;height:15px}.icon-control.spinning svg{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.control,.logout{border-radius:11px;cursor:pointer;font-size:13px;transition:transform .16s ease,background .16s ease,border-color .16s ease,color .16s ease}.control{min-height:42px;padding:0 15px;border:1px solid #e9eef2;background:#edf2f5;color:#0a0d10;font-weight:750;box-shadow:0 6px 20px rgba(0,0,0,.14)}.control:hover{background:#fff}.control:active{transform:translateY(1px)}.control:disabled{opacity:.55;cursor:wait}.logout{min-height:42px;padding:0 11px;border:1px solid transparent;background:transparent;color:#84919d}.logout:hover{background:#13191f;color:#d5dde4;border-color:#202932}.run-status{grid-area:feedback;font-size:12px;color:#8f9daa;min-height:0;text-align:right;margin-top:-8px}.run-status:not(:empty){min-height:18px}.run-status.error{color:var(--danger)}.attention-strip{display:flex;gap:13px;align-items:center;border:1px solid #21302a;border-radius:15px;background:linear-gradient(180deg,rgba(18,38,28,.66),rgba(13,25,19,.66));padding:14px 16px;margin-bottom:18px}.attention-strip.warn{border-color:#473026;background:linear-gradient(180deg,rgba(56,31,24,.72),rgba(35,22,19,.7))}.attention-icon{width:30px;height:30px;border-radius:10px;display:grid;place-items:center;flex:0 0 auto;background:#152c20;color:var(--success);font-weight:800}.attention-strip.warn .attention-icon{background:#3a211a;color:#ffb49a}.attention-copy{display:grid;gap:3px}.attention-copy strong{font-size:13px}.attention-copy span{font-size:11px;color:#8f9c97;line-height:1.45}.overview{margin-bottom:12px}.overview-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin:0 2px 10px}.overview-head h2{font-size:14px;margin:0;letter-spacing:-.01em}.overview-total{font-size:11px;color:#71808d}.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:9px}.stat{appearance:none;text-align:left;color:inherit;position:relative;overflow:hidden;background:linear-gradient(180deg,#11161b,#0f1318);border:1px solid var(--line-soft);border-radius:14px;padding:14px 14px 13px;min-height:78px;cursor:pointer;transition:border-color .16s ease,transform .16s ease,background .16s ease}.stat:hover{border-color:#33404b;background:#13191f}.stat:active{transform:translateY(1px)}.stat::before{content:"";position:absolute;inset:0 auto 0 0;width:2px;background:#44515d}.stat-action::before{background:var(--success)}.stat-active::before{background:var(--blue)}.stat-failed::before{background:var(--danger)}.stat-ready::before{background:var(--violet)}.stat-private::before{background:#788592}.stat.active{border-color:#45525d;background:#171e24}.stat b{font-size:23px;line-height:1;letter-spacing:-.025em;display:block;margin-bottom:8px}.stat span{font-size:11px;color:#7f8d99;line-height:1.3}.toolbar{position:sticky;top:0;z-index:5;padding:12px 0 14px;background:linear-gradient(180deg,rgba(9,11,14,.98) 0,rgba(9,11,14,.93) 76%,rgba(9,11,14,0) 100%);backdrop-filter:blur(14px)}.toolbar-surface{display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--line-soft);border-radius:14px;background:rgba(15,19,24,.94);box-shadow:0 10px 30px rgba(0,0,0,.16)}.search-wrap{position:relative;flex:1;min-width:180px}.search-wrap svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);width:15px;height:15px;color:#687783;pointer-events:none}.toolbar input{width:100%;height:38px;background:#0c1014;border:1px solid #202a33;color:#f4f7f9;border-radius:9px;padding:0 12px 0 34px;outline:none}.toolbar input:focus{border-color:#465563;box-shadow:0 0 0 3px rgba(123,147,169,.08)}.toolbar input::placeholder{color:#596672}.filters{display:flex;gap:5px;align-items:center;overflow-x:auto;scrollbar-width:none}.filters::-webkit-scrollbar{display:none}.filter{height:34px;background:transparent;border:1px solid transparent;color:#84929f;border-radius:8px;padding:0 10px;cursor:pointer;font-size:12px;white-space:nowrap}.filter:hover{background:#171d23;color:#c2ccd4}.filter.active{background:#202830;color:#f3f6f8;border-color:#29343e}.flow{display:grid;gap:26px}.flow-section{display:grid;gap:10px}.flow-section[hidden]{display:none}.section-head{display:flex;justify-content:space-between;align-items:end;gap:20px;padding:0 2px}.section-head h2{display:flex;align-items:center;gap:8px;font-size:17px;line-height:1.2;margin:0;letter-spacing:-.015em}.section-count{font-size:10px;color:#8795a1;border:1px solid #27313a;background:#11171c;border-radius:999px;padding:3px 7px;font-weight:650}.section-head p{margin:6px 0 0;color:#6e7b87;font-size:11px;line-height:1.45}.section-toggle{border:1px solid #28333d;background:#11171c;color:#9eabb6;border-radius:9px;padding:7px 10px;font-size:11px;cursor:pointer}.section-body{display:grid;gap:10px}.flow-section.collapsed .section-body{display:none}.section-empty{padding:22px 18px;border:1px dashed #21302a;border-radius:14px;background:#0d1210;color:#6f8378;font-size:12px}.video-card{position:relative;background:linear-gradient(180deg,#101419,#0f1317);border:1px solid #202932;border-radius:16px;padding:18px;box-shadow:0 8px 28px rgba(0,0,0,.09);transition:border-color .16s ease,background .16s ease}.video-card:hover{border-color:#2d3944;background:#11161b}.video-card[hidden]{display:none}.topline{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.title-wrap{min-width:0}h3{font-size:16px;margin:0 0 8px;line-height:1.45;letter-spacing:-.01em}.meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:11px;color:#71808d}.badge,.status{font-size:10px;border-radius:999px;padding:4px 8px;white-space:nowrap}.badge{background:#1a222a}.badge.warn{color:#e8c86d;background:#292416}.badge.ok{color:#82dba2;background:#14251b}.badge.muted{color:#9ba7b2;background:#1a2025}.status{height:max-content;font-weight:700;border:1px solid transparent}.status-action{background:#132b1d;color:#88e0a7;border-color:#1a4028}.status-processing{background:#11283a;color:#8bc8f5;border-color:#173b55}.status-waiting{background:#2a2413;color:#e8c86e;border-color:#443a1d}.status-failed{background:#301819;color:#ff9d9d;border-color:#4a2223}.status-ready{background:#242138;color:#c7baff;border-color:#373153}.status-private{background:#1c2227;color:#9ba8b2;border-color:#2b333a}.status-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;margin:15px 0}.status-grid>div{background:#0c1014;border:1px solid #1a2229;border-radius:10px;padding:10px 11px}.label{display:block;color:#61707d;font-size:10px;font-weight:650;letter-spacing:.04em;margin-bottom:5px}.status-grid strong{font-size:12px;line-height:1.45;color:#cdd6dd;font-weight:620}.subtle{display:block;color:#788692;font-size:10px;margin-top:5px}.progress-row{display:flex;align-items:center;gap:7px;margin-top:7px;color:#74828e;font-size:9px}.progress-track{height:4px;flex:1;overflow:hidden;border-radius:999px;background:#1b242c}.progress-fill{display:block;height:100%;border-radius:inherit;background:#72bdf1}.card-footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.links{display:flex;gap:7px;flex-wrap:wrap}.links a{color:#9eabb6;text-decoration:none;border:1px solid #26313a;border-radius:9px;padding:7px 10px;font-size:11px;transition:background .15s ease,border-color .15s ease,color .15s ease}.links a:hover{background:#161d23;border-color:#35424d;color:#e4eaee}.links a.primary{background:#17202a;color:#d9e3ea;border-color:#2b3945;font-weight:650}.retry-control{color:#ffc0b6;border:1px solid #4b2b29;border-radius:9px;padding:7px 10px;font-size:11px;background:#251716;cursor:pointer}.retry-control:hover{background:#321d1b}.ops-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:0 0 18px}.ops-item{border:1px solid var(--line-soft);background:#0e1317;border-radius:12px;padding:10px 12px}.ops-item span{display:block;color:#667581;font-size:9px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}.ops-item strong{font-size:11px;color:#b9c5ce}.activity-panel{border:1px solid var(--line-soft);background:#0e1216;border-radius:15px;padding:15px;margin-top:2px}.activity-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:10px}.activity-head h2{font-size:14px;margin:0}.activity-list{display:grid}.activity-item{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 2px;border-top:1px solid #182027}.activity-item:first-child{border-top:0}.activity-dot{width:6px;height:6px;border-radius:999px;background:#7d8b96}.activity-dot.ok{background:var(--success)}.activity-dot.info{background:var(--blue)}.activity-dot.warn{background:var(--warn)}.activity-dot.danger{background:var(--danger)}.activity-item div{display:grid;gap:2px}.activity-item strong{font-size:11px}.activity-item span,.activity-item time{font-size:10px;color:#6f7d89}.activity-item time{white-space:nowrap}.activity-empty{font-size:11px;color:#6f7d89;padding:8px 2px}.sync-panel.stale .sync-dot{background:var(--warn);box-shadow:0 0 0 4px rgba(237,201,108,.08)}.sync-panel.offline .sync-dot{background:var(--danger);box-shadow:0 0 0 4px rgba(255,152,152,.08)}.video-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#46535e;font-size:9px;opacity:.72}.error-details{margin:10px 0 12px;color:#d9a3a3;font-size:11px}.error-details summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0a0d10;border:1px solid #241a1b;padding:10px;border-radius:9px;color:#c7a3a3}.empty{padding:44px 28px;text-align:center;color:#73808c;border:1px dashed #26313a;border-radius:15px;background:#0d1115}@media(max-width:900px){.page-header{grid-template-columns:1fr;grid-template-areas:"brand" "actions" "feedback";gap:14px}.header-actions{justify-content:flex-start}.run-status{text-align:left;margin-top:-4px}.stats{grid-template-columns:repeat(3,1fr)}.toolbar-surface{align-items:stretch;flex-direction:column}.search-wrap{width:100%}.filters{width:100%}}@media(max-width:620px){.ops-strip{grid-template-columns:1fr}.activity-item{grid-template-columns:8px minmax(0,1fr)}.activity-item time{grid-column:2}.shell{width:min(100% - 20px,1180px);padding-top:20px}.header-actions{display:grid;grid-template-columns:1fr auto auto;width:100%}.sync-panel{grid-column:1/-1}.control{width:100%}.stats{grid-template-columns:repeat(2,1fr)}.toolbar{margin:0 -2px}.status-grid{grid-template-columns:1fr 1fr}.status-grid>div:first-child{grid-column:1/-1}.topline{gap:10px}h1{font-size:27px}.video-card{padding:15px}.card-footer{align-items:flex-end}.video-id{display:none}.section-head p{max-width:290px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}.icon-control.spinning svg{animation:none}}
  </style></head><body><main class="shell"><header class="page-header"><div class="brand"><div class="eyebrow">AI Memory · Ingest</div><h1>Meeting Memory</h1><p class="subtitle" id="dashboard-subtitle">監看轉錄、摘要與收尾狀態 · 目前可見 ${counts.all} 支影片</p></div><div class="header-actions"><div class="sync-panel"><span class="sync-dot" aria-hidden="true"></span><div class="sync-copy"><strong id="refresh-copy">自動更新中</strong><span id="manifest-status">Manifest ${escapeHtml(taipeiTime(manifest.updatedAt))} · 60 秒更新</span></div><button class="icon-control" id="refresh-now" type="button" aria-label="重新整理" title="重新整理"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 8.3A7 7 0 0 1 18.7 7L20 11M4 13l1.3 4A7 7 0 0 0 17.9 15.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div><button class="control" id="run-now" type="button">掃描 Playlist</button><form method="post" action="/dashboard/logout"><button class="logout" type="submit">登出</button></form></div><div class="run-status" id="run-status" aria-live="polite"></div></header>
  <section class="attention-strip${attentionCount > 0 ? " warn" : ""}" id="attention-strip"><div class="attention-icon" id="attention-icon">${attentionCount > 0 ? "!" : "✓"}</div><div class="attention-copy"><strong id="attention-title">${escapeHtml(attentionText)}</strong><span id="attention-detail">${escapeHtml(attentionDetail)}</span></div></section>
  <section class="ops-strip"><div class="ops-item"><span>Last scan</span><strong id="last-scan">${escapeHtml(taipeiTime(scan.at))}</strong></div><div class="ops-item"><span>Last completed</span><strong id="last-completed">${escapeHtml(taipeiTime(lastCompletedAt))}</strong></div><div class="ops-item"><span>Last sync</span><strong id="last-sync">剛剛</strong></div></section>
  <section class="overview"><div class="overview-head"><div><div class="eyebrow">Overview</div><h2>目前狀態</h2></div><span class="overview-total">點數字即可篩選</span></div><div class="stats"><button class="stat stat-action" data-filter-target="action"><b>${counts.action}</b><span>已完成，可收回</span></button><button class="stat stat-active" data-filter-target="active"><b>${counts.active}</b><span>處理中 / 等待</span></button><button class="stat stat-failed" data-filter-target="failed"><b>${counts.failed}</b><span>失敗</span></button><button class="stat stat-ready" data-filter-target="ready"><b>${counts.ready}</b><span>待處理</span></button><button class="stat stat-private" data-filter-target="private"><b>${counts.private}</b><span>Private</span></button><button class="stat" data-filter-target="all"><b>${counts.all}</b><span>目前可見</span></button></div></section>
  <section class="toolbar"><div class="toolbar-surface"><div class="search-wrap"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><input id="search" type="search" placeholder="搜尋標題或 video ID" autocomplete="off"></div><div class="filters"><button class="filter active" data-filter="all">全部</button><button class="filter" data-filter="action">可收回</button><button class="filter" data-filter="active">處理中</button><button class="filter" data-filter="ready">待處理</button><button class="filter" data-filter="private">Private</button><button class="filter" data-filter="failed">失敗</button></div></div></section>
  <div class="flow" id="list" data-revision="${escapeHtml(view.revision)}">${sectionsHtml || '<div class="empty">目前沒有可顯示的 playlist 影片。</div>'}</div><section class="activity-panel"><div class="activity-head"><div><div class="eyebrow">Activity</div><h2>最近事件</h2></div><span class="overview-total">最近 8 筆</span></div><div class="activity-list" id="activity-list">${activityHtml}</div></section></main><script>
  const filters=[...document.querySelectorAll('.filter')],statButtons=[...document.querySelectorAll('[data-filter-target]')],search=document.getElementById('search'),runButton=document.getElementById('run-now'),refreshButton=document.getElementById('refresh-now'),refreshCopy=document.getElementById('refresh-copy'),manifestStatus=document.getElementById('manifest-status'),runStatus=document.getElementById('run-status'),flow=document.getElementById('list'),subtitle=document.getElementById('dashboard-subtitle'),attentionStrip=document.getElementById('attention-strip'),attentionIcon=document.getElementById('attention-icon'),attentionTitle=document.getElementById('attention-title'),attentionDetail=document.getElementById('attention-detail'),syncPanel=document.querySelector('.sync-panel'),lastScan=document.getElementById('last-scan'),lastCompleted=document.getElementById('last-completed'),lastSync=document.getElementById('last-sync'),activityList=document.getElementById('activity-list');
  const stateKey='meeting-memory-dashboard-view-v3';let active='all',archiveOpen=false,saved={},cards=[],sections=[],archive=null,refreshing=null;try{saved=JSON.parse(sessionStorage.getItem(stateKey)||'{}')||{};}catch{}
  if(typeof saved.query==='string')search.value=saved.query;if(typeof saved.active==='string'&&filters.some(x=>x.dataset.filter===saved.active))active=saved.active;if(typeof saved.archiveOpen==='boolean')archiveOpen=saved.archiveOpen;
  function refreshDynamicRefs(){cards=[...flow.querySelectorAll('.video-card')];sections=[...flow.querySelectorAll('.flow-section')];archive=flow.querySelector('[data-section="archive"]');}
  function syncArchive(forceOpen=false){if(!archive)return;const toggle=archive.querySelector('.section-toggle');const shouldOpen=forceOpen||archiveOpen||active==='private'||Boolean((search.value||'').trim());archive.classList.toggle('collapsed',!shouldOpen);toggle?.setAttribute('aria-expanded',String(shouldOpen));if(toggle)toggle.textContent=shouldOpen?'收起':'展開';}
  function apply(){const q=(search.value||'').trim().toLowerCase();cards.forEach(card=>{const group=card.dataset.group;const groupMatch=active==='all'||active===group||(active==='active'&&(group==='processing'||group==='waiting'));const searchMatch=!q||(card.dataset.search||'').includes(q);card.hidden=!(groupMatch&&searchMatch);});sections.forEach(section=>{const sectionCards=[...section.querySelectorAll('.video-card')];const visible=sectionCards.filter(card=>!card.hidden).length;const isAttention=section.dataset.section==='attention';const showEmpty=isAttention&&active==='all'&&!q&&sectionCards.length===0;section.hidden=visible===0&&!showEmpty;});filters.forEach(x=>x.classList.toggle('active',x.dataset.filter===active));statButtons.forEach(x=>x.classList.toggle('active',x.dataset.filterTarget===active));syncArchive();}
  function saveView(){try{sessionStorage.setItem(stateKey,JSON.stringify({active,query:search.value||'',scrollY:window.scrollY,archiveOpen}));}catch{}}
  function chooseFilter(next,clearSearch=false){active=next||'all';if(clearSearch)search.value='';if(active==='private')archiveOpen=true;apply();saveView();}
  function updateRelativeTimes(){const now=Date.now();document.querySelectorAll('.retry-time').forEach(node=>{const at=Date.parse(node.dataset.retryAt||'');if(!Number.isFinite(at))return;const minutes=Math.ceil((at-now)/60000);const verb=node.dataset.retryVerb||'重試';const absolute=new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at));node.textContent=minutes>1?minutes+' 分鐘後'+verb+' · '+absolute:minutes===1?'約 1 分鐘後'+verb+' · '+absolute:minutes===0?'即將'+verb+' · '+absolute:verb+'時間已到 · '+absolute;});}
  function activityMarkup(items){return (items||[]).map(item=>'<div class="activity-item"><span class="activity-dot '+item.tone+'"></span><div><strong>'+escapeText(item.label)+'</strong><span>'+escapeText(item.detail)+'</span></div><time>'+formatTaipei(item.at)+'</time></div>').join('')||'<div class="activity-empty">還沒有近期事件。</div>';}
  function escapeText(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
  function formatTaipei(value){if(!value)return '—';const date=new Date(value);if(Number.isNaN(date.getTime()))return '—';return new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);}
  function updateStaticState(data){lastScan.textContent=formatTaipei(data.lastScan?.at);lastCompleted.textContent=formatTaipei(data.lastCompletedAt);lastSync.textContent='剛剛';activityList.innerHTML=activityMarkup(data.activity);subtitle.textContent='監看轉錄、摘要與收尾狀態 · 目前可見 '+data.counts.all+' 支影片';manifestStatus.textContent='Manifest '+data.manifestUpdatedAt+' · 60 秒更新';attentionStrip.classList.toggle('warn',data.attentionCount>0);attentionIcon.textContent=data.attentionCount>0?'!':'✓';attentionTitle.textContent=data.attentionText;attentionDetail.textContent=data.attentionDetail;statButtons.forEach(button=>{const key=button.dataset.filterTarget;const value=key==='all'?data.counts.all:data.counts[key];const number=button.querySelector('b');if(number&&typeof value==='number')number.textContent=String(value);});}
  async function refreshDashboard(manual=false){if(refreshing)return refreshing;refreshButton.classList.add('spinning');syncPanel.classList.remove('offline','stale');refreshButton.disabled=true;refreshCopy.textContent=manual?'更新中…':'同步中…';refreshing=(async()=>{try{const response=await fetch('/dashboard/data',{headers:{accept:'application/json'},cache:'no-store'});if(response.status===401){location.href='/dashboard';return;}const data=await response.json();if(!response.ok)throw new Error(data.error||('HTTP '+response.status));updateStaticState(data);if(data.revision!==flow.dataset.revision){flow.innerHTML=data.sectionsHtml||'<div class="empty">目前沒有可顯示的 playlist 影片。</div>';flow.dataset.revision=data.revision;refreshDynamicRefs();apply();updateRelativeTimes();}refreshCopy.textContent='已同步';syncPanel.classList.remove('offline','stale');setTimeout(()=>{if(!refreshing)refreshCopy.textContent='自動更新中';},1400);}catch(error){refreshCopy.textContent=navigator.onLine?'暫時無法同步':'網路已離線';syncPanel.classList.add(navigator.onLine?'stale':'offline');lastSync.textContent='同步失敗';console.error('Dashboard refresh failed',error);}finally{refreshButton.classList.remove('spinning');refreshButton.disabled=false;refreshing=null;}})();return refreshing;}
  refreshDynamicRefs();apply();updateRelativeTimes();requestAnimationFrame(()=>{if(Number.isFinite(Number(saved.scrollY)))window.scrollTo(0,Number(saved.scrollY)||0);});
  filters.forEach(button=>button.addEventListener('click',()=>chooseFilter(button.dataset.filter||'all')));statButtons.forEach(button=>button.addEventListener('click',()=>chooseFilter(button.dataset.filterTarget||'all',true)));search.addEventListener('input',()=>{apply();saveView();});flow.addEventListener('click',async event=>{const retry=event.target.closest?.('[data-retry-video]');if(retry){const videoId=retry.dataset.retryVideo;if(!videoId||retry.disabled)return;retry.disabled=true;retry.textContent='重試中…';try{const response=await fetch('/dashboard/retry/'+encodeURIComponent(videoId),{method:'POST',headers:{'x-dashboard-action':'retry'}});const data=await response.json();if(!response.ok)throw new Error(data.error||('HTTP '+response.status));await refreshDashboard(true);}catch(error){runStatus.classList.add('error');runStatus.textContent='重試失敗：'+(error instanceof Error?error.message:String(error));retry.disabled=false;retry.textContent='重新嘗試';}return;}const toggle=event.target.closest?.('.section-toggle');if(!toggle||!archive?.contains(toggle))return;archiveOpen=archive.classList.contains('collapsed');syncArchive();saveView();});window.addEventListener('pagehide',saveView);
  refreshButton.addEventListener('click',()=>{void refreshDashboard(true);});setInterval(()=>{if(!document.hidden)void refreshDashboard(false);},60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshDashboard(false);});window.addEventListener('online',()=>{void refreshDashboard(false);});window.addEventListener('offline',()=>{refreshCopy.textContent='網路已離線';syncPanel.classList.add('offline');});setInterval(updateRelativeTimes,30000);
  runButton.addEventListener('click',async()=>{runButton.disabled=true;runStatus.classList.remove('error');runStatus.textContent='正在掃描 Playlist…';try{const response=await fetch('/dashboard/run',{method:'POST',headers:{'x-dashboard-action':'run'}});const data=await response.json();if(!response.ok)throw new Error(data.error||('HTTP '+response.status));runStatus.textContent='掃描完成：發現 '+data.eligible+' 支可處理，觸發 '+data.claimed+' 支。';await refreshDashboard(false);}catch(error){runStatus.classList.add('error');runStatus.textContent='觸發失敗：'+(error instanceof Error?error.message:String(error));}finally{runButton.disabled=false;}});
  </script></body></html>`;
}

export async function handleDashboardRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/dashboard")) return null;

  if (request.method === "POST" && url.pathname === "/dashboard/login") {
    const form = await request.formData();
    const token = String(form.get("token") || "");
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return htmlResponse(loginPage("ADMIN_TOKEN 不正確。"), 401);
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

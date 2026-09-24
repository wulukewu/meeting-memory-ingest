import type { Env, Manifest, ManifestEntry, VideoRecord } from "./types";
import { loadManifest } from "./state";
import { runPlaylist } from "./pipeline";
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
      statusLabel: "失敗",
      actionHint: "達重試時間後會自動再試；可展開錯誤資訊確認原因",
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

function stateRank(group: DashboardGroup): number {
  return { action: 0, processing: 1, waiting: 2, failed: 3, ready: 4, private: 5 }[group];
}

function loginPage(message = ""): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meeting Memory Dashboard</title><style>
  :root{color-scheme:dark;background:#0b0d10;color:#f5f7fa;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(420px,100%);background:#13171c;border:1px solid #29313a;border-radius:18px;padding:28px;box-shadow:0 18px 50px rgba(0,0,0,.32)}h1{font-size:22px;margin:0 0 8px}p{color:#9ca8b5;line-height:1.5}.error{color:#ff9e9e}label{display:block;font-size:13px;color:#b9c3cd;margin:20px 0 8px}input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #35404b;background:#0d1116;color:#fff;font:inherit}button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;background:#f5f7fa;color:#0b0d10;font-weight:700;cursor:pointer}</style></head><body><main class="card"><h1>Meeting Memory</h1><p>輸入現有的 ADMIN_TOKEN 登入。Token 不會寫入網址或 localStorage。</p>${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}<form method="post" action="/dashboard/login"><label for="token">ADMIN_TOKEN</label><input id="token" name="token" type="password" autocomplete="current-password" required autofocus><button type="submit">開啟 Dashboard</button></form></main></body></html>`;
}

function renderDashboard(env: Env, rows: DashboardRow[], manifest: Manifest): string {
  const counts = {
    all: rows.length,
    action: rows.filter((row) => row.group === "action").length,
    active: rows.filter((row) => row.group === "processing" || row.group === "waiting").length,
    failed: rows.filter((row) => row.group === "failed").length,
    ready: rows.filter((row) => row.group === "ready").length,
    private: rows.filter((row) => row.group === "private").length,
  };
  const cards = rows
    .map((row) => {
      const { video, entry } = row;
      const studio = `https://studio.youtube.com/video/${encodeURIComponent(video.id)}/edit`;
      const playlist = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}&list=${encodeURIComponent(env.YOUTUBE_PLAYLIST_ID)}`;
      const watch = `https://youtu.be/${encodeURIComponent(video.id)}`;
      const transcript = entry?.path
        ? `https://github.com/${encodeURIComponent(env.AI_MEMORY_OWNER)}/${encodeURIComponent(env.AI_MEMORY_REPO)}/blob/${encodeURIComponent(env.AI_MEMORY_BRANCH)}/${entry.path.split("/").map(encodeURIComponent).join("/")}`
        : "";
      const privacyClass = video.privacyStatus.toLowerCase() === "private" ? "muted" : video.privacyStatus.toLowerCase() === "unlisted" ? "warn" : "ok";
      const error = entry?.lastError ? `<details><summary>錯誤資訊</summary><pre>${escapeHtml(entry.lastError)}</pre></details>` : "";
      const waiting = entry?.status === "waiting" && entry.retryAfterAt
        ? `<span class="subtle">${isYouTubeBotBlocked(entry) ? "重試" : "續跑"} ${escapeHtml(taipeiTime(entry.retryAfterAt))}</span>`
        : "";
      return `<article class="video-card" data-group="${row.group}" data-search="${escapeHtml(`${video.title} ${video.id}`.toLowerCase())}">
        <div class="topline"><div class="title-wrap"><h2>${escapeHtml(video.title)}</h2><div class="meta"><span>${escapeHtml(durationLabel(video.durationSeconds))}</span><span>${escapeHtml(video.id)}</span><span class="badge ${privacyClass}">${escapeHtml(video.privacyStatus)}</span></div></div><span class="status status-${row.group}">${escapeHtml(row.statusLabel)}</span></div>
        <div class="status-grid"><div><span class="label">建議</span><strong>${escapeHtml(row.actionHint)}</strong></div><div><span class="label">進度</span><strong>${escapeHtml(progressLabel(entry))}</strong>${waiting}</div><div><span class="label">更新</span><strong>${escapeHtml(taipeiTime(rowUpdatedAt(entry)))}</strong></div></div>
        ${error}
        <div class="links"><a class="primary" href="${studio}" target="_blank" rel="noreferrer">Studio 編輯</a><a href="${playlist}" target="_blank" rel="noreferrer">Playlist</a><a href="${watch}" target="_blank" rel="noreferrer">YouTube</a>${transcript ? `<a href="${transcript}" target="_blank" rel="noreferrer">Transcript</a>` : ""}</div>
      </article>`;
    })
    .join("");

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meeting Memory Dashboard</title><style>
  :root{color-scheme:dark;--bg:#090b0e;--panel:#101419;--panel-raised:#13181e;--panel-soft:#0c1014;--line:#232c35;--line-soft:#1b232b;--text:#f4f7f9;--muted:#8b98a5;--muted-2:#687683;--success:#83dfa5;--blue:#83c7ff;--warn:#edc96c;--danger:#ff9898;--violet:#c5b7ff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% -20%,#17202a 0,transparent 36rem),var(--bg);color:var(--text)}button,input{font:inherit}.shell{width:min(1180px,calc(100% - 36px));margin:0 auto;padding:30px 0 64px}.page-header{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"brand actions" "feedback feedback";gap:18px 28px;align-items:center;margin-bottom:24px}.brand{grid-area:brand;min-width:0}.eyebrow{font-size:11px;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:#718090;margin-bottom:7px}h1{font-size:30px;line-height:1.05;letter-spacing:-.035em;margin:0}.subtitle{color:var(--muted);margin:8px 0 0;font-size:14px;line-height:1.5}.header-actions{grid-area:actions;display:flex;gap:9px;align-items:center;justify-content:flex-end;flex-wrap:wrap}.sync-panel{display:flex;align-items:center;gap:10px;min-height:42px;padding:6px 7px 6px 11px;border:1px solid var(--line);border-radius:12px;background:rgba(16,20,25,.82);box-shadow:0 8px 24px rgba(0,0,0,.14)}.sync-dot{width:7px;height:7px;border-radius:999px;background:var(--success);box-shadow:0 0 0 4px rgba(131,223,165,.08);flex:0 0 auto}.sync-copy{display:grid;gap:1px;min-width:128px}.sync-copy strong{font-size:12px;font-weight:650;color:#dbe4eb}.sync-copy span{font-size:10px;color:#73818e}.icon-control{width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:#98a5b1;cursor:pointer;transition:background .16s ease,color .16s ease,transform .16s ease}.icon-control:hover{background:#1b2229;color:#f3f6f8}.icon-control:active{transform:scale(.96)}.icon-control svg{width:15px;height:15px}.icon-control.spinning svg{animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.control,.logout{border-radius:11px;cursor:pointer;font-size:13px;transition:transform .16s ease,background .16s ease,border-color .16s ease,color .16s ease}.control{min-height:42px;padding:0 15px;border:1px solid #e9eef2;background:#edf2f5;color:#0a0d10;font-weight:750;box-shadow:0 6px 20px rgba(0,0,0,.14)}.control:hover{background:#fff}.control:active{transform:translateY(1px)}.control:disabled{opacity:.55;cursor:wait}.logout{min-height:42px;padding:0 11px;border:1px solid transparent;background:transparent;color:#84919d}.logout:hover{background:#13191f;color:#d5dde4;border-color:#202932}.run-status{grid-area:feedback;font-size:12px;color:#8f9daa;min-height:0;text-align:right;margin-top:-8px}.run-status:not(:empty){min-height:18px}.run-status.error{color:var(--danger)}.overview{margin-bottom:14px}.overview-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin:0 2px 10px}.overview-head h2{font-size:14px;margin:0;letter-spacing:-.01em}.overview-total{font-size:11px;color:#71808d}.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:9px}.stat{position:relative;overflow:hidden;background:linear-gradient(180deg,#11161b,#0f1318);border:1px solid var(--line-soft);border-radius:14px;padding:14px 14px 13px;min-height:78px}.stat::before{content:"";position:absolute;inset:0 auto 0 0;width:2px;background:#44515d}.stat-action::before{background:var(--success)}.stat-active::before{background:var(--blue)}.stat-failed::before{background:var(--danger)}.stat-ready::before{background:var(--violet)}.stat-private::before{background:#788592}.stat b{font-size:23px;line-height:1;letter-spacing:-.025em;display:block;margin-bottom:8px}.stat span{font-size:11px;color:#7f8d99;line-height:1.3}.toolbar{position:sticky;top:0;z-index:5;padding:12px 0 14px;background:linear-gradient(180deg,rgba(9,11,14,.98) 0,rgba(9,11,14,.93) 76%,rgba(9,11,14,0) 100%);backdrop-filter:blur(14px)}.toolbar-surface{display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--line-soft);border-radius:14px;background:rgba(15,19,24,.94);box-shadow:0 10px 30px rgba(0,0,0,.16)}.search-wrap{position:relative;flex:1;min-width:180px}.search-wrap svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);width:15px;height:15px;color:#687783;pointer-events:none}.toolbar input{width:100%;height:38px;background:#0c1014;border:1px solid #202a33;color:#f4f7f9;border-radius:9px;padding:0 12px 0 34px;outline:none}.toolbar input:focus{border-color:#465563;box-shadow:0 0 0 3px rgba(123,147,169,.08)}.toolbar input::placeholder{color:#596672}.filters{display:flex;gap:5px;align-items:center;overflow-x:auto;scrollbar-width:none}.filters::-webkit-scrollbar{display:none}.filter{height:34px;background:transparent;border:1px solid transparent;color:#84929f;border-radius:8px;padding:0 10px;cursor:pointer;font-size:12px;white-space:nowrap}.filter:hover{background:#171d23;color:#c2ccd4}.filter.active{background:#202830;color:#f3f6f8;border-color:#29343e}.list{display:grid;gap:10px}.video-card{position:relative;background:linear-gradient(180deg,#101419,#0f1317);border:1px solid #202932;border-radius:16px;padding:18px;box-shadow:0 8px 28px rgba(0,0,0,.09);transition:border-color .16s ease,transform .16s ease,background .16s ease}.video-card:hover{border-color:#2d3944;background:#11161b}.video-card[hidden]{display:none}.topline{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.title-wrap{min-width:0}h2{font-size:16px;margin:0 0 8px;line-height:1.45;letter-spacing:-.01em}.meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;font-size:11px;color:#71808d}.meta>span:not(.badge)+span:not(.badge)::before{content:"·";margin-right:7px;color:#394550}.badge,.status{font-size:10px;border-radius:999px;padding:4px 8px;white-space:nowrap}.badge{background:#1a222a}.badge.warn{color:#e8c86d;background:#292416}.badge.ok{color:#82dba2;background:#14251b}.badge.muted{color:#9ba7b2;background:#1a2025}.status{height:max-content;font-weight:700;border:1px solid transparent}.status-action{background:#132b1d;color:#88e0a7;border-color:#1a4028}.status-processing{background:#11283a;color:#8bc8f5;border-color:#173b55}.status-waiting{background:#2a2413;color:#e8c86e;border-color:#443a1d}.status-failed{background:#301819;color:#ff9d9d;border-color:#4a2223}.status-ready{background:#242138;color:#c7baff;border-color:#373153}.status-private{background:#1c2227;color:#9ba8b2;border-color:#2b333a}.status-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;margin:15px 0}.status-grid>div{background:#0c1014;border:1px solid #1a2229;border-radius:10px;padding:10px 11px}.label{display:block;color:#61707d;font-size:10px;font-weight:650;letter-spacing:.04em;margin-bottom:5px}.status-grid strong{font-size:12px;line-height:1.45;color:#cdd6dd;font-weight:620}.subtle{display:block;color:#788692;font-size:10px;margin-top:4px}.links{display:flex;gap:7px;flex-wrap:wrap}.links a{color:#9eabb6;text-decoration:none;border:1px solid #26313a;border-radius:9px;padding:7px 10px;font-size:11px;transition:background .15s ease,border-color .15s ease,color .15s ease}.links a:hover{background:#161d23;border-color:#35424d;color:#e4eaee}.links a.primary{background:#17202a;color:#d9e3ea;border-color:#2b3945;font-weight:650}details{margin:10px 0 12px;color:#d9a3a3;font-size:11px}details summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0a0d10;border:1px solid #241a1b;padding:10px;border-radius:9px;color:#c7a3a3}.empty{padding:44px 28px;text-align:center;color:#73808c;border:1px dashed #26313a;border-radius:15px;background:#0d1115}@media(max-width:900px){.page-header{grid-template-columns:1fr;grid-template-areas:"brand" "actions" "feedback";gap:14px}.header-actions{justify-content:flex-start}.run-status{text-align:left;margin-top:-4px}.stats{grid-template-columns:repeat(3,1fr)}.toolbar-surface{align-items:stretch;flex-direction:column}.search-wrap{width:100%}.filters{width:100%}}@media(max-width:620px){.shell{width:min(100% - 20px,1180px);padding-top:20px}.header-actions{display:grid;grid-template-columns:1fr auto auto;width:100%}.sync-panel{grid-column:1/-1}.control{width:100%}.stats{grid-template-columns:repeat(2,1fr)}.toolbar{margin:0 -2px}.status-grid{grid-template-columns:1fr 1fr}.status-grid>div:first-child{grid-column:1/-1}.topline{gap:10px}h1{font-size:27px}.video-card{padding:15px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}.icon-control.spinning svg{animation:none}}
  </style></head><body><main class="shell"><header class="page-header"><div class="brand"><div class="eyebrow">AI Memory · Ingest</div><h1>Meeting Memory</h1><p class="subtitle">監看轉錄、摘要與收尾狀態 · 目前可見 ${counts.all} 支影片</p></div><div class="header-actions"><div class="sync-panel"><span class="sync-dot" aria-hidden="true"></span><div class="sync-copy"><strong id="refresh-copy">自動更新中</strong><span>Manifest ${escapeHtml(taipeiTime(manifest.updatedAt))} · 60 秒更新</span></div><button class="icon-control" id="refresh-now" type="button" aria-label="重新整理" title="重新整理"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 8.3A7 7 0 0 1 18.7 7L20 11M4 13l1.3 4A7 7 0 0 0 17.9 15.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div><button class="control" id="run-now" type="button">掃描 Playlist</button><form method="post" action="/dashboard/logout"><button class="logout" type="submit">登出</button></form></div><div class="run-status" id="run-status" aria-live="polite"></div></header>
  <section class="overview"><div class="overview-head"><div><div class="eyebrow">Overview</div><h2>目前狀態</h2></div><span class="overview-total">${counts.all} 支影片</span></div><div class="stats"><div class="stat stat-action"><b>${counts.action}</b><span>已完成，可收回</span></div><div class="stat stat-active"><b>${counts.active}</b><span>處理中 / 等待</span></div><div class="stat stat-failed"><b>${counts.failed}</b><span>失敗</span></div><div class="stat stat-ready"><b>${counts.ready}</b><span>待處理</span></div><div class="stat stat-private"><b>${counts.private}</b><span>Private</span></div><div class="stat"><b>${counts.all}</b><span>目前可見</span></div></div></section>
  <section class="toolbar"><div class="toolbar-surface"><div class="search-wrap"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><input id="search" type="search" placeholder="搜尋標題或 video ID" autocomplete="off"></div><div class="filters"><button class="filter active" data-filter="all">全部</button><button class="filter" data-filter="action">可收回</button><button class="filter" data-filter="active">處理中</button><button class="filter" data-filter="ready">待處理</button><button class="filter" data-filter="private">Private</button><button class="filter" data-filter="failed">失敗</button></div></div></section>
  <section class="list" id="list">${cards || '<div class="empty">目前沒有可顯示的 playlist 影片。</div>'}</section></main><script>
  const filters=[...document.querySelectorAll('.filter')],cards=[...document.querySelectorAll('.video-card')],search=document.getElementById('search'),runButton=document.getElementById('run-now'),refreshButton=document.getElementById('refresh-now'),refreshCopy=document.getElementById('refresh-copy'),runStatus=document.getElementById('run-status');
  const stateKey='meeting-memory-dashboard-view-v1';let active='all',saved={};try{saved=JSON.parse(sessionStorage.getItem(stateKey)||'{}')||{};}catch{}
  if(typeof saved.query==='string')search.value=saved.query;if(typeof saved.active==='string'&&filters.some(x=>x.dataset.filter===saved.active))active=saved.active;
  function apply(){const q=(search.value||'').trim().toLowerCase();cards.forEach(card=>{const group=card.dataset.group;const groupMatch=active==='all'||active===group||(active==='active'&&(group==='processing'||group==='waiting'));const searchMatch=!q||(card.dataset.search||'').includes(q);card.hidden=!(groupMatch&&searchMatch);});filters.forEach(x=>x.classList.toggle('active',x.dataset.filter===active));}
  function saveView(){try{sessionStorage.setItem(stateKey,JSON.stringify({active,query:search.value||'',scrollY:window.scrollY}));}catch{}}
  apply();requestAnimationFrame(()=>{if(Number.isFinite(Number(saved.scrollY)))window.scrollTo(0,Number(saved.scrollY)||0);});
  filters.forEach(button=>button.addEventListener('click',()=>{active=button.dataset.filter||'all';apply();saveView();}));search.addEventListener('input',()=>{apply();saveView();});window.addEventListener('pagehide',saveView);
  function reloadDashboard(){saveView();refreshButton.classList.add('spinning');refreshButton.disabled=true;refreshCopy.textContent='更新中…';requestAnimationFrame(()=>location.reload());}
  refreshButton.addEventListener('click',reloadDashboard);setTimeout(reloadDashboard,60000);
  runButton.addEventListener('click',async()=>{runButton.disabled=true;runStatus.classList.remove('error');runStatus.textContent='正在掃描 Playlist…';try{const response=await fetch('/dashboard/run',{method:'POST',headers:{'x-dashboard-action':'run'}});const data=await response.json();if(!response.ok)throw new Error(data.error||('HTTP '+response.status));runStatus.textContent='掃描完成：發現 '+data.eligible+' 支可處理，觸發 '+data.claimed+' 支。';setTimeout(reloadDashboard,1600);}catch(error){runStatus.classList.add('error');runStatus.textContent='觸發失敗：'+(error instanceof Error?error.message:String(error));runButton.disabled=false;}});
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

  if (request.method !== "GET" || url.pathname !== "/dashboard") return htmlResponse("Not found", 404);
  if (!(await dashboardAuthorized(request, env))) return htmlResponse(loginPage());

  const [accessToken, manifestResult] = await Promise.all([getYouTubeAccessToken(env), loadManifest(env)]);
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
  return htmlResponse(renderDashboard(env, rows, manifestResult.manifest));
}

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

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>Meeting Memory Dashboard</title><style>
  :root{color-scheme:dark;background:#090b0e;color:#f4f6f8;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:#090b0e}.shell{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:28px 0 56px}header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:22px}.header-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}h1{font-size:26px;letter-spacing:-.02em;margin:0}.subtitle{color:#8895a3;margin:7px 0 0;font-size:14px}.control,.logout{border:1px solid #28313a;border-radius:9px;padding:8px 11px;cursor:pointer;font:inherit;font-size:13px}.control{background:#151b21;color:#d7e0e8}.control.primary{background:#eef2f5;color:#0b0d10;border-color:#eef2f5;font-weight:700}.control:disabled{opacity:.5;cursor:wait}.logout{background:none;color:#aeb8c2}.run-status{font-size:12px;color:#8f9daa;min-height:18px;text-align:right;margin-top:7px}.run-status.error{color:#ff9e9e}.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:16px}.stat{background:#11151a;border:1px solid #202831;border-radius:13px;padding:13px}.stat b{font-size:22px;display:block}.stat span{font-size:12px;color:#82909e}.toolbar{position:sticky;top:0;z-index:3;background:rgba(9,11,14,.92);backdrop-filter:blur(10px);display:flex;gap:8px;padding:12px 0}.toolbar input{flex:1;min-width:140px;background:#11161b;border:1px solid #26313a;color:#fff;border-radius:10px;padding:10px 12px}.filter{background:#11161b;border:1px solid #26313a;color:#aab6c2;border-radius:10px;padding:9px 11px;cursor:pointer}.filter.active{background:#eef2f5;color:#0b0d10;border-color:#eef2f5}.list{display:grid;gap:10px}.video-card{background:#101419;border:1px solid #202932;border-radius:15px;padding:17px}.topline{display:flex;justify-content:space-between;gap:18px}.title-wrap{min-width:0}h2{font-size:16px;margin:0 0 7px;line-height:1.4}.meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:#82909e}.badge,.status{font-size:11px;border-radius:999px;padding:4px 8px;white-space:nowrap}.badge{background:#1a222a}.badge.warn{color:#f6d479;background:#2b2414}.badge.ok{color:#8be1ad;background:#14271c}.badge.muted{color:#aab4bd;background:#1b2025}.status{height:max-content;font-weight:700}.status-action{background:#13351f;color:#8cf0ad}.status-processing{background:#132d47;color:#8cc9ff}.status-waiting{background:#332811;color:#f1cd75}.status-failed{background:#39191a;color:#ff9c9c}.status-ready{background:#28243d;color:#c7b8ff}.status-private{background:#1e2328;color:#9aa7b3}.status-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;margin:15px 0}.status-grid>div{background:#0c1014;border-radius:10px;padding:10px 11px}.label{display:block;color:#71808e;font-size:11px;margin-bottom:4px}.status-grid strong{font-size:13px}.subtle{display:block;color:#8b98a5;font-size:11px;margin-top:3px}.links{display:flex;gap:7px;flex-wrap:wrap}.links a{color:#b8c5d1;text-decoration:none;border:1px solid #29343e;border-radius:8px;padding:7px 9px;font-size:12px}.links a.primary{background:#eef2f5;color:#0b0d10;border-color:#eef2f5;font-weight:700}details{margin:10px 0;color:#d7a4a4;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0a0d10;padding:10px;border-radius:8px;color:#c7a3a3}.empty{padding:36px;text-align:center;color:#7d8995;border:1px dashed #26313a;border-radius:14px}@media(max-width:760px){header{flex-direction:column}.header-actions{justify-content:flex-start}.run-status{text-align:left}.stats{grid-template-columns:repeat(3,1fr)}.toolbar{overflow-x:auto}.filter{white-space:nowrap}.status-grid{grid-template-columns:1fr}.topline{align-items:flex-start}.shell{width:min(100% - 20px,1120px)}}
  </style></head><body><main class="shell"><header><div><h1>Meeting Memory</h1><p class="subtitle">Playlist 可見影片 ${counts.all} 支 · manifest 更新 ${escapeHtml(taipeiTime(manifest.updatedAt))} · 每 60 秒自動重新整理</p></div><div><div class="header-actions"><button class="control primary" id="run-now" type="button">立即掃描</button><button class="control" id="refresh-now" type="button">重新整理</button><form method="post" action="/dashboard/logout"><button class="logout" type="submit">登出</button></form></div><div class="run-status" id="run-status" aria-live="polite"></div></div></header>
  <section class="stats"><div class="stat"><b>${counts.action}</b><span>已完成，可收回</span></div><div class="stat"><b>${counts.active}</b><span>處理中 / 等待</span></div><div class="stat"><b>${counts.failed}</b><span>失敗</span></div><div class="stat"><b>${counts.ready}</b><span>待處理</span></div><div class="stat"><b>${counts.private}</b><span>Private</span></div><div class="stat"><b>${counts.all}</b><span>目前可見</span></div></section>
  <section class="toolbar"><input id="search" type="search" placeholder="搜尋標題或 video ID"><button class="filter active" data-filter="all">全部</button><button class="filter" data-filter="action">可收回</button><button class="filter" data-filter="active">處理中</button><button class="filter" data-filter="ready">待處理</button><button class="filter" data-filter="private">Private</button><button class="filter" data-filter="failed">失敗</button></section>
  <section class="list" id="list">${cards || '<div class="empty">目前沒有可顯示的 playlist 影片。</div>'}</section></main><script>
  const filters=[...document.querySelectorAll('.filter')], cards=[...document.querySelectorAll('.video-card')], search=document.getElementById('search'); let active='all';
  function apply(){const q=(search.value||'').trim().toLowerCase(); cards.forEach(card=>{const group=card.dataset.group; const groupMatch=active==='all'||active===group||(active==='active'&&(group==='processing'||group==='waiting')); const searchMatch=!q||(card.dataset.search||'').includes(q); card.hidden=!(groupMatch&&searchMatch);});}
  filters.forEach(button=>button.addEventListener('click',()=>{active=button.dataset.filter;filters.forEach(x=>x.classList.toggle('active',x===button));apply();})); search.addEventListener('input',apply);
  const runButton=document.getElementById('run-now'), refreshButton=document.getElementById('refresh-now'), runStatus=document.getElementById('run-status');
  refreshButton.addEventListener('click',()=>location.reload());
  runButton.addEventListener('click',async()=>{runButton.disabled=true;runStatus.classList.remove('error');runStatus.textContent='正在掃描 playlist…';try{const response=await fetch('/dashboard/run',{method:'POST',headers:{'x-dashboard-action':'run'}});const data=await response.json();if(!response.ok)throw new Error(data.error||('HTTP '+response.status));runStatus.textContent='掃描完成：發現 '+data.eligible+' 支可處理，觸發 '+data.claimed+' 支。';setTimeout(()=>location.reload(),1800);}catch(error){runStatus.classList.add('error');runStatus.textContent='觸發失敗：'+(error instanceof Error?error.message:String(error));runButton.disabled=false;}});
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

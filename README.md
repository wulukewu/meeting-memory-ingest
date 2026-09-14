# meeting-memory-ingest

把一個 **Private YouTube playlist** 當成 AI Memory Inbox。平常影片可保持 `Private`；要處理時手動切成 `Unlisted`。Cloudflare Worker 每 5 分鐘掃一次，只有真的有新影片時才 dispatch 一個短暫 GitHub Action，用 yt-dlp 解析 signed audio URL；之後 Groq 轉錄／摘要，再把 Markdown 寫進 `wulukewu/ai-memory`。

## 日常操作

1. 錄影／錄音後上傳 YouTube，平常保持 `Private`。
2. 要讓 AI 處理時，把該影片改成 `Unlisted`，並放進唯一的 Private playlist。
3. Worker 每 5 分鐘掃一次，每輪預設只 claim 1 支。
4. Claim 成功後 Worker dispatch GitHub Actions resolver；Action 只解析 signed audio URL，不下載整支影片。
5. Resolver callback Worker 後，Worker 用 Groq Whisper 轉錄、GPT-OSS 摘要，再 commit 到 `ai-memory`。
6. 完成後有空再把影片切回 `Private`。

## Architecture

```text
Private YouTube playlist
        │
        │ YouTube Data API + readonly OAuth
        ▼
Cloudflare Worker Cron
        │
        ├─ Private video  → skip
        └─ Unlisted video → claim manifest
                │
                ▼
   GitHub Actions (on demand only)
        yt-dlp resolve URL
                │
                │ signed googlevideo URL
                ▼
      Worker /resolver/callback
                │
                ▼
       Groq Whisper Large v3
                │
      transcript + timestamps
                ▼
        Groq GPT-OSS 120B
 summary / decisions / actions
                │
                ▼
        GitHub Contents API
                │
                ▼
wulukewu/ai-memory/main
reference/meeting-transcripts/...
```

大型影音 bytes 不經過 Worker，也不由 Actions 下載保存。Actions 只負責 YouTube playback URL resolution；Groq 直接抓 signed URL。

## 為什麼 resolver 改成 GitHub Actions？

Cloudflare Workers Free 每次 invocation 的 CPU budget 很小。實測 `youtubei.js` player decipher 會觸發 Cloudflare `1102`；Browser Run 雖然可以播放 YouTube，但 2026 的 web client 會大量使用 SABR/UMP (`application/vnd.yt-ump`)，不再可靠暴露獨立 audio URL。

GitHub-hosted Ubuntu runner 上已實測 yt-dlp 可以取得傳統 signed audio URL，而且該 URL 可由另一個 IP 成功下載。把 yt-dlp 限定為 **有新 meeting 才執行一次**，可以避免每 5 分鐘燒 private-repo Actions minutes。

## Playlist privacy model

- Playlist 本身可以一直保持 **Private**。
- Worker 用 `youtube.readonly` OAuth 讀 Private playlist metadata。
- Private 影片只會被看到 metadata，不會處理。
- 真正要 ingest 的影片需暫時設成 **Unlisted**。
- Worker 沒有修改影片 privacy 的權限。

## 1. Install

```bash
npm install
npm test
npm run typecheck
```

## 2. Cloudflare runtime configuration

Dashboard：

```text
Workers & Pages
→ meeting-memory-ingest
→ Settings
→ Variables and Secrets
```

必填 Variables：

```text
YOUTUBE_PLAYLIST_ID
WORKER_PUBLIC_URL
```

例如：

```text
WORKER_PUBLIC_URL=https://meeting-memory-ingest.ai-memory.workers.dev
```

必填 Secrets：

```text
GROQ_API_KEY
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_REFRESH_TOKEN
GITHUB_TOKEN
ADMIN_TOKEN
RESOLVER_GITHUB_TOKEN
```

`GITHUB_TOKEN`：只需能對 `wulukewu/ai-memory` 做 Contents Read/Write。

`RESOLVER_GITHUB_TOKEN`：另建 fine-grained PAT，只授權 `wulukewu/meeting-memory-ingest`，需要：

```text
Actions: Read and write
Metadata: Read
```

不要把 runtime credentials 放在 Cloudflare Build variables。

## 3. GitHub Actions callback secret

在 `wulukewu/meeting-memory-ingest`：

```text
Settings
→ Secrets and variables
→ Actions
→ New repository secret
```

新增：

```text
Name: WORKER_ADMIN_TOKEN
Value: 與 Cloudflare ADMIN_TOKEN 完全相同
```

Resolver workflow 不需要 Groq key、YouTube OAuth secrets 或 ai-memory PAT。

## 4. YouTube OAuth

Worker 要讀 Private playlist，所以需要 OAuth，而不是單純 API key。

1. Enable **YouTube Data API v3**。
2. 建 OAuth Desktop client。
3. 取得 `YOUTUBE_CLIENT_ID`、`YOUTUBE_CLIENT_SECRET`。
4. 執行：

```bash
export YOUTUBE_CLIENT_ID='...'
export YOUTUBE_CLIENT_SECRET='...'
npm run youtube:auth
```

把產生的 `YOUTUBE_REFRESH_TOKEN` 設成 Cloudflare Secret。

Scope 只有：

```text
https://www.googleapis.com/auth/youtube.readonly
```

## 5. Resolver workflow

`.github/workflows/resolve-youtube.yml` 只接受 `workflow_dispatch`。Worker claim 一支影片後才呼叫 GitHub API dispatch workflow。

Resolver 預設：

```text
yt-dlp 2026.08.19
client 1: visionos
client 2 fallback: default,web_embedded
format: 140 / bestaudio m4a / bestaudio
```

Action 成功後把 signed `googlevideo.com` URL POST 到：

```text
POST /resolver/callback
Authorization: Bearer <WORKER_ADMIN_TOKEN>
```

Worker 會驗證 callback URL 必須是 HTTPS `googlevideo.com`，再交給 Groq。

## 6. Deploy

```bash
npm install
npm run deploy
```

Cron：

```text
*/5 * * * *
```

`keep_vars: true` 已開啟，避免 repo deploy 清掉 Dashboard-only vars/secrets。

若新 resolver 設定尚未補齊，`/health` 會顯示缺項，而且 Cron 會直接 skip，不會動 manifest。

## 7. Endpoints

Health：

```text
GET /health
```

Status：

```bash
curl \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://meeting-memory-ingest.ai-memory.workers.dev/status
```

Process one video：

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://meeting-memory-ingest.ai-memory.workers.dev/process/VIDEO_ID?wait=1'
```

成功 claim 後會回 `dispatched: [VIDEO_ID]`；真正完成狀態稍後由 Action callback 更新 manifest。

Force retry：

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://meeting-memory-ingest.ai-memory.workers.dev/retry/VIDEO_ID?wait=1'
```

## 8. ai-memory output

```text
reference/meeting-transcripts/
├── _manifest.json
├── campus-agent/
├── algorithm/
├── mcl/
└── general/
```

Manifest 狀態：

```text
processing → completed
           ↘ failed
```

processing lease 預設 90 分鐘，failed retry cooldown 預設 30 分鐘。

## Security notes

- YouTube OAuth 是 readonly。
- Worker 無法修改影片 privacy。
- `GITHUB_TOKEN` 與 `RESOLVER_GITHUB_TOKEN` 分開，避免擴大 ai-memory PAT 權限。
- Actions 只拿 `WORKER_ADMIN_TOKEN`，不持有 Groq / Google OAuth / ai-memory secrets。
- Resolver 不把 signed URL commit 到任何 repo；callback 後即丟給 Groq。
- AI summary 只寫 reference，不會自動提升到 `core.md`。

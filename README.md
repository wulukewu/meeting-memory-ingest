# meeting-memory-ingest

把指定 YouTube playlist 當成 **AI Memory Inbox**：只要影片目前是 `unlisted`，Cloudflare Worker 就會自動取得音訊、用 Groq 轉錄與整理，最後把 Markdown reference commit 到 `wulukewu/ai-memory`。

目標是讓日常操作只剩：

1. 錄影／錄音後上傳 YouTube。
2. 平常保持 `Private`。
3. 要讓 AI 處理時，手動改成 `Unlisted` 並加入唯一的 private playlist（AI Memory Inbox）。
4. Worker 每 5 分鐘掃一次；每輪預設只處理 1 支，避免免費額度瞬間打滿。
5. 完成後你有空再手動把影片改回 `Private`。
6. `ai-memory` 在電腦背景同步後，逐字稿自然成為 agent 可查的 reference。

## Architecture

```text
Private YouTube playlist: AI Memory Inbox
               │
               │ 只挑 privacy=unlisted 且尚未完成的影片
               ▼
       Cloudflare Worker Cron
               │
       YouTube Data API (OAuth)
               │
       youtubei.js/cf-worker
               │
        signed audio URL
               │
               ▼
        Groq Whisper Large v3
               │
        transcript + timestamps
               │
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

**大型影音 bytes 不經過 Worker。** Worker 只解析出短效 YouTube 音訊 URL，Groq 直接從該 URL 讀取音訊。

### 已驗證的關鍵假設

2026-09-14 用兩個不同 GitHub-hosted runner 實測：runner A 解析 YouTube signed audio URL（IP `74.249.79.51`），runner B（IP `172.203.254.215`）直接用同一 URL 取得 `206 Partial Content` 與 1 MiB 音訊資料。也就是 signed URL **沒有被限制只能由解析它的那個來源 IP 下載**；因此「Worker 解析 URL → Groq 從另一個網路位置抓音訊」這個設計值得直接實測。

仍有一個真正的風險：YouTube 的播放協定、PO Token / bot detection 會變。`youtubei.js` 已經把這段集中在 `src/youtube-audio.ts`，未來若需要 PO Token，只要加 Worker secrets，不必改其餘 pipeline。

## What gets written to ai-memory

```text
reference/meeting-transcripts/
├── _manifest.json
├── campus-agent/
│   └── 2026-09-14-...-VIDEO_ID.md
├── algorithm/
├── mcl/
└── general/
```

`_manifest.json` 同時是去重與 lease 狀態：`processing / completed / failed`。Worker 先用 GitHub compare-and-swap claim 一支影片，避免 Cron 和手動觸發大多數重複處理情況；如果 Worker 中途掛掉，預設 90 分鐘後 lease 失效可重試。

## 1. Install

```bash
npm install
npm test
npm run typecheck
```

本 repo **沒有 GitHub Actions CI**，避免 private-repo hosted-runner minutes。部署與執行都走 Cloudflare Workers。

## 2. YouTube setup

### Playlist

建立一個 playlist，例如：

> AI Memory Inbox

建議 playlist 自己設成 **Private**。把 playlist URL 裡 `list=` 後面的 ID 填到 `wrangler.jsonc`：

```jsonc
"YOUTUBE_PLAYLIST_ID": "PLxxxxxxxxxxxxxxxx"
```

不需要多個 playlist。Worker 只處理目前 `privacyStatus === "unlisted"` 的影片；Private 影片會保留在 playlist 裡但被忽略。

### Google Cloud / OAuth

1. 建立一個 Google Cloud project。
2. Enable **YouTube Data API v3**。
3. OAuth consent screen 設好你的 Google account。
4. 建立 **OAuth Client ID → Desktop app**。
5. 取得 Client ID / Client Secret。

> 重要：External OAuth app 若保持 `Testing`，非基本 identity scope 的 refresh token 會在 7 天後失效。這套服務要長期跑，完成測試後應把 OAuth publishing status 切到 **In production**，再重新取得正式 refresh token。個人／少數已知使用者用途可以自行通過 unverified-app warning，不需要把這個私人工具公開給其他人。

在本機取得 refresh token：

```bash
export YOUTUBE_CLIENT_ID='...'
export YOUTUBE_CLIENT_SECRET='...'
npm run youtube:auth
```

瀏覽器授權後 terminal 會印出 `YOUTUBE_REFRESH_TOKEN`。不要 commit 它。

本 Worker 只要求 scope：

```text
https://www.googleapis.com/auth/youtube.readonly
```

它 **不會自動修改影片 privacy**；`Private ↔ Unlisted` 完全由你手動控制。

## 3. Groq setup

建立 Groq API key。預設：

```text
STT:     whisper-large-v3
Summary: openai/gpt-oss-120b
```

Groq speech-to-text 支援 `url` input，因此 Worker 不需要下載整支音訊。逐字稿用 `verbose_json + segment timestamps`。

Summary 會把長逐字稿切成約 5,200 characters 的區段逐段整理，再做一次合併；API 遇到 `429` 時會尊重 `Retry-After` 後重試，避免免費方案 8K TPM 直接失敗。

如果只想要逐字稿、不想跑 LLM 摘要：

```jsonc
"SUMMARY_ENABLED": "false"
```

## 4. GitHub token

建立 **fine-grained personal access token**，Repository access 只選：

```text
wulukewu/ai-memory
```

Permissions 只需要：

```text
Contents: Read and write
Metadata: Read
```

Worker 不需要對 `meeting-memory-ingest` repo 有寫入權限。

## 5. Cloudflare Worker secrets

先部署一次或在 Dashboard 建立 Worker，再放 secrets：

```bash
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put YOUTUBE_CLIENT_ID
npx wrangler secret put YOUTUBE_CLIENT_SECRET
npx wrangler secret put YOUTUBE_REFRESH_TOKEN
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ADMIN_TOKEN
```

`ADMIN_TOKEN` 可以自己產生：

```bash
openssl rand -hex 32
```

Optional（只有 YouTube 開始要求時才需要）：

```bash
npx wrangler secret put YOUTUBE_PO_TOKEN
npx wrangler secret put YOUTUBE_VISITOR_DATA
```

不要把任何 secret 寫進 `wrangler.jsonc`。

## 6. Deploy

```bash
npm install
npm run deploy
```

`wrangler.jsonc` 已設定：

```text
*/5 * * * *
```

也就是每 5 分鐘掃一次。Cloudflare Free Workers 對 Cron/HTTP invocation 的 CPU budget 很小；本設計刻意不搬運／轉碼影音，但 `youtubei.js` 的 deciphering 仍是第一個實機測試重點。如果 Free Worker 實際出現 `Error 1102 / exceeded CPU time`，不要先改架構，先保留所有 API pipeline，只把 audio resolver 評估成 paid Worker 或其他極小 fallback。

## 7. Endpoints

### Health（不用 admin token）

```bash
curl https://YOUR_WORKER.workers.dev/health
```

只會回報哪些設定名稱缺少，不會回 secret value。

### Run inbox now

非同步：

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://YOUR_WORKER.workers.dev/run
```

短測試可以等待完整結果：

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://YOUR_WORKER.workers.dev/run?wait=1'
```

### Process one video

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://YOUR_WORKER.workers.dev/process/VIDEO_ID?wait=1'
```

影片仍必須是 `Unlisted`；不會繞過 privacy gate。

### Force retry one video

會先清掉 manifest 裡該 video 的狀態，再重新 claim：

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://YOUR_WORKER.workers.dev/retry/VIDEO_ID?wait=1'
```

### Status

```bash
curl \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://YOUR_WORKER.workers.dev/status
```

回最近 25 筆 `processing / completed / failed` 狀態。

## 8. First real test

先拿一支短、沒有敏感內容的測試影片：

1. 上傳 YouTube。
2. 加進 private `AI Memory Inbox` playlist。
3. 把影片改成 `Unlisted`。
4. `POST /process/VIDEO_ID?wait=1`。
5. 依序確認：
   - YouTube OAuth 能看到影片。
   - Cloudflare 上 `youtubei.js` 能解析 direct audio URL。
   - Groq 能從該 URL 拉到音訊並回 transcript。
   - Groq summary 成功。
   - `ai-memory/reference/meeting-transcripts/...md` 與 `_manifest.json` 出現 commit。
6. 再跑一次 `/run?wait=1`，應看到 `already completed`，不會重複 ingest。
7. 手動把 YouTube 影片改回 `Private`。

### Go / no-go checkpoint

真正需要觀察的是第 2～3 步：

- **成功**：Worker-only 架構成立，之後直接讓 Cron 長期跑。
- **YouTube.js / PO Token 失敗**：只替換 `src/youtube-audio.ts`，其餘 YouTube playlist、Groq、ai-memory pipeline 全保留。
- **Cloudflare Free CPU 不夠**：只搬 resolver，不把整套退回 GitHub Actions。

## Configuration

一般設定都在 `wrangler.jsonc`：

| Variable | Default | Purpose |
|---|---:|---|
| `YOUTUBE_PLAYLIST_ID` | `REPLACE_ME` | AI Memory Inbox playlist |
| `AI_MEMORY_OWNER` | `wulukewu` | target repo owner |
| `AI_MEMORY_REPO` | `ai-memory` | target repo |
| `AI_MEMORY_BRANCH` | `main` | target branch |
| `TRANSCRIPT_ROOT` | `reference/meeting-transcripts` | output root |
| `GROQ_TRANSCRIPTION_MODEL` | `whisper-large-v3` | STT model |
| `GROQ_SUMMARY_MODEL` | `openai/gpt-oss-120b` | summary model |
| `SUMMARY_ENABLED` | `true` | enable LLM summary |
| `MAX_ITEMS_PER_RUN` | `1` | intentionally process slowly |
| `MAX_PLAYLIST_PAGES` | `10` | scan at most 500 playlist entries |
| `PROCESSING_LEASE_MINUTES` | `90` | reclaim a stuck processing job |
| `RETRY_FAILED_AFTER_MINUTES` | `30` | cooldown before auto retry |

## Security model

- Playlist can stay Private.
- Worker only processes videos that you manually make Unlisted.
- Worker has YouTube **read-only** OAuth scope and cannot change privacy.
- `GITHUB_TOKEN` can only write `ai-memory`.
- Groq/Google/GitHub/Admin tokens are Worker Secrets, never repo variables.
- `/run`, `/process`, `/retry`, `/status` require `Authorization: Bearer $ADMIN_TOKEN`.
- Transcript Markdown explicitly marks automated summaries as fallible; it does not silently promote them to `core.md`.

## Notes on privacy

Meeting recordings can contain other people's non-public conversations. Only record and process meetings where doing so is appropriate and disclosed/consented to for the context; this pipeline intentionally does not hide or automate the decision to make a recording processable.

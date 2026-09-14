# meeting-memory-ingest

把一個 **Private YouTube playlist** 當成 AI Memory Inbox。只有你手動設為 `Unlisted` 的影片才會被 Cloudflare Worker 處理；Worker 會用 Groq 轉錄／整理，再把 Markdown reference commit 到 `wulukewu/ai-memory`。

日常操作：

1. 錄影／錄音後上傳 YouTube，平常可保持 `Private`。
2. 要讓 AI 處理時，把該影片改成 `Unlisted`，並放進唯一的 Private playlist。
3. Worker 每 5 分鐘掃一次，每輪預設只吃 1 支。
4. 完成後你有空再手動把影片改回 `Private`。
5. `ai-memory` 本機同步後，逐字稿自然成為 agent reference。

## Architecture

```text
Private YouTube playlist
        │
        │ OAuth 只讀 metadata
        ▼
Cloudflare Worker Cron
        │
        ├─ Private video  → skip
        └─ Unlisted video → process
                │
                ▼
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

大型影音 bytes 不經過 Worker。Worker 只解析短效 YouTube audio URL，Groq 直接抓音訊。

## 已驗證的關鍵假設

2026-09-14 用兩個不同 GitHub-hosted runner 實測：runner A 解析 signed audio URL（IP `74.249.79.51`），runner B（IP `172.203.254.215`）用同一 URL 成功取得 HTTP `206 Partial Content` 與媒體 bytes。因此「Worker 解析 URL → Groq 從另一個網路位置抓音訊」值得直接實機測試。

YouTube 的 PO Token / bot detection 仍可能變動。這段集中在 `src/youtube-audio.ts`；若未來需要 PO Token，只需換 resolver 或加 secrets，不必推翻 Groq / ai-memory pipeline。

## 為什麼 playlist 可以 Private，但影片處理時要 Unlisted？

- YouTube Data API + `youtube.readonly` OAuth 可以讓 Worker 讀你自己的 Private playlist metadata。
- YouTube Data API 不提供原始影片／音訊下載 URL。
- V1 的 playback resolver 不保存你的 Google browser cookies，也不嘗試登入播放 Private 影片。
- 因此 Worker **只處理實際 `privacyStatus === "unlisted"` 的影片**；Private 影片留在 playlist 裡也沒關係，只會 skip。
- 完成後你再手動 `Unlisted → Private`。

這個設計是刻意的安全邊界：自動化系統沒有修改影片 privacy 的權限。

## 1. Install

```bash
npm install
npm test
npm run typecheck
```

本 repo 沒有 production GitHub Actions，避免 private-repo hosted-runner minutes。

## 2. YouTube playlist

只需要一個 playlist，例如：

> AI Memory Inbox

playlist 本身建議設 **Private**。

`YOUTUBE_PLAYLIST_ID` 是部署環境設定，**不寫進 repo / wrangler.jsonc**。從 playlist URL 的 `list=` 取得 ID，之後在 Cloudflare Worker 的 **Settings → Variables and Secrets** 新增：

```text
Type: Variable
Name: YOUTUBE_PLAYLIST_ID
Value: PL...
```

Playlist ID 本身不是 credential；即使有人知道 ID，也不能匿名讀你的 Private playlist。不過仍把它留在 Worker environment，避免把帳號／部署特定設定寫進 source control。

## 3. Google Cloud / YouTube OAuth

Worker 要讀 Private playlist，所以不能只用 API key，需要 OAuth。

### 3.1 建 project 與 OAuth client

1. 到 Google Cloud Console 建一個 project，例如 `meeting-memory-ingest`。
2. **APIs & Services → Library**：啟用 **YouTube Data API v3**。
3. 設定 OAuth consent / audience；這是你自己的工具，只需要讓你自己的 Google account 能授權。
4. **Clients / Credentials → Create client → Desktop app**。
5. 取得：
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`

把兩個都放 Cloudflare **Secret**，不要貼到 issue/chat，也不要 commit。

### 3.2 取得 refresh token

這個 repo 有一次性 helper。Clone branch 後：

```bash
npm install
export YOUTUBE_CLIENT_ID='你的 client id'
export YOUTUBE_CLIENT_SECRET='你的 client secret'
npm run youtube:auth
```

helper 會開瀏覽器／提供授權 URL，scope 只有：

```text
https://www.googleapis.com/auth/youtube.readonly
```

它會要求 `offline` access，所以授權完成後 terminal 會得到：

```text
YOUTUBE_REFRESH_TOKEN=...
```

把這個值設成 Cloudflare **Secret**。

> 如果 Google OAuth app 的 Publishing Status 保持 `Testing`，這類 scope 的授權與 refresh token 會在 7 天後失效。正式長期使用前，應切成 `In production` 後重新授權取得 refresh token。這是私人自用整合，不代表要把應用公開給別人；如果 Google 顯示 unverified-app warning，是否需要進一步 verification 取決於實際 audience / scope / 發布方式。

Worker 之後會自動用 refresh token 換短效 access token，你不用定期人工更新 access token。

## 4. Groq API key

到 GroqCloud API Keys 建一個 key：

```text
GROQ_API_KEY
```

預設模型：

```text
STT:     whisper-large-v3
Summary: openai/gpt-oss-120b
```

放成 Cloudflare **Secret**。

## 5. GitHub fine-grained token

建立 fine-grained PAT：

```text
Resource owner: wulukewu
Repository access: Only select repositories
Selected repository: ai-memory
```

Repository permissions：

```text
Contents: Read and write
Metadata: Read
```

產生後把 token 放成 Cloudflare Secret：

```text
GITHUB_TOKEN
```

Worker 不需要寫入 `meeting-memory-ingest` repo。

## 6. Admin token

這只是保護 `/run`、`/status`、`/process`、`/retry` endpoints 的 bearer token。你自己產生即可：

```bash
openssl rand -hex 32
```

把輸出值設成 Cloudflare Secret：

```text
ADMIN_TOKEN
```

## 7. Cloudflare Variables & Secrets

### 必填 Variable（非 secret）

```text
YOUTUBE_PLAYLIST_ID
```

### 必填 Secrets

```text
GROQ_API_KEY
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_REFRESH_TOKEN
GITHUB_TOKEN
ADMIN_TOKEN
```

### Optional Secrets

只有 YouTube playback 開始要求時才需要：

```text
YOUTUBE_PO_TOKEN
YOUTUBE_VISITOR_DATA
```

Cloudflare Dashboard 路徑：

```text
Workers & Pages
→ meeting-memory-ingest
→ Settings
→ Variables and Secrets
→ Add
```

敏感值選 **Secret**；`YOUTUBE_PLAYLIST_ID` 選 **Variable** 即可。

本機開發則可複製 `.env.example` / 使用 `.dev.vars`，真實檔案已被 `.gitignore` 排除。

## 8. Repo 中保留的非敏感 defaults

`wrangler.jsonc` 只保留服務本身的可版本控設定，例如：

```text
Cron: */5 * * * *
AI_MEMORY_REPO: ai-memory
TRANSCRIPT_ROOT: reference/meeting-transcripts
GROQ_TRANSCRIPTION_MODEL: whisper-large-v3
MAX_ITEMS_PER_RUN: 1
```

這些不是 credential，也不是你的 YouTube account-specific ID。若之後想做 staging / production，再把它們改成 environment-specific vars 即可。

## 9. Deploy

```bash
npm install
npm run deploy
```

Cron 已設定為每 5 分鐘一次。

Cloudflare Free Worker 的 CPU budget 很小，因此 V1 不做影音轉碼／proxy。`youtubei.js` playback URL deciphering 是第一個 Cloudflare 實機 checkpoint。

## 10. Endpoints

Health 不需 admin token：

```bash
curl https://YOUR_WORKER.workers.dev/health
```

正常設定後應看到 `configured: true`。

手動掃 inbox：

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://YOUR_WORKER.workers.dev/run?wait=1'
```

指定一支影片：

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://YOUR_WORKER.workers.dev/process/VIDEO_ID?wait=1'
```

強制 retry：

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://YOUR_WORKER.workers.dev/retry/VIDEO_ID?wait=1'
```

狀態：

```bash
curl \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://YOUR_WORKER.workers.dev/status
```

## 11. First real test

先拿一支短且無敏感內容的影片：

1. 上傳 YouTube。
2. 加進 Private `AI Memory Inbox` playlist。
3. 把**影片本身**改成 `Unlisted`。
4. 呼叫 `/process/VIDEO_ID?wait=1`。
5. 確認：
   - OAuth 能讀 Private playlist / video metadata。
   - Cloudflare 能解析 direct audio URL。
   - Groq 能從 URL 取得 audio 並回 transcript。
   - Groq summary 成功。
   - `ai-memory/reference/meeting-transcripts/...md` 與 `_manifest.json` 出現 commit。
6. 再跑一次應被 manifest 判斷為 completed，不會重複 ingest。
7. 手動把影片改回 `Private`。

### Go / no-go checkpoint

- 成功：Worker-only 架構成立，讓 Cron 長期跑。
- YouTube.js / PO Token 失敗：只替換 `src/youtube-audio.ts`。
- Cloudflare Free CPU 不夠：只搬 resolver，不把整套退回 GitHub Actions。

## What gets written to ai-memory

```text
reference/meeting-transcripts/
├── _manifest.json
├── campus-agent/
├── algorithm/
├── mcl/
└── general/
```

Manifest 是 durable 去重／lease 狀態：`processing / completed / failed`。

## Security model

- Playlist 可永久保持 Private。
- 只有你手動改成 Unlisted 的影片會被處理。
- Worker 只有 YouTube read-only OAuth scope，不能改 privacy。
- GitHub token 只寫 `ai-memory`。
- Groq / Google / GitHub / admin credentials 都是 Worker Secrets。
- Playlist ID 留在 Worker env，不進 repo。
- 自動摘要只進 meeting reference，不自動污染 `core.md`。

## Privacy

Meeting recording 可能包含他人的非公開談話。只處理在該情境下適合且已有適當告知／同意的錄音；這套 pipeline 刻意不自動替你做「是否應該錄／是否應該公開給處理服務」的決定。

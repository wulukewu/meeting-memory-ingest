# meeting-memory-ingest

把一個 **Private YouTube playlist** 當成 AI Memory Inbox。只有你手動設為 `Unlisted` 的影片才會被 Cloudflare Worker 處理；Worker 會用 Groq 轉錄／整理，再把 Markdown reference commit 到 `wulukewu/ai-memory`。

日常操作：

1. 錄影／錄音後上傳 YouTube，平常可保持 `Private`。
2. 要讓 AI 處理時，把該影片改成 `Unlisted`，並放進唯一的 Private playlist。
3. Worker 每 5 分鐘掃一次，每輪預設只吃 1 支。
4. 完成後有空再手動把影片改回 `Private`。
5. `ai-memory` 本機同步後，逐字稿自然成為 agent reference。

## Architecture

```text
Private YouTube playlist
        │
        │ YouTube Data API + readonly OAuth
        ▼
Cloudflare Worker Cron
        │
        ├─ Private video  → skip
        └─ Unlisted video → process
                │
                ▼
      Cloudflare Browser Run
  Chromium loads the YouTube page
                │
     observe googlevideo audio URL
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

大型影音 bytes **不經過 Worker**。Browser Run 只負責讓 YouTube 自己執行播放邏輯並觀察第一個 audio `googlevideo.com/videoplayback` request；Worker 把短效 signed URL 直接交給 Groq。

## 為什麼改用 Browser Run？

最初 V1 使用 `youtubei.js` 在 Worker 內解析 YouTube player JS。第一次真實測試在 Workers Free 上觸發 Cloudflare `1102`：Free Worker 每次 invocation 只有很小的 CPU budget，而 player parsing/deciphering 是 CPU-heavy 工作。

現在改成 Browser Run：YouTube player code 在 Chromium 裡執行，Worker 只做 API orchestration 與少量 request filtering。

Cloudflare Workers Free 目前包含 Browser Run 免費額度（每日 10 browser minutes）。這個 pipeline 只有遇到實際可處理的 Unlisted 影片才會開 browser，掃 playlist 本身不會消耗 browser minutes。

## Playlist privacy model

- Playlist 本身可以一直保持 **Private**。
- Worker 用 `youtube.readonly` OAuth 讀 Private playlist metadata。
- Private 影片會被看到 metadata，但 pipeline 會 skip。
- 真正要處理的影片需暫時設成 **Unlisted**，因為 Browser Run 不保存你的 Google 登入 cookies。
- Worker 沒有權限修改影片 privacy；`Private ↔ Unlisted` 仍由你手動控制。

## 1. Install

```bash
npm install
npm test
npm run typecheck
```

本 repo 不使用 production GitHub Actions，避免 private-repo hosted-runner minutes。

## 2. YouTube playlist

只需要一個 Private playlist，例如：

> AI Memory Inbox

`YOUTUBE_PLAYLIST_ID` 不寫進 repo。從 playlist URL 的 `list=` 取得 ID後，在 Cloudflare Worker 的 runtime settings 新增：

```text
Type: Variable
Name: YOUTUBE_PLAYLIST_ID
Value: PL...
```

## 3. Google Cloud / YouTube OAuth

1. 建 Google Cloud project。
2. Enable **YouTube Data API v3**。
3. 設定 OAuth consent / audience。
4. 建立 **OAuth Client ID → Desktop app**。
5. 取得：
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`

取得 refresh token：

```bash
export YOUTUBE_CLIENT_ID='...'
export YOUTUBE_CLIENT_SECRET='...'
npm run youtube:auth
```

helper 使用：

```text
https://www.googleapis.com/auth/youtube.readonly
```

並要求 offline access。授權後會輸出：

```text
YOUTUBE_REFRESH_TOKEN=...
```

把 Client ID、Client Secret、Refresh Token 都設成 Cloudflare **Secret**。

> OAuth app 若維持 External + Testing，refresh token 可能只有短期效力。第一次 E2E 跑通後，再切到合適的 production publishing 狀態並重新授權。

## 4. Groq API key

Cloudflare Secret：

```text
GROQ_API_KEY
```

預設模型：

```text
STT:     whisper-large-v3
Summary: openai/gpt-oss-120b
```

## 5. GitHub token

建 fine-grained PAT，只授權：

```text
Repository: wulukewu/ai-memory
Contents: Read and write
Metadata: Read
```

Cloudflare Secret：

```text
GITHUB_TOKEN
```

## 6. Admin token

```bash
openssl rand -hex 32
```

把輸出設成 Cloudflare Secret：

```text
ADMIN_TOKEN
```

## 7. Cloudflare runtime configuration

Dashboard：

```text
Workers & Pages
→ meeting-memory-ingest
→ Settings
→ Variables and Secrets
```

必填 Variable：

```text
YOUTUBE_PLAYLIST_ID
```

必填 Secrets：

```text
GROQ_API_KEY
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_REFRESH_TOKEN
GITHUB_TOKEN
ADMIN_TOKEN
```

不要把這些放在 Build variables；程式需要的是 Worker runtime bindings。

`wrangler.jsonc` 已宣告 Browser Run binding：

```jsonc
"browser": {
  "binding": "BROWSER"
}
```

Cloudflare 部署時會把 `env.BROWSER` 綁到 Browser Run。

## 8. Deploy

```bash
npm install
npm run deploy
```

Cron：

```text
*/5 * * * *
```

`keep_vars: true` 已開啟，避免 repo deploy 清掉 Dashboard-only runtime vars/secrets。

## 9. Endpoints

### Health

```text
GET /health
```

不需要 admin token，只回報缺少哪些設定名稱，不會回 secret values。

### Status

```bash
curl \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://YOUR_WORKER.workers.dev/status
```

### Run inbox now

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

影片仍必須是 `Unlisted`。

### Force retry one video

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://YOUR_WORKER.workers.dev/retry/VIDEO_ID?wait=1'
```

`/retry` 會先清掉 manifest 裡的 failed/cooldown 狀態再重新 claim。

## 10. ai-memory output

```text
reference/meeting-transcripts/
├── _manifest.json
├── campus-agent/
├── algorithm/
├── mcl/
└── general/
```

`_manifest.json` 是 durable processing state，包含：

```text
processing / completed / failed
```

Worker 先 claim 再處理，避免 Cron 與手動 trigger 大多數重複 ingest；stuck processing lease 預設 90 分鐘後可回收。

## First real test

1. 把一支短測試影片加入 Private playlist。
2. 把影片本身設成 `Unlisted`。
3. 確認 `/health` 為 `configured: true`。
4. 執行 `/process/VIDEO_ID?wait=1` 或 `/retry/VIDEO_ID?wait=1`。
5. 確認 Browser Run 取得 audio URL。
6. 確認 Groq transcription / summary 成功。
7. 確認 `ai-memory/reference/meeting-transcripts/...md` 與 `_manifest.json` 更新。
8. 再跑一次，應被 manifest 去重。
9. 手動把影片改回 `Private`。

## Security notes

- YouTube OAuth scope 是 readonly。
- Worker 無法修改影片 privacy。
- `GITHUB_TOKEN` 只需能寫 `ai-memory`。
- 所有 API credentials 都是 Worker Secrets。
- Browser Run 使用匿名瀏覽器，只能播放你已手動設為 Unlisted 的影片。
- 自動摘要可能出錯，因此 transcript/summary 只寫到 reference，不會自動提升到 `core.md`。

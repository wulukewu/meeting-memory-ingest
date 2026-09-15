# meeting-memory-ingest

把一個 **Private YouTube playlist** 當成 AI Memory Inbox。平常影片保持 `Private`；要處理時手動切成 `Unlisted`。Cloudflare Worker 每 5 分鐘掃一次，只有真正需要 ingest 的影片才 dispatch GitHub Actions。Action 透過 WireGuard 從可信任出口下載 YouTube 音訊、切成可續傳的轉錄 chunks，再由 Groq 轉錄／摘要，最後把 Markdown 寫進 `wulukewu/ai-memory`。

## 日常操作

1. 錄影／錄音後上傳 YouTube，平常保持 `Private`。
2. 放進唯一的 Private playlist。
3. 要讓 AI 處理時，把該影片改成 `Unlisted`。
4. Worker 最多約 5 分鐘內會發現它並自動開始。
5. 短片會一次完成；長片會自動切段、保存進度，碰到 Groq quota 會等 `retry-after` 後再續跑。
6. 完成後有空再把影片切回 `Private`。已完成的影片不會重複 ingest。

不需要日常手動呼叫 `/run` 或 `/retry`。

## Dashboard

瀏覽器開啟：

```text
https://meeting-memory-ingest.ai-memory.workers.dev/dashboard
```

第一次輸入既有的 `ADMIN_TOKEN`。Worker 會換成一個 7 天有效的 HttpOnly / Secure / SameSite session cookie；token 不會放進 URL 或 localStorage。

Dashboard 會把目前 YouTube playlist 可讀到的影片和 `ai-memory` manifest 合併顯示：

- `已完成`：可把影片改回 Private；如果已經是 Private，就可以直接移出 playlist。
- `處理中`：顯示已完成 chunk / 總 chunk。
- `等待額度`：顯示 Groq quota 後預計續跑時間。
- `失敗`：顯示錯誤資訊；正常 cooldown 後仍會自動重試。
- `待處理`：Unlisted 但尚未被 Cron claim。
- `Private`：尚未排入 ingest。

每支影片都有：

- **Studio 編輯** → `https://studio.youtube.com/video/<videoId>/edit`
- **Playlist** → 在指定 playlist 中開啟該影片
- **YouTube** → 一般影片頁
- **Transcript** → 完成後直達 ai-memory Markdown

頁面預設把最需要人工處理的項目排在前面，並提供狀態 filter、標題 / video ID 搜尋，以及 60 秒自動重新整理。

Dashboard 是唯讀的：它不會自動修改 YouTube visibility，也不會從 playlist 移除影片。

## Architecture

```text
Private YouTube playlist
        │
        │ YouTube Data API + readonly OAuth
        ▼
Cloudflare Worker Cron (*/5)
        │
        ├─ Private video  → skip
        └─ Unlisted video → claim ai-memory manifest
                │
                ▼
GitHub Actions (on demand only)
        │
        ├─ WireGuard full-tunnel egress
        ├─ yt-dlp format 140, native 8 MB HTTP chunks
        ├─ ffmpeg → 16 kHz mono Opus 24 kbps
        └─ split into 45-minute transcript chunks
                │
                ▼
Worker /resolver/transcribe
        │ streaming multipart proxy
        ▼
Groq Whisper Large v3
        │
        ├─ chunk transcript cached in ai-memory/_work
        ├─ 429 → save retryAfterAt and stop cleanly
        └─ next Cron resumes first unfinished chunk
                │
       all chunks complete
                ▼
merge timestamps to whole-video timeline
        │
        ▼
Groq GPT-OSS 120B
summary / decisions / actions / topics
        │
        ▼
GitHub Contents API
        │
        ▼
wulukewu/ai-memory/main
reference/meeting-transcripts/...
```

### Why chunks?

Groq Free tier direct uploads are limited to 25 MB and Whisper has audio-seconds rate limits. Long recordings (including 4–8 hour meetings) therefore cannot safely be treated as one request. The pipeline uses 2,700-second (45-minute) chunks so each upload stays small and completed work can survive rate limits or transient failures.

The resumable state is kept in `reference/meeting-transcripts/_manifest.json`; in-progress transcript chunks are temporarily stored in `reference/meeting-transcripts/_work/<videoId>.json` and deleted after final Markdown is committed.

## YouTube / WireGuard model

GitHub-hosted datacenter IPs can trigger YouTube bot checks. In addition, real testing showed the resulting `googlevideo` signed URL can be bound to the source IP. The resolver therefore downloads the audio while WireGuard is still active instead of handing the signed URL to Groq.

The workflow verifies that WireGuard actually changes the runner public IPv4 before touching YouTube.

Playlist/privacy behavior:

- Playlist can stay **Private** permanently.
- Worker uses `youtube.readonly` OAuth to read it.
- `Private` videos are ignored.
- `Unlisted` means "enqueue this recording for ingest".
- Worker has no permission to change video privacy.

## 1. Install

```bash
npm install
npm test
npm run typecheck
```

## 2. Cloudflare runtime configuration

Dashboard:

```text
Workers & Pages
→ meeting-memory-ingest
→ Settings
→ Variables and Secrets
```

Dashboard-only Variables:

```text
YOUTUBE_PLAYLIST_ID
WORKER_PUBLIC_URL
```

Example:

```text
WORKER_PUBLIC_URL=https://meeting-memory-ingest.ai-memory.workers.dev
```

Secrets:

```text
GROQ_API_KEY
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_REFRESH_TOKEN
GITHUB_TOKEN
ADMIN_TOKEN
RESOLVER_GITHUB_TOKEN
```

`GITHUB_TOKEN`: fine-grained PAT limited to `wulukewu/ai-memory`, Contents Read/Write.

`RESOLVER_GITHUB_TOKEN`: separate fine-grained PAT limited to `wulukewu/meeting-memory-ingest`, Actions Read/Write.

Do not put runtime credentials in Cloudflare Build variables.

## 3. GitHub Actions secrets

Repository:

```text
wulukewu/meeting-memory-ingest
→ Settings
→ Secrets and variables
→ Actions
```

Required:

```text
WORKER_ADMIN_TOKEN  # exactly the same value as Worker ADMIN_TOKEN
WG_CONF             # dedicated WireGuard peer, full-tunnel IPv4
```

`WG_CONF` must route YouTube traffic through the tunnel, typically:

```ini
[Interface]
PrivateKey = ...
Address = 10.x.x.x/32

[Peer]
PublicKey = ...
Endpoint = ...:51820
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

The WireGuard server must provide forwarding + NAT/MASQUERADE to the Internet.

Actions never receive the Groq API key, Google OAuth client secret, YouTube refresh token, or ai-memory PAT.

## 4. YouTube OAuth

1. Enable **YouTube Data API v3**.
2. Create an OAuth Desktop client.
3. Obtain `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`.
4. Run:

```bash
export YOUTUBE_CLIENT_ID='...'
export YOUTUBE_CLIENT_SECRET='...'
npm run youtube:auth
```

Store the resulting `YOUTUBE_REFRESH_TOKEN` as a Cloudflare Secret.

Scope:

```text
https://www.googleapis.com/auth/youtube.readonly
```

## 5. Resolver behavior

The workflow is `workflow_dispatch` only. Worker dispatches it after winning a manifest claim.

Defaults:

```text
yt-dlp: 2026.08.19
YouTube client 1: visionos
fallback: default,web_embedded
format: 140 / bestaudio m4a / bestaudio
native HTTP chunk: 8 MB
transcript chunk: 2700 seconds (45 min)
preprocessing: 16 kHz mono Opus 24 kbps
```

Each resolver run downloads the source once, prepares all local 45-minute chunks, then starts at the manifest's `nextChunkIndex`.

For each chunk:

```text
POST /resolver/transcribe
Authorization: Bearer <WORKER_ADMIN_TOKEN>
X-Video-ID: ...
X-Chunk-Index: ...
```

Worker streams the multipart body directly to Groq without buffering the audio.

### Rate limits / resume

If Groq returns `429`, Worker records the API's `retry-after` as `retryAfterAt`, changes the manifest to `waiting`, and returns HTTP 202 to Actions. The workflow exits successfully because progress was saved intentionally.

Cron will not re-claim that video before `retryAfterAt`. Once eligible again it dispatches a new Action starting at the first unfinished chunk. Already completed chunks are never sent to Whisper again.

If a non-rate-limit failure occurs, status becomes `failed` and the normal 30-minute retry cooldown applies. A lost/stuck `processing` claim expires after 90 minutes.

## 6. Transcript quality

Whisper request parameters:

```text
language=zh
temperature=0
response_format=verbose_json
timestamp_granularities[]=segment
```

No instructional Whisper prompt is used. This avoids prompt text being hallucinated into low-speech portions of a recording.

Whisper transcript text is normalized from Simplified Chinese to Taiwan Traditional Chinese (`cn → tw`) after transcription. English technical terms, product names, commands, and code identifiers remain unchanged. The summary layer is also instructed to prefer Traditional Chinese while preserving English terms.

The Worker conservatively drops segments for which Whisper reports `no_speech_prob >= 0.8`. This is intended to remove obvious silence hallucinations without aggressively deleting uncertain real speech.

Final summary prompts are conservative: discussion possibilities must not be promoted to decisions/action items unless the transcript explicitly contains a decision, commitment, or assignment.

## 7. Deploy

```bash
npm install
npm run deploy
```

Cron:

```text
*/5 * * * *
```

`keep_vars: true` is enabled so repository deploys do not erase Dashboard-only vars/secrets.

## 8. Endpoints

Health:

```text
GET /health
```

Private browser dashboard:

```text
GET /dashboard
```

Status:

```bash
curl \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://meeting-memory-ingest.ai-memory.workers.dev/status
```

Process one video:

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://meeting-memory-ingest.ai-memory.workers.dev/process/VIDEO_ID?wait=1'
```

Manual retry/resume:

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  'https://meeting-memory-ingest.ai-memory.workers.dev/retry/VIDEO_ID?wait=1'
```

Manual retry preserves completed chunk progress; it no longer resets the video to zero.

## 9. ai-memory output

```text
reference/meeting-transcripts/
├── _manifest.json
├── _work/              # temporary resumable state; removed after completion
├── campus-agent/
├── algorithm/
├── mcl/
└── general/
```

Typical state flow:

```text
processing ──chunk success──> processing
    │
    ├─ Groq 429 ────────────> waiting ──retryAfterAt──> processing
    ├─ other error ─────────> failed  ──cooldown─────> processing
    └─ all chunks + summary ─> completed
```

## Security notes

- YouTube OAuth is readonly.
- Worker cannot modify video privacy.
- Dashboard is read-only and protected by the existing `ADMIN_TOKEN`; successful login creates an HMAC-signed HttpOnly session cookie.
- `GITHUB_TOKEN` and `RESOLVER_GITHUB_TOKEN` are deliberately separate.
- Actions only receive `WORKER_ADMIN_TOKEN` and the dedicated WireGuard config.
- Signed YouTube media URLs are not stored or committed.
- Temporary transcript work data lives only in the private `ai-memory` repository and is deleted after completion.
- AI summaries remain reference material and do not automatically modify `core.md`.

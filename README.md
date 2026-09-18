# meeting-memory-ingest

把一個 **Private YouTube playlist** 當成 AI Memory Inbox。平常影片保持 `Private`；要處理時手動切成 `Unlisted`。Cloudflare Worker 定期掃描 playlist，只有真正需要 ingest 的影片才 dispatch GitHub Actions。Action 透過 WireGuard 下載 YouTube 音訊並切段，Groq Whisper 負責轉錄；Cloudflare D1 保存 runtime state，Workers AI + Workflows 負責耐久化摘要，最後只把完成的 Markdown 寫進 `wulukewu/ai-memory`。

## 日常操作

1. 錄影／錄音後上傳 YouTube，平常保持 `Private`。
2. 放進唯一的 Private playlist。
3. 要處理時把影片切成 `Unlisted`。
4. Worker cron 每 30 分鐘掃描一次；Dashboard 也可按「立即掃描」。
5. 長片會自動切成 45 分鐘 chunks；Groq quota 用完時會保存進度並在 retry window 後續跑。
6. 所有 chunks 完成後由 Cloudflare Workflow 分段摘要、合併、發布。
7. 最終只在 `ai-memory/reference/meeting-transcripts/...` 寫入一份 Markdown。
8. 完成後可把影片切回 `Private` 並移出 playlist。

## Storage boundary

這個 repo 刻意把「運行狀態」和「長期記憶」分開：

- **D1 / `QUEUE_DB`**：影片 status、attempts、lease、retry time、chunk progress、final path。
- **D1** 也保存暫時的 Whisper chunk JSON、summary inputs 與 summary outputs；完成 publish 後清除。
- **Workers AI / `AI`**：使用 `@cf/zai-org/glm-4.7-flash` 產生會議摘要。
- **Cloudflare Workflows / `FINALIZE_WORKFLOW`**：可恢復的多步摘要與 final publish。
- **GitHub `ai-memory`**：只保存完成後值得長期查閱的 meeting Markdown。

因此正常 steady state 不再為 claim、retry、chunk completion 產生 Git commits；一場新 meeting 通常只會在最後 publish 時產生一個 `feat(meetings): ingest <videoId>` commit。

## Architecture

```text
Private YouTube playlist
        │
        ▼
Cloudflare Worker
        │
        ├─ D1: queue / retry / progress
        │
        └─ Unlisted video → claim
                │
                ▼
GitHub Actions resolver
        │
        ├─ WireGuard full-tunnel egress
        ├─ yt-dlp downloads YouTube audio
        ├─ ffmpeg → 16 kHz mono Opus 24 kbps
        └─ 45-minute chunks
                │
                ▼
Worker /resolver/transcribe
        │
        ├─ stream chunk to Groq Whisper
        ├─ transcript JSON → D1
        └─ progress → D1
                │
          all chunks complete
                ▼
Cloudflare Workflow
        │
        ├─ reconstruct transcript from D1
        ├─ durable per-part Workers AI summaries
        ├─ combine final summary
        ├─ publish final Markdown to ai-memory
        ├─ D1 → completed
        └─ cleanup temporary D1 rows
```

The finalization Workflow persists successful steps, so a later model/API failure does not force the whole meeting to be downloaded or summarized again.

## Dashboard

Open:

```text
https://meeting-memory-ingest.ai-memory.workers.dev/dashboard
```

Use the existing `ADMIN_TOKEN` to log in. The Worker exchanges it for a 7-day HttpOnly / Secure / SameSite session cookie.

Dashboard states include:

- **已完成**：final Markdown exists; video can be made Private / removed from playlist.
- **轉錄中**：resolver is producing remaining chunks.
- **整理摘要中**：all chunks are safe in D1 and the Cloudflare Workflow is finalizing.
- **等待 Groq 額度**：retry-after is stored in D1.
- **YouTube 冷卻中**：resolver egress hit a bot-verification block.
- **失敗**：cooldown then automatic retry; error details remain in D1.
- **待處理**：Unlisted but not yet claimed.
- **Private**：not queued.

## Cloudflare resources

`wrangler.jsonc` declares:

```jsonc
{
  "d1_databases": [{ "binding": "QUEUE_DB" }],
  "ai": { "binding": "AI" },
  "workflows": [
    {
      "name": "meeting-memory-finalize",
      "binding": "FINALIZE_WORKFLOW",
      "class_name": "FinalizeMeetingWorkflow"
    }
  ]
}
```

Production uses one explicit D1 binding. R2 is intentionally not used so this independent Cloudflare account does not need an R2 subscription or payment method. The D1 database ID is a non-secret resource identifier and can be committed in `wrangler.jsonc`.

The Worker also bootstraps the v1 D1 tables with `CREATE TABLE IF NOT EXISTS`; `migrations/0001_runtime_state.sql` is kept as the canonical schema for inspection and future migrations.

### Existing Dashboard variables / secrets

Dashboard-only variables remain:

```text
YOUTUBE_PLAYLIST_ID
WORKER_PUBLIC_URL
```

Secrets remain:

```text
GROQ_API_KEY
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_REFRESH_TOKEN
GITHUB_TOKEN
ADMIN_TOKEN
RESOLVER_GITHUB_TOKEN
```

`GITHUB_TOKEN` is still needed, but after migration its normal runtime role is only publishing the final meeting Markdown to `ai-memory`.

## One-time migration from legacy ai-memory state

Older versions used:

```text
reference/meeting-transcripts/_manifest.json
reference/meeting-transcripts/_work/<videoId>.json
```

as the queue database. That caused excessive commits and eventually hit the GitHub Contents API inline-content limit when a work JSON exceeded 1 MiB.

The new Worker performs a **one-shot migration automatically before the first cron/manual processing run**:

1. Read the old manifest.
2. Insert job state into D1.
3. Recover already-completed transcript chunks into D1, including legacy work files larger than 1 MiB via the Git blob API.
4. Mark the migration in D1 `runtime_meta` so it cannot overwrite newer runtime state on later runs.
5. Convert legacy in-flight `processing` jobs into immediately resumable state.

For diagnostics, the same migration can be invoked manually by an authenticated admin:

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://meeting-memory-ingest.ai-memory.workers.dev/admin/migrate-legacy-state
```

Do **not** delete the old `_manifest.json` / `_work` files until the first migration has been verified. After D1 has the state and active jobs resume successfully, those legacy files can be removed from the current tree. Rewriting old Git history is a separate, deliberate operation.

## Resolver behavior

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

Each resolver run downloads the source once and starts uploading from the first unfinished chunk recorded in D1. Already completed chunks are read from D1 and are not sent to Whisper again.

After the last transcript chunk is stored, `/resolver/transcribe` returns `finalizing`; the GitHub Action exits successfully while Cloudflare Workflow continues independently.

The resolver captures `cf-error-type`, `cf-ray`, and `server` response headers on Worker errors to make future Cloudflare runtime failures diagnosable.

## Rate limits and recovery

If Groq Whisper transcription returns `429`, Worker records the API retry window in D1 and returns HTTP 202. Cron does not re-claim the video before that time.

The summary phase runs inside Workflows as separate durable steps using Workers AI. Each completed partial summary is checkpointed in D1; retries do not require re-downloading YouTube audio or re-running Whisper.

A lost/stuck resolver `processing` claim expires after 90 minutes. A normal non-rate-limit failure uses a 30-minute retry cooldown.

## YouTube / WireGuard model

GitHub-hosted datacenter IPs can trigger YouTube bot checks. The resolver therefore downloads audio while WireGuard is active and restores normal runner egress before uploading chunks to the Worker/Groq path.

The callback preserves `youtube_bot_blocked` and `retryAfterSeconds`, so a bot challenge becomes a recoverable global YouTube cooldown instead of a generic failure.

Playlist/privacy behavior:

- Playlist can remain **Private**.
- Worker uses `youtube.readonly` OAuth.
- `Private` videos are ignored.
- `Unlisted` means “enqueue this recording”.
- Worker never changes video privacy.

## Transcript quality

Whisper parameters:

```text
language=zh
temperature=0
response_format=verbose_json
timestamp_granularities[]=segment
```

Transcript text is normalized from Simplified Chinese to Taiwan Traditional Chinese while preserving English technical terms, product names, commands, and code identifiers. Segments with `no_speech_prob >= 0.8` are conservatively discarded.

Summary prompts run on Workers AI (`@cf/zai-org/glm-4.7-flash`) and only promote explicit decisions, commitments, or assignments into decisions/action items.

## Development

```bash
npm install
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

CI runs tests, TypeScript checking, and a Wrangler dry-run bundle validation.

## GitHub Actions secrets

Repository:

```text
wulukewu/meeting-memory-ingest
→ Settings
→ Secrets and variables
→ Actions
```

Required:

```text
WORKER_ADMIN_TOKEN  # same value as Worker ADMIN_TOKEN
WG_CONF             # dedicated WireGuard peer, full-tunnel IPv4
```

Actions do not receive the Groq key, Workers AI credentials (the Worker uses a native binding), YouTube OAuth secrets, or `ai-memory` PAT.

## Endpoints

```text
GET  /health
GET  /dashboard
GET  /status
POST /run
POST /process/<videoId>
POST /retry/<videoId>
POST /resolver/transcribe
POST /resolver/callback
POST /admin/migrate-legacy-state
```

All non-dashboard administrative/runtime endpoints require the existing bearer `ADMIN_TOKEN`.

## Security notes

- YouTube OAuth is readonly.
- OAuth access tokens are used inside a Workflow step but are **not returned as durable step output**.
- D1 contains operational metadata; D1 contains both operational metadata and temporary transcript working data.
- Temporary D1 transcript/summary rows are deleted after successful durable publish.
- Signed YouTube media URLs are never stored.
- `GITHUB_TOKEN` and `RESOLVER_GITHUB_TOKEN` remain separate.
- Automatic Git commits use the unlinked identity `wulukewu <luke@ai-memory.local>`.
- AI summaries are reference material and do not automatically modify `core.md`.


## Why D1-only

This Worker intentionally avoids R2. On the Workers Free plan, D1 supports a 500 MB database, 5 GB total account storage, 5 million rows read/day, 100,000 rows written/day, and up to 2,000,000 bytes per TEXT/BLOB/row. Each 45-minute transcript chunk is stored independently and rejected before 1.9 MB, so one long meeting never becomes one giant database row.

The completed meeting transcript is not kept as duplicate runtime storage. It is reconstructed from D1 chunks during finalization, published to ai-memory, and then its temporary D1 rows are deleted.

CREATE TABLE IF NOT EXISTS videos (
  video_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  youtube_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','waiting','finalizing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  failed_at TEXT,
  retry_after_at TEXT,
  path TEXT,
  last_error TEXT,
  transcription_model TEXT,
  summary_model TEXT,
  duration_seconds INTEGER,
  chunk_seconds INTEGER,
  total_chunks INTEGER,
  next_chunk_index INTEGER NOT NULL DEFAULT 0,
  finalization_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript_chunks (
  video_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (video_id, chunk_index),
  FOREIGN KEY (video_id) REFERENCES videos(video_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS summary_inputs (
  video_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  input_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (video_id, part_index),
  FOREIGN KEY (video_id) REFERENCES videos(video_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runtime_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_videos_status_updated ON videos(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_videos_retry_after ON videos(status, retry_after_at);
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_video ON transcript_chunks(video_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_summary_inputs_video ON summary_inputs(video_id, part_index);

import type { Env, StoredTranscriptWork } from "./types";
import { getTextFile, legacyWorkPath, loadLegacyManifest } from "./github";
import { upsertLegacyEntry } from "./state";
import { putStoredChunk } from "./work-store";

export interface LegacyMigrationResult {
  videos: number;
  completedVideos: number;
  workFiles: number;
  chunks: number;
  missingWorkFiles: string[];
}

export async function migrateLegacyAiMemoryState(env: Env): Promise<LegacyMigrationResult> {
  const manifest = await loadLegacyManifest(env);
  if (!manifest) {
    return { videos: 0, completedVideos: 0, workFiles: 0, chunks: 0, missingWorkFiles: [] };
  }

  const result: LegacyMigrationResult = {
    videos: 0,
    completedVideos: 0,
    workFiles: 0,
    chunks: 0,
    missingWorkFiles: [],
  };

  for (const [videoId, entry] of Object.entries(manifest.videos)) {
    await upsertLegacyEntry(env, videoId, { ...entry, updatedAt: manifest.updatedAt });
    result.videos += 1;

    if (entry.status === "completed") {
      result.completedVideos += 1;
      continue;
    }

    if (!(entry.completedChunks?.length)) continue;
    const file = await getTextFile(env, legacyWorkPath(env, videoId));
    if (!file) {
      result.missingWorkFiles.push(videoId);
      continue;
    }

    result.workFiles += 1;
    const work = JSON.parse(file.text) as StoredTranscriptWork;
    if (work.version !== 1 || work.videoId !== videoId || !work.chunks || typeof work.chunks !== "object") {
      throw new Error(`invalid legacy work file for ${videoId}`);
    }

    for (const chunkIndex of entry.completedChunks) {
      const chunk = work.chunks[String(chunkIndex)];
      if (!chunk) continue;
      const key = await putStoredChunk(env, chunk);
      await env.STATE_DB.prepare(
        "INSERT OR REPLACE INTO chunks (video_id,chunk_index,r2_key,completed_at) VALUES (?,?,?,?)",
      ).bind(videoId, chunkIndex, key, manifest.updatedAt).run();
      result.chunks += 1;
    }
  }

  return result;
}

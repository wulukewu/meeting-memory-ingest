import type { Env, StoredTranscriptWork } from "./types";
import { getTextFile, legacyWorkPath, loadLegacyManifest } from "./github";
import { runtimeMeta, setRuntimeMeta, upsertLegacyEntry } from "./state";
import { putStoredChunk } from "./work-store";

export interface LegacyMigrationResult {
  alreadyMigrated: boolean;
  videos: number;
  completedVideos: number;
  workFiles: number;
  chunks: number;
  missingWorkFiles: string[];
}

export async function migrateLegacyAiMemoryState(env: Env): Promise<LegacyMigrationResult> {
  const migrationKey = "legacy_ai_memory_migration_v1";
  if (await runtimeMeta(env, migrationKey)) {
    return { alreadyMigrated: true, videos: 0, completedVideos: 0, workFiles: 0, chunks: 0, missingWorkFiles: [] };
  }

  const manifest = await loadLegacyManifest(env);
  if (!manifest) {
    await setRuntimeMeta(env, migrationKey, "no-legacy-manifest");
    return { alreadyMigrated: false, videos: 0, completedVideos: 0, workFiles: 0, chunks: 0, missingWorkFiles: [] };
  }

  const result: LegacyMigrationResult = {
    alreadyMigrated: false,
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
      await putStoredChunk(env, chunk);
      result.chunks += 1;
    }
  }

  await setRuntimeMeta(env, migrationKey, JSON.stringify({ migratedAt: new Date().toISOString(), ...result }));
  return result;
}

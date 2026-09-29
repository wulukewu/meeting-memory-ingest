// @ts-expect-error Test runtime is Node; Worker tsconfig intentionally omits Node builtin types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isGitHubRunId, isResolverJobToken, resolverRunUrl } from "../src/resolver-job";

const workflow = readFileSync(
  new URL("../.github/workflows/resolve-youtube.yml", import.meta.url),
  "utf8",
);

describe("public-safe resolver workflow", () => {
  it("uses an opaque resolver ticket instead of private video metadata as dispatch input", () => {
    expect(workflow).toContain("resolver_job_token:");
    expect(workflow).toContain("worker_url:");
    expect(workflow).not.toMatch(/^\s+video_id:/m);
    expect(workflow).not.toMatch(/^\s+callback_url:/m);
    expect(workflow).not.toMatch(/^\s+transcription_model:/m);
    expect(workflow).not.toMatch(/^\s+start_chunk_index:/m);
    expect(workflow).not.toMatch(/^\s+chunk_seconds:/m);
  });

  it("masks the resolved YouTube id before resolver tools can print it", () => {
    const mask = workflow.indexOf('echo "::add-mask::$VIDEO_ID"');
    const ytDlp = workflow.indexOf("yt-dlp \\");
    expect(mask).toBeGreaterThan(0);
    expect(ytDlp).toBeGreaterThan(mask);
  });

  it("does not stream private resolver diagnostics or raw Worker JSON into Actions logs", () => {
    expect(workflow).not.toContain('tee "$ERR_FILE" >&2');
    expect(workflow).not.toContain("cat /tmp/callback-response.json");
    expect(workflow).not.toContain("cat /tmp/resolver-job.json");
  });

  it("registers the public Actions run before resolving private meeting metadata", () => {
    const registrationStart = workflow.indexOf('RUN_META_PAYLOAD="$(jq -n');
    const privateJobFetch = workflow.indexOf('JOB_URL="${WORKER_URL}/resolver/job/');
    expect(registrationStart).toBeGreaterThan(0);
    expect(privateJobFetch).toBeGreaterThan(registrationStart);
    const registration = workflow.slice(registrationStart, privateJobFetch);
    expect(registration).toContain('"${WORKER_URL}/resolver/run"');
    expect(registration).toContain("$GITHUB_RUN_ID");
    expect(registration).not.toContain("VIDEO_ID");
  });
});

describe("resolver job token validation", () => {
  it("accepts UUIDv4 tickets and rejects YouTube ids or arbitrary text", () => {
    expect(isResolverJobToken("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(isResolverJobToken("u5FQBLKyRsQ")).toBe(false);
    expect(isResolverJobToken("not-a-ticket")).toBe(false);
  });

  it("validates Actions run ids and constructs the canonical repository run URL", () => {
    expect(isGitHubRunId("36522750376")).toBe(true);
    expect(isGitHubRunId("run-36522750376")).toBe(false);
    expect(
      resolverRunUrl(
        { RESOLVER_GITHUB_OWNER: "wulukewu", RESOLVER_GITHUB_REPO: "meeting-memory-ingest" },
        "36522750376",
      ),
    ).toBe("https://github.com/wulukewu/meeting-memory-ingest/actions/runs/36522750376");
  });
});

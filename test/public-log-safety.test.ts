import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isResolverJobToken } from "../src/resolver-job";

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
});

describe("resolver job token validation", () => {
  it("accepts UUIDv4 tickets and rejects YouTube ids or arbitrary text", () => {
    expect(isResolverJobToken("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(isResolverJobToken("u5FQBLKyRsQ")).toBe(false);
    expect(isResolverJobToken("not-a-ticket")).toBe(false);
  });
});

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderDashboard } from "../src/dashboard";
import type { Env, Manifest } from "../src/types";

function renderEmptyDashboard(): string {
  const manifest: Manifest = {
    version: 1,
    updatedAt: "2026-09-24T00:00:00.000Z",
    videos: {},
  };
  return renderDashboard({} as Env, [], manifest);
}

describe("dashboard embedded client script", () => {
  it("parses as browser JavaScript", () => {
    const html = renderEmptyDashboard();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);

    expect(match?.[1]).toBeTruthy();
    try {
      new Script(match![1], { filename: "dashboard-client.js" });
    } catch (error) {
      const stack = error instanceof Error ? error.stack || error.message : String(error);
      console.error(stack);
      const lineMatch = stack.match(/dashboard-client\.js:(\d+)/);
      if (lineMatch) {
        const line = Number(lineMatch[1]);
        const lines = match![1].split("\n");
        console.error(lines.slice(Math.max(0, line - 3), line + 2).map((value, index) => `${Math.max(1, line - 2) + index}: ${value}`).join("\n"));
      }
      throw error;
    }
  });

  it("keeps the state-driven motion hooks in the rendered dashboard", () => {
    const html = renderEmptyDashboard();

    expect(html).toContain("captureCardMotionState");
    expect(html).toContain("animateCardChanges");
    expect(html).toContain("startViewTransition");
    expect(html).toContain("syncBreath");
    expect(html).toContain("prefers-reduced-motion");
  });
});

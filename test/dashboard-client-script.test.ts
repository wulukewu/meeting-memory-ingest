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
    expect(() => new Function(match![1])).not.toThrow();
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

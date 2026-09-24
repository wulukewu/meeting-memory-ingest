import { describe, expect, it } from "vitest";
import { renderDashboard } from "../src/dashboard";
import type { Env, Manifest } from "../src/types";

describe("dashboard embedded client script", () => {
  it("renders browser JavaScript that parses successfully", () => {
    const manifest: Manifest = {
      version: 1,
      updatedAt: "2026-09-24T00:00:00.000Z",
      videos: {},
    };

    const html = renderDashboard({} as Env, [], manifest);
    const match = html.match(/<script>([\s\S]*?)<\/script>/);

    expect(match?.[1]).toBeTruthy();
    expect(() => new Function(match![1])).not.toThrow();
  });

  it("renders stable motion hooks for stateful cards", () => {
    const manifest: Manifest = {
      version: 1,
      updatedAt: "2026-09-24T00:00:00.000Z",
      videos: {},
    };

    const html = renderDashboard({} as Env, [], manifest);

    expect(html).toContain("captureVisibleLayout");
    expect(html).toContain("animateLayoutFrom");
    expect(html).toContain("syncBreath");
    expect(html).toContain("prefers-reduced-motion");
  });
});

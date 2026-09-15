import { describe, expect, it } from "vitest";
import { FAVICON_SVG, faviconResponse } from "../src/favicon";

describe("favicon", () => {
  it("serves the Meeting Memory SVG icon", async () => {
    const response = faviconResponse();
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(await response.text()).toBe(FAVICON_SVG);
    expect(FAVICON_SVG).toContain("viewBox=\"0 0 64 64\"");
  });
});

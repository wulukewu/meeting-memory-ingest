import { describe, expect, it } from "vitest";
import { formatTimestamp, inferCategoryFromTitle, parseIsoDuration, slugify, splitByApproxChars } from "../src/util";

describe("utility helpers", () => {
  it("formats timestamps", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp(3723.9)).toBe("01:02:03");
  });

  it("parses YouTube ISO durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT9M")).toBe(540);
  });

  it("keeps unicode titles usable in slugs", () => {
    expect(slugify("資工專題 Meeting #3")).toBe("資工專題-meeting-3");
  });

  it("infers common meeting categories", () => {
    expect(inferCategoryFromTitle("[MCL] weekly meeting")).toBe("mcl");
    expect(inferCategoryFromTitle("DC 演算法檢討")).toBe("algorithm");
    expect(inferCategoryFromTitle("資工專題 meeting")).toBe("campus-agent");
  });

  it("splits transcript chunks without dropping lines", () => {
    const chunks = splitByApproxChars(["aaaa", "bbbb", "cccc"], 9);
    expect(chunks).toEqual(["aaaa\nbbbb", "cccc"]);
  });
});

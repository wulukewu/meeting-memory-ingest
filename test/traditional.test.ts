import { describe, expect, it } from "vitest";
import { toTaiwanTraditional } from "../src/traditional";

describe("Taiwan Traditional Chinese normalization", () => {
  it("converts Simplified Chinese while preserving English and technical terms", () => {
    expect(toTaiwanTraditional("这个系统用 Google Colab、TPU 和 H100 做模型训练"))
      .toBe("這個系統用 Google Colab、TPU 和 H100 做模型訓練");
  });

  it("leaves existing Traditional Chinese and mixed English intact", () => {
    expect(toTaiwanTraditional("這個 pipeline 用 Codex 和 GitHub Actions 自動處理"))
      .toBe("這個 pipeline 用 Codex 和 GitHub Actions 自動處理");
  });
});

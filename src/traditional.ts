import OpenCC from "opencc-js";

const toTaiwanTraditionalConverter = OpenCC.Converter({ from: "cn", to: "tw" });

export function toTaiwanTraditional(text: string): string {
  return toTaiwanTraditionalConverter(text);
}

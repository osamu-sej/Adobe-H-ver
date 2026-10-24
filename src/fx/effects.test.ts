import { describe, expect, it } from "vitest";
import { autoStrength, blurSigma, resolveStrength } from "./effects";

describe("モザイク・ぼかしの程度", () => {
  const line = { w: 80, h: 13 };
  it("弱 < 中 < 強 の順に強くなる", () => {
    expect(autoStrength(line, "weak")).toBeLessThan(autoStrength(line, "medium"));
    expect(autoStrength(line, "medium")).toBeLessThan(autoStrength(line, "strong"));
  });
  it("強は文字高の半分以上（読めない）", () => {
    expect(autoStrength(line, "strong")).toBeGreaterThanOrEqual(line.h / 2);
  });
  it("弱はうっすら判別できる細かさまで下げられる", () => {
    expect(autoStrength(line, "weak")).toBeLessThan(line.h * 0.25);
    expect(blurSigma(autoStrength(line, "weak"))).toBeLessThan(2);
  });
  it("細かく指定した強さは程度より優先される", () => {
    expect(resolveStrength({ ...line, strength: 9, level: "weak" })).toBe(9);
    expect(resolveStrength({ ...line, strength: null, level: "weak" })).toBe(autoStrength(line, "weak"));
  });
  it("程度がない古いデータは「強」として扱う", () => {
    expect(resolveStrength({ ...line, strength: null })).toBe(autoStrength(line, "strong"));
  });
});

import { describe, expect, it } from "vitest";
import { autoStrength, blurSigma, renderPatch, resolveStrength, type PixelSource } from "./effects";

describe("モザイク・ぼかしの程度", () => {
  const line = { w: 80, h: 13 };
  it("弱 < 中 < 強 の順に強くなる", () => {
    expect(autoStrength(line, "weak")).toBeLessThan(autoStrength(line, "medium"));
    expect(autoStrength(line, "medium")).toBeLessThan(autoStrength(line, "strong"));
  });
  it("強は文字高の3割以上（ほとんど読めない）", () => {
    expect(autoStrength(line, "strong")).toBeGreaterThanOrEqual(line.h * 0.3);
  });
  it("弱は多少は推測できる細かさ（文字高の15%未満）", () => {
    expect(autoStrength(line, "weak")).toBeLessThan(line.h * 0.15);
    expect(blurSigma(autoStrength(line, "weak"))).toBeLessThan(1.2);
  });
  it("細かく指定した強さは程度より優先される", () => {
    expect(resolveStrength({ ...line, strength: 9, level: "weak" })).toBe(9);
    expect(resolveStrength({ ...line, strength: null, level: "weak" })).toBe(autoStrength(line, "weak"));
  });
  it("程度がない古いデータは「強」として扱う", () => {
    expect(resolveStrength({ ...line, strength: null })).toBe(autoStrength(line, "strong"));
  });
});

describe("塗りつぶし", () => {
  // 左半分が黒、右半分が白の 4×2 px（1px = 1pt）
  const src: PixelSource = {
    data: new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255]),
    width: 4,
    height: 2,
    channels: 3,
    originX: 0,
    originY: 0,
    scale: 1,
  };
  const rect = { x: 0, y: 0, w: 4, h: 2 };
  const px = (data: Uint8ClampedArray, i: number) => [...data.slice(i * 4, i * 4 + 4)];

  it("不透明なら選んだ色で塗る", () => {
    const p = renderPatch(src, rect, "fill", 1, 1, { color: "#3b6fd8", opacity: 1 });
    expect(px(p.data, 0)).toEqual([59, 111, 216, 255]);
    expect(px(p.data, 3)).toEqual([59, 111, 216, 255]);
  });

  it("透明度があると下の見た目が透ける", () => {
    const p = renderPatch(src, rect, "fill", 1, 1, { color: "#6b7280", opacity: 0.5 });
    // 黒の上：0*0.5 + 色*0.5、白の上：255*0.5 + 色*0.5
    expect(px(p.data, 0)).toEqual([54, 57, 64, 255]);
    expect(px(p.data, 3)).toEqual([181, 184, 192, 255]);
  });
});

import { describe, expect, it } from "vitest";
import { supplementDigits, supplementLines } from "./ocrSupplement";
import { buildIndex, snapToRange } from "./text";
import type { OcrLine } from "./ocrText";
import type { PageText } from "./types";

function word(text: string, x: number, confidence = 90, width = 8): OcrLine["words"][number] {
  return {
    confidence,
    bbox: { x0: x, y0: 20, x1: x + text.length * 10, y1: 40 },
    symbols: [...text].map((c, i) => ({ text: c, confidence, bbox: { x0: x + i * 10, y0: 20, x1: x + i * 10 + width, y1: 40 } })),
  };
}
const img = { data: new Uint8Array(300 * 100), width: 300, height: 100 };
const id: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
const base: PageText = {
  chars: ["文"], boxes: Float32Array.from([10, 20, 20, 40]), lines: Int32Array.from([0]), sizes: Float32Array.from([20]),
};

describe("元画像による数字の追加読み取り", () => {
  it("数字が複数ある信頼できる語だけを候補にする", () => {
    const input: OcrLine[] = [{ words: [word("12", 20), word("4", 50), word("A12", 70), word("45", 120, 10), word("12(-3)", 160)] }];
    expect(supplementLines(input)[0].words.map((w) => w.symbols.map((s) => s.text).join(""))).toEqual(["12", "12(-3)"]);
  });

  it("既存の文字を保ち、離れた数字を吸着できるように足す", () => {
    const input: OcrLine[] = [{ words: [word("42", 100)] }];
    const result = supplementDigits(base, input, id, img);
    expect(result.chars[0]).toBe("文");
    const hits = snapToRange(buildIndex(result), { x: 90, y: 0, w: 60, h: 80 }, "digits");
    expect(hits.map((h) => h.text)).toEqual(["42"]);
  });

  it("既存の文字と重なる候補は重複して足さず、細長い罫線の候補も除く", () => {
    const overlap: OcrLine[] = [{ words: [word("42", 10)] }];
    const duplicate = supplementDigits(base, overlap, id, img);
    expect(duplicate.chars.filter((c, i) => c === "4" && duplicate.boxes[i * 4] < 20)).toEqual([]);
    const line = word("55", 100, 90, 1);
    const filtered = supplementDigits(base, [{ words: [line] }], id, img);
    expect(filtered.chars).not.toContain("5");
  });

  it("最初のOCRが空白と誤認した位置にも数字を追加する", () => {
    const space: PageText = {
      chars: [" "], boxes: Float32Array.from([95, 15, 130, 45]), lines: Int32Array.from([0]), sizes: Float32Array.from([20]),
    };
    const result = supplementDigits(space, [{ words: [word("42", 100)] }], id, img);
    const hits = snapToRange(buildIndex(result), { x: 90, y: 0, w: 60, h: 80 }, "digits");
    expect(hits.map((h) => h.text)).toEqual(["42"]);
  });

  it("明るい画像でインクが対応しない数字だけの語は除き、暗い背景の白抜き文字は残す", () => {
    const doubtful = { ...word("42", 100), inkMatched: false };
    const light = { ...img, data: new Uint8Array(300 * 100).fill(255) };
    expect(supplementDigits(base, [{ words: [doubtful] }], id, light)).toBe(base);
    expect(supplementDigits(base, [{ words: [doubtful] }], id, img).chars.join("")).toContain("42");
  });

  it("追加後も最初の認識のマスク範囲を変えない", () => {
    const original: PageText = {
      chars: ["1", "2"], boxes: Float32Array.from([20, 20, 28, 40, 30, 20, 38, 40]),
      lines: Int32Array.from([0, 0]), sizes: Float32Array.from([20, 20]),
    };
    const area = { x: 0, y: 0, w: 60, h: 80 };
    const before = snapToRange(buildIndex(original), area, "digits");
    const after = supplementDigits(original, [{ words: [word("42", 100)] }], id, img);
    expect(snapToRange(buildIndex(after), area, "digits")).toEqual(before);
  });
});

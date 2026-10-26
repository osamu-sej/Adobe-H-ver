import { describe, expect, it } from "vitest";
import { CharFlag, type TextResult } from "../engine/protocol";
import { mergeOcr, ocrPlan, visibleTextBoxes, withoutGarbled } from "./pageText";
import { buildIndex, snapToRange } from "./text";
import type { PageText } from "./types";

/** 1文字 10pt 幅で横に並べた文字層。flags で見えない文字・文字化けを指定する */
function layer(text: string, y = 100, line = 0, flags?: number[]): TextResult {
  const chars = [...text];
  return {
    chars,
    boxes: Float32Array.from(chars.flatMap((_, i) => [100 + i * 10, y, 110 + i * 10, y + 10])),
    lines: Int32Array.from(chars.map(() => line)),
    sizes: Float32Array.from(chars.map(() => 10)),
    flags: Uint8Array.from(flags ?? chars.map(() => 0)),
  };
}

function concat(a: PageText, b: PageText): PageText {
  return {
    chars: [...a.chars, ...b.chars],
    boxes: Float32Array.from([...a.boxes, ...b.boxes]),
    lines: Int32Array.from([...a.lines, ...b.lines]),
    sizes: Float32Array.from([...a.sizes, ...b.sizes]),
  };
}

describe("PDFの文字層と文字認識の組み合わせ", () => {
  it("ふつうの文字だけのページは読まない", () => {
    expect(ocrPlan(layer("Total 1,234"))).toBeNull();
    expect(ocrPlan({ ...layer("Total 1,234"), images: 1, figures: 0 })).toBeNull();
  });

  it("文字がなく画像だけ・文字がすべて化けている・文字を図形にしただけのページは、ページ全体を読む", () => {
    expect(ocrPlan({ ...layer(""), images: 1 })).toBe("page");
    expect(ocrPlan(layer("ABC", 100, 0, [2, 2, 2]))).toBe("page");
    expect(ocrPlan({ ...layer(""), glyphPaths: 10 })).toBe("page");
    // 何も描かれていないページは読まない
    expect(ocrPlan(layer(""))).toBeNull();
  });

  it("見えない文字ばかりで、ページを覆う画像があれば、スキャンに重ねた文字層とみなして読み直す", () => {
    const hidden = layer("1,234,567", 100, 0, [1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(ocrPlan({ ...hidden, images: 1, cover: true })).toBe("page");
    // 覆う画像がない（透明の文字が少しあるだけ）なら、そのまま
    expect(ocrPlan({ ...concat(layer("Total"), hidden), flags: Uint8Array.from([0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]) })).toBeNull();
  });

  it("文字のあるページに、貼り付けた画像・文字の図形・文字化けがあれば、その部分を読んで足す", () => {
    expect(ocrPlan({ ...layer("Total"), images: 1, figures: 1 })).toBe("extra");
    expect(ocrPlan({ ...layer("Total"), glyphPaths: 6 })).toBe("extra");
    expect(ocrPlan({ ...layer("Total"), glyphPaths: 3 })).toBeNull();
    expect(ocrPlan(layer("Total�", 100, 0, [0, 0, 0, 0, 0, CharFlag.Garbled]))).toBe("extra");
  });

  it("文字化けした文字は文字層から除き、白く消す範囲にも入れない（文字認識で読み直すため）", () => {
    const t = layer("ab�c", 100, 0, [0, 0, CharFlag.Garbled, 0]);
    expect(withoutGarbled(t).chars.join("")).toBe("abc");
    expect(withoutGarbled(t).boxes.length).toBe(12);
    // 見えない文字も消さない（下の画像の文字を消してしまうため）
    const u = layer("abc", 100, 0, [0, CharFlag.Hidden, CharFlag.Garbled]);
    expect(visibleTextBoxes(u)).toEqual([100, 100, 110, 110]);
  });

  it("文字認識した文字のうち、PDFの文字と同じ所のものは捨て、ほかは別の行として足す", () => {
    const base = layer("Total", 100, 3);
    const blockers = visibleTextBoxes(base);
    // PDFの文字の上で読んだ「Tota」（消し残し）と、画像の中の「98765」
    const ocr = concat(layer("Tota", 101, 0), layer("98765", 300, 1));
    const merged = mergeOcr(base, blockers, ocr);
    expect(merged.chars.join("")).toBe("Total98765");
    expect([...merged.lines].slice(5)).toEqual([4, 4, 4, 4, 4]);
    // 足した数字にも吸着できる
    const hits = snapToRange(buildIndex(merged), { x: 90, y: 290, w: 100, h: 30 }, "digits");
    expect(hits.map((h) => h.text)).toEqual(["98765"]);
    // 何も足すものがなければ元のまま
    expect(mergeOcr(base, blockers, layer("Tot", 100, 0))).toBe(base);
  });
});

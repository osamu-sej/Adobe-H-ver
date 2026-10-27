import { describe, expect, it } from "vitest";
import { buildCollages, fromCollage, mergeFill, unreadBoxes } from "./ocrFill";
import type { GrayImage, OcrLine, OcrWord } from "./ocrText";

const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

/** 白地の画像に、数字ほどの大きさのインクの四角（幅 w・高さ h、濃さ v）を置く */
function image(width: number, height: number, blobs: { x: number; y: number; w: number; h: number; v: number }[]): GrayImage {
  const data = new Uint8Array(width * height).fill(255);
  for (const b of blobs) for (let y = b.y; y < b.y + b.h; y++) data.fill(b.v, y * width + b.x, y * width + b.x + b.w);
  return { data, width, height };
}

function word(text: string, b: ReturnType<typeof box>, confidence = 90): OcrWord {
  const w = (b.x1 - b.x0) / text.length;
  return {
    confidence,
    bbox: b,
    symbols: [...text].map((c, i) => ({ text: c, confidence, bbox: box(b.x0 + i * w, b.y0, b.x0 + (i + 1) * w, b.y1) })),
  };
}

describe("読み残しの読み直し", () => {
  // 1行目：読めた「123」と、その右の読み残した薄い数字2つ。2行目：ぽつんとある1文字の数字
  const img = image(400, 200, [
    { x: 20, y: 20, w: 16, h: 30, v: 0 },
    { x: 40, y: 20, w: 16, h: 30, v: 0 },
    { x: 60, y: 20, w: 16, h: 30, v: 0 },
    { x: 200, y: 20, w: 16, h: 30, v: 215 },
    { x: 220, y: 20, w: 16, h: 30, v: 215 },
    { x: 100, y: 120, w: 16, h: 30, v: 0 },
    // 小さなかけら（文字の高さに足りない）
    { x: 300, y: 130, w: 3, h: 3, v: 0 },
  ]);
  const first: OcrLine[] = [{ words: [word("123", box(20, 20, 76, 50))] }];

  it("読めた単語の外にある、文字の大きさのインクを行ごとにまとめる。小さなかけらは読まない", () => {
    const boxes = unreadBoxes(img, first);
    expect(boxes).toEqual([box(100, 120, 116, 150), box(200, 20, 236, 50)]);
  });

  it("自信のない、数字と英字の混じった読み違いの所は、読めていないとみなして読み直す", () => {
    const garbage: OcrLine[] = [{ words: [word("8n5", box(198, 18, 238, 52), 10)] }];
    expect(unreadBoxes(img, garbage).length).toBe(3);
    // 自信のない数字だけの単語は、読めたものとして残す
    const digits: OcrLine[] = [{ words: [word("85", box(198, 18, 238, 52), 10)] }];
    expect(unreadBoxes(img, [...first, ...digits])).toEqual([box(100, 120, 116, 150)]);
  });

  it("切り出した行は、薄い文字を濃くして縦に並べ、読めた位置を元の画像に戻す", () => {
    const copy: GrayImage = { ...img, data: img.data.slice() };
    const boxes = unreadBoxes(copy, first);
    const [c] = buildCollages(copy, boxes);
    expect(c.strips.length).toBe(2);
    // 薄い数字（濃さ 215）は黒くなり、元の画像にも書き戻す
    expect(copy.data[30 * 400 + 205]).toBeLessThan(20);
    const s = c.strips[1];
    expect(c.data[(s.y + Math.round((30 - s.src.y0) * s.scale)) * c.width + s.x + Math.round((205 - s.src.x0) * s.scale)]).toBeLessThan(20);
    // 並べた画像の中の位置で読めた単語 → 元の画像の位置
    const read = word("45", box(s.x + (200 - s.src.x0) * s.scale, s.y + (20 - s.src.y0) * s.scale, s.x + (236 - s.src.x0) * s.scale, s.y + (50 - s.src.y0) * s.scale));
    const [line] = fromCollage([{ words: [read] }], c);
    expect(line.words[0].bbox.x0).toBeCloseTo(200);
    expect(line.words[0].bbox.y1).toBeCloseTo(50);
    expect(line.words[0].symbols[1].bbox.x1).toBeCloseTo(236);
  });

  it("読み直した単語は、1回目に読めた単語と重なれば足さない。1回目の読み違いは置き換える", () => {
    const again: OcrLine[] = [{ words: [word("123", box(21, 20, 75, 50)), word("45", box(200, 20, 236, 50))] }];
    const merged = mergeFill([...first, { words: [word("8n5", box(198, 18, 238, 52), 10)] }], again);
    expect(merged.flatMap((l) => l.words.map((w) => w.symbols.map((s) => s.text).join("")))).toEqual(["123", "45"]);
  });
});

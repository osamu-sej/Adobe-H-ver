import { describe, expect, it } from "vitest";
import { buildCollages, fromCollage, mergeFill, unreadGroups } from "./ocrFill";
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

  const boxes = (lines: OcrLine[]) => unreadGroups(img, lines).map((g) => g.box);

  it("読めた単語の外にある、文字の大きさのインクを行ごとにまとめる。小さなかけらは読まない", () => {
    expect(boxes(first)).toEqual([box(100, 120, 116, 150), box(200, 20, 236, 50)]);
  });

  it("自信のない、数字と英字の混じった読み違いの所は、読めていないとみなして読み直す", () => {
    const garbage: OcrLine[] = [{ words: [word("8n5", box(198, 18, 238, 52), 10)] }];
    expect(boxes(garbage).length).toBe(3);
    // 自信のない数字だけの単語は、読めたものとして残す
    const digits: OcrLine[] = [{ words: [word("85", box(198, 18, 238, 52), 10)] }];
    expect(boxes([...first, ...digits])).toEqual([box(100, 120, 116, 150)]);
    // ただしインクを調べて、1文字ずつインクが対応しなかった数字の単語は読み直す
    const unmatched: OcrLine[] = [{ words: [{ ...word("85", box(198, 18, 238, 52), 40), inkMatched: false }] }];
    expect(boxes([...first, ...unmatched])).toEqual([box(100, 120, 116, 150), box(200, 20, 236, 50)]);
  });

  it("行に読み残しがあれば、読めた所も含めて行のインク全部を読み直す", () => {
    const row = image(300, 100, [
      { x: 20, y: 20, w: 16, h: 30, v: 0 },
      { x: 40, y: 20, w: 16, h: 30, v: 0 },
      { x: 62, y: 20, w: 16, h: 30, v: 0 },
    ]);
    const part: OcrLine[] = [{ words: [word("12", box(20, 20, 56, 50))] }];
    expect(unreadGroups(row, part).map((g) => g.box)).toEqual([box(20, 20, 78, 50)]);
    // 読み直しで「123」と1つの単語に読めたときは、読めた「12」の外の「3」を足す
    const merged = mergeFill(part, [{ words: [word("123", box(20, 20, 78, 50))] }]);
    expect(merged.flatMap((l) => l.words.map((w) => w.symbols.map((s) => s.text).join("")))).toEqual(["12", "3"]);
    expect(merged[1].words[0].bbox.x0).toBeCloseTo(20 + (58 * 2) / 3);
  });

  it("濃い文字と薄い数字が同じ行にあるときも、それぞれの濃さで読み直す", () => {
    const row = image(180, 80, [
      { x: 20, y: 20, w: 16, h: 30, v: 0 },
      { x: 40, y: 20, w: 16, h: 30, v: 0 },
      { x: 62, y: 20, w: 16, h: 30, v: 215 },
    ]);
    const read: OcrLine[] = [{ words: [word("12", box(20, 20, 56, 50))] }];
    const groups = unreadGroups(row, read);
    expect(groups).toHaveLength(1);
    const original: GrayImage = { ...row, data: row.data.slice() };
    buildCollages(original, groups);
    expect(original.data[30 * 180 + 68]).toBeGreaterThan(200);
    buildCollages(row, groups, true);
    expect(row.data[30 * 180 + 25]).toBe(0);
    expect(row.data[30 * 180 + 68]).toBeLessThan(20);
  });

  it("切り出した行は、薄い文字を濃くして縦に並べ、読めた位置を元の画像に戻す", () => {
    const copy: GrayImage = { ...img, data: img.data.slice() };
    const [c] = buildCollages(copy, unreadGroups(copy, first));
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

  const texts = (lines: OcrLine[]) => lines.flatMap((l) => l.words.map((w) => w.symbols.map((s) => s.text).join("")));

  it("読み直した単語は、1回目に読めた単語と重なれば足さない。1回目の読み違いは置き換える", () => {
    const again: OcrLine[] = [{ words: [word("123", box(21, 20, 75, 50)), word("45", box(200, 20, 236, 50))] }];
    const merged = mergeFill([...first, { words: [word("8n5", box(198, 18, 238, 52), 10)] }], again);
    expect(texts(merged)).toEqual(["123", "45"]);
  });

  it("読み直しで数字が減るときは、1回目の単語を残す（かすれた「0.5」を「5」と読み直したときなど）", () => {
    const old: OcrLine[] = [{ words: [{ ...word("0.5", box(200, 20, 236, 50), 20), inkMatched: false }] }];
    expect(texts(mergeFill(old, [{ words: [word("5", box(222, 20, 236, 50), 90)] }]))).toEqual(["0.5", "5"]);
    expect(texts(mergeFill(old, [{ words: [word("0.6", box(200, 20, 236, 50), 90)] }]))).toEqual(["0.6"]);
  });

  it("数字が減っても、読み直しが1文字ずつインクと対応したなら置き換える（「10/15」を「10/715」と読んでいたとき）", () => {
    const old: OcrLine[] = [{ words: [{ ...word("10/715", box(200, 20, 300, 50), 40), inkMatched: false }] }];
    const again = (inkMatched: boolean): OcrLine[] => [{ words: [{ ...word("10/15", box(200, 20, 300, 50), 95), inkMatched }] }];
    expect(texts(mergeFill(old, again(true)))).toEqual(["10/15"]);
    // どちらが正しいかわからないときは両方残す（どちらも同じインクを隠すので、隠し漏れがないように）
    expect(texts(mergeFill(old, again(false)))).toEqual(["10/715", "10/15"]);
  });

  it("数字の間の細い「-」も、読み直す行の画像に写す", () => {
    const dash = image(200, 80, [
      { x: 20, y: 20, w: 16, h: 30, v: 0 },
      { x: 40, y: 34, w: 16, h: 2, v: 0 },
      { x: 60, y: 20, w: 16, h: 30, v: 0 },
    ]);
    const [c] = buildCollages(dash, unreadGroups(dash, []));
    const s = c.strips[0];
    expect(c.strips.length).toBe(1);
    expect(c.data[(s.y + Math.round((35 - s.src.y0) * s.scale)) * c.width + s.x + Math.round((48 - s.src.x0) * s.scale)]).toBeLessThan(20);
  });

  it("背の高い読めた文字を介して、上下の別の行の読み残しを1行にまとめない", () => {
    const tall = image(200, 120, [
      { x: 20, y: 20, w: 16, h: 70, v: 0 },
      { x: 55, y: 5, w: 16, h: 30, v: 0 },
      { x: 55, y: 75, w: 16, h: 30, v: 0 },
    ]);
    const read: OcrLine[] = [{ words: [word("1", box(20, 20, 36, 90))] }];
    const groups = unreadGroups(tall, read);
    expect(groups.length).toBe(2);
    expect(groups.some((g) => g.box.y0 === 75 && g.box.y1 === 105)).toBe(true);
  });
});

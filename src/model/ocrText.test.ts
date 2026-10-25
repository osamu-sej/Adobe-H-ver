import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as mupdf from "mupdf";
import { createWorker } from "tesseract.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractPageText } from "../engine/textExtract";
import { fixConfusables, ocrToPageText, orientationScore, readsWell, type Matrix6, type OcrLine } from "./ocrText";
import { presetRegex } from "./presets";
import { buildIndex, searchIndex, snapToRange, tokenAt } from "./text";
import type { Rect } from "./types";

const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

/** 1文字ずつ同じ幅で並べた単語（画素単位） */
function word(text: string, x: number, y = 100, w = 20, h = 30, confidence = 95) {
  const symbols = [...text].map((c, i) => ({ text: c, confidence, bbox: box(x + i * w, y, x + (i + 1) * w - 2, y + h) }));
  return { confidence, bbox: box(x, y, x + text.length * w, y + h), symbols };
}

const ID: Matrix6 = [0.5, 0, 0, 0.5, 0, 0];

describe("文字認識の結果を文字層にする", () => {
  it("数字の隣の l・I・| は 1、O は 0 に直す", () => {
    expect(fixConfusables(["l", "0", "月"]).join("")).toBe("10月");
    expect(fixConfusables(["2", "O", "2", "6"]).join("")).toBe("2026");
    expect(fixConfusables(["|", "2", "3"]).join("")).toBe("123");
    expect(fixConfusables([..."1234一5678"]).join("")).toBe("1234-5678");
    expect(fixConfusables([..."\\800"]).join("")).toBe("¥800");
    // 数字の隣でなければそのまま
    expect(fixConfusables(["N", "o", "."]).join("")).toBe("No.");
    expect(fixConfusables(["l", "a", "b"]).join("")).toBe("lab");
  });

  it("離れたセル同士はつながらず、別々に隠せる", () => {
    const lines: OcrLine[] = [{ words: [word("10.7", 0), word("0.0", 200), word("17.0", 400)] }];
    const idx = buildIndex(ocrToPageText(lines, ID));
    const hits = snapToRange(idx, { x: -5, y: 0, w: 400, h: 100 }, "digits");
    expect(hits.map((h) => h.text)).toEqual(["10.7", "0.0", "17.0"]);
    // 1つのセルをクリックすると、そのセルの数字だけ
    const t = tokenAt(idx, 105, 60, "digits");
    expect(t && idx.norm.slice(t[0], t[1]).join("")).toBe("0.0");
  });

  it("単語の中の細い「1」の後ろに空白を入れない", () => {
    // 「1」は字形が細いので、次の文字との隙間が広く見える
    const symbols = [..."03-1234"].map((c, i) => {
      const x = i * 20;
      return { text: c, confidence: 95, bbox: c === "1" ? box(x + 8, 100, x + 11, 130) : box(x, 100, x + 18, 130) };
    });
    const idx = buildIndex(ocrToPageText([{ words: [{ confidence: 95, bbox: box(0, 100, 140, 130), symbols }] }], ID));
    expect(idx.full).toBe("03-1234");
  });

  it("狭い空白は空白として入り、電話番号のプリセットで見つかる", () => {
    const lines: OcrLine[] = [{ words: [word("TEL", 0), word("03-1234-5678", 70)] }];
    const idx = buildIndex(ocrToPageText(lines, ID));
    expect(idx.full).toBe("TEL 03-1234-5678");
    const m = searchIndex(idx, presetRegex("phone")!);
    expect(m.map((x) => x.text)).toEqual(["03-1234-5678"]);
    // 座標は画素 → pt（0.5倍）に変換される
    expect(m[0].rects[0].x).toBeLessThan(35);
    expect(m[0].rects[0].x).toBeGreaterThan(28);
    expect(Math.abs(m[0].rects[0].y - 50)).toBeLessThan(3);
  });

  it("自信のない単語は捨てるが、数字が3つ以上ある単語は隠し漏れを防ぐため残す", () => {
    const low = 12;
    const lines: OcrLine[] = [
      { words: [word("abc", 0, 100, 20, 30, low), word("7", 200, 100, 20, 30, low), word("13,500", 300, 100, 20, 30, low), word("xyz", 600)] },
    ];
    const t = ocrToPageText(lines, ID);
    expect(t.chars.join("").replace(/ /g, "")).toBe("13,500xyz");
  });

  it("読み落とした数字も隠れるよう、数字は前後の文字との隙間まで広がる", () => {
    // 「(10%)」の「1」を読み落として「(0%)」になった場合
    const symbols = [
      { text: "(", confidence: 90, bbox: box(0, 100, 10, 130) },
      { text: "0", confidence: 90, bbox: box(40, 100, 58, 130) },
      { text: "%", confidence: 90, bbox: box(60, 100, 80, 130) },
      { text: ")", confidence: 90, bbox: box(82, 100, 90, 130) },
    ];
    const idx = buildIndex(ocrToPageText([{ words: [{ confidence: 90, bbox: box(0, 100, 90, 130), symbols }] }], [1, 0, 0, 1, 0, 0]));
    const r = snapToRange(idx, { x: 0, y: 90, w: 100, h: 50 }, "digits")[0].rect;
    // 「1」があった場所（x=15〜35）まで隠れる
    expect(r.x).toBeLessThan(15);
  });

  it("向きの判定：読めた文字が十分あるか", () => {
    const good: OcrLine[] = [{ words: [word("売上予測資料", 0), word("2026年10月21日（水）比較", 200)] }];
    expect(readsWell(orientationScore(good))).toBe(true);
    const bad: OcrLine[] = [{ words: [word("1a", 0, 100, 20, 30, 40)] }];
    expect(readsWell(orientationScore(bad))).toBe(false);
  });
});

// ---- 実際に文字認識する（サンプルを画像だけのPDFにしたもので確かめる） ----

const require = createRequire(import.meta.url);
const SAMPLE = new Uint8Array(readFileSync(new URL("../../public/sample.pdf", import.meta.url)));

/** サンプルの1ページ目（rotate を付けると横向きのページ） */
function samplePage(rotate: number) {
  const d = new mupdf.PDFDocument(SAMPLE);
  if (rotate) d.findPage(0).put("Rotate", rotate);
  return d.loadPage(0);
}

/** サンプルの1ページ目を、文字情報のない画像だけのページにする（スキャンの代わり）。rotate で横向きに置く */
function scannedSample(rotate: number): mupdf.PDFDocument {
  const page = new mupdf.PDFDocument(SAMPLE).loadPage(0);
  const [x0, y0, x1, y1] = page.getBounds();
  const pix = page.toPixmap(mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceRGB, false, true);
  const out = new mupdf.PDFDocument();
  const img = out.addImage(new mupdf.Image(pix));
  const w = x1 - x0;
  const h = y1 - y0;
  const res = out.addObject({ XObject: { Im0: img } });
  out.insertPage(-1, out.addPage([0, 0, w, h], rotate as 0 | 90 | 180 | 270, res, `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`));
  return out;
}

let worker: Awaited<ReturnType<typeof createWorker>>;
beforeAll(async () => {
  worker = await createWorker("jpn", 1, {
    langPath: require.resolve("@tesseract.js-data/jpn/package.json").replace("package.json", "4.0.0_best_int"),
    gzip: true,
    cacheMethod: "none",
  });
}, 60_000);
afterAll(async () => {
  await worker?.terminate();
});

/** 本番と同じやり方で、回転して描いた画像を認識し、元ページ空間の文字層にする */
async function ocrPage(doc: mupdf.PDFDocument, rotate: number) {
  const page = doc.loadPage(0);
  const b = page.getBounds();
  const k = 300 / 72;
  const m = mupdf.Matrix.concat(mupdf.Matrix.scale(k, k), mupdf.Matrix.rotate(rotate));
  const pix = page.toPixmap(m, mupdf.ColorSpace.DeviceGray, false, true);
  const toPage = mupdf.Matrix.concat(
    mupdf.Matrix.concat(mupdf.Matrix.translate(pix.getX(), pix.getY()), mupdf.Matrix.invert(m)),
    mupdf.Matrix.translate(-b[0], -b[1]),
  ) as Matrix6;
  const { data } = await worker.recognize(Buffer.from(pix.asPNG()), {}, { blocks: true, text: false });
  const lines: OcrLine[] = [];
  for (const bl of data.blocks ?? []) for (const p of bl.paragraphs) for (const l of p.lines) lines.push({ words: l.words });
  return { text: ocrToPageText(lines, toPage), score: orientationScore(lines) };
}

type Index = ReturnType<typeof buildIndex>;

/** 元の文字層での電話番号・金額の位置 */
const targets = (idx: Index) =>
  ["phone", "money"].flatMap((p) => searchIndex(idx, presetRegex(p)!)).map((m) => ({ text: m.text, rect: m.rects[0] }));

function overlap(a: Rect, b: Rect) {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
}

/**
 * 元の数字の場所を、文字認識の文字層で「なぞって隠した」ときに覆えるか。
 * 読み違い（0→9 など）は起こり得るので、文字列の一致ではなく、隠せる範囲で確かめる
 */
function expectCovered(ocr: Index, original: Index) {
  const list = targets(original);
  expect(list.length).toBeGreaterThan(10);
  for (const t of list) {
    const r = t.rect;
    const hits = snapToRange(ocr, { x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 }, "digits");
    const covered = hits.reduce((n, h) => n + overlap(h.rect, r), 0) / (r.w * r.h);
    expect(covered, `${t.text} @ ${r.x.toFixed(0)},${r.y.toFixed(0)}`).toBeGreaterThan(0.85);
  }
  // 文字そのものもおおむね正しく読めている
  const exact = list.filter((t) => searchIndex(ocr, new RegExp(t.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).length > 0);
  expect(exact.length / list.length).toBeGreaterThan(0.7);
}

describe("スキャンしたページの文字認識", () => {
  it("文字のない画像だけのページになっている", () => {
    const t = extractPageText(scannedSample(0).loadPage(0));
    expect(t.chars.filter((c) => c.trim()).length).toBe(0);
    expect(t.images).toBe(1);
  });

  it("電話番号・金額を、元の文字と同じ位置で隠せる", async () => {
    const { text, score } = await ocrPage(scannedSample(0), 0);
    expect(readsWell(score)).toBe(true);
    expectCovered(buildIndex(text), buildIndex(extractPageText(samplePage(0))));
  }, 60_000);

  it("横向きに置かれたページも、向きを変えて読めば同じ位置で隠せる", async () => {
    const doc = scannedSample(90);
    // そのままの向きでは読めない → 90度・270度で読み比べ、よく読めたほうを使う（アプリと同じ判断）
    const asIs = await ocrPage(doc, 0);
    expect(readsWell(asIs.score)).toBe(false);
    const a = await ocrPage(doc, 90);
    const b = await ocrPage(doc, 270);
    const best = a.score.good >= b.score.good ? a : b;
    expect(readsWell(best.score)).toBe(true);
    expectCovered(buildIndex(best.text), buildIndex(extractPageText(samplePage(90))));
  }, 120_000);
});

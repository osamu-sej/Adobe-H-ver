import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as mupdf from "mupdf";
import { createWorker } from "tesseract.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareOcrImage } from "../engine/ocrPrep";
import { extractPageText } from "../engine/textExtract";
import {
  fixConfusables,
  OCR_PARAMS,
  ocrToPageText,
  orientationScore,
  readsWell,
  snapToInk,
  type GrayImage,
  type Matrix6,
  type OcrLine,
  type OcrWord,
} from "./ocrText";
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
      {
        words: [
          word("abc", 0, 100, 20, 30, low),
          word("7", 200, 100, 20, 30, low),
          word("13,500", 300, 100, 20, 30, low),
          word("xyz", 600),
        ],
      },
    ];
    const t = ocrToPageText(lines, ID);
    expect(t.chars.join("").replace(/ /g, "")).toBe("13,500xyz");
  });

  it("数字が分かれて読まれたときの1文字だけの単語（「1」と「234,567」）は、単語の自信が低くても残す", () => {
    const one = { confidence: 0, bbox: box(0, 100, 18, 130), symbols: [{ text: "1", confidence: 85, bbox: box(4, 100, 12, 130) }] };
    const lines: OcrLine[] = [{ words: [one, word("234,567", 30)] }];
    expect(ocrToPageText(lines, ID).chars.join("")).toBe("1234,567");
    // 離れた所にある自信のない1文字は、読み違いとして捨てる
    const far = { ...one, bbox: box(-200, 100, -182, 130), symbols: [{ ...one.symbols[0], bbox: box(-196, 100, -188, 130) }] };
    expect(ocrToPageText([{ words: [far, word("234,567", 30)] }], ID).chars.join("")).toBe("234,567");
  });

  it("日本語の文字と数字の間の狭い隙間には空白を入れない（日付などが検索で見つかる）", () => {
    // 隙間は文字の高さ（30）の 1/3。広い隙間（2/3）には空白を入れる
    const lines: OcrLine[] = [{ words: [word("2024年4月", 0), word("1日", 150), word("〒", 210), word("102-8455", 240)] }];
    expect(buildIndex(ocrToPageText(lines, ID)).full).toBe("2024年4月1日 〒102-8455");
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

// ---- 文字の位置をインクに合わせる ----

/** 白地に、文字のインクの代わりに太さ3の四角い枠を描いた画像。rules は表の縦の罫線（文字より上下に長い） */
function inkImage(blobs: [number, number][], opts: { rules?: number[]; invert?: boolean } = {}): GrayImage {
  const W = 400;
  const H = 240;
  const bg = opts.invert ? 30 : 255;
  const fg = opts.invert ? 230 : 0;
  const data = new Uint8Array(W * H).fill(bg);
  const fill = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * W + x] = fg;
  };
  for (const [a, b] of blobs) {
    fill(a, b, 100, 103);
    fill(a, b, 137, 140);
    fill(a, Math.min(b, a + 3), 100, 140);
    fill(Math.max(a, b - 3), b, 100, 140);
  }
  for (const r of opts.rules ?? []) fill(r, r + 2, 40, 200);
  return { data, width: W, height: H };
}

/** 認識した単語（文字ごとの左右を指定。高さは 100〜140、tall なら上下に余白を含んだ 80〜160） */
function ocrWord(symbols: [string, number, number][], confidence = 95, bbox?: [number, number], tall = false) {
  const x0 = bbox ? bbox[0] : Math.min(...symbols.map((s) => s[1]));
  const x1 = bbox ? bbox[1] : Math.max(...symbols.map((s) => s[2]));
  const [y0, y1] = tall ? [80, 160] : [100, 140];
  return {
    confidence,
    bbox: box(x0, y0, x1, y1),
    symbols: symbols.map(([text, a, b]) => ({ text, confidence, bbox: box(a, y0, b, y1) })),
  };
}

const xs = (w: OcrWord) => w.symbols.map((s) => `${s.text}:${s.bbox.x0}-${s.bbox.x1}`).join(" ");

describe("文字の位置をインクに合わせる", () => {
  // 「10.7」のインク
  const digits: [number, number][] = [
    [100, 108],
    [115, 135],
    [140, 146],
    [152, 172],
  ];

  it("認識の位置が半文字ずれていても、インクに合わせて直す", () => {
    const w = ocrWord([
      ["1", 110, 120],
      ["0", 125, 145],
      [".", 150, 156],
      ["7", 162, 182],
    ]);
    const [l] = snapToInk([{ words: [w] }], inkImage(digits));
    expect(xs(l.words[0])).toBe("1:100-108 0:115-135 .:140-146 7:152-172");
  });

  it("濃い地に白い文字でも合わせる", () => {
    const w = ocrWord([
      ["1", 92, 102],
      ["0", 107, 127],
      [".", 132, 138],
      ["7", 144, 164],
    ]);
    const [l] = snapToInk([{ words: [w] }], inkImage(digits, { invert: true }));
    expect(xs(l.words[0])).toBe("1:100-108 0:115-135 .:140-146 7:152-172");
  });

  it("単語の枠ごと1文字ずれていても、隣の単語とまとめてずらして合わせる", () => {
    // 「26年10月2」のインク。漢字は数字より幅が広い
    const img = inkImage([
      [100, 124],
      [130, 154],
      [160, 200],
      [208, 220],
      [228, 252],
      [258, 292],
      [300, 324],
    ]);
    // 「年」から先の単語の枠が、まるごと右に1文字ずれている
    const words = [
      ocrWord([
        ["2", 100, 124],
        ["6", 130, 154],
      ]),
      ocrWord([["年", 185, 225]]),
      ocrWord([
        ["1", 225, 245],
        ["0", 250, 290],
      ]),
      ocrWord([["月", 300, 320]]),
      ocrWord([["2", 320, 340]]),
    ];
    const [l] = snapToInk([{ words }], img);
    expect(l.words.map(xs)).toEqual(["2:100-124 6:130-154", "年:160-200", "1:208-220 0:228-252", "月:258-292", "2:300-324"]);
  });

  it("表の罫線を読み違えた「|」は、隣の数字のインクを取らない", () => {
    // 罫線（x=90）のすぐ右に「10.7」。「|」は罫線の位置にあり、数字はずれて認識されている
    const w = ocrWord([
      ["|", 88, 96],
      ["1", 104, 114],
      ["0", 122, 142],
      [".", 146, 152],
      ["7", 158, 178],
    ]);
    const [l] = snapToInk([{ words: [w] }], inkImage(digits, { rules: [90] }));
    expect(xs(l.words[0])).toBe("|:88-96 1:100-108 0:115-135 .:140-146 7:152-172");
  });

  it("認識されなかった「円」のインクは、数字に含めない", () => {
    // 「100円」の「円」を読めず、単語の枠は「円」まで広がっている
    const img = inkImage([
      [100, 108],
      [115, 135],
      [140, 160],
      [165, 205],
    ]);
    const w = ocrWord(
      [
        ["1", 100, 110],
        ["0", 118, 138],
        ["0", 142, 165],
      ],
      95,
      [100, 205],
    );
    const [l] = snapToInk([{ words: [w] }], img);
    expect(xs(l.words[0])).toBe("1:100-108 0:115-135 0:140-160");
  });

  it("幅のない数字の記号も、インクに合わせる", () => {
    // 「19.6」の「6」が幅0、ほかは右にずれている
    const img = inkImage([
      [100, 108],
      [115, 135],
      [140, 146],
      [152, 172],
    ]);
    const w = ocrWord([
      ["1", 112, 124],
      ["9", 130, 150],
      [".", 156, 160],
      ["6", 172, 172],
    ]);
    const [l] = snapToInk([{ words: [w] }], img);
    expect(xs(l.words[0])).toBe("1:100-108 9:115-135 .:140-146 6:152-172");
  });

  it("自信のない、数字のない単語（絵を読み違えたもの）は、隣の数字のインクを取らない", () => {
    const garbage = ocrWord([["の", 60, 104]], 10);
    const w = ocrWord([
      ["1", 110, 120],
      ["0", 125, 145],
      [".", 150, 156],
      ["7", 162, 182],
    ]);
    const [l] = snapToInk([{ words: [garbage, w] }], inkImage(digits));
    expect(xs(l.words[1])).toBe("1:100-108 0:115-135 .:140-146 7:152-172");
    expect(l.words[0]).toBe(garbage);
  });

  it("数字の認識の枠が広すぎても（「2005年」の「5」の枠が行の終わりまで）、その数字のインクに合わせる", () => {
    // 「2005年1月1日」のインク
    const img = inkImage([
      [100, 116],
      [120, 136],
      [140, 156],
      [160, 176],
      [182, 222],
      [230, 236],
      [246, 280],
      [290, 296],
      [304, 336],
    ]);
    const words = [
      ocrWord(
        [
          ["2", 100, 116],
          ["0", 120, 136],
          ["0", 140, 156],
          ["5", 160, 336],
        ],
        95,
        [100, 336],
      ),
      ocrWord([["年", 190, 222]], 95, undefined, true),
      ocrWord([["1", 222, 244]], 95, undefined, true),
      ocrWord([["月", 244, 284]], 95, undefined, true),
      ocrWord([["1", 284, 302]], 95, undefined, true),
      ocrWord([["日", 302, 336]], 95, undefined, true),
    ];
    const [l] = snapToInk([{ words }], img);
    expect(l.words.map(xs)).toEqual([
      "2:100-116 0:120-136 0:140-156 5:160-176",
      "年:182-222",
      "1:230-236",
      "月:246-280",
      "1:290-296",
      "日:304-336",
    ]);
  });

  it("読み落とした数字のインクは、隣の漢字ではなく数字に含める", () => {
    // 「年10月」を「年1月」と読み、「年」の枠が「1」まで広がっている。1文字だけの単語の枠は上下にも高い
    const img = inkImage([
      [100, 140],
      [146, 150],
      [156, 172],
      [178, 210],
    ]);
    const words = [
      ocrWord([["年", 100, 150]], 95, undefined, true),
      ocrWord([["1", 150, 172]], 95, undefined, true),
      ocrWord([["月", 172, 210]], 95, undefined, true),
    ];
    const [l] = snapToInk([{ words }], img);
    expect(l.words.map(xs)).toEqual(["年:100-140", "1:146-172", "月:178-210"]);
  });

  it("自信が低くても、1文字ずつインクが合った数字は残す", () => {
    const low: OcrLine[] = [
      {
        words: [
          ocrWord(
            [
              ["1", 100, 108],
              [".", 140, 146],
              ["3", 152, 172],
            ],
            0,
          ),
        ],
      },
    ];
    const img = inkImage([
      [100, 108],
      [140, 146],
      [152, 172],
    ]);
    expect(ocrToPageText(low, ID, img).chars.join("")).toBe("1.3");
    // 画像がなければ（インクで確かめられなければ）捨てる
    expect(ocrToPageText(low, ID).chars.join("")).toBe("");
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
  await worker.setParameters(OCR_PARAMS);
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
  const pix = page.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false, true);
  const toPage = mupdf.Matrix.concat(
    mupdf.Matrix.concat(mupdf.Matrix.translate(pix.getX(), pix.getY()), mupdf.Matrix.invert(m)),
    mupdf.Matrix.translate(-b[0], -b[1]),
  ) as Matrix6;
  const w = pix.getWidth();
  const h = pix.getHeight();
  const gray = prepareOcrImage(pix.getPixels(), w, h, pix.getStride(), 300);
  const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false);
  const dst = out.getPixels();
  for (let y = 0; y < h; y++) dst.set(gray.subarray(y * w, y * w + w), y * out.getStride());
  const { data } = await worker.recognize(Buffer.from(out.asPNG()), {}, { blocks: true, text: false });
  const lines: OcrLine[] = [];
  for (const bl of data.blocks ?? []) for (const p of bl.paragraphs) for (const l of p.lines) lines.push({ words: l.words });
  return { text: ocrToPageText(lines, toPage, { data: gray, width: w, height: h }), score: orientationScore(lines) };
}

type Index = ReturnType<typeof buildIndex>;

/** 元の文字層での電話番号・金額の位置 */
const targets = (idx: Index) =>
  ["phone", "money"].flatMap((p) => searchIndex(idx, presetRegex(p)!)).map((m) => ({ text: m.text, rect: m.rects[0] }));

function overlap(a: Rect, b: Rect) {
  return (
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  );
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
    const t = extractPageText(scannedSample(0).loadPage(0), mupdf);
    expect(t.chars.filter((c) => c.trim()).length).toBe(0);
    expect(t.images).toBe(1);
  });

  it("電話番号・金額を、元の文字と同じ位置で隠せる", async () => {
    const { text, score } = await ocrPage(scannedSample(0), 0);
    expect(readsWell(score)).toBe(true);
    expectCovered(buildIndex(text), buildIndex(extractPageText(samplePage(0), mupdf)));
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
    expectCovered(buildIndex(best.text), buildIndex(extractPageText(samplePage(90), mupdf)));
  }, 120_000);
});

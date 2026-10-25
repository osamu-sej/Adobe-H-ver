import { afterEach, describe, expect, it, vi } from "vitest";
import {
  annotate,
  CloudOcrError,
  cloudRemaining,
  MONTHLY_CAP,
  readingTurn,
  uprightReading,
  visionToLines,
  type VisionAnnotation,
} from "./cloudOcr";
import { ocrToPageText, type Matrix6 } from "./ocrText";

/** 頂点を読む順（左上から時計回り）に並べた枠 */
const quad = (x0: number, y0: number, x1: number, y1: number) => ({
  vertices: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
});

/** 1文字ずつ同じ幅で並べた単語。last は行の終わりの区切り */
function word(text: string, x: number, y = 100, w = 20, h = 30, last?: string) {
  const chars = [...text];
  return {
    confidence: 0.98,
    boundingBox: quad(x, y, x + chars.length * w, y + h),
    symbols: chars.map((c, i) => ({
      text: c,
      confidence: 0.97,
      boundingBox: quad(x + i * w, y, x + (i + 1) * w - 2, y + h),
      property: i === chars.length - 1 && last ? { detectedBreak: { type: last } } : undefined,
    })),
  };
}

describe("Google Cloud Vision の結果を文字層にする", () => {
  it("行の終わりの区切りで行に分け、確からしさを0〜100にする", () => {
    const a: VisionAnnotation = {
      pages: [
        {
          blocks: [
            { paragraphs: [{ words: [word("TEL", 0), word("03-1234-5678", 70, 100, 20, 30, "EOL_SURE_SPACE"), word("FAX", 0, 150)] }] },
          ],
        },
      ],
    };
    const lines = visionToLines(a);
    expect(lines.map((l) => l.words.map((w) => w.symbols.map((s) => s.text).join("")).join(" "))).toEqual(["TEL 03-1234-5678", "FAX"]);
    expect(lines[0].words[0].confidence).toBeCloseTo(98);
    expect(lines[0].words[1].symbols[0].bbox).toEqual({ x0: 70, y0: 100, x1: 88, y1: 130 });
    const text = ocrToPageText(lines, [0.5, 0, 0, 0.5, 0, 0]);
    expect(text.chars.join("")).toContain("03-1234-5678");
  });

  it("読む向き：右向き・下向き・逆さま・上向き", () => {
    const one = (vertices: { x: number; y: number }[]): VisionAnnotation => ({
      pages: [{ blocks: [{ paragraphs: [{ words: [{ boundingBox: { vertices }, symbols: [{ text: "1" }] }] }] }] }],
    });
    expect(
      readingTurn(
        one([
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ]),
      ),
    ).toBe(0);
    expect(
      readingTurn(
        one([
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ]),
      ),
    ).toBe(90);
    expect(
      readingTurn(
        one([
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ]),
      ),
    ).toBe(180);
    expect(
      readingTurn(
        one([
          { x: 0, y: 10 },
          { x: 0, y: 0 },
        ]),
      ),
    ).toBe(270);
  });

  it("横向きの資料は、読む向きが右になるよう回しても、元のページの同じ場所を指す", () => {
    // 幅 200・高さ 100 の画像。下向きに読む単語（縦に長い枠）
    const w = 200;
    const h = 100;
    const data = new Uint8Array(w * h).fill(255);
    data[30 * w + 150] = 7; // 目印の画素
    const toPage: Matrix6 = [0.5, 0, 0, 0.5, 10, 20];
    const lines = [{ words: [{ confidence: 90, bbox: { x0: 140, y0: 20, x1: 160, y1: 80 }, symbols: [] }] }];
    const up = uprightReading(lines, toPage, { data, width: w, height: h }, 90);
    expect(up.img.width).toBe(h);
    expect(up.img.height).toBe(w);
    // 枠は横長になる
    const b = up.lines[0].words[0].bbox;
    expect(b.x1 - b.x0).toBe(60);
    expect(b.y1 - b.y0).toBe(20);
    // 回した枠の角を元のページに戻すと、元の枠の角と同じ場所
    const at = (m: Matrix6, x: number, y: number) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
    const corners = [at(up.toPage, b.x0, b.y0), at(up.toPage, b.x1, b.y1)];
    const xs = corners.map((c) => c[0]).sort((p, q) => p - q);
    const ys = corners.map((c) => c[1]).sort((p, q) => p - q);
    expect(xs).toEqual([at(toPage, 140, 0)[0], at(toPage, 160, 0)[0]]);
    expect(ys).toEqual([at(toPage, 0, 20)[1], at(toPage, 0, 80)[1]]);
    // 画素も同じ場所に回る
    const [u, v] = [30, w - 150 - 1];
    expect(up.img.data[v * up.img.width + u]).toBe(7);
  });
});

describe("Google Cloud Vision に送る", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("キーがなければ送らない", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(annotate(new Uint8Array([1, 2, 3]), "")).rejects.toMatchObject({ kind: "key" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("文字認識（DOCUMENT_TEXT_DETECTION）を頼み、今月の枚数に数える", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ responses: [{ fullTextAnnotation: { pages: [] } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const before = cloudRemaining();
    const a = await annotate(new Uint8Array([0xff, 0xd8, 0xff]), "test-key");
    expect(a).toEqual({ pages: [] });
    expect(cloudRemaining()).toBe(before - 1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://vision.googleapis.com/v1/images:annotate?key=test-key");
    const body = JSON.parse(String(init.body));
    expect(body.requests[0].features).toEqual([{ type: "DOCUMENT_TEXT_DETECTION" }]);
    expect(body.requests[0].image.content).toBe("/9j/");
    expect(init.credentials).toBe("omit");
  });

  it("キーが使えない・上限に達したときは、種類を分けて知らせる", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "API key not valid." } }), { status: 400 }));
    await expect(annotate(new Uint8Array([1]), "bad")).rejects.toMatchObject({ kind: "key" });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 429 }));
    await expect(annotate(new Uint8Array([1]), "k")).rejects.toMatchObject({ kind: "quota" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(annotate(new Uint8Array([1]), "k")).rejects.toBeInstanceOf(CloudOcrError);
  });

  it("今月の上限（無料枠より少ない枚数）に達したら、それ以上は送らない", async () => {
    expect(MONTHLY_CAP).toBeLessThan(1000);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ responses: [{}] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    while (cloudRemaining() > 0) await annotate(new Uint8Array([1]), "k");
    const sent = fetch.mock.calls.length;
    await expect(annotate(new Uint8Array([1]), "k")).rejects.toMatchObject({ kind: "quota" });
    expect(fetch.mock.calls.length).toBe(sent);
  });
});

import { describe, expect, it } from "vitest";
import { blankRects, prepareOcrImage } from "./ocrPrep";

/** 白地の RGB 画像。fill で四角を塗る */
function canvas(w: number, h: number) {
  const data = new Uint8Array(w * h * 3).fill(255);
  const fill = (x0: number, y0: number, x1: number, y1: number, [r, g, b]: [number, number, number]) => {
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 3;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
      }
  };
  return { data, fill };
}

describe("文字認識の前に画像を整える", () => {
  const W = 400;
  const H = 300;
  const { data, fill } = canvas(W, H);
  // オレンジのセルの中の黒い文字
  fill(20, 20, 120, 80, [240, 150, 60]);
  fill(50, 35, 56, 65, [30, 30, 30]);
  // 薄い灰色の点線の縦罫線（太さ6、上下に長い）
  for (let y = 0; y < H; y += 10) fill(200, y, 206, y + 7, [205, 205, 205]);
  // 罫線と同じ長さにならない、文字の縦画（「1」など）
  fill(260, 100, 265, 140, [20, 20, 20]);
  // 濃い紺の見出しの帯と白い文字
  fill(20, 200, 180, 260, [30, 40, 90]);
  fill(60, 215, 66, 245, [255, 255, 255]);
  // 紙の地の薄い灰色
  fill(300, 20, 380, 60, [228, 228, 228]);
  // 赤い文字（マイナスの数字など）と青い文字
  fill(300, 100, 306, 130, [220, 30, 30]);
  fill(320, 100, 326, 130, [30, 40, 200]);
  // 赤く塗りつぶしたセルの白抜きの文字
  fill(290, 150, 390, 190, [200, 35, 40]);
  fill(330, 160, 336, 182, [255, 245, 200]);
  // ピンクのマーカーの線
  fill(130, 140, 190, 150, [235, 110, 160]);
  const g = prepareOcrImage(data, W, H, W * 3, 300);
  const at = (x: number, y: number) => g[y * W + x];

  it("同じ描画から作った元画像と前処理画像は、それぞれ従来の画像と一致する", () => {
    const original = new Uint8Array(W * H);
    const prepared = prepareOcrImage(data, W, H, W * 3, 300, original);
    expect(prepared).toEqual(g);
    const expected = new Uint8Array(W * H);
    for (let i = 0; i < original.length; i++) {
      const o = i * 3;
      expected[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
    }
    expect(original).toEqual(expected);
  });

  it("色の付いたセルは白くなり、黒い文字は残る", () => {
    expect(at(30, 25)).toBe(255);
    expect(at(52, 50)).toBeLessThan(80);
  });

  it("表の罫線（点線も）は消え、文字の縦画は残る", () => {
    for (const y of [5, 100, 150, 280]) for (const x of [200, 203, 205]) expect(at(x, y)).toBe(255);
    expect(at(262, 120)).toBeLessThan(80);
  });

  it("濃い見出しの帯は消さず、白い文字との差が残る", () => {
    expect(at(100, 230)).toBeLessThan(160);
    expect(at(63, 230)).toBe(255);
  });

  it("赤や青の文字は消さずに暗いまま残す", () => {
    expect(at(303, 115)).toBeLessThan(110);
    expect(at(323, 115)).toBeLessThan(110);
  });

  it("赤く塗りつぶしたセルの白抜きの文字は、白地に黒い文字にする", () => {
    expect(at(300, 155)).toBe(255);
    expect(at(333, 170)).toBeLessThan(60);
  });

  it("薄い色のマーカーの線は白くなる", () => {
    expect(at(160, 145)).toBe(255);
  });

  it("紙の地の薄い灰色は白にする", () => {
    expect(at(340, 40)).toBe(255);
  });
});

describe("色の付いた文字・網掛け・詰まった表", () => {
  /** 「1」のような縦画と、上下の横画でできた数字ほどの字（線の太さ5） */
  const glyph = (fill: ReturnType<typeof canvas>["fill"], x: number, y: number, color: [number, number, number]) => {
    fill(x, y, x + 5, y + 36, color);
    fill(x, y, x + 20, y + 5, color);
    fill(x, y + 31, x + 20, y + 36, color);
  };

  it("明るめのオレンジの文字は、白地でも黄色の地でも黒くする。黄色の地は白くなる", () => {
    const W = 300;
    const { data, fill } = canvas(W, 120);
    glyph(fill, 20, 40, [200, 120, 90]);
    fill(150, 20, 290, 100, [240, 220, 120]);
    glyph(fill, 200, 40, [205, 125, 70]);
    const g = prepareOcrImage(data, W, 120, W * 3, 300);
    expect(g[60 * W + 22]).toBeLessThan(100);
    expect(g[60 * W + 202]).toBeLessThan(100);
    expect(g[30 * W + 170]).toBe(255);
  });

  it("黄色のセルの上の文字は、地と混じった明るい縁まで濃くし、黄色の地は白くする", () => {
    const W = 300;
    const { data, fill } = canvas(W, 140);
    fill(40, 20, 260, 120, [250, 235, 120]);
    glyph(fill, 100, 50, [60, 55, 30]);
    // 文字の縦画の、地と混じった明るい黄土色の部分
    fill(100, 60, 105, 75, [190, 180, 110]);
    const g = prepareOcrImage(data, W, 140, W * 3, 300);
    expect(g[67 * W + 102]).toBeLessThan(170);
    expect(g[30 * W + 200]).toBe(255);
  });

  it("黄色のセルの隣の濃い色のセルの白抜きの文字は、黄色の地の扱いで消さない", () => {
    const W = 300;
    const { data, fill } = canvas(W, 260);
    fill(20, 20, 150, 240, [250, 235, 120]);
    fill(150, 20, 280, 240, [20, 30, 100]);
    glyph(fill, 154, 40, [255, 255, 255]);
    const g = prepareOcrImage(data, W, 260, W * 3, 300);
    // 白抜きの文字の縦画は黒く、太さも残る。セルの地は白
    for (const x of [154, 156, 158]) expect(g[60 * W + x]).toBeLessThan(80);
    expect(g[60 * W + 200]).toBe(255);
  });

  it("オレンジのセルの地と、黒い文字との境目のにじみは黒くしない", () => {
    const W = 300;
    const { data, fill } = canvas(W, 160);
    fill(40, 30, 240, 130, [215, 150, 100]);
    glyph(fill, 100, 60, [30, 30, 30]);
    // 文字の下のにじみ（オレンジより少し暗い茶色）
    fill(100, 96, 120, 99, [190, 125, 80]);
    const g = prepareOcrImage(data, W, 160, W * 3, 300);
    expect(g[50 * W + 60]).toBe(255);
    expect(g[97 * W + 110]).toBeGreaterThan(200);
    expect(g[70 * W + 102]).toBeLessThan(80);
  });

  it("灰色の網掛けのセルは白くし、網掛けの中の罫線も消す。黒い文字は残る", () => {
    const W = 400;
    const H = 300;
    const { data, fill } = canvas(W, H);
    fill(20, 20, 380, 280, [190, 190, 190]);
    // 網掛けの中の縦の罫線（地より少し暗い）
    fill(200, 20, 203, 280, [150, 150, 150]);
    glyph(fill, 100, 120, [40, 40, 40]);
    const g = prepareOcrImage(data, W, H, W * 3, 300);
    expect(g[60 * W + 60]).toBe(255);
    for (const y of [40, 150, 260]) expect(g[y * W + 201]).toBe(255);
    expect(g[140 * W + 102]).toBeLessThan(80);
  });

  it("行の詰まった表で、数字の下端に接している横の罫線も、数字の下まで消す", () => {
    const W = 400;
    const { data, fill } = canvas(W, 200);
    fill(0, 100, W, 103, [60, 60, 60]);
    // 罫線の上に接した数字（下の方が太く、罫線の太さの倍より上まで黒い）
    glyph(fill, 150, 64, [30, 30, 30]);
    fill(150, 88, 170, 100, [30, 30, 30]);
    const g = prepareOcrImage(data, W, 200, W * 3, 300);
    // 数字の下（罫線のあった所）は白く、数字の縦画は残る
    expect(g[101 * W + 165]).toBe(255);
    expect(g[101 * W + 50]).toBe(255);
    expect(g[80 * W + 152]).toBeLessThan(80);
  });
});

describe("PDFの文字がある所を白く消す", () => {
  it("ページの座標の矩形を画素に直して、少し広めに白く塗る", () => {
    const { data, fill } = canvas(100, 100);
    fill(0, 0, 100, 100, [10, 10, 10]);
    // 画素 = ページ（pt）× 2
    blankRects(data, 100, 100, 300, [10, 10, 20, 15], [2, 0, 0, 2, 0, 0]);
    const px = (x: number, y: number) => data[(y * 100 + x) * 3];
    expect(px(25, 25)).toBe(255);
    expect(px(19, 19)).toBe(255);
    expect(px(40, 30)).toBe(255);
    expect(px(17, 25)).toBe(10);
    expect(px(25, 32)).toBe(10);
    expect(px(50, 50)).toBe(10);
  });
});

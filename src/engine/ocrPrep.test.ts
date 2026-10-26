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

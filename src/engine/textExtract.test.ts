import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { ocrPlan } from "../model/pageText";
import { CharFlag } from "./protocol";
import { extractPageText } from "./textExtract";

const W = 595;
const H = 842;

/** テスト用の1ページのPDF。F1 はふつうのフォント、F2 は文字の対応がない（化ける）フォント、Im0 は画像 */
function page(contents: string, image?: { w: number; h: number; alpha?: boolean }) {
  const doc = new mupdf.PDFDocument();
  const name = (s: string) => doc.newName(s);
  const res: Record<string, unknown> = {
    ExtGState: { T0: { ca: 0, CA: 0 } },
    Font: {
      F1: doc.addSimpleFont(new mupdf.Font("Helvetica")),
      F2: doc.addObject({
        Type: name("Font"),
        Subtype: name("Type1"),
        BaseFont: name("Helvetica"),
        Encoding: { Type: name("Encoding"), Differences: [65, name("g1"), name("g2"), name("g3")] },
      }),
    },
  };
  if (image) {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
    pix.clear(255);
    let img = new mupdf.Image(pix);
    if (image.alpha) {
      const mask = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 16, 16], false);
      mask.clear(128);
      img = new mupdf.Image(pix, new mupdf.Image(mask));
    }
    res.XObject = { Im0: doc.addImage(img) };
  }
  doc.insertPage(-1, doc.addPage([0, 0, W, H], 0, doc.addObject(res), contents));
  return doc.loadPage(0);
}

const text = (s: string, x = 72, y = 700, font = "F1", mode = 0) => `BT /${font} 12 Tf ${mode} Tr ${x} ${y} Td (${s}) Tj ET `;
const image = (x: number, y: number, w: number, h: number) => `q ${w} 0 0 ${h} ${x} ${y} cm /Im0 Do Q `;
const visible = (t: ReturnType<typeof extractPageText>) => t.chars.filter((c, i) => c.trim() && !t.flags![i]).join("");

describe("ページの文字を取り出す", () => {
  it("ふつうの文字は見えている文字で、文字認識はしない", () => {
    const t = extractPageText(page(text("Total 1,234")), mupdf);
    expect(visible(t)).toBe("Total1,234");
    expect(ocrPlan(t)).toBeNull();
  });

  it("文字の上下の枠を字形に合わせる（数字の上端・カンマの下端をわずかに超えるだけ）", () => {
    const t = extractPageText(page(text("1,234")), mupdf);
    const i = t.chars.indexOf("2");
    const [y0, y1] = [t.boxes[i * 4 + 1], t.boxes[i * 4 + 3]];
    // Helvetica の数字は、ベースライン（上から 842-700=142pt）から上へ約 8.6pt。カンマは下へ約 1.5pt
    expect(y0).toBeLessThan(142 - 8.6);
    expect(y0).toBeGreaterThan(142 - 8.6 - 1.5);
    expect(y1).toBeGreaterThan(142 + 1.4);
    expect(y1).toBeLessThan(142 + 1.5 + 1.5);
  });

  it("透明の文字（スキャンに重ねた文字層）は見えない文字。ページを覆う画像があれば、ページ全体を読み直す", () => {
    const t = extractPageText(page(image(0, 0, W, H) + text("Total 1,234", 72, 700, "F1", 3), { w: W, h: H }), mupdf);
    expect(t.cover).toBe(true);
    expect(t.flags!.every((f, i) => !t.chars[i].trim() || f & CharFlag.Hidden)).toBe(true);
    expect(ocrPlan(t)).toBe("page");
  });

  it("完全に透明に描いた文字も見えない文字", () => {
    const t = extractPageText(page(image(0, 0, W, H) + "q /T0 gs " + text("Total 1,234") + "Q", { w: W, h: H }), mupdf);
    expect(visible(t)).toBe("");
    expect(ocrPlan(t)).toBe("page");
  });

  it("画像の下に隠れた文字も見えない文字", () => {
    const t = extractPageText(page(text("Total 1,234") + image(0, 0, W, H), { w: W, h: H }), mupdf);
    expect(visible(t)).toBe("");
    expect(ocrPlan(t)).toBe("page");
  });

  it("透ける画像は文字を隠さない", () => {
    const t = extractPageText(page(text("Total 1,234") + image(0, 0, W, H), { w: W, h: H, alpha: true }), mupdf);
    expect(visible(t)).toBe("Total1,234");
  });

  it("貼り付けた大きな画像（表のスクリーンショットなど）があれば、その中を読んで足す。小さなロゴは読まない", () => {
    const big = extractPageText(page(text("Total 1,234") + image(72, 300, 400, 200), { w: 400, h: 200 }), mupdf);
    expect(big.figures).toBe(1);
    expect(ocrPlan(big)).toBe("extra");
    const logo = extractPageText(page(text("Total 1,234") + image(500, 780, 40, 40), { w: 40, h: 40 }), mupdf);
    expect(logo.figures).toBe(0);
    expect(ocrPlan(logo)).toBeNull();
  });

  it("文字を図形にしたもの（曲線でできた文字くらいの大きさの塗りつぶし）があれば読む", () => {
    // 「0」のような輪郭（外側と内側の楕円）を8つ並べる
    const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
      `${cx - rx} ${cy} m ${cx - rx} ${cy + ry} ${cx} ${cy + ry} ${cx} ${cy + ry} c ${cx + rx} ${cy + ry} ${cx + rx} ${cy} ${cx + rx} ${cy} c ` +
      `${cx + rx} ${cy - ry} ${cx} ${cy - ry} ${cx} ${cy - ry} c ${cx - rx} ${cy - ry} ${cx - rx} ${cy} ${cx - rx} ${cy} c h `;
    let glyphs = "";
    for (let k = 0; k < 8; k++) glyphs += ellipse(103 + k * 9, 400, 3, 4.5) + ellipse(103 + k * 9, 400, 1.8, 3.4) + "f* ";
    const t = extractPageText(page(text("Total") + glyphs), mupdf);
    expect(t.glyphPaths).toBe(8);
    expect(ocrPlan(t)).toBe("extra");
    // 四角（棒グラフの棒など）は文字とみなさない
    const bars = extractPageText(page(text("Total") + "100 100 20 80 re f 140 100 20 120 re f 180 100 20 60 re f"), mupdf);
    expect(bars.glyphPaths).toBe(0);
  });

  it("文字化けした文字（何の文字か分からない）は印を付け、そのフォントの文字が多く化けていればページを読む", () => {
    const some = extractPageText(page(text("Total 1,234") + text("ABC", 72, 600, "F2")), mupdf);
    const bad = some.chars.map((c, i) => (some.flags![i] & CharFlag.Garbled ? c : "")).join("");
    expect(bad).toBe("���");
    expect(visible(some)).toBe("Total1,234");
    expect(ocrPlan(some)).toBe("extra");
    // ページの文字がすべて化けている → ページ全体を読む
    expect(ocrPlan(extractPageText(page(text("ABCABC", 72, 600, "F2")), mupdf))).toBe("page");
  });
});

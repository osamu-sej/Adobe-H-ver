import type * as M from "mupdf";
import { CharFlag, type TextResult } from "./protocol";

type Mupdf = typeof import("mupdf");
type Mat = [number, number, number, number, number, number];

/** ページのこれ以上を覆う画像は、下の文字を隠しているとみなす（スキャンの上に文字層を重ねたPDFなど） */
const COVER_AREA = 0.5;
/** 文字認識で読む画像（貼り付けた表・スクリーンショットなど）の大きさ。小さなロゴやアイコンは数えない */
const FIGURE_AREA = 0.015;
const FIGURE_MIN = 12;
/** 文字の形をした図形の大きさ（pt）。文字を図形にした資料（グラフの数値など）を見つける */
const GLYPH_MIN_H = 3;
const GLYPH_MAX_H = 40;
/** これより透明な文字は見えないとみなす */
const MIN_ALPHA = 0.05;
/** フォントの文字のこの割合以上が化けていれば、そのフォントの文字はすべて化けているとみなす */
const GARBLED_FONT = 0.2;

const apply = (m: Mat, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

/** 文字の位置を照合するためのキー（0.5pt 単位） */
const cell = (x: number, y: number) => `${Math.round(x * 2)},${Math.round(y * 2)}`;

interface Drawn {
  /** 見えるように描いた文字の位置（文字の原点） */
  visible: Set<string>;
  /** 文字認識で読む価値のある画像の数 */
  figures: number;
  /** ページのほとんどを覆う画像があるか */
  cover: boolean;
  /** 文字の形をした図形の数 */
  glyphPaths: number;
}

/**
 * ページを描く命令を調べる：見えるように描いた文字、文字を覆う画像、文字の形をした図形。
 * 透明の文字（スキャンに重ねた文字層）や画像の下の文字は、見た目の文字と位置がずれていたり読み違いがあったりするので見分ける
 */
function inspectDrawing(mupdf: Mupdf, page: M.Page): Drawn {
  const b = page.getBounds();
  const pageArea = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  const glyphs: { x: number; y: number; covered: boolean }[] = [];
  let figures = 0;
  let cover = false;
  let glyphPaths = 0;
  const addGlyphs = (text: M.Text, ctm: Mat) => {
    text.walk({
      showGlyph(_font, trm) {
        const [x, y] = apply(ctm, trm[4], trm[5]);
        glyphs.push({ x, y, covered: false });
      },
    });
    text.destroy();
  };
  const dev = new mupdf.Device({
    // 完全に透明に描いた文字も見えない文字（透明の文字層を、描画モードではなく透明度で作るソフトもある）
    fillText(text, ctm, _cs, _color, alpha) {
      if (alpha >= MIN_ALPHA) addGlyphs(text, ctm as Mat);
      else text.destroy();
    },
    strokeText(text, _stroke, ctm, _cs, _color, alpha) {
      if (alpha >= MIN_ALPHA) addGlyphs(text, ctm as Mat);
      else text.destroy();
    },
    fillImage(image, ctm) {
      const m = ctm as Mat;
      const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
      const x0 = Math.min(...pts.map((p) => p[0]));
      const y0 = Math.min(...pts.map((p) => p[1]));
      const x1 = Math.max(...pts.map((p) => p[0]));
      const y1 = Math.max(...pts.map((p) => p[1]));
      const area = (x1 - x0) * (y1 - y0);
      if (area >= pageArea * FIGURE_AREA && x1 - x0 >= FIGURE_MIN && y1 - y0 >= FIGURE_MIN) figures++;
      // 透けない大きな画像は、先に描いた文字を覆う
      const mask = image.getMask();
      mask?.destroy();
      if (!mask && area >= pageArea * COVER_AREA) {
        cover = true;
        for (const g of glyphs) if (g.x >= x0 && g.x <= x1 && g.y >= y0 && g.y <= y1) g.covered = true;
      }
      image.destroy();
    },
    fillPath(path, _evenOdd, ctm) {
      // 曲線を含む、文字くらいの大きさの塗りつぶし（文字を図形にしたもの）
      const r = path.getBounds(null as unknown as M.StrokeState, ctm);
      const w = r[2] - r[0];
      const h = r[3] - r[1];
      if (h >= GLYPH_MIN_H && h <= GLYPH_MAX_H && w <= h * 2.5) {
        let curves = 0;
        let segments = 0;
        path.walk({
          curveTo() {
            curves++;
            segments++;
          },
          lineTo() {
            segments++;
          },
        });
        if (curves >= 2 && segments >= 6) glyphPaths++;
      }
      path.destroy();
    },
  });
  try {
    page.run(dev, [1, 0, 0, 1, 0, 0]);
    dev.close();
  } finally {
    dev.destroy();
  }
  const visible = new Set<string>();
  for (const g of glyphs) if (!g.covered) visible.add(cell(g.x, g.y));
  return { visible, figures, cover, glyphPaths };
}

/** 文字の原点が、見えるように描いた文字のどれかと同じ位置にあるか（丸めの差を見込んで隣も見る） */
function isVisible(visible: Set<string>, x: number, y: number): boolean {
  const cx = Math.round(x * 2);
  const cy = Math.round(y * 2);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (visible.has(`${cx + dx},${cy + dy}`)) return true;
  return false;
}

/** ページの文字と外接矩形を取り出す（座標はページ原点基準のpt） */
export function extractPageText(page: M.Page, mupdf: Mupdf): TextResult {
  const b = page.getBounds();
  const st = page.toStructuredText("preserve-whitespace,preserve-images");
  let images = 0;
  const chars: string[] = [];
  const boxes: number[] = [];
  const lines: number[] = [];
  const sizes: number[] = [];
  const origins: number[] = [];
  const fonts: number[] = [];
  /** 横書きの行か（行ごと） */
  const horizontal: boolean[] = [];
  let line = -1;
  st.walk({
    onImageBlock() {
      images++;
    },
    beginLine(_bbox, _wmode, dir) {
      line++;
      horizontal.push(Math.abs(dir[1]) < 0.01 && dir[0] > 0);
    },
    onChar(c, origin, font, size, q) {
      chars.push(c);
      boxes.push(
        Math.min(q[0], q[2], q[4], q[6]) - b[0],
        Math.min(q[1], q[3], q[5], q[7]) - b[1],
        Math.max(q[0], q[2], q[4], q[6]) - b[0],
        Math.max(q[1], q[3], q[5], q[7]) - b[1],
      );
      lines.push(line);
      sizes.push(size);
      origins.push(origin[0], origin[1]);
      fonts.push(font.pointer);
      font.destroy();
    },
  });
  st.destroy();
  const n = chars.length;
  const flags = new Uint8Array(n);
  const result: TextResult = {
    chars,
    boxes: new Float32Array(boxes),
    lines: new Int32Array(lines),
    sizes: new Float32Array(sizes),
    images,
    flags,
  };
  if (!n && !images) return result;

  const drawn = inspectDrawing(mupdf, page);
  result.figures = drawn.figures;
  result.cover = drawn.cover;
  result.glyphPaths = drawn.glyphPaths;
  if (!n) return result;

  // 文字化け：何の文字か分からない文字（U+FFFD）。化けた文字が多いフォントは、ほかの文字も当てにならない
  const perFont = new Map<number, { all: number; bad: number }>();
  for (let i = 0; i < n; i++) {
    if (!chars[i].trim()) continue;
    const f = perFont.get(fonts[i]) ?? { all: 0, bad: 0 };
    f.all++;
    if (chars[i].includes("�")) f.bad++;
    perFont.set(fonts[i], f);
  }
  for (let i = 0; i < n; i++) {
    if (!chars[i].trim()) continue;
    const f = perFont.get(fonts[i])!;
    if (chars[i].includes("�") || f.bad >= f.all * GARBLED_FONT) flags[i] |= CharFlag.Garbled;
    if (!isVisible(drawn.visible, origins[i * 2], origins[i * 2 + 1])) flags[i] |= CharFlag.Hidden;
  }

  tightenToInk(page, b, result, horizontal);
  return result;
}

/**
 * 文字の上下の範囲を、実際の字形（インク）に合わせる。PDFの文字の枠はフォントの決まった高さで、
 * フォントによっては字形より大きくずれていたり、上下の行にかかったりするため。
 * 行ごとに字形の上端と下端をそろえて使う（行の中で高さがそろい、マスクの見た目がきれいになる）
 */
function tightenToInk(page: M.Page, b: number[], t: TextResult, horizontal: boolean[]) {
  const st = page.toStructuredText("preserve-whitespace,accurate-bboxes");
  const ys: number[] = [];
  let k = 0;
  let same = true;
  st.walk({
    onChar(c, _origin, font, _size, q) {
      font.destroy();
      if (t.chars[k] !== c) same = false;
      ys.push(Math.min(q[1], q[3], q[5], q[7]) - b[1], Math.max(q[1], q[3], q[5], q[7]) - b[1]);
      k++;
    },
  });
  st.destroy();
  // 文字の並びが違えば（念のため）、フォントの枠のまま
  if (!same || k !== t.chars.length) return;
  const ink = new Map<number, { y0: number; y1: number }>();
  for (let i = 0; i < k; i++) {
    const y0 = ys[i * 2];
    const y1 = ys[i * 2 + 1];
    if (!t.chars[i].trim() || !(y1 > y0) || !horizontal[t.lines[i]]) continue;
    const r = ink.get(t.lines[i]);
    if (r) {
      r.y0 = Math.min(r.y0, y0);
      r.y1 = Math.max(r.y1, y1);
    } else ink.set(t.lines[i], { y0, y1 });
  }
  for (let i = 0; i < k; i++) {
    const r = ink.get(t.lines[i]);
    if (!r) continue;
    const h = r.y1 - r.y0;
    // 字形の高さが文字の大きさに比べて小さすぎる行（「ー」や「。」だけの行など）は、フォントの枠のまま
    if (h < t.sizes[i] * 0.3) continue;
    const pad = Math.max(0.4, h * 0.08);
    t.boxes[i * 4 + 1] = r.y0 - pad;
    t.boxes[i * 4 + 3] = r.y1 + pad;
  }
}

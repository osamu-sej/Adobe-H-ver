import { isDigit } from "./normalize";
import type { PageText } from "./types";

/**
 * 文字認識（OCR）の結果を、PDFの文字層と同じ形（PageText）に直す。
 * こうしておけば、数字への吸着・検索・プリセットがスキャンしたページでもそのまま使える。
 */

export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrSymbol {
  text: string;
  confidence: number;
  bbox: OcrBox;
}

export interface OcrWord {
  confidence: number;
  bbox: OcrBox;
  symbols: OcrSymbol[];
}

export interface OcrLine {
  words: OcrWord[];
}

/** 画像の画素 → 元ページ空間（pt）の変換行列 [a, b, c, d, e, f] */
export type Matrix6 = [number, number, number, number, number, number];

/**
 * これより自信のない単語は、写真の模様などの読み違いとして捨てる。
 * ただし数字が3つ以上ある単語は、自信が低くても残す（金額などの隠し漏れのほうが困るため）
 */
const MIN_WORD_CONFIDENCE = 30;
const KEEP_DIGITS = 3;
/** 単語の間の隙間が文字の高さに対してこれより広ければ、別のかたまり（表の別のセルなど）とみなす */
const CHUNK_GAP = 0.8;
/** 単語の中でも、これより広い隙間があれば別のかたまりにする（セル同士が1語に読まれたとき） */
const CHUNK_GAP_IN_WORD = 1.2;
/** 単語の間の隙間がこれより広ければ空白を入れる。単語の中には入れない（「1」は細いので隙間が広く見える） */
const SPACE_GAP = 0.25;
const NUMBER_SPACE_GAP = 0.6;
/** 文字の高さに対する上下の余白 */
const INK_PAD = 0.12;
/** 数字のかたまりの両端に足す余白（端の数字の一部を読み落としても隠れるように） */
const RUN_PAD = 0.3;

/** 数字の隣にあるときは「1」の読み違いとみなす文字 */
const LIKE_ONE = new Set(["l", "I", "|", "!", "]", "[", "i", "j", "¦", "ｌ", "Ｉ", "｜", "丨"]);
/** 数字の隣にあるときは「0」の読み違いとみなす文字 */
const LIKE_ZERO = new Set(["O", "o", "〇", "○", "Ｏ", "ｏ"]);
/** 数字に挟まれているときは「-」の読み違いとみなす文字（漢数字の「一」など） */
const LIKE_DASH = new Set(["一", "ー", "—", "–", "―", "－", "‐", "~", "〜", "_"]);

interface Glyph {
  text: string;
  conf: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const digit = (s: string | undefined) => !!s && s.length === 1 && isDigit(s);

/** 数字に挟まれた・隣り合った読み違いを直す（「l0月」→「10月」など） */
export function fixConfusables(texts: string[]): string[] {
  const out = texts.map((t) => t.normalize("NFKC"));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < out.length; i++) {
      const t = out[i];
      if (LIKE_DASH.has(t) && digit(out[i - 1]) && digit(out[i + 1])) {
        out[i] = "-";
        continue;
      }
      // 円記号はバックスラッシュに読まれやすい
      if (t === "\\" && digit(out[i + 1])) {
        out[i] = "¥";
        continue;
      }
      const near = digit(out[i - 1]) || digit(out[i + 1]);
      if (!near) continue;
      if (LIKE_ONE.has(t) || LIKE_ONE.has(texts[i])) {
        out[i] = "1";
      } else if (LIKE_ZERO.has(t) || LIKE_ZERO.has(texts[i])) {
        out[i] = "0";
      }
    }
  }
  return out;
}

function apply(m: Matrix6, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

/** 画像上の矩形を元ページ空間の矩形にする（90度単位の回転なので軸に沿ったまま） */
function toPageBox(m: Matrix6, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * OCRの結果を PageText にする。
 * - 隙間の広いところで別のかたまりに分け、かたまりごとに別の行番号を付ける（表のセル同士がつながらない）
 * - 文字の縦の範囲は単語の高さにそろえる（隠したときに上下が欠けない）
 */
export function ocrToPageText(lines: OcrLine[], toPage: Matrix6): PageText {
  const chars: string[] = [];
  const boxes: number[] = [];
  const lineNo: number[] = [];
  const sizes: number[] = [];
  const unit = Math.sqrt(Math.abs(toPage[0] * toPage[3] - toPage[1] * toPage[2])) || 1;
  let line = -1;

  const push = (c: string, x0: number, y0: number, x1: number, y1: number, size: number) => {
    // 認識した矩形はインクぎりぎりなので、PDFの文字の枠と同じくらいまで上下に少し広げる
    const pad = (y1 - y0) * INK_PAD;
    const [px0, py0, px1, py1] = toPageBox(toPage, x0, y0 - pad, x1, y1 + pad);
    chars.push(c);
    boxes.push(px0, py0, px1, py1);
    lineNo.push(line);
    // 文字の大きさ（吸着のつなぎ判定に使う）。かたまり同士は行番号で分けてあるので大きめにして、
    // 幅の広い「-」をはさむ数字や、横向きのページで縦に並んだ文字もひとつながりにする
    sizes.push(size * unit * 1.6);
  };

  for (const l of lines) {
    const words: Glyph[][] = [];
    for (const w of l.words) {
      const digits = w.symbols.filter((s) => /\d/.test(s.text.normalize("NFKC"))).length;
      if (w.confidence < MIN_WORD_CONFIDENCE && digits < KEEP_DIGITS) continue;
      const glyphs: Glyph[] = [];
      for (const s of w.symbols) {
        if (!s.text.trim()) continue;
        glyphs.push({ text: s.text, conf: s.confidence, x0: s.bbox.x0, x1: s.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1 });
      }
      if (glyphs.length) words.push(glyphs.sort((a, b) => a.x0 - b.x0));
    }
    words.sort((a, b) => a[0].x0 - b[0].x0);
    // 行の中の文字を並べ、単語の切れ目を覚えておく
    const seq: { g: Glyph; text: string; first: boolean }[] = [];
    for (const glyphs of words) {
      const fixed = fixConfusables(glyphs.map((g) => g.text));
      glyphs.forEach((g, i) => seq.push({ g, text: fixed[i], first: i === 0 }));
    }
    const h = (g: Glyph) => Math.max(1, g.y1 - g.y0);
    const numeric = (t: string | undefined) => digit(t) || (!!t && /^[,.\-:/]$/.test(t));
    seq.forEach(({ g, text, first }, i) => {
      const prev = seq[i - 1];
      const next = seq[i + 1];
      const hh = Math.max(h(g), prev ? h(prev.g) : 0);
      const gap = prev ? g.x0 - prev.g.x1 : Infinity;
      // 数字の中（「1,234」のカンマの後など）は、単語が分かれていても広めの隙間でなければ空白を入れない
      const inNumber = prev && ((numeric(prev.text) && digit(text)) || (digit(prev.text) && numeric(text)));
      if (!prev || gap > hh * (first ? CHUNK_GAP : CHUNK_GAP_IN_WORD)) line++;
      else if (first && gap > hh * (inNumber ? NUMBER_SPACE_GAP : SPACE_GAP))
        push(" ", prev.g.x1, Math.min(prev.g.y0, g.y0), g.x0, Math.max(prev.g.y1, g.y1), hh);
      // 数字は前後の文字との隙間まで広げる。読み落とした数字（「10%」の「1」など）も隠れるように。
      // 単語の切れ目をまたぐのは、隣も数字・区切り記号のときだけ
      let x0 = g.x0;
      let x1 = g.x1;
      if (digit(text)) {
        if (prev && gap <= hh * CHUNK_GAP_IN_WORD && (!first || numeric(prev.text))) x0 = Math.min(x0, prev.g.x1 + 1);
        const gapNext = next ? next.g.x0 - g.x1 : Infinity;
        if (next && gapNext <= hh * CHUNK_GAP_IN_WORD && (!next.first || numeric(next.text))) x1 = Math.max(x1, next.g.x0 - 1);
        if (!prev || !numeric(prev.text) || gap > hh * CHUNK_GAP_IN_WORD) x0 -= h(g) * RUN_PAD;
        if (!next || !numeric(next.text) || gapNext > hh * CHUNK_GAP_IN_WORD) x1 += h(g) * RUN_PAD;
      }
      push(text, x0, g.y0, x1, g.y1, h(g));
    });
  }
  return {
    chars,
    boxes: new Float32Array(boxes),
    lines: new Int32Array(lineNo),
    sizes: new Float32Array(sizes),
  };
}

/** 向きの判定用：自信をもって読めた文字（記号を除く）の数 */
export function orientationScore(lines: OcrLine[]): { good: number; total: number } {
  let good = 0;
  let total = 0;
  for (const l of lines)
    for (const w of l.words)
      for (const s of w.symbols) {
        const t = s.text.normalize("NFKC");
        if (!/[0-9A-Za-z぀-ヿ㐀-鿿]/.test(t)) continue;
        total++;
        if (s.confidence >= 75 && w.confidence >= 60) good++;
      }
  return { good, total };
}

/** この向きで十分に読めているか（読めていなければ、ほかの向きも試す） */
export function readsWell(score: { good: number; total: number }): boolean {
  return score.good >= 20 && score.good >= score.total * 0.3;
}

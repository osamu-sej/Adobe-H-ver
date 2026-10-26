import { CharFlag, type TextResult } from "../engine/protocol";
import type { PageText } from "./types";

/**
 * PDFの文字層と文字認識の結果の組み合わせ方。
 * - page：ページ全体を読んで、文字層を置き換える（スキャン。スキャンに透明の文字層を重ねたPDFも、
 *   重ねた文字は見た目とずれていたり読み違いがあったりするので読み直す）
 * - extra：PDFの文字がない所（貼り付けた画像・文字を図形にしたもの・文字化けした文字）だけを読んで足す
 */
export type OcrMode = "page" | "extra";

/** 文字の形をした図形がこれ以上あれば、文字を図形にした資料（グラフの数値など）とみなして読む */
const MIN_GLYPH_PATHS = 6;
/** 見えない文字がこの割合以上で、ページを覆う画像があれば、スキャンに重ねた文字層とみなす */
const HIDDEN_LAYER = 0.8;
/** 文字認識の文字が、PDFの文字とこの割合以上重なれば、同じ文字を読んだものとして捨てる */
const SAME_PLACE = 0.3;

const flagOf = (t: TextResult, i: number) => t.flags?.[i] ?? 0;

/** このページを文字認識で読むか、読むならどう組み合わせるか */
export function ocrPlan(t: TextResult): OcrMode | null {
  let visible = 0;
  let hidden = 0;
  let garbled = 0;
  for (let i = 0; i < t.chars.length; i++) {
    if (!t.chars[i].trim()) continue;
    const f = flagOf(t, i);
    if (f & CharFlag.Garbled) garbled++;
    else if (f & CharFlag.Hidden) hidden++;
    else visible++;
  }
  const vector = (t.glyphPaths ?? 0) >= MIN_GLYPH_PATHS;
  if (!visible) return (t.images ?? 0) > 0 || vector || garbled > 0 ? "page" : null;
  if (t.cover && hidden >= (visible + hidden) * HIDDEN_LAYER) return "page";
  if ((t.figures ?? 0) > 0 || vector || garbled > 0) return "extra";
  return null;
}

/** 文字化けした文字を除いた文字層（化けた文字は検索にも吸着にも使えない） */
export function withoutGarbled(t: TextResult): PageText {
  if (!t.flags?.some((f) => f & CharFlag.Garbled)) return { chars: t.chars, boxes: t.boxes, lines: t.lines, sizes: t.sizes };
  const keep: number[] = [];
  for (let i = 0; i < t.chars.length; i++) if (!(flagOf(t, i) & CharFlag.Garbled)) keep.push(i);
  return {
    chars: keep.map((i) => t.chars[i]),
    boxes: Float32Array.from(keep.flatMap((i) => [t.boxes[i * 4], t.boxes[i * 4 + 1], t.boxes[i * 4 + 2], t.boxes[i * 4 + 3]])),
    lines: Int32Array.from(keep.map((i) => t.lines[i])),
    sizes: Float32Array.from(keep.map((i) => t.sizes[i])),
  };
}

/** 見えているPDFの文字（文字化けを除く）の枠。文字認識の前に白く消し、認識した文字と重なれば捨てる */
export function visibleTextBoxes(t: TextResult): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.chars.length; i++) {
    if (!t.chars[i].trim() || flagOf(t, i) & (CharFlag.Hidden | CharFlag.Garbled)) continue;
    out.push(t.boxes[i * 4], t.boxes[i * 4 + 1], t.boxes[i * 4 + 2], t.boxes[i * 4 + 3]);
  }
  return out;
}

/**
 * PDFの文字層に、画像・図の中で文字認識した文字を足す。PDFの文字と同じ所で読んだ文字（消し残しなど）は捨てる。
 * 足した文字は行番号を分けておく（PDFの文字とつながらない）
 */
export function mergeOcr(base: PageText, blockers: ArrayLike<number>, ocr: PageText): PageText {
  const keep: number[] = [];
  for (let i = 0; i < ocr.chars.length; i++) {
    const x0 = ocr.boxes[i * 4];
    const y0 = ocr.boxes[i * 4 + 1];
    const x1 = ocr.boxes[i * 4 + 2];
    const y1 = ocr.boxes[i * 4 + 3];
    const area = Math.max(1e-6, (x1 - x0) * (y1 - y0));
    let same = false;
    for (let k = 0; k + 3 < blockers.length && !same; k += 4) {
      const w = Math.min(x1, blockers[k + 2]) - Math.max(x0, blockers[k]);
      const h = Math.min(y1, blockers[k + 3]) - Math.max(y0, blockers[k + 1]);
      if (w <= 0 || h <= 0) continue;
      const other = Math.max(1e-6, (blockers[k + 2] - blockers[k]) * (blockers[k + 3] - blockers[k + 1]));
      same = w * h >= Math.min(area, other) * SAME_PLACE;
    }
    if (!same) keep.push(i);
  }
  if (!keep.length) return base;
  let firstLine = 0;
  for (let i = 0; i < base.lines.length; i++) firstLine = Math.max(firstLine, base.lines[i] + 1);
  const lineOf = (i: number) => firstLine + ocr.lines[i] - ocr.lines[keep[0]];
  return {
    chars: [...base.chars, ...keep.map((i) => ocr.chars[i])],
    boxes: Float32Array.from([
      ...base.boxes,
      ...keep.flatMap((i) => [ocr.boxes[i * 4], ocr.boxes[i * 4 + 1], ocr.boxes[i * 4 + 2], ocr.boxes[i * 4 + 3]]),
    ]),
    lines: Int32Array.from([...base.lines, ...keep.map(lineOf)]),
    sizes: Float32Array.from([...base.sizes, ...keep.map((i) => ocr.sizes[i])]),
  };
}

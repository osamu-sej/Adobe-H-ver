import { LABEL_FONT } from "./effects";
import type { TextFrame } from "../model/types";

/**
 * テキスト枠の文字のレイアウトと描画。画面とPDFの書き出しで同じ関数を使い、同じ見た目にする。
 * 座標・大きさはすべて元ページ空間（pt）。枠を編集しているときの入力欄（textarea）も、
 * 同じ余白・行の高さ・折り返し（どの文字でも折り返す）にそろえてある
 */

/** 枠の内側の余白（pt） */
export const FRAME_PAD = 4;
/** 行の高さ（文字の大きさに対する倍率） */
export const FRAME_LINE = 1.3;
export const FRAME_MIN_SIZE = 4;
export const FRAME_MAX_SIZE = 400;
/** 文字の大きさの候補（PowerPoint の文字サイズ欄にそろえた段階） */
export const FRAME_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];
/** 新しい枠の初期値：白い塗り・オレンジ（色見本の「朱」。アプリの強調色と同じ）の枠線・黒い12ptの文字 */
export const FRAME_DEFAULTS = {
  size: 12,
  bold: false,
  color: "#000000",
  align: "left" as const,
  fill: "#ffffff" as string | null,
  line: "#e8492a" as string | null,
};
/** 文字色の候補 */
export const FRAME_TEXT_COLORS: { name: string; value: string }[] = [
  { name: "黒", value: "#000000" },
  { name: "グレー", value: "#6b7280" },
  { name: "白", value: "#ffffff" },
  { name: "赤", value: "#d92d20" },
  { name: "朱", value: "#e8492a" },
  { name: "青", value: "#2457c5" },
  { name: "緑", value: "#2f7d4f" },
  { name: "ネイビー", value: "#1e3a5f" },
];

export type Measure = (text: string) => number;

/**
 * 文字を、幅 maxWidth に収まるように折り返す。改行（\n）はそのまま。
 * どの文字の位置でも折り返す（入力欄の line-break: anywhere と同じ）。行末の空白は折り返さずに次へはみ出させる
 */
export function wrapText(measure: Measure, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    let width = 0;
    for (const ch of para) {
      const w = measure(ch);
      if (line && ch !== " " && width + w > maxWidth) {
        lines.push(line);
        line = "";
        width = 0;
      }
      line += ch;
      width += w;
    }
    lines.push(line);
  }
  return lines;
}

/** 文字の高さ（余白を含まない） */
export const textHeight = (lines: number, size: number) => lines * size * FRAME_LINE;

/** 次に大きく・小さくする文字の大きさ（段階にない大きさのときは、いちばん近い上下の段階） */
export function stepSize(size: number, dir: 1 | -1): number {
  const next = dir > 0 ? FRAME_SIZES.find((s) => s > size + 1e-6) : [...FRAME_SIZES].reverse().find((s) => s < size - 1e-6);
  return next ?? (dir > 0 ? Math.min(FRAME_MAX_SIZE, size) : Math.max(FRAME_MIN_SIZE, size));
}

export function clampSize(size: number): number {
  return Math.min(FRAME_MAX_SIZE, Math.max(FRAME_MIN_SIZE, Math.round(size * 10) / 10));
}

export const frameFont = (f: Pick<TextFrame, "size" | "bold">) => `${f.bold ? 700 : 400} ${f.size}px ${LABEL_FONT}`;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let measureCtx: Ctx | null = null;
function scratch(): Ctx | null {
  if (measureCtx) return measureCtx;
  if (typeof OffscreenCanvas !== "undefined") measureCtx = new OffscreenCanvas(1, 1).getContext("2d");
  else if (typeof document !== "undefined") measureCtx = document.createElement("canvas").getContext("2d");
  return measureCtx;
}

/** 枠の中の文字の行。文字の幅が測れない環境（テスト）では、1文字を文字の大きさの幅として数える */
export function frameLines(f: Pick<TextFrame, "text" | "size" | "bold" | "w">, ctx: Ctx | null = scratch()): string[] {
  // 入力欄（textarea）の内側の幅そのもの。1文字が幅より広いときは、その文字を1行に置く（wrapText が受け持つ）
  const inner = Math.max(1, f.w - FRAME_PAD * 2);
  if (ctx) {
    ctx.font = frameFont(f);
    return wrapText((s) => ctx.measureText(s).width, f.text, inner);
  }
  return wrapText(() => f.size, f.text, inner);
}

/** 文字が入りきる枠の高さ */
export function neededHeight(f: Pick<TextFrame, "text" | "size" | "bold" | "w">): number {
  return textHeight(frameLines(f).length, f.size) + FRAME_PAD * 2;
}

/**
 * 枠を ctx に描く（ctx の座標は元ページ空間 pt のもの。画素に直すのは ctx の変換に任せる）。
 * 文字は枠の中でクリップする
 */
export function drawFrame(ctx: Ctx, f: TextFrame) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(f.x, f.y, f.w, f.h);
  ctx.clip();
  if (f.fill) {
    ctx.fillStyle = f.fill;
    ctx.fillRect(f.x, f.y, f.w, f.h);
  }
  const lines = frameLines(f, ctx);
  ctx.font = frameFont(f);
  ctx.fillStyle = f.color;
  ctx.textBaseline = "middle";
  ctx.textAlign = f.align;
  const x = f.align === "left" ? f.x + FRAME_PAD : f.align === "right" ? f.x + f.w - FRAME_PAD : f.x + f.w / 2;
  lines.forEach((line, i) => ctx.fillText(line, x, f.y + FRAME_PAD + (i + 0.5) * f.size * FRAME_LINE));
  ctx.restore();
  if (f.line) {
    ctx.save();
    ctx.strokeStyle = f.line;
    ctx.lineWidth = 1;
    ctx.strokeRect(f.x + 0.5, f.y + 0.5, f.w - 1, f.h - 1);
    ctx.restore();
  }
}

/** 枠1つ分を、scale 画素/pt のRGBA画像にする（PDFに書き出すとき用）。キャンバスが使えなければ null */
export function renderFrame(f: TextFrame, scale: number): { width: number; height: number; data: Uint8ClampedArray } | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const width = Math.max(1, Math.ceil(f.w * scale));
  const height = Math.max(1, Math.ceil(f.h * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(width / f.w, 0, 0, height / f.h, 0, 0);
  drawFrame(ctx, { ...f, x: 0, y: 0 });
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

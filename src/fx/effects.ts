import type { MaskStyle, Rect } from "../model/types";

/**
 * 画面プレビューと書き出しで共通に使うマスク描画処理。
 * DOMに依存しないので Web Worker（書き出し）でもメインスレッド（プレビュー）でも同じ結果になる。
 */

export interface PixelSource {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** 1ピクセルあたりの成分数（MuPDFのRGB=3、ImageData=4） */
  channels: number;
  /** data[0] がページ上のどこか（ソースのピクセル単位、ページ原点基準） */
  originX: number;
  originY: number;
  /** ソースの解像度（px / pt） */
  scale: number;
}

export interface Patch {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 強さの下限（pt）。モザイクのブロックが小さすぎると数字が読めてしまうため */
export const MIN_STRENGTH = 2.5;
export const MAX_STRENGTH = 48;

/**
 * 自動の強さ：短辺の45%（1行の文字なら文字高の約半分）を基準に、3.5〜24ptに収める。
 * 仕様の「ブロックは文字高の半分以上」を満たす。
 */
export function autoStrength(r: { w: number; h: number }): number {
  const base = Math.min(r.w, r.h) * 0.45;
  return Math.max(3.5, Math.min(24, base));
}

export function resolveStrength(m: { w: number; h: number; strength: number | null }): number {
  return Math.max(MIN_STRENGTH, m.strength ?? autoStrength(m));
}

/** ぼかしの標準偏差（pt）。強さの0.6倍、最低2.5pt */
export function blurSigma(strength: number): number {
  return Math.max(2.5, strength * 0.6);
}

/** ぼかしで周囲を参照する余白（pt） */
export function blurMargin(strength: number): number {
  return blurSigma(strength) * 3;
}

export function patchSize(rect: Rect, outScale: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(rect.w * outScale)),
    height: Math.max(1, Math.round(rect.h * outScale)),
  };
}

export function renderPatch(
  src: PixelSource,
  rect: Rect,
  style: MaskStyle,
  strength: number,
  outScale: number,
): Patch {
  const { width, height } = patchSize(rect, outScale);
  const out = new Uint8ClampedArray(width * height * 4);
  if (style === "black" || style === "white") {
    const v = style === "black" ? 0 : 255;
    for (let i = 0; i < out.length; i += 4) {
      out[i] = out[i + 1] = out[i + 2] = v;
      out[i + 3] = 255;
    }
    return { data: out, width, height };
  }
  if (style === "mosaic") {
    mosaicInto(src, rect, strength, outScale, out, width, height);
  } else {
    blurInto(src, rect, strength, outScale, out, width, height);
  }
  return { data: out, width, height };
}

function mosaicInto(
  src: PixelSource,
  rect: Rect,
  cell: number,
  outScale: number,
  out: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const nx = Math.max(1, Math.ceil(rect.w / cell - 1e-6));
  const ny = Math.max(1, Math.ceil(rect.h / cell - 1e-6));
  const ch = src.channels;
  for (let j = 0; j < ny; j++) {
    const cy0 = rect.y + j * cell;
    const cy1 = Math.min(rect.y + rect.h, cy0 + cell);
    for (let i = 0; i < nx; i++) {
      const cx0 = rect.x + i * cell;
      const cx1 = Math.min(rect.x + rect.w, cx0 + cell);
      // セルに対応するソースのピクセル範囲
      let sx0 = Math.floor(cx0 * src.scale - src.originX);
      let sx1 = Math.ceil(cx1 * src.scale - src.originX);
      let sy0 = Math.floor(cy0 * src.scale - src.originY);
      let sy1 = Math.ceil(cy1 * src.scale - src.originY);
      sx0 = clampInt(sx0, 0, src.width - 1);
      sy0 = clampInt(sy0, 0, src.height - 1);
      sx1 = clampInt(Math.max(sx1, sx0 + 1), 1, src.width);
      sy1 = clampInt(Math.max(sy1, sy0 + 1), 1, src.height);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = sy0; y < sy1; y++) {
        let p = (y * src.width + sx0) * ch;
        for (let x = sx0; x < sx1; x++) {
          r += src.data[p];
          g += src.data[p + 1];
          b += src.data[p + 2];
          n++;
          p += ch;
        }
      }
      if (n === 0) n = 1;
      const cr = r / n;
      const cg = g / n;
      const cb = b / n;
      // 出力パッチのピクセル範囲
      const ox0 = clampInt(Math.round((cx0 - rect.x) * outScale), 0, width);
      const ox1 = clampInt(Math.round((cx1 - rect.x) * outScale), 0, width);
      const oy0 = clampInt(Math.round((cy0 - rect.y) * outScale), 0, height);
      const oy1 = clampInt(Math.round((cy1 - rect.y) * outScale), 0, height);
      for (let y = oy0; y < oy1; y++) {
        let p = (y * width + ox0) * 4;
        for (let x = ox0; x < ox1; x++) {
          out[p] = cr;
          out[p + 1] = cg;
          out[p + 2] = cb;
          out[p + 3] = 255;
          p += 4;
        }
      }
    }
  }
}

function blurInto(
  src: PixelSource,
  rect: Rect,
  strength: number,
  outScale: number,
  out: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const margin = blurMargin(strength);
  // ソース上の作業領域（マスク＋余白）
  const ax0 = clampInt(Math.floor((rect.x - margin) * src.scale - src.originX), 0, src.width - 1);
  const ay0 = clampInt(Math.floor((rect.y - margin) * src.scale - src.originY), 0, src.height - 1);
  const ax1 = clampInt(Math.ceil((rect.x + rect.w + margin) * src.scale - src.originX), ax0 + 1, src.width);
  const ay1 = clampInt(Math.ceil((rect.y + rect.h + margin) * src.scale - src.originY), ay0 + 1, src.height);
  const aw = ax1 - ax0;
  const ah = ay1 - ay0;
  const ch = src.channels;
  const buf = new Float32Array(aw * ah * 3);
  for (let y = 0; y < ah; y++) {
    let p = ((ay0 + y) * src.width + ax0) * ch;
    let q = y * aw * 3;
    for (let x = 0; x < aw; x++) {
      buf[q] = src.data[p];
      buf[q + 1] = src.data[p + 1];
      buf[q + 2] = src.data[p + 2];
      p += ch;
      q += 3;
    }
  }
  const sigmaPx = blurSigma(strength) * src.scale;
  const tmp = new Float32Array(buf.length);
  for (const r of boxRadii(sigmaPx, 3)) {
    boxH(buf, tmp, aw, ah, r);
    boxV(tmp, buf, aw, ah, r);
  }
  // 出力へ（最近傍で再標本化）
  for (let y = 0; y < height; y++) {
    const sy = clampInt(Math.floor((rect.y + (y + 0.5) / outScale) * src.scale - src.originY) - ay0, 0, ah - 1);
    for (let x = 0; x < width; x++) {
      const sx = clampInt(Math.floor((rect.x + (x + 0.5) / outScale) * src.scale - src.originX) - ax0, 0, aw - 1);
      const q = (sy * aw + sx) * 3;
      const p = (y * width + x) * 4;
      out[p] = buf[q];
      out[p + 1] = buf[q + 1];
      out[p + 2] = buf[q + 2];
      out[p + 3] = 255;
    }
  }
}

/** ガウスぼかしを箱型ぼかしn回で近似するときの各半径 */
function boxRadii(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const radii: number[] = [];
  for (let i = 0; i < n; i++) radii.push(Math.max(0, ((i < m ? wl : wu) - 1) / 2));
  return radii;
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  if (r <= 0) {
    dst.set(src);
    return;
  }
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r - 1; k < r; k++) acc += src[(row + clampInt(k, 0, w - 1)) * 3 + c];
      for (let x = 0; x < w; x++) {
        acc += src[(row + clampInt(x + r, 0, w - 1)) * 3 + c] - src[(row + clampInt(x - r - 1, 0, w - 1)) * 3 + c];
        dst[(row + x) * 3 + c] = acc * iarr;
      }
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  if (r <= 0) {
    dst.set(src);
    return;
  }
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r - 1; k < r; k++) acc += src[(clampInt(k, 0, h - 1) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        acc += src[(clampInt(y + r, 0, h - 1) * w + x) * 3 + c] - src[(clampInt(y - r - 1, 0, h - 1) * w + x) * 3 + c];
        dst[(y * w + x) * 3 + c] = acc * iarr;
      }
    }
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const LABEL_FONT =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif';

/** マスク上の文言（「非開示」など）を描く。座標はctxのピクセル単位 */
export function drawLabel(
  ctx: Ctx2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  style: MaskStyle,
) {
  if (!label || w < 4 || h < 4) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  let size = Math.min(h * 0.62, (w * 0.9) / Math.max(1, label.length * 0.95));
  size = Math.max(4, size);
  ctx.font = `600 ${size}px ${LABEL_FONT}`;
  const tw = ctx.measureText(label).width;
  if (tw > w * 0.92) {
    size = (size * (w * 0.92)) / tw;
    ctx.font = `600 ${size}px ${LABEL_FONT}`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (style === "mosaic" || style === "blur") {
    const m = ctx.measureText(label);
    const pw = Math.min(w, m.width + size * 0.8);
    const ph = Math.min(h, size * 1.4);
    ctx.fillStyle = "rgba(17,24,39,0.82)";
    ctx.fillRect(cx - pw / 2, cy - ph / 2, pw, ph);
    ctx.fillStyle = "#fff";
  } else {
    ctx.fillStyle = style === "black" ? "#fff" : "#4b5563";
  }
  ctx.fillText(label, cx, cy + size * 0.04);
  ctx.restore();
}

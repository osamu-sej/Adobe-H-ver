import { blurMargin, drawLabel, isOpaqueFill, renderPatch, resolveStrength, type PixelSource } from "../fx/effects";
import { clampRect, maskBounds, maskCorners } from "../model/geometry";
import type { Level, MaskStyle, Rect, Rot } from "../model/types";
import type { PageBitmap } from "./bitmaps";

export interface PaintMask extends Rect {
  angle?: number;
  style: MaskStyle;
  level: Level;
  strength: number | null;
  color: string;
  opacity: number;
  label: string | null;
}

/** 元ページ空間 → 回転後の表示（キャンバス）への変換行列。s は px/pt */
export function baseToView(rot: Rot, w: number, h: number, s: number): [number, number, number, number, number, number] {
  switch (rot) {
    case 90:
      return [0, s, -s, 0, h * s, 0];
    case 180:
      return [-s, 0, 0, -s, w * s, h * s];
    case 270:
      return [0, -s, s, 0, 0, w * s];
    default:
      return [s, 0, 0, s, 0, 0];
  }
}

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;
function scratch2d() {
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  return { canvas: scratch!, ctx: scratchCtx! };
}

const patchCache = new WeakMap<ImageBitmap, Map<string, HTMLCanvasElement>>();

/** マスク1つ分のモザイク／ぼかし／塗りの画像（表示中のページ画像から作る。書き出しと同じ処理） */
function maskPatch(bmp: PageBitmap, m: PaintMask, shape: PaintMask = m): HTMLCanvasElement | null {
  const strength = resolveStrength(shape);
  const key = `${m.x.toFixed(2)},${m.y.toFixed(2)},${m.w.toFixed(2)},${m.h.toFixed(2)},${m.style},${strength.toFixed(2)},${m.color},${m.opacity.toFixed(2)},${m.label ?? ""},${shape.x},${shape.y},${shape.w},${shape.h},${shape.angle ?? 0}`;
  let cache = patchCache.get(bmp.bitmap);
  if (!cache) patchCache.set(bmp.bitmap, (cache = new Map()));
  // 回転中は毎フレーム異なる画像になるため、キャッシュに積み続けない。
  const hit = shape.angle ? undefined : cache.get(key);
  if (hit) return hit;

  const s = bmp.scale;
  const margin = m.style === "blur" ? blurMargin(strength) : 0;
  const sx0 = Math.max(0, Math.floor((m.x - margin) * s));
  const sy0 = Math.max(0, Math.floor((m.y - margin) * s));
  const sx1 = Math.min(bmp.width, Math.ceil((m.x + m.w + margin) * s));
  const sy1 = Math.min(bmp.height, Math.ceil((m.y + m.h + margin) * s));
  const sw = sx1 - sx0;
  const sh = sy1 - sy0;
  if (sw <= 0 || sh <= 0) return null;

  let src: PixelSource;
  if (m.style !== "fill" || !isOpaqueFill(m)) {
    const { canvas, ctx } = scratch2d();
    canvas.width = sw;
    canvas.height = sh;
    ctx.drawImage(bmp.bitmap, sx0, sy0, sw, sh, 0, 0, sw, sh);
    const img = ctx.getImageData(0, 0, sw, sh);
    src = { data: img.data, width: sw, height: sh, channels: 4, originX: sx0, originY: sy0, scale: s };
  } else {
    src = { data: new Uint8ClampedArray(4), width: 1, height: 1, channels: 4, originX: 0, originY: 0, scale: s };
  }
  const patch = renderPatch(src, m, m.style, strength, s, m);
  const c = document.createElement("canvas");
  c.width = patch.width;
  c.height = patch.height;
  const ctx = c.getContext("2d")!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(patch.data), patch.width, patch.height), 0, 0);
  if (m.label) {
    ctx.save();
    ctx.translate((shape.x + shape.w / 2 - m.x) * patch.width / m.w, (shape.y + shape.h / 2 - m.y) * patch.height / m.h);
    ctx.rotate((shape.angle ?? 0) * Math.PI / 180);
    const w = shape.w * patch.width / m.w, h = shape.h * patch.height / m.h;
    drawLabel(ctx, -w / 2, -h / 2, w, h, m.label, m.style, m);
    ctx.restore();
  }
  if (!shape.angle) {
    if (cache.size > 600) cache.clear();
    cache.set(key, c);
  }
  return c;
}

/** マスクの効果をキャンバスに描く（キャンバスはページ画像と同じ大きさ・向き） */
export function paintMasks(
  canvas: HTMLCanvasElement,
  bmp: PageBitmap | undefined,
  masks: PaintMask[],
  rot: Rot,
  pageW: number,
  pageH: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!bmp || !masks.length) return;
  ctx.setTransform(...baseToView(rot, pageW, pageH, bmp.scale));
  ctx.imageSmoothingEnabled = false;
  for (const raw of masks) {
    const m = { ...raw, ...clampRect(maskBounds(raw), pageW, pageH) };
    if (m.w <= 0 || m.h <= 0) continue;
    ctx.save();
    if (raw.angle) {
      const points = maskCorners(raw);
      ctx.beginPath();
      ctx.moveTo(...points[0]);
      for (const p of points.slice(1)) ctx.lineTo(...p);
      ctx.closePath();
      ctx.clip();
    }
    if (m.style === "fill" && !m.label) {
      // ページ画像の上に重ねるキャンバスなので、透ける塗りもそのまま半透明で塗れば書き出しと同じ見た目になる
      ctx.globalAlpha = m.opacity;
      ctx.fillStyle = m.color;
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.globalAlpha = 1;
      ctx.restore();
      continue;
    }
    const patch = maskPatch(bmp, m, raw.angle ? raw : m);
    if (patch) ctx.drawImage(patch, m.x, m.y, m.w, m.h);
    ctx.restore();
  }
}

/** ページ画像（元の向き）を回転して描く */
export function paintPage(canvas: HTMLCanvasElement, bmp: PageBitmap, rot: Rot) {
  const swap = rot === 90 || rot === 270;
  const w = swap ? bmp.height : bmp.width;
  const h = swap ? bmp.width : bmp.height;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(...baseToView(rot, bmp.width, bmp.height, 1));
  ctx.drawImage(bmp.bitmap, 0, 0);
}

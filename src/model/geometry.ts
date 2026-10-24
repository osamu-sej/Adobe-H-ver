import type { Rect, Rot } from "./types";

export function viewSize(w: number, h: number, rot: Rot): { w: number; h: number } {
  return rot === 90 || rot === 270 ? { w: h, h: w } : { w, h };
}

/** 元ページ空間の点 → 回転後の表示空間の点（時計回り） */
export function toViewPoint(x: number, y: number, rot: Rot, w: number, h: number): [number, number] {
  switch (rot) {
    case 90:
      return [h - y, x];
    case 180:
      return [w - x, h - y];
    case 270:
      return [y, w - x];
    default:
      return [x, y];
  }
}

/** 表示空間の点 → 元ページ空間の点 */
export function toBasePoint(u: number, v: number, rot: Rot, w: number, h: number): [number, number] {
  switch (rot) {
    case 90:
      return [v, h - u];
    case 180:
      return [w - u, h - v];
    case 270:
      return [w - v, u];
    default:
      return [u, v];
  }
}

export function toViewRect(r: Rect, rot: Rot, w: number, h: number): Rect {
  const [ax, ay] = toViewPoint(r.x, r.y, rot, w, h);
  const [bx, by] = toViewPoint(r.x + r.w, r.y + r.h, rot, w, h);
  return normRect(ax, ay, bx, by);
}

export function toBaseRect(r: Rect, rot: Rot, w: number, h: number): Rect {
  const [ax, ay] = toBasePoint(r.x, r.y, rot, w, h);
  const [bx, by] = toBasePoint(r.x + r.w, r.y + r.h, rot, w, h);
  return normRect(ax, ay, bx, by);
}

export function normRect(ax: number, ay: number, bx: number, by: number): Rect {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

export function clampRect(r: Rect, w: number, h: number): Rect {
  const x0 = Math.max(0, Math.min(w, r.x));
  const y0 = Math.max(0, Math.min(h, r.y));
  const x1 = Math.max(0, Math.min(w, r.x + r.w));
  const y1 = Math.max(0, Math.min(h, r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

export function containsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function addRot(a: Rot, delta: number): Rot {
  return ((((a + delta) % 360) + 360) % 360) as Rot;
}

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

export type OrientedRect = Rect & { angle?: number };
export type Point = [number, number];

export function normalizeAngle(angle: number): number {
  const normalized = ((angle + 180) % 360 + 360) % 360 - 180;
  return Math.round(normalized * 10) / 10 || 0;
}

/** ページの左上原点で、中心を軸に時計回りに回転した点 */
export function rotatePoint(x: number, y: number, cx: number, cy: number, angle: number): Point {
  const a = (angle * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a), dx = x - cx, dy = y - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

export function maskCorners(r: OrientedRect): Point[] {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]
    .map(([x, y]) => rotatePoint(x, y, cx, cy, r.angle ?? 0));
}

export function maskBounds(r: OrientedRect): Rect {
  if (!r.angle) return { x: r.x, y: r.y, w: r.w, h: r.h };
  const p = maskCorners(r), xs = p.map((v) => v[0]), ys = p.map((v) => v[1]);
  return normRect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

export function maskContains(r: OrientedRect, x: number, y: number): boolean {
  if (!r.angle) return containsPoint(r, x, y);
  const [px, py] = rotatePoint(x, y, r.x + r.w / 2, r.y + r.h / 2, -(r.angle ?? 0));
  return containsPoint(r, px, py);
}

/** 回転した四角と、軸に沿う四角の交差部分 */
export function maskOverlapArea(mask: OrientedRect, rect: Rect): number {
  if (!mask.angle) return overlapArea(mask, rect);
  let points = maskCorners(mask);
  const clip = (axis: 0 | 1, value: number, greater: boolean) => {
    const input = points;
    points = [];
    if (!input.length) return;
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const inA = greater ? a[axis] >= value : a[axis] <= value;
      const inB = greater ? b[axis] >= value : b[axis] <= value;
      if (inA) points.push(a);
      if (inA !== inB) {
        const t = (value - a[axis]) / (b[axis] - a[axis]);
        points.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
  };
  clip(0, rect.x, true); clip(0, rect.x + rect.w, false);
  clip(1, rect.y, true); clip(1, rect.y + rect.h, false);
  return Math.abs(points.reduce((s, p, i) => s + p[0] * points[(i + 1) % points.length][1] - p[1] * points[(i + 1) % points.length][0], 0)) / 2;
}

export function addRot(a: Rot, delta: number): Rot {
  return ((((a + delta) % 360) + 360) % 360) as Rot;
}

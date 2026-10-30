import { describe, expect, it } from 'vitest';
import { maskBounds, maskContains, maskCorners, maskOverlapArea, rotatePoint, toBasePoint, toViewPoint } from './geometry';

describe('回転したマスク', () => {
  it('中心を軸に回り、枠外を覆ったと誤認しない', () => {
    const mask = { x: 20, y: 40, w: 80, h: 20, angle: 45 };
    const b = maskBounds(mask);
    expect(maskContains(mask, 60, 50)).toBe(true);
    expect(maskContains(mask, b.x + 1, b.y + 1)).toBe(false);
    expect(maskOverlapArea(mask, { x: b.x, y: b.y, w: 3, h: 3 })).toBe(0);
    expect(maskOverlapArea(mask, { x: 59, y: 49, w: 2, h: 2 })).toBeCloseTo(4);
    expect(maskOverlapArea(mask, b)).toBeCloseTo(1600);
  });
  it('ページ回転した表示と元ページの位置を相互変換する', () => {
    for (const rot of [0, 90, 180, 270] as const) {
      const [x,y] = rotatePoint(120, 40, 100, 100, 37.4);
      const [u,v] = toViewPoint(x,y,rot,200,300);
      expect(toBasePoint(u,v,rot,200,300)[0]).toBeCloseTo(x);
      expect(toBasePoint(u,v,rot,200,300)[1]).toBeCloseTo(y);
    }
    expect(maskCorners({x:0,y:0,w:20,h:10,angle:180})[0][0]).toBeCloseTo(20);
  });
});

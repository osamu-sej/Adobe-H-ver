/**
 * 文字認識の前に、ページの画像を読みやすく整える（1画素1バイトのグレースケールにして返す）。
 * - 薄い色（オレンジ・黄色のセル、マーカーの線）は、色の中でいちばん明るい成分を使って白っぽくする。黒い文字だけが残る
 * - 濃い色（赤や青の文字）は暗いまま残す。濃い色で塗りつぶしたセルの白抜きの文字は、白地に黒い文字にする
 * - 表の罫線（細くて長い縦線・横線。点線も）を消す：罫線を「1」や「|」と読んだり、隣のセルの数字とつながったりしないように
 * - 薄い灰色（紙の地、色の付いたセルの名残）を白にする
 * 色付きの表のスキャンで、文字認識が読めた数字は3割台から9割に増えた。
 */

/** これより暗い画素を、罫線の候補にする */
const RULE_DARK = 235;
/** 色の濃さ（最大と最小の成分の差）と明るさがこの範囲の色を「濃い色の地」とみなす */
const DEEP_SAT = 60;
const DEEP_LUM = 110;
/** 濃い色の画素がまとまりの外枠のこの割合以上を埋めていれば、塗りつぶしたセルとみなす */
const CELL_FILL = 0.6;
/** 反転したセルの中で、これより明るい画素は白にする（濃い色の地は反転すると明るい灰色になる） */
const CELL_PAPER = 150;
/** これより明るい画素は白にする */
const PAPER = 215;

export function prepareOcrImage(
  rgb: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  stride: number,
  dpi: number,
): Uint8Array {
  const n = width * height;
  const g = new Uint8Array(n);
  // 濃い色の地（赤いセルなど）の画素
  const deep = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    let o = y * stride;
    for (let x = 0, i = y * width; x < width; x++, i++, o += 3) {
      const r = rgb[o];
      const gr = rgb[o + 1];
      const b = rgb[o + 2];
      const hi = Math.max(r, gr, b);
      const lum = 0.299 * r + 0.587 * gr + 0.114 * b;
      // 濃い色（赤や青の文字、赤いセル）は暗いまま。薄い色（オレンジのセル、マーカー）は白っぽくする
      if (hi - Math.min(r, gr, b) > DEEP_SAT && lum < DEEP_LUM) {
        deep[i] = 1;
        g[i] = lum;
      } else g[i] = hi;
    }
  }
  const k = dpi / 300;
  invertDeepCells(g, deep, rgb, width, height, stride, k);
  removeRules(g, width, height, Math.round(100 * k), Math.max(2, Math.round(7 * k)), Math.max(1, Math.round(6 * k)));
  for (let i = 0; i < n; i++) g[i] = Math.min(255, Math.round((g[i] * 255) / PAPER));
  return g;
}

/**
 * 画像の中の矩形を白く塗る（PDFの文字がある所を消して、画像や図の中の文字だけを読むため）。
 * rects は元ページ空間の [x0, y0, x1, y1] × n、toImage はページ → 画素の変換。文字の端が残らないよう1画素広げる
 */
export function blankRects(
  rgb: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  stride: number,
  rects: ArrayLike<number>,
  toImage: [number, number, number, number, number, number],
) {
  const m = toImage;
  const at = (x: number, y: number) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  for (let r = 0; r + 3 < rects.length; r += 4) {
    const pts = [at(rects[r], rects[r + 1]), at(rects[r + 2], rects[r + 1]), at(rects[r], rects[r + 3]), at(rects[r + 2], rects[r + 3])];
    const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0]))) - 1);
    const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1]))) - 1);
    const x1 = Math.min(width, Math.ceil(Math.max(...pts.map((p) => p[0]))) + 1);
    const y1 = Math.min(height, Math.ceil(Math.max(...pts.map((p) => p[1]))) + 1);
    for (let y = y0; y < y1; y++) rgb.fill(255, y * stride + x0 * 3, y * stride + x1 * 3);
  }
}

/**
 * 濃い色で塗りつぶしたセルに白抜きの文字（赤いセルの気温など）は、セルの中の明るさを反転して、白地に黒い文字にする。
 * 濃い色の画素のまとまりのうち、大きくて四角をほぼ埋めているものをセルとみなす（濃い色の文字は細いので当たらない）
 */
function invertDeepCells(
  g: Uint8Array,
  deep: Uint8Array,
  rgb: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  stride: number,
  k: number,
) {
  // 小さな四角（block 画素四方）ごとに、半分以上が濃い色かを見る
  const block = Math.max(2, Math.round(4 * k));
  const gw = Math.ceil(w / block);
  const gh = Math.ceil(h / block);
  const cell = new Uint8Array(gw * gh);
  for (let by = 0; by < gh; by++)
    for (let bx = 0; bx < gw; bx++) {
      let n = 0;
      let all = 0;
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y++)
        for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x++) {
          n += deep[y * w + x];
          all++;
        }
      if (n * 2 >= all) cell[by * gw + bx] = 1;
    }
  // つながった濃い色の四角のまとまりごとに、外枠と数を求める
  const seen = new Uint8Array(gw * gh);
  const stack: number[] = [];
  const minW = 40 * k;
  const minH = 30 * k;
  for (let start = 0; start < gw * gh; start++) {
    if (!cell[start] || seen[start]) continue;
    let x0 = gw;
    let x1 = -1;
    let y0 = gh;
    let y1 = -1;
    let count = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % gw;
      const cy = (c - cx) / gw;
      count++;
      x0 = Math.min(x0, cx);
      x1 = Math.max(x1, cx);
      y0 = Math.min(y0, cy);
      y1 = Math.max(y1, cy);
      for (const [nx, ny] of [
        [cx - 1, cy],
        [cx + 1, cy],
        [cx, cy - 1],
        [cx, cy + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const nc = ny * gw + nx;
        if (cell[nc] && !seen[nc]) {
          seen[nc] = 1;
          stack.push(nc);
        }
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (bw * block < minW || bh * block < minH || count < bw * bh * CELL_FILL) continue;
    // セルの中を反転し、地（反転して明るい灰色）を白にする
    for (let y = y0 * block; y < Math.min(h, (y1 + 1) * block); y++)
      for (let x = x0 * block; x < Math.min(w, (x1 + 1) * block); x++) {
        const o = y * stride + x * 3;
        const inv = 255 - (0.299 * rgb[o] + 0.587 * rgb[o + 1] + 0.114 * rgb[o + 2]);
        g[y * w + x] = Math.min(255, Math.round((inv * 255) / CELL_PAPER));
      }
  }
}

/**
 * 罫線を白く消す。左右（横線なら上下）の off 画素先が明るい細い暗い画素が、途切れ gap 画素以下で minLen 画素以上続けば罫線とみなす。
 * 文字の画は文字の高さより長くならないので残る。塗りつぶした帯（濃い見出しなど）は「細い」に当たらないので残る
 */
function removeRules(g: Uint8Array, w: number, h: number, minLen: number, off: number, gap: number) {
  const src = g.slice();
  // 画像の外は明るいとみなす
  const dark = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && src[y * w + x] < RULE_DARK;
  // 縦線（a が列、b が行）と横線（a が行、b が列）を同じ手順で調べる
  for (const vertical of [true, false]) {
    const lines = vertical ? w : h;
    const len = vertical ? h : w;
    const at = (a: number, b: number) => (vertical ? [a, b] : [b, a]) as [number, number];
    // 線に直交する向きに d 画素ずらした位置が暗いか
    const darkAcross = (a: number, b: number, d: number) => (vertical ? dark(a + d, b) : dark(b, a + d));
    const thin = (a: number, b: number) => darkAcross(a, b, 0) && !darkAcross(a, b, -off) && !darkAcross(a, b, off);
    const erase = (a: number, from: number, to: number) => {
      for (let b = from; b <= to; b++)
        for (let d = -off + 1; d < off; d++) {
          // 線の太さ分を消す。文字と接しているところは、線の外側が明るい画素だけ
          if (!darkAcross(a, b, d)) continue;
          if (darkAcross(a, b, d - off) && darkAcross(a, b, d + off)) continue;
          const [x, y] = at(a + d, b);
          g[y * w + x] = 255;
        }
    };
    for (let a = 0; a < lines; a++) {
      let start = -1;
      let last = -1;
      for (let b = 0; b < len; b++) {
        if (!thin(a, b)) continue;
        if (start < 0 || b - last > gap + 1) {
          if (start >= 0 && last - start + 1 >= minLen) erase(a, start, last);
          start = b;
        }
        last = b;
      }
      if (start >= 0 && last - start + 1 >= minLen) erase(a, start, last);
    }
  }
}

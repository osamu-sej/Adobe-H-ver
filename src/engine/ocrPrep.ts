/**
 * 文字認識の前に、ページの画像を読みやすく整える（1画素1バイトのグレースケールにして返す）。
 * - 薄い色（オレンジ・黄色のセル、マーカーの線）は、色の中でいちばん明るい成分を使って白っぽくする。黒い文字だけが残る
 * - 濃い色（赤や青の文字）は暗いまま残す。濃い色で塗りつぶしたセルの白抜きの文字は、白地に黒い文字にする
 * - 薄い灰色（紙の地、網掛けのセル、色の付いたセルの名残）を白にする
 * - 表の罫線（細くて長い縦線・横線。点線も）を消す：罫線を「1」や「|」と読んだり、隣のセルの数字とつながったりしないように
 * 色付きの表のスキャンで、文字認識が読めた数字は3割台から9割に増えた。
 */

/** これより暗い画素を、罫線の候補にする（薄い灰色を白にした後の明るさ） */
const RULE_DARK = 250;
/** 色の濃さ（最大と最小の成分の差）と明るさがこの範囲の色を「濃い色の地」とみなす */
const DEEP_SAT = 60;
const DEEP_LUM = 110;
/** 濃い色の画素がまとまりの外枠のこの割合以上を埋めていれば、塗りつぶしたセルとみなす */
const CELL_FILL = 0.6;
/** 反転したセルの中で、これより明るい画素は白にする（濃い色の地は反転すると明るい灰色になる） */
const CELL_PAPER = 150;
/** 色の成分がすべてこれより暗い画素を黒っぽい（黒い文字や罫線）とみなす */
const BLACK = 100;
/** これより明るい画素は白にする */
const PAPER = 215;
/** 網掛けの地とみなす明るさの下限（これより暗い地は塗りつぶした帯などとして、そのままにする） */
const SHADE_MIN = 150;
/** 網掛けの地は、地の明るさよりこれだけ暗い所まで白にする（網掛けの細かい模様も消す） */
const SHADE_MARGIN = 15;
/** 色の付いた文字とみなす色の濃さ（最大と最小の成分の差） */
const INK_SAT = 70;
/** これより明るい色はマーカーの線などとみなし、色の付いた文字にしない */
const INK_LUM = 145;
/** オレンジ・茶色の文字はこれより暗い所まで（明るめのオレンジの文字が多い。オレンジのセルは太さで見分ける） */
const WARM_INK_LUM = 170;
/** オレンジの文字のすぐ隣で、同じ文字の線とみなす色の濃さと明るさ（赤み〜黄色み） */
const FAINT_INK_SAT = 30;
const FAINT_INK_LUM = 215;
/** 黄色の地とみなす色の濃さ・明るさと、まわりの正方形の中の黄色の画素の割合の下限 */
const YELLOW_SAT = 50;
const YELLOW_LUM = 190;
const YELLOW_SHARE = 0.3;
/** 黄色の地の上の文字の濃さ：赤と緑の暗い方の、白からの暗さのこの割合だけさらに暗くする */
const YELLOW_GAIN = 0.6;
/** オレンジのセルを見分ける正方形の半径（300dpi での画素。セルの文字の高さくらい） */
const CELL_WINDOW = 20;
const CELL_SHARE = 0.4;
/** オレンジのセルとみなす色の濃さと明るさ（黄色のマーカーや地はこれより明るい） */
const WARM_FILL_SAT = 50;
const WARM_FILL_LUM = 200;
/** これより太い色の線（300dpi での画素）は蛍光ペンなどとみなし、色の付いた文字にしない */
const INK_THICK = 11;
/** 色の付いた文字の暗さ：色の濃さ（オレンジの文字は白からの暗さも）のこの倍だけ白から暗くする */
const INK_GAIN = 2;

/** 色相（0〜360度） */
function hueOf(r: number, g: number, b: number, hi: number, sat: number): number {
  let hue: number;
  if (hi === r) hue = (60 * (g - b)) / sat;
  else if (hi === g) hue = (60 * (b - r)) / sat + 120;
  else hue = (60 * (r - g)) / sat + 240;
  return hue < 0 ? hue + 360 : hue;
}

/** オレンジ・黄色・茶色（色相 12〜75度）か */
function warmHue(r: number, g: number, b: number, hi: number, sat: number): boolean {
  const hue = hueOf(r, g, b, hi, sat);
  return hue >= 12 && hue <= 75;
}

/** 黄色（色相 45〜70度）か */
function yellowHue(r: number, g: number, b: number, hi: number, sat: number): boolean {
  const hue = hueOf(r, g, b, hi, sat);
  return hue >= 45 && hue <= 70;
}

/**
 * 黄色の地（黄色のセルやマーカー）の上の文字は、赤と緑の暗い方の明るさで濃淡にする。
 * 黄色の地の上の黒い文字は、地と混じって黄土色のむらになり、色の付いた文字として一部だけ黒くするとまだらになるため。
 * 黄色の地は赤と緑が明るいので白に近いまま、文字は赤も緑も暗いので濃く残る。この中は色の付いた文字として扱わない。
 * 隣の濃い色のセル（反転して白地に黒い文字にしたもの）には当てない
 */
function darkenOnYellow(
  g: Uint8Array,
  ink: Uint8Array,
  yellow: Uint8Array,
  inverted: Uint8Array,
  rgb: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  stride: number,
  k: number,
) {
  const r = Math.max(2, Math.round(CELL_WINDOW * k));
  const share = boxCount(yellow, w, h, r);
  const need = YELLOW_SHARE * (2 * r + 1) ** 2;
  for (let y = 0; y < h; y++) {
    let o = y * stride;
    for (let x = 0, i = y * w; x < w; x++, i++, o += 3) {
      if (share[i] < need || inverted[i]) continue;
      // オレンジの文字（赤は明るく、緑だけ暗い）も黒くなるよう、地との差を広げる
      const v = Math.min(rgb[o], rgb[o + 1]);
      g[i] = Math.min(g[i], Math.max(0, Math.round(v - (255 - v) * YELLOW_GAIN)));
      ink[i] = 0;
    }
  }
}

/** 赤からオレンジ・黄色まで（色相 -15〜75度）か。赤みのオレンジの文字は、スキャンの色むらで赤にもオレンジにもなる */
function redToYellow(r: number, g: number, b: number, hi: number, sat: number): boolean {
  const hue = hueOf(r, g, b, hi, sat);
  return hue >= 345 || hue <= 75;
}

export function prepareOcrImage(
  rgb: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  stride: number,
  dpi: number,
  originalGray?: Uint8Array,
): Uint8Array {
  const n = width * height;
  const g = new Uint8Array(n);
  // 濃い色の地（赤いセルなど）の画素
  const deep = new Uint8Array(n);
  // 色の付いた文字の候補と、そのうちオレンジ・茶色のもの（黒い線とオレンジのセルの境目もこの色になる）
  const ink = new Uint8Array(n);
  const warm = new Uint8Array(n);
  // オレンジのセルの候補（太さで見分ける）と、黒っぽい画素（黒い文字や罫線）
  const warmFill = new Uint8Array(n);
  const black = new Uint8Array(n);
  // 黄色の地（黄色のセルやマーカー）の画素
  const yellow = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    let o = y * stride;
    for (let x = 0, i = y * width; x < width; x++, i++, o += 3) {
      const r = rgb[o];
      const gr = rgb[o + 1];
      const b = rgb[o + 2];
      const hi = Math.max(r, gr, b);
      const sat = hi - Math.min(r, gr, b);
      const lum = 0.299 * r + 0.587 * gr + 0.114 * b;
      if (originalGray) originalGray[i] = Math.round(lum);
      // 濃い色（赤や青の文字、赤いセル）は暗いまま。薄い色（オレンジのセル、マーカー）は白っぽくする
      if (sat > DEEP_SAT && lum < DEEP_LUM) {
        deep[i] = 1;
        g[i] = lum;
      } else g[i] = hi;
      const isWarm = sat > 0 && warmHue(r, gr, b, hi, sat);
      if (sat >= INK_SAT && lum < (isWarm ? WARM_INK_LUM : INK_LUM)) {
        ink[i] = 1;
        warm[i] = isWarm ? 1 : 0;
      }
      if (isWarm && sat >= WARM_FILL_SAT && lum < WARM_FILL_LUM) warmFill[i] = 1;
      if (hi < BLACK) black[i] = 1;
      if (sat >= YELLOW_SAT && lum >= YELLOW_LUM && yellowHue(r, gr, b, hi, sat)) yellow[i] = 1;
    }
  }
  const k = dpi / 300;
  const inverted = invertDeepCells(g, deep, rgb, width, height, stride, k);
  darkenOnYellow(g, ink, yellow, inverted, rgb, width, height, stride, k);
  darkenColorInk(g, ink, warm, warmFill, black, rgb, width, height, stride, k);
  // 薄い灰色（紙の地や網掛けのセル）を先に白にする。網掛けの中の罫線も、両側が白になって消せる
  whitenPaper(g, width, height, k);
  removeRules(g, width, height, Math.round(100 * k), Math.max(2, Math.round(7 * k)), Math.max(1, Math.round(6 * k)));
  return g;
}

/**
 * 紙の地を白にする。地の明るさは場所ごとに測る（小さな四角ごとに明るい方から1割の明るさ）。
 * 灰色の網掛けのセルは、地が暗い分だけ明るくして白にする（網掛けの地や模様を罫線や文字と間違えないように）
 */
function whitenPaper(g: Uint8Array, w: number, h: number, k: number) {
  const block = Math.max(4, Math.round(16 * k));
  const gw = Math.ceil(w / block);
  const gh = Math.ceil(h / block);
  const level = new Uint8Array(gw * gh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < gh; by++)
    for (let bx = 0; bx < gw; bx++) {
      hist.fill(0);
      let all = 0;
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y++)
        for (let x = bx * block, i = y * w + x; x < Math.min(w, (bx + 1) * block); x++, i++) {
          hist[g[i]]++;
          all++;
        }
      let v = 255;
      for (let seen = 0; v > 0; v--) if ((seen += hist[v]) * 10 >= all) break;
      level[by * gw + bx] = v;
    }
  // 隣の四角の暗い方の地を使う（網掛けの端の四角や、文字が詰まって地が測れない四角も網掛けとして扱う。
  // 白い紙はどちらでも白のまま）。塗りつぶした帯のように暗すぎる所は地とみなさない
  const divisor = new Float32Array(gw * gh);
  for (let by = 0; by < gh; by++)
    for (let bx = 0; bx < gw; bx++) {
      let v = 255;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = bx + dx;
          const ny = by + dy;
          if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && level[ny * gw + nx] >= SHADE_MIN)
            v = Math.min(v, level[ny * gw + nx]);
        }
      divisor[by * gw + bx] = Math.min(PAPER, v - SHADE_MARGIN);
    }
  for (let y = 0; y < h; y++) {
    const row = Math.floor(y / block) * gw;
    for (let x = 0, i = y * w; x < w; x++, i++)
      g[i] = Math.min(255, Math.round((g[i] * 255) / divisor[row + Math.floor(x / block)]));
  }
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
 * 濃い色の画素のまとまりのうち、大きくて四角をほぼ埋めているものをセルとみなす（濃い色の文字は細いので当たらない）。
 * 反転したセルの画素に印を付けて返す
 */
function invertDeepCells(
  g: Uint8Array,
  deep: Uint8Array,
  rgb: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  stride: number,
  k: number,
): Uint8Array {
  const inverted = new Uint8Array(w * h);
  for (const c of filledRegions(deep, w, h, k)) {
    // セルの中を反転し、地（反転して明るい灰色）を白にする
    for (let y = c.y0; y < c.y1; y++)
      for (let x = c.x0; x < c.x1; x++) {
        const o = y * stride + x * 3;
        const inv = 255 - (0.299 * rgb[o] + 0.587 * rgb[o + 1] + 0.114 * rgb[o + 2]);
        g[y * w + x] = Math.min(255, Math.round((inv * 255) / CELL_PAPER));
        inverted[y * w + x] = 1;
      }
  }
  return inverted;
}

/**
 * 色の付いた文字（赤字の「▲27」、オレンジの表の数字など）は、色の濃さに応じて黒っぽくする。明るめの赤やオレンジは、
 * 明るさだけ見ると薄い色の地と同じく白になり、線が途切れて読めなくなるため。色で塗りつぶしたセルの地には当てない
 */
function darkenColorInk(
  g: Uint8Array,
  ink: Uint8Array,
  warm: Uint8Array,
  warmFill: Uint8Array,
  black: Uint8Array,
  rgb: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  stride: number,
  k: number,
) {
  for (const c of filledRegions(ink, w, h, k))
    for (let y = c.y0; y < c.y1; y++) ink.fill(0, y * w + c.x0, y * w + c.x1);
  // 文字の線より太いもの（蛍光ペンの線など）は文字ではない：太さ size 画素の正方形が収まる所を除く
  const size = Math.max(5, Math.round(INK_THICK * k));
  const thick = opening(ink, w, h, size);
  // オレンジのセルの中と縁、黒い罫線や文字のすぐ脇の茶色（オレンジと黒の境目のにじみ）は、オレンジの文字ではない
  const near = Math.max(1, Math.round(3 * k));
  const nearBlack = dilate(black, w, h, near);
  // 蛍光ペンの線の縁も文字ではない
  const nearThick = dilate(thick, w, h, near);
  for (let i = 0; i < w * h; i++) if (nearThick[i] || (warm[i] && nearBlack[i])) ink[i] = 0;
  // オレンジのセルの中と縁：まわりの四角の4割以上がオレンジの所（セルの中の文字の周りも含む。オレンジの文字は線が細いので当たらない）
  const r = Math.max(2, Math.round(CELL_WINDOW * k));
  const share = boxCount(warmFill, w, h, r);
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = share[i] >= CELL_SHARE * (2 * r + 1) ** 2 ? 1 : 0;
  const cells = dilate(filled, w, h, near * 2);
  for (let i = 0; i < w * h; i++) if (cells[i]) ink[i] = 0;
  // 赤・オレンジの文字のすぐ隣の、色の薄い所も同じ文字の線（スキャンの色むらで、線がまだらにしか拾えないため）
  const warmInk = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let o = y * stride;
    for (let x = 0, i = y * w; x < w; x++, i++, o += 3) {
      if (!ink[i]) continue;
      const hi = Math.max(rgb[o], rgb[o + 1], rgb[o + 2]);
      warmInk[i] = redToYellow(rgb[o], rgb[o + 1], rgb[o + 2], hi, hi - Math.min(rgb[o], rgb[o + 1], rgb[o + 2]))
        ? 1
        : 0;
    }
  }
  const besideWarm = dilate(warmInk, w, h, Math.max(1, Math.round(2 * k)));
  for (let y = 0; y < h; y++) {
    let o = y * stride;
    for (let x = 0, i = y * w; x < w; x++, i++, o += 3) {
      if (!ink[i] && !besideWarm[i]) continue;
      const r = rgb[o];
      const gr = rgb[o + 1];
      const b = rgb[o + 2];
      const hi = Math.max(r, gr, b);
      const sat = hi - Math.min(r, gr, b);
      const lum = 0.299 * r + 0.587 * gr + 0.114 * b;
      let v = 255;
      if (ink[i]) {
        // オレンジの文字は明るめで色も薄いことが多いので、白からの暗さでも黒くする（濃い方を使う）
        v = 255 - sat * INK_GAIN;
        if (warm[i]) v = Math.min(v, 255 - (255 - lum) * INK_GAIN);
      } else if (
        !nearBlack[i] &&
        !nearThick[i] &&
        !cells[i] &&
        sat >= FAINT_INK_SAT &&
        lum < FAINT_INK_LUM &&
        redToYellow(r, gr, b, hi, sat)
      )
        v = 255 - (255 - lum) * INK_GAIN;
      g[i] = Math.min(g[i], Math.max(0, v));
    }
  }
}

/** 各画素を中心とする (2r+1) 画素四方の正方形の中の、印の付いた画素の数 */
function boxCount(mask: Uint8Array, w: number, h: number, r: number): Uint16Array {
  const row = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const o = y * w;
    for (let x = 0; x < Math.min(w, r); x++) count += mask[o + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) count += mask[o + x + r];
      if (x - r - 1 >= 0) count -= mask[o + x - r - 1];
      row[o + x] = count;
    }
  }
  const out = new Uint16Array(w * h);
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(h, r); y++) count += row[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) count += row[(y + r) * w + x];
      if (y - r - 1 >= 0) count -= row[(y - r - 1) * w + x];
      out[y * w + x] = count;
    }
  }
  return out;
}

/** 1方向に、前後 r 画素がすべて印なら印（収縮）／前後 r 画素に1つでも印があれば印（膨張） */
function boxPass(src: Uint8Array, w: number, h: number, r: number, horizontal: boolean, erode: boolean): Uint8Array {
  const dst = new Uint8Array(w * h);
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const idx = (a: number, b: number) => (horizontal ? a * w + b : b * w + a);
  for (let a = 0; a < lines; a++) {
    let count = 0;
    for (let b = 0; b < Math.min(len, r); b++) count += src[idx(a, b)];
    for (let b = 0; b < len; b++) {
      if (b + r < len) count += src[idx(a, b + r)];
      if (b - r - 1 >= 0) count -= src[idx(a, b - r - 1)];
      const span = Math.min(len - 1, b + r) - Math.max(0, b - r) + 1;
      dst[idx(a, b)] = erode ? (count === span ? 1 : 0) : count > 0 ? 1 : 0;
    }
  }
  return dst;
}

/** 印の付いた画素から r 画素以内（正方形）に印を広げる */
function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return boxPass(boxPass(mask, w, h, r, true, false), w, h, r, false, false);
}

/** 印の付いた画素のうち、size 画素四方の正方形がすっぽり収まる所（太い線や塗った所）だけを残す（収縮して膨張） */
function opening(mask: Uint8Array, w: number, h: number, size: number): Uint8Array {
  const r = size >> 1;
  return dilate(boxPass(boxPass(mask, w, h, r, true, true), w, h, r, false, true), w, h, r);
}

/**
 * 印の付いた画素で塗りつぶした四角い範囲（色で塗ったセルなど）を探す。
 * 小さな四角（block 画素四方）ごとに半分以上が印かを見て、つながったまとまりのうち、大きくて外枠をほぼ埋めているものを返す
 */
function filledRegions(
  mask: Uint8Array,
  w: number,
  h: number,
  k: number,
): { x0: number; y0: number; x1: number; y1: number }[] {
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
          n += mask[y * w + x];
          all++;
        }
      if (n * 2 >= all) cell[by * gw + bx] = 1;
    }
  const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
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
    out.push({
      x0: x0 * block,
      y0: y0 * block,
      x1: Math.min(w, (x1 + 1) * block),
      y1: Math.min(h, (y1 + 1) * block),
    });
  }
  return out;
}

/**
 * 罫線を白く消す。左右（横線なら上下）の off 画素先が明るい細い暗い画素が、途切れ gap 画素以下で minLen 画素以上続けば罫線とみなす。
 * 文字の画は文字の高さより長くならないので残る。塗りつぶした帯（濃い見出しなど）は「細い」に当たらないので残る
 */
function removeRules(g: Uint8Array, w: number, h: number, minLen: number, off: number, gap: number) {
  const src = new Uint8Array(g.length);
  // 画像の外は明るいとみなす
  const dark = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && src[y * w + x] < RULE_DARK;
  // 縦線（a が列、b が行）と横線（a が行、b が列）を同じ手順で調べる。横線は縦線を消した後の画像で調べ、
  // 縦線と横線の交わる所も消す（交わる所が小さな点や十字で残ると、隣の数字とつながって読み違える）
  for (const vertical of [true, false]) {
    src.set(g);
    const lines = vertical ? w : h;
    const len = vertical ? h : w;
    const at = (a: number, b: number) => (vertical ? [a, b] : [b, a]) as [number, number];
    // 線に直交する向きに d 画素ずらした位置が暗いか
    const darkAcross = (a: number, b: number, d: number) => (vertical ? dark(a + d, b) : dark(b, a + d));
    const thin = (a: number, b: number) => darkAcross(a, b, 0) && !darkAcross(a, b, -off) && !darkAcross(a, b, off);
    // 線に直交する向きに、暗い画素が何画素続くか
    const run = (a: number, b: number, dir: number) => {
      let n = 0;
      while (n < off && darkAcross(a, b, dir * (n + 1))) n++;
      return n;
    };
    // 線の太さの分だけ消す。太さは線だけの所（両側が明るい所）で測り、文字が接している所も同じ太さだけ消す
    // （線に接した数字の上端・下端を削らず、線も残さない）。線を横切る文字の画（線の両側が暗い）は残す
    const erase = (a: number, from: number, to: number) => {
      const ups: number[] = [];
      const downs: number[] = [];
      for (let b = from; b <= to; b++) {
        if (!thin(a, b)) continue;
        ups.push(run(a, b, -1));
        downs.push(run(a, b, 1));
      }
      const mid = (v: number[]) => v.sort((p, q) => p - q)[v.length >> 1] ?? 0;
      const up = mid(ups);
      const down = mid(downs);
      for (let b = from; b <= to; b++) {
        if (darkAcross(a, b, -up - 2) && darkAcross(a, b, down + 2)) continue;
        for (let d = -up; d <= down; d++) {
          if (!darkAcross(a, b, d)) continue;
          const [x, y] = at(a + d, b);
          g[y * w + x] = 255;
        }
      }
    };
    // 線が途切れずに続いているか（文字が接して「細い」に当たらない所も、線そのものは暗いまま続く）
    const continuous = (a: number, from: number, to: number) => {
      for (let b = from; b <= to; b++) if (!darkAcross(a, b, 0)) return false;
      return true;
    };
    for (let a = 0; a < lines; a++) {
      let start = -1;
      let last = -1;
      for (let b = 0; b < len; b++) {
        if (!thin(a, b)) continue;
        // 行の詰まった表では、数字の下端が線に接して、その所だけ「細い」に当たらない。線が続いていれば一本の線として消す
        if (start < 0 || (b - last > gap + 1 && !continuous(a, last + 1, b - 1))) {
          if (start >= 0 && last - start + 1 >= minLen) erase(a, start, last);
          start = b;
        }
        last = b;
      }
      if (start >= 0 && last - start + 1 >= minLen) erase(a, start, last);
    }
  }
}

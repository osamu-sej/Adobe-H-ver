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
  /** 文字の位置をインクに合わせた（文字ごとの上下の範囲も使える） */
  snapped?: boolean;
  /** 1文字に1つずつインクが対応した（認識の自信が低くても本物の文字とみなせる） */
  inkMatched?: boolean;
}

export interface OcrLine {
  words: OcrWord[];
}

/**
 * 文字認識（Tesseract）の設定。白黒に分けるしきい値を、ページ全体ではなく場所ごとに決める（Sauvola）。
 * 色の付いたセルや濃い見出しが混じった表でも、文字を背景から分けやすい
 */
export const OCR_PARAMS = { thresholding_method: "2" };

/** 画像の画素 → 元ページ空間（pt）の変換行列 [a, b, c, d, e, f] */
export type Matrix6 = [number, number, number, number, number, number];

/**
 * これより自信のない単語は、写真の模様などの読み違いとして捨てる。
 * ただし数字が3つ以上ある単語と、1文字ずつインクが対応した単語（「1.3」など）は、
 * 自信が低くても残す（隠し漏れのほうが困るため）
 */
const MIN_WORD_CONFIDENCE = 30;
const KEEP_DIGITS = 3;
/** 単語の間の隙間が文字の高さに対してこれより広ければ、別のかたまり（表の別のセルなど）とみなす */
const CHUNK_GAP = 0.8;
/** 数字と数字の間がこれより広ければ（単語の中でも）、別のセルの数字とみなす。1つの数字の中の隙間はずっと狭い */
const NUMBER_CELL_GAP = 0.45;
/** 単語の中でも、これより広い隙間があれば別のかたまりにする（セル同士が1語に読まれたとき） */
const CHUNK_GAP_IN_WORD = 1.2;
/** 単語の間の隙間がこれより広ければ空白を入れる。単語の中には入れない（「1」は細いので隙間が広く見える） */
const SPACE_GAP = 0.25;
const NUMBER_SPACE_GAP = 0.6;
/** 文字の高さに対する上下の余白（数字のインクは、文字の枠の高さの7割ほど。PDFの文字の枠と同じくらいに隠す） */
const INK_PAD = 0.2;
/** 数字のかたまりの両端に足す余白（端の数字の一部を読み落としても隠れるように） */
const RUN_PAD = 0.2;

/** 数字の隣にあるときは「1」の読み違いとみなす文字 */
const LIKE_ONE = new Set(["l", "I", "|", "!", "]", "[", "i", "j", "¦", "ｌ", "Ｉ", "｜", "丨"]);
/** 数字の隣にあるときは「0」の読み違いとみなす文字 */
const LIKE_ZERO = new Set(["O", "o", "〇", "○", "Ｏ", "ｏ"]);
/** 数字の高さのこの倍より高い縦棒は、表の枠線とみなす（「1」に直さず捨てる） */
const TALL_BAR = 1.4;
/** 数字の線の太さのこの割合より細い（薄い）縦棒も、表の枠線とみなす */
const THIN_BAR = 0.6;
/** 「%」1文字の幅の上限（文字の高さに対して）。これより広ければ、数字と「%」がくっついたもの */
const PERCENT_W = 1.6;
/** 「7」の上の横棒は字の幅のこの割合より広い。これより狭ければ斜めのひと筆の「/」 */
const SLASH_TOP = 0.6;
/** 塗りつぶした三角：行ごとのインクの詰まり具合の下限と、下の幅が上の幅の何倍以上か */
const TRIANGLE_SOLID = 0.85;
const TRIANGLE_WIDEN = 2.5;
/** 読めなかった小数点の空き：数字の中心の間隔が、行の中のふつうの間隔のこの範囲の倍。間隔を測るには数字の組がこれだけ要る */
const GAP_DOT_MIN = 1.3;
const GAP_DOT_MAX = 2.2;
const MIN_DOT_STEPS = 4;
/** 数字に挟まれているときは「-」の読み違いとみなす文字（漢数字の「一」など） */
const LIKE_DASH = new Set(["一", "ー", "—", "–", "―", "－", "‐", "~", "〜", "_"]);

interface Glyph {
  text: string;
  conf: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** 単語の文字の大きさ（隙間の判定に使う） */
  em: number;
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

// ---- 文字の位置をインクに合わせる ----

/** 認識に使ったグレースケール画像（1画素1バイト、黒いほど小さい） */
export interface GrayImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

// 文字の左右をインクに合わせるときの重み（文字の高さを1とした位置のずれと比べる）

/** 文字にインクを1つも割り当てない（飛ばす）ときの重み。大きくして、1文字1まとまりの対応を優先する */
const SKIP_COST = 2.5;
/** 縦棒（「|」など）にインクを割り当てないときの重み */
const BAR_SKIP_COST = 0.5;
/** 位置のずれそのものの重み（ずれ方が隣の文字と変わるときの重みを1として） */
const SHIFT_COST = 0.3;
/** 数字に2つ目以上のまとまりを割り当てるときの重み（読み落とした細い「1」などは含められる程度） */
const EXTRA_COST = 0.5;
/** 数字に漢字ほどの幅のまとまりを割り当てるときの重み */
const WIDE_COST = 1.5;
/** 漢字に数字ほどの幅しか割り当てないときの重み */
const NARROW_COST = 1.0;
/** 1文字に割り当てるまとまりの数の上限（漢字は左右に分かれていることがある） */
const MAX_BLOBS = 6;

/** 大津の方法で、文字と背景を分けるしきい値を決める */
function otsu(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** しきい値より暗い画素が半分を超える（濃い地に明るい文字）。白い地の文字のインクは、太字でも半分に満たない */
function inverted(hist: Uint32Array, t: number, total: number): boolean {
  let n = 0;
  for (let i = 0; i <= t; i++) n += hist[i];
  return n > total / 2;
}

interface Segment {
  x0: number;
  x1: number;
}

/** 単語の範囲にある文字のインク（縦に見て黒い画素のある列のまとまり）を左から順に取り出す。rules には表の縦の罫線の位置を入れる */
function inkSegments(
  img: GrayImage,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  rules?: number[],
): Segment[] | null {
  const { data, width: W, height: H } = img;
  x0 = Math.max(0, Math.floor(x0));
  x1 = Math.min(W, Math.ceil(x1));
  y0 = Math.max(0, Math.floor(y0));
  y1 = Math.min(H, Math.ceil(y1));
  const h = y1 - y0;
  if (x1 - x0 < 2 || h < 4) return null;
  const hist = new Uint32Array(256);
  let lo = 255;
  let hi = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const v = data[y * W + x];
      hist[v]++;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  if (hi - lo < 60) return null; // 文字と背景の差がない（読み取れない）
  const total = (x1 - x0) * h;
  const t = otsu(hist, total);
  // 濃い地に白い文字（表の見出しなど）は、明るいほうを文字のインクとみなす
  const light = inverted(hist, t, total);
  const dark = (x: number, y: number) => y >= 0 && y < H && data[y * W + x] <= t !== light;
  // 列ごとの黒い画素の数。表の罫線（単語の上下に大きくはみ出して続く縦線）は文字ではないので数えない。
  // 漢字の縦棒は数字より少し長いだけなので罫線とはみなさない
  const minInk = Math.max(1, h * 0.03);
  const reach = Math.max(3, Math.round(h * 0.25));
  const count = new Array<number>(x1 - x0).fill(0);
  for (let x = x0; x < x1; x++) {
    let n = 0;
    for (let y = y0; y < y1; y++) if (dark(x, y)) n++;
    const rule = n >= h * 0.9 && dark(x, y0 - reach) && dark(x, y1 - 1 + reach);
    count[x - x0] = rule ? 0 : n;
    if (rule) rules?.push(x);
  }
  const ink = (x: number) => x < x1 && count[x - x0] >= minInk;
  const segs: Segment[] = [];
  let start = -1;
  let mass = 0;
  for (let x = x0; x <= x1; x++) {
    if (ink(x)) {
      if (start < 0) start = x;
      mass += count[x - x0];
    } else if (start >= 0) {
      // 小さな点（汚れ）は捨てる
      if (mass >= h * 0.15) segs.push({ x0: start, x1: x });
      start = -1;
      mass = 0;
    }
  }
  return segs;
}

/** 単語の間がこれ（文字の高さに対して）より狭ければ、まとめてインクに合わせる */
const GROUP_GAP = 1.0;

/**
 * 文字の左右の位置をインクに合わせる。
 * Tesseract（LSTM）の1文字ごとの位置はおおよそで、半文字ほど、ときには単語の枠ごと1文字ずれることがある。
 * 隣り合う単語のインクのまとまりを、左から順番を保ったまま近い文字に割り当て（動的計画法）、
 * 割り当てたインクの範囲を文字の左右とする。読み落とした文字のインクも隣の文字に含まれる
 */
export function snapToInk(lines: OcrLine[], img: GrayImage): OcrLine[] {
  return lines.map((l) => {
    const words = l.words.slice();
    // 自信のない、数字のない単語（記号や絵を読み違えたもの。あとで捨てる）は、隣の数字のインクを取らないよう合わせない
    const junk = (w: OcrWord) =>
      w.confidence < MIN_WORD_CONFIDENCE && !w.symbols.some((s) => digit(s.text.normalize("NFKC")));
    const order = words
      .map((_, i) => i)
      .filter((i) => !junk(words[i]))
      .sort((a, b) => words[a].bbox.x0 - words[b].bbox.x0);
    let group: number[] = [];
    const flush = () => {
      if (!group.length) return;
      const others = order.filter((i) => !group.includes(i)).map((i) => l.words[i].bbox);
      const members = group.map((i) => l.words[i]);
      snapGroup(members, img, others).forEach((w, k) => (words[group[k]] = w));
      group = [];
    };
    for (const i of order) {
      const w = l.words[i];
      const prev = group.length ? l.words[group[group.length - 1]] : null;
      if (prev && !adjacent(prev, w, img)) flush();
      group.push(i);
    }
    flush();
    return { words };
  });
}

/** 縦棒1つだけの単語（表の罫線を読み違えたことが多い） */
const isBar = (w: OcrWord) => {
  const t = w.symbols.map((s) => s.text.trim()).join("");
  return t.length === 1 && LIKE_ONE.has(t);
};

/** 間が狭く、同じ高さにあり、表の罫線で区切られていない単語（同じセルの中の単語など） */
function adjacent(p: OcrWord, q: OcrWord, img: GrayImage): boolean {
  const a = p.bbox;
  const b = q.bbox;
  const h = Math.min(a.y1 - a.y0, b.y1 - b.y0);
  const y0 = Math.max(a.y0, b.y0);
  const y1 = Math.min(a.y1, b.y1);
  if (b.x0 - a.x1 > h * GROUP_GAP || y1 - y0 < h * 0.5 || isBar(p) || isBar(q)) return false;
  const xa = Math.min(a.x1, b.x0) - h * 0.25;
  const xb = Math.max(a.x1, b.x0) + h * 0.25;
  const rules: number[] = [];
  inkSegments(img, xa - h, xb + h, y0, y1, rules);
  return !rules.some((x) => x >= xa && x <= xb);
}

const median = (xs: number[]) => {
  const v = xs.slice().sort((p, q) => p - q);
  const k = v.length >> 1;
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
};

function snapGroup(words: OcrWord[], img: GrayImage, others: OcrBox[]): OcrWord[] {
  // 単語の上下の範囲は、2行にまたがっていることがあるので、まとめた単語の中ほどの値を使う
  const y0 = median(words.map((w) => w.bbox.y0));
  const y1 = median(words.map((w) => w.bbox.y1));
  if (y1 - y0 < 4) return words;
  const x0 = Math.min(...words.map((w) => w.bbox.x0));
  const x1 = Math.max(...words.map((w) => w.bbox.x1));
  // 文字の高さはインクから測る（1文字だけの単語の枠は上下に余白を含んで高いことがある）
  const rows = inkRows(img, x0, x1, y0, y1);
  const h = rows && rows.y1 - rows.y0 >= 4 ? rows.y1 - rows.y0 : y1 - y0;
  // 幅のない記号（「2」に重なった「」」など）は読み違いのかけら。割り当てに使わず、そのままにする。
  // 数字は幅がなくても、読めた数字の分のインクがあるはずなので使う。
  // 文字は読んだ順のまま（認識の枠は重なり合っていることがあり、左端で並べ直すと「234」が「324」になる）
  const order = words.flatMap((w, wi) =>
    w.symbols
      .map((s, si) => ({ s, wi, si }))
      .filter(({ s }) => s.text.trim() && (s.bbox.x1 - s.bbox.x0 >= h * 0.06 || digit(s.text.normalize("NFKC")))),
  );
  if (!order.length) return words;
  // 罫線のかけらなど、細すぎるインクは文字ではない。
  // インクは文字の行の高さの範囲だけで見る（単語の枠が、点線の枠の消え残りの点などまで上下に広がっていることがある）
  const by0 = rows && rows.y1 - rows.y0 >= 4 ? Math.max(y0, rows.y0 - h * 0.1) : y0;
  const by1 = rows && rows.y1 - rows.y0 >= 4 ? Math.min(y1, rows.y1 + h * 0.1) : y1;
  const ruleXs: number[] = [];
  const all = (inkSegments(img, x0 - h * 1.2, x1 + h * 1.2, by0, by1, ruleXs) ?? []).filter(
    (g) => g.x1 - g.x0 >= h * 0.06,
  );
  const core = all
    .map((g, i) => (words.some((w) => g.x1 > w.bbox.x0 && g.x0 < w.bbox.x1) ? i : -1))
    .filter((i) => i >= 0);
  if (!core.length) return words;
  // 単語の枠が文字の途中で終わっていることがあるので、枠の外でも続いているインク（間が狭く、
  // ほかの単語のものではなく、数字の単語なら数字くらいの幅のもの）は含める
  const isDigitSym = order.map(({ s }) => digit(s.text.normalize("NFKC")));
  const hasDigit = isDigitSym.some(Boolean);
  const typicalW = median(core.map((i) => all[i].x1 - all[i].x0));
  const free = (g: Segment) =>
    (!hasDigit || g.x1 - g.x0 <= typicalW * 1.3) &&
    !others.some((o) => o.x0 < g.x1 && o.x1 > g.x0 && o.y0 < y1 && o.y1 > y0);
  const near = h * 0.35;
  let first = core[0];
  let last = core[core.length - 1];
  while (first > 0 && all[first].x0 - all[first - 1].x1 <= near && free(all[first - 1])) first--;
  while (last < all.length - 1 && all[last + 1].x0 - all[last].x1 <= near && free(all[last + 1])) last++;
  const segs = all.slice(first, last + 1);
  const n = segs.length;
  const m = order.length;
  const segC = segs.map((g) => (g.x0 + g.x1) / 2);
  const symC = order.map(({ s }) => (s.bbox.x0 + s.bbox.x1) / 2);
  const cost = (i: number, j: number) => Math.abs(segC[i] - symC[j]) / h;
  // 数字の幅の目安：数字の近くにあるインクの幅（点やカンマほどの小さなまとまりは数えない）
  const nearest = (i: number) =>
    symC.reduce((b, c, j) => (Math.abs(c - segC[i]) < Math.abs(symC[b] - segC[i]) ? j : b), 0);
  const guess = segs.filter((g, i) => isDigitSym[nearest(i)] && g.x1 - g.x0 >= h * 0.25).map((g) => g.x1 - g.x0);
  const wideW = (guess.length ? median(guess) : h * 0.6) * 1.4;
  const ideograph = order.map(({ s }) => /^[\u3400-\u9fff]$/.test(s.text));
  const single = order.map(({ s }) => /^[,.\-:/()（）・、。]$/.test(s.text.normalize("NFKC")));
  const dot = order.map(({ s }) => /^[,.:・、。]$/.test(s.text.normalize("NFKC")));
  // 縦棒（「|」「l」など）は細いひと筆。表の罫線を読み違えたことが多く、罫線はインクから除いてあるので、インクがなくてもよい
  const bar = order.map(({ s }) => LIKE_ONE.has(s.text));
  const skipCost = (j: number) => (bar[j] ? BAR_SKIP_COST : SKIP_COST);
  // 文字 j にまとまり a〜b-1 を割り当てるときの、字形の合わなさ
  const shape = (j: number, a: number, b: number, widest: number) => {
    let c = 0;
    // 句読点・記号はひと筆（ずれて「-」が「-5」に広がっていても正しく直す）
    if ((single[j] || bar[j]) && b - a > 1) c += SKIP_COST;
    // 点やカンマは小さい（ずれて隣の数字を取らないように）
    if ((dot[j] || bar[j]) && segs[b - 1].x1 - segs[a].x0 > h * 0.35) c += WIDE_COST;
    if (isDigitSym[j]) {
      // 数字は1つのまとまりで、漢字ほどの幅はない（単語の枠ごとずれて、数字が隣の「年」を取らないように）
      c += EXTRA_COST * (b - a - 1);
      if (widest > wideW) c += WIDE_COST;
    } else {
      if (ideograph[j] && segs[b - 1].x1 - segs[a].x0 < h * 0.55) c += NARROW_COST; // 漢字の幅に足りない
      // 数字の隣の端にある数字ほどの幅のまとまりは、数字に回す（「10月」を「1月」と読んだときの「0」などが、
      // 隣の漢字に含まれて隠れ残らないように。漢字の一部を隠しすぎるほうがよい）
      const digitLike = (g: Segment) => g.x1 - g.x0 <= wideW;
      if (b - a > 1 && isDigitSym[j + 1] && digitLike(segs[b - 1])) c += EXTRA_COST * 2;
      if (b - a > 1 && isDigitSym[j - 1] && digitLike(segs[a])) c += EXTRA_COST * 2;
    }
    return c;
  };
  // 認識の位置からの、割り当てたインクのずれ（文字の高さに対して）。数字の認識の枠がインクより広いとき
  // （「2005年」の「5」の枠が「年」の先まで広がっているなど）は、枠の中に収まればずれなしとみなす。
  // 漢字などは、広い枠のまま隣の数字のインクを取らないよう、中心からのずれで見る
  const shift = (j: number, a: number, b: number) => {
    const half = (segs[b - 1].x1 - segs[a].x0) / 2;
    const c = segs[a].x0 + half;
    const lo = order[j].s.bbox.x0 + half;
    const hi = order[j].s.bbox.x1 - half;
    return (c - (isDigitSym[j] && lo <= hi ? Math.min(Math.max(c, lo), hi) : symC[j])) / h;
  };
  // 動的計画法で、文字ごとに左から順に、続いたまとまり（1〜MAX_BLOBS個）を割り当てるか飛ばす。
  // 位置のずれそのものより、ずれ方が隣の文字と変わることを重く見る（単語の枠ごとずれていても、まとめてずらして合わせられる）。
  // 状態 (j, i, l)：j 文字目まで、i 個目のまとまりまで割り当て済みで、直前の文字が l 個のまとまりを取った（0 は飛ばした）
  const L = MAX_BLOBS + 1;
  const at = (j: number, i: number, l: number) => (j * (n + 1) + i) * L + l;
  const size = (m + 1) * (n + 1) * L;
  const best = new Float64Array(size).fill(Infinity);
  const prevShift = new Float64Array(size); // 直前に割り当てた文字のずれ
  const from = new Int32Array(size).fill(-1);
  best[at(0, 0, 0)] = 0;
  const relax = (to: number, c: number, d: number, prev: number) => {
    if (c < best[to]) {
      best[to] = c;
      prevShift[to] = d;
      from[to] = prev;
    }
  };
  for (let j = 0; j < m; j++)
    for (let i = 0; i <= n; i++)
      for (let l = 0; l < L; l++) {
        const cur = at(j, i, l);
        const c = best[cur];
        if (c === Infinity) continue;
        relax(at(j + 1, i, 0), c + skipCost(j), prevShift[cur], cur);
        let widest = 0;
        for (let b = i + 1; b <= Math.min(n, i + MAX_BLOBS); b++) {
          widest = Math.max(widest, segs[b - 1].x1 - segs[b - 1].x0);
          const d = shift(j, i, b);
          relax(
            at(j + 1, b, b - i),
            c + SHIFT_COST * Math.abs(d) + Math.abs(d - prevShift[cur]) + shape(j, i, b, widest),
            d,
            cur,
          );
        }
      }
  let end = -1;
  for (let l = 0; l < L; l++) if (end < 0 || best[at(m, n, l)] < best[end]) end = at(m, n, l);
  if (best[end] === Infinity) return words; // 割り当てきれない（インクのまとまりが多すぎる）
  const assigned: number[][] = order.map(() => []);
  for (let cur = end, j = m; j > 0; j--) {
    const l = cur % L;
    const i = Math.floor(cur / L) % (n + 1);
    for (let k = i - l; k < i; k++) assigned[j - 1].push(k);
    cur = from[cur];
  }
  // 数字は1つのまとまり。数字に余分に付いた幅の広いまとまり（認識されなかった「円」など）は数字に含めない。
  // 数字と同じくらいの幅なら、読み落とした数字かもしれないので含める
  // 数字の幅の目安は、まとまりが1つだけの数字から（余分なまとまりで大きくならないように）
  const widthsOf = (one: boolean) =>
    assigned
      .flatMap((a, k) => (isDigitSym[k] && (!one || a.length === 1) ? a.map((i) => segs[i].x1 - segs[i].x0) : []))
      .filter((x) => x >= h * 0.25);
  const widths = widthsOf(true).length ? widthsOf(true) : widthsOf(false);
  const digitW = widths.length ? median(widths) : h * 0.6;
  const rename = new Map<number, string>();
  const dots = findMissedDots(
    img,
    segs,
    assigned,
    isDigitSym,
    h,
    y0,
    y1,
    rename,
    order.map((o) => o.wi),
  );
  // 同じ数字を二重に読んだ（「71」を「771」など）：インクのない数字の隣に、数字1つ分のインクを取った同じ数字があれば、余分とみなして除く。
  // くっついた2文字（幅が数字1つ分より広い）は除かない
  // 単語の数字の数だけ数字ほどの幅のインクがあれば、インクのない数字は認識の枠がずれただけ（「53466」の「46」が
  // くっついて1つのまとまりになり、最後の「6」の枠が前の「6」の枠の中に入っていたなど）なので除かない
  // 数字でない文字（「71円」の「円」など）に割り当てたインクは数えない。
  // くっついた数字の数は、幅の狭い「1」を除いた数字の幅で数える（「1」の幅で数えると、ふつうの「7」が2文字分になる）
  const otherInk = new Set(assigned.flatMap((a, j) => (isDigitSym[j] ? [] : a)));
  const wideDigits = assigned
    .flatMap((a, k) =>
      isDigitSym[k] && a.length === 1 && order[k].s.text.normalize("NFKC") !== "1"
        ? [segs[a[0]].x1 - segs[a[0]].x0]
        : [],
    )
    .filter((x) => x >= h * 0.25);
  const countW = wideDigits.length ? median(wideDigits) : digitW;
  const enoughInk = (wi: number) => {
    const b = words[wi].bbox;
    const ink = segs.filter(
      (g, i) =>
        !otherInk.has(i) &&
        g.x1 - g.x0 >= h * 0.25 &&
        (g.x0 + g.x1) / 2 >= b.x0 - h * 0.2 &&
        (g.x0 + g.x1) / 2 <= b.x1 + h * 0.2,
    );
    // くっついた数字（「466」の「46」など）は、数字の幅の何個分かで数える
    const count = ink.reduce((n, g) => n + Math.max(1, Math.round((g.x1 - g.x0) / countW)), 0);
    return count >= order.filter((o, j) => o.wi === wi && isDigitSym[j]).length;
  };
  const dropped = new Set<number>();
  for (let k = 0; k < m; k++) {
    if (!isDigitSym[k] || assigned[k].length) continue;
    const twin = [k - 1, k + 1].some((nb) => {
      if (nb < 0 || nb >= m || order[nb].wi !== order[k].wi || assigned[nb].length !== 1) return false;
      const width = segs[assigned[nb][0]].x1 - segs[assigned[nb][0]].x0;
      if (order[nb].s.text === order[k].s.text)
        return width <= Math.min(digitW * 1.3, h * 0.8) && !enoughInk(order[k].wi);
      // 「%」を「9%」と読んだとき：「%」のインクが1文字分しかなければ、数字は「%」の一部を読んだもの
      return order[nb].s.text.normalize("NFKC") === "%" && width <= h * PERCENT_W;
    });
    if (twin) dropped.add(k);
  }
  // 表の縦の罫線を「1」と読んだもの（「96.1」が「196.1」に）：インクのない「1」が罫線の位置にあれば除く。
  // 点線の罫線は罫線として見つからないので、インクのない数字の認識の枠がほとんど隣の文字の枠の中にあるもの
  // （同じインクを2文字に読んだ）も除く
  const misread = new Set<number>();
  for (let k = 0; k < m; k++) {
    const s = order[k].s;
    if (!isDigitSym[k] || assigned[k].length || dropped.has(k)) continue;
    const onRule =
      s.text.normalize("NFKC") === "1" && ruleXs.some((x) => x >= s.bbox.x0 - h * 0.15 && x <= s.bbox.x1 + h * 0.15);
    const host = enoughInk(order[k].wi)
      ? -1
      : ([k - 1, k + 1].find((nb) => {
          if (nb < 0 || nb >= m || order[nb].wi !== order[k].wi || !assigned[nb].length) return false;
          const o = order[nb].s.bbox;
          return Math.min(o.x1, s.bbox.x1) - Math.max(o.x0, s.bbox.x0) >= (s.bbox.x1 - s.bbox.x0) * 0.7;
        }) ?? -1);
    if (onRule || host >= 0) dropped.add(k);
    if (!onRule && host >= 0 && order[host].s.text !== s.text) misread.add(order[k].wi);
  }
  // 「%」を「9%」と読み、数字の方が「%」のインクを取ったとき（数字にしては幅が広い）も、数字を除いてインクを「%」に戻す
  for (let k = 0; k + 1 < m; k++) {
    const nb = k + 1;
    if (!isDigitSym[k] || assigned[k].length !== 1 || assigned[nb].length || order[nb].wi !== order[k].wi) continue;
    if (order[nb].s.text.normalize("NFKC") !== "%") continue;
    const width = segs[assigned[k][0]].x1 - segs[assigned[k][0]].x0;
    if (width <= digitW * 1.3 || width > h * PERCENT_W) continue;
    assigned[nb] = assigned[k];
    assigned[k] = [];
    dropped.add(k);
  }
  // 「%」を「96」や「9」と読んだとき（「97.2%」が「97.296」に）：小数のすぐ後ろで、数字にしては幅が広い
  // （「%」くらいの）インク1つを数字1〜2文字が取り合っていれば、それは「%」
  for (let k = 0; k < m; k++) {
    if (!isDigitSym[k] || assigned[k].length !== 1 || dropped.has(k)) continue;
    const width = segs[assigned[k][0]].x1 - segs[assigned[k][0]].x0;
    if (width <= digitW * 1.35 || width > h * PERCENT_W) continue;
    const twin = [k - 1, k + 1].find(
      (nb) =>
        nb >= 0 && nb < m && isDigitSym[nb] && !assigned[nb].length && !dropped.has(nb) && order[nb].wi === order[k].wi,
    );
    const start = twin === undefined ? k : Math.min(twin, k);
    if (start < 2 || !isDigitSym[start - 1] || order[start - 2].s.text.normalize("NFKC") !== ".") continue;
    rename.set(k, "%");
    if (twin !== undefined) dropped.add(twin);
  }
  // 増減の「▲」を「4」「人」などと読んだとき：数字の前の、塗りつぶした三角のインク1つなら「▲」
  for (let k = 0; k + 1 < m; k++) {
    if (assigned[k].length !== 1 || dropped.has(k) || rename.has(k) || !isDigitSym[k + 1]) continue;
    const t = order[k].s.text.normalize("NFKC");
    if ((isDigitSym[k] && t !== "4") || /^[,.:;・、。]$/.test(t)) continue;
    if (triangleShaped(img, segs[assigned[k][0]], by0, by1)) rename.set(k, "▲");
  }
  // 日付の「/」を「7」と読んだとき（「10/15」が「10715」に）：数字に挟まれた「7」が、上の横棒のない斜めのひと筆なら「/」
  for (let k = 1; k + 1 < m; k++) {
    if (order[k].s.text.normalize("NFKC") !== "7" || assigned[k].length !== 1 || dropped.has(k) || rename.has(k))
      continue;
    if (isDigitSym[k - 1] && isDigitSym[k + 1] && slashShaped(img, segs[assigned[k][0]], by0, by1)) rename.set(k, "/");
  }
  const ranges: (Segment | null)[] = assigned.map((a, k) => {
    if (!a.length) return null;
    let use = a.map((i) => segs[i]);
    if (isDigitSym[k] && use.length > 1) {
      const fit = use.filter((g) => g.x1 - g.x0 <= digitW * 1.5);
      use = fit.length
        ? fit
        : [
            use.reduce((p, g) =>
              Math.abs((g.x0 + g.x1) / 2 - symC[k]) < Math.abs((p.x0 + p.x1) / 2 - symC[k]) ? g : p,
            ),
          ];
    }
    return { x0: Math.min(...use.map((g) => g.x0)), x1: Math.max(...use.map((g) => g.x1)) };
  });
  // くっついた2文字（「0円」など）が1つのまとまりになり、片方にインクがないときは、認識の位置の中間で分ける
  for (let k = 0; k < m; k++) {
    if (ranges[k] || dropped.has(k)) continue;
    for (const nb of [k - 1, k + 1]) {
      const r = ranges[nb];
      if (!r || symC[k] <= r.x0 || symC[k] >= r.x1) continue;
      const cut = (symC[k] + symC[nb]) / 2;
      if (nb < k) {
        ranges[k] = { x0: cut, x1: r.x1 };
        r.x1 = cut;
      } else {
        ranges[k] = { x0: r.x0, x1: cut };
        r.x0 = cut;
      }
      break;
    }
  }
  const out = words.map((w) => ({ ...w, symbols: w.symbols.slice(), snapped: true }));
  order.forEach(({ s, wi, si }, k) => {
    const r = ranges[k];
    if (!r) return;
    // 認識の位置から大きく離れる割り当ては誤りとみなして元のまま。
    // 認識の枠の中に収まるなら、枠が広すぎた（「2005年」の「5」が「年」の先まで広がっているなど）だけなので直す
    const within = r.x0 >= s.bbox.x0 - h * 0.2 && r.x1 <= s.bbox.x1 + h * 0.2;
    if (!within && Math.abs((r.x0 + r.x1) / 2 - symC[k]) > h * 1.2) return;
    const w = words[wi].bbox;
    const v = inkRows(img, r.x0, r.x1, w.y0, w.y1);
    out[wi].symbols[si] = {
      ...s,
      text: rename.get(k) ?? s.text,
      bbox: { x0: r.x0, x1: r.x1, y0: v ? v.y0 : w.y0, y1: v ? v.y1 : w.y1 },
    };
  });
  // 二重に読んだ数字を除き、読み落とした小数点・カンマを数字の間に入れる
  if (dropped.size || dots.length) {
    const at = (k: number) => `${order[k].wi}:${order[k].si}`;
    const gone = new Set([...dropped].map(at));
    const add = new Map<string, { before: OcrSymbol[]; after: OcrSymbol[] }>();
    for (const d of dots) {
      const e = add.get(at(d.k)) ?? { before: [], after: [] };
      (d.after ? e.after : e.before).push(d.symbol);
      add.set(at(d.k), e);
    }
    out.forEach((w, wi) => {
      w.symbols = w.symbols.flatMap((s, si) => {
        const e = add.get(`${wi}:${si}`);
        return gone.has(`${wi}:${si}`) ? [] : [...(e?.before ?? []), s, ...(e?.after ?? [])];
      });
    });
  }
  // 1文字に1つずつ、近くのインクが対応したか（認識の自信が低くても、本物の文字とみなせる）
  // 1文字だけの単語は写真の模様でも偶然そろうので数えない。
  // 同じインクを違う2文字に読んだ単語（「10/15」を「10/715」など。どちらが正しいかわからない）も数えない
  return out.map((w, wi) => {
    const ks = order.map((o, k) => (o.wi === wi && !dropped.has(k) ? k : -1)).filter((k) => k >= 0);
    const inkMatched =
      ks.length >= 2 && !misread.has(wi) && ks.every((k) => assigned[k].length === 1 && cost(assigned[k][0], k) < 0.35);
    return { ...w, inkMatched };
  });
}

/**
 * インクのかすれ（マーカーの下など）で読めなかった小数点を、数字の間の空きから補う（「100.8」を「1008」と読んだとき）。
 * 表の数字は数字の幅がそろっているので、数字と数字の中心の間隔は行の中でほぼ一定になる。
 * 数字だけの単語で、1か所だけ間隔が小数点1つ分広く、その前が2桁以上・後ろが1〜2桁なら、そこに小数点があったとみなす。
 * words はインクに位置を合わせた単語（同じ行のもの）
 */
function restoreGapDots(words: Glyph[][]) {
  const isDigit = (g: Glyph) => digit(g.text.normalize("NFKC"));
  const center = (g: Glyph) => (g.x0 + g.x1) / 2;
  const steps: number[] = [];
  for (const w of words)
    for (let i = 0; i + 1 < w.length; i++)
      if (isDigit(w[i]) && isDigit(w[i + 1])) steps.push(center(w[i + 1]) - center(w[i]));
  if (steps.length < MIN_DOT_STEPS) return;
  const step = median(steps);
  for (const w of words) {
    if (w.length < 3 || !w.every(isDigit)) continue;
    const wide: number[] = [];
    for (let i = 0; i + 1 < w.length; i++) {
      const d = center(w[i + 1]) - center(w[i]);
      if (d >= step * GAP_DOT_MIN && d <= step * GAP_DOT_MAX) wide.push(i);
    }
    if (wide.length !== 1) continue;
    const i = wide[0];
    // 前は2桁以上（「▲31」の「▲」を「4」と読んだときの「431」などに入れないように）
    const after = w.length - i - 1;
    if (i + 1 < 2 || after < 1 || after > 2) continue;
    const a = w[i];
    const b = w[i + 1];
    const h = Math.max(a.y1 - a.y0, b.y1 - b.y0);
    const bottom = Math.max(a.y1, b.y1);
    w.splice(i + 1, 0, {
      text: ".",
      conf: 50,
      x0: a.x1,
      x1: Math.max(a.x1 + 1, b.x0),
      y0: bottom - h * 0.2,
      y1: bottom,
      em: a.em,
    });
  }
}

/** まとまりのインクの、行ごとの左端・右端と画素の数（インクのある行だけ、上から順に） */
function inkRowSpans(img: GrayImage, g: Segment, y0: number, y1: number): { a: number; b: number; n: number }[] | null {
  const { data, width: W, height: H } = img;
  const x0 = Math.max(0, Math.floor(g.x0));
  const x1 = Math.min(W, Math.ceil(g.x1));
  y0 = Math.max(0, Math.floor(y0));
  y1 = Math.min(H, Math.ceil(y1));
  if (x1 - x0 < 3 || y1 - y0 < 6) return null;
  const hist = new Uint32Array(256);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[data[y * W + x]]++;
  const total = (x1 - x0) * (y1 - y0);
  const t = otsu(hist, total);
  const light = inverted(hist, t, total);
  const rows: { a: number; b: number; n: number }[] = [];
  for (let y = y0; y < y1; y++) {
    let a = -1;
    let b = -1;
    let n = 0;
    for (let x = x0; x < x1; x++)
      if (data[y * W + x] <= t !== light) {
        if (a < 0) a = x;
        b = x;
        n++;
      }
    if (a >= 0) rows.push({ a, b, n });
  }
  return rows;
}

/**
 * 「7」と読んだ字が、上の横棒のない斜めのひと筆（「/」）か。
 * 字のいちばん上の方の行で、インクの左右の広がりが字の幅に比べて狭ければ「/」（「7」は上の横棒が字の幅いっぱいにある）
 */
function slashShaped(img: GrayImage, g: Segment, y0: number, y1: number): boolean {
  const rows = inkRowSpans(img, g, y0, y1);
  if (!rows || rows.length < 6) return false;
  const top = rows.slice(0, Math.max(2, Math.round(rows.length * 0.15)));
  return Math.max(...top.map((r) => r.b - r.a + 1)) < (g.x1 - g.x0) * SLASH_TOP;
}

/**
 * 塗りつぶした三角（「▲」）か。「4」「人」などと読まれやすい。
 * 行ごとにインクがすき間なく詰まっていて、上が細く下へ行くほど広い
 */
function triangleShaped(img: GrayImage, g: Segment, y0: number, y1: number): boolean {
  const rows = inkRowSpans(img, g, y0, y1);
  // 文字の高さの半分以上ある（小数点のような小さな点は除く）
  if (!rows || rows.length < Math.max(6, (y1 - y0) * 0.5)) return false;
  const span = (r: { a: number; b: number }) => r.b - r.a + 1;
  const solid = rows.reduce((n, r) => n + r.n, 0) / rows.reduce((n, r) => n + span(r), 0);
  const q = Math.max(1, Math.round(rows.length / 4));
  const top = median(rows.slice(0, q).map(span));
  const mid = span(rows[rows.length >> 1]);
  const bottom = median(rows.slice(-q).map(span));
  // 中ほども下の幅の半分ほどある（「1」は縦棒が細く、下の横棒だけが広い）
  return (
    solid >= TRIANGLE_SOLID && bottom >= top * TRIANGLE_WIDEN && mid >= bottom * 0.35 && bottom >= (g.x1 - g.x0) * 0.8
  );
}

/**
 * 読み落とした小数点・カンマ（「7.7」を「77」と読んだときの「.」など）を、インクから見つける。
 * 数字に割り当てた2つ目以降のまとまりのうち、隣の数字の側の端にある、文字の下の方の小さな点を取り出す
 * （assigned から除く）。数字の下端より下へ伸びていればカンマとする。
 * 点そのものを数字と読んだもの（「11.7」を「1117」と読んだときの3つ目の「1」）は、rename に小数点として入れる
 */
function findMissedDots(
  img: GrayImage,
  segs: Segment[],
  assigned: number[][],
  isDigitSym: boolean[],
  h: number,
  y0: number,
  y1: number,
  rename: Map<number, string>,
  wordOf: number[],
): { k: number; after: boolean; symbol: OcrSymbol }[] {
  const out: { k: number; after: boolean; symbol: OcrSymbol }[] = [];
  // 数字の下端（1つのまとまりだけを取った、数字らしい幅の数字から）
  const bottoms: number[] = [];
  assigned.forEach((a, k) => {
    if (!isDigitSym[k] || a.length !== 1 || segs[a[0]].x1 - segs[a[0]].x0 < h * 0.25) return;
    const r = inkRows(img, segs[a[0]].x0, segs[a[0]].x1, y0, y1);
    if (r) bottoms.push(r.y1);
  });
  if (!bottoms.length) return out;
  const base = median(bottoms);
  // 小さく、下の方にある点か（「1」のように縦に長いもの、「-」のように中ほどのものは除く）。点なら「.」、下へ伸びていれば「,」
  const dotAt = (g: Segment): OcrSymbol | null => {
    if (g.x1 - g.x0 > h * 0.35) return null;
    const r = inkRows(img, g.x0, g.x1, y0, y1 + h * 0.25);
    if (!r || r.y1 - r.y0 > h * 0.4 || r.y0 < base - h * 0.35 || r.y1 < base - h * 0.15) return null;
    return {
      text: r.y1 > base + h * 0.1 ? "," : ".",
      confidence: 90,
      bbox: { x0: g.x0, x1: g.x1, y0: r.y0, y1: r.y1 },
    };
  };
  for (let k = 0; k < assigned.length; k++) {
    const a = assigned[k];
    if (!isDigitSym[k]) continue;
    // 小数点の上に数字を読み、その前の数字が2文字分のインクを取ったとき（「20.7」を「207」と読み、「0」の位置が点にずれた）：
    // 前の数字の2つ目のインクをこの数字に回し、点を小数点にする
    if (a.length === 1 && k > 0 && isDigitSym[k - 1] && assigned[k - 1].length >= 2) {
      const prev = assigned[k - 1];
      const moved = segs[prev[prev.length - 1]];
      const dot = moved.x1 - moved.x0 >= h * 0.25 ? dotAt(segs[a[0]]) : null;
      if (dot) {
        assigned[k] = [prev.pop()!];
        out.push({ k, after: true, symbol: dot });
        continue;
      }
    }
    // 小数点そのものを数字と読んだとき（「11.7」を「1117」と読んだ）：同じ単語の数字に挟まれ、取ったインクが
    // 両隣の数字よりずっと低い点だけなら小数点
    const sameWord = (j: number) => j >= 0 && j < wordOf.length && wordOf[j] === wordOf[k];
    if (a.length === 1 && sameWord(k - 1) && sameWord(k + 1) && isDigitSym[k - 1] && isDigitSym[k + 1]) {
      const dot = dotAt(segs[a[0]]);
      const tall = (j: number) => {
        if (assigned[j].length !== 1) return 0;
        const r = inkRows(img, segs[assigned[j][0]].x0, segs[assigned[j][0]].x1, y0, y1);
        return r ? r.y1 - r.y0 : 0;
      };
      const dh = dot ? dot.bbox.y1 - dot.bbox.y0 : Infinity;
      if (dot && dh <= tall(k - 1) * 0.4 && dh <= tall(k + 1) * 0.4) rename.set(k, dot.text);
      continue;
    }
    if (a.length < 2) continue;
    for (const side of [-1, 1]) {
      const nb = k + side;
      if (nb < 0 || nb >= assigned.length || !isDigitSym[nb]) continue;
      const dot = dotAt(segs[side < 0 ? a[0] : a[a.length - 1]]);
      if (!dot) continue;
      a.splice(side < 0 ? 0 : a.length - 1, 1);
      out.push({ k, after: side > 0, symbol: dot });
      break;
    }
  }
  return out;
}

/**
 * 文字の線の太さ（画素）：文字の中ほどの高さの各行で、いちばん長く続く暗い画素の数の中ほどの値。
 * 薄い線は暗い画素がないので 0 になる
 */
function stemWidth(img: GrayImage, b: OcrBox): number {
  const { data, width: W, height: H } = img;
  const x0 = Math.max(0, Math.floor(b.x0) - 2);
  const x1 = Math.min(W, Math.ceil(b.x1) + 2);
  const h = b.y1 - b.y0;
  const runs: number[] = [];
  for (let y = Math.max(0, Math.floor(b.y0 + h * 0.3)); y < Math.min(H, Math.ceil(b.y1 - h * 0.3)); y++) {
    let best = 0;
    let run = 0;
    for (let x = x0; x < x1; x++) {
      run = data[y * W + x] < 128 ? run + 1 : 0;
      best = Math.max(best, run);
    }
    runs.push(best);
  }
  return runs.length ? median(runs) : 0;
}

/**
 * 文字の列の範囲で、上下のインクの範囲を求める。単語の枠が2行にまたがっていることがあるので、
 * 縦に途切れたインクのうち最も多いひとまとまりを選ぶ
 */
function inkRows(img: GrayImage, x0: number, x1: number, y0: number, y1: number): { y0: number; y1: number } | null {
  const { data, width: W, height: H } = img;
  x0 = Math.max(0, Math.floor(x0));
  x1 = Math.min(W, Math.ceil(x1));
  y0 = Math.max(0, Math.floor(y0));
  y1 = Math.min(H, Math.ceil(y1));
  if (x1 <= x0 || y1 - y0 < 4) return null;
  const hist = new Uint32Array(256);
  let lo = 255;
  let hi = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const v = data[y * W + x];
      hist[v]++;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  if (hi - lo < 60) return null;
  const t = Math.floor((lo + hi) / 2);
  const light = inverted(hist, t, (x1 - x0) * (y1 - y0));
  let best: { y0: number; y1: number; mass: number } | null = null;
  let start = -1;
  let mass = 0;
  let gap = 0;
  const maxGap = Math.max(1, Math.round((y1 - y0) * 0.08));
  for (let y = y0; y <= y1; y++) {
    let n = 0;
    if (y < y1) for (let x = x0; x < x1; x++) if (data[y * W + x] <= t !== light) n++;
    if (n > 0) {
      if (start < 0) start = y;
      mass += n;
      gap = 0;
    } else if (start >= 0 && ++gap > maxGap) {
      const end = y - gap + 1;
      if (!best || mass > best.mass) best = { y0: start, y1: end, mass };
      start = -1;
      mass = 0;
      gap = 0;
    }
  }
  if (start >= 0) {
    const end = y1 - gap;
    if (!best || mass > best.mass) best = { y0: start, y1: end, mass };
  }
  return best && best.y1 > best.y0 ? { y0: best.y0, y1: best.y1 } : null;
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
 * 数字だけの単語が、すぐ隣の数字の単語の続き（「1,234,567」が「1」と「234,567」に分かれたなど）か。
 * 1文字だけの単語は単語としての自信が低く出やすいが、文字としては読めていれば、数字の一部として残す
 */
function partOfNumber(w: OcrWord, words: OcrWord[]): boolean {
  const text = w.symbols.map((s) => s.text.normalize("NFKC")).join("");
  if (!/^[\d,.\-]+$/.test(text) || !/\d/.test(text) || Math.max(...w.symbols.map((s) => s.confidence)) < 60)
    return false;
  const h = w.bbox.y1 - w.bbox.y0;
  return words.some((o) => {
    if (o === w) return false;
    const t = o.symbols.map((s) => s.text.normalize("NFKC")).join("");
    const sameRow = Math.min(o.bbox.y1, w.bbox.y1) - Math.max(o.bbox.y0, w.bbox.y0) > h * 0.5;
    if (!sameRow) return false;
    if (o.bbox.x0 >= w.bbox.x1) return o.bbox.x0 - w.bbox.x1 <= h * 0.6 && /^[\d,.]/.test(t) && /\d/.test(t);
    if (o.bbox.x1 <= w.bbox.x0) return w.bbox.x0 - o.bbox.x1 <= h * 0.6 && /[\d,.]$/.test(t) && /\d/.test(t);
    return false;
  });
}

/**
 * 数字だけの単語（「0.0」「54」など）で、数字の1文字ずつは自信をもって読めているか。
 * 日本語のモデルは数字だけの単語に低い自信を付けやすく（「0.0」が 10 など）、単語の自信だけで捨てると表の数字が抜ける。
 * 1文字だけの数字は、罫線や汚れの読み違いのことがあるので含めない
 */
const SURE_DIGIT = 80;
function sureNumber(w: OcrWord): boolean {
  const symbols = w.symbols.filter((s) => s.text.trim() && s.text !== "_");
  const text = symbols.map((s) => s.text.normalize("NFKC")).join("");
  if (!/^[+\-−▲△]?\d[\d,.]*%?$/.test(text)) return false;
  const digits = symbols.filter((s) => digit(s.text.normalize("NFKC")));
  return digits.length >= 2 && digits.every((s) => s.confidence >= SURE_DIGIT);
}

/** 日本語の文字（漢字・かな・記号）。日本語の文の中の単語の切れ目には、ふつう空白を入れない */
const CJK = /[　-ヿ㐀-鿿＀-￯]/;

/**
 * OCRの結果を PageText にする。
 * - 隙間の広いところで別のかたまりに分け、かたまりごとに別の行番号を付ける（表のセル同士がつながらない）
 * - 文字の縦の範囲は単語の高さにそろえる（隠したときに上下が欠けない）
 * - 認識に使った画像を渡すと、文字の左右の位置をインクに合わせてから変換する
 */
export function ocrToPageText(lines: OcrLine[], toPage: Matrix6, img?: GrayImage): PageText {
  if (img) lines = snapToInk(lines, img);
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
    const snappedWords = new Set<Glyph[]>();
    // 表の枠線を読み違えた縦棒（「17.2|」の「|」など）は「1」に直さず捨てる。
    // 数字よりずっと高いもの、数字の線よりずっと細い（または薄い）ものは枠線
    const digitSyms = l.words.flatMap((w) => w.symbols.filter((s) => digit(s.text.normalize("NFKC"))));
    const digitH = digitSyms.length ? median(digitSyms.map((s) => s.bbox.y1 - s.bbox.y0)) : 0;
    const strokes = img ? digitSyms.map((s) => stemWidth(img, s.bbox)).filter((v) => v > 0) : [];
    const stroke = strokes.length ? median(strokes) : 0;
    const ruleBar = (s: OcrSymbol) => {
      if (!digitH || !LIKE_ONE.has(s.text)) return false;
      if (s.bbox.y1 - s.bbox.y0 > digitH * TALL_BAR) return true;
      if (!img) return false;
      // 認識の枠は数字の高さで切れていることがあるので、画像で縦棒の上下を確かめる
      const run = inkRows(img, s.bbox.x0 - 2, s.bbox.x1 + 2, s.bbox.y0 - digitH * 1.5, s.bbox.y1 + digitH * 1.5);
      if (run && run.y1 - run.y0 > digitH * TALL_BAR) return true;
      return stroke > 0 && stemWidth(img, s.bbox) < stroke * THIN_BAR;
    };
    for (let w of l.words) {
      const digits = w.symbols.filter((s) => /\d/.test(s.text.normalize("NFKC"))).length;
      if (
        w.confidence < MIN_WORD_CONFIDENCE &&
        digits < KEEP_DIGITS &&
        !w.inkMatched &&
        !partOfNumber(w, l.words) &&
        !sureNumber(w)
      )
        continue;
      if (w.symbols.some(ruleBar)) w = { ...w, symbols: w.symbols.filter((s) => !ruleBar(s)) };
      // 文字の大きさは単語の高さ。単語の枠が2行にまたがって高すぎるときは、文字のインクの高さから見積もる
      const wordH = Math.max(1, w.bbox.y1 - w.bbox.y0);
      const inkH = w.snapped
        ? w.symbols
            .filter((s) => /[0-9A-Za-z\u3040-\u30ff\u3400-\u9fff]/.test(s.text.normalize("NFKC")))
            .map((s) => s.bbox.y1 - s.bbox.y0)
            .sort((a, b) => a - b)
        : [];
      const em = inkH.length ? Math.min(wordH, inkH[Math.floor(inkH.length / 2)] * 1.5) : wordH;
      const glyphs: Glyph[] = [];
      for (const s of w.symbols) {
        if (!s.text.trim()) continue;
        const y = w.snapped ? s.bbox : w.bbox;
        glyphs.push({ text: s.text, conf: s.confidence, x0: s.bbox.x0, x1: s.bbox.x1, y0: y.y0, y1: y.y1, em });
      }
      // 単語の中は読んだ順のまま（インクに合わせられなかった文字の枠で並べ直すと、順番が入れ替わることがある）
      if (glyphs.length) words.push(glyphs);
      if (glyphs.length && w.snapped) snappedWords.add(glyphs);
    }
    restoreGapDots(words.filter((g) => snappedWords.has(g)));
    words.sort((a, b) => a[0].x0 - b[0].x0);
    // 行の中の文字を並べ、単語の切れ目を覚えておく
    const seq: { g: Glyph; text: string; first: boolean }[] = [];
    for (const all of words) {
      // 「_」は表の点線の枠の切れ端を読んだもの。単語の端にあるもの、離れた数字の間（隣のセルとの境目）にあるものは捨てる。
      // 数字のすぐ間にあるものは「-」の読み違いなので残す（あとで「-」に直す）
      const glyphs = all.filter((g, i) => {
        if (!/^[_＿]$/.test(g.text)) return true;
        const p = all[i - 1];
        const n = all[i + 1];
        return !!p && !!n && n.x0 - p.x1 <= g.em * NUMBER_CELL_GAP;
      });
      if (!glyphs.length) continue;
      const fixed = fixConfusables(glyphs.map((g) => g.text));
      glyphs.forEach((g, i) => seq.push({ g, text: fixed[i], first: i === 0 }));
    }
    const numeric = (t: string | undefined) => digit(t) || (!!t && /^[,.\-:/]$/.test(t));
    seq.forEach(({ g, text, first }, i) => {
      const prev = seq[i - 1];
      const next = seq[i + 1];
      const hh = Math.max(g.em, prev ? prev.g.em : 0);
      const gap = prev ? g.x0 - prev.g.x1 : Infinity;
      // 数字の中（「1,234」のカンマの後など）は、単語が分かれていても広めの隙間でなければ空白を入れない
      const inNumber = prev && ((numeric(prev.text) && digit(text)) || (digit(prev.text) && numeric(text)));
      // 日本語の文字の隣（「4月 1日」「〒 102」など）も、狭い隙間には空白を入れない（検索で見つかるように）
      const japanese = prev && (CJK.test(prev.text) || CJK.test(text));
      // 1つの単語に読まれていても、数字の間が広く空いていれば隣のセルの数字（「100.9」と「103.1」など）
      const cellGap = !first && inNumber && gap > hh * NUMBER_CELL_GAP;
      if (!prev || gap > hh * (first ? CHUNK_GAP : CHUNK_GAP_IN_WORD) || cellGap) line++;
      else if (first && gap > hh * (inNumber || japanese ? NUMBER_SPACE_GAP : SPACE_GAP))
        push(" ", prev.g.x1, Math.min(prev.g.y0, g.y0), g.x0, Math.max(prev.g.y1, g.y1), hh);
      // 数字は前後の文字との隙間まで広げる。読み落とした数字（「10%」の「1」など）も隠れるように。
      // 単語の切れ目をまたぐのは、隣も数字・区切り記号のときだけ
      let x0 = g.x0;
      let x1 = g.x1;
      if (digit(text)) {
        if (prev && gap <= hh * CHUNK_GAP_IN_WORD && (!first || numeric(prev.text))) x0 = Math.min(x0, prev.g.x1 + 1);
        const gapNext = next ? next.g.x0 - g.x1 : Infinity;
        if (next && gapNext <= hh * CHUNK_GAP_IN_WORD && (!next.first || numeric(next.text)))
          x1 = Math.max(x1, next.g.x0 - 1);
        if (!prev || !numeric(prev.text) || gap > hh * CHUNK_GAP_IN_WORD) x0 -= g.em * RUN_PAD;
        if (!next || !numeric(next.text) || gapNext > hh * CHUNK_GAP_IN_WORD) x1 += g.em * RUN_PAD;
      }
      push(text, x0, g.y0, x1, g.y1, g.em);
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

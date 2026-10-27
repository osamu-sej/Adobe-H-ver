import type { GrayImage, OcrBox, OcrLine, OcrWord } from "./ocrText";

/**
 * 文字認識の読み残しを読み直す。
 * 1回目の認識で単語にならなかったインクのまとまり（薄い灰色の文字、網掛けのセルの数字、ぽつんとある1文字の数字など）を
 * 行ごとに切り出し、薄い文字は濃くし、小さい文字は大きくして、1枚の画像に縦に並べて読み直す。
 * 読めた単語は元の画像の位置に戻す
 */

/** これより暗い画素をインクとみなす（前処理で地は白にしてある。薄い灰色の文字も拾う） */
const FILL_INK = 235;
/** 文字とみなすインクのまとまりの高さ（300dpi での画素） */
const MIN_H = 10;
const MAX_H = 90;
/** 1文字のまとまりの幅の上限（高さに対して）。これより横に長いものは線や図 */
const MAX_ASPECT = 4;
/** 同じ行の文字とみなす、まとまりの間の隙間（高さに対して） */
const JOIN_GAP = 0.8;
/** 読み直す画像での文字の高さの目安（画素）。小さい文字は拡大する */
const TARGET_H = 36;
const MAX_SCALE = 3;
/** 1枚に並べる画像の高さの上限（画素） */
const MAX_COLLAGE_H = 6000;

interface Comp extends OcrBox {
  n: number;
}

/** 読み直す行の範囲（元の画像の画素） */
export type FillBox = OcrBox;

/** 1回目の認識で確かに読めた単語の自信（これより低い単語の所は、読み違いかもしれないので読み直す） */
const SURE = 60;

/**
 * 1回目に読めたとみなす単語：確かに読めた単語と、数字を読んだ単語（数字は自信が低くても、読み直すとかえって崩れやすい）。
 * ただし自信がなく、数字と英字が混じった単語（「879nsr2m5」など、薄い文字や絵の読み違い）は読めたことにしない
 */
function wasRead(w: OcrWord): boolean {
  if (w.confidence >= SURE) return true;
  const t = w.symbols.map((s) => s.text.normalize("NFKC")).join("");
  if (!/\d/.test(t)) return false;
  return w.confidence >= 30 || !/[A-Za-z]/.test(t);
}

/** 1回目の認識で読めた所 */
function readBoxes(lines: OcrLine[]): OcrBox[] {
  const out: OcrBox[] = [];
  for (const l of lines) for (const w of l.words) if (wasRead(w)) out.push(w.bbox);
  return out;
}

/** インクのまとまり（8近傍でつながった画素）を、行ごとの連なりをつなげて求める */
function components(img: GrayImage, x0: number, y0: number, x1: number, y1: number): Comp[] {
  const { data, width: W } = img;
  const parent: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const runs: { x0: number; x1: number; y: number; id: number }[] = [];
  let prev: { x0: number; x1: number; id: number }[] = [];
  for (let y = y0; y < y1; y++) {
    const cur: { x0: number; x1: number; id: number }[] = [];
    let x = x0;
    while (x < x1) {
      while (x < x1 && data[y * W + x] >= FILL_INK) x++;
      if (x >= x1) break;
      const a = x;
      while (x < x1 && data[y * W + x] < FILL_INK) x++;
      const id = parent.length;
      parent.push(id);
      cur.push({ x0: a, x1: x, id });
      runs.push({ x0: a, x1: x, y, id });
    }
    // 上の行の連なりと重なる（斜めも含む）ものをつなぐ
    let j = 0;
    for (const r of cur) {
      while (j < prev.length && prev[j].x1 < r.x0) j++;
      for (let k = j; k < prev.length && prev[k].x0 <= r.x1; k++) {
        const a = find(r.id);
        const b = find(prev[k].id);
        if (a !== b) parent[a] = b;
      }
    }
    prev = cur;
  }
  const byRoot = new Map<number, Comp>();
  for (const r of runs) {
    const root = find(r.id);
    const c = byRoot.get(root);
    if (c) {
      c.x0 = Math.min(c.x0, r.x0);
      c.x1 = Math.max(c.x1, r.x1);
      c.y0 = Math.min(c.y0, r.y);
      c.y1 = Math.max(c.y1, r.y + 1);
      c.n += r.x1 - r.x0;
    } else byRoot.set(root, { x0: r.x0, x1: r.x1, y0: r.y, y1: r.y + 1, n: r.x1 - r.x0 });
  }
  return [...byRoot.values()];
}

/**
 * 読み残したインクのまとまりを、行ごとの範囲にまとめて返す。
 * dpi は画像の解像度（文字の大きさの目安に使う）
 */
export function unreadBoxes(img: GrayImage, lines: OcrLine[], dpi = 300): FillBox[] {
  const k = dpi / 300;
  const read = readBoxes(lines);
  const minH = MIN_H * k;
  const maxH = MAX_H * k;
  const comps = components(img, 0, 0, img.width, img.height).filter((c) => {
    const h = c.y1 - c.y0;
    const w = c.x1 - c.x0;
    if (h > maxH || w > maxH * MAX_ASPECT || w > h * MAX_ASPECT + 2 * k) return false;
    // 読めた単語の中や縁にあるものは除く
    return !read.some((b) => {
      const m = Math.min(b.y1 - b.y0, maxH) * 0.2;
      return c.x0 < b.x1 + m && c.x1 > b.x0 - m && c.y0 < b.y1 + m && c.y1 > b.y0 - m;
    });
  });
  comps.sort((a, b) => a.x0 - b.x0);
  // 同じ高さに並び、間の狭いまとまりを1行にまとめる（小数点のような小さな点も、隣の文字と同じ行に入れる）
  const parent = comps.map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (let i = 0; i < comps.length; i++) {
    const a = comps[i];
    const ha = a.y1 - a.y0;
    for (let j = i + 1; j < comps.length; j++) {
      const b = comps[j];
      const hb = b.y1 - b.y0;
      const h = Math.max(ha, hb, minH);
      if (b.x0 - a.x1 > h * JOIN_GAP) {
        if (b.x0 - a.x1 > maxH * JOIN_GAP) break;
        continue;
      }
      const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      const small = Math.min(ha, hb);
      // 縦に重なる（点や記号は、大きい方の文字の高さの中にある）
      if (overlap >= small * 0.5) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, { box: OcrBox; tall: number }>();
  comps.forEach((c, i) => {
    const r = find(i);
    const g = groups.get(r);
    const h = c.y1 - c.y0;
    if (g) {
      g.box = {
        x0: Math.min(g.box.x0, c.x0),
        y0: Math.min(g.box.y0, c.y0),
        x1: Math.max(g.box.x1, c.x1),
        y1: Math.max(g.box.y1, c.y1),
      };
      g.tall = Math.max(g.tall, h);
    } else groups.set(r, { box: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }, tall: h });
  });
  // 文字の高さのまとまりがない行（点や小さなかけらだけ）、高すぎる行は読まない
  return [...groups.values()].filter((g) => g.tall >= minH && g.box.y1 - g.box.y0 <= maxH).map((g) => g.box);
}

/** 読み直す画像の中の1行：元の画像の範囲 src と、並べた画像での位置（左上）と倍率 */
export interface FillStrip {
  src: OcrBox;
  x: number;
  y: number;
  scale: number;
}

export interface FillCollage {
  data: Uint8Array;
  width: number;
  height: number;
  strips: FillStrip[];
}

/**
 * 読み直す行を切り出して、1枚（多ければ数枚）の画像に縦に並べる。
 * 行ごとに明るさを伸ばして（薄い灰色の文字も黒く）、小さい文字は拡大する。
 * 伸ばした明るさは元の画像にも書き戻す（あとでインクに位置を合わせるため）
 */
export function buildCollages(img: GrayImage, boxes: FillBox[]): FillCollage[] {
  const { data, width: W, height: H } = img;
  type Item = { src: OcrBox; scale: number; w: number; h: number };
  const items: Item[] = [];
  for (const b of boxes) {
    const th = b.y1 - b.y0;
    const pad = Math.max(3, Math.round(th * 0.35));
    const src = {
      x0: Math.max(0, b.x0 - pad),
      y0: Math.max(0, b.y0 - pad),
      x1: Math.min(W, b.x1 + pad),
      y1: Math.min(H, b.y1 + pad),
    };
    // 行の中の明るさを伸ばす：いちばん暗い所を黒に、白に近い所を白にする
    let lo = 255;
    for (let y = src.y0; y < src.y1; y++) for (let x = src.x0; x < src.x1; x++) lo = Math.min(lo, data[y * W + x]);
    const hi = Math.max(lo + 40, 245);
    for (let y = src.y0; y < src.y1; y++)
      for (let x = src.x0; x < src.x1; x++) {
        const i = y * W + x;
        data[i] = Math.max(0, Math.min(255, Math.round(((data[i] - lo) * 255) / (hi - lo))));
      }
    const scale = Math.min(MAX_SCALE, Math.max(1, TARGET_H / Math.max(1, th)));
    items.push({ src, scale, w: Math.ceil((src.x1 - src.x0) * scale), h: Math.ceil((src.y1 - src.y0) * scale) });
  }
  const out: FillCollage[] = [];
  let cur: { strips: FillStrip[]; items: Item[]; width: number; height: number } | null = null;
  const margin = 20;
  const flush = () => {
    if (!cur || !cur.items.length) return;
    const width = cur.width + margin * 2;
    const height = cur.height + margin;
    const px = new Uint8Array(width * height).fill(255);
    cur.items.forEach((it, i) => {
      const s = cur!.strips[i];
      for (let y = 0; y < it.h; y++) {
        const sy = Math.min(it.src.y1 - 1, it.src.y0 + Math.floor(y / it.scale));
        for (let x = 0; x < it.w; x++) {
          const sx = Math.min(it.src.x1 - 1, it.src.x0 + Math.floor(x / it.scale));
          px[(s.y + y) * width + s.x + x] = data[sy * W + sx];
        }
      }
    });
    out.push({ data: px, width, height, strips: cur.strips });
    cur = null;
  };
  for (const it of items) {
    // 行の間は、文字の高さほど空ける（隣の行とつながって1行に読まれないように）
    const gap = Math.round(TARGET_H * 0.8);
    if (cur && cur.height + it.h + gap > MAX_COLLAGE_H) flush();
    if (!cur) cur = { strips: [], items: [], width: 0, height: margin };
    cur.strips.push({ src: it.src, x: margin, y: cur.height, scale: it.scale });
    cur.items.push(it);
    cur.height += it.h + gap;
    cur.width = Math.max(cur.width, it.w);
  }
  flush();
  return out;
}

/** 並べた画像で読めた行を、元の画像の位置に戻す。どの行の範囲にも入らない単語は捨てる */
export function fromCollage(lines: OcrLine[], c: FillCollage): OcrLine[] {
  const out: OcrLine[] = [];
  const back = (b: OcrBox, s: FillStrip): OcrBox => ({
    x0: s.src.x0 + (b.x0 - s.x) / s.scale,
    x1: s.src.x0 + (b.x1 - s.x) / s.scale,
    y0: s.src.y0 + (b.y0 - s.y) / s.scale,
    y1: s.src.y0 + (b.y1 - s.y) / s.scale,
  });
  for (const l of lines) {
    const byStrip = new Map<number, OcrWord[]>();
    for (const w of l.words) {
      const cy = (w.bbox.y0 + w.bbox.y1) / 2;
      const k = c.strips.findIndex((s) => cy >= s.y && cy < s.y + (s.src.y1 - s.src.y0) * s.scale);
      if (k < 0) continue;
      const s = c.strips[k];
      const moved: OcrWord = {
        confidence: w.confidence,
        bbox: back(w.bbox, s),
        symbols: w.symbols.map((sym) => ({ ...sym, bbox: back(sym.bbox, s) })),
      };
      byStrip.set(k, [...(byStrip.get(k) ?? []), moved]);
    }
    for (const words of byStrip.values()) out.push({ words });
  }
  return out;
}

/**
 * 1回目と読み直しの結果を合わせる。読み直した単語のうち、1回目に読めた単語と重なるもの（同じ文字の読み直し）は除く。
 * 1回目に読めたとみなさない単語（読み違い）は、重なる所を読み直した単語のほうが自信があれば、読み直した単語に置き換える
 */
export function mergeFill(first: OcrLine[], again: OcrLine[]): OcrLine[] {
  const overlaps = (a: OcrBox, b: OcrBox) => {
    const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const area = Math.max(1, Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)));
    return ix > 0 && iy > 0 && ix * iy > area * 0.3;
  };
  const read = readBoxes(first);
  const added = again
    .map((l) => ({ words: l.words.filter((w) => !read.some((b) => overlaps(b, w.bbox))) }))
    .filter((l) => l.words.length);
  const addedWords = added.flatMap((l) => l.words);
  const kept = first
    .map((l) => ({
      words: l.words.filter(
        (w) => wasRead(w) || !addedWords.some((n) => n.confidence > w.confidence && overlaps(n.bbox, w.bbox)),
      ),
    }))
    .filter((l) => l.words.length);
  return [...kept, ...added];
}

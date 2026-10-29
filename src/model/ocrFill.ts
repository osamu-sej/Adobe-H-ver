import type { GrayImage, OcrBox, OcrLine, OcrSymbol, OcrWord } from "./ocrText";

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
/** 横に細長くても、これより短いもの（「-」「−」などの記号）は文字に含める（300dpi での画素） */
const MAX_DASH = 30;
/** 同じ行の文字とみなす、まとまりの間の隙間（高さに対して） */
const JOIN_GAP = 0.8;
/** 読み直す画像での文字の高さの目安（画素）。小さい文字は拡大する */
const TARGET_H = 36;
const MAX_SCALE = 3;
/** 1枚に並べる画像の高さの上限（画素） */
const MAX_COLLAGE_H = 6000;

interface Comp extends OcrBox {
  /** このまとまりの画素の連なり（runs の番号） */
  runs: number[];
}

/** 読み直す1行：範囲（元の画像の画素）と、その行のインクの画素の連なり（行ごとの [y, x0, x1]） */
export interface FillGroup {
  box: OcrBox;
  runs: [number, number, number][];
  /** 隣り合う濃い文字の影響を受けず、字形ごとに濃さを調整する */
  components: [number, number, number][][];
}

/** 1回目の認識で確かに読めた単語の自信（これより低い単語の所は、読み違いかもしれないので読み直す） */
const SURE = 60;

/**
 * 1回目に読めたとみなす単語：確かに読めた単語と、1文字ずつインクが対応した数字の単語（inkMatched。snapToInk で調べる）。
 * インクを調べていなければ、数字を読んだ単語は、自信がなく数字と英字が混じったもの（「879nsr2m5」など、
 * 薄い文字や絵の読み違い）のほかは読めたとみなす
 */
function wasRead(w: OcrWord): boolean {
  if (w.confidence >= SURE) return true;
  const t = w.symbols.map((s) => s.text.normalize("NFKC")).join("");
  if (!/\d/.test(t)) return false;
  if (w.inkMatched !== undefined) return w.inkMatched;
  return w.confidence >= 30 || !/[A-Za-z]/.test(t);
}

/** 1回目の認識で読めた所 */
function readBoxes(lines: OcrLine[]): OcrBox[] {
  const out: OcrBox[] = [];
  for (const l of lines) for (const w of l.words) if (wasRead(w)) out.push(w.bbox);
  return out;
}

/** インクのまとまり（8近傍でつながった画素）を、行ごとの連なりをつなげて求める */
function components(img: GrayImage): { comps: Comp[]; runs: [number, number, number][] } {
  const { data, width: W, height: H } = img;
  const parent: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const runs: [number, number, number][] = [];
  let prev: number[] = [];
  for (let y = 0; y < H; y++) {
    const cur: number[] = [];
    let x = 0;
    while (x < W) {
      while (x < W && data[y * W + x] >= FILL_INK) x++;
      if (x >= W) break;
      const a = x;
      while (x < W && data[y * W + x] < FILL_INK) x++;
      parent.push(runs.length);
      cur.push(runs.length);
      runs.push([y, a, x]);
    }
    // 上の行の連なりと重なる（斜めも含む）ものをつなぐ
    let j = 0;
    for (const r of cur) {
      while (j < prev.length && runs[prev[j]][2] < runs[r][1]) j++;
      for (let k = j; k < prev.length && runs[prev[k]][1] <= runs[r][2]; k++) {
        const a = find(r);
        const b = find(prev[k]);
        if (a !== b) parent[a] = b;
      }
    }
    prev = cur;
  }
  const byRoot = new Map<number, Comp>();
  runs.forEach(([y, x0, x1], i) => {
    const root = find(i);
    const c = byRoot.get(root);
    if (c) {
      c.x0 = Math.min(c.x0, x0);
      c.x1 = Math.max(c.x1, x1);
      c.y0 = Math.min(c.y0, y);
      c.y1 = Math.max(c.y1, y + 1);
      c.runs.push(i);
    } else byRoot.set(root, { x0, x1, y0: y, y1: y + 1, runs: [i] });
  });
  return { comps: [...byRoot.values()], runs };
}

/**
 * 読み残しのある行を返す。インクのまとまりを行ごとにまとめ、1回目に読めた単語の外にある
 * 文字の大きさのまとまりを含む行を、その行のインク全部（読めた所も含む）で返す。
 * dpi は画像の解像度（文字の大きさの目安に使う）
 */
export function unreadGroups(img: GrayImage, lines: OcrLine[], dpi = 300): FillGroup[] {
  const k = dpi / 300;
  const read = readBoxes(lines);
  const minH = MIN_H * k;
  const maxH = MAX_H * k;
  const { comps: all, runs } = components(img);
  const comps = all.filter((c) => {
    const h = c.y1 - c.y0;
    const w = c.x1 - c.x0;
    return h <= maxH && w <= maxH * MAX_ASPECT && (w <= h * MAX_ASPECT + 2 * k || w <= MAX_DASH * k);
  });
  // 読めた単語の中や縁にあるか
  const covered = comps.map((c) =>
    read.some((b) => {
      const m = Math.min(b.y1 - b.y0, maxH) * 0.2;
      return c.x0 < b.x1 + m && c.x1 > b.x0 - m && c.y0 < b.y1 + m && c.y1 > b.y0 - m;
    }),
  );
  const order = comps.map((_, i) => i);
  order.sort((a, b) => comps[a].x0 - comps[b].x0);
  // 同じ高さに並び、間の狭いまとまりを1行にまとめる（小数点のような小さな点も、隣の文字と同じ行に入れる）。
  // まとめた行が高くなりすぎるつなぎはしない（背の高い文字を介して、上下の別の行がつながらないように）
  const parent = new Map<number, number>(order.map((i) => [i, i]));
  const span = new Map<number, [number, number]>(order.map((i) => [i, [comps[i].y0, comps[i].y1]]));
  const find = (a: number): number => {
    while (parent.get(a) !== a) a = parent.get(a)!;
    return a;
  };
  for (let p = 0; p < order.length; p++) {
    const a = comps[order[p]];
    const ha = a.y1 - a.y0;
    for (let q = p + 1; q < order.length; q++) {
      const b = comps[order[q]];
      const hb = b.y1 - b.y0;
      const h = Math.max(ha, hb, minH);
      if (b.x0 - a.x1 > h * JOIN_GAP) {
        if (b.x0 - a.x1 > maxH * JOIN_GAP) break;
        continue;
      }
      const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      // 縦に重なる（点や記号は、大きい方の文字の高さの中にある）
      if (overlap < Math.min(ha, hb) * 0.5) continue;
      const ra = find(order[p]);
      const rb = find(order[q]);
      if (ra === rb) continue;
      const [a0, a1] = span.get(ra)!;
      const [b0, b1] = span.get(rb)!;
      if (Math.max(a1, b1) - Math.min(a0, b0) > maxH) continue;
      parent.set(rb, ra);
      span.set(ra, [Math.min(a0, b0), Math.max(a1, b1)]);
    }
  }
  const groups = new Map<number, { members: number[]; box: OcrBox; seed: boolean }>();
  for (const i of order) {
    const c = comps[i];
    const r = find(i);
    const g = groups.get(r);
    const seed = !covered[i] && c.y1 - c.y0 >= minH;
    if (g) {
      g.members.push(i);
      g.box = {
        x0: Math.min(g.box.x0, c.x0),
        y0: Math.min(g.box.y0, c.y0),
        x1: Math.max(g.box.x1, c.x1),
        y1: Math.max(g.box.y1, c.y1),
      };
      g.seed ||= seed;
    } else groups.set(r, { members: [i], box: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }, seed });
  }
  // 文字の高さの読み残しがない行（読めた行、点や小さなかけらだけ）、高すぎる行は読まない
  return [...groups.values()]
    .filter((g) => g.seed && g.box.y1 - g.box.y0 <= maxH)
    .map((g) => {
      const parts = g.members.map((i) => comps[i].runs.map((r) => runs[r]));
      return { box: g.box, runs: parts.flat(), components: parts };
    });
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
 * 行のインクだけを写し（上下の行の文字の端が入らないように）、明るさを伸ばして（薄い灰色の文字も黒く）、小さい文字は拡大する。
 * 伸ばした明るさは元の画像にも書き戻す（あとでインクに位置を合わせるため）
 */
export function buildCollages(img: GrayImage, groups: FillGroup[], enhanceMixed = false): FillCollage[] {
  const { data, width: W, height: H } = img;
  type Item = { src: OcrBox; scale: number; w: number; h: number; px: Uint8Array };
  const items: Item[] = [];
  for (const gr of groups) {
    const b = gr.box;
    const th = b.y1 - b.y0;
    const padX = Math.max(3, Math.round(th * 0.35));
    const padY = Math.max(2, Math.round(th * 0.25));
    const src = {
      x0: Math.max(0, b.x0 - padX),
      y0: Math.max(0, b.y0 - padY),
      x1: Math.min(W, b.x1 + padX),
      y1: Math.min(H, b.y1 + padY),
    };
    const sw = src.x1 - src.x0;
    const sh = src.y1 - src.y0;
    // 行のインクの画素と、そのすぐ周り（文字の縁のぼかし）
    const levels = new Int16Array(sw * sh).fill(-1);
    // 通常は従来の行全体の濃さを使う。追加読みでは字形ごとに濃さを伸ばし、
    // 行に黒い文字があっても薄い数字を黒くできる。
    let rowLo = 255;
    for (const [y, x0, x1] of gr.runs) for (let x = x0; x < x1; x++) rowLo = Math.min(rowLo, data[y * W + x]);
    for (const component of gr.components) {
      let lo = rowLo;
      if (enhanceMixed) {
        lo = 255;
        for (const [y, x0, x1] of component) for (let x = x0; x < x1; x++) lo = Math.min(lo, data[y * W + x]);
      }
      for (const [y, x0, x1] of component)
        for (let y2 = Math.max(src.y0, y - 1); y2 <= Math.min(src.y1 - 1, y + 1); y2++)
          for (let x = Math.max(src.x0, x0 - 1); x < Math.min(src.x1, x1 + 1); x++) {
            const i = (y2 - src.y0) * sw + x - src.x0;
            levels[i] = Math.max(levels[i], lo);
          }
    }
    const px = new Uint8Array(sw * sh).fill(255);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        const lo = levels[y * sw + x];
        if (lo < 0) continue;
        const hi = Math.max(lo + 40, 245);
        const i = (y + src.y0) * W + x + src.x0;
        data[i] = Math.max(0, Math.min(255, Math.round(((data[i] - lo) * 255) / (hi - lo))));
        px[y * sw + x] = data[i];
      }
    const scale = Math.min(MAX_SCALE, Math.max(1, TARGET_H / Math.max(1, th)));
    items.push({ src, scale, w: Math.ceil(sw * scale), h: Math.ceil(sh * scale), px });
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
      const sw = it.src.x1 - it.src.x0;
      const sh = it.src.y1 - it.src.y0;
      for (let y = 0; y < it.h; y++) {
        const sy = Math.min(sh - 1, Math.floor(y / it.scale));
        for (let x = 0; x < it.w; x++)
          px[(s.y + y) * width + s.x + x] = it.px[sy * sw + Math.min(sw - 1, Math.floor(x / it.scale))];
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
 * 1回目と読み直しの結果を合わせる。読み直した文字のうち、1回目に読めた単語の中にあるもの（同じ文字の読み直し）は除く。
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
  // 読めた単語と重なる単語は、読めた単語の外にある文字だけを残す（行ごと読み直して「12」の続きの「3」まで
  // 「123」と読めたときに、「3」を落とさないように）。数字を含まない残り（罫線のかけらなど）は足さない
  const inRead = (s: OcrSymbol) => {
    const cx = (s.bbox.x0 + s.bbox.x1) / 2;
    const cy = (s.bbox.y0 + s.bbox.y1) / 2;
    return read.some((b) => cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1);
  };
  const outside = (w: OcrWord): OcrWord[] => {
    if (!read.some((b) => overlaps(b, w.bbox))) return [w];
    const out: OcrWord[] = [];
    let run: OcrSymbol[] = [];
    const flush = () => {
      if (run.some((s) => /\d/.test(s.text.normalize("NFKC"))))
        out.push({
          confidence: w.confidence,
          bbox: {
            x0: Math.min(...run.map((s) => s.bbox.x0)),
            y0: Math.min(...run.map((s) => s.bbox.y0)),
            x1: Math.max(...run.map((s) => s.bbox.x1)),
            y1: Math.max(...run.map((s) => s.bbox.y1)),
          },
          symbols: run,
        });
      run = [];
    };
    for (const s of w.symbols) {
      if (s.text.trim() && !inRead(s)) run.push(s);
      else flush();
    }
    flush();
    return out;
  };
  const added = again.map((l) => ({ words: l.words.flatMap(outside) })).filter((l) => l.words.length);
  const addedWords = added.flatMap((l) => l.words);
  // 置き換えるのは、読み直した単語が1回目の単語の半分以上を覆い、平均の自信が上回り、数字が減らないとき
  // （かすれた「0.5」を「5」と読み直したときなどに、数字を落とさないように）。
  // 数字が減っても、読み直した単語が1文字ずつインクと対応したなら置き換える（「10/15」を「10/715」と読んでいたときなど）
  const digits = (w: OcrWord) => w.symbols.filter((s) => /\d/.test(s.text.normalize("NFKC"))).length;
  const replaced = (w: OcrWord) => {
    const area = Math.max(1, (w.bbox.x1 - w.bbox.x0) * (w.bbox.y1 - w.bbox.y0));
    let cover = 0;
    let conf = 0;
    let count = 0;
    let found = 0;
    let matched = true;
    for (const n of addedWords) {
      const ix = Math.min(n.bbox.x1, w.bbox.x1) - Math.max(n.bbox.x0, w.bbox.x0);
      const iy = Math.min(n.bbox.y1, w.bbox.y1) - Math.max(n.bbox.y0, w.bbox.y0);
      if (ix <= 0 || iy <= 0) continue;
      cover += ix * iy;
      conf += n.confidence;
      count++;
      found += digits(n);
      matched &&= n.inkMatched === true;
    }
    return count > 0 && cover >= area * 0.5 && conf / count > w.confidence && (found >= digits(w) || matched);
  };
  // 置き換えないときは、1回目と読み直しの両方を残す。どちらが正しいかわからず、どちらも同じインクの所なので
  // （片方だけにすると、正しい方を捨てて隠し漏れや検索漏れになることがある）
  const kept = first
    .map((l) => ({ words: l.words.filter((w) => wasRead(w) || !replaced(w)) }))
    .filter((l) => l.words.length);
  return [...kept, ...added];
}

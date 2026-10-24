import { normalize, DASH_CHARS, isDigit } from "./normalize";
import type { PageText, Rect, SnapMode } from "./types";

/**
 * 文字層の処理：数字のかたまり、ドラッグ範囲への吸着、検索。
 * 座標はすべて元ページ空間（pt）。
 */

export interface TextIndex {
  text: PageText;
  /** 各文字の正規化後の文字列 */
  norm: string[];
  /** 検索用のページ全文（行ごとに改行） */
  full: string;
  /** full の各位置 → 文字番号（改行は -1） */
  map: Int32Array;
  /** 行ごとの文字範囲 [start, end) */
  lineRanges: [number, number][];
  /** 各文字の種類（CharKind）。数字モード・文字モードで隠す対象を分ける */
  kind: Uint8Array;
}

/** 文字の種類：空白／数字（数字のかたまりの区切り記号を含む）／数字の前の通貨記号／それ以外の文字 */
export const CharKind = { Space: 0, Number: 1, Currency: 2, Text: 3 } as const;

/** 数字と数字の間にあるときだけ、ひとかたまりとして扱う記号 */
const CONNECTORS = new Set([",", ".", "/", ":", "'", "・", ...DASH_CHARS]);

/** 数字の直前にあれば数字の一部とみなす通貨記号（どちらのモードでも隠さない） */
const CURRENCY = new Set(["¥", "$", "€", "£"]);

export function buildIndex(text: PageText): TextIndex {
  const n = text.chars.length;
  const norm = text.chars.map((c) => normalize(c));
  let full = "";
  const map: number[] = [];
  const lineRanges: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && text.lines[i] !== text.lines[i - 1]) {
      lineRanges.push([start, i]);
      start = i;
      full += "\n";
      map.push(-1);
    }
    const s = norm[i];
    full += s;
    for (let k = 0; k < s.length; k++) map.push(i);
  }
  if (n > 0) lineRanges.push([start, n]);
  const idx: TextIndex = { text, norm, full, map: new Int32Array(map), lineRanges, kind: new Uint8Array(n) };
  classify(idx);
  return idx;
}

function classify(idx: TextIndex) {
  const { norm, kind } = idx;
  const n = norm.length;
  for (let i = 0; i < n; i++) kind[i] = isSpace(norm[i]) ? CharKind.Space : CharKind.Text;
  for (let i = 0; i < n; i++) {
    if (kind[i] === CharKind.Number || !isDigitChar(idx, i)) continue;
    const g = numberGroupAt(idx, i);
    if (!g) continue;
    for (let k = g[0]; k < g[1]; k++) if (kind[k] !== CharKind.Space) kind[k] = CharKind.Number;
  }
  for (let i = 0; i < n; i++) {
    if (!CURRENCY.has(norm[i])) continue;
    const next = i + 1 < n && kind[i + 1] === CharKind.Space ? i + 2 : i + 1;
    if (next < n && kind[next] === CharKind.Number && idx.text.lines[next] === idx.text.lines[i]) kind[i] = CharKind.Currency;
  }
}

export function charRect(t: PageText, i: number): Rect {
  const b = t.boxes;
  return { x: b[i * 4], y: b[i * 4 + 1], w: b[i * 4 + 2] - b[i * 4], h: b[i * 4 + 3] - b[i * 4 + 1] };
}

function isSpace(s: string) {
  return s.trim() === "";
}

function isDigitChar(idx: TextIndex, i: number) {
  const s = idx.norm[i];
  return s.length === 1 && isDigit(s);
}

function lineOf(idx: TextIndex, i: number): [number, number] {
  const line = idx.text.lines[i];
  for (const r of idx.lineRanges) if (idx.text.lines[r[0]] === line) return r;
  return [i, i + 1];
}

/** 文字の下にある点を探す（少し外れていても近ければ拾う） */
export function charAt(idx: TextIndex, x: number, y: number, tolerance = 1.5): number {
  const b = idx.text.boxes;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < idx.text.chars.length; i++) {
    if (isSpace(idx.norm[i])) continue;
    const x0 = b[i * 4] - tolerance;
    const y0 = b[i * 4 + 1];
    const x1 = b[i * 4 + 2] + tolerance;
    const y1 = b[i * 4 + 3];
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
      const cx = (x0 + x1) / 2;
      const d = Math.abs(cx - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  return best;
}

/**
 * i 番目の文字を含む「数字のかたまり」の範囲 [start, end)。
 * 区切り記号（, . - / : など）と、文字幅程度の狭い空白は数字の間にあるときだけつなぐ。
 */
export function numberGroupAt(idx: TextIndex, i: number): [number, number] | null {
  if (i < 0 || !isDigitChar(idx, i)) return null;
  const [ls, le] = lineOf(idx, i);
  const t = idx.text;
  const canBridge = (a: number, b: number) => {
    // a..b の間（a,b は数字）を区切り記号・狭い空白だけでつなげるか
    let spaces = 0;
    for (let k = a + 1; k < b; k++) {
      const s = idx.norm[k];
      if (isSpace(s)) spaces++;
      else if (!CONNECTORS.has(s)) return false;
    }
    if (b - a - 1 > 2 || spaces > 1) return false;
    const em = Math.max(t.sizes[a], t.sizes[b], 1);
    const gap = t.boxes[b * 4] - t.boxes[a * 4 + 2];
    return gap < em * 0.65;
  };
  let s = i;
  for (;;) {
    let k = s - 1;
    while (k >= ls && k >= s - 3 && !isDigitChar(idx, k)) k--;
    if (k >= ls && isDigitChar(idx, k) && (k === s - 1 || canBridge(k, s))) s = k;
    else break;
  }
  let e = i;
  for (;;) {
    let k = e + 1;
    while (k < le && k <= e + 3 && !isDigitChar(idx, k)) k++;
    if (k < le && isDigitChar(idx, k) && (k === e + 1 || canBridge(e, k))) e = k;
    else break;
  }
  return [s, e + 1];
}

type CharClass = "digit" | "latin" | "kanji" | "kana" | "other";

function charClass(s: string): CharClass {
  if (isDigit(s)) return "digit";
  if (/[A-Za-z@._+\-]/.test(s)) return "latin";
  if (/[一-鿿㐀-䶿々〆]/.test(s)) return "kanji";
  if (/[぀-ヿー]/.test(s)) return "kana";
  return "other";
}

/** 英単語の端に付いた記号（「INV-」の「-」など）は単語に含めない */
const WORD_EDGE = /[\-._+@:/]/;

/** 文字モードでクリックしたときの単語（同じ字種の連なり。数字は含めない） */
export function wordAt(idx: TextIndex, i: number): [number, number] | null {
  if (i < 0 || idx.kind[i] !== CharKind.Text) return null;
  const [ls, le] = lineOf(idx, i);
  const g = charClass(idx.norm[i]);
  const same = (k: number) => idx.kind[k] === CharKind.Text && charClass(idx.norm[k]) === g;
  let s = i;
  while (s - 1 >= ls && same(s - 1)) s--;
  let e = i;
  while (e + 1 < le && same(e + 1)) e++;
  if (g === "latin") {
    while (s < e && s !== i && WORD_EDGE.test(idx.norm[s])) s++;
    while (e > s && e !== i && WORD_EDGE.test(idx.norm[e])) e--;
  }
  return [s, e + 1];
}

/** クリック位置のかたまり（モードに応じて数字／単語） */
export function tokenAt(idx: TextIndex, x: number, y: number, mode: SnapMode): [number, number] | null {
  if (mode === "free") return null;
  const i = charAt(idx, x, y);
  if (i < 0) return null;
  return mode === "digits" ? numberGroupAt(idx, i) : wordAt(idx, i);
}

/** 文字範囲 [s, e) を、行ごとの矩形に変換する（空白は端から除く） */
export function rangeRects(idx: TextIndex, s: number, e: number, pad = 0): Rect[] {
  const out: Rect[] = [];
  let cur: Rect | null = null;
  let curLine = -1;
  for (let i = s; i < e; i++) {
    if (isSpace(idx.norm[i])) continue;
    const r = charRect(idx.text, i);
    const line = idx.text.lines[i];
    if (cur && line === curLine) {
      const x0 = Math.min(cur.x, r.x);
      const y0 = Math.min(cur.y, r.y);
      cur = { x: x0, y: y0, w: Math.max(cur.x + cur.w, r.x + r.w) - x0, h: Math.max(cur.y + cur.h, r.y + r.h) - y0 };
    } else {
      if (cur) out.push(cur);
      cur = { ...r };
      curLine = line;
    }
  }
  if (cur) out.push(cur);
  return out.map((r) => padRect(r, pad));
}

/** 矩形の下にある文字（中心が入っているもの）。自由範囲のマスクでも同じ値の検出・検証に使う */
export function textUnder(idx: TextIndex, r: Rect): string {
  let out = "";
  let line = -1;
  for (let i = 0; i < idx.text.chars.length; i++) {
    const c = charRect(idx.text, i);
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    if (cx < r.x || cx > r.x + r.w || cy < r.y || cy > r.y + r.h) continue;
    if (line >= 0 && idx.text.lines[i] !== line) out += " ";
    line = idx.text.lines[i];
    out += idx.norm[i];
  }
  return out.trim();
}

export function rangeText(idx: TextIndex, s: number, e: number): string {
  return idx.norm.slice(s, e).join("").trim();
}

function padRect(r: Rect, pad: number): Rect {
  const p = pad || Math.max(0.6, r.h * 0.06);
  return { x: r.x - p, y: r.y - p * 0.5, w: r.w + p * 2, h: r.h + p };
}

export interface SnapResult {
  rect: Rect;
  text: string;
}

/**
 * ドラッグ範囲に吸着した矩形を返す。
 * 数字モードは数字（と数字の間の区切り記号）だけ、文字モードは数字以外の文字だけを対象にする。
 * 範囲内（中心が入っている）の対象文字を行ごとに集め、近い文字同士は1つにまとめる。
 * 間に対象外の文字（文字モードなら数字、数字モードなら漢字など）を挟むときはまとめない。
 */
export function snapToRange(idx: TextIndex, area: Rect, mode: SnapMode): SnapResult[] {
  if (mode === "free") return [];
  const t = idx.text;
  const want = mode === "digits" ? CharKind.Number : CharKind.Text;
  const hits: number[] = [];
  for (let i = 0; i < t.chars.length; i++) {
    if (idx.kind[i] !== want) continue;
    const r = charRect(t, i);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    if (cx < area.x || cx > area.x + area.w || cy < area.y || cy > area.y + area.h) continue;
    hits.push(i);
  }
  const out: SnapResult[] = [];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const rects = rangeRects(idx, run[0], run[run.length - 1] + 1);
    const text = run.map((k) => idx.norm[k]).join("");
    for (const rect of rects) out.push({ rect, text });
    run = [];
  };
  for (const i of hits) {
    if (run.length) {
      const prev = run[run.length - 1];
      const sameLine = t.lines[prev] === t.lines[i];
      const em = Math.max(t.sizes[prev], t.sizes[i], 1);
      const gap = t.boxes[i * 4] - t.boxes[prev * 4 + 2];
      let other = false;
      for (let k = prev + 1; k < i && !other; k++) other = idx.kind[k] !== CharKind.Space;
      if (!sameLine || other || gap > em * 1.25 || gap < -em) flush();
    }
    run.push(i);
  }
  flush();
  return out;
}

export interface Match {
  start: number;
  end: number;
  text: string;
  rects: Rect[];
  context: string;
  /** context 内でのヒット位置 */
  ctxStart: number;
  ctxEnd: number;
}

/** 正規表現でページを検索する。名前付きキャプチャ (?<m>…) があればそこだけを対象にする */
export function searchIndex(idx: TextIndex, re: RegExp, limit = 5000): Match[] {
  const out: Match[] = [];
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const rx = new RegExp(re.source, flags.includes("d") ? flags : flags + "d");
  let m: RegExpExecArray | null;
  while ((m = rx.exec(idx.full)) && out.length < limit) {
    if (m[0].length === 0) {
      rx.lastIndex++;
      continue;
    }
    let a = m.index;
    let b = m.index + m[0].length;
    const g = m.indices?.groups?.m;
    if (g) [a, b] = g;
    if (a >= b) continue;
    let s = -1;
    let e = -1;
    for (let k = a; k < b; k++) {
      const ci = idx.map[k];
      if (ci < 0) continue;
      if (s < 0) s = ci;
      e = ci + 1;
    }
    if (s < 0) continue;
    const text = idx.full.slice(a, b);
    if (!text.trim()) continue;
    const c0 = Math.max(0, a - 14);
    const c1 = Math.min(idx.full.length, b + 14);
    const context = idx.full.slice(c0, c1).replace(/\n/g, " ");
    out.push({ start: s, end: e, text, rects: rangeRects(idx, s, e), context, ctxStart: a - c0, ctxEnd: b - c0 });
  }
  return out;
}

/** 文字列そのものを探す（同じ値の検出用）。前後が数字につながる場合は除く */
export function findLiteral(idx: TextIndex, value: string): Match[] {
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = isDigit(value[0] ?? "") ? "(?<!\\d)" : "";
  const tail = isDigit(value[value.length - 1] ?? "") ? "(?!\\d)" : "";
  return searchIndex(idx, new RegExp(head + esc + tail, "g"));
}

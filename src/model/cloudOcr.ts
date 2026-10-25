import type { GrayImage, Matrix6, OcrLine, OcrSymbol, OcrWord } from "./ocrText";

/**
 * 高精度の文字認識（クラウド）：スキャンしたページの画像を Google Cloud Vision に送って読む。
 * 使う人が自分のAPIキーを入れ、文書ごとに確かめてから送る。キーと今月送った枚数は、このブラウザにだけ保存する。
 * 文字情報のあるページ・PDFファイルそのもの・ファイル名は送らない。
 */

export const CLOUD_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
/** 無料枠（月1,000枚）を超えないよう、このブラウザから今月送る枚数の上限 */
export const MONTHLY_CAP = 900;

const KEY_STORE = "kakusu.cloudOcr.key";
const USAGE_STORE = "kakusu.cloudOcr.usage";

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function cloudKey(): string {
  try {
    return store()?.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
}

export function saveCloudKey(key: string) {
  // 保存できない（プライベートブラウズなど）ときも、この画面を開いている間は使えるようにしておく
  memoryKey = key;
  try {
    if (key) store()?.setItem(KEY_STORE, key);
    else store()?.removeItem(KEY_STORE);
  } catch {
    // 保存できなくても続ける
  }
}

let memoryKey = "";
export const currentKey = () => cloudKey() || memoryKey;

export const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/** このブラウザから今月送った枚数 */
export function cloudUsage(now = new Date()): number {
  try {
    const u = JSON.parse(store()?.getItem(USAGE_STORE) ?? "null") as { month: string; pages: number } | null;
    return u && u.month === monthOf(now) ? u.pages : 0;
  } catch {
    return 0;
  }
}

function addUsage(n: number, now = new Date()) {
  try {
    store()?.setItem(USAGE_STORE, JSON.stringify({ month: monthOf(now), pages: cloudUsage(now) + n }));
  } catch {
    // 数えられないときも上限は守る（この画面を開いている間の分）
  }
  memoryUsage += n;
}

let memoryUsage = 0;
export const cloudRemaining = () => Math.max(0, MONTHLY_CAP - Math.max(cloudUsage(), memoryUsage));

// ---- Google Cloud Vision の結果を、文字認識の共通の形（OcrLine）にする ----

interface Vertex {
  x?: number;
  y?: number;
}
interface Box {
  vertices?: Vertex[];
}
interface VSymbol {
  text?: string;
  confidence?: number;
  boundingBox?: Box;
  property?: { detectedBreak?: { type?: string } };
}
interface VWord {
  confidence?: number;
  boundingBox?: Box;
  symbols?: VSymbol[];
}
export interface VisionAnnotation {
  pages?: { blocks?: { paragraphs?: { words?: VWord[] }[] }[] }[];
}

const box = (b: Box | undefined) => {
  const v = b?.vertices ?? [];
  const xs = v.map((p) => p.x ?? 0);
  const ys = v.map((p) => p.y ?? 0);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

/** 行の終わりを表す区切り */
const LINE_END = new Set(["LINE_BREAK", "EOL_SURE_SPACE"]);

/** 段落の単語を、行の終わりの区切りで行に分ける。確からしさは 0〜100 にそろえる */
export function visionToLines(a: VisionAnnotation): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const page of a.pages ?? [])
    for (const block of page.blocks ?? [])
      for (const para of block.paragraphs ?? []) {
        let words: OcrWord[] = [];
        for (const w of para.words ?? []) {
          const symbols: OcrSymbol[] = (w.symbols ?? []).map((s) => ({
            text: s.text ?? "",
            confidence: (s.confidence ?? w.confidence ?? 0.9) * 100,
            bbox: box(s.boundingBox),
          }));
          if (symbols.length) words.push({ confidence: (w.confidence ?? 0.9) * 100, bbox: box(w.boundingBox), symbols });
          const last = w.symbols?.[w.symbols.length - 1];
          if (LINE_END.has(last?.property?.detectedBreak?.type ?? "") && words.length) {
            lines.push({ words });
            words = [];
          }
        }
        if (words.length) lines.push({ words });
      }
  return lines;
}

/**
 * 画像の上で文字を読む向き（右向きを 0 として時計回りの角度）。Google は横向きや逆さまの資料も読み、
 * 枠の頂点を読む順（左上から）で返すので、最初の2頂点の向きを単語ごとに数えて多いほうにする
 */
export function readingTurn(a: VisionAnnotation): 0 | 90 | 180 | 270 {
  const count = [0, 0, 0, 0];
  for (const page of a.pages ?? [])
    for (const block of page.blocks ?? [])
      for (const para of block.paragraphs ?? [])
        for (const w of para.words ?? []) {
          const [p, q] = w.boundingBox?.vertices ?? [];
          if (!p || !q) continue;
          const dx = (q.x ?? 0) - (p.x ?? 0);
          const dy = (q.y ?? 0) - (p.y ?? 0);
          if (dx === 0 && dy === 0) continue;
          const k = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : dy > 0 ? 1 : 3;
          count[k] += w.symbols?.length ?? 1;
        }
  const best = count.indexOf(Math.max(...count));
  return ((best * 90) % 360) as 0 | 90 | 180 | 270;
}

/** 読む向きが右になるよう座標を回す変換（画像 w×h の座標 → 回した画像の座標）と、回した画像の大きさ */
export function turnMatrix(turn: 0 | 90 | 180 | 270, w: number, h: number): { m: Matrix6; w: number; h: number } {
  // x' = a x + c y + e,  y' = b x + d y + f
  if (turn === 90) return { m: [0, -1, 1, 0, 0, w], w: h, h: w }; // 下向きに読む → (y, w - x)
  if (turn === 270) return { m: [0, 1, -1, 0, h, 0], w: h, h: w }; // 上向きに読む → (h - y, x)
  if (turn === 180) return { m: [-1, 0, 0, -1, w, h], w, h };
  return { m: [1, 0, 0, 1, 0, 0], w, h };
}

const apply = (m: Matrix6, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

function invert(m: Matrix6): Matrix6 {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** 先に p、次に q をかける変換 */
function concat(p: Matrix6, q: Matrix6): Matrix6 {
  return [
    p[0] * q[0] + p[1] * q[2],
    p[0] * q[1] + p[1] * q[3],
    p[2] * q[0] + p[3] * q[2],
    p[2] * q[1] + p[3] * q[3],
    p[4] * q[0] + p[5] * q[2] + q[4],
    p[4] * q[1] + p[5] * q[3] + q[5],
  ];
}

/**
 * 横向き・逆さまの資料を、読む向きが右になるように回す（行・画像・ページへの変換をそろえて回す）。
 * 文字の位置合わせは横書きを前提にしているため
 */
export function uprightReading(lines: OcrLine[], toPage: Matrix6, img: GrayImage, turn: 0 | 90 | 180 | 270) {
  if (turn === 0) return { lines, toPage, img };
  const t = turnMatrix(turn, img.width, img.height);
  const turnBox = (b: { x0: number; y0: number; x1: number; y1: number }) => {
    const [ax, ay] = apply(t.m, b.x0, b.y0);
    const [bx, by] = apply(t.m, b.x1, b.y1);
    return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  };
  const turned = lines.map((l) => ({
    words: l.words.map((w) => ({ ...w, bbox: turnBox(w.bbox), symbols: w.symbols.map((s) => ({ ...s, bbox: turnBox(s.bbox) })) })),
  }));
  const back = invert(t.m);
  const data = new Uint8Array(t.w * t.h);
  for (let y = 0; y < t.h; y++)
    for (let x = 0; x < t.w; x++) {
      // 回した画像の画素の中心を、元の画像の画素に戻す
      const [sx, sy] = apply(back, x + 0.5, y + 0.5);
      data[y * t.w + x] = img.data[Math.min(img.height - 1, Math.floor(sy)) * img.width + Math.min(img.width - 1, Math.floor(sx))];
    }
  return { lines: turned, toPage: concat(back, toPage), img: { data, width: t.w, height: t.h } };
}

// ---- 送る ----

export type CloudErrorKind = "key" | "quota" | "network" | "other";

export class CloudOcrError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    message: string,
  ) {
    super(message);
  }
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** ページの画像（JPEG）を1枚送って、文字の位置と内容を受け取る。送る前に今月の枚数に数える */
export async function annotate(jpeg: Uint8Array, key = currentKey()): Promise<VisionAnnotation> {
  if (!key) throw new CloudOcrError("key", "APIキーが設定されていません");
  if (cloudRemaining() <= 0) throw new CloudOcrError("quota", `今月の上限（${MONTHLY_CAP}枚）に達しました`);
  const body = JSON.stringify({
    requests: [
      {
        image: { content: base64(jpeg) },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        imageContext: { languageHints: ["ja", "en"] },
      },
    ],
  });
  addUsage(1);
  let res: Response;
  try {
    res = await fetch(`${CLOUD_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "omit",
      referrerPolicy: "strict-origin",
    });
  } catch (e) {
    throw new CloudOcrError("network", "Google に接続できませんでした（" + (e instanceof Error ? e.message : String(e)) + "）");
  }
  const json = (await res.json().catch(() => null)) as {
    error?: { message?: string; status?: string };
    responses?: { fullTextAnnotation?: VisionAnnotation; error?: { message?: string } }[];
  } | null;
  if (!res.ok || json?.error) {
    const message = json?.error?.message ?? `HTTP ${res.status}`;
    const kind: CloudErrorKind =
      res.status === 429 || /quota|rate limit/i.test(message)
        ? "quota"
        : res.status === 401 || res.status === 403 || /api key/i.test(message)
          ? "key"
          : "other";
    throw new CloudOcrError(kind, message);
  }
  const r = json?.responses?.[0];
  if (r?.error) throw new CloudOcrError("other", r.error.message ?? "読み取れませんでした");
  return r?.fullTextAnnotation ?? {};
}

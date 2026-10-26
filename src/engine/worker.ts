/// <reference lib="webworker" />
import wasmUrl from "../../node_modules/mupdf/dist/mupdf-wasm.wasm?url";
import type { OcrImageResult, OpenResult, RenderResult, TextResult, WorkerRequest, WorkerResponse } from "./protocol";
import { runExport } from "./exporter";
import { blankRects, prepareOcrImage } from "./ocrPrep";
import { extractPageText } from "./textExtract";

declare const self: DedicatedWorkerGlobalScope;

// mupdf を読み込む前に wasm の場所を教える
(globalThis as unknown as Record<string, unknown>).$libmupdf_wasm_Module = {
  locateFile: () => wasmUrl,
};

type Mupdf = typeof import("mupdf");
let mupdf: Mupdf;

interface OpenDoc {
  doc: import("mupdf").PDFDocument;
  bytes: Uint8Array;
  password?: string;
}

const docs = new Map<string, OpenDoc>();

/** 表示リストのキャッシュ（ズームのたびに解析し直さないため） */
const dlCache = new Map<string, import("mupdf").DisplayList>();
const DL_LIMIT = 40;

function getDisplayList(docId: string, page: number) {
  const key = `${docId}:${page}`;
  let dl = dlCache.get(key);
  if (dl) {
    dlCache.delete(key);
    dlCache.set(key, dl);
    return dl;
  }
  const d = docs.get(docId);
  if (!d) throw new Error("document is not open");
  const p = d.doc.loadPage(page);
  dl = p.toDisplayList(true);
  p.destroy();
  dlCache.set(key, dl);
  while (dlCache.size > DL_LIMIT) {
    const [k, v] = dlCache.entries().next().value!;
    dlCache.delete(k);
    v.destroy();
  }
  return dl;
}

function post(msg: WorkerResponse, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

// ---- 優先度付きキュー（表示中のページを最優先。古い要求は取り消せる） ----
interface Task {
  req: WorkerRequest & { id: number };
  priority: number;
  seq: number;
}
const queue: Task[] = [];
let seq = 0;
let busy = false;

function enqueue(req: WorkerRequest & { id: number }, priority: number) {
  queue.push({ req, priority, seq: seq++ });
  schedule();
}

const channel = new MessageChannel();
channel.port1.onmessage = () => void pump();
function schedule() {
  if (!busy) channel.port2.postMessage(0);
}

async function pump() {
  if (busy || !mupdf) return;
  if (queue.length === 0) return;
  queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  const task = queue.shift()!;
  busy = true;
  try {
    await handle(task.req);
  } catch (e) {
    post({ type: "result", id: task.req.id, ok: false, error: errorText(e) });
  } finally {
    busy = false;
    if (queue.length) schedule();
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function handle(req: WorkerRequest & { id: number }) {
  switch (req.type) {
    case "open":
      post({ type: "result", id: req.id, ok: true, value: open(req.docId, req.bytes, req.password) });
      return;
    case "render": {
      const r = await render(req.docId, req.page, req.scale);
      post({ type: "result", id: req.id, ok: true, value: r }, [r.bitmap]);
      return;
    }
    case "text": {
      const t = extractText(req.docId, req.page);
      const transfer = [t.boxes.buffer, t.lines.buffer, t.sizes.buffer] as ArrayBuffer[];
      if (t.flags) transfer.push(t.flags.buffer as ArrayBuffer);
      post({ type: "result", id: req.id, ok: true, value: t }, transfer);
      return;
    }
    case "ocrImage": {
      const r = ocrImage(req.docId, req.page, req.rotate, req.dpi, !!req.jpeg, req.blank);
      const transfer = [r.png.buffer as ArrayBuffer, r.gray.buffer as ArrayBuffer];
      if (r.jpeg) transfer.push(r.jpeg.buffer as ArrayBuffer);
      post({ type: "result", id: req.id, ok: true, value: r }, transfer);
      return;
    }
    case "close": {
      const d = docs.get(req.docId);
      if (d) {
        for (const [k, v] of dlCache) {
          if (k.startsWith(req.docId + ":")) {
            v.destroy();
            dlCache.delete(k);
          }
        }
        d.doc.destroy();
        docs.delete(req.docId);
      }
      post({ type: "result", id: req.id, ok: true, value: null });
      return;
    }
    case "export": {
      const result = await runExport(mupdf, req.job, (id) => {
        const d = docs.get(id);
        if (!d) throw new Error("document is not open");
        return { bytes: d.bytes, password: d.password };
      }, (done, total, label) => post({ type: "progress", id: req.id, done, total, label }));
      post(
        { type: "result", id: req.id, ok: true, value: result },
        result.files.map((f) => f.bytes.buffer as ArrayBuffer),
      );
      return;
    }
  }
}

function open(docId: string, bytes: Uint8Array, password?: string): OpenResult {
  let doc: import("mupdf").PDFDocument;
  try {
    doc = new mupdf.PDFDocument(bytes);
  } catch (e) {
    throw new Error("PDFとして読み込めませんでした（" + errorText(e) + "）");
  }
  if (doc.needsPassword()) {
    if (!password) {
      doc.destroy();
      return { needsPassword: true };
    }
    if (!doc.authenticatePassword(password)) {
      doc.destroy();
      return { needsPassword: true, badPassword: true };
    }
  }
  const n = doc.countPages();
  const pages = [];
  let hasAnnots = false;
  for (let i = 0; i < n; i++) {
    const p = doc.loadPage(i);
    const b = p.getBounds();
    pages.push({ w: b[2] - b[0], h: b[3] - b[1], x0: b[0], y0: b[1] });
    if (!hasAnnots) {
      const annots = p.getObject().get("Annots");
      hasAnnots = annots.isArray() && annots.length > 0;
    }
    p.destroy();
  }
  const meta = (k: string) => doc.getMetaData(k) ?? "";
  docs.get(docId)?.doc.destroy();
  docs.set(docId, { doc, bytes, password });
  return {
    needsPassword: false,
    pages,
    hasAnnots,
    meta: {
      title: meta("info:Title"),
      author: meta("info:Author"),
      subject: meta("info:Subject"),
      keywords: meta("info:Keywords"),
      creator: meta("info:Creator"),
      producer: meta("info:Producer"),
      encryption: meta("encryption"),
    },
  };
}

async function render(docId: string, page: number, scale: number): Promise<RenderResult> {
  const dl = getDisplayList(docId, page);
  const pix = dl.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
  const w = pix.getWidth();
  const h = pix.getHeight();
  const stride = pix.getStride();
  const src = pix.getPixels();
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    let p = y * stride;
    let q = y * w * 4;
    for (let x = 0; x < w; x++) {
      rgba[q] = src[p];
      rgba[q + 1] = src[p + 1];
      rgba[q + 2] = src[p + 2];
      rgba[q + 3] = 255;
      p += 3;
      q += 4;
    }
  }
  pix.destroy();
  const bitmap = await createImageBitmap(new ImageData(rgba, w, h));
  return { bitmap, width: w, height: h, scale };
}

/**
 * 文字認識用に、ページを高解像度のグレースケール画像にする（向きを変えて読むときは回転して描く）。
 * blank にはPDFの文字がある範囲を入れる：白く消して、画像や図の中の文字だけを読む（クラウドにもPDFの文字は送らない）
 */
function ocrImage(docId: string, page: number, rotate: number, dpi: number, withJpeg: boolean, blank?: number[]): OcrImageResult {
  const d = docs.get(docId);
  if (!d) throw new Error("document is not open");
  const p = d.doc.loadPage(page);
  const b = p.getBounds();
  p.destroy();
  const area = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]));
  const k = Math.min(dpi / 72, Math.sqrt(14_000_000 / area));
  const m = mupdf.Matrix.concat(mupdf.Matrix.scale(k, k), mupdf.Matrix.rotate(rotate));
  const pix = getDisplayList(docId, page).toPixmap(m, mupdf.ColorSpace.DeviceRGB, false);
  // 画素 (u, v) → 描画空間 (u + x, v + y) → ページ空間 → 左上を原点にした元ページ空間
  const toPage = mupdf.Matrix.concat(
    mupdf.Matrix.concat(mupdf.Matrix.translate(pix.getX(), pix.getY()), mupdf.Matrix.invert(m)),
    mupdf.Matrix.translate(-b[0], -b[1]),
  ) as OcrImageResult["toPage"];
  const w = pix.getWidth();
  const h = pix.getHeight();
  // 画素の配列は WASM のメモリを直接見ているので、取り出したらすぐ使う
  const rgb = pix.getPixels();
  if (blank?.length) blankRects(rgb, w, h, pix.getStride(), blank, mupdf.Matrix.invert(toPage) as OcrImageResult["toPage"]);
  // 色の付いたセルや罫線を消して、読みやすい白黒の濃淡にする
  const gray = prepareOcrImage(rgb, w, h, pix.getStride(), k * 72);
  const jpeg = withJpeg ? pix.asJPEG(85).slice() : undefined;
  pix.destroy();
  const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false);
  // 画素の配列は WASM のメモリを直接見ているので、取り出したらすぐ書く（途中でメモリが増えると見えなくなる）
  const dst = out.getPixels();
  const os = out.getStride();
  for (let y = 0; y < h; y++) dst.set(gray.subarray(y * w, y * w + w), y * os);
  const png = out.asPNG().slice();
  out.destroy();
  return { png, gray, width: w, height: h, toPage, jpeg };
}

function extractText(docId: string, page: number): TextResult {
  const d = docs.get(docId);
  if (!d) throw new Error("document is not open");
  const p = d.doc.loadPage(page);
  try {
    return extractPageText(p, mupdf);
  } finally {
    p.destroy();
  }
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  switch (req.type) {
    case "cancel":
      for (const id of req.ids) {
        const i = queue.findIndex((t) => t.req.id === id);
        if (i >= 0) {
          queue.splice(i, 1);
          post({ type: "result", id, ok: false, error: "cancelled", cancelled: true });
        }
      }
      return;
    case "open":
      enqueue(req, -10);
      return;
    case "close":
      enqueue(req, -9);
      return;
    case "export":
      enqueue(req, -5);
      return;
    case "render":
    case "text":
    case "ocrImage":
      enqueue(req, req.priority);
      return;
  }
};

(async () => {
  try {
    mupdf = await import("mupdf");
    mupdf.setLog?.(() => {});
    post({ type: "ready" });
    schedule();
  } catch (e) {
    post({ type: "fatal", error: errorText(e) });
  }
})();

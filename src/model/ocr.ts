import type { Worker as OcrWorker } from "tesseract.js";
import { engine } from "../engine/client";
import { OCR_PARAMS, ocrToPageText, orientationScore, readsWell, type GrayImage, type Matrix6, type OcrLine } from "./ocrText";
import { toast, useStore } from "./store";
import type { PageText } from "./types";

/**
 * スキャンしたページ（文字情報がなく画像だけのページ）の文字認識。
 * 認識の部品（tesseract.js と日本語のモデル）はアプリと一緒に配信したものを使い、すべてこの端末の中で動く。
 * 表示中のページを優先し、CPUに余裕があれば2ページずつ並行して処理する。
 */

export type OcrState = "queued" | "running" | "done" | "failed";

interface Job {
  docId: string;
  page: number;
  state: OcrState;
  onDone: (text: PageText) => void;
}

const jobs = new Map<string, Job>();
const key = (docId: string, page: number) => `${docId}:${page}`;
const notified = new Set<string>();
const POOL_SIZE = (navigator.hardwareConcurrency ?? 2) >= 4 ? 2 : 1;
/** 認識エンジン（1つが1ページずつ処理する） */
const pool: Promise<OcrWorker>[] = [];
const idle: Promise<OcrWorker>[] = [];
let active = 0;
let broken = false;
let idleTimer = 0;

const asset = (path: string) => new URL(path, document.baseURI).href;

async function createOcrWorker(): Promise<OcrWorker> {
  const { default: Tesseract } = await import("tesseract.js/dist/tesseract.esm.min.js");
  const worker = await Tesseract.createWorker("jpn", 1, {
    workerPath: asset("ocr/worker.min.js"),
    corePath: asset("ocr/"),
    langPath: asset("ocr"),
    gzip: true,
    cacheMethod: "none",
  });
  await worker.setParameters(OCR_PARAMS);
  return worker;
}

function takeWorker(): Promise<OcrWorker> {
  const w = idle.pop();
  if (w) return w;
  const created = createOcrWorker();
  pool.push(created);
  return created;
}

/** しばらく使わなければ認識エンジンを止めてメモリを空ける */
function scheduleIdleStop() {
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (active) return;
    for (const w of pool.splice(0)) w.then((x) => x.terminate()).catch(() => {});
    idle.length = 0;
  }, 90_000);
}

export function ocrState(docId: string, page: number): OcrState | undefined {
  return jobs.get(key(docId, page))?.state;
}

function publish() {
  let pending = 0;
  let done = 0;
  let failed = 0;
  for (const j of jobs.values()) {
    if (j.state === "done") done++;
    else if (j.state === "failed") failed++;
    else pending++;
  }
  useStore.setState({ ocr: { pending, done, failed, running: active > 0 } });
}

/** 文字のないページの文字認識を予約する。終わったら onDone に文字層を渡す */
export function requestOcr(docId: string, page: number, onDone: (text: PageText) => void) {
  const k = key(docId, page);
  if (jobs.has(k)) return;
  jobs.set(k, { docId, page, state: broken ? "failed" : "queued", onDone });
  if (!broken && !notified.has(docId)) {
    notified.add(docId);
    const name = useStore.getState().docs[docId]?.name ?? "PDF";
    toast({ message: `「${name}」はスキャンした画像のページがあります。文字を認識して、数字に吸着できるようにしています（端末の中で処理）`, duration: 6000 });
  }
  publish();
  pump();
}

export function dropOcr(docId: string) {
  for (const [k, j] of jobs) if (j.docId === docId) jobs.delete(k);
  notified.delete(docId);
  publish();
}

function pickNext(): Job | undefined {
  const s = useStore.getState();
  const queued = [...jobs.values()].filter((j) => j.state === "queued");
  if (!queued.length) return undefined;
  const cur = s.current;
  const visible = cur && queued.find((j) => j.docId === cur.docId && j.page === cur.page);
  if (visible) return visible;
  const order = (j: Job) => s.docOrder.indexOf(j.docId) * 100000 + j.page;
  return queued.sort((a, b) => order(a) - order(b))[0];
}

function pump() {
  while (!broken && active < POOL_SIZE) {
    const job = pickNext();
    if (!job) break;
    void run(job);
  }
  if (!active) scheduleIdleStop();
}

async function run(job: Job) {
  window.clearTimeout(idleTimer);
  active++;
  job.state = "running";
  publish();
  const worker = takeWorker();
  try {
    const text = await recognizePage(await worker, job.docId, job.page);
    if (jobs.get(key(job.docId, job.page)) === job) {
      job.state = "done";
      job.onDone(text);
    }
    idle.push(worker);
  } catch (e) {
    job.state = "failed";
    const started = await worker.then(
      () => true,
      () => false,
    );
    if (started) idle.push(worker);
    else pool.splice(pool.indexOf(worker), 1);
    if (!started && !broken) {
      // 認識エンジン自体を読み込めない（オフラインなど）。残りも試さない
      broken = true;
      for (const j of jobs.values()) if (j.state === "queued") j.state = "failed";
      toast({
        message: "文字認識を始められませんでした（" + (e instanceof Error ? e.message : String(e)) + "）。スキャンしたページは範囲をなぞって隠せます",
        tone: "warn",
        duration: 9000,
      });
    }
  } finally {
    active--;
    publish();
    pump();
  }
}

interface Reading {
  lines: OcrLine[];
  toPage: Matrix6;
  image: GrayImage;
  score: { good: number; total: number };
}

async function read(worker: OcrWorker, docId: string, page: number, rotate: number, dpi: number): Promise<Reading> {
  const img = await engine.ocrImage(docId, page, rotate, dpi, 7);
  const { data } = await worker.recognize(new Blob([img.png as BlobPart], { type: "image/png" }), {}, { blocks: true, text: false });
  const lines: OcrLine[] = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs)
      for (const l of p.lines)
        lines.push({
          words: l.words.map((w) => ({
            confidence: w.confidence,
            bbox: w.bbox,
            symbols: w.symbols.map((s) => ({ text: s.text, confidence: s.confidence, bbox: s.bbox })),
          })),
        });
  return { lines, toPage: img.toPage, image: { data: img.gray, width: img.width, height: img.height }, score: orientationScore(lines) };
}

const ratio = (s: Reading["score"]) => s.good / Math.max(1, s.total);

/**
 * 1ページを認識する。そのままの向きで読めないとき（横向きに貼られた資料など）は、
 * 小さな画像で横向き（90度・270度）、だめなら逆さま（180度）を試し、よく読める向きで読み直す
 */
async function recognizePage(worker: OcrWorker, docId: string, page: number): Promise<PageText> {
  let best = await read(worker, docId, page, 0, 300);
  if (!readsWell(best.score)) {
    const probe = async (r: number) => ({ r, s: (await read(worker, docId, page, r, 110)).score });
    let top = { r: 0, s: best.score };
    for (const r of [90, 270]) {
      const p = await probe(r);
      if (ratio(p.s) > ratio(top.s)) top = p;
    }
    if (top.r === 0) {
      const p = await probe(180);
      if (ratio(p.s) > ratio(top.s)) top = p;
    }
    if (top.r !== 0 && top.s.good >= 8 && ratio(top.s) >= Math.max(0.25, ratio(best.score) * 2)) {
      const turned = await read(worker, docId, page, top.r, 300);
      if (turned.score.good > best.score.good) best = turned;
    }
  }
  return ocrToPageText(best.lines, best.toPage, best.image);
}

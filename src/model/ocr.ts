import type { Worker as OcrWorker } from "tesseract.js";
import { engine } from "../engine/client";
import { annotate, CloudOcrError, readingTurn, uprightReading, visionToLines } from "./cloudOcr";
import { buildCollages, fromCollage, mergeFill, unreadGroups } from "./ocrFill";
import { OCR_PARAMS, ocrToPageText, orientationScore, readsWell, snapToInk, type GrayImage, type Matrix6, type OcrLine } from "./ocrText";
import type { OcrMode } from "./pageText";
import { toast, useStore } from "./store";
import type { PageText } from "./types";

/**
 * 文字認識。スキャンしたページ（文字情報がなく画像だけのページ）はページ全体を、
 * 文字情報のあるページは貼り付けた画像・文字を図形にしたもの・文字化けした文字の部分を読む。
 * 認識の部品（tesseract.js と日本語のモデル）はアプリと一緒に配信したものを使い、すべてこの端末の中で動く。
 * 表示中のページを優先し、CPUに余裕があれば2ページずつ並行して処理する。
 * 設定でAPIキーを入れた人が文書ごとに確かめてオンにしたときだけ、ページの画像を Google Cloud Vision に送って読む（高精度）。
 */

export type OcrState = "queued" | "running" | "done" | "failed";

interface Job {
  docId: string;
  page: number;
  state: OcrState;
  mode: OcrMode;
  /** 白く消してから読む範囲（PDFの文字がある所） */
  blank?: number[];
  onDone: (text: PageText) => void;
  /** どこで読んだか */
  source?: "local" | "cloud";
  /** クラウドで読めなかった（このページは端末内で読む） */
  cloudFailed?: boolean;
}

const jobs = new Map<string, Job>();
const key = (docId: string, page: number) => `${docId}:${page}`;
const notified = new Set<string>();
/** 高精度の文字認識（クラウド）をオンにした文書 */
const cloudDocs = new Set<string>();
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

/** ページの文字認識の使い方（ページ全体／画像・図の中だけ） */
export function ocrJobMode(docId: string, page: number): OcrMode | undefined {
  return jobs.get(key(docId, page))?.mode;
}

/** 読み取ったページを、どこで読んだか */
export function ocrSource(docId: string, page: number): "local" | "cloud" | undefined {
  const j = jobs.get(key(docId, page));
  return j?.state === "done" ? j.source : undefined;
}

/** 文字認識するページ（スキャンしたページと、画像や図の中の文字を読むページ）の数 */
export function ocrTargetCount(docId: string): number {
  let n = 0;
  for (const j of jobs.values()) if (j.docId === docId) n++;
  return n;
}

/** 高精度の文字認識（クラウド）で読み直す。使う人が文書ごとに確かめてから呼ぶ */
export function enableCloudOcr(docId: string) {
  cloudDocs.add(docId);
  cloudWarned = "";
  for (const j of jobs.values()) {
    if (j.docId !== docId) continue;
    j.cloudFailed = false;
    // 読んでいる途中のページは、終わってから読み直す
    if (j.state === "done" || j.state === "failed") j.state = "queued";
  }
  publish();
  pump();
}

/** 高精度の文字認識（クラウド）をすべての文書でやめる（APIキーを消したとき）。読み終えたページはそのまま */
export function disableCloudOcr() {
  cloudDocs.clear();
  publish();
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
  useStore.setState({ ocr: { pending, done, failed, running: active > 0, cloud: [...cloudDocs] } });
}

/**
 * ページの文字認識を予約する。終わったら onDone に読んだ文字を渡す。
 * mode が extra のときは blank の範囲（PDFの文字がある所）を白く消してから読む
 */
export function requestOcr(docId: string, page: number, mode: OcrMode, blank: number[] | undefined, onDone: (text: PageText) => void) {
  const k = key(docId, page);
  if (jobs.has(k)) return;
  jobs.set(k, { docId, page, state: broken ? "failed" : "queued", mode, blank, onDone });
  // スキャンした文書を開いたときだけ知らせる（画像の中の文字を読むのは裏で静かに進める）
  if (!broken && mode === "page" && !notified.has(docId)) {
    notified.add(docId);
    const s = useStore.getState();
    const name = s.docs[docId]?.name ?? "PDF";
    toast({
      message: `「${name}」はスキャンした画像のページがあります。文字を認識して、数字に吸着できるようにしています（端末の中で処理）`,
      duration: 9000,
      // クラウドはAPIキーを設定した人にだけ出す
      action: s.cloudKeySet ? { label: "高精度で読む（クラウド）", run: () => useStore.setState({ cloudOcrFor: docId }) } : undefined,
    });
  }
  publish();
  pump();
}

export function dropOcr(docId: string) {
  for (const [k, j] of jobs) if (j.docId === docId) jobs.delete(k);
  notified.delete(docId);
  cloudDocs.delete(docId);
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
  while (active < POOL_SIZE) {
    const job = pickNext();
    if (!job) break;
    if (broken && !(cloudDocs.has(job.docId) && !job.cloudFailed)) {
      // 端末内の認識エンジンを読み込めないときは、クラウドで読むページだけ進める
      job.state = "failed";
      publish();
      continue;
    }
    void run(job);
  }
  if (!active) scheduleIdleStop();
}

function finish(job: Job, text: PageText, source: "local" | "cloud") {
  if (jobs.get(key(job.docId, job.page)) !== job) return; // 認識中に閉じた
  job.source = source;
  // 端末内で読んでいる途中にクラウドがオンになったページは、クラウドで読み直す
  job.state = source === "local" && cloudDocs.has(job.docId) && !job.cloudFailed ? "queued" : "done";
  job.onDone(text);
}

let cloudWarned = "";
function cloudFailed(job: Job, e: unknown) {
  const err = e instanceof CloudOcrError ? e : new CloudOcrError("other", e instanceof Error ? e.message : String(e));
  job.cloudFailed = true;
  // キーが使えない・上限に達したときは、ほかのページも端末内で読む
  if (err.kind === "key" || err.kind === "quota") {
    cloudDocs.clear();
    publish();
  }
  const message =
    err.kind === "key"
      ? `高精度の文字認識（クラウド）を使えませんでした。APIキーを確かめてください（${err.message}）。端末内で読みます`
      : err.kind === "quota"
        ? `高精度の文字認識（クラウド）の上限に達しました（${err.message}）。端末内で読みます`
        : `クラウドで読めなかったページがあります（${err.message}）。そのページは端末内で読みます`;
  if (message !== cloudWarned) {
    cloudWarned = message;
    toast({ message, tone: "warn", duration: 9000 });
  }
}

async function run(job: Job) {
  window.clearTimeout(idleTimer);
  active++;
  job.state = "running";
  publish();
  if (cloudDocs.has(job.docId) && !job.cloudFailed) {
    try {
      finish(job, await recognizeCloud(job), "cloud");
      active--;
      publish();
      pump();
      return;
    } catch (e) {
      cloudFailed(job, e);
    }
  }
  if (broken) {
    job.state = "failed";
    active--;
    publish();
    pump();
    return;
  }
  const worker = takeWorker();
  try {
    finish(job, await recognizePage(await worker, job), "local");
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
        message: "文字認識を始められませんでした（" + (e instanceof Error ? e.message : String(e)) + "）。スキャンしたページや画像の部分は、範囲をなぞって隠せます",
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

/** PNG の画像を読み、行ごとの単語にする */
async function recognizeLines(worker: OcrWorker, png: Uint8Array): Promise<OcrLine[]> {
  const { data } = await worker.recognize(new Blob([png as BlobPart], { type: "image/png" }), {}, { blocks: true, text: false });
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
  return lines;
}

async function read(worker: OcrWorker, docId: string, page: number, rotate: number, dpi: number, blank?: number[]): Promise<Reading> {
  const img = await engine.ocrImage(docId, page, rotate, dpi, 7, false, blank);
  const lines = await recognizeLines(worker, img.png);
  return { lines, toPage: img.toPage, image: { data: img.gray, width: img.width, height: img.height }, score: orientationScore(lines) };
}

/** 1ページで読み直す行の数の上限（写真の模様などで多くなりすぎたときに時間がかからないように） */
const MAX_FILL = 1000;

/**
 * 1回目に読み残した所（薄い灰色の文字、網掛けのセルの数字、ぽつんとある数字など）を切り出して読み直し、結果に足す
 */
async function fillUnread(worker: OcrWorker, r: Reading): Promise<OcrLine[]> {
  const dpi = 72 / (Math.sqrt(Math.abs(r.toPage[0] * r.toPage[3] - r.toPage[1] * r.toPage[2])) || 1);
  // 数字の単語は、1文字ずつインクが対応したものだけを読めたとみなす（対応しないものは読み直して、よく読めたほうを使う）
  const marked = snapToInk(r.lines, r.image);
  const first = r.lines.map((l, i) => ({ words: l.words.map((w, j) => ({ ...w, inkMatched: marked[i].words[j].inkMatched ?? false })) }));
  const groups = unreadGroups(r.image, first, dpi);
  if (!groups.length || groups.length > MAX_FILL) return r.lines;
  // 切り出した行を縦に並べた画像を、1回目と同じく1つのかたまりの文章として読む
  const again: OcrLine[] = [];
  for (const c of buildCollages(r.image, groups)) {
    const png = await engine.grayPng(c.data, c.width, c.height);
    again.push(...fromCollage(await recognizeLines(worker, png), c));
  }
  return mergeFill(first, again);
}

const ratio = (s: Reading["score"]) => s.good / Math.max(1, s.total);

/**
 * 1ページを Google Cloud Vision で読む。横向き・逆さまの資料も、読む向きに合わせて回してから文字層にする。
 * 文字情報のあるページは、PDFの文字を白く消した画像を送る
 */
async function recognizeCloud(job: Job): Promise<PageText> {
  const img = await engine.ocrImage(job.docId, job.page, 0, 300, 7, true, job.blank);
  if (!img.jpeg) throw new CloudOcrError("other", "ページの画像を作れませんでした");
  const a = await annotate(img.jpeg);
  const up = uprightReading(visionToLines(a), img.toPage, { data: img.gray, width: img.width, height: img.height }, readingTurn(a));
  return ocrToPageText(up.lines, up.toPage, up.img);
}

/** 向きを試すときの画像の解像度。低すぎると表やグラフの小さな文字が読めず、正しい向きでも読めないと判断してしまう */
const PROBE_DPI = 160;

/**
 * 1ページを認識する。そのままの向きで読めないとき（横向きに貼られた資料など）は、
 * 小さな画像で横向き（90度・270度）、だめなら逆さま（180度）を試し、よく読める向きで読み直す。
 * 画像や図の中だけを読むページは、文字が少ないのが普通なので向きは試さない
 */
async function recognizePage(worker: OcrWorker, job: Job): Promise<PageText> {
  const { docId, page } = job;
  let best = await read(worker, docId, page, 0, 300, job.blank);
  if (job.mode === "page" && !readsWell(best.score)) {
    const probe = async (r: number) => ({ r, s: (await read(worker, docId, page, r, PROBE_DPI)).score });
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
  return ocrToPageText(await fillUnread(worker, best), best.toPage, best.image);
}

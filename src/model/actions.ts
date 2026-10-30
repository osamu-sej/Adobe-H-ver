import { engine } from "../engine/client";
import { pageCache, thumbCache } from "../render/bitmaps";
import { clampRect, maskContains, maskOverlapArea } from "./geometry";
import { checkRestore } from "./autosave";
import { isMeaningfulValue } from "./normalize";
import {
  addMasks,
  newMaskId,
  registerDoc,
  removeDoc,
  toast,
  useStore,
  type SearchHit,
  type Suggestion,
} from "./store";
import { findLiteral, searchIndex, textUnder } from "./text";
import { dropTexts, ensureText, getText, loadAllTexts } from "./texts";
import { presetRegex } from "./presets";
import type { DocEntry, Mask, Rect } from "./types";

const set = useStore.setState;
const get = useStore.getState;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function askPassword(fileName: string, bad: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    set({
      passwordRequest: {
        fileName,
        bad,
        resolve: (pw) => {
          set({ passwordRequest: null });
          resolve(pw);
        },
      },
    });
  });
}

let docSeq = 0;

export function isPdfFile(f: File) {
  return f.type === "application/pdf" || /\.pdf$/i.test(f.name);
}

/** PDFを開く（複数可）。すべて端末内で処理する */
export async function openFiles(files: File[]) {
  const pdfs = files.filter(isPdfFile);
  const skipped = files.length - pdfs.length;
  if (skipped) toast({ message: `PDF以外のファイル ${skipped} 件はスキップしました`, tone: "warn" });
  for (let i = 0; i < pdfs.length; i++) {
    const file = pdfs[i];
    set({ loading: { name: file.name, done: i, total: pdfs.length } });
    try {
      await openOne(file);
    } catch (e) {
      toast({ message: `「${file.name}」を開けませんでした：${(e as Error).message}`, tone: "error", duration: 8000 });
    }
  }
  set({ loading: null });
}

async function openOne(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256(bytes);
  const dup = Object.values(get().docs).find((d) => d.hash === hash);
  if (dup) {
    toast({ message: `「${file.name}」はすでに開いています` });
    return;
  }
  await engine.ready;
  const docId = `d${Date.now().toString(36)}${docSeq++}`;
  let res = await engine.open(docId, bytes);
  let password: string | undefined;
  while (res.needsPassword) {
    const pw = await askPassword(file.name, !!res.badPassword);
    if (pw === null) return;
    password = pw;
    res = await engine.open(docId, bytes, pw);
  }
  if (!res.pages || !res.meta) throw new Error("ページ情報を取得できませんでした");
  if (res.pages.length === 0) throw new Error("ページがありません");
  const entry: DocEntry = {
    id: docId,
    name: file.name,
    size: file.size,
    hash,
    bytes,
    password,
    pages: res.pages,
    meta: res.meta,
    hasAnnots: !!res.hasAnnots,
  };
  const first = get().docOrder.length === 0;
  registerDoc(entry, { order: res.pages.map((_, i) => i), rot: {} });
  if (first) set({ fitWidth: true, current: { docId, page: 0 } });
  loadAllTexts(docId, res.pages.length);
  checkRestore(entry);
}

export async function openSample() {
  const res = await fetch("./sample.pdf");
  const blob = await res.blob();
  await openFiles([new File([blob], "サンプル_請求書と名簿.pdf", { type: "application/pdf" })]);
}

export function closeDoc(docId: string) {
  removeDoc(docId);
  pageCache.drop(docId);
  thumbCache.drop(docId);
  dropTexts(docId);
  engine.close(docId).catch(() => {});
}

// ---- マスクの重なり判定 ----

/** rect がすでにマスクで覆われているか（中心が入り、6割以上重なる） */
export function isCovered(masks: Mask[], docId: string, page: number, rect: Rect): boolean {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const area = Math.max(0.01, rect.w * rect.h);
  return masks.some(
    (m) =>
      m.docId === docId &&
      m.page === page &&
      maskContains(m, cx, cy) &&
      maskOverlapArea(m, rect) >= area * 0.6,
  );
}

/** 新しいマスクの既定値（現在のスタイル設定） */
export function maskFrom(docId: string, page: number, r: Rect, text?: string): Mask {
  const s = get();
  const info = s.docs[docId]?.pages[page];
  const rect = info ? clampRect(r, info.w, info.h) : r;
  if (text === undefined) {
    const idx = getText(docId, page);
    text = idx ? textUnder(idx, rect) || undefined : undefined;
  }
  return {
    id: newMaskId(),
    docId,
    page,
    ...rect,
    style: s.style,
    level: s.level,
    strength: s.strength,
    color: s.fillColor,
    opacity: s.fillOpacity,
    label: s.label,
    text,
  };
}

// ---- 同じ値の提案 ----

/** 作ったマスクと同じ値が他の場所にもあれば「まとめて隠す」を提案する */
export function suggestSameValues(values: string[]) {
  const uniq = [...new Set(values.map((v) => v.trim()).filter(isMeaningfulValue))];
  if (!uniq.length) {
    set({ suggestion: null });
    return;
  }
  const s = get();
  const hits: Suggestion["hits"] = [];
  for (const docId of s.docOrder) {
    const d = s.docs[docId];
    if (!d) continue;
    for (const page of s.layouts[docId]?.order ?? []) {
      const idx = getText(docId, page);
      if (!idx) continue;
      for (const v of uniq) {
        for (const m of findLiteral(idx, v)) {
          const rects = m.rects.filter((r) => !isCovered(s.masks, docId, page, r));
          if (rects.length) hits.push({ docId, page, rects, text: m.text });
        }
      }
    }
  }
  set({ suggestion: hits.length ? { values: uniq, hits } : null });
}

export function applySuggestion() {
  const sug = get().suggestion;
  if (!sug) return;
  const masks = sug.hits.flatMap((h) => h.rects.map((r) => maskFrom(h.docId, h.page, r, h.text)));
  addMasks(masks);
  set({ suggestion: null });
  toast({ message: `同じ値を ${masks.length} か所隠しました`, tone: "success" });
}

/** 選択中のマスクと同じ値を探す */
export function suggestForSelection() {
  const s = get();
  const texts = s.masks.filter((m) => s.selection.includes(m.id) && m.text).map((m) => m.text!);
  if (!texts.length) {
    toast({ message: "選択したマスクには文字情報がありません（自由範囲のマスク）" });
    return;
  }
  suggestSameValues(texts);
  if (!get().suggestion) toast({ message: "同じ値はほかに見つかりませんでした" });
}

// ---- 検索 ----

export function runSearch() {
  const s = get();
  const { query, regex, preset, scope } = s.search;
  let re: RegExp | null = null;
  let error: string | null = null;
  if (preset) re = presetRegex(preset);
  else if (query.trim()) {
    try {
      re = regex
        ? new RegExp(query, "giu")
        : new RegExp(query.normalize("NFKC").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*"), "giu");
    } catch (e) {
      error = "正規表現が正しくありません";
    }
  }
  const hits: SearchHit[] = [];
  if (re) {
    const docIds = scope === "current" && s.current ? [s.current.docId] : s.docOrder;
    for (const docId of docIds) {
      for (const page of s.layouts[docId]?.order ?? []) {
        const idx = getText(docId, page);
        if (!idx) continue;
        searchIndex(idx, re, 3000).forEach((m, i) =>
          hits.push({
            key: `${docId}:${page}:${m.start}:${i}`,
            docId,
            page,
            text: m.text,
            rects: m.rects,
            context: m.context,
            ctxStart: m.ctxStart,
            ctxEnd: m.ctxEnd,
          }),
        );
      }
    }
  }
  set({ search: { ...s.search, hits, error, active: Math.min(s.search.active, Math.max(0, hits.length - 1)) } });
}

export function setSearch(patch: Partial<ReturnType<typeof get>["search"]>) {
  set((s) => ({ search: { ...s.search, excluded: [], active: 0, ...patch } }));
  runSearch();
}

/** 検索結果のうち、チェックが入っていて未マスクのものをすべて隠す */
export function maskSearchHits() {
  const s = get();
  const excluded = new Set(s.search.excluded);
  const masks: Mask[] = [];
  for (const h of s.search.hits) {
    if (excluded.has(h.key)) continue;
    for (const r of h.rects) {
      if (isCovered(s.masks, h.docId, h.page, r) || isCovered(masks, h.docId, h.page, r)) continue;
      masks.push(maskFrom(h.docId, h.page, r, h.text));
    }
  }
  if (!masks.length) {
    toast({ message: "隠す対象がありません（すべてマスク済みです）" });
    return;
  }
  addMasks(masks, false);
  const pages = new Set(masks.map((m) => `${m.docId}:${m.page}`)).size;
  toast({ message: `${masks.length} か所を隠しました（${pages}ページ）`, tone: "success" });
}

export async function ensureAllTexts() {
  const s = get();
  const all: Promise<unknown>[] = [];
  for (const docId of s.docOrder) {
    const d = s.docs[docId];
    if (!d) continue;
    for (let i = 0; i < d.pages.length; i++) all.push(ensureText(docId, i, 4).catch(() => {}));
  }
  await Promise.all(all);
}

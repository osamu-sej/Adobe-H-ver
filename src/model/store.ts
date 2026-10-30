import { create } from "zustand";
import type { DocEntry, DocLayout, Level, Mask, MaskStyle, Rect, Rot, SnapMode, TextFrame, Tool } from "./types";
import { addRot } from "./geometry";
import { cloudKey } from "./cloudOcr";
import { moveBlock, trimSelection, type PageSel } from "./pageSelection";

export interface Snapshot {
  docOrder: string[];
  layouts: Record<string, DocLayout>;
  masks: Mask[];
  /** テキスト枠（マスクとは別のもの） */
  frames: TextFrame[];
}

export interface SearchHit {
  key: string;
  docId: string;
  page: number;
  text: string;
  rects: Rect[];
  context: string;
  ctxStart: number;
  ctxEnd: number;
}

export interface Toast {
  id: number;
  message: string;
  tone?: "info" | "success" | "warn" | "error";
  action?: { label: string; run: () => void };
  duration?: number;
}

export interface Suggestion {
  values: string[];
  hits: { docId: string; page: number; rects: Rect[]; text: string }[];
}

export interface PasswordRequest {
  fileName: string;
  bad: boolean;
  resolve: (pw: string | null) => void;
}

export interface PageRef {
  docId: string;
  page: number;
}

interface AppState extends Snapshot {
  docs: Record<string, DocEntry>;
  past: Snapshot[];
  future: Snapshot[];
  /** ドラッグ中など、Undo履歴に積む前の状態 */
  gesture: Snapshot | null;

  tool: Tool;
  style: MaskStyle;
  snap: SnapMode;
  level: Level;
  strength: number | null;
  /** 新しい塗りつぶしの色と不透明度 */
  fillColor: string;
  fillOpacity: number;
  label: string | null;
  selection: string[];
  /** 選択中のテキスト枠（マスクの選択とは同時に持たない） */
  frameSel: string[];
  /** 文字を入力中のテキスト枠 */
  frameEdit: { id: string; fresh?: boolean } | null;
  /** 選択中のマスクの上に操作ツールバーを出すか（作った直後は出さない） */
  toolbar: boolean;
  zoom: number;
  fitWidth: boolean;
  peek: boolean;
  panel: "search" | "masks" | null;
  sidebar: boolean;
  chrome: boolean;
  current: PageRef | null;
  /** ページ一覧（サムネイル）で選んでいるページ。Undo の対象ではない */
  pageSel: PageSel | null;
  scrollTarget: (PageRef & { rect?: Rect; nonce: number }) | null;
  textVersion: number;

  search: {
    query: string;
    regex: boolean;
    preset: string | null;
    scope: "all" | "current";
    hits: SearchHit[];
    excluded: string[];
    active: number;
    error: string | null;
  };

  suggestion: Suggestion | null;
  toasts: Toast[];
  passwordRequest: PasswordRequest | null;
  exportOpen: boolean;
  helpOpen: boolean;
  safetyOpen: boolean;
  settingsOpen: boolean;
  loading: { name: string; done: number; total: number } | null;
  /** 文字認識の進み具合。cloud は高精度の文字認識（クラウド）をオンにした文書 */
  ocr: { pending: number; done: number; failed: number; running: boolean; cloud: string[] };
  /** 設定で高精度の文字認識（クラウド）のAPIキーを入れたか（入れていなければ、クラウドの項目は画面に出さない） */
  cloudKeySet: boolean;
  /** 高精度の文字認識（クラウド）の確認画面を開いている文書 */
  cloudOcrFor: string | null;
  exportedAt: number | null;
  editedAt: number;
}

export const useStore = create<AppState>(() => ({
  docOrder: [],
  layouts: {},
  masks: [],
  frames: [],
  docs: {},
  past: [],
  future: [],
  gesture: null,

  tool: "mask",
  style: "mosaic",
  snap: "digits",
  level: "strong",
  strength: null,
  fillColor: "#000000",
  fillOpacity: 1,
  label: null,
  selection: [],
  frameSel: [],
  frameEdit: null,
  toolbar: false,
  zoom: 1.4,
  fitWidth: true,
  peek: false,
  panel: null,
  sidebar: true,
  chrome: true,
  current: null,
  pageSel: null,
  scrollTarget: null,
  textVersion: 0,

  search: { query: "", regex: false, preset: null, scope: "all", hits: [], excluded: [], active: 0, error: null },

  suggestion: null,
  toasts: [],
  passwordRequest: null,
  exportOpen: false,
  helpOpen: false,
  safetyOpen: false,
  settingsOpen: false,
  loading: null,
  ocr: { pending: 0, done: 0, failed: 0, running: false, cloud: [] },
  cloudKeySet: !!cloudKey(),
  cloudOcrFor: null,
  exportedAt: null,
  editedAt: 0,
}));

const get = useStore.getState;
const set = useStore.setState;

function snapshot(): Snapshot {
  const s = get();
  return { docOrder: s.docOrder, layouts: s.layouts, masks: s.masks, frames: s.frames };
}

const HISTORY_LIMIT = 300;

/** 履歴に積んで状態を変える（Undo可能な操作はすべてこれを通す） */
export function commit(fn: (s: Snapshot) => Partial<Snapshot>) {
  const before = snapshot();
  const patch = fn(before);
  set((s) => ({
    ...patch,
    past: [...s.past.slice(-HISTORY_LIMIT), before],
    future: [],
    editedAt: Date.now(),
  }));
}

/** ドラッグ開始。終わるまで履歴には積まない */
export function beginGesture() {
  if (!get().gesture) set({ gesture: snapshot() });
}

export function updateGesture(fn: (s: Snapshot) => Partial<Snapshot>) {
  set(fn(snapshot()));
}

export function endGesture() {
  const g = get().gesture;
  if (!g) return;
  const now = snapshot();
  const changed = g.masks !== now.masks || g.frames !== now.frames || g.layouts !== now.layouts || g.docOrder !== now.docOrder;
  set((s) => ({
    gesture: null,
    ...(changed ? { past: [...s.past.slice(-HISTORY_LIMIT), g], future: [], editedAt: Date.now() } : {}),
  }));
}

export function cancelGesture() {
  const g = get().gesture;
  if (!g) return;
  set({ ...g, gesture: null });
}

export function undo() {
  const s = get();
  if (s.gesture || !s.past.length) return false;
  const prev = s.past[s.past.length - 1];
  set({
    ...prev,
    past: s.past.slice(0, -1),
    future: [snapshot(), ...s.future],
    selection: s.selection.filter((id) => prev.masks.some((m) => m.id === id)),
    frameSel: s.frameSel.filter((id) => prev.frames.some((f) => f.id === id)),
    pageSel: trimSelection(s.pageSel, s.pageSel && prev.layouts[s.pageSel.docId]?.order),
    editedAt: Date.now(),
  });
  return true;
}

export function redo() {
  const s = get();
  if (s.gesture || !s.future.length) return false;
  const next = s.future[0];
  set({
    ...next,
    past: [...s.past, snapshot()],
    future: s.future.slice(1),
    selection: s.selection.filter((id) => next.masks.some((m) => m.id === id)),
    frameSel: s.frameSel.filter((id) => next.frames.some((f) => f.id === id)),
    pageSel: trimSelection(s.pageSel, s.pageSel && next.layouts[s.pageSel.docId]?.order),
    editedAt: Date.now(),
  });
  return true;
}

// ---- 文書 ----

export function registerDoc(doc: DocEntry, layout: DocLayout, masks: Mask[] = [], frames: TextFrame[] = []) {
  // 開いた操作そのものはUndoの対象にしない（過去の履歴にも追加しておく）
  const add = (s: Snapshot): Snapshot => ({
    docOrder: [...s.docOrder, doc.id],
    layouts: { ...s.layouts, [doc.id]: layout },
    masks: [...s.masks, ...masks],
    frames: [...s.frames, ...frames],
  });
  set((s) => ({
    docs: { ...s.docs, [doc.id]: doc },
    ...add(snapshot()),
    past: s.past.map(add),
    future: s.future.map(add),
    // 文字の入力中など、ひとまとまりの操作の途中に開いたときも、その操作の基準の状態に加えておく
    // （あとで取り消し・やり直しの基準に戻ったとき、開いた文書が消えないように）
    gesture: s.gesture ? add(s.gesture) : null,
  }));
}

export function removeDoc(docId: string) {
  const strip = (s: Snapshot): Snapshot => {
    const layouts = { ...s.layouts };
    delete layouts[docId];
    return { docOrder: s.docOrder.filter((d) => d !== docId), layouts, masks: s.masks.filter((m) => m.docId !== docId), frames: s.frames.filter((f) => f.docId !== docId) };
  };
  set((s) => {
    const docs = { ...s.docs };
    delete docs[docId];
    return {
      docs,
      ...strip(snapshot()),
      past: s.past.map(strip),
      future: s.future.map(strip),
      selection: s.selection.filter((id) => s.masks.find((m) => m.id === id)?.docId !== docId),
      frameSel: s.frameSel.filter((id) => s.frames.find((f) => f.id === id)?.docId !== docId),
      frameEdit: s.frameEdit && s.frames.find((f) => f.id === s.frameEdit!.id)?.docId === docId ? null : s.frameEdit,
      // 入力中の枠のある文書を閉じたときは、入力のひとまとまりの操作も捨てる。それ以外の途中の操作は、閉じた文書を除く
      gesture:
        s.frameEdit && s.frames.find((f) => f.id === s.frameEdit!.id)?.docId === docId ? null : s.gesture ? strip(s.gesture) : null,
      current: s.current?.docId === docId ? null : s.current,
      pageSel: s.pageSel?.docId === docId ? null : s.pageSel,
      search: { ...s.search, hits: s.search.hits.filter((h) => h.docId !== docId) },
      suggestion: null,
    };
  });
}

// ---- マスク ----

let maskSeq = 0;
export function newMaskId() {
  return `m${Date.now().toString(36)}${(maskSeq++).toString(36)}`;
}

export function addMasks(masks: Mask[], select = true) {
  if (!masks.length) return;
  commit((s) => ({ masks: [...s.masks, ...masks] }));
  if (select) set({ selection: masks.map((m) => m.id), frameSel: [], toolbar: false });
}

export function updateMasks(ids: string[], patch: Partial<Mask> | ((m: Mask) => Partial<Mask>)) {
  if (!ids.length) return;
  const idSet = new Set(ids);
  commit((s) => ({
    masks: s.masks.map((m) => (idSet.has(m.id) ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)),
  }));
}

export function deleteMasks(ids: string[]) {
  if (!ids.length) return;
  const idSet = new Set(ids);
  commit((s) => ({ masks: s.masks.filter((m) => !idSet.has(m.id)) }));
  set((s) => ({ selection: s.selection.filter((id) => !idSet.has(id)) }));
}

export function select(ids: string[], toolbar = true) {
  set({ selection: ids, frameSel: [], toolbar: toolbar && ids.length > 0 });
}

// ---- テキスト枠 ----

let frameSeq = 0;
export function newFrameId() {
  return `t${Date.now().toString(36)}${(frameSeq++).toString(36)}`;
}

/** 枠を選ぶ（マスクの選択は外す）。空なら枠の選択を外す */
export function selectFrames(ids: string[]) {
  set(ids.length ? { frameSel: ids, selection: [], toolbar: false } : { frameSel: [] });
}

/** 枠を足して選ぶ。ドラッグ中などの途中（gesture）なら履歴には積まない */
export function addFrame(frame: TextFrame) {
  const add = (s: Snapshot) => ({ frames: [...s.frames, frame] });
  if (get().gesture) updateGesture(add);
  else commit(add);
  selectFrames([frame.id]);
}

/** 枠の設定を変える。文字の入力中など gesture の途中なら履歴には積まない（終わったときにまとめて1回） */
export function patchFrames(ids: string[], patch: Partial<TextFrame> | ((f: TextFrame) => Partial<TextFrame>)) {
  if (!ids.length) return;
  const idSet = new Set(ids);
  const apply = (s: Snapshot) => ({
    frames: s.frames.map((f) => (idSet.has(f.id) ? { ...f, ...(typeof patch === "function" ? patch(f) : patch) } : f)),
  });
  if (get().gesture) updateGesture(apply);
  else commit(apply);
}

/**
 * 枠の中の文字の入力を始める。入力が終わるまでの変更（文字・大きさなど）は履歴に積まず、終わったときに1回にまとめる。
 * fresh は、ツールで作ったばかりの枠（何も入れずに終えたら、枠ごとなかったことにする）
 */
export function startFrameEdit(id: string, opts: { fresh?: boolean } = {}) {
  const f = get().frames.find((x) => x.id === id);
  // 削除したページの枠は、画面に出ない（入力欄が出ない）ので始めない
  if (!f || !get().layouts[f.docId]?.order.includes(f.page)) return;
  beginGesture();
  set({ frameEdit: { id, ...opts }, frameSel: [id], selection: [], toolbar: false });
}

/** 文字の入力を終える */
export function finishFrameEdit() {
  const e = get().frameEdit;
  if (!e) return;
  const f = get().frames.find((x) => x.id === e.id);
  set({ frameEdit: null });
  if (e.fresh && !f?.text.trim()) {
    cancelGesture();
    set({ frameSel: [] });
  } else endGesture();
}

export function deleteFrames(ids: string[]) {
  if (!ids.length) return;
  // 入力中の枠を消すときは、先に入力を終える（入力のひとまとまりの操作を残したままにしない）
  const editing = get().frameEdit;
  if (editing && ids.includes(editing.id)) finishFrameEdit();
  const idSet = new Set(ids.filter((id) => get().frames.some((f) => f.id === id)));
  if (!idSet.size) {
    // 作ったばかりの空の枠は、入力を終えた時点でなくなっている
    set((s) => ({ frameSel: s.frameSel.filter((id) => !ids.includes(id)) }));
    return;
  }
  commit((s) => ({ frames: s.frames.filter((f) => !idSet.has(f.id)) }));
  set((s) => ({
    frameSel: s.frameSel.filter((id) => !idSet.has(id)),
    frameEdit: s.frameEdit && idSet.has(s.frameEdit.id) ? null : s.frameEdit,
  }));
}

// ---- ページ操作 ----

export function rotatePages(docId: string, pages: number[], delta: number) {
  commit((s) => {
    const l = s.layouts[docId];
    if (!l) return {};
    const rot: Record<number, Rot> = { ...l.rot };
    for (const p of pages) rot[p] = addRot(rot[p] ?? 0, delta);
    return { layouts: { ...s.layouts, [docId]: { ...l, rot } } };
  });
}

export function deletePages(docId: string, pages: number[]) {
  const s = get();
  const l = s.layouts[docId];
  if (!l) return false;
  const gone = new Set(pages);
  const remaining = l.order.filter((p) => !gone.has(p));
  if (remaining.length === l.order.length || remaining.length === 0) return false;
  commit((snap) => ({
    layouts: { ...snap.layouts, [docId]: { ...snap.layouts[docId], order: remaining } },
  }));
  // 削除したページは選択から外す（そのページの枠の選択も）
  set((st) => ({
    pageSel: st.pageSel?.docId === docId ? trimSelection(st.pageSel, remaining) : st.pageSel,
    frameSel: st.frameSel.filter((id) => {
      const f = st.frames.find((x) => x.id === id);
      return !f || f.docId !== docId || remaining.includes(f.page);
    }),
  }));
  return true;
}

/** ページ一覧の選択を変える（null で解除） */
export function setPageSel(sel: PageSel | null) {
  set({ pageSel: sel && sel.pages.length ? sel : null });
}

/** pages をひとまとめにして、表示順で at 番目（0〜ページ数）の前へ動かす。動かさなかったときは false */
export function movePages(docId: string, pages: number[], at: number) {
  const l = get().layouts[docId];
  if (!l) return false;
  const order = moveBlock(l.order, pages, at);
  if (order.length === l.order.length && order.every((p, i) => p === l.order[i])) return false;
  commit((s) => ({ layouts: { ...s.layouts, [docId]: { ...s.layouts[docId], order } } }));
  return true;
}

export function movePage(docId: string, from: number, to: number) {
  commit((s) => {
    const l = s.layouts[docId];
    if (!l || from === to) return {};
    const order = [...l.order];
    const [p] = order.splice(from, 1);
    order.splice(to, 0, p);
    return { layouts: { ...s.layouts, [docId]: { ...l, order } } };
  });
}

// ---- 通知 ----

let toastSeq = 1;
export function toast(t: Omit<Toast, "id">) {
  const id = toastSeq++;
  set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
  const ms = t.duration ?? (t.action ? 6500 : 3200);
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function scrollToPage(ref: PageRef, rect?: Rect) {
  set({ scrollTarget: { ...ref, rect, nonce: Date.now() + Math.random() } });
}

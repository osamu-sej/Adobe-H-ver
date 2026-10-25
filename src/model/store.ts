import { create } from "zustand";
import type { DocEntry, DocLayout, Level, Mask, MaskStyle, Rect, Rot, SnapMode, Tool } from "./types";
import { addRot } from "./geometry";

export interface Snapshot {
  docOrder: string[];
  layouts: Record<string, DocLayout>;
  masks: Mask[];
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
  /** 選択中のマスクの上に操作ツールバーを出すか（作った直後は出さない） */
  toolbar: boolean;
  zoom: number;
  fitWidth: boolean;
  peek: boolean;
  panel: "search" | "masks" | null;
  sidebar: boolean;
  chrome: boolean;
  current: PageRef | null;
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
  loading: { name: string; done: number; total: number } | null;
  /** スキャンしたページの文字認識の進み具合 */
  ocr: { pending: number; done: number; failed: number; running: boolean };
  exportedAt: number | null;
  editedAt: number;
}

export const useStore = create<AppState>(() => ({
  docOrder: [],
  layouts: {},
  masks: [],
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
  toolbar: false,
  zoom: 1.4,
  fitWidth: true,
  peek: false,
  panel: null,
  sidebar: true,
  chrome: true,
  current: null,
  scrollTarget: null,
  textVersion: 0,

  search: { query: "", regex: false, preset: null, scope: "all", hits: [], excluded: [], active: 0, error: null },

  suggestion: null,
  toasts: [],
  passwordRequest: null,
  exportOpen: false,
  helpOpen: false,
  safetyOpen: false,
  loading: null,
  ocr: { pending: 0, done: 0, failed: 0, running: false },
  exportedAt: null,
  editedAt: 0,
}));

const get = useStore.getState;
const set = useStore.setState;

function snapshot(): Snapshot {
  const s = get();
  return { docOrder: s.docOrder, layouts: s.layouts, masks: s.masks };
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
  const changed = g.masks !== now.masks || g.layouts !== now.layouts || g.docOrder !== now.docOrder;
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
    editedAt: Date.now(),
  });
  return true;
}

// ---- 文書 ----

export function registerDoc(doc: DocEntry, layout: DocLayout, masks: Mask[] = []) {
  // 開いた操作そのものはUndoの対象にしない（過去の履歴にも追加しておく）
  const add = (s: Snapshot): Snapshot => ({
    docOrder: [...s.docOrder, doc.id],
    layouts: { ...s.layouts, [doc.id]: layout },
    masks: [...s.masks, ...masks],
  });
  set((s) => ({
    docs: { ...s.docs, [doc.id]: doc },
    ...add(snapshot()),
    past: s.past.map(add),
    future: s.future.map(add),
  }));
}

export function removeDoc(docId: string) {
  const strip = (s: Snapshot): Snapshot => {
    const layouts = { ...s.layouts };
    delete layouts[docId];
    return { docOrder: s.docOrder.filter((d) => d !== docId), layouts, masks: s.masks.filter((m) => m.docId !== docId) };
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
      current: s.current?.docId === docId ? null : s.current,
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
  if (select) set({ selection: masks.map((m) => m.id), toolbar: false });
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
  set({ selection: ids, toolbar: toolbar && ids.length > 0 });
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
  const remaining = l.order.filter((p) => !pages.includes(p));
  if (remaining.length === 0) return false;
  commit((snap) => ({
    layouts: { ...snap.layouts, [docId]: { ...snap.layouts[docId], order: remaining } },
  }));
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

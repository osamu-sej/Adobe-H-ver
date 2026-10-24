import { engine } from "../engine/client";
import { useStore } from "./store";
import { buildIndex, type TextIndex } from "./text";

/** ページごとの文字層（大きいので状態管理の外に置き、更新は textVersion で知らせる） */
const indexes = new Map<string, TextIndex>();
const inflight = new Map<string, Promise<TextIndex>>();

const key = (docId: string, page: number) => `${docId}:${page}`;

export function getText(docId: string, page: number): TextIndex | undefined {
  return indexes.get(key(docId, page));
}

let bumpTimer = 0;
function bump() {
  if (bumpTimer) return;
  bumpTimer = window.setTimeout(() => {
    bumpTimer = 0;
    useStore.setState((s) => ({ textVersion: s.textVersion + 1 }));
  }, 60);
}

export function ensureText(docId: string, page: number, priority = 3): Promise<TextIndex> {
  const k = key(docId, page);
  const have = indexes.get(k);
  if (have) return Promise.resolve(have);
  const running = inflight.get(k);
  if (running) return running;
  const p = engine
    .text(docId, page, priority)
    .then((t) => {
      const idx = buildIndex(t);
      indexes.set(k, idx);
      inflight.delete(k);
      bump();
      return idx;
    })
    .catch((e) => {
      inflight.delete(k);
      throw e;
    });
  inflight.set(k, p);
  return p;
}

/** 文書を開いたら裏で全ページの文字を読んでおく（検索・同じ値の検出に使う） */
export function loadAllTexts(docId: string, pageCount: number) {
  for (let i = 0; i < pageCount; i++) ensureText(docId, i, 6).catch(() => {});
}

export function dropTexts(docId: string) {
  for (const k of [...indexes.keys()]) if (k.startsWith(docId + ":")) indexes.delete(k);
}

export function textProgress(): { loaded: number; total: number } {
  const s = useStore.getState();
  let loaded = 0;
  let total = 0;
  for (const id of s.docOrder) {
    const d = s.docs[id];
    if (!d) continue;
    total += d.pages.length;
    for (let i = 0; i < d.pages.length; i++) if (indexes.has(key(id, i))) loaded++;
  }
  return { loaded, total };
}

export function pageHasText(docId: string, page: number): boolean | undefined {
  const t = indexes.get(key(docId, page));
  if (!t) return undefined;
  return t.text.chars.some((c) => c.trim() !== "");
}

import { commit, toast, useStore } from "./store";
import { textUnder } from "./text";
import { getText } from "./texts";
import type { DocEntry, DocLayout, Level, Mask, MaskStyle } from "./types";

/**
 * 作業の自動保存。保存するのはマスクの位置・ページ構成だけで、PDF本体や隠した文字は保存しない。
 * 同じファイル（SHA-256が一致）を開き直したときに復元できる。
 */

const PREFIX = "kakusu:v1:";
const MAX_ENTRIES = 60;

type SavedMask = Omit<Mask, "docId" | "text">;

interface Saved {
  /** 保存形式。2：塗りつぶしの色・透明度と、弱めた程度。なし：黒塗り・白塗りと、1段階ずつ強かった程度 */
  v?: number;
  name: string;
  savedAt: number;
  order: number[];
  rot: DocLayout["rot"];
  masks: SavedMask[];
}

const VERSION = 2;

/** 古い形式で保存したマスクを今の形式に直す（見た目がなるべく変わらないように） */
function migrate(raw: SavedMask, v: number): SavedMask {
  const m = raw as Omit<SavedMask, "style" | "level" | "color" | "opacity"> & {
    style: string;
    level?: Level;
    color?: string;
    opacity?: number;
  };
  const style: MaskStyle = m.style === "black" || m.style === "white" ? "fill" : (m.style as MaskStyle);
  const color = m.color ?? (m.style === "white" ? "#ffffff" : "#000000");
  // v1 の弱・中は、今の中・強と同じ強さ。v1 の強（今はない）は今の強に寄せる
  const level: Level = v >= 2 ? (m.level ?? "strong") : m.level === "weak" ? "medium" : "strong";
  return { ...m, style, level, color, opacity: m.opacity ?? 1 };
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isPristine(doc: DocEntry, layout: DocLayout, masks: Mask[]) {
  return (
    masks.length === 0 &&
    layout.order.length === doc.pages.length &&
    layout.order.every((p, i) => p === i) &&
    Object.values(layout.rot).every((r) => !r)
  );
}

function saveAll() {
  const ls = storage();
  if (!ls) return;
  const s = useStore.getState();
  for (const id of s.docOrder) {
    const doc = s.docs[id];
    const layout = s.layouts[id];
    if (!doc || !layout) continue;
    const masks = s.masks.filter((m) => m.docId === id);
    const key = PREFIX + doc.hash;
    try {
      if (isPristine(doc, layout, masks)) {
        ls.removeItem(key);
        continue;
      }
      const data: Saved = {
        v: VERSION,
        name: doc.name,
        savedAt: Date.now(),
        order: layout.order,
        rot: layout.rot,
        masks: masks.map(({ docId: _d, text: _t, ...rest }) => rest),
      };
      ls.setItem(key, JSON.stringify(data));
    } catch {
      // 容量不足などは無視（作業は続けられる）
    }
  }
  prune(ls);
}

function prune(ls: Storage) {
  try {
    const entries: [string, number][] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      try {
        entries.push([k, (JSON.parse(ls.getItem(k) ?? "{}") as Saved).savedAt ?? 0]);
      } catch {
        entries.push([k, 0]);
      }
    }
    entries.sort((a, b) => b[1] - a[1]);
    for (const [k] of entries.slice(MAX_ENTRIES)) ls.removeItem(k);
  } catch {
    // 無視
  }
}

let timer = 0;
export function startAutosave() {
  useStore.subscribe((s, prev) => {
    if (s.masks === prev.masks && s.layouts === prev.layouts) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(saveAll, 600);
  });
}

/** 開いたファイルに前回の作業があれば、復元を提案する */
export function checkRestore(doc: DocEntry) {
  const ls = storage();
  if (!ls) return;
  let saved: Saved | null = null;
  try {
    const raw = ls.getItem(PREFIX + doc.hash);
    saved = raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    saved = null;
  }
  if (!saved) return;
  const data = saved;
  const when = new Date(data.savedAt).toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  toast({
    message: `「${doc.name}」の前回の作業（マスク ${data.masks.length} 件・${when}）が残っています`,
    duration: 15000,
    action: {
      label: "復元する",
      run: () => {
        const valid = data.order.filter((p) => p >= 0 && p < doc.pages.length);
        const restored = data.masks
          .filter((m) => m.page < doc.pages.length)
          .map((m) => {
            const idx = getText(doc.id, m.page);
            return { ...migrate(m, data.v ?? 1), docId: doc.id, text: idx ? textUnder(idx, m) || undefined : undefined };
          });
        commit((s) => ({
          layouts: { ...s.layouts, [doc.id]: { order: valid.length ? valid : s.layouts[doc.id].order, rot: data.rot ?? {} } },
          masks: [...s.masks.filter((m) => m.docId !== doc.id), ...restored],
        }));
        toast({ message: "前回の作業を復元しました", tone: "success" });
      },
    },
  });
}

export function clearSavedWork() {
  const ls = storage();
  if (!ls) return 0;
  const keys: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k?.startsWith(PREFIX)) keys.push(k);
  }
  keys.forEach((k) => ls.removeItem(k));
  return keys.length;
}

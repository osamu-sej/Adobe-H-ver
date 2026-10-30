import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toViewRect, viewSize } from "../model/geometry";
import { allPages, clickPage, pageAfterDelete, singlePage, stepPage } from "../model/pageSelection";
import { deletePages, movePages, rotatePages, scrollToPage, setPageSel, toast, undo, useStore } from "../model/store";
import type { PageInfo, Rot } from "../model/types";
import { thumbCache, usePageBitmap } from "../render/bitmaps";
import { paintMasks, paintPage } from "../render/paint";
import { openContextMenu } from "./ContextMenu";
import { IconChevron, IconPlus, IconRotL, IconRotR, IconTrash, IconX } from "./icons";
import { confirmClose } from "./Viewer";

const THUMB_W = 128;
const NONE: number[] = [];

/** ページを削除して、次のページを選ぶ。「元に戻す」で削除したページを選び直す。全ページは削除できない（ファイルごと閉じる） */
function removePages(docId: string, pages: number[]) {
  const l = useStore.getState().layouts[docId];
  if (!l) return;
  const targets = l.order.filter((p) => pages.includes(p));
  if (!targets.length) return;
  const next = pageAfterDelete(l.order, targets);
  const first = l.order.indexOf(targets[0]);
  if (!deletePages(docId, targets)) {
    toast({
      message: l.order.length === 1 ? "最後の1ページは削除できません" : "すべてのページは削除できません",
      tone: "warn",
      action: { label: "ファイルを閉じる", run: () => confirmClose(docId) },
    });
    return;
  }
  if (next !== null) {
    setPageSel(singlePage(docId, next));
    scrollToPage({ docId, page: next });
  }
  toast({
    message: targets.length === 1 ? `${first + 1}ページ目を削除しました` : `${targets.length}ページを削除しました`,
    action: {
      label: "元に戻す",
      run: () => {
        if (!undo()) return;
        const order = useStore.getState().layouts[docId]?.order ?? [];
        const back = order.filter((p) => targets.includes(p));
        if (back.length) setPageSel({ docId, pages: back, anchor: back[0], focus: back[back.length - 1] });
      },
    },
  });
}

/** サムネイルの並びの中で、clientY の位置に落としたとき、表示順で何番目の前に入るか */
function dropIndex(container: HTMLElement, clientY: number): number {
  const items = [...container.querySelectorAll<HTMLElement>(".thumb")];
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return items.length;
}

/** サムネイルの操作が及ぶページ：選択中のページ（複数選択の一部）なら選択全体、そうでなければそのページだけ */
function pagesFor(docId: string, page: number): number[] {
  const sel = useStore.getState().pageSel;
  return sel?.docId === docId && sel.pages.includes(page) ? sel.pages : [page];
}

function openPageMenu(e: React.MouseEvent, docId: string, page: number) {
  e.preventDefault();
  const st = useStore.getState();
  const order = st.layouts[docId]?.order ?? [];
  // 選択していないページを右クリックしたら、そのページだけを選ぶ（PowerPoint と同じ）
  const pages = pagesFor(docId, page);
  if (pages.length === 1 && pages[0] === page && !(st.pageSel?.docId === docId && st.pageSel.pages.includes(page))) {
    setPageSel(singlePage(docId, page));
  }
  const n = pages.length;
  const many = n > 1 ? `選択した ${n} ページ` : "ページ";
  openContextMenu(e.clientX, e.clientY, [
    { label: `${many}を削除`, shortcut: "Del", icon: <IconTrash size={15} />, danger: true, run: () => removePages(docId, pages) },
    { separator: true, label: "" },
    { label: `${many}を左に回転`, shortcut: "Ctrl+L", icon: <IconRotL size={15} />, run: () => rotatePages(docId, pages, -90) },
    { label: `${many}を右に回転`, shortcut: "Ctrl+R", icon: <IconRotR size={15} />, run: () => rotatePages(docId, pages, 90) },
    { separator: true, label: "" },
    { label: "すべてのページを選択", shortcut: "Ctrl+A", disabled: n === order.length, run: () => setPageSel(allPages(docId, order)) },
  ]);
}

/** ダイアログを開いている間は、ページの操作をしない（App.tsx のキー操作と同じ条件） */
function modalOpen(s: ReturnType<typeof useStore.getState>) {
  return s.exportOpen || s.helpOpen || !!s.passwordRequest || s.safetyOpen || s.settingsOpen || !!s.cloudOcrFor;
}

/** ページ一覧にフォーカスがあるときのキー操作（PowerPoint のスライド一覧と同じ）。ページを選んでいなければ従来の操作に任せる */
function onPaneKeyDown(e: React.KeyboardEvent) {
  const s = useStore.getState();
  if (modalOpen(s)) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const sel = s.pageSel;
  const take = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (mod && key === "a") {
    const docId = sel?.docId ?? s.current?.docId ?? s.docOrder[0];
    const all = docId ? allPages(docId, s.layouts[docId]?.order ?? []) : null;
    if (all) {
      take();
      setPageSel(all);
    }
    return;
  }
  if (!sel) return;
  const order = s.layouts[sel.docId]?.order ?? [];
  if (e.key === "Delete" || e.key === "Backspace" || (mod && key === "d")) {
    take();
    removePages(sel.docId, sel.pages);
    return;
  }
  if (mod && (key === "l" || key === "r")) {
    take();
    rotatePages(sel.docId, sel.pages, key === "l" ? -90 : 90);
    return;
  }
  if (mod || e.altKey) return;
  if (e.key === "Escape" && sel.pages.length > 1) {
    take();
    setPageSel(singlePage(sel.docId, sel.focus));
    return;
  }
  const to = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : e.key === "Home" ? "first" : e.key === "End" ? "last" : null;
  if (to === null) return;
  take();
  const next = stepPage(sel, order, to, e.shiftKey);
  if (!next) return;
  setPageSel(next);
  // 範囲を広げている間は、本文の表示は動かさない
  if (!e.shiftKey) scrollToPage({ docId: next.docId, page: next.focus });
}

export function Sidebar({ onAddFiles }: { onAddFiles: () => void }) {
  const docOrder = useStore((s) => s.docOrder);
  const current = useStore((s) => s.current);
  const sel = useStore((s) => s.pageSel);
  const asideRef = useRef<HTMLElement>(null);

  // 自分で選んでいない間は、本文で表示しているページに選択が付いていく。
  // 自分で選んだページは動かさない（縮小表示だと、クリックしたページと本文の「現在のページ」が違うことがあり、Delete で別のページを消さないため）
  useEffect(() => {
    if (!current) return;
    const cur = useStore.getState().pageSel;
    if (cur && !cur.follow) return;
    if (cur?.docId === current.docId && cur.pages[0] === current.page) return;
    setPageSel({ ...singlePage(current.docId, current.page), follow: true });
  }, [current]);

  // 本文などをクリックしたら、ページ一覧のキー操作（Delete など）は終える。マスクの Delete と取り違えないため
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const aside = asideRef.current;
      const el = document.activeElement;
      if (aside && el instanceof HTMLElement && aside.contains(el) && !aside.contains(e.target as Node)) {
        el.blur();
        // 本文へ戻ったら、ひとつだけ選んでいた選択は、また本文に付いていく
        const sel = useStore.getState().pageSel;
        if (sel && sel.pages.length === 1 && !sel.follow) setPageSel({ ...sel, follow: true });
      }
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, []);

  return (
    <aside className="sidebar" aria-label="ページ一覧" ref={asideRef}>
      <div className="side-head">
        <span>ページ</span>
        <button className="icon-btn sm" title="PDFを追加（Ctrl+O）" onClick={onAddFiles}>
          <IconPlus size={15} />
        </button>
      </div>
      {sel && sel.pages.length > 1 && (
        <div className="side-selbar">
          <span>{sel.pages.length}ページを選択中</span>
          <button className="icon-btn sm danger" title="選択したページを削除（Delete）" onClick={() => removePages(sel.docId, sel.pages)}>
            <IconTrash size={15} />
          </button>
          <button className="icon-btn sm" title="選択を解除" onClick={() => setPageSel(singlePage(sel.docId, sel.focus))}>
            <IconX size={15} />
          </button>
        </div>
      )}
      <div className="side-scroll" tabIndex={0} role="listbox" aria-label="ページ" aria-multiselectable="true" onKeyDown={onPaneKeyDown}>
        {docOrder.map((id) => (
          <DocThumbs key={id} docId={id} multi={docOrder.length > 1} />
        ))}
      </div>
    </aside>
  );
}

function DocThumbs({ docId, multi }: { docId: string; multi: boolean }) {
  const doc = useStore((s) => s.docs[docId]);
  const layout = useStore((s) => s.layouts[docId]);
  const current = useStore((s) => s.current);
  const selected = useStore(
    useShallow((s) => (s.pageSel?.docId === docId ? s.pageSel.pages : (NONE as number[]))),
  );
  const focusPage = useStore((s) => (s.pageSel?.docId === docId ? s.pageSel.focus : -1));
  const counts = useStore(
    useShallow((s) => {
      const c: Record<number, number> = {};
      for (const m of s.masks) if (m.docId === docId) c[m.page] = (c[m.page] ?? 0) + 1;
      return c;
    }),
  );
  const [collapsed, setCollapsed] = useState(false);
  // 動かしているページ。表示（ドロップ位置の線）には state、判断には ref（再描画を待たずに読める）を使う
  const [dragPages, setDragState] = useState<number[] | null>(null);
  const dragRef = useRef<number[] | null>(null);
  const setDragPages = (pages: number[] | null) => {
    dragRef.current = pages;
    setDragState(pages);
  };
  const [dropAt, setDropAt] = useState<number | null>(null);
  if (!doc || !layout) return null;

  return (
    <section className="side-doc">
      {multi && (
        <div className="side-doc-head">
          <button className={"icon-btn xs" + (collapsed ? "" : " rot90")} onClick={() => setCollapsed(!collapsed)} title="開く・閉じる">
            <IconChevron size={13} />
          </button>
          <span className="side-doc-name" title={doc.name}>
            {doc.name}
          </span>
          <button className="icon-btn xs" title="このファイルを閉じる" onClick={() => confirmClose(docId)}>
            <IconX size={13} />
          </button>
        </div>
      )}
      {!collapsed && (
        <div
          className="thumbs"
          onDragOver={(e) => {
            if (dragRef.current === null) return;
            e.preventDefault();
            setDropAt(dropIndex(e.currentTarget, e.clientY));
          }}
          onDrop={(e) => {
            e.preventDefault();
            // 位置はドロップした座標から求める（直前の dragover の再描画を待たない）
            if (dragRef.current !== null) movePages(docId, dragRef.current, dropIndex(e.currentTarget, e.clientY));
            setDragPages(null);
            setDropAt(null);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
          }}
        >
          {layout.order.map((p, i) => (
            <div key={p} className="thumb-wrap">
              {dropAt === i && dragPages !== null && <div className="drop-line" />}
              <Thumb
                docId={docId}
                page={p}
                index={i}
                info={doc.pages[p]}
                rot={layout.rot[p] ?? 0}
                count={counts[p] ?? 0}
                active={current?.docId === docId && current.page === p}
                selected={selected.includes(p)}
                focused={focusPage === p}
                onPick={(e) => {
                  const mode = { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey };
                  setPageSel(clickPage(useStore.getState().pageSel, docId, layout.order, p, mode));
                  // 追加・範囲の選択では本文を動かさない
                  if (!mode.toggle && !mode.range) scrollToPage({ docId, page: p });
                  (e.currentTarget.closest(".side-scroll") as HTMLElement | null)?.focus({ preventScroll: true });
                }}
                onDragStart={() => {
                  const pages = pagesFor(docId, p);
                  if (pages.length === 1) setPageSel(singlePage(docId, p));
                  setDragPages(pages);
                }}
                onDragEnd={() => {
                  setDragPages(null);
                  setDropAt(null);
                }}
              />
            </div>
          ))}
          {dropAt === layout.order.length && dragPages !== null && <div className="drop-line" />}
        </div>
      )}
    </section>
  );
}

const Thumb = memo(function Thumb({
  docId,
  page,
  index,
  info,
  rot,
  count,
  active,
  selected,
  focused,
  onPick,
  onDragStart,
  onDragEnd,
}: {
  docId: string;
  page: number;
  index: number;
  info: PageInfo;
  rot: Rot;
  count: number;
  active: boolean;
  selected: boolean;
  /** 矢印キーなどで動かしている側（選択の端）。画面の外にならないように一覧をスクロールする */
  focused: boolean;
  onPick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const masks = useStore(useShallow((s) => s.masks.filter((m) => m.docId === docId && m.page === page)));
  const v = viewSize(info.w, info.h, rot);
  const z = THUMB_W / v.w;
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.round(z * dpr * 100) / 100;
  const bmp = usePageBitmap(thumbCache, docId, page, scale, 8, 0, visible);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  useLayoutEffect(() => {
    if (!bmp) return;
    if (baseRef.current) paintPage(baseRef.current, bmp, rot);
    const fx = fxRef.current;
    if (fx && baseRef.current) {
      fx.width = baseRef.current.width;
      fx.height = baseRef.current.height;
      paintMasks(fx, bmp, masks, rot, info.w, info.h);
    }
  }, [bmp, masks, rot, info.w, info.h]);

  return (
    <div
      ref={ref}
      className={"thumb" + (active ? " active" : "") + (selected ? " selected" : "")}
      role="option"
      aria-selected={selected}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onPick}
      onContextMenu={(e) => openPageMenu(e, docId, page)}
      title={`${index + 1}ページ目（クリックで選択・Ctrl／Shift で複数選択・ドラッグで並べ替え・右クリックで削除）`}
    >
      <div className="thumb-img" style={{ width: THUMB_W, height: v.h * z }}>
        <canvas ref={baseRef} style={{ width: "100%", height: "100%" }} />
        <canvas ref={fxRef} style={{ width: "100%", height: "100%" }} />
        {!bmp &&
          masks.map((m) => {
            const r = toViewRect(m, rot, info.w, info.h);
            return <div key={m.id} className="thumb-mask" style={{ left: r.x * z, top: r.y * z, width: r.w * z, height: r.h * z, transform: `rotate(${m.angle ?? 0}deg)` }} />;
          })}
        <div className="thumb-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn xs" title="左に回転" onClick={() => rotatePages(docId, pagesFor(docId, page), -90)}>
            <IconRotL size={13} />
          </button>
          <button className="icon-btn xs" title="右に回転" onClick={() => rotatePages(docId, pagesFor(docId, page), 90)}>
            <IconRotR size={13} />
          </button>
          <button
            className="icon-btn xs danger"
            title="ページを削除（複数選択中なら選択したページすべて）"
            onClick={() => removePages(docId, pagesFor(docId, page))}
          >
            <IconTrash size={13} />
          </button>
        </div>
      </div>
      <div className="thumb-foot">
        <span>{index + 1}</span>
        {count > 0 && <span className="badge">{count}</span>}
      </div>
    </div>
  );
});

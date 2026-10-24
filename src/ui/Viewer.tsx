import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { closeDoc } from "../model/actions";
import { viewSize } from "../model/geometry";
import { select, useStore, type PageRef } from "../model/store";
import type { DocEntry, DocLayout, Rot } from "../model/types";
import { toViewRect } from "../model/geometry";
import { IconX } from "./icons";
import { PageView } from "./PageView";

const SIDE = 36;
const TOP = 18;
const GAP = 34;
const HEADER = 44;

interface PageItem {
  kind: "page";
  docId: string;
  page: number;
  rot: Rot;
  top: number;
  left: number;
  width: number;
  height: number;
  index: number;
  count: number;
}
interface HeaderItem {
  kind: "header";
  docId: string;
  top: number;
  left: number;
  width: number;
}
type Item = PageItem | HeaderItem;

function computeLayout(
  docOrder: string[],
  layouts: Record<string, DocLayout>,
  docs: Record<string, DocEntry>,
  zoom: number,
  viewportW: number,
) {
  let maxW = 0;
  for (const id of docOrder) {
    const d = docs[id];
    const l = layouts[id];
    if (!d || !l) continue;
    for (const p of l.order) {
      const info = d.pages[p];
      maxW = Math.max(maxW, viewSize(info.w, info.h, l.rot[p] ?? 0).w * zoom);
    }
  }
  const width = Math.max(viewportW, maxW + SIDE * 2);
  const items: Item[] = [];
  let y = TOP;
  for (const id of docOrder) {
    const d = docs[id];
    const l = layouts[id];
    if (!d || !l) continue;
    items.push({ kind: "header", docId: id, top: y, left: (width - maxW) / 2, width: maxW });
    y += HEADER;
    l.order.forEach((p, i) => {
      const info = d.pages[p];
      const rot = l.rot[p] ?? 0;
      const v = viewSize(info.w, info.h, rot);
      const w = v.w * zoom;
      const h = v.h * zoom;
      items.push({ kind: "page", docId: id, page: p, rot, top: y, left: (width - w) / 2, width: w, height: h, index: i, count: l.order.length });
      y += h + GAP;
    });
    y += 18;
  }
  return { items, width, height: y + 40, maxW };
}

/** キーボードやツールバーからビューアを操作するための窓口 */
export const viewerApi = {
  zoomBy: (_f: number) => {},
  setZoom: (_z: number) => {},
  fitWidth: () => {},
  fitPage: () => {},
  pageBy: (_d: number) => {},
  pageTo: (_where: "first" | "last") => {},
};

export function Viewer() {
  const docOrder = useStore((s) => s.docOrder);
  const layouts = useStore((s) => s.layouts);
  const docs = useStore((s) => s.docs);
  const zoom = useStore((s) => s.zoom);
  const fitWidth = useStore((s) => s.fitWidth);
  const tool = useStore((s) => s.tool);
  const scrollTarget = useStore((s) => s.scrollTarget);
  const masks = useStore((s) => s.masks);

  const ref = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 1000, h: 800 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const anchorRef = useRef<{ docId: string; page: number; fx: number; fy: number; cx: number; cy: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const spaceRef = useRef(false);

  const layout = useMemo(() => computeLayout(docOrder, layouts, docs, zoom, vp.w), [docOrder, layouts, docs, zoom, vp.w]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // 画面サイズの追従
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setVp({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const maxBaseWidth = useMemo(() => {
    let m = 0;
    for (const id of docOrder) {
      const d = docs[id];
      const l = layouts[id];
      if (!d || !l) continue;
      for (const p of l.order) m = Math.max(m, viewSize(d.pages[p].w, d.pages[p].h, l.rot[p] ?? 0).w);
    }
    return m || 595;
  }, [docOrder, docs, layouts]);

  const anchorAt = useCallback((cx: number, cy: number) => {
    const el = ref.current;
    if (!el) return;
    const x = el.scrollLeft + cx;
    const y = el.scrollTop + cy;
    const pages = layoutRef.current.items.filter((i): i is PageItem => i.kind === "page");
    let it = pages.find((p) => y >= p.top && y <= p.top + p.height + GAP);
    if (!it) it = pages.reduce<PageItem | undefined>((best, p) => (!best || Math.abs(p.top - y) < Math.abs(best.top - y) ? p : best), undefined);
    if (!it) return;
    anchorRef.current = { docId: it.docId, page: it.page, fx: (x - it.left) / it.width, fy: (y - it.top) / it.height, cx, cy };
  }, []);

  const zoomTo = useCallback(
    (z: number, cx?: number, cy?: number, keepFit = false) => {
      const el = ref.current;
      if (!el) return;
      const nz = Math.max(0.2, Math.min(8, z));
      anchorAt(cx ?? el.clientWidth / 2, cy ?? el.clientHeight / 3);
      useStore.setState({ zoom: nz, fitWidth: keepFit });
    },
    [anchorAt],
  );

  // 幅に合わせる
  useLayoutEffect(() => {
    if (!fitWidth || !docOrder.length) return;
    const z = Math.max(0.2, Math.min(5, (vp.w - SIDE * 2 - 4) / maxBaseWidth));
    if (Math.abs(z - zoom) > 0.002) zoomTo(z, undefined, 0, true);
  }, [fitWidth, vp.w, maxBaseWidth, docOrder.length, zoom, zoomTo]);

  // ズーム後、カーソル下の位置を保つ
  useLayoutEffect(() => {
    const a = anchorRef.current;
    const el = ref.current;
    if (!a || !el) return;
    anchorRef.current = null;
    const it = layout.items.find((i): i is PageItem => i.kind === "page" && i.docId === a.docId && i.page === a.page);
    if (!it) return;
    el.scrollTop = it.top + a.fy * it.height - a.cy;
    el.scrollLeft = it.left + a.fx * it.width - a.cx;
    setScroll({ top: el.scrollTop, left: el.scrollLeft });
  }, [layout]);

  // 指定ページへ移動
  useEffect(() => {
    const el = ref.current;
    if (!scrollTarget || !el) return;
    const it = layoutRef.current.items.find(
      (i): i is PageItem => i.kind === "page" && i.docId === scrollTarget.docId && i.page === scrollTarget.page,
    );
    if (!it) return;
    if (scrollTarget.rect) {
      const d = useStore.getState().docs[it.docId];
      const info = d.pages[it.page];
      const v = toViewRect(scrollTarget.rect, it.rot, info.w, info.h);
      const z = useStore.getState().zoom;
      const cy = it.top + (v.y + v.h / 2) * z;
      const cx = it.left + (v.x + v.w / 2) * z;
      const visible = cy > el.scrollTop + 60 && cy < el.scrollTop + el.clientHeight - 60;
      if (!visible) el.scrollTop = cy - el.clientHeight / 2;
      if (cx < el.scrollLeft + 20 || cx > el.scrollLeft + el.clientWidth - 20) el.scrollLeft = cx - el.clientWidth / 2;
    } else {
      el.scrollTop = it.top - 12;
    }
  }, [scrollTarget]);

  // スクロール → 表示範囲・現在のページ
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setScroll({ top: el.scrollTop, left: el.scrollLeft });
    const probe = el.scrollTop + el.clientHeight * 0.35;
    const it = layoutRef.current.items.find(
      (i): i is PageItem => i.kind === "page" && probe >= i.top - GAP && probe <= i.top + i.height,
    );
    const cur = useStore.getState().current;
    if (it && (cur?.docId !== it.docId || cur?.page !== it.page)) useStore.setState({ current: { docId: it.docId, page: it.page } });
  };
  useEffect(onScroll, [layout]);

  // Ctrl+ホイール（トラックパッドのピンチ）でズーム
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
      zoomTo(useStore.getState().zoom * f, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  // スペース長押し・中ボタン・手のひらツールでパン
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return t.closest("input, textarea, select, [contenteditable]") != null;
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e)) {
        e.preventDefault();
        if (!spaceRef.current) {
          spaceRef.current = true;
          ref.current?.classList.add("space-pan");
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceRef.current = false;
        ref.current?.classList.remove("space-pan");
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const onPointerDownCapture = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const wantPan = e.button === 1 || (e.button === 0 && (spaceRef.current || useStore.getState().tool === "hand"));
    if (!wantPan) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const st = el.scrollTop;
    const sl = el.scrollLeft;
    setPanning(true);
    const move = (ev: PointerEvent) => {
      el.scrollTop = st - (ev.clientY - sy);
      el.scrollLeft = sl - (ev.clientX - sx);
    };
    const upFn = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", upFn);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", upFn);
  };

  // 外部から操作するAPI
  const pages = layout.items.filter((i): i is PageItem => i.kind === "page");
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(() => {
    viewerApi.zoomBy = (f) => zoomTo(useStore.getState().zoom * f);
    viewerApi.setZoom = (z) => zoomTo(z);
    viewerApi.fitWidth = () => useStore.setState({ fitWidth: true });
    viewerApi.fitPage = () => {
      const el = ref.current;
      const cur = useStore.getState().current;
      const it = pagesRef.current.find((p) => p.docId === cur?.docId && p.page === cur?.page) ?? pagesRef.current[0];
      if (!el || !it) return;
      const z = useStore.getState().zoom;
      const baseW = it.width / z;
      const baseH = it.height / z;
      const nz = Math.min((el.clientWidth - SIDE * 2) / baseW, (el.clientHeight - 40) / baseH);
      anchorRef.current = { docId: it.docId, page: it.page, fx: 0.5, fy: 0, cx: el.clientWidth / 2, cy: 20 };
      useStore.setState({ zoom: Math.max(0.2, nz), fitWidth: false });
    };
    viewerApi.pageBy = (d) => {
      const cur = useStore.getState().current;
      const list = pagesRef.current;
      const i = list.findIndex((p) => p.docId === cur?.docId && p.page === cur?.page);
      const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + d))];
      if (next && ref.current) ref.current.scrollTop = next.top - 12;
    };
    viewerApi.pageTo = (where) => {
      const list = pagesRef.current;
      const it = where === "first" ? list[0] : list[list.length - 1];
      if (it && ref.current) ref.current.scrollTop = it.top - 12;
    };
  }, [zoomTo]);

  const vTop = scroll.top - vp.h * 0.8;
  const vBottom = scroll.top + vp.h * 1.8;
  const maskCount = useMemo(() => {
    const c: Record<string, number> = {};
    for (const m of masks) c[m.docId] = (c[m.docId] ?? 0) + 1;
    return c;
  }, [masks]);

  return (
    <div
      ref={ref}
      className={"viewer" + (panning ? " panning" : "") + (tool === "hand" ? " hand" : "")}
      onScroll={onScroll}
      onPointerDownCapture={onPointerDownCapture}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("viewer-content")) select([]);
      }}
    >
      <div className="viewer-content" style={{ width: layout.width, height: layout.height }}>
        {layout.items.map((it) => {
          if (it.kind === "header") {
            const d = docs[it.docId];
            return (
              <div key={"h" + it.docId} className="doc-header" style={{ top: it.top, left: it.left, width: it.width }}>
                <span className="doc-name" title={d.name}>
                  {d.name}
                </span>
                <span className="doc-meta">
                  {layouts[it.docId]?.order.length}ページ
                  {maskCount[it.docId] ? ` · マスク ${maskCount[it.docId]}` : ""}
                </span>
                {docOrder.length > 1 && (
                  <button className="icon-btn sm" title="このファイルを閉じる" onClick={() => confirmClose(it.docId)}>
                    <IconX size={14} />
                  </button>
                )}
              </div>
            );
          }
          if (it.top + it.height < vTop || it.top > vBottom) return null;
          const inView = it.top + it.height > scroll.top && it.top < scroll.top + vp.h;
          return (
            <div
              key={it.docId + ":" + it.page}
              className="page-slot"
              style={{ top: it.top, left: it.left, width: it.width, height: it.height }}
              data-doc={it.docId}
              data-page={it.page}
            >
              <PageView
                docId={it.docId}
                page={it.page}
                info={docs[it.docId].pages[it.page]}
                rot={it.rot}
                zoom={zoom}
                priority={inView ? 0 : 2}
              />
              <div className="page-label">
                {it.index + 1} / {it.count}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function confirmClose(docId: string) {
  const s = useStore.getState();
  const n = s.masks.filter((m) => m.docId === docId).length;
  const name = s.docs[docId]?.name ?? "";
  if (n > 0 && !window.confirm(`「${name}」を閉じますか？\nマスク ${n} 件はこの端末に自動保存されており、同じファイルを開くと復元できます。`)) return;
  closeDoc(docId);
}

export type { PageRef };

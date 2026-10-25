import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  addMasks,
  beginGesture,
  cancelGesture,
  deleteMasks,
  deletePages,
  endGesture,
  rotatePages,
  select,
  toast,
  undo,
  updateGesture,
  updateMasks,
  useStore,
} from "../model/store";
import { clampRect, normRect, toBasePoint, toBaseRect, toViewRect, viewSize } from "../model/geometry";
import { maskFrom, suggestSameValues, suggestForSelection } from "../model/actions";
import { rangeRects, rangeText, snapToRange, textUnder, tokenAt, type SnapResult } from "../model/text";
import { ocrSource, ocrState } from "../model/ocr";
import { ensureText, getText, isOcrPage } from "../model/texts";
import { STYLE_LABEL, STYLE_ORDER, type Mask, type PageInfo, type Rect, type Rot } from "../model/types";
import { pageCache, usePageBitmap } from "../render/bitmaps";
import { paintMasks, paintPage, type PaintMask } from "../render/paint";
import { openContextMenu, type MenuItem } from "./ContextMenu";
import { IconRotL, IconRotR, IconTrash, IconWand } from "./icons";
import { SelectionToolbar, STYLE_ICON } from "./SelectionToolbar";

type Drag =
  | { kind: "create"; start: [number, number]; cur: [number, number]; sx: number; sy: number; moved: boolean; alt: boolean }
  | { kind: "move"; ids: string[]; start: [number, number]; orig: Map<string, Rect>; moved: boolean }
  | { kind: "resize"; id: string; handle: string; orig: Rect; moved: boolean }
  | { kind: "marquee"; start: [number, number]; cur: [number, number]; base: string[] };

interface Hover {
  key: string;
  rects: Rect[];
  text: string;
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

interface Props {
  docId: string;
  page: number;
  info: PageInfo;
  rot: Rot;
  zoom: number;
  priority: number;
}

function PageViewImpl({ docId, page, info, rot, zoom, priority }: Props) {
  const dpr = window.devicePixelRatio || 1;
  const view = viewSize(info.w, info.h, rot);
  const cssW = view.w * zoom;
  const cssH = view.h * zoom;
  const maxScale = Math.sqrt(12_000_000 / Math.max(1, info.w * info.h));
  const target = Math.min(maxScale, Math.max(0.4, Math.round(zoom * dpr * 20) / 20));
  const bmp = usePageBitmap(pageCache, docId, page, target, priority, 160);

  const masks = useStore(useShallow((s) => s.masks.filter((m) => m.docId === docId && m.page === page)));
  const selection = useStore((s) => s.selection);
  const toolbarOn = useStore((s) => s.toolbar);
  const tool = useStore((s) => s.tool);
  const peek = useStore((s) => s.peek);
  const defStyle = useStore((s) => s.style);
  const defLevel = useStore((s) => s.level);
  const defStrength = useStore((s) => s.strength);
  const defColor = useStore((s) => s.fillColor);
  const defOpacity = useStore((s) => s.fillOpacity);
  const defLabel = useStore((s) => s.label);
  useStore((s) => s.textVersion);
  useStore((s) => s.ocr);
  const ocrSt = ocrState(docId, page);
  const ocrFrom = ocrSource(docId, page);
  const ocrRead = isOcrPage(docId, page);
  const panel = useStore((s) => s.panel);
  const hits = useStore(
    useShallow((s) => (s.panel === "search" ? s.search.hits.filter((h) => h.docId === docId && h.page === page) : [])),
  );
  const activeHit = useStore((s) => s.search.hits[s.search.active]?.key);
  const excluded = useStore((s) => s.search.excluded);
  const sugHits = useStore(
    useShallow((s) => (s.suggestion ? s.suggestion.hits.filter((h) => h.docId === docId && h.page === page) : [])),
  );
  const idx = getText(docId, page);
  const hasText = idx ? idx.text.chars.some((c) => c.trim()) : undefined;

  useEffect(() => {
    ensureText(docId, page, 1).catch(() => {});
  }, [docId, page]);

  const baseRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [preview, setPreview] = useState<(SnapResult & { free?: boolean })[]>([]);

  const setDragBoth = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  // ページ画像
  useLayoutEffect(() => {
    if (bmp && baseRef.current) paintPage(baseRef.current, bmp, rot);
  }, [bmp, rot]);

  // マスクの効果（モザイク・ぼかし・塗り）
  const previewMasks: PaintMask[] = useMemo(
    () =>
      preview.map((p) => ({
        ...p.rect,
        style: defStyle,
        level: defLevel,
        strength: defStrength,
        color: defColor,
        opacity: defOpacity,
        label: defLabel,
      })),
    [preview, defStyle, defLevel, defStrength, defColor, defOpacity, defLabel],
  );
  useLayoutEffect(() => {
    const c = fxRef.current;
    if (!c || !bmp) return;
    const swap = rot === 90 || rot === 270;
    const w = swap ? bmp.height : bmp.width;
    const h = swap ? bmp.width : bmp.height;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    paintMasks(c, bmp, peek ? [] : [...masks, ...previewMasks], rot, info.w, info.h);
  }, [bmp, masks, previewMasks, peek, rot, info.w, info.h]);

  const toBase = (clientX: number, clientY: number): [number, number] => {
    const r = overlayRef.current!.getBoundingClientRect();
    return toBasePoint((clientX - r.left) / zoom, (clientY - r.top) / zoom, rot, info.w, info.h);
  };
  const toView = (r: Rect) => {
    const v = toViewRect(r, rot, info.w, info.h);
    return { left: v.x * zoom, top: v.y * zoom, width: v.w * zoom, height: v.h * zoom };
  };

  // ---- ポインタ操作 ----

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st = useStore.getState();
    if (st.tool === "hand" || (e.target as HTMLElement).closest(".sel-toolbar")) return;
    e.preventDefault();
    const p = toBase(e.clientX, e.clientY);
    const el = e.target as HTMLElement;
    const box = el.closest<HTMLElement>("[data-mask-id]");
    overlayRef.current?.setPointerCapture(e.pointerId);
    useStore.setState({ suggestion: null });

    if (box) {
      const id = box.dataset.maskId!;
      const m = st.masks.find((x) => x.id === id);
      if (!m) return;
      if (el.dataset.handle) {
        select(st.selection.includes(id) ? st.selection : [id]);
        setDragBoth({ kind: "resize", id, handle: el.dataset.handle, orig: { x: m.x, y: m.y, w: m.w, h: m.h }, moved: false });
        return;
      }
      let sel = st.selection;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
        select(sel);
        if (!sel.includes(id)) return;
      } else if (!sel.includes(id)) {
        sel = [id];
        select(sel);
      } else {
        useStore.setState({ toolbar: true });
      }
      const ids = sel.filter((sid) => {
        const mm = st.masks.find((x) => x.id === sid);
        return mm && mm.docId === docId && mm.page === page;
      });
      const orig = new Map<string, Rect>();
      for (const sid of ids) {
        const mm = st.masks.find((x) => x.id === sid)!;
        orig.set(sid, { x: mm.x, y: mm.y, w: mm.w, h: mm.h });
      }
      setDragBoth({ kind: "move", ids, start: p, orig, moved: false });
      return;
    }

    if (st.tool === "select" || e.shiftKey) {
      setDragBoth({ kind: "marquee", start: p, cur: p, base: e.shiftKey ? st.selection : [] });
      if (!e.shiftKey) select([]);
      return;
    }
    setDragBoth({ kind: "create", start: p, cur: p, sx: e.clientX, sy: e.clientY, moved: false, alt: e.altKey });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const p = toBase(e.clientX, e.clientY);
    if (!d) {
      updateHover(p);
      return;
    }
    if (d.kind === "create") {
      const moved = d.moved || Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4;
      const nd = { ...d, cur: p, moved, alt: e.altKey };
      setDragBoth(nd);
      if (moved) {
        setHover(null);
        setPreview(computePreview(nd));
      }
      return;
    }
    if (d.kind === "move") {
      const dx = p[0] - d.start[0];
      const dy = p[1] - d.start[1];
      if (!d.moved && Math.hypot(dx, dy) * zoom < 3) return;
      if (!d.moved) {
        beginGesture();
        dragRef.current = { ...d, moved: true };
      }
      updateGesture((s) => ({
        masks: s.masks.map((m) => {
          const o = d.orig.get(m.id);
          if (!o) return m;
          const x = Math.max(-o.w / 2, Math.min(info.w - o.w / 2, o.x + dx));
          const y = Math.max(-o.h / 2, Math.min(info.h - o.h / 2, o.y + dy));
          return { ...m, x, y };
        }),
      }));
      return;
    }
    if (d.kind === "resize") {
      if (!d.moved) {
        beginGesture();
        dragRef.current = { ...d, moved: true };
      }
      const v = toViewRect(d.orig, rot, info.w, info.h);
      const r = overlayRef.current!.getBoundingClientRect();
      const u = (e.clientX - r.left) / zoom;
      const w = (e.clientY - r.top) / zoom;
      let x0 = v.x;
      let y0 = v.y;
      let x1 = v.x + v.w;
      let y1 = v.y + v.h;
      if (d.handle.includes("w")) x0 = u;
      if (d.handle.includes("e")) x1 = u;
      if (d.handle.includes("n")) y0 = w;
      if (d.handle.includes("s")) y1 = w;
      const nv = normRect(x0, y0, x1, y1);
      nv.w = Math.max(2, nv.w);
      nv.h = Math.max(2, nv.h);
      const nb = clampRect(toBaseRect(nv, rot, info.w, info.h), info.w, info.h);
      updateGesture((s) => ({ masks: s.masks.map((m) => (m.id === d.id ? { ...m, ...nb } : m)) }));
      return;
    }
    if (d.kind === "marquee") {
      const nd = { ...d, cur: p };
      setDragBoth(nd);
      const area = normRect(d.start[0], d.start[1], p[0], p[1]);
      const inside = useStore
        .getState()
        .masks.filter(
          (m) =>
            m.docId === docId &&
            m.page === page &&
            m.x < area.x + area.w &&
            area.x < m.x + m.w &&
            m.y < area.y + area.h &&
            area.y < m.y + m.h,
        )
        .map((m) => m.id);
      select([...new Set([...d.base, ...inside])]);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    setDragBoth(null);
    if (!d) return;
    if (d.kind === "move" || d.kind === "resize") {
      if (d.moved) endGesture();
      return;
    }
    if (d.kind === "marquee") return;
    // マスクを作る
    if (!d.moved) {
      const p = toBase(e.clientX, e.clientY);
      const st = useStore.getState();
      if (st.tool === "mask" && idx && st.snap !== "free") {
        const t = tokenAt(idx, p[0], p[1], st.snap);
        if (t) {
          const text = rangeText(idx, t[0], t[1]);
          const created = rangeRects(idx, t[0], t[1]).map((r) => maskFrom(docId, page, r, text));
          addMasks(created);
          setHover(null);
          suggestSameValues([text]);
          return;
        }
      }
      select([]);
      return;
    }
    const pv = computePreview(d);
    setPreview([]);
    const created = pv
      .filter((s) => s.rect.w * zoom >= 3 && s.rect.h * zoom >= 3)
      .map((s) => maskFrom(docId, page, s.rect, s.free ? undefined : s.text));
    if (!created.length) return;
    addMasks(created);
    if (!pv[0].free) suggestSameValues(pv.map((s) => s.text));
  };

  const computePreview = (d: Extract<Drag, { kind: "create" }>): (SnapResult & { free?: boolean })[] => {
    const area = clampRect(normRect(d.start[0], d.start[1], d.cur[0], d.cur[1]), info.w, info.h);
    const st = useStore.getState();
    const free = d.alt || st.snap === "free" || !idx || !hasText;
    if (!free) {
      const snapped = snapToRange(idx!, area, st.snap);
      if (snapped.length) return snapped;
    }
    return [{ rect: area, text: idx ? textUnder(idx, area) : "", free: true }];
  };

  const updateHover = (p: [number, number]) => {
    const st = useStore.getState();
    if (st.tool !== "mask" || st.snap === "free" || !idx) {
      if (hover) setHover(null);
      return;
    }
    const t = tokenAt(idx, p[0], p[1], st.snap);
    if (!t) {
      if (hover) setHover(null);
      return;
    }
    const key = `${t[0]}:${t[1]}`;
    if (hover?.key === key) return;
    setHover({ key, rects: rangeRects(idx, t[0], t[1]), text: rangeText(idx, t[0], t[1]) });
  };

  const onPointerCancel = () => {
    if (dragRef.current?.kind === "move" || dragRef.current?.kind === "resize") cancelGesture();
    setDragBoth(null);
    setPreview([]);
  };

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onPointerCancel();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const st = useStore.getState();
    const box = (e.target as HTMLElement).closest<HTMLElement>("[data-mask-id]");
    const items: MenuItem[] = [];
    if (box) {
      const id = box.dataset.maskId!;
      const ids = st.selection.includes(id) ? st.selection : [id];
      if (!st.selection.includes(id)) select([id]);
      STYLE_ORDER.forEach((s, i) => {
        const Icon = STYLE_ICON[s];
        items.push({ label: STYLE_LABEL[s], shortcut: String(i + 1), icon: <Icon size={15} />, run: () => updateMasks(ids, { style: s }) });
      });
      items.push({ separator: true, label: "" });
      items.push({ label: "同じ値をほかからも探す", icon: <IconWand size={15} />, run: suggestForSelection });
      items.push({ label: `削除（${ids.length}件）`, shortcut: "Del", icon: <IconTrash size={15} />, danger: true, run: () => deleteMasks(ids) });
    } else {
      const pageMasks = st.masks.filter((m) => m.docId === docId && m.page === page).map((m) => m.id);
      items.push({ label: "このページのマスクをすべて選択", shortcut: "Ctrl+A", disabled: !pageMasks.length, run: () => select(pageMasks) });
      items.push({ separator: true, label: "" });
      items.push({ label: "ページを左に回転", shortcut: "Ctrl+L", icon: <IconRotL size={15} />, run: () => rotatePages(docId, [page], -90) });
      items.push({ label: "ページを右に回転", shortcut: "Ctrl+R", icon: <IconRotR size={15} />, run: () => rotatePages(docId, [page], 90) });
      items.push({
        label: "このページを削除",
        shortcut: "Ctrl+D",
        icon: <IconTrash size={15} />,
        danger: true,
        run: () => {
          if (!deletePages(docId, [page])) toast({ message: "最後の1ページは削除できません", tone: "warn" });
          else toast({ message: "ページを削除しました", action: { label: "元に戻す", run: undo } });
        },
      });
    }
    openContextMenu(e.clientX, e.clientY, items);
  };

  // ---- 表示 ----

  const selSet = new Set(selection);
  const selectedHere = masks.filter((m) => selSet.has(m.id));
  const anchorId = selection[selection.length - 1];
  const showToolbar = toolbarOn && !drag && selectedHere.some((m) => m.id === anchorId);
  let toolbarPos: { left: number; top: number; below: boolean } | null = null;
  if (showToolbar) {
    const vs = selectedHere.map(toView);
    const left = Math.min(...vs.map((v) => v.left));
    const right = Math.max(...vs.map((v) => v.left + v.width));
    const top = Math.min(...vs.map((v) => v.top));
    const bottom = Math.max(...vs.map((v) => v.top + v.height));
    const below = top < 56;
    toolbarPos = { left: Math.max(150, Math.min(cssW - 150, (left + right) / 2)), top: below ? bottom + 10 : top - 10, below };
  }
  const createRect = drag?.kind === "create" && drag.moved ? toView(normRect(drag.start[0], drag.start[1], drag.cur[0], drag.cur[1])) : null;
  const marqueeRect = drag?.kind === "marquee" ? toView(normRect(drag.start[0], drag.start[1], drag.cur[0], drag.cur[1])) : null;
  const excludedSet = new Set(excluded);
  const cursorClass =
    tool === "hand" ? "cur-hand" : tool === "select" ? "cur-select" : hover ? "cur-token" : "cur-mask";

  return (
    <div className="page" style={{ width: cssW, height: cssH }}>
      <canvas ref={baseRef} className="page-canvas" style={{ width: cssW, height: cssH, opacity: bmp ? 1 : 0 }} />
      <canvas ref={fxRef} className="page-canvas fx" style={{ width: cssW, height: cssH }} />
      {!bmp && <div className="page-loading" />}
      <div
        ref={overlayRef}
        className={"page-overlay " + cursorClass + (peek ? " peek" : "")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => !dragRef.current && hover && setHover(null)}
        onContextMenu={onContextMenu}
      >
        {panel === "search" &&
          hits.map((h) =>
            h.rects.map((r, i) => (
              <div
                key={h.key + i}
                className={"hit" + (h.key === activeHit ? " active" : "") + (excludedSet.has(h.key) ? " excluded" : "")}
                style={toView(r)}
              />
            )),
          )}
        {sugHits.map((h, hi) => h.rects.map((r, i) => <div key={`s${hi}-${i}`} className="sug-hit" style={toView(r)} />))}
        {hover && tool === "mask" && !drag && hover.rects.map((r, i) => <div key={i} className="hover-token" style={toView(r)} />)}
        {masks.map((m) => (
          <MaskBox key={m.id} mask={m} selected={selSet.has(m.id)} style={toView(m)} peek={peek} />
        ))}
        {createRect && (
          <div className={"rubber" + (preview[0]?.free ? " free" : "")} style={createRect}>
            <span className="rubber-tag">
              {preview[0]?.free ? "範囲そのまま" : `${preview.length}か所に吸着`}
            </span>
          </div>
        )}
        {drag?.kind === "create" && drag.moved && !preview[0]?.free &&
          preview.map((p, i) => <div key={i} className="snap-box" style={toView(p.rect)} />)}
        {marqueeRect && <div className="marquee" style={marqueeRect} />}
        {ocrSt === "queued" || ocrSt === "running" ? (
          <div className="page-badge ocr">
            <i className="spinner" aria-hidden="true" />
            {ocrSt === "running" ? "スキャン画像の文字を認識中…" : "文字認識の順番待ち"}
          </div>
        ) : ocrRead && !peek ? (
          <div className="page-badge ocr done">
            {ocrFrom === "cloud" ? "クラウドで文字認識済み・目で確認を" : "文字認識（OCR）済み・目で確認を"}
          </div>
        ) : (
          tool === "mask" && hasText === false && <div className="page-badge">画像のみ・範囲指定で隠せます</div>
        )}
        {toolbarPos && <SelectionToolbar {...toolbarPos} />}
      </div>
    </div>
  );
}

const MaskBox = memo(function MaskBox({
  mask,
  selected,
  style,
  peek,
}: {
  mask: Mask;
  selected: boolean;
  style: React.CSSProperties;
  peek: boolean;
}) {
  return (
    <div
      className={"mask-box" + (selected ? " selected" : "") + (peek ? " peek" : "") + ` st-${mask.style}`}
      style={style}
      data-mask-id={mask.id}
    >
      {selected && HANDLES.map((h) => <span key={h} className={`handle h-${h}`} data-handle={h} />)}
    </div>
  );
});

export const PageView = memo(PageViewImpl);

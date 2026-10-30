import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toViewRect, viewSize } from "../model/geometry";
import { deletePages, movePage, rotatePages, scrollToPage, toast, undo, useStore } from "../model/store";
import type { PageInfo, Rot } from "../model/types";
import { thumbCache, usePageBitmap } from "../render/bitmaps";
import { paintMasks, paintPage } from "../render/paint";
import { IconChevron, IconPlus, IconRotL, IconRotR, IconTrash, IconX } from "./icons";
import { confirmClose } from "./Viewer";

const THUMB_W = 128;

export function Sidebar({ onAddFiles }: { onAddFiles: () => void }) {
  const docOrder = useStore((s) => s.docOrder);
  return (
    <aside className="sidebar" aria-label="ページ一覧">
      <div className="side-head">
        <span>ページ</span>
        <button className="icon-btn sm" title="PDFを追加（Ctrl+O）" onClick={onAddFiles}>
          <IconPlus size={15} />
        </button>
      </div>
      <div className="side-scroll">
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
  const counts = useStore(
    useShallow((s) => {
      const c: Record<number, number> = {};
      for (const m of s.masks) if (m.docId === docId) c[m.page] = (c[m.page] ?? 0) + 1;
      return c;
    }),
  );
  const [collapsed, setCollapsed] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
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
            if (dragFrom === null) return;
            e.preventDefault();
            const items = [...e.currentTarget.querySelectorAll<HTMLElement>(".thumb")];
            let at = items.length;
            for (let i = 0; i < items.length; i++) {
              const r = items[i].getBoundingClientRect();
              if (e.clientY < r.top + r.height / 2) {
                at = i;
                break;
              }
            }
            setDropAt(at);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragFrom !== null && dropAt !== null) {
              const to = dropAt > dragFrom ? dropAt - 1 : dropAt;
              if (to !== dragFrom) movePage(docId, dragFrom, to);
            }
            setDragFrom(null);
            setDropAt(null);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
          }}
        >
          {layout.order.map((p, i) => (
            <div key={p} className="thumb-wrap">
              {dropAt === i && dragFrom !== null && <div className="drop-line" />}
              <Thumb
                docId={docId}
                page={p}
                index={i}
                info={doc.pages[p]}
                rot={layout.rot[p] ?? 0}
                count={counts[p] ?? 0}
                active={current?.docId === docId && current.page === p}
                onDragStart={() => setDragFrom(i)}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDropAt(null);
                }}
              />
            </div>
          ))}
          {dropAt === layout.order.length && dragFrom !== null && <div className="drop-line" />}
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
      className={"thumb" + (active ? " active" : "")}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={() => scrollToPage({ docId, page })}
      title={`${index + 1}ページ目（ドラッグで並べ替え）`}
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
          <button className="icon-btn xs" title="左に回転" onClick={() => rotatePages(docId, [page], -90)}>
            <IconRotL size={13} />
          </button>
          <button className="icon-btn xs" title="右に回転" onClick={() => rotatePages(docId, [page], 90)}>
            <IconRotR size={13} />
          </button>
          <button
            className="icon-btn xs danger"
            title="ページを削除"
            onClick={() => {
              if (!deletePages(docId, [page])) toast({ message: "最後の1ページは削除できません", tone: "warn" });
              else toast({ message: `${index + 1}ページ目を削除しました`, action: { label: "元に戻す", run: undo } });
            }}
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

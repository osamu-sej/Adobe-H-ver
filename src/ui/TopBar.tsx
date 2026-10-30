import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { BUILD_LABEL, VERSION_LABEL } from "../buildInfo";
import { redo, toast, undo, updateMasks, useStore } from "../model/store";
import {
  LEVEL_HINT,
  LEVEL_LABEL,
  LEVEL_ORDER,
  SNAP_LABEL,
  STYLE_LABEL,
  STYLE_ORDER,
  type Level,
  type MaskStyle,
  type SnapMode,
  type Tool,
} from "../model/types";
import {
  IconCrop,
  IconDownload,
  IconEye,
  IconFolderOpen,
  IconHand,
  IconTextBox,
  IconHash,
  IconHelp,
  IconSettings,
  IconList,
  IconMask,
  IconMaximize,
  IconMinimize,
  IconMinus,
  IconPlus,
  IconPointer,
  IconRedo,
  IconSearch,
  IconSidebar,
  IconType,
  IconUndo,
  IconX,
} from "./icons";
import { colorName, FillPopover, FillSwatch } from "./FillPicker";
import { STYLE_ICON } from "./SelectionToolbar";
import { viewerApi } from "./Viewer";

const TOOLS: { id: Tool; label: string; key: string; icon: React.ReactNode }[] = [
  { id: "mask", label: "マスク", key: "M", icon: <IconMask /> },
  { id: "select", label: "選択", key: "V", icon: <IconPointer /> },
  { id: "text", label: "テキスト枠", key: "T", icon: <IconTextBox /> },
  { id: "hand", label: "手のひら", key: "H", icon: <IconHand /> },
];

const SNAPS: { id: SnapMode; label: string; icon: React.ReactNode }[] = [
  { id: "digits", label: "数字", icon: <IconHash size={16} /> },
  { id: "text", label: "文字", icon: <IconType size={16} /> },
  { id: "free", label: "自由", icon: <IconCrop size={16} /> },
];

export function setStyle(style: MaskStyle) {
  const s = useStore.getState();
  if (s.selection.length) updateMasks(s.selection, { style });
  useStore.setState({ style });
}

/** 程度（弱・中・強）を選ぶ。選択中のマスクにも適用し、細かい調整は解除する */
export function setLevel(level: Level) {
  const s = useStore.getState();
  if (s.selection.length) updateMasks(s.selection, { level, strength: null });
  useStore.setState({ level, strength: null });
}

/** [ ] キー：程度を1段階ずつ変える */
export function stepLevel(dir: 1 | -1) {
  const s = useStore.getState();
  const sel = s.masks.find((m) => s.selection.includes(m.id) && (m.style === "mosaic" || m.style === "blur"));
  const cur = sel ? sel.level : s.level;
  const next = LEVEL_ORDER[Math.max(0, Math.min(LEVEL_ORDER.length - 1, LEVEL_ORDER.indexOf(cur) + dir))];
  setLevel(next);
  toast({ message: `程度：${LEVEL_LABEL[next]}（${LEVEL_HINT[next]}）`, duration: 1400 });
}

export function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

export function TopBar({ onOpen }: { onOpen: () => void }) {
  const tool = useStore((s) => s.tool);
  const style = useStore((s) => s.style);
  const snap = useStore((s) => s.snap);
  const label = useStore((s) => s.label);
  const peek = useStore((s) => s.peek);
  const panel = useStore((s) => s.panel);
  const sidebar = useStore((s) => s.sidebar);
  const zoom = useStore((s) => s.zoom);
  const fitWidth = useStore((s) => s.fitWidth);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const maskCount = useStore((s) => s.masks.length);
  const selStyles = useStore((s) => {
    if (!s.selection.length) return null;
    const set = new Set(s.masks.filter((m) => s.selection.includes(m.id)).map((m) => m.style));
    return set.size === 1 ? [...set][0] : "mixed";
  });
  const [fs, setFs] = useState(false);
  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const level = useStore((s) => s.level);
  const strength = useStore((s) => s.strength);
  const selLevel = useStore((s) => {
    const sel = s.masks.filter((m) => s.selection.includes(m.id) && (m.style === "mosaic" || m.style === "blur"));
    if (!sel.length) return null;
    if (sel.some((m) => m.strength !== null)) return "custom";
    const set = new Set(sel.map((m) => m.level));
    return set.size === 1 ? [...set][0] : "mixed";
  });
  const shownStyle = selStyles && selStyles !== "mixed" ? selStyles : style;
  const shownLevel = selLevel ?? (strength !== null ? "custom" : level);
  const fillColor = useStore((s) => s.fillColor);
  const fillOpacity = useStore((s) => s.fillOpacity);
  const selFill = useStore(
    useShallow((s) => {
      const sel = s.masks.filter((m) => m.style === "fill" && s.selection.includes(m.id));
      if (!sel.length) return null;
      const same = <T,>(vals: T[]) => (vals.every((v) => v === vals[0]) ? vals[0] : undefined);
      return { color: same(sel.map((m) => m.color)), opacity: same(sel.map((m) => m.opacity)) };
    }),
  );
  const shownFill = selFill ?? { color: fillColor, opacity: fillOpacity };
  const showFill = selLevel === null && shownStyle === "fill";
  const [fillOpen, setFillOpen] = useState(false);
  const closeFill = useCallback(() => setFillOpen(false), []);

  return (
    <header className="topbar">
      <div className="tb-left">
        <button
          className={"icon-btn" + (sidebar ? " active" : "")}
          title="ページ一覧の表示（Tab で全パネル切替）"
          onClick={() => useStore.setState({ sidebar: !sidebar })}
        >
          <IconSidebar />
        </button>
        <div className="brand" title={`カクス ${VERSION_LABEL}（${BUILD_LABEL}）— PDFモザイク・墨消し`}>
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="brand-name">カクス</span>
        </div>
        <button className="tb-btn wide ghost" title="PDFを開く（Ctrl+O）・ドロップでも開けます" onClick={onOpen}>
          <IconFolderOpen size={17} />
          <span className="lbl">開く</span>
        </button>
      </div>

      <div className="tb-center">
        <div className="seg" role="radiogroup" aria-label="ツール">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={tool === t.id}
              className={"tb-btn" + (tool === t.id ? " active" : "")}
              title={`${t.label}（${t.key}）`}
              onClick={() => useStore.setState({ tool: t.id })}
            >
              {t.icon}
            </button>
          ))}
        </div>

        <div className="seg styles" role="radiogroup" aria-label="隠し方">
          {STYLE_ORDER.map((s, i) => {
            const Icon = STYLE_ICON[s];
            return (
              <button
                key={s}
                role="radio"
                aria-checked={shownStyle === s}
                className={"tb-btn wide" + (shownStyle === s ? " active" : "") + (selStyles === "mixed" ? " mixed" : "")}
                title={`${STYLE_LABEL[s]}（${i + 1}）${selStyles ? "：選択中のマスクにも適用" : ""}`}
                onClick={() => setStyle(s)}
              >
                <Icon size={17} />
                <span className="lbl">{STYLE_LABEL[s]}</span>
              </button>
            );
          })}
        </div>

        {showFill ? (
          <div className="seg fills">
            <span className="seg-label">色</span>
            <div className="pop-anchor">
              <button
                className={"tb-btn wide" + (fillOpen ? " active" : "")}
                title={`塗りの色と透明度${selFill ? "：選択中のマスクにも適用" : ""}`}
                aria-expanded={fillOpen}
                onClick={() => setFillOpen(!fillOpen)}
              >
                {shownFill.color === undefined ? (
                  <span className="fill-swatch mixed" aria-hidden="true" />
                ) : (
                  <FillSwatch color={shownFill.color} opacity={shownFill.opacity ?? 1} />
                )}
                <span className="fill-name">
                  {shownFill.color === undefined ? "混在" : colorName(shownFill.color)}
                  {shownFill.opacity !== undefined && shownFill.opacity < 1 && (
                    <span className="muted"> 透明度{Math.round((1 - shownFill.opacity) * 100)}%</span>
                  )}
                </span>
              </button>
              {fillOpen && <FillPopover color={shownFill.color} opacity={shownFill.opacity} onClose={closeFill} />}
            </div>
          </div>
        ) : (
          <div className="seg levels" role="radiogroup" aria-label="モザイク・ぼかしの程度">
            <span className="seg-label">程度</span>
            {LEVEL_ORDER.map((l) => (
              <button
                key={l}
                role="radio"
                aria-checked={shownLevel === l}
                className={"tb-btn" + (shownLevel === l ? " active" : "")}
                title={`${LEVEL_LABEL[l]}：${LEVEL_HINT[l]}（[ と ] で切替）${selLevel ? "：選択中のマスクにも適用" : ""}`}
                onClick={() => setLevel(l)}
              >
                {LEVEL_LABEL[l]}
              </button>
            ))}
          </div>
        )}

        <div className="seg" role="radiogroup" aria-label="吸着">
          {SNAPS.map((s) => (
            <button
              key={s.id}
              role="radio"
              aria-checked={snap === s.id}
              className={"tb-btn wide" + (snap === s.id ? " active" : "")}
              title={`${SNAP_LABEL[s.id]}（S で切替・Alt+ドラッグで一時的に自由範囲）`}
              onClick={() => useStore.setState({ snap: s.id })}
            >
              {s.icon}
              <span className="lbl">{s.label}</span>
            </button>
          ))}
        </div>
        {label && (
          <span className="chip on removable" title="新しいマスクに重ねる文言">
            文言：{label}
            <button aria-label="文言をやめる" onClick={() => useStore.setState({ label: null })}>
              <IconX size={12} />
            </button>
          </span>
        )}
      </div>

      <div className="tb-right">
        <button
          className={"icon-btn" + (panel === "search" ? " active" : "")}
          title="検索して隠す（Ctrl+F）"
          onClick={() => useStore.setState({ panel: panel === "search" ? null : "search" })}
        >
          <IconSearch />
        </button>
        <button
          className={"icon-btn with-badge" + (panel === "masks" ? " active" : "")}
          title="マスク一覧（L）"
          onClick={() => useStore.setState({ panel: panel === "masks" ? null : "masks" })}
        >
          <IconList />
          {maskCount > 0 && <span className="badge">{maskCount}</span>}
        </button>
        <button
          className={"icon-btn" + (peek ? " active" : "")}
          title="原本を確認する（クリックで切替・P を押している間だけ表示も可）"
          aria-pressed={peek}
          onClick={() => useStore.setState({ peek: !peek })}
        >
          <IconEye />
        </button>
        <span className="tb-div" />
        <button className="icon-btn" title="元に戻す（Ctrl+Z）" disabled={!canUndo} onClick={() => undo()}>
          <IconUndo />
        </button>
        <button className="icon-btn" title="やり直す（Ctrl+Shift+Z）" disabled={!canRedo} onClick={() => redo()}>
          <IconRedo />
        </button>
        <span className="tb-div" />
        <div className="zoom">
          <button className="icon-btn sm" title="縮小（Ctrl+-）" onClick={() => viewerApi.zoomBy(1 / 1.2)}>
            <IconMinus size={15} />
          </button>
          <select
            className="zoom-select"
            value=""
            title="表示倍率"
            onChange={(e) => {
              const v = e.target.value;
              if (v === "fit") viewerApi.fitWidth();
              else if (v === "page") viewerApi.fitPage();
              else viewerApi.setZoom(Number(v) / 75);
            }}
          >
            <option value="" hidden>
              {fitWidth ? "幅" : `${Math.round(zoom * 75)}%`}
            </option>
            <option value="fit">幅に合わせる（Ctrl+0）</option>
            <option value="page">ページ全体（Ctrl+9）</option>
            {[50, 75, 100, 125, 150, 200, 300, 400].map((p) => (
              <option key={p} value={p}>
                {p}%
              </option>
            ))}
          </select>
          <button className="icon-btn sm" title="拡大（Ctrl++）" onClick={() => viewerApi.zoomBy(1.2)}>
            <IconPlus size={15} />
          </button>
        </div>
        <button className="icon-btn" title="全画面（F）" onClick={toggleFullscreen}>
          {fs ? <IconMinimize /> : <IconMaximize />}
        </button>
        <button className="icon-btn" title="使い方とショートカット（?）" onClick={() => useStore.setState({ helpOpen: true })}>
          <IconHelp />
        </button>
        <button className="icon-btn" title="設定" onClick={() => useStore.setState({ settingsOpen: true })}>
          <IconSettings />
        </button>
        <button className="btn primary export-btn" title="PDFを書き出す（Ctrl+S）" onClick={() => useStore.setState({ exportOpen: true })}>
          <IconDownload size={17} />
          <span>書き出す</span>
        </button>
      </div>
    </header>
  );
}

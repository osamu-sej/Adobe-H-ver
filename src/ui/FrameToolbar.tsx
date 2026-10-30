import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { clampSize, FRAME_SIZES, FRAME_TEXT_COLORS, neededHeight, stepSize } from "../fx/frames";
import { deleteFrames, patchFrames, toast, undo, useStore } from "../model/store";
import { FILL_COLORS, type TextFrame } from "../model/types";
import { IconAlignCenter, IconAlignLeft, IconAlignRight, IconTrash } from "./icons";

/** 選んでいる枠の文字の大きさを、段階（8, 9, 10, … 96）で1つ大きく・小さくする */
export function changeFrameSize(dir: 1 | -1) {
  const s = useStore.getState();
  const ids = s.frameSel;
  if (!ids.length) return;
  patchFrames(ids, (f) => resize(f, stepSize(f.size, dir)));
}

/** 文字の大きさを変える。文字が枠に入りきらなくなったら、枠を下に広げる */
export function setFrameSize(ids: string[], size: number) {
  patchFrames(ids, (f) => resize(f, clampSize(size)));
}

function resize(f: TextFrame, size: number): Partial<TextFrame> {
  return { size, h: Math.max(f.h, neededHeight({ ...f, size })) };
}

/** 太字にする・戻す。字幅が変わって折り返しが増えたら、枠を下に広げる */
export function setFrameBold(ids: string[], bold: boolean | ((f: TextFrame) => boolean)) {
  patchFrames(ids, (f) => {
    const next = typeof bold === "function" ? bold(f) : bold;
    return { bold: next, h: Math.max(f.h, neededHeight({ ...f, bold: next })) };
  });
}

/** 文字の大きさの欄：数字を入れて Enter、または一覧から選ぶ。↑↓で段階を上下 */
function SizeInput({ ids, size }: { ids: string[]; size: number | undefined }) {
  const shown = size === undefined ? "" : String(Math.round(size * 10) / 10);
  const [value, setValue] = useState(shown);
  const [focus, setFocus] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!focus) setValue(shown);
  }, [shown, focus]);
  const apply = (raw: string) => {
    const v = Number(raw.replace(/[^\d.]/g, ""));
    if (!raw.trim() || !Number.isFinite(v) || v <= 0) {
      setValue(shown);
      return;
    }
    setFrameSize(ids, v);
  };
  return (
    <div className="pop-anchor size-box">
      <input
        className="size-input"
        type="text"
        inputMode="decimal"
        aria-label="文字の大きさ（pt）"
        title="文字の大きさ（pt）。数字を入れて Enter。↑↓で段階を変える"
        value={value}
        placeholder="—"
        onFocus={(e) => {
          setFocus(true);
          e.currentTarget.select();
        }}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setFocus(false);
          apply(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            apply(value);
            e.currentTarget.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const base = Number(value) || size || 14;
            const next = stepSize(base, e.key === "ArrowUp" ? 1 : -1);
            setValue(String(next));
            setFrameSize(ids, next);
          } else if (e.key === "Escape") {
            setValue(shown);
            e.currentTarget.blur();
            e.stopPropagation();
          }
        }}
      />
      <button
        className={"tb-btn size-drop" + (open ? " active" : "")}
        title="文字の大きさの一覧"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        ▾
      </button>
      {open && (
        <div className="popover size-list" role="listbox" aria-label="文字の大きさ">
          {FRAME_SIZES.map((n) => (
            <button
              key={n}
              role="option"
              aria-selected={size === n}
              className={"size-item" + (size === n ? " on" : "")}
              onClick={() => {
                setFrameSize(ids, n);
                setOpen(false);
              }}
            >
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Swatches({
  colors,
  value,
  none,
  onPick,
}: {
  colors: { name: string; value: string }[];
  value: string | null | undefined;
  none?: string;
  onPick: (v: string | null) => void;
}) {
  return (
    <div className="swatches">
      {none && (
        <button className={"chip" + (value === null ? " on" : "")} onClick={() => onPick(null)}>
          {none}
        </button>
      )}
      {colors.map((c) => (
        <button
          key={c.value}
          className={"swatch" + (value === c.value ? " on" : "")}
          style={{ background: c.value }}
          title={c.name}
          aria-label={c.name}
          onClick={() => onPick(c.value)}
        />
      ))}
    </div>
  );
}

const ALIGNS = [
  { id: "left", label: "左揃え", Icon: IconAlignLeft },
  { id: "center", label: "中央揃え", Icon: IconAlignCenter },
  { id: "right", label: "右揃え", Icon: IconAlignRight },
] as const;

/** 選んでいるテキスト枠の操作バー（文字の大きさ・太字・色・揃え・塗り・枠線・削除） */
export function FrameToolbar({ left, top, below }: { left: number; top: number; below: boolean }) {
  const frames = useStore(useShallow((s) => s.frames.filter((f) => s.frameSel.includes(f.id))));
  const [open, setOpen] = useState<"color" | "fill" | "line" | null>(null);
  if (!frames.length) return null;
  const ids = frames.map((f) => f.id);
  const one = <T,>(vals: T[]): T | undefined => (vals.every((v) => v === vals[0]) ? vals[0] : undefined);
  const size = one(frames.map((f) => f.size));
  const bold = frames.every((f) => f.bold);
  const color = one(frames.map((f) => f.color));
  const align = one(frames.map((f) => f.align));
  const fill = one(frames.map((f) => f.fill));
  const line = one(frames.map((f) => f.line));
  const toggle = (k: typeof open) => setOpen(open === k ? null : k);

  return (
    <div
      className={"sel-toolbar frame-toolbar" + (below ? " below" : "")}
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      // ボタンを押しても、入力中の枠の文字入力欄から入力位置を奪わない（文字の欄は除く）
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
      }}
    >
      <span className="sel-count">{frames.length > 1 ? `枠 ${frames.length}件` : "テキスト枠"}</span>
      <button className="tb-btn size-step" title="文字を小さく（Ctrl+Shift+<）" onClick={() => changeFrameSize(-1)}>
        <span className="a-small">A</span>
        <span className="a-sign">−</span>
      </button>
      <SizeInput ids={ids} size={size} />
      <button className="tb-btn size-step" title="文字を大きく（Ctrl+Shift+>）" onClick={() => changeFrameSize(1)}>
        <span className="a-big">A</span>
        <span className="a-sign">＋</span>
      </button>
      <span className="sel-sep" />
      <button
        className={"tb-btn bold" + (bold ? " active" : "")}
        title="太字（Ctrl+B）"
        aria-pressed={bold}
        onClick={() => setFrameBold(ids, !bold)}
      >
        B
      </button>
      <div className="pop-anchor">
        <button className={"tb-btn" + (open === "color" ? " active" : "")} title="文字の色" aria-expanded={open === "color"} onClick={() => toggle("color")}>
          <span className="color-a" style={{ borderBottomColor: color ?? "#9ca3af" }}>
            A
          </span>
        </button>
        {open === "color" && (
          <div className="popover">
            <div className="pop-title">文字の色</div>
            <Swatches
              colors={FRAME_TEXT_COLORS}
              value={color}
              onPick={(v) => {
                patchFrames(ids, { color: v ?? "#000000" });
                setOpen(null);
              }}
            />
          </div>
        )}
      </div>
      <div className="seg">
        {ALIGNS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={"tb-btn" + (align === id ? " active" : "")}
            title={label}
            aria-pressed={align === id}
            onClick={() => patchFrames(ids, { align: id })}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>
      <span className="sel-sep" />
      <div className="pop-anchor">
        <button className={"tb-btn wide" + (open === "fill" ? " active" : "")} title="枠の中の塗り" aria-expanded={open === "fill"} onClick={() => toggle("fill")}>
          <span className={"fill-swatch" + (fill === null ? " none" : "")} style={fill ? { background: fill } : undefined} />
          <span>塗り</span>
        </button>
        {open === "fill" && (
          <div className="popover">
            <div className="pop-title">枠の中の塗り</div>
            <Swatches
              colors={FILL_COLORS}
              value={fill}
              none="なし"
              onPick={(v) => {
                patchFrames(ids, { fill: v });
                setOpen(null);
              }}
            />
            <div className="pop-note">下のページの文字は消えません。隠すときは「マスク」を使います</div>
          </div>
        )}
      </div>
      <div className="pop-anchor">
        <button className={"tb-btn wide" + (open === "line" ? " active" : "")} title="枠線" aria-expanded={open === "line"} onClick={() => toggle("line")}>
          <span className={"line-swatch" + (line === null ? " none" : "")} style={line ? { borderColor: line } : undefined} />
          <span>枠線</span>
        </button>
        {open === "line" && (
          <div className="popover">
            <div className="pop-title">枠線</div>
            <Swatches
              colors={FILL_COLORS}
              value={line}
              none="なし"
              onPick={(v) => {
                patchFrames(ids, { line: v });
                setOpen(null);
              }}
            />
          </div>
        )}
      </div>
      <span className="sel-sep" />
      <button
        className="tb-btn danger"
        title="削除（Delete）"
        onClick={() => {
          deleteFrames(ids);
          toast({ message: `テキスト枠 ${ids.length} 件を削除しました`, action: { label: "元に戻す", run: undo } });
        }}
      >
        <IconTrash size={16} />
      </button>
    </div>
  );
}

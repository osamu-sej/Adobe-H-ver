import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { autoStrength, MAX_STRENGTH, MIN_STRENGTH } from "../fx/effects";
import { suggestForSelection } from "../model/actions";
import { beginGesture, deleteMasks, endGesture, updateGesture, updateMasks, useStore } from "../model/store";
import { STYLE_LABEL, STYLE_ORDER, type MaskStyle } from "../model/types";
import { IconBlack, IconBlur, IconMosaic, IconSlider, IconTag, IconTrash, IconWand, IconWhite } from "./icons";

export const STYLE_ICON: Record<MaskStyle, (p: { size?: number }) => React.ReactElement> = {
  mosaic: IconMosaic,
  blur: IconBlur,
  black: IconBlack,
  white: IconWhite,
};

export const LABEL_PRESETS = ["非開示", "個人情報", "黒塗り", "マスキング済"];

export function SelectionToolbar({ left, top, below }: { left: number; top: number; below: boolean }) {
  const selected = useStore(useShallow((s) => s.masks.filter((m) => s.selection.includes(m.id))));
  const [open, setOpen] = useState<"strength" | "label" | null>(null);
  if (!selected.length) return null;
  const ids = selected.map((m) => m.id);
  const styles = new Set(selected.map((m) => m.style));
  const one = <T,>(vals: T[]): T | undefined => (vals.every((v) => v === vals[0]) ? vals[0] : undefined);
  const strength = one(selected.map((m) => m.strength));
  const label = one(selected.map((m) => m.label));
  const autoValue = autoStrength(selected[0]);
  const showStrength = selected.some((m) => m.style === "mosaic" || m.style === "blur");

  const setStyle = (style: MaskStyle) => {
    updateMasks(ids, { style });
    useStore.setState({ style });
  };

  return (
    <div
      className={"sel-toolbar" + (below ? " below" : "")}
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <span className="sel-count">{selected.length}件</span>
      <div className="seg">
        {STYLE_ORDER.map((s, i) => {
          const Icon = STYLE_ICON[s];
          return (
            <button
              key={s}
              className={"tb-btn" + (styles.size === 1 && styles.has(s) ? " active" : "")}
              title={`${STYLE_LABEL[s]}（${i + 1}）`}
              onClick={() => setStyle(s)}
            >
              <Icon size={16} />
            </button>
          );
        })}
      </div>
      <span className="sel-sep" />
      {showStrength && (
        <div className="pop-anchor">
          <button
            className={"tb-btn wide" + (open === "strength" ? " active" : "")}
            title="強さ（[ と ] でも調整）"
            onClick={() => setOpen(open === "strength" ? null : "strength")}
          >
            <IconSlider size={16} />
            <span>{strength === undefined ? "混在" : strength === null ? "自動" : `${strength}pt`}</span>
          </button>
          {open === "strength" && (
            <div className="popover">
              <div className="pop-title">モザイクの粗さ・ぼかしの強さ</div>
              <input
                type="range"
                min={MIN_STRENGTH}
                max={MAX_STRENGTH}
                step={0.5}
                value={strength ?? autoValue}
                onPointerDown={() => beginGesture()}
                onPointerUp={() => endGesture()}
                onKeyDown={() => beginGesture()}
                onKeyUp={() => endGesture()}
                onBlur={() => endGesture()}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  beginGesture();
                  updateGesture((s) => ({ masks: s.masks.map((m) => (ids.includes(m.id) ? { ...m, strength: v } : m)) }));
                  useStore.setState({ strength: v });
                }}
              />
              <div className="pop-row">
                <span className="muted">{(strength ?? autoValue).toFixed(1)}pt</span>
                <button
                  className={"chip" + (strength === null ? " on" : "")}
                  onClick={() => {
                    updateMasks(ids, { strength: null });
                    useStore.setState({ strength: null });
                  }}
                >
                  自動（文字高の半分以上）
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="pop-anchor">
        <button
          className={"tb-btn wide" + (open === "label" ? " active" : "")}
          title="墨消しの上に文言を重ねる"
          onClick={() => setOpen(open === "label" ? null : "label")}
        >
          <IconTag size={16} />
          <span>{label === undefined ? "混在" : label ?? "文言なし"}</span>
        </button>
        {open === "label" && (
          <div className="popover">
            <div className="pop-title">重ねる文言</div>
            <div className="chips">
              <button
                className={"chip" + (label === null ? " on" : "")}
                onClick={() => {
                  updateMasks(ids, { label: null });
                  useStore.setState({ label: null });
                  setOpen(null);
                }}
              >
                なし
              </button>
              {LABEL_PRESETS.map((l) => (
                <button
                  key={l}
                  className={"chip" + (label === l ? " on" : "")}
                  onClick={() => {
                    updateMasks(ids, { label: l });
                    useStore.setState({ label: l });
                    setOpen(null);
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <form
              className="pop-row"
              onSubmit={(e) => {
                e.preventDefault();
                const v = String(new FormData(e.currentTarget).get("label") ?? "").trim();
                updateMasks(ids, { label: v || null });
                useStore.setState({ label: v || null });
                setOpen(null);
              }}
            >
              <input name="label" className="input sm" placeholder="自由入力（Enterで決定）" maxLength={24} defaultValue={label ?? ""} />
            </form>
          </div>
        )}
      </div>
      <span className="sel-sep" />
      <button className="tb-btn" title="同じ値をほかの場所からも探す" onClick={suggestForSelection}>
        <IconWand size={16} />
      </button>
      <button className="tb-btn danger" title="削除（Delete）" onClick={() => deleteMasks(ids)}>
        <IconTrash size={16} />
      </button>
    </div>
  );
}

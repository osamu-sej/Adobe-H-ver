import { useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { MAX_STRENGTH, MIN_STRENGTH, resolveStrength } from "../fx/effects";
import { suggestForSelection } from "../model/actions";
import { beginGesture, deleteMasks, endGesture, updateGesture, updateMasks, useStore } from "../model/store";
import { LEVEL_HINT, LEVEL_LABEL, LEVEL_ORDER, STYLE_LABEL, STYLE_ORDER, type MaskStyle } from "../model/types";
import { FillPopover, FillSwatch } from "./FillPicker";
import { IconBlur, IconFill, IconMosaic, IconSlider, IconTag, IconTrash, IconWand } from "./icons";
import { setLevel } from "./TopBar";

export const STYLE_ICON: Record<MaskStyle, (p: { size?: number }) => React.ReactElement> = {
  mosaic: IconMosaic,
  blur: IconBlur,
  fill: IconFill,
};

export const LABEL_PRESETS = ["非開示", "個人情報", "黒塗り", "マスキング済"];

export function SelectionToolbar({ left, top, below }: { left: number; top: number; below: boolean }) {
  const selected = useStore(useShallow((s) => s.masks.filter((m) => s.selection.includes(m.id))));
  const [open, setOpen] = useState<"strength" | "label" | "fill" | null>(null);
  const closeFill = useCallback(() => setOpen((o) => (o === "fill" ? null : o)), []);
  if (!selected.length) return null;
  const ids = selected.map((m) => m.id);
  const styles = new Set(selected.map((m) => m.style));
  const one = <T,>(vals: T[]): T | undefined => (vals.every((v) => v === vals[0]) ? vals[0] : undefined);
  const strength = one(selected.map((m) => m.strength));
  const level = one(selected.map((m) => m.level));
  const label = one(selected.map((m) => m.label));
  const current = resolveStrength(selected[0]);
  const showStrength = selected.some((m) => m.style === "mosaic" || m.style === "blur");
  const fills = selected.filter((m) => m.style === "fill");
  const fillColor = one(fills.map((m) => m.color));
  const fillOpacity = one(fills.map((m) => m.opacity));

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
        <div className="seg" role="radiogroup" aria-label="程度">
          {LEVEL_ORDER.map((l) => (
            <button
              key={l}
              role="radio"
              aria-checked={strength === null && level === l}
              className={"tb-btn level" + (strength === null && level === l ? " active" : "")}
              title={`${LEVEL_LABEL[l]}：${LEVEL_HINT[l]}（[ と ] で切替）`}
              onClick={() => setLevel(l)}
            >
              {LEVEL_LABEL[l]}
            </button>
          ))}
        </div>
      )}
      {showStrength && (
        <div className="pop-anchor">
          <button
            className={"tb-btn" + (open === "strength" || strength ? " active" : "")}
            title={strength ? `細かく調整中（${strength.toFixed(1)}pt）` : "細かく調整する"}
            onClick={() => setOpen(open === "strength" ? null : "strength")}
          >
            <IconSlider size={16} />
          </button>
          {open === "strength" && (
            <div className="popover">
              <div className="pop-title">モザイクの粗さ・ぼかしの強さを細かく調整</div>
              <input
                type="range"
                min={MIN_STRENGTH}
                max={MAX_STRENGTH}
                step={0.1}
                value={strength ?? current}
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
                <span className="muted">{(strength ?? current).toFixed(1)}pt</span>
                <button
                  className={"chip" + (strength === null ? " on" : "")}
                  onClick={() => {
                    updateMasks(ids, { strength: null });
                    useStore.setState({ strength: null });
                  }}
                >
                  弱・中・強に戻す
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {fills.length > 0 && (
        <div className="pop-anchor">
          <button
            className={"tb-btn" + (open === "fill" ? " active" : "")}
            title="塗りの色と透明度"
            aria-expanded={open === "fill"}
            onClick={() => setOpen(open === "fill" ? null : "fill")}
          >
            {fillColor === undefined ? (
              <span className="fill-swatch mixed" aria-hidden="true" />
            ) : (
              <FillSwatch color={fillColor} opacity={fillOpacity ?? 1} />
            )}
          </button>
          {open === "fill" && <FillPopover color={fillColor} opacity={fillOpacity} onClose={closeFill} />}
        </div>
      )}
      <div className="pop-anchor">
        <button
          className={"tb-btn wide" + (open === "label" ? " active" : "")}
          title="マスクの上に文言を重ねる"
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

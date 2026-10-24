import { useEffect, useRef } from "react";
import { beginGesture, endGesture, updateGesture, updateMasks, useStore } from "../model/store";
import { FILL_COLORS, type Mask } from "../model/types";

type FillPatch = Partial<Pick<Mask, "color" | "opacity">>;

const TRANSPARENCY_PRESETS = [0, 25, 50, 75];
const MAX_TRANSPARENCY = 90;

function selectedFillIds(): Set<string> {
  const s = useStore.getState();
  return new Set(s.masks.filter((m) => m.style === "fill" && s.selection.includes(m.id)).map((m) => m.id));
}

function defaults(patch: FillPatch) {
  return {
    ...(patch.color !== undefined && { fillColor: patch.color }),
    ...(patch.opacity !== undefined && { fillOpacity: patch.opacity }),
  };
}

/** 塗りの色・不透明度を決める。選択中の塗りつぶしマスクに適用し、新しいマスクの既定にもする */
export function setFill(patch: FillPatch) {
  endGesture();
  const ids = [...selectedFillIds()];
  if (ids.length) updateMasks(ids, patch);
  useStore.setState(defaults(patch));
}

/** スライダーや色選択の途中。操作が終わるまで（endGesture）を1回のUndoにまとめる */
function liveFill(patch: FillPatch) {
  const ids = selectedFillIds();
  if (ids.size) {
    beginGesture();
    updateGesture((snap) => ({ masks: snap.masks.map((m) => (ids.has(m.id) ? { ...m, ...patch } : m)) }));
  }
  useStore.setState(defaults(patch));
}

export function colorName(color: string): string {
  return FILL_COLORS.find((c) => c.value === color.toLowerCase())?.name ?? color.toUpperCase();
}

/** 色見本。透けるときは市松模様の上に重ねて見せる */
export function FillSwatch({ color, opacity, size = 16 }: { color: string; opacity: number; size?: number }) {
  return (
    <span className="fill-swatch" style={{ width: size, height: size }} aria-hidden="true">
      <i style={{ background: color, opacity }} />
    </span>
  );
}

/** 色と透明度を選ぶポップオーバー。color / opacity が undefined のときは選択中のマスクで値が混在 */
export function FillPopover({
  color,
  opacity,
  onClose,
}: {
  color: string | undefined;
  opacity: number | undefined;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const transparency = opacity === undefined ? undefined : Math.round((1 - opacity) * 100);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      endGesture();
    };
  }, [onClose]);

  return (
    <div ref={ref} className="popover fill-pop" onPointerDown={(e) => e.stopPropagation()}>
      <div className="pop-title">塗りの色</div>
      <div className="swatches" role="radiogroup" aria-label="塗りの色">
        {FILL_COLORS.map((c) => (
          <button
            key={c.value}
            role="radio"
            aria-checked={color === c.value}
            aria-label={c.name}
            title={c.name}
            className={"swatch" + (color === c.value ? " on" : "")}
            style={{ background: c.value }}
            onClick={() => setFill({ color: c.value })}
          />
        ))}
        <label
          className={"swatch custom" + (color && !FILL_COLORS.some((c) => c.value === color) ? " on" : "")}
          title="ほかの色を選ぶ"
          style={color && !FILL_COLORS.some((c) => c.value === color) ? { background: color } : undefined}
        >
          <input
            type="color"
            aria-label="ほかの色を選ぶ"
            value={color ?? "#000000"}
            onChange={(e) => liveFill({ color: e.target.value })}
            onBlur={() => endGesture()}
          />
        </label>
      </div>
      <div className="pop-row">
        <span className="pop-title">透明度</span>
        <span className="muted">{transparency === undefined ? "混在" : transparency === 0 ? "不透明" : `${transparency}%`}</span>
      </div>
      <div className="chips">
        {TRANSPARENCY_PRESETS.map((t) => (
          <button key={t} className={"chip" + (transparency === t ? " on" : "")} onClick={() => setFill({ opacity: 1 - t / 100 })}>
            {t === 0 ? "不透明" : `${t}%`}
          </button>
        ))}
      </div>
      <input
        type="range"
        min={0}
        max={MAX_TRANSPARENCY}
        step={5}
        aria-label="透明度"
        value={transparency ?? 0}
        onPointerUp={() => endGesture()}
        onKeyUp={() => endGesture()}
        onBlur={() => endGesture()}
        onChange={(e) => liveFill({ opacity: 1 - Number(e.target.value) / 100 })}
      />
      {!!transparency && <div className="muted small">下の内容が透けて見えます。書き出したPDFでも、この透け具合のまま見えます。</div>}
    </div>
  );
}

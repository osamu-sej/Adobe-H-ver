import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";

export interface MenuItem {
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  run?: () => void;
  separator?: boolean;
}

const useMenu = create<{ x: number; y: number; items: MenuItem[] } | { items: null }>(() => ({ items: null }));

export function openContextMenu(x: number, y: number, items: MenuItem[]) {
  useMenu.setState({ x, y, items });
}

export function closeContextMenu() {
  useMenu.setState({ items: null });
}

export function ContextMenu() {
  const state = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!state.items || !ref.current || !("x" in state)) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(state.x, window.innerWidth - r.width - 8),
      y: Math.min(state.y, window.innerHeight - r.height - 8),
    });
  }, [state]);

  useEffect(() => {
    if (!state.items) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.type === "pointerdown" && ref.current?.contains(e.target as Node)) return;
      closeContextMenu();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("wheel", close);
    };
  }, [state.items]);

  if (!state.items) return null;
  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {state.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={"ctx-item" + (it.danger ? " danger" : "")}
            disabled={it.disabled}
            onClick={() => {
              closeContextMenu();
              it.run?.();
            }}
          >
            <span className="ctx-icon">{it.icon}</span>
            <span className="ctx-label">{it.label}</span>
            {it.shortcut && <kbd>{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

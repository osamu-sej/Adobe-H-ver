import { useEffect, useRef, useState } from "react";
import { engine } from "./engine/client";
import { applySuggestion, isPdfFile, maskSearchHits, openFiles } from "./model/actions";
import {
  beginGesture,
  deleteFrames,
  deleteMasks,
  deletePages,
  endGesture,
  redo,
  rotatePages,
  select,
  selectFrames,
  startFrameEdit,
  toast,
  undo,
  updateGesture,
  useStore,
} from "./model/store";
import { STYLE_ORDER, type SnapMode, type Tool } from "./model/types";
import { ContextMenu } from "./ui/ContextMenu";
import { ExportDialog } from "./ui/ExportDialog";
import { changeFrameSize, setFrameBold } from "./ui/FrameToolbar";
import { CloudOcrDialog } from "./ui/CloudOcr";
import { SettingsDialog } from "./ui/Settings";
import { DropOverlay, EmptyState, HelpOverlay, PasswordDialog, SafetyDialog, StatusBar, SuggestionBar, Toasts } from "./ui/Overlays";
import { focusSearch, SidePanel } from "./ui/SidePanel";
import { Sidebar } from "./ui/Sidebar";
import { setStyle, stepLevel, toggleFullscreen, TopBar } from "./ui/TopBar";
import { viewerApi, Viewer } from "./ui/Viewer";

const SNAP_CYCLE: SnapMode[] = ["digits", "text", "free"];
const TOOL_KEYS: Record<string, Tool> = { m: "mask", v: "select", t: "text", h: "hand" };

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t?.closest?.("input, textarea, select, [contenteditable]");
}

function handleKeyDown(e: KeyboardEvent, openPicker: () => void) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const s = useStore.getState();
  const hasDocs = s.docOrder.length > 0;

  if (mod && k === "o") {
    e.preventDefault();
    openPicker();
    return;
  }
  if (!hasDocs) return;
  if (mod && k === "s") {
    e.preventDefault();
    useStore.setState({ exportOpen: true });
    return;
  }
  if (mod && k === "f") {
    e.preventDefault();
    useStore.setState({ panel: "search", chrome: true });
    setTimeout(() => focusSearch.current(), 0);
    return;
  }
  if (isTyping(e) || s.exportOpen || s.passwordRequest || s.safetyOpen || s.settingsOpen || s.cloudOcrFor) return;
  if (s.helpOpen) {
    if (e.key === "Escape" || e.key === "?") useStore.setState({ helpOpen: false });
    return;
  }

  const cur = s.current;
  if (mod) {
    if (e.key === "Enter" && s.panel === "search") {
      e.preventDefault();
      maskSearchHits();
    } else if (s.frameSel.length && (k === "]" || k === "[" || (e.shiftKey && [">", "<", ".", ","].includes(e.key)))) {
      // 選んだテキスト枠の文字を大きく・小さく（PowerPoint と同じ Ctrl+Shift+> / <、Ctrl+] / [）
      e.preventDefault();
      changeFrameSize(k === "]" || e.key === ">" || e.key === "." ? 1 : -1);
    } else if (s.frameSel.length && k === "b") {
      e.preventDefault();
      const bold = s.frames.filter((f) => s.frameSel.includes(f.id)).every((f) => f.bold);
      setFrameBold(s.frameSel, !bold);
    } else if (k === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (k === "y") {
      e.preventDefault();
      redo();
    } else if (k === "a") {
      e.preventDefault();
      const ids = s.masks.filter((m) => e.shiftKey || (m.docId === cur?.docId && m.page === cur?.page)).map((m) => m.id);
      select(ids);
    } else if (k === "=" || k === "+" || k === ";") {
      e.preventDefault();
      viewerApi.zoomBy(1.2);
    } else if (k === "-") {
      e.preventDefault();
      viewerApi.zoomBy(1 / 1.2);
    } else if (k === "0") {
      e.preventDefault();
      viewerApi.fitWidth();
    } else if (k === "9") {
      e.preventDefault();
      viewerApi.fitPage();
    } else if (k === "1") {
      e.preventDefault();
      viewerApi.setZoom(4 / 3);
    } else if (cur && (k === "l" || k === "r")) {
      e.preventDefault();
      rotatePages(cur.docId, [cur.page], k === "l" ? -90 : 90);
    } else if (cur && k === "d") {
      e.preventDefault();
      if (deletePages(cur.docId, [cur.page])) toast({ message: "ページを削除しました", action: { label: "元に戻す", run: undo } });
      else toast({ message: "最後の1ページは削除できません", tone: "warn" });
    }
    return;
  }
  if (e.altKey) return;

  // 枠を1つ選んでいるとき：Enter / F2 で文字の入力。文字キーでは始めない（M V T H P などのショートカットが使えなくなるため）
  if (s.frameSel.length === 1 && !s.selection.length && !s.suggestion && (e.key === "Enter" || e.key === "F2")) {
    e.preventDefault();
    startFrameEdit(s.frameSel[0]);
    return;
  }

  if (TOOL_KEYS[k]) {
    useStore.setState({ tool: TOOL_KEYS[k] });
    return;
  }
  if (/^[1-3]$/.test(e.key)) {
    setStyle(STYLE_ORDER[Number(e.key) - 1]);
    return;
  }
  switch (e.key) {
    case "s":
    case "S": {
      const next = SNAP_CYCLE[(SNAP_CYCLE.indexOf(s.snap) + 1) % SNAP_CYCLE.length];
      useStore.setState({ snap: next });
      return;
    }
    case "p":
    case "P":
      if (!e.repeat) useStore.setState({ peek: true });
      return;
    case "l":
    case "L":
      useStore.setState({ panel: s.panel === "masks" ? null : "masks", chrome: true });
      return;
    case "f":
    case "F":
      toggleFullscreen();
      return;
    case "?":
      useStore.setState({ helpOpen: true });
      return;
    case "Tab":
      e.preventDefault();
      useStore.setState({ chrome: !s.chrome });
      return;
    case "Enter":
      if (s.suggestion) {
        e.preventDefault();
        applySuggestion();
      }
      return;
    case "Escape":
      if (s.suggestion) useStore.setState({ suggestion: null });
      else if (s.selection.length) select([]);
      else if (s.frameSel.length) selectFrames([]);
      else if (s.panel) useStore.setState({ panel: null });
      return;
    case "Delete":
    case "Backspace":
      if (s.selection.length) {
        e.preventDefault();
        const n = s.selection.length;
        deleteMasks(s.selection);
        toast({ message: `マスク ${n} 件を削除しました`, action: { label: "元に戻す", run: undo } });
      } else if (s.frameSel.length) {
        e.preventDefault();
        const n = s.frameSel.length;
        deleteFrames(s.frameSel);
        toast({ message: `テキスト枠 ${n} 件を削除しました`, action: { label: "元に戻す", run: undo } });
      }
      return;
    case "[":
    case "]":
      stepLevel(e.key === "]" ? 1 : -1);
      return;
    case "PageDown":
    case "j":
      e.preventDefault();
      viewerApi.pageBy(1);
      return;
    case "PageUp":
    case "k":
      e.preventDefault();
      viewerApi.pageBy(-1);
      return;
    case "Home":
      e.preventDefault();
      viewerApi.pageTo("first");
      return;
    case "End":
      e.preventDefault();
      viewerApi.pageTo("last");
      return;
    case "ArrowLeft":
    case "ArrowRight":
    case "ArrowUp":
    case "ArrowDown": {
      if (!s.selection.length && !s.frameSel.length) return;
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
      const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
      // 回転したページでは見た目の方向に動かす
      const sel = new Set(s.selection);
      const selFrames = new Set(s.frameSel);
      beginGesture();
      updateGesture((snap) => {
        const shift = (docId: string, page: number): [number, number] => {
          const rot = snap.layouts[docId]?.rot[page] ?? 0;
          return rot === 90 ? [dy, -dx] : rot === 180 ? [-dx, -dy] : rot === 270 ? [-dy, dx] : [dx, dy];
        };
        return {
          masks: snap.masks.map((m) => {
            if (!sel.has(m.id)) return m;
            const [bx, by] = shift(m.docId, m.page);
            return { ...m, x: m.x + bx, y: m.y + by };
          }),
          frames: snap.frames.map((f) => {
            if (!selFrames.has(f.id)) return f;
            const [bx, by] = shift(f.docId, f.page);
            return { ...f, x: f.x + bx, y: f.y + by };
          }),
        };
      });
      return;
    }
  }
}

function handleKeyUp(e: KeyboardEvent) {
  if (e.key === "p" || e.key === "P") useStore.setState({ peek: false });
  // 文字の入力中は、入力欄の矢印キー（入力位置の移動）で、入力のひとまとまりの操作を終えない
  if (e.key.startsWith("Arrow") && !isTyping(e) && !useStore.getState().frameEdit) endGesture();
}

export function App() {
  const hasDocs = useStore((s) => s.docOrder.length > 0);
  const sidebar = useStore((s) => s.sidebar);
  const chrome = useStore((s) => s.chrome);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const openPicker = () => fileRef.current?.click();

  useEffect(() => {
    const down = (e: KeyboardEvent) => handleKeyDown(e, openPicker);
    const blur = () => useStore.setState({ peek: false });
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // ファイルのドロップ
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) openFiles(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  // 書き出していない作業があるときは閉じる前に確認
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      const s = useStore.getState();
      if (s.masks.length && s.editedAt > (s.exportedAt ?? 0)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);

  useEffect(() => {
    engine.ready.catch((e: Error) =>
      toast({ message: "PDFエンジンを起動できませんでした：" + e.message, tone: "error", duration: 0 }),
    );
  }, []);

  return (
    <div className="app">
      {hasDocs ? (
        <>
          <TopBar onOpen={openPicker} />
          <div className="main">
            {sidebar && chrome && <Sidebar onAddFiles={openPicker} />}
            <Viewer />
            {chrome && <SidePanel />}
          </div>
          <StatusBar />
          <SuggestionBar />
        </>
      ) : (
        <EmptyState onOpen={openPicker} />
      )}
      <Toasts />
      <ExportDialog />
      <PasswordDialog />
      <HelpOverlay />
      <SafetyDialog />
      <CloudOcrDialog />
      <SettingsDialog />
      <ContextMenu />
      <DropOverlay active={dragging} />
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])].filter(isPdfFile);
          e.target.value = "";
          if (files.length) openFiles(files);
        }}
      />
    </div>
  );
}

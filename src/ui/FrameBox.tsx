import { memo, useLayoutEffect, useRef } from "react";
import { FRAME_LINE, FRAME_PAD, neededHeight } from "../fx/frames";
import { LABEL_FONT } from "../fx/effects";
import { finishFrameEdit, patchFrames, useStore } from "../model/store";
import type { Rot, TextFrame } from "../model/types";
import { changeFrameSize } from "./FrameToolbar";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** 枠の文字の入力欄。枠の描画（fx/frames.ts）と同じ余白・行の高さ・折り返しにそろえる */
function FrameEditor({ frame, rot, zoom }: { frame: TextFrame; rot: Rot; zoom: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    const e = useStore.getState().frameEdit;
    if (e?.insert) {
      // 選んだ枠に文字キーを押して入力を始めたとき：その1文字から入力する
      const text = frame.text + e.insert;
      patchFrames([frame.id], (f) => ({ text, h: Math.max(f.h, neededHeight({ ...f, text })) }));
      useStore.setState({ frameEdit: { id: e.id, fresh: e.fresh } });
      queueMicrotask(() => ta.setSelectionRange(text.length, text.length));
    } else ta.setSelectionRange(ta.value.length, ta.value.length);
    // 入力中に画面から外れた（スクロールで消えた）ときも、入力を終える。
    // 同じ場所に入力欄が付け直されたとき（開発時の再実行など）は続ける
    return () => {
      setTimeout(() => {
        if (!document.querySelector(".frame-editor")) finishFrameEdit();
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="frame-editor"
      style={{
        width: frame.w * zoom,
        height: frame.h * zoom,
        transform: `translate(-50%, -50%) rotate(${rot}deg)`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        aria-label="テキスト枠の文字"
        value={frame.text}
        spellCheck={false}
        style={{
          fontFamily: LABEL_FONT,
          fontSize: frame.size * zoom,
          fontWeight: frame.bold ? 700 : 400,
          lineHeight: FRAME_LINE,
          padding: FRAME_PAD * zoom,
          textAlign: frame.align,
          color: frame.color,
          caretColor: frame.color,
          background: frame.fill ?? "transparent",
          boxShadow: frame.line ? `inset 0 0 0 ${Math.max(1, zoom)}px ${frame.line}` : undefined,
        }}
        onChange={(e) => {
          const text = e.target.value;
          patchFrames([frame.id], (f) => ({ text, h: Math.max(f.h, neededHeight({ ...f, text })) }));
        }}
        onBlur={() => finishFrameEdit()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return;
          const mod = e.ctrlKey || e.metaKey;
          if (e.key === "Escape" || (mod && e.key === "Enter")) {
            e.preventDefault();
            ref.current?.blur();
          } else if (mod && (e.key === "b" || e.key === "B")) {
            e.preventDefault();
            patchFrames([frame.id], (f) => ({ bold: !f.bold }));
          } else if (mod && (e.key === "]" || (e.shiftKey && (e.key === ">" || e.key === ".")))) {
            e.preventDefault();
            changeFrameSize(1);
          } else if (mod && (e.key === "[" || (e.shiftKey && (e.key === "<" || e.key === ",")))) {
            e.preventDefault();
            changeFrameSize(-1);
          } else if (e.key === "Tab") e.preventDefault();
        }}
      />
    </div>
  );
}

export const FrameBox = memo(function FrameBox({
  frame,
  selected,
  editing,
  style,
  rot,
  zoom,
}: {
  frame: TextFrame;
  selected: boolean;
  editing: boolean;
  style: React.CSSProperties;
  rot: Rot;
  zoom: number;
}) {
  return (
    <div
      className={"frame-box" + (selected ? " selected" : "") + (editing ? " editing" : "")}
      style={style}
      data-frame-id={frame.id}
    >
      {editing && <FrameEditor frame={frame} rot={rot} zoom={zoom} />}
      {selected && !editing && HANDLES.map((h) => <span key={h} className={`handle h-${h}`} data-handle={h} />)}
    </div>
  );
});

import { beforeEach, describe, expect, it } from "vitest";
import { neededHeight } from "../fx/frames";
import { addFrame, registerDoc, removeDoc, undo, useStore } from "../model/store";
import type { DocEntry, TextFrame } from "../model/types";
import { changeFrameSize, setFrameBold, setFrameSize } from "./FrameToolbar";

const doc: DocEntry = {
  id: "a",
  name: "a.pdf",
  size: 0,
  hash: "a",
  bytes: new Uint8Array(),
  pages: [{ w: 300, h: 300, x0: 0, y0: 0 }],
  meta: { title: "", author: "", subject: "", keywords: "", creator: "", producer: "", encryption: "" },
  hasAnnots: false,
};
const frame = (id: string, over: Partial<TextFrame> = {}): TextFrame => ({
  id,
  docId: "a",
  page: 0,
  x: 10,
  y: 10,
  w: 50,
  h: 20,
  text: "あいうえお",
  size: 14,
  bold: false,
  color: "#000000",
  align: "left",
  fill: null,
  line: null,
  ...over,
});
const get = (id: string) => useStore.getState().frames.find((f) => f.id === id)!;

describe("テキスト枠の操作バー", () => {
  beforeEach(() => {
    for (const id of [...useStore.getState().docOrder]) removeDoc(id);
    useStore.setState({ past: [], future: [], gesture: null, frames: [], frameSel: [], frameEdit: null });
    registerDoc(doc, { order: [0], rot: {} });
  });

  it("文字を大きくして折り返しが増えたら、枠が下に広がる（小さくしても枠は縮まない）", () => {
    addFrame(frame("t1"));
    setFrameSize(["t1"], 20);
    const f = get("t1");
    expect(f.size).toBe(20);
    expect(f.h).toBeGreaterThanOrEqual(neededHeight(f));
    expect(f.h).toBeGreaterThan(20);
    const grown = f.h;
    setFrameSize(["t1"], 8);
    expect(get("t1").h).toBe(grown);
  });

  it("A＋・A−は、枠ごとに今の大きさから段階を1つ動かす", () => {
    addFrame(frame("t1", { size: 14 }));
    useStore.setState({ frameSel: ["t1"] });
    changeFrameSize(1);
    expect(get("t1").size).toBe(16);
    changeFrameSize(-1);
    changeFrameSize(-1);
    expect(get("t1").size).toBe(12);
  });

  it("太字にしたあとも文字が枠に入りきる高さになり、1回の取り消しで元に戻る", () => {
    addFrame(frame("t1", { h: 10 }));
    setFrameBold(["t1"], true);
    const f = get("t1");
    expect(f.bold).toBe(true);
    expect(f.h).toBeGreaterThanOrEqual(neededHeight(f));
    setFrameBold(["t1"], (x) => !x);
    expect(get("t1").bold).toBe(false);
    undo();
    expect(get("t1").bold).toBe(true);
  });
});

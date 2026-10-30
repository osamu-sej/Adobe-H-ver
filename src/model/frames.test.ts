import { beforeEach, describe, expect, it } from "vitest";
import {
  addFrame,
  beginGesture,
  deleteFrames,
  finishFrameEdit,
  patchFrames,
  redo,
  registerDoc,
  removeDoc,
  select,
  selectFrames,
  startFrameEdit,
  undo,
  useStore,
} from "./store";
import type { DocEntry, TextFrame } from "./types";

const page = { w: 100, h: 100, x0: 0, y0: 0 };
const doc = (id: string, n: number): DocEntry => ({
  id,
  name: `${id}.pdf`,
  size: 0,
  hash: id,
  bytes: new Uint8Array(),
  pages: Array.from({ length: n }, () => page),
  meta: { title: "", author: "", subject: "", keywords: "", creator: "", producer: "", encryption: "" },
  hasAnnots: false,
});
const frame = (id: string, over: Partial<TextFrame> = {}): TextFrame => ({
  id,
  docId: "a",
  page: 0,
  x: 10,
  y: 10,
  w: 50,
  h: 20,
  text: "",
  size: 14,
  bold: false,
  color: "#000000",
  align: "left",
  fill: null,
  line: "#374151",
  ...over,
});
const frames = () => useStore.getState().frames;

describe("テキスト枠（ストア）", () => {
  beforeEach(() => {
    for (const id of [...useStore.getState().docOrder]) removeDoc(id);
    useStore.setState({ past: [], future: [], gesture: null, frames: [], frameSel: [], frameEdit: null, selection: [] });
    registerDoc(doc("a", 3), { order: [0, 1, 2], rot: {} });
  });

  it("枠を足すと選ばれ、1回の取り消しで消える。やり直しで戻る", () => {
    addFrame(frame("t1", { text: "あ" }));
    expect(frames().map((f) => f.id)).toEqual(["t1"]);
    expect(useStore.getState().frameSel).toEqual(["t1"]);
    expect(useStore.getState().past.length).toBe(1);
    expect(undo()).toBe(true);
    expect(frames()).toEqual([]);
    expect(useStore.getState().frameSel).toEqual([]);
    expect(redo()).toBe(true);
    expect(frames()[0].text).toBe("あ");
  });

  it("枠を選ぶとマスクの選択は外れ、マスクを選ぶと枠の選択は外れる", () => {
    addFrame(frame("t1"));
    useStore.setState({ selection: ["m1"] });
    selectFrames(["t1"]);
    expect(useStore.getState().selection).toEqual([]);
    expect(useStore.getState().frameSel).toEqual(["t1"]);
    select(["m1"]);
    expect(useStore.getState().frameSel).toEqual([]);
    selectFrames(["t1"]);
    select([]);
    expect(useStore.getState().frameSel).toEqual([]);
  });

  it("設定を変えるのも削除も、取り消せる（削除した枠は選択からも外れる）", () => {
    addFrame(frame("t1"));
    patchFrames(["t1"], { size: 20, bold: true });
    expect(frames()[0]).toMatchObject({ size: 20, bold: true });
    patchFrames(["t1"], (f) => ({ size: f.size + 4 }));
    expect(frames()[0].size).toBe(24);
    deleteFrames(["t1"]);
    expect(frames()).toEqual([]);
    expect(useStore.getState().frameSel).toEqual([]);
    undo();
    expect(frames()[0].size).toBe(24);
    undo();
    expect(frames()[0].size).toBe(20);
  });

  it("文字の入力中の変更（文字・大きさ）は、終えたときに履歴1つにまとまる", () => {
    addFrame(frame("t1", { text: "元" }));
    const before = useStore.getState().past.length;
    startFrameEdit("t1");
    expect(useStore.getState().frameEdit?.id).toBe("t1");
    patchFrames(["t1"], { text: "元の文字" });
    patchFrames(["t1"], { size: 18 });
    patchFrames(["t1"], { text: "元の文字を直した" });
    // 入力中は取り消し・やり直しを受けつけない（入力欄のほうで取り消す）
    expect(undo()).toBe(false);
    finishFrameEdit();
    expect(useStore.getState().frameEdit).toBeNull();
    expect(useStore.getState().past.length).toBe(before + 1);
    expect(frames()[0]).toMatchObject({ text: "元の文字を直した", size: 18 });
    undo();
    expect(frames()[0]).toMatchObject({ text: "元", size: 14 });
  });

  it("何も変えずに入力を終えたときは、履歴を積まない", () => {
    addFrame(frame("t1", { text: "あ" }));
    const before = useStore.getState().past.length;
    startFrameEdit("t1");
    finishFrameEdit();
    expect(useStore.getState().past.length).toBe(before);
  });

  /** ツールで枠を作る操作と同じ順番：ひとまとまりの操作（gesture）を始めてから、枠を足して入力を始める */
  const createFresh = (f: TextFrame) => {
    beginGesture();
    addFrame(f);
    startFrameEdit(f.id, { fresh: true });
  };

  it("作ったばかりの枠を、文字を入れずに終えたら、枠ごとなかったことになる（履歴にも残らない）", () => {
    const before = useStore.getState().past.length;
    createFresh(frame("t9"));
    expect(frames().length).toBe(1);
    finishFrameEdit();
    expect(frames()).toEqual([]);
    expect(useStore.getState().frameSel).toEqual([]);
    expect(useStore.getState().past.length).toBe(before);
    expect(useStore.getState().gesture).toBeNull();
  });

  it("作ったばかりの枠に文字を入れて終えたら、枠の作成と文字が履歴1つになる", () => {
    createFresh(frame("t2"));
    patchFrames(["t2"], { text: "新しい枠" });
    finishFrameEdit();
    expect(frames()[0].text).toBe("新しい枠");
    expect(useStore.getState().past.length).toBe(1);
    undo();
    expect(frames()).toEqual([]);
  });

  it("入力中の枠を削除しても、入力のひとまとまりの操作は残らない（そのあとも取り消し・やり直しができる）", () => {
    addFrame(frame("t1", { text: "あ" }));
    startFrameEdit("t1");
    patchFrames(["t1"], { text: "あい" });
    deleteFrames(["t1"]);
    expect(frames()).toEqual([]);
    expect(useStore.getState().gesture).toBeNull();
    expect(useStore.getState().frameEdit).toBeNull();
    // 削除、入力の変更、作成の順に取り消せる
    expect(undo()).toBe(true);
    expect(frames()[0].text).toBe("あい");
    expect(undo()).toBe(true);
    expect(frames()[0].text).toBe("あ");
    expect(redo()).toBe(true);
  });

  it("作ったばかりの空の枠を入力中に削除したら、枠は履歴に残らず、操作のひとまとまりも残らない", () => {
    const before = useStore.getState().past.length;
    createFresh(frame("t3"));
    deleteFrames(["t3"]);
    expect(frames()).toEqual([]);
    expect(useStore.getState().gesture).toBeNull();
    expect(useStore.getState().past.length).toBe(before);
    expect(useStore.getState().frameSel).toEqual([]);
  });

  it("入力中に文書を閉じたら、入力のひとまとまりの操作も捨てる（取り消し・やり直しが止まったままにならない）", () => {
    createFresh(frame("t4"));
    removeDoc("a");
    expect(useStore.getState().gesture).toBeNull();
    registerDoc(doc("a", 2), { order: [0, 1], rot: {} });
    addFrame(frame("t5"));
    expect(undo()).toBe(true);
  });

  it("文書を閉じると、その文書の枠も選択も入力もなくなる", () => {
    addFrame(frame("t1"));
    startFrameEdit("t1");
    removeDoc("a");
    expect(frames()).toEqual([]);
    expect(useStore.getState().frameSel).toEqual([]);
    expect(useStore.getState().frameEdit).toBeNull();
  });

  it("ない枠の入力は始めない", () => {
    startFrameEdit("nothing");
    expect(useStore.getState().frameEdit).toBeNull();
    expect(useStore.getState().gesture).toBeNull();
  });
});

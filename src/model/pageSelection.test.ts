import { beforeEach, describe, expect, it } from "vitest";
import {
  allPages,
  clickPage,
  moveBlock,
  pageAfterDelete,
  pageRange,
  singlePage,
  stepPage,
  trimSelection,
  type PageSel,
} from "./pageSelection";
import { deletePages, movePages, redo, registerDoc, removeDoc, setPageSel, undo, useStore } from "./store";
import type { DocEntry } from "./types";

describe("ページ一覧の選択（PowerPoint のスライド一覧と同じ操作）", () => {
  // 表示順は元のページ番号と違うことがある（並べ替え後）
  const order = [4, 2, 0, 3, 1];

  it("Shift+クリックは、起点から押したページまでを表示順で選ぶ（逆向きも同じ）", () => {
    expect(pageRange(order, 2, 3)).toEqual([2, 0, 3]);
    expect(pageRange(order, 3, 2)).toEqual([2, 0, 3]);
    expect(pageRange(order, 4, 4)).toEqual([4]);
    expect(pageRange(order, 9, 4)).toEqual([4]);
    expect(pageRange(order, 9, 8)).toEqual([]);
  });

  it("クリックは1ページ、Ctrl/⌘+クリックは追加・解除、Shift+クリックは範囲", () => {
    let sel: PageSel | null = clickPage(null, "a", order, 2);
    expect(sel).toEqual({ docId: "a", pages: [2], anchor: 2, focus: 2 });
    sel = clickPage(sel, "a", order, 3, { toggle: true });
    expect(sel.pages).toEqual([2, 3]);
    // 追加したあとも、並びは表示順にそろう
    sel = clickPage(sel, "a", order, 4, { toggle: true });
    expect(sel.pages).toEqual([4, 2, 3]);
    sel = clickPage(sel, "a", order, 2, { toggle: true });
    expect(sel.pages).toEqual([4, 3]);
    // Shift+クリックは、最後にクリックしたページ（解除したページでも）を起点にした範囲
    sel = clickPage(sel, "a", order, 1, { range: true });
    expect(sel).toEqual({ docId: "a", pages: [2, 0, 3, 1], anchor: 2, focus: 1 });
    // 範囲を取り直しても起点は変わらない
    expect(clickPage(sel, "a", order, 0, { range: true })).toEqual({ docId: "a", pages: [2, 0], anchor: 2, focus: 0 });
    // ふつうのクリックは選択し直し
    expect(clickPage(sel, "a", order, 0).pages).toEqual([0]);
  });

  it("ほかのファイルのページをクリックしたら、選択はそのファイルのページだけになる", () => {
    const sel = clickPage(singlePage("a", 2), "b", [0, 1, 2], 1, { toggle: true });
    expect(sel).toEqual({ docId: "b", pages: [1], anchor: 1, focus: 1 });
    expect(clickPage(singlePage("a", 2), "b", [0, 1, 2], 1, { range: true }).pages).toEqual([1]);
  });

  it("矢印キーで1つずつ動き、Shiftを付けると起点からの範囲が広がる。端で止まる", () => {
    let sel: PageSel | null = singlePage("a", 0);
    sel = stepPage(sel, order, 1, false)!;
    expect(sel.pages).toEqual([3]);
    sel = stepPage(sel, order, 1, true)!;
    expect(sel).toEqual({ docId: "a", pages: [3, 1], anchor: 3, focus: 1 });
    sel = stepPage(sel, order, 1, true)!;
    expect(sel.pages).toEqual([3, 1]);
    sel = stepPage(sel, order, -1, true)!;
    expect(sel.pages).toEqual([3]);
    expect(stepPage(sel, order, "first", false)!.pages).toEqual([4]);
    expect(stepPage(sel, order, "last", false)!.pages).toEqual([1]);
    expect(stepPage(sel, order, "first", true)!.pages).toEqual([4, 2, 0, 3]);
    expect(stepPage(sel, [], 1, false)).toBeNull();
  });

  it("すべて選択", () => {
    expect(allPages("a", order)).toEqual({ docId: "a", pages: order, anchor: 4, focus: 1 });
    expect(allPages("a", [])).toBeNull();
  });

  it("削除や取り消しのあと、なくなったページは選択から外れる", () => {
    const sel: PageSel = { docId: "a", pages: [4, 2, 3], anchor: 4, focus: 3 };
    expect(trimSelection(sel, order)).toBe(sel);
    expect(trimSelection(sel, [2, 0, 1])).toEqual({ docId: "a", pages: [2], anchor: 2, focus: 2 });
    expect(trimSelection(sel, [0, 1])).toBeNull();
    expect(trimSelection(sel, undefined)).toBeNull();
    expect(trimSelection(null, order)).toBeNull();
  });

  it("削除したあとは、削除した先頭の位置にあった（次の）ページを選ぶ。末尾を消したら直前のページ", () => {
    expect(pageAfterDelete([0, 1, 2, 3, 4], [1, 2])).toBe(3);
    expect(pageAfterDelete([0, 1, 2, 3, 4], [0])).toBe(1);
    expect(pageAfterDelete([0, 1, 2, 3, 4], [3, 4])).toBe(2);
    expect(pageAfterDelete(order, [2, 3])).toBe(0);
    expect(pageAfterDelete([0, 1], [0, 1])).toBeNull();
  });

  it("選んだページをひとまとめにして動かす（動かすページの前後の数え方に注意）", () => {
    const o = [0, 1, 2, 3, 4];
    expect(moveBlock(o, [1], 4)).toEqual([0, 2, 3, 1, 4]);
    expect(moveBlock(o, [3, 4], 1)).toEqual([0, 3, 4, 1, 2]);
    expect(moveBlock(o, [1, 3], 5)).toEqual([0, 2, 4, 1, 3]);
    expect(moveBlock(o, [1, 3], 0)).toEqual([1, 3, 0, 2, 4]);
    // 選んだ順ではなく表示順のまま動く
    expect(moveBlock(o, [3, 1], 0)).toEqual([1, 3, 0, 2, 4]);
    // 自分の位置のまわりに落としても変わらない
    expect(moveBlock(o, [2, 3], 2)).toEqual(o);
    expect(moveBlock(o, [2, 3], 4)).toEqual(o);
    expect(moveBlock(o, [], 2)).toEqual(o);
  });
});

describe("ページの削除・並べ替え（ストア）", () => {
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
  const orderOf = (id: string) => useStore.getState().layouts[id].order;

  beforeEach(() => {
    for (const id of [...useStore.getState().docOrder]) removeDoc(id);
    useStore.setState({ past: [], future: [], pageSel: null });
    registerDoc(doc("a", 6), { order: [0, 1, 2, 3, 4, 5], rot: {} });
    registerDoc(doc("b", 2), { order: [0, 1], rot: {} });
  });

  it("複数のページをまとめて削除でき、1回の取り消しで全部戻る（残りのページは順番も保つ）", () => {
    expect(deletePages("a", [1, 3, 4])).toBe(true);
    expect(orderOf("a")).toEqual([0, 2, 5]);
    expect(useStore.getState().past.length).toBe(1);
    expect(undo()).toBe(true);
    expect(orderOf("a")).toEqual([0, 1, 2, 3, 4, 5]);
    expect(redo()).toBe(true);
    expect(orderOf("a")).toEqual([0, 2, 5]);
  });

  it("全ページは削除できない。ないページだけを指定したときは何もしない（履歴も積まない）", () => {
    expect(deletePages("b", [0, 1])).toBe(false);
    expect(deletePages("a", [9])).toBe(false);
    expect(deletePages("a", [])).toBe(false);
    expect(orderOf("b")).toEqual([0, 1]);
    expect(useStore.getState().past.length).toBe(0);
  });

  it("削除したページは選択から外れ、取り消しても選択に戻らない。別のファイルの選択は変わらない", () => {
    setPageSel({ docId: "a", pages: [1, 2, 3], anchor: 1, focus: 3 });
    deletePages("a", [2]);
    expect(useStore.getState().pageSel?.pages).toEqual([1, 3]);
    setPageSel({ docId: "b", pages: [1], anchor: 1, focus: 1 });
    deletePages("a", [0]);
    expect(useStore.getState().pageSel?.docId).toBe("b");
    deletePages("b", [1]);
    expect(useStore.getState().pageSel).toBeNull();
  });

  it("やり直しで消えたページは、選択からも外れる", () => {
    deletePages("a", [1, 2]);
    undo();
    setPageSel({ docId: "a", pages: [1, 2, 3], anchor: 1, focus: 3 });
    redo();
    expect(useStore.getState().pageSel?.pages).toEqual([3]);
  });

  it("ファイルを閉じると、そのファイルの選択もなくなる", () => {
    setPageSel({ docId: "a", pages: [1], anchor: 1, focus: 1 });
    removeDoc("a");
    expect(useStore.getState().pageSel).toBeNull();
  });

  it("選んだページをまとめて動かせる。動かなかったときは履歴を積まない", () => {
    expect(movePages("a", [4, 1], 0)).toBe(true);
    expect(orderOf("a")).toEqual([1, 4, 0, 2, 3, 5]);
    expect(undo()).toBe(true);
    expect(orderOf("a")).toEqual([0, 1, 2, 3, 4, 5]);
    expect(movePages("a", [2, 3], 3)).toBe(false);
    expect(movePages("a", [], 3)).toBe(false);
    expect(movePages("zz", [1], 0)).toBe(false);
    // 動かさなかった操作は履歴を積まず、やり直しの履歴も消さない
    expect(useStore.getState().past.length).toBe(0);
    expect(useStore.getState().future.length).toBe(1);
  });

  it("空の選択は選択なしとして扱う", () => {
    setPageSel({ docId: "a", pages: [], anchor: 0, focus: 0 });
    expect(useStore.getState().pageSel).toBeNull();
  });
});

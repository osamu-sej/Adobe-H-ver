/**
 * ページ一覧（サムネイル）の選択。PowerPoint のスライド一覧と同じ操作：
 * クリックで1ページ、Ctrl/⌘+クリックで追加・解除、Shift+クリックで範囲、矢印キーで移動（Shiftで範囲を広げる）。
 * ページ番号はすべて「元PDFでのページ番号」（並べ替え・削除しても変わらない）。順序は表示順（layout.order）で扱う
 */

export interface PageSel {
  docId: string;
  /** 選択中のページ（表示順） */
  pages: number[];
  /** Shift で範囲を取るときの起点 */
  anchor: number;
  /** 最後に操作したページ（矢印キーで動く側） */
  focus: number;
  /** 本文で表示しているページに付いていくだけの選択（自分で選んだものではない）。自分で選んだ選択は、本文のスクロールで動かさない */
  follow?: boolean;
}

/** 表示順 order のうち、a から b まで（どちらが先でもよい）のページ */
export function pageRange(order: number[], a: number, b: number): number[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return j >= 0 ? [b] : i >= 0 ? [a] : [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

export function singlePage(docId: string, page: number): PageSel {
  return { docId, pages: [page], anchor: page, focus: page };
}

export function allPages(docId: string, order: number[]): PageSel | null {
  if (!order.length) return null;
  return { docId, pages: [...order], anchor: order[0], focus: order[order.length - 1] };
}

/** サムネイルをクリックしたときの新しい選択 */
export function clickPage(
  prev: PageSel | null,
  docId: string,
  order: number[],
  page: number,
  mode: { toggle?: boolean; range?: boolean } = {},
): PageSel {
  const same = prev && prev.docId === docId ? prev : null;
  if (mode.range && same && order.includes(same.anchor)) {
    return { docId, pages: pageRange(order, same.anchor, page), anchor: same.anchor, focus: page };
  }
  if (mode.toggle && same) {
    const next = same.pages.includes(page) ? same.pages.filter((p) => p !== page) : [...same.pages, page];
    return { docId, pages: order.filter((p) => next.includes(p)), anchor: page, focus: page };
  }
  return singlePage(docId, page);
}

/** 矢印キーなどで選択を動かす。extend なら起点から動かした先までの範囲にする */
export function stepPage(sel: PageSel, order: number[], to: number | "first" | "last", extend: boolean): PageSel | null {
  if (!order.length) return null;
  const at = order.indexOf(sel.focus);
  const from = at >= 0 ? at : Math.max(0, order.findIndex((p) => sel.pages.includes(p)));
  const idx = to === "first" ? 0 : to === "last" ? order.length - 1 : Math.min(order.length - 1, Math.max(0, from + to));
  const page = order[idx];
  if (extend) {
    const anchor = order.includes(sel.anchor) ? sel.anchor : page;
    return { docId: sel.docId, pages: pageRange(order, anchor, page), anchor, focus: page };
  }
  return singlePage(sel.docId, page);
}

/** 並べ替えが終わったあと、選択から外れたページ（削除・文書の入れ替え）を取り除く */
export function trimSelection(sel: PageSel | null, order: number[] | null | undefined): PageSel | null {
  if (!sel || !order) return null;
  const pages = order.filter((p) => sel.pages.includes(p));
  if (pages.length === sel.pages.length) return sel;
  if (!pages.length) return null;
  return {
    ...sel,
    pages,
    anchor: pages.includes(sel.anchor) ? sel.anchor : pages[0],
    focus: pages.includes(sel.focus) ? sel.focus : pages[pages.length - 1],
  };
}

/** pages を削除したあとに選ぶページ：削除した先頭の位置にあった（次の）ページ。末尾を消したときは直前のページ。残らなければ null */
export function pageAfterDelete(order: number[], pages: number[]): number | null {
  const gone = new Set(pages);
  const first = order.findIndex((p) => gone.has(p));
  const rest = order.filter((p) => !gone.has(p));
  if (!rest.length) return null;
  return rest[Math.min(first < 0 ? 0 : first, rest.length - 1)];
}

/**
 * pages（表示順のまま）をひとまとめにして、at（0〜order.length：表示順で何番目の前に入れるか）へ動かす。
 * 動かす側のページが at より前にあった分は、抜けた分だけ入れる位置が前にずれる
 */
export function moveBlock(order: number[], pages: number[], at: number): number[] {
  const moving = order.filter((p) => pages.includes(p));
  if (!moving.length) return order;
  const before = order.slice(0, at).filter((p) => pages.includes(p)).length;
  const rest = order.filter((p) => !pages.includes(p));
  const target = at - before;
  return [...rest.slice(0, target), ...moving, ...rest.slice(target)];
}

import { useLayoutEffect, type RefObject } from "react";

/** 画面の端からあけておく余白（px） */
const MARGIN = 8;

/**
 * ページの上に出す操作バーを、いま見えている範囲（スクロールする表示領域）の中に収める。
 * バーの幅を実際に測って、はみ出す分だけ横にずらす（CSS の --dx）。
 * 画面の端の近くに作った枠・マスクでも、バーの端が切れて押せなくならない。
 * スクロール・画面の大きさ・表示領域とバー自身の大きさが変わったときも、そのつど合わせ直す。key は、バーの位置や中身が変わったことを知らせる値
 */
export function useKeepInView(ref: RefObject<HTMLElement | null>, key: unknown) {
  useLayoutEffect(() => {
    const el = ref.current;
    const area = el?.closest<HTMLElement>(".viewer");
    if (!el || !area) return;
    const fit = () => {
      el.style.setProperty("--dx", "0px");
      const r = el.getBoundingClientRect();
      const v = area.getBoundingClientRect();
      let dx = 0;
      if (r.right > v.right - MARGIN) dx = v.right - MARGIN - r.right;
      // 広すぎて収まらないときは、左端が見えることを優先する
      if (r.left + dx < v.left + MARGIN) dx = v.left + MARGIN - r.left;
      el.style.setProperty("--dx", `${Math.round(dx)}px`);
    };
    fit();
    area.addEventListener("scroll", fit, { passive: true });
    window.addEventListener("resize", fit);
    // バー自身の幅が変わったとき（隠し方を変えてボタンが増減した、文言が長くなったなど）、
    // 表示領域の大きさが変わったとき（検索パネルやマスク一覧を開いて狭くなったなど。ウィンドウの大きさは変わらない）も
    const watch = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    watch?.observe(el);
    watch?.observe(area);
    return () => {
      area.removeEventListener("scroll", fit);
      window.removeEventListener("resize", fit);
      watch?.disconnect();
    };
  }, [ref, key]);
}

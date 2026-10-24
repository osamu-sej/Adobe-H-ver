/** 全角数字・全角英字などを半角にそろえる（NFKC）。検索・同値判定・検証で共通に使う */
export function normalize(s: string): string {
  return s.normalize("NFKC");
}

/** 区切りとして扱う横棒のなかま（ハイフン・長音・マイナスなど） */
export const DASH_CHARS = "-‐‑‒–—―−ーｰ";

export function isDigit(c: string): boolean {
  return c.length > 0 && c >= "0" && c <= "9";
}

/** text 中の needle の出現数（前後が数字に連続している場合は別の数とみなして数えない） */
export function countStandalone(text: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  const startsDigit = isDigit(needle[0]);
  const endsDigit = isDigit(needle[needle.length - 1]);
  let i = text.indexOf(needle);
  while (i >= 0) {
    const before = i > 0 ? text[i - 1] : "";
    const after = text[i + needle.length] ?? "";
    const okBefore = !(startsDigit && isDigit(before));
    const okAfter = !(endsDigit && isDigit(after));
    if (okBefore && okAfter) hits.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return hits;
}

/** 同じ値の検出・残存チェックの対象にするか（短すぎる値は誤検出が多いので除外） */
export function isMeaningfulValue(s: string): boolean {
  const t = s.replace(/\s+/g, "");
  if (t.length < 3) return false;
  const digits = (t.match(/\d/g) ?? []).length;
  return digits >= 3 || t.length >= 4;
}

import { describe, expect, it } from "vitest";
import { presetRegex } from "./presets";
import { buildIndex, numberGroupAt, searchIndex, snapToRange, wordAt } from "./text";
import type { PageText } from "./types";

/** 1文字6pt幅・1行16ptの擬似ページ */
function fakePage(lines: string[], size = 10): PageText {
  const chars: string[] = [];
  const boxes: number[] = [];
  const ls: number[] = [];
  const sizes: number[] = [];
  lines.forEach((line, li) => {
    [...line].forEach((c, ci) => {
      chars.push(c);
      boxes.push(ci * 6, li * 16, ci * 6 + 6, li * 16 + 12);
      ls.push(li);
      sizes.push(size);
    });
  });
  return { chars, boxes: new Float32Array(boxes), lines: new Int32Array(ls), sizes: new Float32Array(sizes) };
}

function hits(preset: string, lines: string[]) {
  return searchIndex(buildIndex(fakePage(lines)), presetRegex(preset)!).map((m) => m.text);
}

describe("数字のかたまり", () => {
  const idx = buildIndex(fakePage(["電話：090-1234-5678 です", "金額 ¥1,234,567", "カード 4111 1111 1111 1111", "2026年10月24日"]));
  const group = (line: number, col: number) => {
    const start = idx.lineRanges[line][0];
    const g = numberGroupAt(idx, start + col);
    return g ? idx.norm.slice(g[0], g[1]).join("") : null;
  };
  it("ハイフン区切りの電話番号を1つにまとめる", () => {
    expect(group(0, 4)).toBe("090-1234-5678");
  });
  it("カンマ区切りの金額をまとめ、通貨記号は含めない", () => {
    expect(group(1, 6)).toBe("1,234,567");
  });
  it("狭い空白で区切られたカード番号をまとめる", () => {
    expect(group(2, 5)).toBe("4111 1111 1111 1111");
  });
  it("漢字をまたいではつながない", () => {
    expect(group(3, 0)).toBe("2026");
  });
  it("数字でない文字では null", () => {
    expect(group(0, 0)).toBeNull();
  });
  it("数字の直前の符号（▲・＋・－）も数字に含める。英数字のつなぎの「-」は含めない", () => {
    const signs = buildIndex(fakePage(["差 ▲27 前年 +5.9 と -0.6", "型番 AB-123"]));
    const at = (line: number, col: number) => {
      const g = numberGroupAt(signs, signs.lineRanges[line][0] + col);
      return g ? signs.norm.slice(g[0], g[1]).join("") : null;
    };
    expect(at(0, 3)).toBe("▲27");
    expect(at(0, 10)).toBe("+5.9");
    expect(at(0, 17)).toBe("-0.6");
    expect(at(1, 6)).toBe("123");
  });
  it("単語は同じ字種でまとめる", () => {
    const start = idx.lineRanges[0][0];
    const w = wordAt(idx, start)!;
    expect(idx.norm.slice(w[0], w[1]).join("")).toBe("電話");
  });
});

describe("ドラッグ範囲への吸着", () => {
  const idx = buildIndex(fakePage(["TEL 03-1234-5678 / FAX 03-9999-0000"]));
  it("数字モードでは範囲内の数字だけを覆う", () => {
    const r = snapToRange(idx, { x: 0, y: 0, w: 6 * 17, h: 14 }, "digits");
    expect(r.map((s) => s.text)).toEqual(["03-1234-5678"]);
    expect(r[0].rect.x).toBeGreaterThan(6 * 3);
  });
  it("離れた数字は別々の矩形にする", () => {
    const r = snapToRange(idx, { x: 0, y: 0, w: 6 * 40, h: 14 }, "digits");
    expect(r.map((s) => s.text)).toEqual(["03-1234-5678", "03-9999-0000"]);
  });
  it("文字モードでは文字全般を覆う", () => {
    const r = snapToRange(idx, { x: 0, y: 0, w: 6 * 3, h: 14 }, "text");
    expect(r.map((s) => s.text)).toEqual(["TEL"]);
  });
  it("自由モードでは吸着しない", () => {
    expect(snapToRange(idx, { x: 0, y: 0, w: 100, h: 14 }, "free")).toEqual([]);
  });
});

describe("文字モードは数字を隠さない・数字モードは文字を隠さない", () => {
  const idx = buildIndex(
    fakePage(["担当：山田 太郎（携帯 090-1234-5678）", "2026年10月24日", "金額 ¥1,234,567", "INV-2026-001234 E10231"]),
  );
  const line = (n: number) => ({ x: 0, y: n * 16, w: 6 * 40, h: 14 });
  const texts = (n: number, mode: "digits" | "text") => snapToRange(idx, line(n), mode).map((s) => s.text);
  it("文字モード：数字の前後の文字だけを覆い、電話番号は残す", () => {
    expect(texts(0, "text")).toEqual(["担当:山田太郎(携帯", ")"]);
  });
  it("文字モード：日付は年・月・日だけ", () => {
    expect(texts(1, "text")).toEqual(["年", "月", "日"]);
  });
  it("数字モード：日付は数字だけ（年・月・日は残す）", () => {
    expect(texts(1, "digits")).toEqual(["2026", "10", "24"]);
  });
  it("通貨記号はどちらのモードでも隠さない", () => {
    expect(texts(2, "text")).toEqual(["金額"]);
    expect(texts(2, "digits")).toEqual(["1,234,567"]);
  });
  it("英数字が混ざる番号は、文字モードでは英字だけ", () => {
    expect(texts(3, "text")).toEqual(["INV-", "E"]);
  });
  it("文字モードで数字をクリックしても何も選ばない", () => {
    const start = idx.lineRanges[0][0];
    expect(wordAt(idx, start + 13)).toBeNull();
  });
  it("文字モードで英字をクリックすると、端の記号を除いた英字だけ", () => {
    const start = idx.lineRanges[3][0];
    const w = wordAt(idx, start + 1)!;
    expect(idx.norm.slice(w[0], w[1]).join("")).toBe("INV");
  });
});

describe("検索プリセット", () => {
  it("電話番号", () => {
    expect(hits("phone", ["TEL 03-1234-5678 携帯 090-1234-5678", "(03)1234-5678 と 09012345678", "郵便 100-0001 日付 2026-10-24"])).toEqual([
      "03-1234-5678",
      "090-1234-5678",
      "(03)1234-5678",
      "09012345678",
    ]);
  });
  it("金額（通貨記号は残して数字だけ）", () => {
    expect(hits("money", ["¥1,234,567 と 12,000円 と 300円", "数量 120"])).toEqual(["1,234,567", "12,000", "300"]);
  });
  it("全角の数字も見つける", () => {
    expect(hits("money", ["￥１，２００"])).toEqual(["1,200"]);
  });
  it("日付", () => {
    expect(hits("date", ["2026/10/24", "2026年10月24日", "令和8年10月20日", "電話 03-1234-5678"])).toEqual([
      "2026/10/24",
      "2026年10月24日",
      "令和8年10月20日",
    ]);
  });
  it("カード番号", () => {
    expect(hits("card", ["4980 1234 5678 9012", "4980-1234-5678-9012", "1234 5678 9012"])).toEqual([
      "4980 1234 5678 9012",
      "4980-1234-5678-9012",
    ]);
  });
  it("マイナンバー（カード番号の一部は拾わない）", () => {
    expect(hits("mynumber", ["1234 5678 9012", "4980 1234 5678 9012", "123456789012"])).toEqual([
      "1234 5678 9012",
      "123456789012",
    ]);
  });
  it("口座番号（7桁）", () => {
    expect(hits("account", ["普通 1234567", "12345678", "1,234,567"])).toEqual(["1234567"]);
  });
  it("郵便番号", () => {
    expect(hits("postal", ["〒100-0001", "03-1234-5678"])).toEqual(["100-0001"]);
  });
  it("メール", () => {
    expect(hits("email", ["taro.yamada@example.co.jp まで"])).toEqual(["taro.yamada@example.co.jp"]);
  });
});

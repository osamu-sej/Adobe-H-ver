import { describe, expect, it } from "vitest";
import type { TextFrame } from "../model/types";
import { clampSize, drawFrame, FRAME_LINE, FRAME_PAD, FRAME_SIZES, neededHeight, stepSize, textHeight, wrapText } from "./frames";

/** 1文字を size の幅として数える（日本語の全角文字と同じ） */
const wide = (size: number) => () => size;

const frame = (over: Partial<TextFrame> = {}): TextFrame => ({
  id: "t1",
  docId: "d",
  page: 0,
  x: 10,
  y: 20,
  w: 100,
  h: 60,
  text: "テスト",
  size: 10,
  bold: false,
  color: "#112233",
  align: "left",
  fill: null,
  line: null,
  ...over,
});

describe("テキスト枠の折り返し", () => {
  it("幅に入りきらないところで折り返す。改行はそのまま", () => {
    expect(wrapText(wide(10), "あいうえおかきくけこ", 50)).toEqual(["あいうえお", "かきくけこ"]);
    expect(wrapText(wide(10), "あい\nうえお", 100)).toEqual(["あい", "うえお"]);
    expect(wrapText(wide(10), "", 100)).toEqual([""]);
    expect(wrapText(wide(10), "あ\n\nい", 100)).toEqual(["あ", "", "い"]);
  });

  it("行末の空白は折り返さず、次の行の頭には来ない", () => {
    expect(wrapText(wide(10), "ああああ ああ", 40)).toEqual(["ああああ ", "ああ"]);
  });

  it("1文字が幅より広くても、その文字を1行に置く（進まなくなったりしない）", () => {
    expect(wrapText(wide(30), "あい", 10)).toEqual(["あ", "い"]);
  });
});

describe("文字の大きさの段階", () => {
  it("大きく・小さくするときは、PowerPoint と同じ段階を1つずつ動く", () => {
    expect(stepSize(14, 1)).toBe(16);
    expect(stepSize(14, -1)).toBe(12);
    expect(stepSize(10.5, 1)).toBe(11);
    expect(stepSize(10.5, -1)).toBe(10);
  });

  it("段階にない大きさは、いちばん近い上下の段階へ。両端では止まる", () => {
    expect(stepSize(13, 1)).toBe(14);
    expect(stepSize(13, -1)).toBe(12);
    expect(stepSize(96, 1)).toBe(96);
    expect(stepSize(8, -1)).toBe(8);
    expect(stepSize(5, -1)).toBe(5);
    expect(stepSize(120, 1)).toBe(120);
    expect(FRAME_SIZES).toEqual([...FRAME_SIZES].sort((a, b) => a - b));
  });

  it("入力した大きさは、小数1桁まで・4〜400ptに収める", () => {
    expect(clampSize(0)).toBe(4);
    expect(clampSize(1000)).toBe(400);
    expect(clampSize(12.34)).toBe(12.3);
  });
});

describe("枠の高さ", () => {
  it("文字が入りきる高さは、行数×行の高さ＋上下の余白", () => {
    // 1文字 = size(10) の幅。内側の幅 100-8=92 → 9文字で折り返す
    const f = { text: "あ".repeat(10), size: 10, bold: false, w: 100 };
    expect(neededHeight(f)).toBeCloseTo(textHeight(2, 10) + FRAME_PAD * 2);
    expect(neededHeight({ ...f, text: "あ" })).toBeCloseTo(10 * FRAME_LINE + FRAME_PAD * 2);
  });
});

/** 描画の呼び出しを記録するだけのキャンバス */
function recorder() {
  const calls: { op: string; args: unknown[] }[] = [];
  const ctx = new Proxy(
    { font: "", fillStyle: "", strokeStyle: "", textAlign: "", textBaseline: "", lineWidth: 0 },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        return (...args: unknown[]) => {
          calls.push({ op: prop, args });
          if (prop === "measureText") return { width: 10 };
        };
      },
      set(target, prop: string, value) {
        (target as Record<string, unknown>)[prop] = value;
        calls.push({ op: `set:${prop}`, args: [value] });
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("テキスト枠の描画", () => {
  it("枠の中で切り取り、左揃えは左の余白の位置から行ごとに描く", () => {
    const { ctx, calls } = recorder();
    drawFrame(ctx, frame({ text: "あ\nい" }));
    expect(calls.find((c) => c.op === "rect")?.args).toEqual([10, 20, 100, 60]);
    const texts = calls.filter((c) => c.op === "fillText");
    expect(texts.map((t) => t.args[0])).toEqual(["あ", "い"]);
    expect(texts[0].args[1]).toBe(10 + FRAME_PAD);
    expect(texts[0].args[2]).toBeCloseTo(20 + FRAME_PAD + 0.5 * 10 * FRAME_LINE);
    expect(texts[1].args[2]).toBeCloseTo(20 + FRAME_PAD + 1.5 * 10 * FRAME_LINE);
    expect(calls.some((c) => c.op === "set:textAlign" && c.args[0] === "left")).toBe(true);
  });

  it("中央・右揃えの位置、太字、塗り、枠線", () => {
    const center = recorder();
    drawFrame(center.ctx, frame({ align: "center", bold: true, fill: "#ffeeaa", line: "#000000" }));
    expect(center.calls.find((c) => c.op === "fillText")?.args[1]).toBe(10 + 50);
    expect(center.calls.find((c) => c.op === "fillRect")?.args).toEqual([10, 20, 100, 60]);
    expect(center.calls.some((c) => c.op === "set:font" && String(c.args[0]).startsWith("700 10px"))).toBe(true);
    expect(center.calls.find((c) => c.op === "strokeRect")).toBeTruthy();
    const right = recorder();
    drawFrame(right.ctx, frame({ align: "right" }));
    expect(right.calls.find((c) => c.op === "fillText")?.args[1]).toBe(10 + 100 - FRAME_PAD);
  });

  it("塗りも枠線もないときは、文字だけを描く", () => {
    const { calls } = recorder();
    drawFrame(recorder().ctx, frame());
    const r = recorder();
    drawFrame(r.ctx, frame());
    expect(r.calls.some((c) => c.op === "fillRect" || c.op === "strokeRect")).toBe(false);
    expect(calls).toEqual([]);
  });
});

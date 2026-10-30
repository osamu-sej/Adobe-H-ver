import { readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { resolveStrength } from "../fx/effects";
import { presetRegex } from "../model/presets";
import { buildIndex, searchIndex } from "../model/text";
import type { Level, MaskStyle } from "../model/types";
import { runExport } from "./exporter";
import type { FrameRenderer } from "./exporter";
import type { ExportFrame, ExportMask, ExportOptions } from "./protocol";
import { extractPageText } from "./textExtract";

const SAMPLE = new Uint8Array(readFileSync(new URL("../../public/sample.pdf", import.meta.url)));

function findMasks(
  page: number,
  preset: string,
  style: MaskStyle,
  label: string | null = null,
  level: Level = "strong",
  fill = { color: "#000000", opacity: 1 },
): ExportMask[] {
  const doc = new mupdf.PDFDocument(SAMPLE);
  const idx = buildIndex(extractPageText(doc.loadPage(page), mupdf));
  doc.destroy();
  return searchIndex(idx, presetRegex(preset)!).flatMap((m, i) =>
    m.rects.map((r) => ({
      ...r,
      id: `${preset}-${page}-${i}`,
      page,
      style,
      strength: resolveStrength({ ...r, strength: null, level }),
      ...fill,
      label,
      text: m.text,
    })),
  );
}

const baseOptions: ExportOptions = {
  mode: "separate",
  mergedName: "merged.pdf",
  rasterize: false,
  keepText: false,
  rasterDpi: 150,
  flatten: true,
  stripMetadata: true,
  stripExtras: true,
  stripOutlines: false,
  props: null,
  encryption: null,
};

function textOf(bytes: Uint8Array, password = ""): string[] {
  const doc = new mupdf.PDFDocument(bytes);
  if (doc.needsPassword()) doc.authenticatePassword(password);
  const out: string[] = [];
  for (let i = 0; i < doc.countPages(); i++) out.push(doc.loadPage(i).toStructuredText("preserve-whitespace").asText().normalize("NFKC"));
  doc.destroy();
  return out;
}

const source = () => ({ bytes: SAMPLE });

describe("書き出し（墨消し）", () => {
  it("マスクした文字は消え、マスク外は変わらない", async () => {
    const masks = [
      ...findMasks(0, "phone", "mosaic"),
      ...findMasks(0, "money", "blur"),
      ...findMasks(0, "account", "fill", "非開示"),
      ...findMasks(1, "mynumber", "fill", null, "strong", { color: "#ffffff", opacity: 1 }),
      // スキャン画像のページ（文字層なし）は自由範囲で
      {
        id: "free",
        page: 3,
        x: 180,
        y: 190,
        w: 150,
        h: 40,
        style: "mosaic" as const,
        strength: 8,
        color: "#000000",
        opacity: 1,
        label: null,
      },
    ];
    expect(masks.length).toBeGreaterThan(10);
    const result = await runExport(
      mupdf,
      {
        docs: [{ docId: "a", name: "out.pdf", order: [0, 1, 2, 3], rot: {}, masks }],
        options: baseOptions,
      },
      source,
      () => {},
    );
    const [file] = result.files;
    if (process.env.KAKUSU_DUMP) writeFileSync(process.env.KAKUSU_DUMP, file.bytes);
    const r = file.report;
    expect(r.leakedChars).toBe(0);
    expect(r.pixelDiffPercent).toBeLessThan(0.5);
    expect(r.hasXmp).toBe(false);
    expect(r.metadata.Title).toBeUndefined();
    expect(r.metadata.Author).toBeUndefined();
    expect(r.passed).toBe(true);

    const pages = textOf(file.bytes);
    expect(pages[0]).not.toContain("1234567");
    expect(pages[0]).not.toContain("1,234,567");
    expect(pages[0]).not.toContain("090-1234-5678");
    expect(pages[0]).toContain("請求書");
    expect(pages[1]).not.toMatch(/\d{4} \d{4} \d{4}/);
    // 3ページ目に同じ電話番号が残っていることを検証が知らせる
    expect(r.residues.some((x) => x.text === "090-1234-5678" && x.pages.includes(3))).toBe(true);
  });

  it("並べ替え・回転・暗号化しても検証が通る", async () => {
    const masks = findMasks(1, "phone", "mosaic");
    const result = await runExport(
      mupdf,
      {
        docs: [{ docId: "a", name: "out.pdf", order: [1, 0, 2], rot: { 1: 90 }, masks }],
        options: {
          ...baseOptions,
          props: { title: "公開用", author: "", subject: "", keywords: "" },
          encryption: {
            method: "aes-256",
            userPassword: "open",
            ownerPassword: "owner",
            permissions: { print: true, copy: false, edit: false, annotate: false, form: false, assemble: false, accessibility: true },
          },
        },
      },
      source,
      () => {},
    );
    const [file] = result.files;
    expect(file.pages).toBe(3);
    expect(file.report.leakedChars).toBe(0);
    expect(file.report.pixelDiffPercent).toBeLessThan(0.5);
    expect(file.report.encrypted).toMatch(/AES/);
    expect(file.report.metadata.Title).toBe("公開用");
    expect(file.report.passed).toBe(true);

    const doc = new mupdf.PDFDocument(file.bytes);
    expect(doc.needsPassword()).toBe(true);
    expect(doc.authenticatePassword("open")).toBeGreaterThan(0);
    const first = doc.loadPage(0);
    const b = first.getBounds();
    expect(b[2] - b[0]).toBeGreaterThan(b[3] - b[1]); // 回転して横長
    expect(doc.hasPermission("copy")).toBe(false);
    expect(doc.hasPermission("print")).toBe(true);
    doc.destroy();
  });

  it("見た目だけ重ねる：加工は画面どおりに重なり、元の文字は残る", async () => {
    const masks = findMasks(0, "phone", "blur", null, "weak");
    const result = await runExport(
      mupdf,
      {
        docs: [{ docId: "a", name: "out.pdf", order: [0], rot: {}, masks }],
        options: { ...baseOptions, keepText: true },
      },
      source,
      () => {},
    );
    const [file] = result.files;
    expect(file.report.textKept).toBe(true);
    expect(file.report.passed).toBe(true);
    expect(file.report.residues).toEqual([]);
    expect(file.report.pixelDiffPercent).toBeLessThan(0.5);
    // 元の文字は残る
    expect(textOf(file.bytes)[0]).toContain("090-1234-5678");
    // マスクの場所には、ぼかしが重なっている（元の見た目と違う）
    const out = new mupdf.PDFDocument(file.bytes);
    const src = new mupdf.PDFDocument(SAMPLE);
    const m = masks[0];
    const crop = (d: mupdf.PDFDocument) => {
      const pix = d.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
      const px = pix.getPixels();
      const vals: number[] = [];
      for (let y = Math.ceil(m.y * 2); y < Math.floor((m.y + m.h) * 2); y++)
        for (let x = Math.ceil(m.x * 2); x < Math.floor((m.x + m.w) * 2); x++) vals.push(px[(y * pix.getWidth() + x) * 3]);
      return vals;
    };
    const a = crop(src);
    const b = crop(out);
    const changed = a.filter((v, i) => Math.abs(v - b[i]) > 24).length / a.length;
    expect(changed).toBeGreaterThan(0.1);
    out.destroy();
    src.destroy();
  });

  it("塗りつぶし：色と透明度は画面どおりに書き出され、透けていても元の文字は消える", async () => {
    const solid = findMasks(0, "phone", "fill", null, "strong", { color: "#3b6fd8", opacity: 1 });
    const clear = findMasks(0, "money", "fill", null, "strong", { color: "#e8492a", opacity: 0.4 });
    const result = await runExport(
      mupdf,
      { docs: [{ docId: "a", name: "out.pdf", order: [0], rot: {}, masks: [...solid, ...clear] }], options: baseOptions },
      source,
      () => {},
    );
    const [file] = result.files;
    expect(file.report.leakedChars).toBe(0);
    expect(file.report.passed).toBe(true);
    const text = textOf(file.bytes)[0];
    expect(text).not.toContain("090-1234-5678");
    expect(text).not.toContain("1,234,567");

    const render = (bytes: Uint8Array) => {
      const d = new mupdf.PDFDocument(bytes);
      const pix = d.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
      const out = { px: pix.getPixels().slice(), w: pix.getWidth() };
      pix.destroy();
      d.destroy();
      return out;
    };
    const out = render(file.bytes);
    const src = render(SAMPLE);
    const inside = (m: ExportMask) => {
      const idx: number[] = [];
      for (let y = Math.ceil(m.y * 2) + 1; y < Math.floor((m.y + m.h) * 2) - 1; y++)
        for (let x = Math.ceil(m.x * 2) + 1; x < Math.floor((m.x + m.w) * 2) - 1; x++) idx.push((y * out.w + x) * 3);
      return idx;
    };

    // 不透明：選んだ色そのもの
    for (const i of inside(solid[0])) expect([...out.px.slice(i, i + 3)]).toEqual([59, 111, 216]);

    // 透ける：元の見た目に色を40%重ねたもの（文字の濃淡が透けて見える）
    const color = [232, 73, 42];
    const idx = inside(clear[0]);
    let diff = 0;
    for (const i of idx) for (let c = 0; c < 3; c++) diff += Math.abs(out.px[i + c] - (src.px[i + c] * 0.6 + color[c] * 0.4));
    expect(diff / (idx.length * 3)).toBeLessThan(12);
    const greens = idx.map((i) => out.px[i + 1]);
    expect(Math.max(...greens) - Math.min(...greens)).toBeGreaterThan(60);
  });

  it("結合＋画像化では文字が一切残らない", async () => {
    const result = await runExport(
      mupdf,
      {
        docs: [
          { docId: "a", name: "a.pdf", order: [0], rot: {}, masks: findMasks(0, "phone", "fill") },
          { docId: "b", name: "b.pdf", order: [2], rot: {}, masks: findMasks(2, "card", "mosaic") },
        ],
        options: { ...baseOptions, mode: "merge", rasterize: true, rasterDpi: 100 },
      },
      source,
      () => {},
    );
    expect(result.files).toHaveLength(1);
    const [file] = result.files;
    expect(file.pages).toBe(2);
    expect(file.report.leakedChars).toBe(0);
    expect(file.report.passed).toBe(true);
    expect(textOf(file.bytes).join("").trim()).toBe("");
  });

  describe("テキスト枠", () => {
    /** キャンバスのない環境用：枠の左半分を赤で不透明、右半分を透明にした画像を返す */
    const calls: { w: number; h: number; scale: number }[] = [];
    const halfRed: FrameRenderer = (f, scale) => {
      calls.push({ w: f.w, h: f.h, scale });
      const width = Math.ceil(f.w * scale);
      const height = Math.ceil(f.h * scale);
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          data[i] = 255;
          data[i + 3] = x < width / 2 ? 255 : 0;
        }
      return { width, height, data };
    };
    const frame = (over: Partial<ExportFrame> = {}): ExportFrame => ({
      id: "t1",
      page: 0,
      x: 100,
      y: 300,
      w: 200,
      h: 60,
      text: "テスト",
      size: 14,
      bold: false,
      color: "#000000",
      align: "left",
      fill: null,
      line: null,
      ...over,
    });
    const pixel = (bytes: Uint8Array, pageNo: number, x: number, y: number) => {
      const doc = new mupdf.PDFDocument(bytes);
      const pix = doc.loadPage(pageNo).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      const px = pix.getPixels();
      const i = (y - pix.getY()) * pix.getStride() + (x - pix.getX()) * 3;
      const rgb = [px[i], px[i + 1], px[i + 2]];
      doc.destroy();
      return rgb;
    };

    it("枠の画像をページに重ねる。透明な所は下のページが見え、枠のないページは変わらない", async () => {
      calls.length = 0;
      const base = await runExport(
        mupdf,
        { docs: [{ docId: "a", name: "out.pdf", order: [0, 1], rot: {}, masks: [] }], options: baseOptions },
        source,
        () => {},
      );
      const result = await runExport(
        mupdf,
        { docs: [{ docId: "a", name: "out.pdf", order: [0, 1], rot: {}, masks: [], frames: [frame()] }], options: baseOptions },
        source,
        () => {},
        halfRed,
      );
      const [file] = result.files;
      expect(file.frames).toBe(1);
      expect(calls).toEqual([{ w: 200, h: 60, scale: 4 }]);
      // 左半分（不透明）は赤、右半分（透明）は元のページのまま（半透明の合成の丸めで1段階ずれることはある）
      const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(2));
      expect(pixel(file.bytes, 0, 130, 330)).toEqual([255, 0, 0]);
      near(pixel(file.bytes, 0, 270, 330), pixel(base.files[0].bytes, 0, 270, 330));
      // 枠のないページは書き出し前と同じ
      expect(pixel(file.bytes, 1, 130, 330)).toEqual(pixel(base.files[0].bytes, 1, 130, 330));
      // 枠のところは「マスク以外が変わった」とは数えない
      expect(file.report.passed).toBe(true);
      expect(file.report.diffPages).toEqual([]);
    });

    it("見えるものがない枠（文字も塗りも枠線もない）は書き込まない。並べ替え・回転しても枠は同じ元のページに付く", async () => {
      calls.length = 0;
      const result = await runExport(
        mupdf,
        {
          docs: [
            {
              docId: "a",
              name: "out.pdf",
              order: [1, 0],
              rot: { 0: 90 },
              masks: [],
              frames: [frame({ id: "empty", text: "  ", x: 10, y: 10 }), frame({ id: "t2", page: 0 })],
            },
          ],
          options: baseOptions,
        },
        source,
        () => {},
        halfRed,
      );
      expect(calls).toHaveLength(1);
      const [file] = result.files;
      expect(file.report.passed).toBe(true);
      // 元の0ページ目は書き出し後の2ページ目（90度回転）。枠の画像はそこにだけある
      const doc = new mupdf.PDFDocument(file.bytes);
      const imageCount = (i: number) => {
        let n = 0;
        const xo = doc.loadPage(i).getObject().get("Resources").get("XObject");
        if (xo.isDictionary()) xo.forEach(() => n++);
        return n;
      };
      expect(imageCount(1)).toBeGreaterThan(0);
      expect(imageCount(0)).toBe(0);
      doc.destroy();
    });
  });
});

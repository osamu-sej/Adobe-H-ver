import { readFileSync, writeFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { resolveStrength } from "../fx/effects";
import { presetRegex } from "../model/presets";
import { buildIndex, searchIndex } from "../model/text";
import type { MaskStyle } from "../model/types";
import { runExport } from "./exporter";
import type { ExportMask, ExportOptions } from "./protocol";
import { extractPageText } from "./textExtract";

const SAMPLE = new Uint8Array(readFileSync(new URL("../../public/sample.pdf", import.meta.url)));

function findMasks(page: number, preset: string, style: MaskStyle, label: string | null = null): ExportMask[] {
  const doc = new mupdf.PDFDocument(SAMPLE);
  const idx = buildIndex(extractPageText(doc.loadPage(page)));
  doc.destroy();
  return searchIndex(idx, presetRegex(preset)!).flatMap((m, i) =>
    m.rects.map((r) => ({
      ...r,
      id: `${preset}-${page}-${i}`,
      page,
      style,
      strength: resolveStrength({ ...r, strength: null }),
      label,
      text: m.text,
    })),
  );
}

const baseOptions: ExportOptions = {
  mode: "separate",
  mergedName: "merged.pdf",
  rasterize: false,
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
      ...findMasks(0, "account", "black", "非開示"),
      ...findMasks(1, "mynumber", "white"),
      // スキャン画像のページ（文字層なし）は自由範囲で
      { id: "free", page: 3, x: 180, y: 190, w: 150, h: 40, style: "mosaic" as const, strength: 8, label: null },
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

  it("結合＋画像化では文字が一切残らない", async () => {
    const result = await runExport(
      mupdf,
      {
        docs: [
          { docId: "a", name: "a.pdf", order: [0], rot: {}, masks: findMasks(0, "phone", "black") },
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
});

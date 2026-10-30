import type * as M from "mupdf";
import { drawLabel, hexToRgb, isOpaqueFill, renderPatch, type FillSpec, type Patch, type PixelSource } from "../fx/effects";
import { inflate, maskBounds, maskCorners, maskOverlapArea, toViewRect, type OrientedRect, type Point } from "../model/geometry";
import { countStandalone, isMeaningfulValue, normalize } from "../model/normalize";
import type { Rect, Rot } from "../model/types";
import type {
  ExportDoc,
  ExportFile,
  ExportJob,
  ExportMask,
  ExportOptions,
  ExportResult,
  Permissions,
  Residue,
  VerifyReport,
} from "./protocol";

type Mupdf = typeof M;
type Source = { bytes: Uint8Array; password?: string };
type Progress = (done: number, total: number, label: string) => void;

/** 書き出し後の各ページが、どの元ページから来て、どこにマスクがあるか */
interface PageMap {
  docId: string;
  srcPage: number;
  rot: Rot;
  /** 書き出し後のページ空間でのマスク位置 */
  masks: OrientedRect[];
  texts: string[];
}

/** モザイク・ぼかしの元にするページ画像の解像度（px/pt）。216dpi相当 */
const SAMPLE_SCALE = 3;
/** 重ねる画像の最大画素数 */
const PATCH_MAX_PIXELS = 2_500_000;

export async function runExport(
  mupdf: Mupdf,
  job: ExportJob,
  getSource: (docId: string) => Source,
  progress: Progress,
): Promise<ExportResult> {
  const opts = job.options;
  const total =
    job.docs.reduce((n, d) => n + new Set(d.masks.map((m) => m.page)).size + d.order.length * (opts.rasterize ? 2 : 1), 0) +
    1;
  let done = 0;
  const step = (label: string) => progress(++done, total, label);

  const open = (docId: string) => {
    const s = getSource(docId);
    const doc = new mupdf.PDFDocument(s.bytes);
    if (doc.needsPassword()) doc.authenticatePassword(s.password ?? "");
    return doc;
  };

  const outputs: { name: string; doc: M.PDFDocument; maps: PageMap[] }[] = [];
  const processed: { ed: ExportDoc; doc: M.PDFDocument; maps: PageMap[] }[] = [];

  for (const ed of job.docs) {
    const doc = open(ed.docId);
    const maps = await processDoc(mupdf, doc, ed, opts, step);
    processed.push({ ed, doc, maps });
  }

  if (opts.mode === "merge" && processed.length > 0) {
    const merged = new mupdf.PDFDocument();
    const maps: PageMap[] = [];
    for (const p of processed) {
      const graft = merged.newGraftMap();
      for (let i = 0; i < p.doc.countPages(); i++) graft.graftPage(-1, p.doc, i);
      maps.push(...p.maps);
    }
    outputs.push({ name: opts.mergedName, doc: merged, maps });
  } else {
    for (const p of processed) outputs.push({ name: p.ed.name, doc: p.doc, maps: p.maps });
  }

  const files: ExportFile[] = [];
  for (const out of outputs) {
    let doc = out.doc;
    if (opts.rasterize) doc = rasterize(mupdf, doc, opts.rasterDpi, step);
    applyMetadata(doc, opts);
    const buf = doc.saveToBuffer(saveOptions(opts));
    const bytes = buf.asUint8Array().slice();
    buf.destroy();
    const report = verify(mupdf, bytes, out.maps, opts, open, step);
    files.push({
      name: out.name,
      bytes,
      pages: out.maps.length,
      masks: out.maps.reduce((n, m) => n + m.masks.length, 0),
      report,
    });
  }
  for (const p of processed) p.doc.destroy();
  for (const o of outputs) if (!processed.some((p) => p.doc === o.doc)) o.doc.destroy();
  progress(total, total, "完了");
  return { files };
}

async function processDoc(
  mupdf: Mupdf,
  doc: M.PDFDocument,
  ed: ExportDoc,
  opts: ExportOptions,
  step: (label: string) => void,
): Promise<PageMap[]> {
  if (opts.flatten) {
    doc.bake(true, true);
    doc.getTrailer().get("Root").delete("AcroForm");
  }

  const byPage = new Map<number, ExportMask[]>();
  for (const m of ed.masks) {
    const list = byPage.get(m.page) ?? [];
    list.push(m);
    byPage.set(m.page, list);
  }

  const sizes: { w: number; h: number }[] = [];
  for (let i = 0; i < doc.countPages(); i++) {
    const p = doc.loadPage(i);
    const b = p.getBounds();
    sizes.push({ w: b[2] - b[0], h: b[3] - b[1] });
    p.destroy();
  }

  for (const [pageIndex, masks] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    if (pageIndex >= sizes.length) continue;
    await redactPage(mupdf, doc, pageIndex, masks, opts.keepText && !opts.rasterize);
    step(`${ed.name}：${pageIndex + 1}ページを加工中`);
  }

  // ユーザーが加えた回転
  for (const [k, r] of Object.entries(ed.rot)) {
    const idx = Number(k);
    if (!r || idx >= sizes.length) continue;
    const obj = doc.findPage(idx);
    const cur = obj.getInheritable("Rotate");
    const base = cur.isNumber() ? cur.asNumber() : 0;
    obj.put("Rotate", (((base + r) % 360) + 360) % 360);
  }

  if (opts.stripExtras) stripExtras(doc);
  if (opts.stripMetadata) stripPageMetadata(doc);

  const n = doc.countPages();
  const identity = ed.order.length === n && ed.order.every((v, i) => v === i);
  if (!identity) doc.rearrangePages(ed.order);

  return ed.order.map((src) => {
    const rot = (ed.rot[src] ?? 0) as Rot;
    const size = sizes[src];
    const ms = byPage.get(src) ?? [];
    return {
      docId: ed.docId,
      srcPage: src,
      rot,
      masks: ms.map((m) => ({ ...toViewRect(m, rot, size.w, size.h), angle: m.angle })),
      texts: ms.map((m) => m.text ?? "").filter(Boolean),
    };
  });
}

async function redactPage(mupdf: Mupdf, doc: M.PDFDocument, pageIndex: number, masks: ExportMask[], keepText: boolean) {
  const page = doc.loadPage(pageIndex);
  const b = page.getBounds();
  const [x0, y0] = b;
  const pw = b[2] - b[0];
  const ph = b[3] - b[1];
  const rotated = masks.some((m) => !!m.angle);

  // 1) 墨消し前のページ画像からモザイク・ぼかし（と透ける塗り）を作る
  let src: PixelSource | null = null;
  if ((!keepText && rotated) || masks.some((m) => m.style !== "fill" || !isOpaqueFill(m))) {
    const k = Math.min(SAMPLE_SCALE, Math.sqrt(30_000_000 / Math.max(1, pw * ph)));
    const pix = page.toPixmap(mupdf.Matrix.scale(k, k), mupdf.ColorSpace.DeviceRGB, false, true);
    src = {
      data: copyPixels(pix),
      width: pix.getWidth(),
      height: pix.getHeight(),
      channels: 3,
      originX: pix.getX() - x0 * k,
      originY: pix.getY() - y0 * k,
      scale: k,
    };
    pix.destroy();
  }

  type Overlay = ({ rect: Rect; fill: [number, number, number] } | { rect: Rect; image: M.PDFObject }) & { shape: ExportMask };
  const overlays: Overlay[] = [];
  for (const m of masks) {
    const rect = clipRect(maskBounds(m), pw, ph);
    if (rect.w <= 0 || rect.h <= 0) continue;
    // 不透明な塗りは図形で塗る。透ける塗りは、元の見た目に色を重ねた画像にする（下の文字を消しても透けて見える）
    if (m.style === "fill" && isOpaqueFill(m) && !m.label) {
      overlays.push({ rect, shape: m, fill: hexToRgb(m.color) });
      continue;
    }
    const outScale =
      m.style !== "mosaic" && src
        ? Math.min(src.scale, Math.sqrt(PATCH_MAX_PIXELS / (rect.w * rect.h)))
        : Math.min(4, Math.sqrt(PATCH_MAX_PIXELS / (rect.w * rect.h)));
    let patch = renderPatch(src ?? EMPTY_SOURCE, rect, m.style, m.strength, outScale, m);
    if (m.label) patch = withLabel(patch, m.label, m.style, m, rect);
    const image = new mupdf.Image(pixmapFromPatch(mupdf, patch));
    const ref = doc.addImage(image);
    image.destroy();
    ref.put("Interpolate", false);
    overlays.push({ rect, shape: m, image: ref });
  }

  // 図形は一部に触れるとMuPDFが図形全体を削除する。その外側の見た目を保つため、
  // マスク範囲を画素ごとに消したページ画像を、マスク外だけに重ねる。
  // 元画像には、クリッピングで隠すだけでなく、隠す領域の画素を残さない。
  let backdrop: M.PDFObject | undefined;
  if (!keepText && rotated && src) {
    const safe = new Uint8ClampedArray(src.data);
    for (const mask of masks) for (const r of redactionRects(mask, pw, ph)) {
      const xStart = Math.max(0, Math.floor(r.x * src.scale - src.originX));
      const xEnd = Math.min(src.width, Math.ceil((r.x + r.w) * src.scale - src.originX));
      const yStart = Math.max(0, Math.floor(r.y * src.scale - src.originY));
      const yEnd = Math.min(src.height, Math.ceil((r.y + r.h) * src.scale - src.originY));
      for (let y = yStart; y < yEnd; y++) safe.fill(255, (y * src.width + xStart) * 3, (y * src.width + xEnd) * 3);
    }
    const pixels = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, src.width, src.height], false);
    const dst = pixels.getPixels(), stride = pixels.getStride();
    for (let y = 0; y < src.height; y++) dst.set(safe.subarray(y * src.width * 3, (y + 1) * src.width * 3), y * stride);
    const image = new mupdf.Image(pixels); backdrop = doc.addImage(image); image.destroy(); pixels.destroy();
    backdrop.put("Interpolate", false);
  }

  // 2) 領域内の文字・画像・図形を恒久的に削除する（「見た目だけ重ねる」では消さない）
  if (!keepText) {
    for (const m of masks) {
      for (const r of redactionRects(m, pw, ph)) {
        const annot = page.createAnnotation("Redact");
        annot.setRect([x0 + r.x, y0 + r.y, x0 + r.x + r.w, y0 + r.y + r.h]);
      }
    }
    page.applyRedactions(
      false,
      mupdf.PDFPage.REDACT_IMAGE_PIXELS,
      rotated ? mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED : mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
      mupdf.PDFPage.REDACT_TEXT_REMOVE,
    );
  }

  // 3) モザイク画像・塗りを、画面と同じ見た目で重ねる
  const pageObj = page.getObject();
  let res = pageObj.get("Resources");
  if (!res.isDictionary()) {
    const inherited = pageObj.getInheritable("Resources");
    const copy = doc.newDictionary();
    if (inherited.isDictionary()) inherited.forEach((v, key) => copy.put(key, v));
    pageObj.put("Resources", copy);
    res = pageObj.get("Resources");
  }
  let xobjects = res.get("XObject");
  if (!xobjects.isDictionary()) {
    res.put("XObject", doc.newDictionary());
    xobjects = res.get("XObject");
  }
  const toUser = mupdf.Matrix.invert(page.getTransform());
  let ops = "Q\n";
  if (backdrop && src) {
    const name = `KakusuBackdrop${pageIndex}`;
    xobjects.put(name, backdrop);
    const m = mupdf.Matrix.concat([src.width / src.scale, 0, 0, -src.height / src.scale, x0 + src.originX / src.scale, y0 + (src.originY + src.height) / src.scale], toUser);
    const paths = masks.map((mask) => maskCorners(mask).map(([x,y], j) => {
      const p = apply(toUser, x0 + x, y0 + y);
      return `${num(p[0])} ${num(p[1])} ${j ? "l" : "m"}`;
    }).join(" ") + " h").join(" ");
    const pagePoints = [[x0,y0],[x0+pw,y0],[x0+pw,y0+ph],[x0,y0+ph]].map(([x,y],j) => {
      const p=apply(toUser,x,y);return `${num(p[0])} ${num(p[1])} ${j ? "l" : "m"}`;
    }).join(" ");
    ops += `q ${pagePoints} h ${paths} W* n ${m.map(num).join(" ")} cm /${name} Do Q\n`;
  }
  overlays.forEach((o, i) => {
    const fx = x0 + o.rect.x;
    const fy = y0 + o.rect.y;
    const points = maskCorners(o.shape).map(([x, y]) => apply(toUser, x0 + x, y0 + y));
    const clip = o.shape.angle ? `${points.map(([x, y], j) => `${num(x)} ${num(y)} ${j ? "l" : "m"}`).join(" ")} h W n ` : "";
    if ("fill" in o) {
      const a = apply(toUser, fx, fy);
      const c = apply(toUser, fx + o.rect.w, fy + o.rect.h);
      const ux = Math.min(a[0], c[0]);
      const uy = Math.min(a[1], c[1]);
      const [r, g, b] = o.fill.map((v) => num(v / 255));
      ops += `q ${clip}${r} ${g} ${b} rg ${num(ux)} ${num(uy)} ${num(Math.abs(c[0] - a[0]))} ${num(Math.abs(c[1] - a[1]))} re f Q\n`;
    } else {
      const name = `KakusuP${pageIndex}M${i}`;
      xobjects.put(name, o.image);
      const m = mupdf.Matrix.concat([o.rect.w, 0, 0, -o.rect.h, fx, fy + o.rect.h], toUser);
      ops += `q ${clip}${m.map(num).join(" ")} cm /${name} Do Q\n`;
    }
  });
  const contents = pageObj.get("Contents");
  const arr = doc.newArray();
  arr.push(doc.addStream("q\n", {}));
  if (contents.isArray()) contents.forEach((v) => arr.push(v));
  else if (!contents.isNull()) arr.push(contents);
  arr.push(doc.addStream(ops, {}));
  pageObj.put("Contents", arr);
  page.destroy();
}

const EMPTY_SOURCE: PixelSource = {
  data: new Uint8ClampedArray([255, 255, 255]),
  width: 1,
  height: 1,
  channels: 3,
  originX: 0,
  originY: 0,
  scale: 1,
};

function clipRect(r: Rect, w: number, h: number): Rect {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(w, r.x + r.w);
  const y1 = Math.min(h, r.y + r.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** MuPDFの矩形墨消しで、回転した領域を隙間なく覆う。細い水平帯で余分な削除を抑える。 */
function redactionRects(mask: OrientedRect, w: number, h: number): Rect[] {
  if (!mask.angle) {
    const r = clipRect(mask, w, h);
    return r.w > 0 && r.h > 0 ? [r] : [];
  }
  const corners = maskCorners(mask), bounds = clipRect(maskBounds(mask), w, h);
  if (bounds.w <= 0 || bounds.h <= 0) return [];
  const out: Rect[] = [];
  for (let y0 = bounds.y; y0 < bounds.y + bounds.h; y0 += 0.5) {
    const y1 = Math.min(bounds.y + bounds.h, y0 + 0.5);
    const points: Point[] = corners.filter((p) => p[1] >= y0 && p[1] <= y1);
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      for (const y of [y0, y1]) if ((a[1] < y && b[1] > y) || (b[1] < y && a[1] > y)) {
        const t = (y - a[1]) / (b[1] - a[1]);
        points.push([a[0] + t * (b[0] - a[0]), y]);
      }
    }
    if (!points.length) continue;
    const x0 = Math.max(0, Math.min(...points.map((p) => p[0])));
    const x1 = Math.min(w, Math.max(...points.map((p) => p[0])));
    if (x1 > x0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return out;
}

function apply(m: M.Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function num(v: number): string {
  return (Math.round(v * 10000) / 10000).toString();
}

function copyPixels(pix: M.Pixmap): Uint8ClampedArray {
  const w = pix.getWidth();
  const h = pix.getHeight();
  const n = pix.getNumberOfComponents() + pix.getAlpha();
  const stride = pix.getStride();
  const view = pix.getPixels();
  if (stride === w * n) return new Uint8ClampedArray(view);
  const out = new Uint8ClampedArray(w * h * n);
  for (let y = 0; y < h; y++) out.set(view.subarray(y * stride, y * stride + w * n), y * w * n);
  return out;
}

function pixmapFromPatch(mupdf: Mupdf, patch: Patch): M.Pixmap {
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, patch.width, patch.height], false);
  const stride = pix.getStride();
  const view = pix.getPixels();
  for (let y = 0; y < patch.height; y++) {
    let p = y * stride;
    let q = y * patch.width * 4;
    for (let x = 0; x < patch.width; x++) {
      view[p] = patch.data[q];
      view[p + 1] = patch.data[q + 1];
      view[p + 2] = patch.data[q + 2];
      p += 3;
      q += 4;
    }
  }
  return pix;
}

function withLabel(patch: Patch, label: string, style: ExportMask["style"], fill: FillSpec & OrientedRect, rect: Rect): Patch {
  if (typeof OffscreenCanvas === "undefined") return patch;
  const canvas = new OffscreenCanvas(patch.width, patch.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return patch;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(patch.data), patch.width, patch.height), 0, 0);
  if (fill.angle) {
    ctx.save();
    ctx.translate((fill.x + fill.w / 2 - rect.x) * patch.width / rect.w, (fill.y + fill.h / 2 - rect.y) * patch.height / rect.h);
    ctx.rotate(fill.angle * Math.PI / 180);
    const w = fill.w * patch.width / rect.w, h = fill.h * patch.height / rect.h;
    drawLabel(ctx, -w / 2, -h / 2, w, h, label, style, fill);
    ctx.restore();
  } else drawLabel(ctx, 0, 0, patch.width, patch.height, label, style, fill);
  const img = ctx.getImageData(0, 0, patch.width, patch.height);
  return { data: img.data, width: patch.width, height: patch.height };
}

function rasterize(mupdf: Mupdf, doc: M.PDFDocument, dpi: number, step: (label: string) => void): M.PDFDocument {
  const out = new mupdf.PDFDocument();
  const k = dpi / 72;
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const b = page.getBounds();
    const w = b[2] - b[0];
    const h = b[3] - b[1];
    const pix = page.toPixmap(mupdf.Matrix.scale(k, k), mupdf.ColorSpace.DeviceRGB, false, true);
    const jpeg = pix.asJPEG(88);
    pix.destroy();
    page.destroy();
    const image = new mupdf.Image(jpeg);
    const ref = out.addImage(image);
    image.destroy();
    const res = out.newDictionary();
    const xo = out.newDictionary();
    xo.put("Im0", ref);
    res.put("XObject", xo);
    const pageObj = out.addPage([0, 0, w, h], 0, res, `q ${num(w)} 0 0 ${num(h)} 0 0 cm /Im0 Do Q`);
    out.insertPage(-1, pageObj);
    step(`ページを画像化中（${i + 1}/${n}）`);
  }
  return out;
}

function stripExtras(doc: M.PDFDocument) {
  const root = doc.getTrailer().get("Root");
  const names = root.get("Names");
  if (names.isDictionary()) {
    names.delete("EmbeddedFiles");
    names.delete("JavaScript");
  }
  const oa = root.get("OpenAction");
  if (oa.isDictionary()) {
    const s = oa.get("S");
    if (s.isName() && ["JavaScript", "Launch", "SubmitForm", "ImportData"].includes(s.asName())) root.delete("OpenAction");
  }
  root.delete("AA");
  root.delete("PieceInfo");
  const risky = new Set(["FileAttachment", "Sound", "Movie", "RichMedia", "Screen", "3D"]);
  for (let i = 0; i < doc.countPages(); i++) {
    const pg = doc.findPage(i);
    pg.delete("Thumb");
    pg.delete("PieceInfo");
    pg.delete("AA");
    const annots = pg.get("Annots");
    if (annots.isArray()) {
      const keep = doc.newArray();
      annots.forEach((a) => {
        const st = a.get("Subtype");
        const sub = st.isName() ? st.asName() : "";
        if (risky.has(sub)) return;
        const act = a.get("A");
        if (act.isDictionary()) {
          const s = act.get("S");
          if (s.isName() && ["JavaScript", "Launch"].includes(s.asName())) return;
        }
        keep.push(a);
      });
      pg.put("Annots", keep);
    }
  }
}

function stripPageMetadata(doc: M.PDFDocument) {
  for (let i = 0; i < doc.countPages(); i++) {
    const pg = doc.findPage(i);
    pg.delete("Metadata");
  }
}

function applyMetadata(doc: M.PDFDocument, opts: ExportOptions) {
  const trailer = doc.getTrailer();
  const root = trailer.get("Root");
  if (opts.stripMetadata) {
    trailer.delete("Info");
    root.delete("Metadata");
    root.delete("StructTreeRoot");
    root.delete("MarkInfo");
  }
  if (opts.stripOutlines) root.delete("Outlines");
  const p = opts.props;
  if (p) {
    if (p.title) doc.setMetaData("info:Title", p.title);
    if (p.author) doc.setMetaData("info:Author", p.author);
    if (p.subject) doc.setMetaData("info:Subject", p.subject);
    if (p.keywords) doc.setMetaData("info:Keywords", p.keywords);
  }
}

export function permissionValue(p: Permissions): number {
  let bits = 0;
  if (p.print) bits |= 4 | 2048;
  if (p.edit) bits |= 8;
  if (p.copy) bits |= 16;
  if (p.annotate) bits |= 32;
  if (p.form) bits |= 256;
  if (p.accessibility) bits |= 512;
  if (p.assemble) bits |= 1024;
  return (0xfffff0c0 | bits) | 0;
}

export function saveOptions(opts: ExportOptions): string {
  const parts = ["garbage=4", "compress=yes"];
  const e = opts.encryption;
  if (e && (e.userPassword || e.ownerPassword)) {
    parts.push(`encrypt=${e.method}`);
    if (e.userPassword) parts.push(`user-password=${e.userPassword}`);
    parts.push(`owner-password=${e.ownerPassword || e.userPassword}`);
    const shared = !e.ownerPassword || e.ownerPassword === e.userPassword;
    if (!shared) parts.push(`permissions=${permissionValue(e.permissions)}`);
  } else {
    parts.push("encrypt=no");
  }
  return parts.join(",");
}

// ---- 書き出し後の漏えい検証 ----

const META_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer"];

function verify(
  mupdf: Mupdf,
  bytes: Uint8Array,
  maps: PageMap[],
  opts: ExportOptions,
  open: (docId: string) => M.PDFDocument,
  step: (label: string) => void,
): VerifyReport {
  const out = new mupdf.PDFDocument(bytes);
  if (out.needsPassword()) {
    const e = opts.encryption;
    out.authenticatePassword(e?.userPassword || e?.ownerPassword || "");
  }
  let leakedChars = 0;
  const leakedSamples: string[] = [];
  let diff = 0;
  let compared = 0;
  const diffPages: number[] = [];
  const pageTexts: string[] = [];
  const refs = new Map<string, M.PDFDocument>();
  const n = Math.min(out.countPages(), maps.length);

  for (let i = 0; i < n; i++) {
    const map = maps[i];
    const page = out.loadPage(i);
    const b = page.getBounds();

    // (1) マスク内に文字が残っていないか
    const st = page.toStructuredText("preserve-whitespace");
    let text = "";
    st.walk({
      onChar(c, _o, _f, _s, q) {
        text += c;
        if (!map.masks.length) return;
        const x0 = Math.min(q[0], q[2], q[4], q[6]) - b[0];
        const x1 = Math.max(q[0], q[2], q[4], q[6]) - b[0];
        const y0 = Math.min(q[1], q[3], q[5], q[7]) - b[1];
        const y1 = Math.max(q[1], q[3], q[5], q[7]) - b[1];
        const cr = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        const area = Math.max(0.01, cr.w * cr.h);
        if (c.trim() && map.masks.some((m) => maskOverlapArea(m, cr) > area * 0.4)) {
          leakedChars++;
          if (leakedSamples.length < 8) leakedSamples.push(`${i + 1}ページ「${c}」`);
        }
      },
      endLine() {
        text += "\n";
      },
    });
    st.destroy();
    pageTexts.push(normalize(text));

    // (2) マスクの外の見た目が変わっていないか（1px/pt で比較）
    let ref = refs.get(map.docId);
    if (!ref) {
      ref = open(map.docId);
      if (opts.flatten) ref.bake(true, true);
      refs.set(map.docId, ref);
    }
    const refObj = ref.findPage(map.srcPage);
    const cur = refObj.getInheritable("Rotate");
    const baseRot = cur.isNumber() ? cur.asNumber() : 0;
    if (map.rot) refObj.put("Rotate", (baseRot + map.rot) % 360);
    const refPage = ref.loadPage(map.srcPage);
    const k = 1;
    const a = page.toPixmap(mupdf.Matrix.scale(k, k), mupdf.ColorSpace.DeviceRGB, false, true);
    const c = refPage.toPixmap(mupdf.Matrix.scale(k, k), mupdf.ColorSpace.DeviceRGB, false, true);
    if (map.rot) refObj.put("Rotate", baseRot);
    const r = comparePixmaps(a, c, map.masks.map((m) => inflate(maskBounds(m), 2.5)), k, opts.rasterize ? 72 : 40);
    a.destroy();
    c.destroy();
    refPage.destroy();
    page.destroy();
    diff += r.diff;
    compared += r.compared;
    if (r.compared > 0 && r.diff / r.compared > 0.0005) diffPages.push(i + 1);
    step(`検証中（${i + 1}/${n}ページ）`);
  }
  for (const r of refs.values()) r.destroy();

  // (3) 文書情報・XMP
  const metadata: Record<string, string> = {};
  for (const key of META_KEYS) {
    const v = out.getMetaData(`info:${key}`);
    if (v) metadata[key] = v;
  }
  const hasXmp = !out.getTrailer().get("Root").get("Metadata").isNull();
  const encrypted = out.getMetaData("encryption") ?? "";

  // (4) 隠した値がマスクの外に残っていないか（ページ本文・文書情報・しおり）
  const extraText = normalize(Object.values(metadata).join("\n") + "\n" + outlineTitles(out).join("\n"));
  out.destroy();
  const residues: Residue[] = [];
  const seen = new Set<string>();
  const textKept = opts.keepText && !opts.rasterize;
  // 文字を残す設定では、マスクの下の値そのものが見つかるので調べない
  for (const map of textKept ? [] : maps) {
    for (const t of map.texts) {
      const v = normalize(t).trim();
      if (!isMeaningfulValue(v) || seen.has(v)) continue;
      seen.add(v);
      let count = 0;
      const pages: number[] = [];
      pageTexts.forEach((pt, idx) => {
        const hits = countStandalone(pt, v).length;
        if (hits) {
          count += hits;
          pages.push(idx + 1);
        }
      });
      const extra = countStandalone(extraText, v).length;
      if (extra) {
        count += extra;
        pages.push(0);
      }
      if (count) residues.push({ text: v, count, pages });
    }
  }

  const pixelDiffPercent = compared ? (diff / compared) * 100 : 0;
  const allowedMeta = new Set(
    opts.props ? Object.values(opts.props).filter(Boolean) : [],
  );
  const metaClean =
    !opts.stripMetadata ||
    (!hasXmp && Object.values(metadata).every((v) => allowedMeta.has(v) || /mupdf/i.test(v)));
  const passed = (textKept || leakedChars === 0) && pixelDiffPercent < (opts.rasterize ? 1.5 : 0.5) && metaClean;
  return {
    leakedChars,
    leakedSamples,
    pixelDiffPercent,
    diffPages,
    metadata,
    hasXmp,
    metadataClean: metaClean,
    textKept,
    encrypted,
    residues,
    passed,
  };
}

function outlineTitles(doc: M.PDFDocument): string[] {
  const titles: string[] = [];
  const walk = (items: { title?: string; down?: unknown[] }[] | null | undefined) => {
    for (const it of items ?? []) {
      if (it.title) titles.push(it.title);
      walk(it.down as typeof items);
    }
  };
  try {
    walk(doc.loadOutline() as never);
  } catch {
    // しおりが壊れていても検証は続ける
  }
  return titles;
}

function comparePixmaps(a: M.Pixmap, b: M.Pixmap, exclude: Rect[], k: number, threshold: number) {
  const w = Math.min(a.getWidth(), b.getWidth());
  const h = Math.min(a.getHeight(), b.getHeight());
  const da = copyPixels(a);
  const db = copyPixels(b);
  const wa = a.getWidth() * 3;
  const wb = b.getWidth() * 3;
  let diff = 0;
  let compared = 0;
  const mask = new Uint8Array(w * h);
  for (const r of exclude) {
    const x0 = Math.max(0, Math.floor(r.x * k));
    const y0 = Math.max(0, Math.floor(r.y * k));
    const x1 = Math.min(w, Math.ceil((r.x + r.w) * k));
    const y1 = Math.min(h, Math.ceil((r.y + r.h) * k));
    for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + Math.max(x0, x1));
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) continue;
      const p = y * wa + x * 3;
      const q = y * wb + x * 3;
      compared++;
      if (
        Math.abs(da[p] - db[q]) > threshold ||
        Math.abs(da[p + 1] - db[q + 1]) > threshold ||
        Math.abs(da[p + 2] - db[q + 2]) > threshold
      )
        diff++;
    }
  }
  return { diff, compared };
}

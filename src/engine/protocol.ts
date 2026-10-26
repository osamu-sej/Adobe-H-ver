import type { DocMeta, MaskStyle, PageInfo, Rect, Rot } from "../model/types";

export interface OpenResult {
  needsPassword: boolean;
  badPassword?: boolean;
  pages?: PageInfo[];
  meta?: DocMeta;
  hasAnnots?: boolean;
}

export interface RenderResult {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  scale: number;
}

/** 文字ごとの状態（TextResult.flags のビット） */
export const CharFlag = {
  /** 見えない文字（透明の文字、上から画像で覆われた文字）。スキャンに重ねた文字層など */
  Hidden: 1,
  /** 文字化け（PDFに文字の対応表がなく、何の文字か分からない） */
  Garbled: 2,
} as const;

export interface TextResult {
  chars: string[];
  boxes: Float32Array;
  lines: Int32Array;
  sizes: Float32Array;
  /** ページ上の画像の数（文字がなく画像だけのページは文字認識の対象にする） */
  images?: number;
  /** 文字ごとの状態（CharFlag のビット：見えない文字・文字化け） */
  flags?: Uint8Array;
  /** 文字認識で読む画像（貼り付けた表・スクリーンショットなど）の数 */
  figures?: number;
  /** ページのほとんどを覆う画像がある（スキャンの上に文字層を重ねたPDFなど） */
  cover?: boolean;
  /** 文字の形をした図形（文字を図形にしたもの）の数 */
  glyphPaths?: number;
}

/** 文字認識用のページ画像（グレースケールPNG） */
export interface OcrImageResult {
  png: Uint8Array;
  /** 同じ画像の画素（1画素1バイト）。文字の位置をインクに合わせるのに使う */
  gray: Uint8Array;
  width: number;
  height: number;
  /** 画像の画素 → 元ページ空間（pt）の変換行列 [a, b, c, d, e, f] */
  toPage: [number, number, number, number, number, number];
  /** 整える前のカラーの画像（JPEG）。高精度の文字認識（クラウド）に送るときだけ作る */
  jpeg?: Uint8Array;
}

export interface ExportMask extends Rect {
  id: string;
  page: number;
  style: MaskStyle;
  strength: number;
  /** 塗りつぶしの色（#rrggbb）と不透明度 */
  color: string;
  opacity: number;
  label: string | null;
  text?: string;
}

export interface ExportDoc {
  docId: string;
  /** 書き出すファイル名（拡張子込み） */
  name: string;
  order: number[];
  rot: Record<number, Rot>;
  masks: ExportMask[];
}

export interface Permissions {
  print: boolean;
  copy: boolean;
  edit: boolean;
  annotate: boolean;
  form: boolean;
  assemble: boolean;
  accessibility: boolean;
}

export interface EncryptionOptions {
  method: "aes-256" | "aes-128" | "rc4-128";
  userPassword: string;
  ownerPassword: string;
  permissions: Permissions;
}

export interface ExportOptions {
  mode: "separate" | "merge";
  mergedName: string;
  /** 全ページを画像化する（最も安全・文字は検索できなくなる） */
  rasterize: boolean;
  /**
   * 見た目だけ重ねる：モザイク等を上に重ねるだけで、下にある元の文字・画像は消さない。
   * コピーや検索で元の内容が読めてしまうので、見た目を和らげれば十分なとき用
   */
  keepText: boolean;
  rasterDpi: number;
  /** 注釈・フォームを平坦化してから墨消しする */
  flatten: boolean;
  /** 文書情報・XMP・構造タグを削除 */
  stripMetadata: boolean;
  /** 添付ファイル・JavaScript・サムネイル・アプリ固有データを削除 */
  stripExtras: boolean;
  /** しおりを削除 */
  stripOutlines: boolean;
  /** 書き出し後に設定する文書プロパティ（空欄は書き込まない） */
  props: { title: string; author: string; subject: string; keywords: string } | null;
  encryption: EncryptionOptions | null;
}

export interface ExportJob {
  docs: ExportDoc[];
  options: ExportOptions;
}

export interface Residue {
  text: string;
  count: number;
  pages: number[];
}

export interface VerifyReport {
  /** マスク内に残った文字数（0であるべき） */
  leakedChars: number;
  leakedSamples: string[];
  /** マスク外で見た目が変わった画素の割合（%） */
  pixelDiffPercent: number;
  /** 見た目の比較で差が出たページ（1始まり） */
  diffPages: number[];
  /** 残っている文書情報 */
  metadata: Record<string, string>;
  hasXmp: boolean;
  /** 「文書情報を削除」を選んだのに残っている情報がないか */
  metadataClean: boolean;
  encrypted: string;
  /** 隠した値と同じ文字列がマスクの外に残っている箇所 */
  residues: Residue[];
  /** 「見た目だけ重ねる」で書き出したので、マスクの下の文字は意図して残している */
  textKept: boolean;
  passed: boolean;
}

export interface ExportFile {
  name: string;
  bytes: Uint8Array;
  pages: number;
  masks: number;
  report: VerifyReport;
}

export interface ExportResult {
  files: ExportFile[];
}

export type WorkerRequest =
  | { type: "open"; id: number; docId: string; bytes: Uint8Array; password?: string }
  | { type: "render"; id: number; docId: string; page: number; scale: number; priority: number }
  | { type: "text"; id: number; docId: string; page: number; priority: number }
  | {
      type: "ocrImage";
      id: number;
      docId: string;
      page: number;
      rotate: number;
      dpi: number;
      priority: number;
      jpeg?: boolean;
      /** 白く消してから読む範囲（PDFの文字がある所。元ページ空間の [x0, y0, x1, y1] × n） */
      blank?: number[];
    }
  | { type: "close"; id: number; docId: string }
  | { type: "export"; id: number; job: ExportJob }
  | { type: "cancel"; ids: number[] };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "fatal"; error: string }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string; cancelled?: boolean }
  | { type: "progress"; id: number; done: number; total: number; label: string };

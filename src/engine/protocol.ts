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

export interface TextResult {
  chars: string[];
  boxes: Float32Array;
  lines: Int32Array;
  sizes: Float32Array;
}

export interface ExportMask extends Rect {
  id: string;
  page: number;
  style: MaskStyle;
  strength: number;
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
  | { type: "close"; id: number; docId: string }
  | { type: "export"; id: number; job: ExportJob }
  | { type: "cancel"; ids: number[] };

export type WorkerResponse =
  | { type: "ready" }
  | { type: "fatal"; error: string }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string; cancelled?: boolean }
  | { type: "progress"; id: number; done: number; total: number; label: string };

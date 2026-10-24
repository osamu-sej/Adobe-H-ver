export type Rot = 0 | 90 | 180 | 270;

/** マスクの見た目。モザイク・ぼかしは元の見た目を崩す、塗りつぶしは好きな色・透明度で塗る */
export type MaskStyle = "mosaic" | "blur" | "fill";

export const STYLE_LABEL: Record<MaskStyle, string> = {
  mosaic: "モザイク",
  blur: "ぼかし",
  fill: "塗りつぶし",
};

export const STYLE_ORDER: MaskStyle[] = ["mosaic", "blur", "fill"];

/** 塗りつぶしの色の候補 */
export const FILL_COLORS: { name: string; value: string }[] = [
  { name: "黒", value: "#000000" },
  { name: "チャコール", value: "#374151" },
  { name: "グレー", value: "#6b7280" },
  { name: "ライトグレー", value: "#d1d5db" },
  { name: "白", value: "#ffffff" },
  { name: "ネイビー", value: "#1e3a5f" },
  { name: "ブルー", value: "#3b6fd8" },
  { name: "グリーン", value: "#2f7d4f" },
  { name: "ベージュ", value: "#e8dcc4" },
  { name: "朱", value: "#e8492a" },
  { name: "イエロー", value: "#f5c518" },
];

/** モザイク・ぼかしの程度。弱＝多少は推測できる、中＝うっすら判別できる、強＝ほとんど読めない */
export type Level = "weak" | "medium" | "strong";

export const LEVEL_ORDER: Level[] = ["weak", "medium", "strong"];

export const LEVEL_LABEL: Record<Level, string> = { weak: "弱", medium: "中", strong: "強" };

export const LEVEL_HINT: Record<Level, string> = {
  weak: "多少は推測できる程度",
  medium: "うっすら判別できる程度",
  strong: "ほとんど読めない",
};

/** 吸着モード。数字＝数字だけに吸着、文字＝文字全般、自由＝ドラッグ範囲そのまま */
export type SnapMode = "digits" | "text" | "free";

export const SNAP_LABEL: Record<SnapMode, string> = {
  digits: "数字に吸着",
  text: "文字（数字以外）に吸着",
  free: "自由範囲",
};

/** 座標はすべて「元ページ空間」：PDF本来の向き（/Rotate適用済み）、左上原点、単位pt */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Mask extends Rect {
  id: string;
  docId: string;
  /** 元PDFでのページ番号（0始まり）。並べ替え・削除しても変わらない */
  page: number;
  style: MaskStyle;
  /** モザイク・ぼかしの程度（strength が null のときに使う） */
  level: Level;
  /** モザイクのブロック／ぼかしの強さ（pt）を細かく指定したとき。null は程度から自動 */
  strength: number | null;
  /** 塗りつぶしの色（#rrggbb） */
  color: string;
  /** 塗りつぶしの不透明度（0.1〜1）。1未満は下が透けて見える */
  opacity: number;
  /** 墨消しの上に重ねる文言（「非開示」など） */
  label: string | null;
  /** マスク作成時に覆った文字列（正規化済み）。同じ値の検出と書き出し後の検証に使う。保存はしない */
  text?: string;
}

export interface PageInfo {
  /** 元ページ空間の幅・高さ（pt） */
  w: number;
  h: number;
  /** MuPDF座標での原点オフセット */
  x0: number;
  y0: number;
}

export interface DocMeta {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  encryption: string;
}

/** 開いた文書の不変情報（Undo対象外） */
export interface DocEntry {
  id: string;
  name: string;
  size: number;
  hash: string;
  bytes: Uint8Array;
  password?: string;
  pages: PageInfo[];
  meta: DocMeta;
  hasAnnots: boolean;
}

/** 文書ごとのページ構成（Undo対象） */
export interface DocLayout {
  /** 表示順の元ページ番号。削除されたページは含まない */
  order: number[];
  /** ユーザーが加えた回転（元ページ番号→角度） */
  rot: Record<number, Rot>;
}

export type Tool = "mask" | "select" | "hand";

/** 文字層：ページ内の文字の外接矩形（元ページ空間） */
export interface PageText {
  chars: string[];
  /** [x0,y0,x1,y1] × n */
  boxes: Float32Array;
  /** 各文字の行番号（ページ内で通し） */
  lines: Int32Array;
  /** 各文字のフォントサイズ */
  sizes: Float32Array;
}

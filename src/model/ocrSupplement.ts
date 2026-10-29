import { mergeOcr } from "./pageText";
import { ocrToPageText, type GrayImage, type Matrix6, type OcrLine, type OcrWord } from "./ocrText";
import type { PageText } from "./types";

type Candidate = OcrWord & { unitContext?: boolean };
const NUMERIC = /^[\d.,:+%/()\-]+$/;
// 数字に続く実際の単位・方角。一般的な英単語は対象にしない。
const UNIT = /^[\d.,:+%/()\-]+(?:km(?:\/h)?|hpa|nm|kts|m\/s|[EN]|円|日|月|年|時|分)$/i;

/** 数字が複数ある語、または単位の付いた語の数値部分を候補にする。 */
export function supplementLines(lines: OcrLine[]): OcrLine[] {
  return lines.map((line) => ({
    words: line.words.flatMap((word): Candidate[] => {
      const text = word.symbols.map((s) => s.text).join("").normalize("NFKC").trim();
      if (word.confidence < 30) return [];
      let candidates: Candidate[] = [];
      if (NUMERIC.test(text) && (text.match(/\d/g)?.length ?? 0) >= 2) candidates = [word];
      else if (word.confidence >= 65 && UNIT.test(text)) {
        // 例: 「20km/h」「127.0E」は数字の部分だけを取り出し、単位は隠さない。
        let run: OcrWord["symbols"] = [];
        const flush = () => {
          const digits = run.map((s) => s.text).join("").normalize("NFKC").match(/\d/g)?.length ?? 0;
          if (digits >= 2) candidates.push({
            ...word,
            unitContext: true,
            symbols: run,
            bbox: {
              x0: Math.min(...run.map((s) => s.bbox.x0)), y0: Math.min(...run.map((s) => s.bbox.y0)),
              x1: Math.max(...run.map((s) => s.bbox.x1)), y1: Math.max(...run.map((s) => s.bbox.y1)),
            },
          });
          run = [];
        };
        for (const symbol of word.symbols) {
          if (NUMERIC.test(symbol.text.normalize("NFKC"))) run.push(symbol);
          else flush();
        }
        flush();
      }
      return candidates.map((candidate) => ({
        ...candidate,
        symbols: candidate.symbols.filter((symbol) => {
          const c = symbol.text.normalize("NFKC");
          const w = symbol.bbox.x1 - symbol.bbox.x0;
          const h = symbol.bbox.y1 - symbol.bbox.y0;
          return !/^[023456789]$/.test(c) || w >= h * 0.18;
        }),
      })).filter((candidate) => candidate.symbols.length > 0);
    }),
  })).filter((line) => line.words.length > 0);
}

/** 暗い地の白抜き文字は、通常の黒いインクへの位置合わせを使わない。 */
function darkBackground(word: OcrWord, img: GrayImage): boolean {
  const { x0, x1, y0, y1 } = word.bbox;
  const hist = new Uint32Array(256);
  let count = 0;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(img.height, Math.ceil(y1)); y += 2)
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(img.width, Math.ceil(x1)); x += 2) {
      hist[img.data[y * img.width + x]]++;
      count++;
    }
  if (!count) return false;
  let deep = 0;
  for (let i = 0; i < 100; i++) deep += hist[i];
  let low = 0;
  for (let i = 0; i < 140; i++) low += hist[i];
  return low > count / 2 && deep >= count * 0.15;
}

/** 先の認識を変えず、その文字と重ならない追加候補だけを文字層に足す。 */
export function supplementDigits(base: PageText, lines: OcrLine[], toPage: Matrix6, img: GrayImage): PageText {
  const candidates = supplementLines(lines).map((line) => ({
    words: line.words.filter((word) => {
      const text = word.symbols.map((s) => s.text).join("").normalize("NFKC");
      // 無地の図・写真を数字と誤認するのを抑える。桁ごとにインクが対応しない
      // 数字だけの語は、暗い地の白抜き文字の場合を除いて追加しない。
      return word.inkMatched !== false || (word as Candidate).unitContext === true || /[.,():]/.test(text) || darkBackground(word, img);
    }),
  })).filter((line) => line.words.length > 0);
  if (!candidates.length) return base;
  const split = (dark: boolean) => candidates.map((l) => ({ words: l.words.filter((w) => darkBackground(w, img) === dark) }));
  const layers = [ocrToPageText(split(false), toPage, img), ocrToPageText(split(true), toPage)];
  // 元画像には消していない罫線がある。数字の枠として細長すぎる文字は追加しない。
  // 横向きページでは元ページの x/y が画像と入れ替わる。
  const turned = Math.abs(toPage[1]) > Math.abs(toPage[0]);
  let merged = base;
  for (const [layer, raw] of layers.entries()) {
    const keep: number[] = [];
    for (let i = 0; i < raw.chars.length; i++) {
      const c = raw.chars[i].normalize("NFKC");
      const w = raw.boxes[i * 4 + 2] - raw.boxes[i * 4];
      const h = raw.boxes[i * 4 + 3] - raw.boxes[i * 4 + 1];
      const height = turned ? w : h;
      const aspect = (turned ? h : w) / Math.max(0.001, height);
      if (/^\d$/.test(c) && (height < 3 || aspect > (layer === 1 ? 1.1 : 1.6) || aspect < (c === "1" ? 0.08 : 0.35))) continue;
      keep.push(i);
    }
    const extra: PageText = {
      chars: keep.map((i) => raw.chars[i]),
      boxes: Float32Array.from(keep.flatMap((i) => Array.from(raw.boxes.slice(i * 4, i * 4 + 4)))),
      lines: Int32Array.from(keep.map((i) => raw.lines[i])),
      sizes: Float32Array.from(keep.map((i) => raw.sizes[i])),
    };
    // OCR で挿入された空白は実際の文字ではない。空白の矩形を重複判定に使うと、
    // 読み落とされた数字をその位置に追加できない。
    const blockers: number[] = [];
    for (let i = 0; i < merged.chars.length; i++)
      if (merged.chars[i].trim()) blockers.push(...Array.from(merged.boxes.slice(i * 4, i * 4 + 4)));
    merged = mergeOcr(merged, blockers, extra);
  }
  return merged;
}

import type * as M from "mupdf";
import type { TextResult } from "./protocol";

/** ページの文字と外接矩形を取り出す（座標はページ原点基準のpt） */
export function extractPageText(page: M.Page): TextResult {
  const b = page.getBounds();
  const st = page.toStructuredText("preserve-whitespace,preserve-images");
  let images = 0;
  const chars: string[] = [];
  const boxes: number[] = [];
  const lines: number[] = [];
  const sizes: number[] = [];
  let line = -1;
  st.walk({
    onImageBlock() {
      images++;
    },
    beginLine() {
      line++;
    },
    onChar(c, _origin, _font, size, q) {
      chars.push(c);
      boxes.push(
        Math.min(q[0], q[2], q[4], q[6]) - b[0],
        Math.min(q[1], q[3], q[5], q[7]) - b[1],
        Math.max(q[0], q[2], q[4], q[6]) - b[0],
        Math.max(q[1], q[3], q[5], q[7]) - b[1],
      );
      lines.push(line);
      sizes.push(size);
    },
  });
  st.destroy();
  return {
    chars,
    boxes: new Float32Array(boxes),
    lines: new Int32Array(lines),
    sizes: new Float32Array(sizes),
    images,
  };
}

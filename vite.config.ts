import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);

// 本番ビルドでは外部への通信を一切許可しないCSPを埋め込む。
// 機密PDFを扱うため「ファイルが端末の外に出ない」ことをブラウザ側でも保証する。
function offlineCsp(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "img-src 'self' blob: data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "offline-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

// 文字認識（OCR）の部品。外部のCDNから読み込まないよう、ocr/ にそのまま置いて配信する
const OCR_FILES: Record<string, string> = {
  "worker.min.js": "tesseract.js/dist/worker.min.js",
  "tesseract-core-lstm.wasm.js": "tesseract.js-core/tesseract-core-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm.js": "tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm.js": "tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "jpn.traineddata.gz": "@tesseract.js-data/jpn/4.0.0_best_int/jpn.traineddata.gz",
};

function ocrAssets(): Plugin {
  const file = (name: string) => require.resolve(OCR_FILES[name]);
  return {
    name: "ocr-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/ocr\/([^/?#]+)/.exec(req.url ?? "");
        if (!m || !OCR_FILES[m[1]]) return next();
        res.setHeader("Content-Type", m[1].endsWith(".js") ? "text/javascript" : "application/octet-stream");
        res.end(readFileSync(file(m[1])));
      });
    },
    generateBundle() {
      for (const name of Object.keys(OCR_FILES)) {
        this.emitFile({ type: "asset", fileName: `ocr/${name}`, source: readFileSync(file(name)) });
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), offlineCsp(), ocrAssets()],
  optimizeDeps: { exclude: ["mupdf"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  test: { environment: "node" },
} as never);

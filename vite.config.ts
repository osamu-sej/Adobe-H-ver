import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);

// ---- ビルド情報（バージョン・ビルド日時（日本時間）・元になったコミット） ----
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

function gitCommit(): string {
  // Render・GitHub Actions ではビルドしたコミットが環境変数に入る
  const env = process.env.RENDER_GIT_COMMIT || process.env.GITHUB_SHA;
  if (env) return env.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const BUILD = {
  version: pkg.version,
  date: new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date()),
  commit: gitCommit(),
};

/** 使い方ガイド（public/ からそのまま配信）にもバージョンを入れ、version.json でも確かめられるようにする */
function buildInfo(): Plugin {
  let outDir = "dist";
  return {
    name: "build-info",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify(BUILD, null, 2) + "\n" });
    },
    closeBundle() {
      const manual = resolve(outDir, "manual/index.html");
      if (!existsSync(manual)) return;
      const label = `カクス v${BUILD.version}（${BUILD.date} 更新${BUILD.commit ? ` · ${BUILD.commit}` : ""}）`;
      writeFileSync(manual, readFileSync(manual, "utf8").replace("<!--BUILD_INFO-->", `<br /><span class="build">${label}</span>`));
    },
  };
}

// 本番ビルドでは外部への通信を許可しないCSPを埋め込む。
// 機密PDFを扱うため「ファイルが端末の外に出ない」ことをブラウザ側でも保証する。
// 例外は、使う人が文書ごとに選んだときに使う高精度の文字認識（Google Cloud Vision）の送り先だけ。
function offlineCsp(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "img-src 'self' blob: data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "connect-src 'self' blob: data: https://vision.googleapis.com",
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
  plugins: [react(), offlineCsp(), ocrAssets(), buildInfo()],
  define: { __BUILD__: JSON.stringify(BUILD) },
  optimizeDeps: { exclude: ["mupdf"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  test: { environment: "node" },
} as never);

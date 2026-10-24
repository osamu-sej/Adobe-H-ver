import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

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

export default defineConfig({
  base: "./",
  plugins: [react(), offlineCsp()],
  optimizeDeps: { exclude: ["mupdf"] },
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  test: { environment: "node" },
} as never);

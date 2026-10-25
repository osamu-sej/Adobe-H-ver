declare const __BUILD__: { version: string; date: string; commit: string };

/** ビルド情報（ビルド時に vite.config.ts で埋め込む）。date は日本時間、commit は元になったコミットの短縮形 */
export const BUILD = __BUILD__;

export const VERSION_LABEL = `v${BUILD.version}`;

/** 「2026-10-25 16:11 · fb75984」のような表記 */
export const BUILD_LABEL = `${BUILD.date}${BUILD.commit ? ` · ${BUILD.commit}` : ""}`;

import { useEffect, useRef, useState } from "react";
import { cloudRemaining, currentKey, MONTHLY_CAP, saveCloudKey } from "../model/cloudOcr";
import { enableCloudOcr, scannedPageCount } from "../model/ocr";
import { toast, useStore } from "../model/store";
import { IconCloud, IconX } from "./icons";

/**
 * 高精度の文字認識（クラウド）の確認画面。文書ごとに、送るものと送り先を確かめてからオンにする。
 * APIキーはこのブラウザにだけ保存する
 */
export function CloudOcrDialog() {
  const docId = useStore((s) => s.cloudOcrFor);
  const name = useStore((s) => (s.cloudOcrFor ? s.docs[s.cloudOcrFor]?.name : undefined));
  useStore((s) => s.ocr);
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!docId) return;
    setKey(currentKey());
    setShow(false);
    setTimeout(() => ref.current?.focus(), 0);
  }, [docId]);
  useEffect(() => {
    if (!docId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useStore.setState({ cloudOcrFor: null });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [docId]);
  if (!docId) return null;
  const close = () => useStore.setState({ cloudOcrFor: null });
  const pages = scannedPageCount(docId);
  const remaining = cloudRemaining();
  const sending = Math.min(pages, remaining);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <form
        className="modal cloud-ocr"
        role="dialog"
        aria-modal="true"
        aria-label="高精度の文字認識（クラウド）"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key.trim() || !sending) return;
          saveCloudKey(key.trim());
          enableCloudOcr(docId);
          close();
          toast({ message: `スキャンしたページ ${sending}ページを、高精度の文字認識（クラウド）で読み直しています` });
        }}
      >
        <div className="modal-head">
          <h2>
            <IconCloud size={20} /> 高精度の文字認識（クラウド）
          </h2>
          <button type="button" className="icon-btn" onClick={close} aria-label="閉じる">
            <IconX />
          </button>
        </div>
        <div className="modal-body">
          <p className="cloud-lead">
            「{name}」のスキャンしたページ <b>{pages}ページ</b> の画像を <b>Google Cloud Vision</b>{" "}
            に送って読み取ります。端末内の文字認識より、色付きの表・小さな文字・手書きも正確に読めます。
          </p>
          <ul className="cloud-points">
            <li>
              送るのは<b>スキャンしたページの画像だけ</b>です。文字情報のあるページ、PDFファイルそのもの、ファイル名は送りません。
            </li>
            <li>
              Google は送られた画像を学習には使いません（Google Cloud
              の規約）。社外秘の資料は、外部のサービスに送ってよいか社内のルールを確かめてください。
            </li>
            <li>この文書だけが対象です。ほかの文書は、改めて選ぶまで端末内で読みます。</li>
          </ul>
          <label className="cloud-key">
            <span>Google Cloud Vision の APIキー（このブラウザにだけ保存します）</span>
            <span className="cloud-key-row">
              <input
                ref={ref}
                className="input"
                type={show ? "text" : "password"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="AIza…"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="btn ghost sm" onClick={() => setShow(!show)}>
                {show ? "隠す" : "表示"}
              </button>
            </span>
            <a href="manual/#cloud" target="_blank" rel="noopener">
              APIキーの作り方
            </a>
          </label>
          <p className="muted small">
            今月このブラウザから送った枚数：{MONTHLY_CAP - remaining} / {MONTHLY_CAP}枚。無料枠（月1,000枚）を超えないよう、{MONTHLY_CAP}
            枚で止めて端末内の文字認識に戻します。
          </p>
          {pages > remaining && (
            <div className="field-error">
              今月の残り{remaining}枚を超える {pages - remaining}ページは、端末内の文字認識で読みます。
            </div>
          )}
        </div>
        <div className="modal-foot">
          <span />
          <button type="button" className="btn ghost" onClick={close}>
            送らない
          </button>
          <button className="btn primary" type="submit" disabled={!key.trim() || !sending}>
            送って読み取る（{sending}ページ）
          </button>
        </div>
      </form>
    </div>
  );
}

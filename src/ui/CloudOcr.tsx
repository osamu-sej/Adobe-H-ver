import { useEffect } from "react";
import { cloudRemaining, MONTHLY_CAP } from "../model/cloudOcr";
import { enableCloudOcr, ocrTargetCount } from "../model/ocr";
import { toast, useStore } from "../model/store";
import { IconCloud, IconX } from "./icons";

/**
 * 高精度の文字認識（クラウド）の確認画面。設定でAPIキーを入れた人だけが開ける。
 * 文書ごとに、送るものと送り先を確かめてからオンにする
 */
export function CloudOcrDialog() {
  const docId = useStore((s) => s.cloudOcrFor);
  const name = useStore((s) => (s.cloudOcrFor ? s.docs[s.cloudOcrFor]?.name : undefined));
  const keySet = useStore((s) => s.cloudKeySet);
  useStore((s) => s.ocr);
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
  const pages = ocrTargetCount(docId);
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
          if (!keySet || !sending) return;
          enableCloudOcr(docId);
          close();
          toast({ message: `${sending}ページを、高精度の文字認識（クラウド）で読み直しています` });
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
            「{name}」の文字認識するページ <b>{pages}ページ</b> の画像を <b>Google Cloud Vision</b>{" "}
            に送って読み取ります。端末内の文字認識より、色付きの表・小さな文字・手書きも正確に読めます。
          </p>
          <ul className="cloud-points">
            <li>
              送るのは<b>文字認識するページの画像だけ</b>
              です。PDFの文字情報がある部分は白く消してから送ります。PDFファイルそのもの・ファイル名は送りません。
            </li>
            <li>
              Google は送られた画像を学習には使いません（Google Cloud
              の規約）。社外秘の資料は、外部のサービスに送ってよいか社内のルールを確かめてください。
            </li>
            <li>この文書だけが対象です。ほかの文書は、改めて選ぶまで端末内で読みます。</li>
          </ul>
          <p className="muted small">
            今月このブラウザから送った枚数：{MONTHLY_CAP - remaining} / {MONTHLY_CAP}枚。無料枠（月1,000枚）を超えないよう、{MONTHLY_CAP}
            枚で止めて端末内の文字認識に戻します。APIキーは「設定」で変えられます。
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
          <button className="btn primary" type="submit" disabled={!keySet || !sending}>
            送って読み取る（{sending}ページ）
          </button>
        </div>
      </form>
    </div>
  );
}

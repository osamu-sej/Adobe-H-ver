import { useEffect, useState } from "react";
import { cloudRemaining, MONTHLY_CAP, saveCloudKey } from "../model/cloudOcr";
import { disableCloudOcr } from "../model/ocr";
import { toast, useStore } from "../model/store";
import { IconSettings, IconX } from "./icons";

/**
 * 設定。いまは高精度の文字認識（クラウド）のAPIキーだけ。
 * ふだんの使い方ではAPIは要らないので、キーを入れた人にだけクラウドの項目を画面に出す
 */
export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const keySet = useStore((s) => s.cloudKeySet);
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!open) return;
    setKey("");
    setShow(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useStore.setState({ settingsOpen: false });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  const close = () => useStore.setState({ settingsOpen: false });
  const used = MONTHLY_CAP - cloudRemaining();
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-label="設定">
        <div className="modal-head">
          <h2>
            <IconSettings size={20} /> 設定
          </h2>
          <button className="icon-btn" onClick={close} aria-label="閉じる">
            <IconX />
          </button>
        </div>
        <div className="modal-body">
          <section className="safety-sec">
            <h3>文字認識</h3>
            <p>スキャンしたページや、画像・図として貼られた文字は、この端末の中で自動で読み取ります。設定は要りません。</p>
          </section>
          <section className="safety-sec settings-cloud">
            <h3>高精度の文字認識（クラウド）・上級者向け</h3>
            <p>
              端末の中の文字認識で読み落としが多い資料のために、Google Cloud Vision で読む方法を使えます。ご自身の Google Cloud の
              APIキーが必要です。<b>キーを入れなければ、外部には一切送信しません。</b>
            </p>
            {keySet ? (
              <>
                <div className="settings-row">
                  <span className="settings-ok">APIキー：このブラウザに保存済み</span>
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      saveCloudKey("");
                      disableCloudOcr();
                      useStore.setState({ cloudKeySet: false });
                      toast({ message: "APIキーを消去しました。クラウドには送りません" });
                    }}
                  >
                    キーを消去
                  </button>
                </div>
                <p className="muted small">
                  文字認識するページのある文書を開くと、画面下に「高精度で読む」が出ます。送る前に毎回、文書ごとに確かめます。今月このブラウザから送った枚数：
                  {used} / {MONTHLY_CAP}枚（無料枠の月1,000枚を超えないよう、{MONTHLY_CAP}枚で止めます）。
                </p>
              </>
            ) : (
              <form
                className="cloud-key"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!key.trim()) return;
                  saveCloudKey(key.trim());
                  setKey("");
                  useStore.setState({ cloudKeySet: true });
                  toast({ message: "APIキーを保存しました（このブラウザだけ）", tone: "success" });
                }}
              >
                <span>Google Cloud Vision の APIキー（このブラウザにだけ保存します）</span>
                <span className="cloud-key-row">
                  <input
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
                  <button className="btn primary sm" type="submit" disabled={!key.trim()}>
                    保存
                  </button>
                </span>
                <a href="manual/#cloud" target="_blank" rel="noopener">
                  APIキーの作り方
                </a>
              </form>
            )}
          </section>
        </div>
        <div className="modal-foot">
          <span />
          <button className="btn primary" onClick={close}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

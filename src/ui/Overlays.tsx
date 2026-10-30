import { useEffect, useRef, useState } from "react";
import { BUILD, BUILD_LABEL, VERSION_LABEL } from "../buildInfo";
import { applySuggestion, openSample } from "../model/actions";
import { clearSavedWork } from "../model/autosave";
import { dismissToast, toast, useStore } from "../model/store";
import { ocrJobMode, ocrState, ocrTargetCount } from "../model/ocr";
import { isOcrPage, ocrMode, pageHasText } from "../model/texts";
import { IconAlert, IconCheck, IconCloud, IconFolderOpen, IconLock, IconShield, IconWand, IconX } from "./icons";

// ---- 通知 ----

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={"toast " + (t.tone ?? "info")}>
          {t.tone === "success" && <IconCheck size={16} />}
          {(t.tone === "warn" || t.tone === "error") && <IconAlert size={16} />}
          <span>{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn xs" aria-label="閉じる" onClick={() => dismissToast(t.id)}>
            <IconX size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---- 同じ値の提案 ----

export function SuggestionBar() {
  const sug = useStore((s) => s.suggestion);
  if (!sug) return null;
  const count = sug.hits.reduce((n, h) => n + h.rects.length, 0);
  const pages = new Set(sug.hits.map((h) => `${h.docId}:${h.page}`)).size;
  return (
    <div className="suggestion" role="status">
      <IconWand size={18} />
      <span>
        {sug.values.length === 1 ? (
          <>
            同じ<b>「{sug.values[0]}」</b>が
          </>
        ) : (
          <>
            同じ値（<b>{sug.values.length}</b>種類）が
          </>
        )}
        ほかに <b>{count}</b> か所（{pages}ページ）あります
      </span>
      <button className="btn primary sm" onClick={applySuggestion}>
        すべて隠す <kbd>Enter</kbd>
      </button>
      <button className="icon-btn xs" aria-label="閉じる（Esc）" onClick={() => useStore.setState({ suggestion: null })}>
        <IconX size={14} />
      </button>
    </div>
  );
}

// ---- パスワード ----

export function PasswordDialog() {
  const req = useStore((s) => s.passwordRequest);
  const [pw, setPw] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (req) {
      setPw("");
      setTimeout(() => ref.current?.focus(), 0);
    }
  }, [req]);
  if (!req) return null;
  return (
    <div className="modal-backdrop">
      <form
        className="modal small"
        role="dialog"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault();
          req.resolve(pw);
        }}
      >
        <div className="modal-head">
          <h2>
            <IconLock size={18} /> パスワードが必要です
          </h2>
        </div>
        <div className="modal-body">
          <p>
            「{req.fileName}」は保護されています。
            <br />
            <span className="muted small">編集して書き出すため、権限パスワード（管理用）があればそちらを入力してください。</span>
          </p>
          <input ref={ref} className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="パスワード" />
          {req.bad && <div className="field-error">パスワードが違います</div>}
        </div>
        <div className="modal-foot">
          <span />
          <button type="button" className="btn ghost" onClick={() => req.resolve(null)}>
            開かない
          </button>
          <button className="btn primary" type="submit">
            開く
          </button>
        </div>
      </form>
    </div>
  );
}

// ---- 使い方・ショートカット ----

const SHORTCUTS: [string, [string, string][]][] = [
  [
    "隠す",
    [
      ["ドラッグ", "範囲内の数字だけ（文字モードでは数字以外の文字だけ）に吸着して隠す"],
      ["クリック", "数字のかたまり（単語）を隠す"],
      ["Alt + ドラッグ", "吸着せず範囲そのままを隠す"],
      ["1 / 2 / 3", "モザイク / ぼかし / 塗りつぶし（色・透明度は上のバーで選択）"],
      ["S", "吸着の切替（数字 → 文字 → 自由）"],
      ["[ / ]", "モザイク・ぼかしの程度（弱・中・強）を切り替え"],
      ["Enter", "「同じ値をすべて隠す」を実行"],
      ["P（長押し）", "原本を確認する"],
    ],
  ],
  [
    "選択・編集",
    [
      ["クリック / Shift+クリック", "マスクを選択 / 追加選択"],
      ["回転ハンドル", "上の丸をドラッグして回転。Shiftで15度刻み、角度欄で細かく指定"],
      ["Shift + ドラッグ", "範囲内のマスクをまとめて選択"],
      ["Ctrl + A", "このページのマスクをすべて選択"],
      ["Delete", "選択中のマスクを削除"],
      ["矢印（Shiftで10倍）", "選択中のマスクを1ptずつ移動"],
      ["Ctrl+Z / Ctrl+Shift+Z", "元に戻す / やり直す"],
    ],
  ],
  [
    "テキスト枠（Tで作る。マスクとは別）",
    [
      ["T → ドラッグ（またはクリック）", "ページに枠を作って、そのまま文字を入力"],
      ["枠をダブルクリック / Enter / F2", "枠の中の文字を入力（枠を選んで文字キーでも始まる）"],
      ["Esc / 枠の外をクリック", "入力を終える（枠は選んだまま）"],
      ["Ctrl+Shift+> / <（Ctrl+] / [）", "文字を大きく / 小さく。サイズ欄に数字を入れても変えられる"],
      ["Ctrl + B", "太字"],
      ["Delete / 矢印キー", "枠を削除 / 動かす（Shiftで10pt）"],
    ],
  ],
  [
    "検索・書き出し",
    [
      ["Ctrl + F", "検索して隠す（プリセットあり）"],
      ["Ctrl + Enter", "検索結果をすべて隠す"],
      ["L", "マスク一覧"],
      ["Ctrl + S", "PDFを書き出す"],
      ["Ctrl + O", "PDFを開く"],
    ],
  ],
  [
    "表示・ページ",
    [
      ["M / V / T / H", "マスク / 選択 / テキスト枠 / 手のひらツール"],
      ["Space（押しながら）", "一時的に手のひら"],
      ["Ctrl + ホイール", "カーソル位置でズーム"],
      ["Ctrl + 0 / Ctrl + 9", "幅に合わせる / ページ全体"],
      ["PageUp / PageDown", "前 / 次のページ"],
      ["Ctrl + L / Ctrl + R", "表示中のページを左 / 右に回転"],
      ["Ctrl + D", "表示中のページを削除"],
      ["F / Tab", "全画面 / パネルを隠す"],
    ],
  ],
  [
    "ページ一覧（左のサムネイル）",
    [
      ["クリック", "ページを選ぶ（本文もそのページへ）"],
      ["Ctrl + クリック / Shift + クリック", "ページを追加・解除 / 範囲で選ぶ"],
      ["↑ ↓ / Shift + ↑ ↓ / Home / End", "選択を動かす / 範囲を広げる / 先頭・末尾へ"],
      ["Ctrl + A", "すべてのページを選ぶ"],
      ["Delete / Backspace", "選んだページをまとめて削除（Ctrl+Z で戻せる）"],
      ["右クリック", "削除・回転・すべて選択"],
      ["ドラッグ", "選んだページをまとめて並べ替え"],
    ],
  ],
];

export function HelpOverlay() {
  const open = useStore((s) => s.helpOpen);
  if (!open) return null;
  const close = () => useStore.setState({ helpOpen: false });
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal help" role="dialog" aria-modal="true" aria-label="使い方とショートカット">
        <div className="modal-head">
          <h2>使い方とショートカット</h2>
          <button className="icon-btn" onClick={close} aria-label="閉じる">
            <IconX />
          </button>
        </div>
        <div className="modal-body help-grid">
          {SHORTCUTS.map(([title, rows]) => (
            <section key={title}>
              <h3>{title}</h3>
              <dl>
                {rows.map(([k, v]) => (
                  <div key={k} className="kv">
                    <dt>
                      <kbd>{k}</kbd>
                    </dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="modal-foot">
          <div className="foot-note">
            <span className="muted small">
              <IconShield size={13} /> PDFはこの端末の中だけで処理され、外部には送信されません。
            </span>
            <span className="app-version" title="バージョン（ビルド日時・元になったコミット）">
              カクス {VERSION_LABEL}（{BUILD_LABEL}）
            </span>
          </div>
          <div className="foot-actions">
            <a className="btn ghost sm" href="manual/" target="_blank" rel="noopener">
              使い方ガイド（動画つき）
            </a>
            <button className="btn ghost sm" onClick={() => useStore.setState({ helpOpen: false, safetyOpen: true })}>
              安全性について
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 安全性について ----

const SOURCE_URL = "https://github.com/osamu-sej/Adobe-H-ver";

export function SafetyDialog() {
  const open = useStore((s) => s.safetyOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useStore.setState({ safetyOpen: false });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  const close = () => useStore.setState({ safetyOpen: false });
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal safety" role="dialog" aria-modal="true" aria-label="安全性について">
        <div className="modal-head">
          <h2>
            <IconShield size={20} /> 安全性について
          </h2>
          <button className="icon-btn" onClick={close} aria-label="閉じる">
            <IconX />
          </button>
        </div>
        <div className="modal-body">
          <p className="safety-lead">
            取り込んだPDFは、<b>お使いのパソコンのブラウザの中だけ</b>で処理されます。インターネット上のどこにも送信されません。
          </p>

          <section className="safety-sec">
            <h3>しくみ</h3>
            <p>
              このサイトから届くのは「ツールのプログラム」だけです。PDFの表示・加工・書き出しは、ブラウザに読み込んだPDFエンジン（MuPDF）が手元で行い、書き出したファイルも手元に保存されます。スキャンしたページや画像の中の文字の読み取り（OCR）も、このサイトから届く認識エンジンが手元で行います。サーバーはツールを配るだけで、PDFを受け取る仕組みはありません。
            </p>
          </section>

          <section className="safety-sec">
            <h3>送らないことの保証</h3>
            <ul>
              <li>
                外部への通信を禁止する設定（コンテンツセキュリティポリシー）を組み込んでいます。例外は、設定でAPIキーを入れた人だけが使える高精度の文字認識（クラウド）の送り先（Google Cloud Vision）だけで、それ以外へはプログラムが送ろうとしてもブラウザがブロックします。
              </li>
              <li>
                回線を切った状態でも、PDFを開く・隠す・書き出す・検証するまで動作します（スキャンしたページの文字認識だけは、初めて使うときに認識用の部品をこのサイトから読み込みます）。
              </li>
              <li>
                ソースコードは公開されており、誰でも中身を確認できます（
                <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
                  GitHub
                </a>
                ）。
              </li>
              <li>
                このページは {VERSION_LABEL}（{BUILD.date} ビルド）です。
                {BUILD.commit && (
                  <>
                    元になったソースコードは
                    <a href={`${SOURCE_URL}/commit/${BUILD.commit}`} target="_blank" rel="noopener noreferrer">
                      {BUILD.commit}
                    </a>
                    で確認できます。
                  </>
                )}
              </li>
            </ul>
          </section>

          <section className="safety-sec">
            <h3>高精度の文字認識（クラウド・任意）</h3>
            <p>
              端末内の文字認識では読み落としがある資料のために、「設定」でご自身の Google Cloud の APIキーを入れた場合だけ、Google Cloud Vision で読む方法を使えます。
              <b>キーを入れなければ、外部への送信は一切行いません。</b>
              使う場合も文書ごとに確かめてから送り、送るのは文字認識するページの画像だけです（PDFの文字情報がある部分は白く消して送ります。PDFファイルそのもの・ファイル名は送りません）。
            </p>
            <button className="btn ghost sm" onClick={() => useStore.setState({ safetyOpen: false, settingsOpen: true })}>
              設定を開く
            </button>
          </section>

          <section className="safety-sec">
            <h3>ご自身で確かめる方法</h3>
            <ol>
              <li>このページを開いたあと、Wi-Fiを切る（または機内モードにする）。そのままPDFを開いて、隠して、書き出せることを確かめる。</li>
              <li>
                Chromeなら <kbd>F12</kbd> →「Network」タブを開いたままPDFを読み込む。通信が増えないことを確かめる。
              </li>
            </ol>
          </section>

          <section className="safety-sec">
            <h3>この端末に残るもの</h3>
            <p>
              作業の自動保存として、<b>ファイル名とマスクの位置（テキスト枠に入れた文字も）だけ</b>がこのブラウザに残ります（PDF本体と隠した文字は残りません）。設定でAPIキーを入れた場合は、APIキーと今月送った枚数も残ります（設定で消去できます）。共用のパソコンでは、使い終わったら消去してください。
            </p>
            <button
              className="btn ghost sm"
              onClick={() => {
                const n = clearSavedWork();
                toast({ message: `自動保存された作業 ${n} 件を消去しました` });
              }}
            >
              自動保存を消去
            </button>
          </section>

          <section className="safety-sec">
            <h3>書き出したPDFについて</h3>
            <p>
              社外に渡すときは、書き出しで<b>「加工したとおり」</b>を選んでください。「見た目だけ重ねる」では、隠した数字の文字データがPDFの中に残ります。
            </p>
          </section>

          <p className="muted small">
            サーバーには、一般のウェブサイトと同じく「ページが開かれた」というアクセス記録（IPアドレスなど）が残ります。PDFの中身やファイル名は届きません。なお、第三者によるセキュリティ監査は受けていません。
          </p>
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

// ---- 最初の画面 ----

export function EmptyState({ onOpen }: { onOpen: () => void }) {
  const loading = useStore((s) => s.loading);
  return (
    <div className="empty">
      <div className="empty-card">
        <div className="empty-mark" aria-hidden="true">
          {Array.from({ length: 16 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${(i % 4) * 90 + Math.floor(i / 4) * 60}ms` }} />
          ))}
        </div>
        <h1>PDFの見せられない部分を、数秒で隠す。</h1>
        <p className="lead">ここにPDFをドロップ（複数可）。数字はクリックするだけ、範囲はなぞるだけで隠せます。</p>
        <div className="empty-actions">
          <button className="btn primary lg" onClick={onOpen} disabled={!!loading}>
            <IconFolderOpen size={18} /> PDFを選ぶ
          </button>
          <button className="btn ghost lg" onClick={() => openSample()} disabled={!!loading}>
            サンプルで試す
          </button>
        </div>
        {loading && (
          <div className="muted small">
            「{loading.name}」を読み込み中…（{loading.done + 1}/{loading.total}）
          </div>
        )}
        <div className="safety-card">
          <IconShield size={26} />
          <div className="safety-card-main">
            <b>PDFはこの端末の外に送信されません</b>
            <ul>
              <li>ブラウザの中だけで処理</li>
              <li>外部への通信はブラウザが禁止</li>
              <li>回線を切っても使えます</li>
            </ul>
          </div>
          <button className="btn ghost sm" onClick={() => useStore.setState({ safetyOpen: true })}>
            安全性について
          </button>
        </div>
        <ol className="steps">
          <li>
            <b>なぞる</b>
            <span>範囲をドラッグすると、中の数字だけにピタッと吸着</span>
          </li>
          <li>
            <b>まとめる</b>
            <span>電話・金額・口座などのプリセットで全ページを一括</span>
          </li>
          <li>
            <b>書き出す</b>
            <span>文字ごと完全に削除し、残っていないか自動で検証</span>
          </li>
        </ol>
        <a className="manual-link" href="manual/" target="_blank" rel="noopener">
          使い方ガイドを見る（動画とお試しつき）→
        </a>
        <span className="app-version" title={`ビルド ${BUILD_LABEL}`}>
          {VERSION_LABEL} · {BUILD.date} 更新
        </span>
      </div>
    </div>
  );
}

// ---- 下部のステータス ----

export function StatusBar() {
  const current = useStore((s) => s.current);
  const docs = useStore((s) => s.docs);
  const layouts = useStore((s) => s.layouts);
  const tool = useStore((s) => s.tool);
  const snap = useStore((s) => s.snap);
  const peek = useStore((s) => s.peek);
  const selection = useStore((s) => s.selection.length);
  const frameSel = useStore((s) => s.frameSel.length);
  const editing = useStore((s) => !!s.frameEdit);
  useStore((s) => s.textVersion);
  const ocr = useStore((s) => s.ocr);
  const keySet = useStore((s) => s.cloudKeySet);
  const d = current ? docs[current.docId] : undefined;
  const idx = current ? layouts[current.docId]?.order.indexOf(current.page) ?? -1 : -1;
  const noText = current ? pageHasText(current.docId, current.page) === false : false;
  const ocrHere = current ? ocrState(current.docId, current.page) : undefined;
  const ocrRead = current ? isOcrPage(current.docId, current.page) : false;
  const partial = current ? (ocrMode(current.docId, current.page) ?? ocrJobMode(current.docId, current.page)) === "extra" : false;
  const ocrTotal = ocr.pending + ocr.done + ocr.failed;
  const targets = current ? ocrTargetCount(current.docId) : 0;
  const cloudOn = current ? ocr.cloud.includes(current.docId) : false;

  let hint = "";
  if (peek) hint = "原本を表示中（マスクは書き出し時に適用されます）";
  else if (editing) hint = "文字を入力中 · Esc か枠の外をクリックで終了 · Ctrl+Shift+> / < で文字サイズ · Ctrl+B で太字";
  else if (frameSel) hint = "Enter か ダブルクリックで文字を入力 · Ctrl+Shift+> / < で文字サイズ · Delete で削除 · 矢印で微調整 · Esc で選択解除";
  else if (tool === "text") hint = "ドラッグ（またはクリック）でテキスト枠をつくって、そのまま文字を入力できます";
  else if (tool === "hand") hint = "ドラッグでスクロール";
  else if (tool === "select") hint = "クリックで選択 · ドラッグで範囲選択 · Delete で削除 · 矢印で微調整";
  else if (selection) hint = "1〜3 で隠し方を変更 · [ ] で程度（弱・中・強） · Delete で削除 · 矢印で微調整 · Esc で選択解除";
  else if ((ocrHere === "queued" || ocrHere === "running") && partial)
    hint = "画像や図の中の文字を認識しています…（終わると画像の中の数字にも吸着できます）";
  else if (ocrHere === "queued" || ocrHere === "running")
    hint = "スキャンしたページの文字を認識しています…（終わると数字に吸着できます。今は範囲をなぞって隠せます）";
  else if (noText) hint = "このページは画像のみ（文字情報なし）：ドラッグした範囲をそのまま隠します";
  else if (ocrRead && snap !== "free")
    hint =
      (partial ? "画像や図の中の文字は文字認識（OCR）で読み取りました" : "文字認識（OCR）で読み取ったページです") +
      "。取りこぼしがないか目で確認してください · ドラッグ：範囲内の" +
      (snap === "digits" ? "数字" : "文字") +
      "だけを隠す · Alt+ドラッグ：範囲そのまま";
  else if (snap === "digits") hint = "ドラッグ：範囲内の数字だけを隠す · クリック：数字のかたまりを隠す · Alt+ドラッグ：範囲そのまま · P長押し：原本";
  else if (snap === "text") hint = "ドラッグ：範囲内の文字だけを隠す（数字は残す） · クリック：単語を隠す · Alt+ドラッグ：範囲そのまま";
  else hint = "ドラッグした範囲をそのまま隠す";

  return (
    <footer className="statusbar">
      <span className="sb-page">
        {d && idx >= 0 ? (
          <>
            <b>{idx + 1}</b> / {layouts[current!.docId]?.order.length}ページ <span className="muted">· {d.name}</span>
          </>
        ) : null}
      </span>
      <span className="sb-hint">{hint}</span>
      {ocr.pending > 0 && (
        <span
          className="sb-ocr"
          title={
            ocr.cloud.length
              ? "スキャンしたページや画像の中の文字を認識しています（高精度をオンにした文書は Google Cloud Vision で読みます）"
              : "スキャンしたページや画像の中の文字を、この端末の中で認識しています（外部には送信しません）"
          }
        >
          <i className="spinner" aria-hidden="true" />
          文字認識中 {ocr.done}/{ocrTotal}
        </span>
      )}
      {keySet && targets > 0 && !cloudOn && (
        <button
          className="sb-cloud"
          title="文字認識するページを Google Cloud Vision で読み直します（送る前に確認します）"
          onClick={() => useStore.setState({ cloudOcrFor: current!.docId })}
        >
          <IconCloud size={13} /> 高精度で読む
        </button>
      )}
      {cloudOn ? (
        <button
          className="sb-privacy cloud"
          title="この文書の文字認識は Google Cloud Vision で行っています。送るのはページの画像だけで、PDFそのものは送っていません（クリックで詳しく）"
          onClick={() => useStore.setState({ safetyOpen: true })}
        >
          <IconCloud size={13} /> クラウドで文字認識
        </button>
      ) : (
        <button
          className="sb-privacy"
          title="PDFはブラウザの中だけで処理され、外部には送信されません（クリックで詳しく）"
          onClick={() => useStore.setState({ safetyOpen: true })}
        >
          <IconShield size={13} /> 端末内で処理
        </button>
      )}
    </footer>
  );
}

export function DropOverlay({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="drop-overlay">
      <div>
        <IconFolderOpen size={40} />
        <b>ドロップして開く</b>
        <span>PDFを複数まとめて開けます · 端末の外には送信されません</span>
      </div>
    </div>
  );
}

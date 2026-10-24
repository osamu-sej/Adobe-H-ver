import { useEffect, useRef, useState } from "react";
import { applySuggestion, openSample } from "../model/actions";
import { clearSavedWork } from "../model/autosave";
import { dismissToast, toast, useStore } from "../model/store";
import { pageHasText } from "../model/texts";
import { IconAlert, IconCheck, IconFolderOpen, IconLock, IconShield, IconWand, IconX } from "./icons";

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
      ["1 / 2 / 3 / 4", "モザイク / ぼかし / 黒塗り / 白塗り"],
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
      ["Shift + ドラッグ", "範囲内のマスクをまとめて選択"],
      ["Ctrl + A", "このページのマスクをすべて選択"],
      ["Delete", "選択中のマスクを削除"],
      ["矢印（Shiftで10倍）", "選択中のマスクを1ptずつ移動"],
      ["Ctrl+Z / Ctrl+Shift+Z", "元に戻す / やり直す"],
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
      ["M / V / H", "マスク / 選択 / 手のひらツール"],
      ["Space（押しながら）", "一時的に手のひら"],
      ["Ctrl + ホイール", "カーソル位置でズーム"],
      ["Ctrl + 0 / Ctrl + 9", "幅に合わせる / ページ全体"],
      ["PageUp / PageDown", "前 / 次のページ"],
      ["Ctrl + L / Ctrl + R", "表示中のページを左 / 右に回転"],
      ["Ctrl + D", "表示中のページを削除"],
      ["F / Tab", "全画面 / パネルを隠す"],
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
          <span className="muted small">
            <IconShield size={13} /> PDFはこの端末の中だけで処理され、外部には送信されません。
          </span>
          <button className="btn ghost sm" onClick={() => useStore.setState({ helpOpen: false, safetyOpen: true })}>
            安全性について
          </button>
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
              このサイトから届くのは「ツールのプログラム」だけです。PDFの表示・加工・書き出しは、ブラウザに読み込んだPDFエンジン（MuPDF）が手元で行い、書き出したファイルも手元に保存されます。サーバーはツールを配るだけで、PDFを受け取る仕組みはありません。
            </p>
          </section>

          <section className="safety-sec">
            <h3>送らないことの保証</h3>
            <ul>
              <li>外部への通信を禁止する設定（コンテンツセキュリティポリシー）を組み込んでいます。万一プログラムが送ろうとしても、ブラウザがブロックします。</li>
              <li>回線を切った状態でも、PDFを開く・隠す・書き出す・検証するまで、すべて動作します。</li>
              <li>
                ソースコードは公開されており、誰でも中身を確認できます（
                <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
                  GitHub
                </a>
                ）。
              </li>
            </ul>
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
              作業の自動保存として、<b>ファイル名とマスクの位置だけ</b>がこのブラウザに残ります（PDF本体と隠した文字は残りません）。共用のパソコンでは、使い終わったら消去してください。
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
  useStore((s) => s.textVersion);
  const d = current ? docs[current.docId] : undefined;
  const idx = current ? layouts[current.docId]?.order.indexOf(current.page) ?? -1 : -1;
  const noText = current ? pageHasText(current.docId, current.page) === false : false;

  let hint = "";
  if (peek) hint = "原本を表示中（マスクは書き出し時に適用されます）";
  else if (tool === "hand") hint = "ドラッグでスクロール";
  else if (tool === "select") hint = "クリックで選択 · ドラッグで範囲選択 · Delete で削除 · 矢印で微調整";
  else if (selection) hint = "1〜4 で隠し方を変更 · [ ] で程度（弱・中・強） · Delete で削除 · 矢印で微調整 · Esc で選択解除";
  else if (noText) hint = "このページは画像のみ（文字情報なし）：ドラッグした範囲をそのまま隠します";
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
      <button
        className="sb-privacy"
        title="PDFはブラウザの中だけで処理され、外部には送信されません（クリックで詳しく）"
        onClick={() => useStore.setState({ safetyOpen: true })}
      >
        <IconShield size={13} /> 端末内で処理
      </button>
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

import { zipSync } from "fflate";
import { useEffect, useMemo, useState } from "react";
import { resolveStrength } from "../fx/effects";
import { engine } from "../engine/client";
import type { EncryptionOptions, ExportFile, ExportJob, Permissions } from "../engine/protocol";
import { toast, useStore } from "../model/store";
import { ocrPageCount } from "../model/texts";
import { IconAlert, IconCheck, IconDownload, IconLayers, IconLock, IconShield, IconX } from "./icons";

const DEFAULT_PERMS: Permissions = {
  print: true,
  copy: false,
  edit: false,
  annotate: false,
  form: false,
  assemble: false,
  accessibility: true,
};

const PERM_LABEL: Record<keyof Permissions, string> = {
  print: "印刷",
  copy: "文字・画像のコピー",
  edit: "内容の変更",
  annotate: "注釈の追加",
  form: "フォームへの入力",
  assemble: "ページの挿入・回転・削除",
  accessibility: "アクセシビリティ用の抽出",
};

function outName(name: string) {
  return name.replace(/\.pdf$/i, "") + "_加工済.pdf";
}

function download(name: string, bytes: Uint8Array, type = "application/pdf") {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 仕上がり：加工したとおり（下の文字は消す）／見た目だけ重ねる（文字は残す）／全ページ画像 */
type Method = "visual" | "overlay" | "image";

type Phase = { kind: "form" } | { kind: "running"; done: number; total: number; label: string } | { kind: "done"; files: ExportFile[] };

export function ExportDialog() {
  const open = useStore((s) => s.exportOpen);
  if (!open) return null;
  return <ExportDialogInner />;
}

function ExportDialogInner() {
  const docOrder = useStore((s) => s.docOrder);
  const docs = useStore((s) => s.docs);
  const layouts = useStore((s) => s.layouts);
  const masks = useStore((s) => s.masks);

  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(docOrder.map((id) => [id, outName(docs[id].name)])),
  );
  const [included, setIncluded] = useState<Record<string, boolean>>(() => Object.fromEntries(docOrder.map((id) => [id, true])));
  const [mode, setMode] = useState<"separate" | "merge">("separate");
  const [mergedName, setMergedName] = useState(`結合_加工済_${stamp()}.pdf`);
  const [method, setMethod] = useState<Method>("visual");
  const [flatten, setFlatten] = useState(true);
  const [stripMetadata, setStripMetadata] = useState(true);
  const [stripExtras, setStripExtras] = useState(true);
  const [stripOutlines, setStripOutlines] = useState(false);
  const [props, setProps] = useState({ title: "", author: "", subject: "", keywords: "" });
  const [encrypt, setEncrypt] = useState(false);
  const [enc, setEnc] = useState<EncryptionOptions>({ method: "aes-256", userPassword: "", ownerPassword: "", permissions: DEFAULT_PERMS });
  const [userConfirm, setUserConfirm] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [showDetails, setShowDetails] = useState(false);

  const close = () => {
    if (phase.kind === "running") return;
    useStore.setState({ exportOpen: false });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const selectedDocs = docOrder.filter((id) => included[id]);
  const maskCount = (id: string) => masks.filter((m) => m.docId === id && layouts[id]?.order.includes(m.page)).length;
  const totalMasks = selectedDocs.reduce((n, id) => n + maskCount(id), 0);
  const rotatedMasks = masks.some((m) => !!m.angle && selectedDocs.includes(m.docId) && layouts[m.docId]?.order.includes(m.page));
  const single = selectedDocs.length === 1 || mode === "merge";
  const shared = encrypt && (!enc.ownerPassword || enc.ownerPassword === enc.userPassword);
  const restricted = Object.values(enc.permissions).some((v) => !v);

  const errors = useMemo(() => {
    const e: string[] = [];
    if (!selectedDocs.length) e.push("書き出すファイルを1つ以上選んでください");
    if (encrypt) {
      if (!enc.userPassword && !enc.ownerPassword) e.push("パスワードを入力してください");
      if (enc.userPassword !== userConfirm) e.push("閲覧用パスワードが確認用と一致しません");
      if (/,/.test(enc.userPassword + enc.ownerPassword)) e.push("パスワードにカンマ（,）は使えません");
      if (!shared && restricted && !enc.ownerPassword) e.push("権限を制限するには権限パスワードが必要です");
    }
    return e;
  }, [selectedDocs.length, encrypt, enc, userConfirm, shared, restricted]);

  const start = async () => {
    if (errors.length) return;
    const job: ExportJob = {
      docs: selectedDocs.map((id) => {
        const l = layouts[id];
        return {
          docId: id,
          name: ensurePdf(names[id] || outName(docs[id].name)),
          order: l.order,
          rot: l.rot,
          masks: masks
            .filter((m) => m.docId === id && l.order.includes(m.page))
            .map((m) => ({
              id: m.id,
              page: m.page,
              x: m.x,
              y: m.y,
              w: m.w,
              h: m.h,
              angle: m.angle,
              style: m.style,
              strength: resolveStrength(m),
              color: m.color,
              opacity: m.opacity,
              label: m.label,
              text: m.text,
            })),
        };
      }),
      options: {
        mode,
        mergedName: ensurePdf(mergedName),
        rasterize: method === "image",
        keepText: method === "overlay",
        rasterDpi: 200,
        flatten,
        stripMetadata,
        stripExtras,
        stripOutlines,
        props: single && Object.values(props).some(Boolean) ? props : null,
        encryption: encrypt ? enc : null,
      },
    };
    setPhase({ kind: "running", done: 0, total: 1, label: "準備中" });
    try {
      const res = await engine.export(job, (done, total, label) => setPhase({ kind: "running", done, total, label }));
      setPhase({ kind: "done", files: res.files });
      useStore.setState({ exportedAt: Date.now() });
      saveAll(res.files);
    } catch (e) {
      setPhase({ kind: "form" });
      toast({ message: "書き出しに失敗しました：" + (e as Error).message, tone: "error", duration: 10000 });
    }
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal export" role="dialog" aria-modal="true" aria-label="PDFを書き出す">
        <div className="modal-head">
          <h2>PDFを書き出す</h2>
          <button className="icon-btn" onClick={close} disabled={phase.kind === "running"} aria-label="閉じる">
            <IconX />
          </button>
        </div>

        {phase.kind === "form" && (
          <>
            <div className="modal-body">
              <section className="ex-section">
                <h3>ファイル</h3>
                <div className="ex-files">
                  {docOrder.map((id) => (
                    <div key={id} className={"ex-file" + (included[id] ? "" : " off")}>
                      {docOrder.length > 1 && (
                        <input
                          type="checkbox"
                          checked={included[id]}
                          onChange={(e) => setIncluded({ ...included, [id]: e.target.checked })}
                          aria-label="書き出す"
                        />
                      )}
                      <div className="ex-file-main">
                        <input
                          className="input"
                          value={names[id]}
                          disabled={mode === "merge"}
                          onChange={(e) => setNames({ ...names, [id]: e.target.value })}
                        />
                        <span className="muted small">
                          {docs[id].name} · {layouts[id].order.length}ページ · マスク {maskCount(id)} 件
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
                {docOrder.length > 1 && (
                  <div className="radio-row">
                    <label>
                      <input type="radio" checked={mode === "separate"} onChange={() => setMode("separate")} />
                      ファイルごとに保存（ZIPにまとめる）
                    </label>
                    <label>
                      <input type="radio" checked={mode === "merge"} onChange={() => setMode("merge")} />
                      1つのPDFに結合
                    </label>
                  </div>
                )}
                {mode === "merge" && docOrder.length > 1 && (
                  <input className="input" value={mergedName} onChange={(e) => setMergedName(e.target.value)} aria-label="結合後のファイル名" />
                )}
              </section>

              <section className="ex-section">
                <h3>
                  <IconShield size={16} /> 仕上がり
                </h3>
                <p className="muted small">
                  どれを選んでも、モザイク・ぼかしの程度や塗りは<b>画面で加工したとおりの見た目</b>で書き出されます。違いは、隠した部分の下にある元の文字データの扱いです。
                </p>
                <div className="choice-cards three">
                  <label className={"choice" + (method === "visual" ? " on" : "")}>
                    <input type="radio" checked={method === "visual"} onChange={() => setMethod("visual")} />
                    <b>加工したとおり（おすすめ）</b>
                    <span>見た目は画面のまま。隠した部分の下の元の文字データだけを消すので、コピーや検索でも読めません。</span>
                  </label>
                  <label className={"choice" + (method === "overlay" ? " on warn" : "")}>
                    <input type="radio" checked={method === "overlay"} onChange={() => setMethod("overlay")} />
                    <b>見た目だけ重ねる</b>
                    <span>加工を上に重ねるだけ。元の文字データは残るので、コピーや検索で読めてしまいます。</span>
                  </label>
                  <label className={"choice" + (method === "image" ? " on" : "")}>
                    <input type="radio" checked={method === "image"} onChange={() => setMethod("image")} />
                    <b>全ページを画像にする</b>
                    <span>最も安全。文字情報は一切残りません（検索・コピー不可、容量は増えます）。</span>
                  </label>
                </div>
                {method === "overlay" && (
                  <div className="note warn">
                    <IconAlert size={15} />
                    <span>
                      隠した数字は見た目では読みにくくなりますが、PDFの中には残ります。社外に渡す資料では「加工したとおり」を選んでください。
                    </span>
                  </div>
                )}
                {rotatedMasks && method !== "overlay" && (
                  <div className="note">
                    回転したマスクのあるページは、周囲の見た目を保つため画像が追加されます。ファイル容量が増え、マスクに接する文字や図形は枠の外側まで削除される場合があります。
                  </div>
                )}
                <div className="checks">
                  <label>
                    <input type="checkbox" checked={flatten} onChange={(e) => setFlatten(e.target.checked)} />
                    注釈・フォームを平坦化<span className="muted">（注釈内の数字の取りこぼし防止）</span>
                  </label>
                  <label>
                    <input type="checkbox" checked={stripMetadata} onChange={(e) => setStripMetadata(e.target.checked)} />
                    文書情報・XMP・構造タグを削除<span className="muted">（作成者・タイトル等に残る情報）</span>
                  </label>
                  <label>
                    <input type="checkbox" checked={stripExtras} onChange={(e) => setStripExtras(e.target.checked)} />
                    添付ファイル・JavaScript・埋め込みサムネイルを削除
                  </label>
                  <label>
                    <input type="checkbox" checked={stripOutlines} onChange={(e) => setStripOutlines(e.target.checked)} />
                    しおりを削除
                  </label>
                </div>
              </section>

              <button className="disclosure" onClick={() => setShowDetails(!showDetails)}>
                {showDetails ? "▾" : "▸"} 文書プロパティ・パスワード保護
                {encrypt && (
                  <span className="chip on sm">
                    <IconLock size={12} /> 保護あり
                  </span>
                )}
              </button>

              {showDetails && (
                <>
                  {single && (
                    <section className="ex-section">
                      <h3>文書プロパティ</h3>
                      <p className="muted small">空欄の項目は書き込みません。</p>
                      <div className="grid2">
                        {(
                          [
                            ["title", "タイトル"],
                            ["author", "作成者"],
                            ["subject", "サブタイトル"],
                            ["keywords", "キーワード"],
                          ] as const
                        ).map(([k, l]) => (
                          <label key={k} className="field">
                            <span>{l}</span>
                            <input className="input" value={props[k]} onChange={(e) => setProps({ ...props, [k]: e.target.value })} />
                          </label>
                        ))}
                      </div>
                    </section>
                  )}
                  <section className="ex-section">
                    <label className="switch-row">
                      <input type="checkbox" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} />
                      <b>パスワードで保護する</b>
                    </label>
                    {encrypt && (
                      <>
                        <div className="grid2">
                          <label className="field">
                            <span>閲覧用パスワード（開くときに必要）</span>
                            <input
                              className="input"
                              type="password"
                              autoComplete="new-password"
                              value={enc.userPassword}
                              onChange={(e) => setEnc({ ...enc, userPassword: e.target.value })}
                            />
                          </label>
                          <label className="field">
                            <span>確認のためもう一度</span>
                            <input className="input" type="password" autoComplete="new-password" value={userConfirm} onChange={(e) => setUserConfirm(e.target.value)} />
                          </label>
                          <label className="field">
                            <span>権限パスワード（制限の解除に必要）</span>
                            <input
                              className="input"
                              type="password"
                              autoComplete="new-password"
                              value={enc.ownerPassword}
                              onChange={(e) => setEnc({ ...enc, ownerPassword: e.target.value })}
                            />
                          </label>
                          <label className="field">
                            <span>暗号化方式</span>
                            <select className="input" value={enc.method} onChange={(e) => setEnc({ ...enc, method: e.target.value as EncryptionOptions["method"] })}>
                              <option value="aes-256">AES 256bit（推奨）</option>
                              <option value="aes-128">AES 128bit</option>
                              <option value="rc4-128">RC4 128bit（古い閲覧ソフト向け）</option>
                            </select>
                          </label>
                        </div>
                        <div className={"perm-grid" + (shared ? " disabled" : "")}>
                          <div className="muted small">
                            {shared
                              ? "閲覧用と権限パスワードが同じ（または権限パスワードなし）のため、権限の制限は設定できません。制限が効かない閲覧ソフトがあるためです。"
                              : "許可する操作"}
                          </div>
                          {(Object.keys(PERM_LABEL) as (keyof Permissions)[]).map((k) => (
                            <label key={k}>
                              <input
                                type="checkbox"
                                disabled={shared}
                                checked={shared ? true : enc.permissions[k]}
                                onChange={(e) => setEnc({ ...enc, permissions: { ...enc.permissions, [k]: e.target.checked } })}
                              />
                              {PERM_LABEL[k]}
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </section>
                </>
              )}
            </div>
            <div className="modal-foot">
              <div className="muted small">
                {errors[0] ? (
                  <span className="field-error">{errors[0]}</span>
                ) : (
                  <>書き出し後に「残存文字・見た目の変化・文書情報」を自動で検証します。元のファイルは変更しません。</>
                )}
              </div>
              <button className="btn ghost" onClick={close}>
                キャンセル
              </button>
              <button className="btn primary" disabled={errors.length > 0} onClick={start}>
                <IconDownload size={16} />
                {totalMasks > 0 ? `${totalMasks}件の加工を反映して書き出す` : "書き出す"}
              </button>
            </div>
          </>
        )}

        {phase.kind === "running" && (
          <div className="modal-body center">
            <div className="progress-ring" aria-hidden="true" />
            <div className="progress-label">{phase.label}</div>
            <div className="progress-bar">
              <i style={{ width: `${Math.round((phase.done / Math.max(1, phase.total)) * 100)}%` }} />
            </div>
            <div className="muted small">すべてこの端末の中で処理しています</div>
          </div>
        )}

        {phase.kind === "done" && (
          <>
            <div className="modal-body">
              <Report files={phase.files} ocrPages={selectedDocs.reduce((n, id) => n + ocrPageCount(id), 0)} />
            </div>
            <div className="modal-foot">
              <div className="muted small">ダウンロードが始まらない場合は、各ファイルの「保存」を押してください。</div>
              <button className="btn ghost" onClick={() => setPhase({ kind: "form" })}>
                設定に戻る
              </button>
              <button className="btn primary" onClick={close}>
                閉じる
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ensurePdf(name: string) {
  const n = name.trim() || "output.pdf";
  return /\.pdf$/i.test(n) ? n : n + ".pdf";
}

function saveAll(files: ExportFile[]) {
  if (files.length === 1) {
    download(files[0].name, files[0].bytes);
    return;
  }
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) {
    let n = f.name;
    let i = 2;
    while (entries[n]) n = f.name.replace(/\.pdf$/i, `_${i++}.pdf`);
    entries[n] = f.bytes;
  }
  const zip = zipSync(entries, { level: 0 });
  download(`墨消し済_${stamp()}.zip`, zip, "application/zip");
}

function Report({ files, ocrPages }: { files: ExportFile[]; ocrPages: number }) {
  const allPassed = files.every((f) => f.report.passed);
  const kept = files.some((f) => f.report.textKept);
  return (
    <div className="report">
      <div className={"report-banner " + (allPassed ? "ok" : "ng")}>
        {allPassed ? <IconShield size={28} /> : <IconAlert size={28} />}
        <div>
          <b>{!allPassed ? "確認が必要な項目があります" : kept ? "書き出しました" : "検証に合格しました"}</b>
          <span>
            {!allPassed
              ? "下の項目を確認してください。心配な場合は「全ページを画像にする」で書き出し直すと確実です。"
              : kept
                ? "見た目は画面で加工したとおりです。「見た目だけ重ねる」設定のため、元の文字データは残しています。"
                : "見た目は画面で加工したとおりで、隠した部分の下に文字は残っていません。"}
          </span>
        </div>
      </div>
      {ocrPages > 0 && (
        <div className="report-note">
          <IconAlert size={16} />
          <span>
            スキャンした画像のページが<b>{ocrPages}ページ</b>あり、数字は文字認識（OCR）で探しました。画像の中の数字は上の自動検証では確かめられないので、
            <b>取りこぼしがないか書き出したPDFを目で確認してください。</b>
          </span>
        </div>
      )}
      {files.map((f) => {
        const r = f.report;
        const metaLeft = Object.entries(r.metadata);
        return (
          <div key={f.name} className="report-file">
            <div className="report-file-head">
              <b>{f.name}</b>
              <span className="muted small">
                {f.pages}ページ · マスク {f.masks} 件 · {(f.bytes.length / 1024).toFixed(0)}KB
              </span>
              <button className="btn sm" onClick={() => download(f.name, f.bytes)}>
                <IconDownload size={14} /> 保存
              </button>
            </div>
            <ul className="checklist">
              {r.textKept ? (
                <Check ok info label="隠した部分の元の文字データ">
                  残しています（見た目だけ重ねる設定）
                </Check>
              ) : (
                <Check ok={r.leakedChars === 0} label="隠した部分に残っている文字">
                  {r.leakedChars === 0 ? "0文字" : `${r.leakedChars}文字（${r.leakedSamples.join("、")}）`}
                </Check>
              )}
              <Check ok={r.pixelDiffPercent < 0.5} label="隠した部分以外の見た目の変化">
                {r.pixelDiffPercent.toFixed(3)}%{r.diffPages.length ? `（${r.diffPages.join("・")}ページ）` : ""}
              </Check>
              <Check ok={r.metadataClean} label="文書情報">
                {metaLeft.length ? metaLeft.map(([k, v]) => `${k}: ${v}`).join(" / ") : "なし"}
                {r.hasXmp ? "・XMPあり" : ""}
              </Check>
              <Check ok label="保護">
                {r.encrypted && r.encrypted !== "None" ? r.encrypted : "なし"}
              </Check>
              {r.residues.length > 0 && (
                <li className="warn">
                  <IconAlert size={15} />
                  <div>
                    <b>同じ値がマスクの外に残っています</b>
                    <ul>
                      {r.residues.slice(0, 8).map((x) => (
                        <li key={x.text}>
                          「{x.text}」… {x.count}か所（
                          {x.pages.map((p) => (p === 0 ? "文書情報・しおり" : `${p}ページ`)).join("・")}）
                        </li>
                      ))}
                    </ul>
                    <span className="muted small">意図して残している場合は問題ありません。隠すには、検索パネルでその値を検索してください。</span>
                  </div>
                </li>
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function Check({ ok, info, label, children }: { ok: boolean; info?: boolean; label: string; children: React.ReactNode }) {
  return (
    <li className={info ? "info" : ok ? "ok" : "ng"}>
      {info ? <IconLayers size={15} /> : ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
      <span className="check-label">{label}</span>
      <span className="check-value">{children}</span>
    </li>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { isCovered, maskSearchHits, runSearch, setSearch } from "../model/actions";
import { PRESETS } from "../model/presets";
import { deleteMasks, scrollToPage, select, useStore, type SearchHit } from "../model/store";
import { textProgress } from "../model/texts";
import { STYLE_LABEL } from "../model/types";
import { IconCheck, IconSearch, IconTrash, IconX } from "./icons";
import { STYLE_ICON } from "./SelectionToolbar";

export function SidePanel() {
  const panel = useStore((s) => s.panel);
  const maskCount = useStore((s) => s.masks.length);
  if (!panel) return null;
  return (
    <aside className="panel" aria-label={panel === "search" ? "検索して隠す" : "マスク一覧"}>
      <div className="panel-tabs">
        <button className={"tab" + (panel === "search" ? " on" : "")} onClick={() => useStore.setState({ panel: "search" })}>
          検索して隠す
        </button>
        <button className={"tab" + (panel === "masks" ? " on" : "")} onClick={() => useStore.setState({ panel: "masks" })}>
          マスク一覧 <span className="count">{maskCount}</span>
        </button>
        <button className="icon-btn sm" title="閉じる（Esc）" onClick={() => useStore.setState({ panel: null })}>
          <IconX size={15} />
        </button>
      </div>
      {panel === "search" ? <SearchTab /> : <MaskTab />}
    </aside>
  );
}

export const focusSearch = { current: () => {} };

function SearchTab() {
  const search = useStore((s) => s.search);
  const masks = useStore((s) => s.masks);
  const docs = useStore((s) => s.docs);
  const docCount = useStore((s) => s.docOrder.length);
  const style = useStore((s) => s.style);
  const textVersion = useStore((s) => s.textVersion);
  const inputRef = useRef<HTMLInputElement>(null);
  const [limit, setLimit] = useState(300);

  useEffect(() => {
    focusSearch.current = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    inputRef.current?.focus();
  }, []);

  // 文字の読み込みが進んだら検索し直す
  useEffect(() => {
    if (search.query || search.preset) runSearch();
  }, [textVersion]); // 検索条件の変更は setSearch 側で検索し直す

  const progress = textProgress();
  const excluded = useMemo(() => new Set(search.excluded), [search.excluded]);
  const covered = useMemo(
    () => new Set(search.hits.filter((h) => h.rects.every((r) => isCovered(masks, h.docId, h.page, r))).map((h) => h.key)),
    [search.hits, masks],
  );
  const pending = search.hits.filter((h) => !covered.has(h.key) && !excluded.has(h.key)).length;
  const pageCount = new Set(search.hits.map((h) => `${h.docId}:${h.page}`)).size;
  const StyleIcon = STYLE_ICON[style];

  const go = (i: number) => {
    const h = search.hits[i];
    if (!h) return;
    useStore.setState((s) => ({ search: { ...s.search, active: i } }));
    scrollToPage({ docId: h.docId, page: h.page }, h.rects[0]);
  };

  const toggle = (key: string) =>
    useStore.setState((s) => ({
      search: {
        ...s.search,
        excluded: s.search.excluded.includes(key) ? s.search.excluded.filter((k) => k !== key) : [...s.search.excluded, key],
      },
    }));

  const grouped: { head: string; items: { h: SearchHit; i: number }[] }[] = [];
  search.hits.slice(0, limit).forEach((h, i) => {
    const pageIdx = useStore.getState().layouts[h.docId]?.order.indexOf(h.page) ?? h.page;
    const head = (docCount > 1 ? `${docs[h.docId]?.name ?? ""} · ` : "") + `${pageIdx + 1}ページ`;
    const last = grouped[grouped.length - 1];
    if (last?.head === head) last.items.push({ h, i });
    else grouped.push({ head, items: [{ h, i }] });
  });

  return (
    <div className="panel-body">
      <div className="search-box">
        <IconSearch size={16} />
        <input
          ref={inputRef}
          className="search-input"
          placeholder={search.preset ? `プリセット：${PRESETS.find((p) => p.id === search.preset)?.label}` : "文字・数字で検索"}
          value={search.query}
          onChange={(e) => setSearch({ query: e.target.value, preset: null })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              maskSearchHits();
            } else if (e.key === "Enter") {
              e.preventDefault();
              const n = search.hits.length;
              if (n) go((search.active + (e.shiftKey ? n - 1 : 1)) % n);
            } else if (e.key === "Escape") {
              useStore.setState({ panel: null });
            }
          }}
        />
        <button
          className={"chip mono" + (search.regex ? " on" : "")}
          title="正規表現で検索。(?<m>…) で一部だけ隠せます"
          onClick={() => setSearch({ regex: !search.regex })}
        >
          .*
        </button>
      </div>
      {search.error && <div className="field-error">{search.error}</div>}

      <div className="preset-grid">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className={"preset" + (search.preset === p.id ? " on" : "")}
            title={p.hint}
            onClick={() => setSearch({ preset: search.preset === p.id ? null : p.id, query: "" })}
          >
            {p.label}
          </button>
        ))}
      </div>

      {docCount > 1 && (
        <div className="scope">
          <label>
            <input type="radio" checked={search.scope === "all"} onChange={() => setSearch({ scope: "all" })} />
            すべてのファイル
          </label>
          <label>
            <input type="radio" checked={search.scope === "current"} onChange={() => setSearch({ scope: "current" })} />
            表示中のファイル
          </label>
        </div>
      )}

      {progress.loaded < progress.total && (
        <div className="muted small">
          文字を読み込み中… {progress.loaded}/{progress.total}ページ
        </div>
      )}

      {(search.query || search.preset) && (
        <div className="result-head">
          <span>
            <b>{search.hits.length}</b>件（{pageCount}ページ）
            {search.hits.length > 0 && <span className="muted"> · 未マスク {pending}</span>}
          </span>
          {search.hits.length > 0 && (
            <button
              className="link"
              onClick={() =>
                useStore.setState((s) => ({
                  search: { ...s.search, excluded: s.search.excluded.length ? [] : s.search.hits.map((h) => h.key) },
                }))
              }
            >
              {search.excluded.length ? "すべて選択" : "すべて解除"}
            </button>
          )}
        </div>
      )}

      <div className="result-list">
        {grouped.map((g) => (
          <div key={g.head} className="result-group">
            <div className="result-group-head">{g.head}</div>
            {g.items.map(({ h, i }) => {
              const done = covered.has(h.key);
              return (
                <div
                  key={h.key}
                  className={"result" + (i === search.active ? " active" : "") + (done ? " done" : "")}
                  onClick={() => go(i)}
                >
                  <input
                    type="checkbox"
                    checked={!excluded.has(h.key)}
                    disabled={done}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggle(h.key)}
                    aria-label="隠す対象にする"
                  />
                  <span className="ctx">
                    {h.context.slice(0, h.ctxStart)}
                    <mark>{h.context.slice(h.ctxStart, h.ctxEnd)}</mark>
                    {h.context.slice(h.ctxEnd)}
                  </span>
                  {done && (
                    <span className="done-tag" title="マスク済み">
                      <IconCheck size={13} />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {search.hits.length > limit && (
          <button className="btn ghost full" onClick={() => setLimit(limit + 500)}>
            さらに表示（残り {search.hits.length - limit} 件）
          </button>
        )}
        {!search.query && !search.preset && (
          <div className="empty-hint">
            <p>プリセットを押すと、全ページから一気に探せます。</p>
            <p className="muted small">
              検索語は全角・半角を区別しません。見つかったものはチェックを外すと除外できます。
            </p>
          </div>
        )}
      </div>

      <div className="panel-foot">
        <button className="btn primary full" disabled={pending === 0} onClick={maskSearchHits} title="Ctrl+Enter">
          <StyleIcon size={16} />
          {pending > 0 ? `${pending}件を${STYLE_LABEL[style]}で隠す` : "隠す対象はありません"}
          <kbd>Ctrl+Enter</kbd>
        </button>
      </div>
    </div>
  );
}

function MaskTab() {
  const masks = useStore((s) => s.masks);
  const docs = useStore((s) => s.docs);
  const docOrder = useStore((s) => s.docOrder);
  const layouts = useStore((s) => s.layouts);
  const selection = useStore((s) => s.selection);
  const sel = new Set(selection);

  const groups: { key: string; head: string; items: typeof masks }[] = [];
  for (const docId of docOrder) {
    const l = layouts[docId];
    if (!l) continue;
    l.order.forEach((p, i) => {
      const items = masks.filter((m) => m.docId === docId && m.page === p).sort((a, b) => a.y - b.y || a.x - b.x);
      if (items.length) groups.push({ key: `${docId}:${p}`, head: (docOrder.length > 1 ? `${docs[docId]?.name} · ` : "") + `${i + 1}ページ`, items });
    });
  }
  const hiddenPages = masks.filter((m) => !layouts[m.docId]?.order.includes(m.page)).length;

  return (
    <div className="panel-body">
      <div className="result-head">
        <span>
          <b>{masks.length}</b>件（{groups.length}ページ）
        </span>
        {masks.length > 0 && (
          <button className="link" onClick={() => select(masks.map((m) => m.id))}>
            すべて選択
          </button>
        )}
      </div>
      {hiddenPages > 0 && <div className="muted small">削除したページ上のマスク {hiddenPages} 件は書き出されません。</div>}
      <div className="result-list">
        {groups.map((g) => (
          <div key={g.key} className="result-group">
            <div className="result-group-head">{g.head}</div>
            {g.items.map((m) => {
              const Icon = STYLE_ICON[m.style];
              return (
                <div
                  key={m.id}
                  className={"result mask-row" + (sel.has(m.id) ? " active" : "")}
                  onClick={(e) => {
                    select(e.shiftKey || e.metaKey || e.ctrlKey ? (sel.has(m.id) ? selection.filter((x) => x !== m.id) : [...selection, m.id]) : [m.id]);
                    scrollToPage({ docId: m.docId, page: m.page }, m);
                  }}
                >
                  <span className="mask-ico" title={STYLE_LABEL[m.style]}>
                    <Icon size={15} />
                  </span>
                  <span className="ctx">
                    {m.text ? m.text : <span className="muted">範囲 {Math.round(m.w)}×{Math.round(m.h)}pt</span>}
                    {m.label && <span className="tag">{m.label}</span>}
                  </span>
                  <button
                    className="icon-btn xs danger"
                    title="削除"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMasks([m.id]);
                    }}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
        {!masks.length && (
          <div className="empty-hint">
            <p>まだマスクはありません。</p>
            <p className="muted small">ページ上の数字をクリックするか、範囲をドラッグして隠します。</p>
          </div>
        )}
      </div>
      {selection.length > 0 && (
        <div className="panel-foot">
          <button className="btn danger full" onClick={() => deleteMasks(selection)}>
            <IconTrash size={15} />
            選択中の {selection.length} 件を削除
          </button>
        </div>
      )}
    </div>
  );
}

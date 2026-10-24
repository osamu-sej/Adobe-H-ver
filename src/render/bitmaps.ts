import { useEffect, useState } from "react";
import { CancelledError, engine } from "../engine/client";

export interface PageBitmap {
  bitmap: ImageBitmap;
  /** px / pt */
  scale: number;
  width: number;
  height: number;
}

type Listener = () => void;

/**
 * ページ画像のキャッシュ。表示中のページを高解像度で、それ以外は捨てる。
 * サムネイルは別枠で小さく持つ。
 */
class BitmapCache {
  private entries = new Map<string, PageBitmap>();
  private inflight = new Map<string, { scale: number; cancel: () => void }>();
  private listeners = new Map<string, Set<Listener>>();

  constructor(private limit: number) {}

  get(key: string): PageBitmap | undefined {
    const e = this.entries.get(key);
    if (e) {
      this.entries.delete(key);
      this.entries.set(key, e);
    }
    return e;
  }

  subscribe(key: string, fn: Listener) {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
  }

  private emit(key: string) {
    this.listeners.get(key)?.forEach((fn) => fn());
  }

  request(docId: string, page: number, scale: number, priority: number) {
    const key = `${docId}:${page}`;
    const running = this.inflight.get(key);
    if (running) {
      if (Math.abs(running.scale - scale) / scale < 0.02) return;
      running.cancel();
      this.inflight.delete(key);
    }
    const { promise, cancel } = engine.render(docId, page, scale, priority);
    this.inflight.set(key, { scale, cancel });
    promise
      .then((r) => {
        if (this.inflight.get(key)?.scale === scale) this.inflight.delete(key);
        const old = this.entries.get(key);
        this.entries.delete(key);
        this.entries.set(key, { bitmap: r.bitmap, scale: r.scale, width: r.width, height: r.height });
        if (old) queueMicrotask(() => old.bitmap.close());
        this.evict();
        this.emit(key);
      })
      .catch((e) => {
        if (this.inflight.get(key)?.scale === scale) this.inflight.delete(key);
        if (!(e instanceof CancelledError)) console.warn("render failed", e);
      });
  }

  cancel(docId: string, page: number) {
    const key = `${docId}:${page}`;
    this.inflight.get(key)?.cancel();
    this.inflight.delete(key);
  }

  private evict() {
    while (this.entries.size > this.limit) {
      const [k, v] = this.entries.entries().next().value!;
      // 表示中（購読者あり）のページは残す
      if (this.listeners.get(k)?.size) {
        this.entries.delete(k);
        this.entries.set(k, v);
        if ([...this.entries.keys()].every((key) => this.listeners.get(key)?.size)) break;
        continue;
      }
      this.entries.delete(k);
      v.bitmap.close();
    }
  }

  drop(docId: string) {
    for (const [k, v] of [...this.entries]) {
      if (k.startsWith(docId + ":")) {
        v.bitmap.close();
        this.entries.delete(k);
      }
    }
  }
}

export const pageCache = new BitmapCache(8);
export const thumbCache = new BitmapCache(600);

/** 表示中のページの画像。目標解像度と15%以上ずれたら描き直しを頼む */
export function usePageBitmap(
  cache: BitmapCache,
  docId: string,
  page: number,
  targetScale: number,
  priority: number,
  delay = 0,
  enabled = true,
): PageBitmap | undefined {
  const key = `${docId}:${page}`;
  const [, force] = useState(0);
  useEffect(() => cache.subscribe(key, () => force((n) => n + 1)), [cache, key]);
  // 画面外に出たら描きかけの要求は取り消す
  useEffect(() => () => cache.cancel(docId, page), [cache, docId, page]);
  const current = cache.get(key);
  const stale = !current || Math.abs(current.scale - targetScale) / targetScale > 0.15;
  useEffect(() => {
    if (!stale || !enabled) return;
    const t = window.setTimeout(() => cache.request(docId, page, targetScale, priority), current ? delay : 0);
    return () => window.clearTimeout(t);
  }, [cache, docId, page, targetScale, priority, stale, delay, current, enabled]);
  return current;
}

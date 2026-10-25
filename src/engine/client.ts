import type {
  ExportJob,
  ExportResult,
  OcrImageResult,
  OpenResult,
  RenderResult,
  TextResult,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number, label: string) => void;
};

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;

/** MuPDFワーカーとのやりとり。PDFはすべてこの端末の中で処理される */
class Engine {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  readonly ready: Promise<void>;
  private markReady!: () => void;
  private markFailed!: (e: Error) => void;
  isReady = false;
  fatal: string | null = null;

  constructor() {
    this.ready = new Promise((res, rej) => {
      this.markReady = res;
      this.markFailed = rej;
    });
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      this.fatal = ev.message || "PDFエンジンを起動できませんでした";
      this.markFailed(new Error(this.fatal));
    };
  }

  private onMessage(msg: WorkerResponse) {
    switch (msg.type) {
      case "ready":
        this.isReady = true;
        this.markReady();
        return;
      case "fatal":
        this.fatal = msg.error;
        this.markFailed(new Error(msg.error));
        return;
      case "progress":
        this.pending.get(msg.id)?.onProgress?.(msg.done, msg.total, msg.label);
        return;
      case "result": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(msg.cancelled ? new CancelledError() : new Error(msg.error));
      }
    }
  }

  private call<T>(
    req: Distribute<WorkerRequest>,
    transfer: Transferable[] = [],
    onProgress?: Pending["onProgress"],
  ): { id: number; promise: Promise<T> } {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    });
    this.worker.postMessage({ ...req, id }, transfer);
    return { id, promise };
  }

  open(docId: string, bytes: Uint8Array, password?: string): Promise<OpenResult> {
    // 元のバイト列は手元にも残すのでコピーを渡す
    return this.call<OpenResult>({ type: "open", docId, bytes: bytes.slice(), password }).promise;
  }

  render(docId: string, page: number, scale: number, priority: number) {
    const { id, promise } = this.call<RenderResult>({ type: "render", docId, page, scale, priority });
    return { promise, cancel: () => this.worker.postMessage({ type: "cancel", ids: [id] }) };
  }

  text(docId: string, page: number, priority: number): Promise<TextResult> {
    return this.call<TextResult>({ type: "text", docId, page, priority }).promise;
  }

  ocrImage(docId: string, page: number, rotate: number, dpi: number, priority = 8, jpeg = false): Promise<OcrImageResult> {
    return this.call<OcrImageResult>({ type: "ocrImage", docId, page, rotate, dpi, priority, jpeg }).promise;
  }

  close(docId: string) {
    return this.call<null>({ type: "close", docId }).promise;
  }

  export(job: ExportJob, onProgress: Pending["onProgress"]): Promise<ExportResult> {
    return this.call<ExportResult>({ type: "export", job }, [], onProgress).promise;
  }
}

export const engine = new Engine();

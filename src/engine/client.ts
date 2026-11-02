import type { FontSource } from './fonts';
import type { FileResolver, RenderOptions, RenderResult } from './engine';
import type { FromWorker, ToWorker } from './protocol';

export class CancelledError extends Error {
  constructor() {
    super('Render superseded by a newer request');
    this.name = 'CancelledError';
  }
}

export interface WorkerClientOptions {
  /** Factory creating the engine worker (see `worker.ts`). */
  createWorker: () => Worker;
  /** URL of manifold.wasm, if it is not next to the bundled manifold.js. */
  wasmUrl?: string;
  fonts?: FontSource[];
  resolveFile?: FileResolver;
  /**
   * If a render is still running this long after a newer request arrived, the
   * worker is terminated and restarted (losing its geometry cache). Default 1500ms.
   */
  restartAfterMs?: number;
  edges?: boolean;
}

interface Job {
  id: number;
  source: string;
  options: RenderOptions;
  resolve: (r: RenderResult) => void;
  reject: (e: unknown) => void;
  started?: number;
}

/**
 * Main-thread client for the engine worker. Only the latest request matters:
 * intermediate requests are dropped, and long-running obsolete jobs are killed.
 */
export class OpenSCADWorkerClient {
  private worker!: Worker;
  private running: Job | undefined;
  private queued: Job | undefined;
  private nextId = 1;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: WorkerClientOptions) {
    this.spawn();
  }

  private spawn(): void {
    this.worker = this.opts.createWorker();
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data);
    this.worker.onerror = (ev) => {
      const job = this.running;
      this.running = undefined;
      job?.reject(new Error(ev.message || 'Worker error'));
      this.pump();
    };
    this.send({ type: 'init', wasmUrl: this.opts.wasmUrl, fonts: this.opts.fonts, edges: this.opts.edges });
  }

  private send(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }

  private async onMessage(msg: FromWorker): Promise<void> {
    switch (msg.type) {
      case 'resolve': {
        let result: { path: string; data: string | Uint8Array } | null = null;
        try {
          result = this.opts.resolveFile ? await this.opts.resolveFile(msg.path, msg.relativeTo, msg.binary) : null;
        } catch {
          result = null;
        }
        this.send({ type: 'resolved', reqId: msg.reqId, result });
        break;
      }
      case 'result':
      case 'error': {
        const job = this.running;
        if (!job || job.id !== msg.id) return;
        this.running = undefined;
        clearTimeout(this.killTimer);
        if (msg.type === 'result') job.resolve(msg.result);
        else job.reject(new Error(msg.message));
        this.pump();
        break;
      }
    }
  }

  private pump(): void {
    if (this.running || !this.queued) return;
    const job = this.queued;
    this.queued = undefined;
    this.running = job;
    job.started = performance.now();
    this.send({ type: 'render', id: job.id, source: job.source, options: job.options });
  }

  /** Render source code. Rejects with {@link CancelledError} if superseded. */
  render(source: string, options: RenderOptions = {}): Promise<RenderResult> {
    return new Promise((resolve, reject) => {
      this.queued?.reject(new CancelledError());
      this.queued = { id: this.nextId++, source, options, resolve, reject };
      if (!this.running) {
        this.pump();
        return;
      }
      // a job is running: kill it if it does not finish soon
      clearTimeout(this.killTimer);
      const limit = this.opts.restartAfterMs ?? 1500;
      const elapsed = performance.now() - (this.running.started ?? 0);
      this.killTimer = setTimeout(() => this.restart(), Math.max(0, limit - elapsed));
    });
  }

  /** Notify the worker that files changed on disk. */
  invalidateFiles(paths?: string[]): void {
    this.send({ type: 'invalidate', paths });
  }

  /** Abort the current job (restarting the worker) and drop queued work. */
  cancel(): void {
    this.queued?.reject(new CancelledError());
    this.queued = undefined;
    if (this.running) this.restart();
  }

  private restart(): void {
    if (!this.running) return;
    this.worker.terminate();
    this.running.reject(new CancelledError());
    this.running = undefined;
    this.spawn();
    this.pump();
  }

  dispose(): void {
    clearTimeout(this.killTimer);
    this.worker.terminate();
    this.queued?.reject(new CancelledError());
    this.running?.reject(new CancelledError());
  }
}

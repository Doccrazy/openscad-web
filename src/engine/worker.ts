/// <reference lib="webworker" />
/**
 * Web Worker entry point. Hosts an {@link OpenSCADEngine} and talks to
 * {@link OpenSCADWorkerClient} on the main thread.
 */
import Module from 'manifold-3d';
import { OpenSCADEngine } from './engine';
import type { FromWorker, ToWorker } from './protocol';
import { transferablesOf } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let engine: OpenSCADEngine | undefined;
let ready: Promise<OpenSCADEngine> | undefined;
let reqCounter = 0;
const resolvers = new Map<number, (r: { path: string; data: string | Uint8Array } | null) => void>();

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      ready = (async () => {
        const wasm = await Module(msg.wasmUrl ? { locateFile: () => msg.wasmUrl! } : undefined);
        wasm.setup();
        engine = new OpenSCADEngine({
          wasm,
          fonts: msg.fonts,
          edges: msg.edges,
          resolveFile: (path, relativeTo, binary) =>
            new Promise((resolve) => {
              const reqId = ++reqCounter;
              resolvers.set(reqId, resolve);
              post({ type: 'resolve', reqId, path, relativeTo, binary });
            }),
        });
        post({ type: 'ready' });
        return engine;
      })();
      break;
    case 'resolved':
      resolvers.get(msg.reqId)?.(msg.result);
      resolvers.delete(msg.reqId);
      break;
    case 'invalidate':
      engine?.invalidateFiles(msg.paths);
      break;
    case 'render': {
      try {
        const e = await ready;
        if (!e) throw new Error('Worker not initialized');
        const result = await e.render(msg.source, msg.options);
        post({ type: 'result', id: msg.id, result }, transferablesOf(result));
      } catch (err) {
        post({ type: 'error', id: msg.id, message: String((err as Error)?.stack ?? err) });
      }
      break;
    }
  }
};

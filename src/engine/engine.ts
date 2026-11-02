import type { ManifoldToplevel } from 'manifold-3d';
import { Interpreter } from '../eval/interpreter';
import type { EvalFileSystem, FileLookup, Message, PendingFile } from '../eval/interpreter';
import type { GeomNode } from '../eval/csg-tree';
import type { Value } from '../eval/values';
import { GeometryEvaluator } from '../geometry/evaluator';
import type { SceneData } from '../geometry/types';
import { offsetToLineCol, SyntaxError } from '../lang/lexer';
import { parse } from '../lang/parser';
import { FontRegistry, FontSource } from './fonts';

/**
 * Resolves files referenced by include/use/import/surface.
 * `relativeTo` is the canonical path of the referencing file (undefined for the main file).
 * Return `null` if the file does not exist.
 */
export type FileResolver = (
  path: string,
  relativeTo: string | undefined,
  binary: boolean,
) => Promise<{ path: string; data: string | Uint8Array } | null>;

export interface EngineOptions {
  /** An initialized manifold-3d module (call `setup()` before passing it). */
  wasm: ManifoldToplevel;
  fonts?: FontSource[];
  resolveFile?: FileResolver;
  /** Compute feature edges for outline rendering (default true). */
  edges?: boolean;
}

export interface RenderOptions {
  /** Canonical path / URI of the main file, used to resolve relative includes. */
  file?: string;
  /** Customizer values overriding top-level assignments. */
  overrides?: Record<string, Value>;
  /** Special variables such as `$t`. */
  specialVars?: Record<string, Value>;
  /** Abort evaluation after this many milliseconds. */
  timeoutMs?: number;
  /**
   * Compute exact unions (like OpenSCAD's F6 "render"); needed for export.
   * Default false: fast preview where plain unions are not computed.
   */
  exact?: boolean;
}

export interface EngineMessage extends Message {
  line?: number;
  col?: number;
}

export interface RenderResult {
  scene: SceneData;
  messages: EngineMessage[];
  /** True if evaluation failed (syntax or runtime error); the scene may be empty. */
  failed: boolean;
  timings: { parseMs: number; evalMs: number; geometryMs: number; totalMs: number };
}

const MAX_FILE_ROUNDS = 16;

/**
 * Host-agnostic OpenSCAD engine: parse → evaluate → CSG → meshes.
 * Works in a Web Worker, the main thread or Node.js.
 */
export class OpenSCADEngine {
  private readonly geometry: GeometryEvaluator;
  private readonly fonts: FontRegistry;
  private readonly fileCache = new Map<string, { path: string; data: string | Uint8Array } | null>();
  private readonly contents = new Map<string, string>();

  constructor(private readonly options: EngineOptions) {
    this.fonts = new FontRegistry(options.fonts);
    this.geometry = new GeometryEvaluator(options.wasm, { fonts: this.fonts, edges: options.edges });
  }

  /** Forget cached files (call when files on disk changed). */
  invalidateFiles(paths?: string[]): void {
    if (!paths) this.fileCache.clear();
    else
      for (const [k, v] of [...this.fileCache]) {
        if (v && paths.includes(v.path)) this.fileCache.delete(k);
      }
  }

  addFont(src: FontSource): void {
    this.fonts.add(src);
  }

  dispose(): void {
    this.geometry.dispose();
  }

  private fs(): EvalFileSystem {
    const lookup = <T>(binary: boolean) => (path: string, relativeTo?: string): FileLookup<T> => {
      const key = `${binary ? 'b' : 't'}|${relativeTo ?? ''}|${path}`;
      if (!this.fileCache.has(key)) return 'pending';
      const r = this.fileCache.get(key);
      if (!r) return undefined;
      let data = r.data;
      if (!binary && typeof data !== 'string') data = new TextDecoder().decode(data);
      if (binary && typeof data === 'string') data = new TextEncoder().encode(data);
      return { path: r.path, data: data as T };
    };
    return { readText: lookup<string>(false), readBinary: lookup<Uint8Array>(true) };
  }

  private async fetchPending(pending: PendingFile[]): Promise<void> {
    const resolver = this.options.resolveFile;
    await Promise.all(
      pending.map(async (p) => {
        const key = `${p.binary ? 'b' : 't'}|${p.relativeTo ?? ''}|${p.path}`;
        if (this.fileCache.has(key)) return;
        let r: { path: string; data: string | Uint8Array } | null = null;
        try {
          r = resolver ? await resolver(p.path, p.relativeTo, p.binary) : null;
        } catch {
          r = null;
        }
        this.fileCache.set(key, r);
        if (r && typeof r.data === 'string') this.contents.set(r.path, r.data);
      }),
    );
  }

  /** Evaluate the program to a CSG tree only (no geometry). */
  async evaluate(source: string, opts: RenderOptions = {}): Promise<{ nodes: GeomNode[]; messages: EngineMessage[]; failed: boolean; parseMs: number; evalMs: number }> {
    const t0 = performance.now();
    let program;
    try {
      program = parse(source, opts.file).program;
    } catch (e) {
      const err = e as SyntaxError;
      const msg: EngineMessage = { level: 'error', text: `Parser error: ${err.message}`, pos: err.pos, file: err.file };
      return { nodes: [], messages: this.locate([msg], source, opts.file), failed: true, parseMs: performance.now() - t0, evalMs: 0 };
    }
    const t1 = performance.now();
    for (let round = 0; ; round++) {
      const interp = new Interpreter({
        fs: this.fs(),
        overrides: opts.overrides,
        specialVars: opts.specialVars,
        timeoutMs: opts.timeoutMs,
      });
      const r = interp.run(program);
      if (r.pending.length && round < MAX_FILE_ROUNDS) {
        await this.fetchPending(r.pending);
        continue;
      }
      return {
        nodes: r.nodes,
        messages: this.locate(r.messages, source, opts.file),
        failed: r.failed,
        parseMs: t1 - t0,
        evalMs: performance.now() - t1,
      };
    }
  }

  async render(source: string, opts: RenderOptions = {}): Promise<RenderResult> {
    const t0 = performance.now();
    const ev = await this.evaluate(source, opts);
    if (this.fonts.hasPending && containsText(ev.nodes)) await this.fonts.load();
    const tg = performance.now();
    const { scene, warnings } = this.geometry.evaluate(ev.nodes, { exact: opts.exact });
    const geometryMs = performance.now() - tg;
    const messages = [
      ...ev.messages,
      ...this.locate(
        warnings.map((w) => ({ level: 'warning' as const, text: w.text, file: w.src?.file, pos: w.src?.pos, end: w.src?.end })),
        source,
        opts.file,
      ),
    ];
    return {
      scene,
      messages,
      failed: ev.failed,
      timings: { parseMs: ev.parseMs, evalMs: ev.evalMs, geometryMs, totalMs: performance.now() - t0 },
    };
  }

  private locate(messages: Message[], source: string, mainFile?: string): EngineMessage[] {
    return messages.map((m) => {
      if (m.pos === undefined) return m;
      const text = m.file === undefined || m.file === mainFile ? source : this.contents.get(m.file);
      if (text === undefined) return m;
      const { line, col } = offsetToLineCol(text, m.pos);
      return { ...m, line, col };
    });
  }
}

function containsText(nodes: GeomNode[]): boolean {
  const stack = [...nodes];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'text') return true;
    if ('children' in n) stack.push(...n.children);
  }
  return false;
}

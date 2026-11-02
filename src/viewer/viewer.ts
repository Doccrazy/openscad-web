import type { SceneData } from '../geometry/types';
import { OrbitCamera, Projection, ViewPreset } from './camera';
import { Canvas2DRenderer } from './canvas-renderer';
import { OrbitControls } from './controls';
import { gridParams, prepareScene } from './prepare';
import { DARK_THEME, LIGHT_THEME, ViewerTheme } from './theme';
import { FrameParams, WebGLRenderer } from './webgl-renderer';

export interface ViewerOptions {
  /** 'auto' uses WebGL2 when available and falls back to Canvas 2D. */
  renderer?: 'auto' | 'webgl2' | 'canvas2d';
  theme?: ViewerTheme | 'light' | 'dark';
  showEdges?: boolean;
  showGrid?: boolean;
  showAxes?: boolean;
  projection?: Projection;
  /** Max number of depth-peeling layers for transparency (default 8). */
  peelLayers?: number;
  /** Supersampling for antialiasing; 'auto' = 2x on low-DPI screens (default). */
  supersampling?: number | 'auto';
}

interface Renderer {
  setMeshes(m: ReturnType<typeof prepareScene>): void;
  render(p: FrameParams): void;
  dispose(): void;
}

/**
 * Interactive 3D viewer for {@link SceneData}. Creates its own canvas inside
 * the given container and keeps it sized to the container.
 */
export class Viewer {
  readonly canvas: HTMLCanvasElement;
  readonly camera = new OrbitCamera();
  readonly backend: 'webgl2' | 'canvas2d';
  private renderer: Renderer;
  private controls: OrbitControls;
  private scene: SceneData | null = null;
  private theme: ViewerTheme;
  private opts: Required<Omit<ViewerOptions, 'theme' | 'renderer' | 'projection'>>;
  private raf = 0;
  private interacting = false;
  private resizeObs: ResizeObserver;
  private sceneRadius = 100;
  private disposed = false;
  /** Called after every rendered frame (e.g. to sync UI). */
  onFrame?: () => void;

  constructor(
    private readonly container: HTMLElement,
    options: ViewerOptions = {},
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;outline:none;';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);
    this.theme = resolveTheme(options.theme);
    this.opts = {
      showEdges: options.showEdges ?? true,
      showGrid: options.showGrid ?? true,
      showAxes: options.showAxes ?? true,
      peelLayers: options.peelLayers ?? 8,
      supersampling: options.supersampling ?? 'auto',
    };
    this.camera.projection = options.projection ?? 'perspective';

    const want = options.renderer ?? 'auto';
    let r: Renderer | undefined;
    let backend: 'webgl2' | 'canvas2d' = 'webgl2';
    if (want !== 'canvas2d') {
      try {
        r = new WebGLRenderer(this.canvas);
      } catch (e) {
        if (want === 'webgl2') throw e;
        console.warn('WebGL2 unavailable, falling back to Canvas 2D renderer:', e);
      }
    }
    if (!r) {
      r = new Canvas2DRenderer(this.canvas);
      backend = 'canvas2d';
    }
    this.renderer = r;
    this.backend = backend;

    this.canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.renderer = new WebGLRenderer(this.canvas);
      if (this.scene) this.renderer.setMeshes(prepareScene(this.scene, this.theme));
      this.requestRender();
    });

    this.controls = new OrbitControls(
      this.canvas,
      this.camera,
      (interacting) => {
        this.interacting = interacting;
        this.requestRender();
      },
      () => this.fit(),
    );
    this.resizeObs = new ResizeObserver(() => this.requestRender());
    this.resizeObs.observe(container);
    this.requestRender();
  }

  /** Display a new scene. Set `fit` to frame the camera on it. */
  setScene(scene: SceneData | null, opts: { fit?: boolean } = {}): void {
    this.scene = scene;
    this.renderer.setMeshes(scene ? prepareScene(scene, this.theme) : []);
    const b = scene?.bbox;
    const grid = gridParams(scene);
    this.sceneRadius = Math.max(grid.extent * 1.5, b ? Math.max(Math.hypot(...b.max), Math.hypot(...b.min)) : 100);
    if (opts.fit) this.fit();
    this.requestRender();
  }

  getScene(): SceneData | null {
    return this.scene;
  }

  fit(): void {
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    this.camera.fit(this.scene?.bbox ?? null, aspect);
    this.requestRender();
  }

  setView(preset: ViewPreset): void {
    this.camera.setView(preset);
    this.requestRender();
  }

  setProjection(p: Projection): void {
    this.camera.projection = p;
    this.requestRender();
  }

  setTheme(theme: ViewerTheme | 'light' | 'dark'): void {
    this.theme = resolveTheme(theme);
    if (this.scene) this.renderer.setMeshes(prepareScene(this.scene, this.theme));
    this.requestRender();
  }

  setOptions(o: Partial<Omit<ViewerOptions, 'renderer' | 'theme'>>): void {
    if (o.projection) this.camera.projection = o.projection;
    for (const k of ['showEdges', 'showGrid', 'showAxes', 'peelLayers', 'supersampling'] as const) {
      if (o[k] !== undefined) (this.opts as Record<string, unknown>)[k] = o[k];
    }
    this.requestRender();
  }

  getOptions(): Readonly<typeof this.opts> & { projection: Projection } {
    return { ...this.opts, projection: this.camera.projection };
  }

  requestRender(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private maxSsaa(dpr: number): number {
    const s = this.opts.supersampling;
    if (s === 'auto') return dpr >= 1.75 ? 1 : 2;
    return Math.max(1, s);
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const maxSsaa = this.backend === 'webgl2' ? this.maxSsaa(dpr) : 1;
    const aspect = cw / ch;
    const b = this.scene?.bbox;
    const axesLength = b ? Math.max(...b.max.map(Math.abs), ...b.min.map(Math.abs), 1) * 1.2 : 50;
    this.renderer.render({
      viewProj: this.camera.viewProj(aspect, this.sceneRadius),
      view: this.camera.view(),
      ortho: this.camera.projection === 'orthographic',
      width: cw,
      height: ch,
      ssaa: this.interacting ? 1 : maxSsaa,
      maxSsaa,
      theme: this.theme,
      showEdges: this.opts.showEdges,
      showGrid: this.opts.showGrid,
      showAxes: this.opts.showAxes,
      peelLayers: this.interacting ? Math.min(this.opts.peelLayers, 4) : this.opts.peelLayers,
      grid: gridParams(this.scene),
      axesLength,
    });
    this.onFrame?.();
  }

  /** Render the current view to a PNG blob. */
  screenshot(): Promise<Blob | null> {
    this.draw();
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.controls.dispose();
    this.resizeObs.disconnect();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

function resolveTheme(t: ViewerOptions['theme']): ViewerTheme {
  if (!t || t === 'light') return LIGHT_THEME;
  if (t === 'dark') return DARK_THEME;
  return t;
}

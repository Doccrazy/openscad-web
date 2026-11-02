import type { OrbitCamera } from './camera';

/** Mouse / touch / keyboard interaction for an {@link OrbitCamera}. */
export class OrbitControls {
  private pointers = new Map<number, { x: number; y: number }>();
  private mode: 'orbit' | 'pan' | null = null;
  private lastPinch = 0;
  private lastMid: { x: number; y: number } | null = null;
  enabled = true;

  constructor(
    private readonly el: HTMLElement,
    private readonly camera: OrbitCamera,
    private readonly onChange: (interacting: boolean) => void,
    private readonly onDoubleClick?: () => void,
  ) {
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
    el.addEventListener('wheel', this.wheel, { passive: false });
    el.addEventListener('contextmenu', this.ctx);
    el.addEventListener('dblclick', this.dbl);
    el.style.touchAction = 'none';
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.down);
    this.el.removeEventListener('pointermove', this.move);
    this.el.removeEventListener('pointerup', this.up);
    this.el.removeEventListener('pointercancel', this.up);
    this.el.removeEventListener('wheel', this.wheel);
    this.el.removeEventListener('contextmenu', this.ctx);
    this.el.removeEventListener('dblclick', this.dbl);
  }

  private ctx = (e: Event): void => e.preventDefault();
  private dbl = (): void => this.onDoubleClick?.();

  private down = (e: PointerEvent): void => {
    if (!this.enabled) return;
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.mode = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey ? 'pan' : 'orbit';
    } else {
      this.mode = null;
      this.lastPinch = this.pinchDist();
      this.lastMid = this.mid();
    }
  };

  private pinchDist(): number {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private mid(): { x: number; y: number } {
    const [a, b] = [...this.pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private move = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    const h = this.el.clientHeight || 1;
    if (this.pointers.size >= 2) {
      const d = this.pinchDist();
      if (this.lastPinch > 0 && d > 0) this.camera.zoom(this.lastPinch / d);
      this.lastPinch = d;
      const m = this.mid();
      if (this.lastMid) this.camera.pan((m.x - this.lastMid.x) / h, (m.y - this.lastMid.y) / h);
      this.lastMid = m;
    } else if (this.mode === 'orbit') {
      this.camera.orbit(-dx * 0.4, dy * 0.4);
    } else if (this.mode === 'pan') {
      this.camera.pan(dx / h, dy / h);
    }
    this.onChange(true);
  };

  private up = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.lastMid = null;
    if (this.pointers.size === 0) {
      this.mode = null;
      this.onChange(false);
    }
  };

  private wheelTimer: ReturnType<typeof setTimeout> | undefined;
  private wheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.camera.zoom(Math.exp(delta * 0.0015));
    this.onChange(true);
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => this.onChange(false), 150);
  };
}

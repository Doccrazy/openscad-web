import type { Value } from '../eval/values';
import { valuesEqual } from '../eval/values';
import type { CustomizerParameter } from './customizer';
import { groupParameters } from './customizer';

export interface CustomizerPanelOptions {
  /** Called whenever the user changes a value. Receives only modified values. */
  onChange: (overrides: Record<string, Value>) => void;
}

/**
 * Framework-free DOM component rendering customizer widgets. Styling hooks use
 * `cz-*` class names (see demo/style.css for an example stylesheet).
 */
export class CustomizerPanel {
  private params: CustomizerParameter[] = [];
  private values = new Map<string, Value>();
  private signature = '';
  private openGroups = new Set<string>();

  constructor(
    readonly element: HTMLElement,
    private readonly options: CustomizerPanelOptions,
  ) {}

  /** Current values that differ from the source defaults. */
  get overrides(): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const p of this.params) {
      if (this.values.has(p.name)) out[p.name] = this.values.get(p.name);
    }
    return out;
  }

  /** Update the parameter list (e.g. after the source changed). */
  setParameters(params: CustomizerParameter[]): void {
    const sig = JSON.stringify(params.map((p) => [p.name, p.group, p.description, p.type, p.initial, p.widget]));
    // drop overrides that equal the (new) default or whose parameter disappeared
    for (const [k, v] of [...this.values]) {
      const p = params.find((x) => x.name === k);
      if (!p || valuesEqual(p.initial, v) || p.type !== this.params.find((x) => x.name === k)?.type) this.values.delete(k);
    }
    this.params = params;
    if (sig === this.signature) return;
    this.signature = sig;
    this.render();
  }

  setValues(values: Record<string, Value>): void {
    this.values = new Map(Object.entries(values));
    this.render();
    this.options.onChange(this.overrides);
  }

  reset(): void {
    this.values.clear();
    this.render();
    this.options.onChange(this.overrides);
  }

  private set(p: CustomizerParameter, v: Value, row: HTMLElement): void {
    if (valuesEqual(v, p.initial)) this.values.delete(p.name);
    else this.values.set(p.name, v);
    row.classList.toggle('modified', this.values.has(p.name));
    this.options.onChange(this.overrides);
  }

  private render(): void {
    const el = this.element;
    // remember which groups are open
    for (const d of el.querySelectorAll<HTMLDetailsElement>('details.cz-group')) {
      if (d.open) this.openGroups.add(d.dataset.group!);
      else this.openGroups.delete(d.dataset.group!);
    }
    el.textContent = '';
    if (!this.params.length) {
      const empty = document.createElement('div');
      empty.className = 'cz-empty';
      empty.innerHTML =
        'No parameters. Top-level assignments with literal values become parameters, e.g. <code>width = 10; // [1:100]</code>';
      el.appendChild(empty);
      return;
    }
    const groups = groupParameters(this.params);
    for (const g of groups) {
      const details = document.createElement('details');
      details.className = 'cz-group';
      details.dataset.group = g.name;
      details.open = this.openGroups.size === 0 || this.openGroups.has(g.name) || groups.length === 1;
      const summary = document.createElement('summary');
      summary.textContent = g.name;
      details.appendChild(summary);
      for (const p of g.parameters) details.appendChild(this.renderParam(p));
      el.appendChild(details);
    }
  }

  private renderParam(p: CustomizerParameter): HTMLElement {
    const row = document.createElement('div');
    row.className = 'cz-param';
    if (this.values.has(p.name)) row.classList.add('modified');
    const label = document.createElement('div');
    label.className = 'cz-label';
    const name = document.createElement('span');
    name.className = 'cz-name';
    name.textContent = p.name;
    label.appendChild(name);
    const reset = document.createElement('button');
    reset.className = 'link cz-reset';
    reset.textContent = 'reset';
    reset.title = 'Reset to default';
    label.appendChild(reset);
    row.appendChild(label);
    if (p.description) {
      const d = document.createElement('div');
      d.className = 'cz-desc';
      d.textContent = p.description;
      row.appendChild(d);
    }
    const ctl = document.createElement('div');
    ctl.className = 'cz-control';
    row.appendChild(ctl);
    const value = this.values.has(p.name) ? this.values.get(p.name) : p.initial;
    const id = `cz-${p.name}`;
    const update = (v: Value): void => this.set(p, v, row);
    let resetUi: () => void = () => {};

    const numberInput = (v: number, step: number, min?: number, max?: number, small = false): HTMLInputElement => {
      const i = document.createElement('input');
      i.type = 'number';
      i.value = String(v);
      i.step = String(step);
      if (min !== undefined) i.min = String(min);
      if (max !== undefined) i.max = String(max);
      if (small) i.className = 'small';
      return i;
    };

    const w = p.widget;
    switch (w.kind) {
      case 'slider': {
        const r = document.createElement('input');
        r.type = 'range';
        r.id = id;
        r.min = String(w.min);
        r.max = String(w.max);
        r.step = String(w.step);
        r.value = String(value);
        const n = numberInput(value as number, w.step, undefined, undefined, true);
        r.addEventListener('input', () => {
          n.value = r.value;
          update(Number(r.value));
        });
        n.addEventListener('input', () => {
          if (n.value === '' || Number.isNaN(Number(n.value))) return;
          r.value = n.value;
          update(Number(n.value));
        });
        ctl.append(r, n);
        resetUi = () => { r.value = n.value = String(p.initial); };
        break;
      }
      case 'spinbox': {
        const n = numberInput(value as number, w.step, w.min, w.max);
        n.id = id;
        n.addEventListener('input', () => {
          if (n.value === '' || Number.isNaN(Number(n.value))) return;
          update(Number(n.value));
        });
        ctl.append(n);
        resetUi = () => { n.value = String(p.initial); };
        break;
      }
      case 'checkbox': {
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.id = id;
        c.checked = value === true;
        c.addEventListener('change', () => update(c.checked));
        ctl.append(c);
        resetUi = () => { c.checked = p.initial === true; };
        break;
      }
      case 'text': {
        const t = document.createElement('input');
        t.type = 'text';
        t.id = id;
        t.value = String(value ?? '');
        if (w.maxLength) t.maxLength = w.maxLength;
        t.addEventListener('input', () => update(t.value));
        ctl.append(t);
        resetUi = () => { t.value = String(p.initial ?? ''); };
        break;
      }
      case 'dropdown': {
        const s = document.createElement('select');
        s.id = id;
        w.options.forEach((o, i) => {
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = o.label;
          if (valuesEqual(o.value, value)) opt.selected = true;
          s.appendChild(opt);
        });
        s.addEventListener('change', () => update(w.options[Number(s.value)].value));
        ctl.append(s);
        resetUi = () => {
          const i = w.options.findIndex((o) => valuesEqual(o.value, p.initial));
          s.value = String(Math.max(0, i));
        };
        break;
      }
      case 'vector': {
        const box = document.createElement('div');
        box.className = 'cz-vector';
        box.style.gridTemplateColumns = `repeat(${w.length}, minmax(0, 1fr))`;
        const cur = [...(value as number[])];
        const inputs = cur.map((v, i) => {
          const n = numberInput(v, w.step, w.min, w.max);
          n.addEventListener('input', () => {
            if (n.value === '' || Number.isNaN(Number(n.value))) return;
            cur[i] = Number(n.value);
            update([...cur]);
          });
          box.appendChild(n);
          return n;
        });
        ctl.append(box);
        resetUi = () => {
          (p.initial as number[]).forEach((v, i) => {
            cur[i] = v;
            inputs[i].value = String(v);
          });
        };
        break;
      }
    }
    reset.addEventListener('click', () => {
      resetUi();
      update(p.initial);
    });
    return row;
  }
}

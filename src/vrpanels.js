import * as THREE from 'three';
import { CanvasPanel, roundRect, wrapText } from './text.js';

const C = {
  bg: 'rgba(16,19,28,0.92)',
  card: '#1c2130',
  cardHover: '#28304a',
  active: '#3a4fd6',
  text: '#e6e9ef',
  dim: '#8d97ab',
  accent: '#7fa2ff',
  err: '#ff7b7b',
  border: '#2f3647',
};
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/**
 * Catalog picker shown inside the headset. Hit-testing is done with the uv
 * coordinate of a ray intersection, mapped back to canvas pixels.
 */
export class VRMenu {
  constructor({ catalog, onSelect, onAction }) {
    this.catalog = catalog;
    this.onSelect = onSelect;
    this.onAction = onAction;
    this.perPage = 8;
    this.page = 0;
    this.hoverId = null;
    this.state = { activeId: null, log: false, refresh: 5, dashboard: false };
    this.panel = new CanvasPanel(0.62, 0.92, 1600);
    this.mesh = this.panel.mesh;
    this.mesh.userData.panel = this;
    this.buttons = [];
    this.draw();
  }

  get pages() { return Math.ceil(this.catalog.length / this.perPage); }

  setState(s) {
    Object.assign(this.state, s);
    if (s.activeId) {
      const i = this.catalog.findIndex(e => e.id === s.activeId);
      if (i >= 0) this.page = Math.floor(i / this.perPage);
    }
    this.draw();
  }

  hitTest(uv) {
    const p = this.panel.toPx(uv);
    return this.buttons.find(b => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) || null;
  }

  hover(uv) {
    const b = uv ? this.hitTest(uv) : null;
    const id = b ? b.id : null;
    if (id !== this.hoverId) { this.hoverId = id; this.draw(); }
  }

  click(uv) {
    const b = this.hitTest(uv);
    if (!b) return;
    if (b.entry) this.onSelect(b.entry);
    else if (b.id === 'prev') { this.page = (this.page - 1 + this.pages) % this.pages; this.draw(); }
    else if (b.id === 'next') { this.page = (this.page + 1) % this.pages; this.draw(); }
    else this.onAction(b.id);
  }

  draw() {
    this.panel.redraw((ctx, w, h) => {
      this.buttons = [];
      ctx.fillStyle = C.bg;
      roundRect(ctx, 0, 0, w, h, 36);
      ctx.fill();
      ctx.strokeStyle = C.border;
      ctx.lineWidth = 3;
      ctx.stroke();

      const pad = 36;
      ctx.fillStyle = C.text;
      ctx.font = `700 52px ${SANS}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('vmxr', pad, 84);
      ctx.fillStyle = C.dim;
      ctx.font = `400 28px ${SANS}`;
      ctx.fillText('VictoriaMetrics playground catalog', pad + 140, 82);

      const top = 120;
      const rowH = 104;
      const gap = 10;
      const items = this.catalog.slice(this.page * this.perPage, (this.page + 1) * this.perPage);
      items.forEach((e, i) => {
        const y = top + i * (rowH + gap);
        const b = { id: e.id, entry: e, x: pad, y, w: w - pad * 2, h: rowH };
        this.buttons.push(b);
        const active = e.id === this.state.activeId;
        ctx.fillStyle = active ? C.active : this.hoverId === e.id ? C.cardHover : C.card;
        roundRect(ctx, b.x, b.y, b.w, b.h, 18);
        ctx.fill();
        ctx.fillStyle = active ? '#cdd7ff' : C.accent;
        ctx.font = `600 24px ${SANS}`;
        ctx.fillText(`${e.group.toUpperCase()} · ${e.viz}`, b.x + 24, y + 36);
        ctx.fillStyle = C.text;
        ctx.font = `600 34px ${SANS}`;
        ctx.fillText(clip(ctx, e.title, b.w - 48), b.x + 24, y + 80);
      });

      // footer: pager + actions
      const fy = h - 290;
      const bw = (w - pad * 2 - 20) / 3;
      const btn = (id, label, x, y, bwidth, on = false) => {
        const b = { id, x, y, w: bwidth, h: 74 };
        this.buttons.push(b);
        ctx.fillStyle = on ? C.active : this.hoverId === id ? C.cardHover : C.card;
        roundRect(ctx, x, y, bwidth, 74, 16);
        ctx.fill();
        ctx.fillStyle = C.text;
        ctx.font = `600 30px ${SANS}`;
        ctx.textAlign = 'center';
        ctx.fillText(label, x + bwidth / 2, y + 48);
        ctx.textAlign = 'left';
      };
      btn('prev', '◀  Prev', pad, fy, bw);
      ctx.fillStyle = C.dim;
      ctx.font = `500 30px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText(`${this.page + 1} / ${this.pages}`, pad + bw * 1.5 + 10, fy + 48);
      ctx.textAlign = 'left';
      btn('next', 'Next  ▶', pad + bw * 2 + 20, fy, bw);

      const ay = fy + 90;
      btn('refresh', '⟳ Refresh', pad, ay, bw);
      btn('log', `Log: ${this.state.log ? 'on' : 'off'}`, pad + bw + 10, ay, bw, this.state.log);
      btn('auto', `Auto: ${this.state.refresh ? this.state.refresh + 's' : 'off'}`, pad + bw * 2 + 20, ay, bw, !!this.state.refresh);
      btn('dashboard', this.state.dashboard ? '▦  Dashboard: on — back to single view' : '▦  Dashboard: show every plot around me',
        pad, ay + 90, w - pad * 2, this.state.dashboard);
    });
  }
}

/** Title / query / status board floating behind the plot. */
export class InfoBoard {
  constructor() {
    this.panel = new CanvasPanel(1.6, 0.3, 1000);
    this.mesh = this.panel.mesh;
    this.set({ title: '', query: '', status: '' });
  }

  set({ title, query, status, error = false }) {
    this.panel.redraw((ctx, w, h) => {
      ctx.fillStyle = 'rgba(16,19,28,0.82)';
      roundRect(ctx, 0, 0, w, h, 28);
      ctx.fill();
      const pad = 34;
      ctx.fillStyle = C.text;
      ctx.font = `700 44px ${SANS}`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(clip(ctx, title || 'Custom query', w - pad * 2), pad, 66);
      ctx.fillStyle = '#b8c4ff';
      ctx.font = `400 26px ${MONO}`;
      wrapText(ctx, query || '', w - pad * 2).slice(0, 4).forEach((l, i) => ctx.fillText(l, pad, 112 + i * 34));
      ctx.fillStyle = error ? C.err : C.dim;
      ctx.font = `500 26px ${SANS}`;
      ctx.fillText(clip(ctx, status || '', w - pad * 2), pad, h - 26);
    });
  }
}

/** Floating value read-out used while hovering with a controller. */
export class Tooltip3D {
  constructor() {
    this.panel = new CanvasPanel(0.34, 0.14, 1600);
    this.mesh = this.panel.mesh;
    this.mesh.visible = false;
    this.mesh.renderOrder = 20;
    this.mesh.material.depthTest = false;
    this.key = '';
  }

  show(info, worldPos, cameraPos) {
    const key = info.title + '|' + info.lines.join('|');
    if (key !== this.key) {
      this.key = key;
      this.panel.redraw((ctx, w, h) => {
        ctx.fillStyle = 'rgba(10,12,18,0.94)';
        roundRect(ctx, 0, 0, w, h, 24);
        ctx.fill();
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = C.text;
        ctx.font = `700 46px ${SANS}`;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(info.title, 26, 58);
        ctx.fillStyle = C.dim;
        ctx.font = `400 26px ${SANS}`;
        info.lines.slice(0, 4).forEach((l, i) => ctx.fillText(clip(ctx, l, w - 52), 26, 100 + i * 32));
      });
    }
    this.mesh.position.copy(worldPos).add(new THREE.Vector3(0, 0.1, 0));
    this.mesh.lookAt(cameraPos);
    this.mesh.visible = true;
  }

  hide() { this.mesh.visible = false; }
}

function clip(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

// DOM side panel: catalog, query editor, options. Holds no rendering logic.

import { PLAYGROUND_URL } from './catalog.js';
import { isMultiViz, VIZ_MODE, AXES, entryToState } from './fetch.js';

const $ = id => document.getElementById(id);
export const DEFAULT_REFRESH = 5; // seconds; 0 = off
const QUERY_IDS = { x: 'query', y: 'queryY', z: 'queryZ' };

const VIZ_HINTS = {
  surface: 'Floor = time × an ordered label: histogram buckets (vmrange / le) or quantiles (phi). Avoid instance/job rows — use quantiles() across them instead.',
  ribbons: 'One lane per series, laid out in depth. Works best when lanes are ordered (quantiles, buckets).',
  calendar: 'One signal, sampled hourly over N days, folded into day × hour of day. Use a 1h window, e.g. sum(rate(metric[1h])).',
  scatter: 'Three instant queries aggregated by the same labels, e.g. … by (job). Every matching series becomes a point at (X, Y, Z).',
  trails: 'Like scatter but over time: each entity draws its path through X × Y × Z, fading into the past.',
  radial: 'A ranking: one pillar per series, largest in front.',
  bars: 'A cross-tab of two labels. Keep both small; prefer ordered shapes when you can.',
};

export class UI {
  constructor({ catalog, onRun, onXR, onRefreshChange, onPick, onDashboard, onOverview }) {
    this.catalog = catalog;
    this.onRun = onRun;
    this.onPick = onPick;
    this.onXR = onXR;
    this.onRefreshChange = onRefreshChange;
    this.activeId = null;
    this.title = '';
    this.axesMeta = null; // labels / units / log flags of a catalog scatter or trails entry
    this.labels = [];

    this.renderCatalog();

    $('run').addEventListener('click', () => this.run());
    for (const id of Object.values(QUERY_IDS)) {
      $(id).addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.run(); }
      });
      $(id).addEventListener('input', () => this.detachFromCatalog());
    }
    // Changing shape/options re-renders immediately.
    for (const id of ['viz', 'range', 'days', 'x', 'z', 'sortBy', 'colorBy', 'unit', 'log']) {
      $(id).addEventListener('change', () => {
        if (id === 'viz') this.detachFromCatalog(); // a different shape is a different view
        this.syncVisibility();
        this.run();
      });
    }
    $('refresh').addEventListener('change', () => this.onRefreshChange(Number($('refresh').value)));
    $('enter-vr').addEventListener('click', () => this.onXR('immersive-vr'));
    $('enter-ar').addEventListener('click', () => this.onXR('immersive-ar'));
    $('panel-toggle').addEventListener('click', () => document.body.classList.toggle('panel-hidden'));
    $('dash-toggle').addEventListener('click', () => onDashboard?.());
    $('dash-overview').addEventListener('click', () => onOverview?.());
    $('share').addEventListener('click', async () => {
      const url = location.href.split('#')[0] + '#' + this.toHash();
      history.replaceState(null, '', url);
      try { await navigator.clipboard.writeText(url); this.setStatus('Link copied to clipboard', 'ok'); }
      catch { this.setStatus('Link is in the address bar', 'ok'); }
    });
  }

  detachFromCatalog() {
    if (!this.activeId) return;
    this.activeId = null;
    this.title = '';
    this.axesMeta = null;
    this.markActive();
    this.syncVisibility();
  }

  renderCatalog() {
    const root = $('catalog');
    root.textContent = '';
    const groups = new Map();
    for (const e of this.catalog) {
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group).push(e);
    }
    for (const [name, entries] of groups) {
      const g = document.createElement('div');
      g.className = 'cat-group';
      const t = document.createElement('div');
      t.className = 'cat-group-title';
      t.textContent = name;
      g.append(t);
      for (const e of entries) {
        const b = document.createElement('button');
        b.className = 'cat-item';
        b.dataset.id = e.id;
        b.title = e.description;
        const v = document.createElement('span');
        v.className = 'v';
        v.textContent = e.viz;
        const tt = document.createElement('span');
        tt.className = 't';
        tt.textContent = e.title;
        b.append(v, tt);
        b.addEventListener('click', () => (this.onPick ? this.onPick(e) : this.loadEntry(e)));
        g.append(b);
      }
      root.append(g);
    }
  }

  loadEntry(e, { run = true } = {}) {
    this.activeId = e.id;
    this.title = e.title;
    this.axesMeta = e.axes || null;
    const st = entryToState(e);
    this.setState({ ...st, query: st.queries.x, queryY: st.queries.y, queryZ: st.queries.z });
    this.markActive();
    if (run) this.run();
  }

  markActive() {
    for (const b of document.querySelectorAll('.cat-item')) b.classList.toggle('active', b.dataset.id === this.activeId);
    document.querySelector('.cat-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  setState(s) {
    for (const [k, id] of Object.entries({ query: 'query', queryY: 'queryY', queryZ: 'queryZ' })) {
      if (s[k] !== undefined) $(id).value = s[k];
    }
    if (s.viz) $('viz').value = s.viz;
    if (s.range) ensureOption($('range'), s.range, `${Math.round(s.range / 60)} minutes`);
    if (s.days) ensureOption($('days'), s.days, `${s.days} days`);
    if (s.log !== undefined) $('log').checked = s.log;
    if (s.unit) $('unit').value = s.unit;
    if (s.endpoint) $('endpoint').value = s.endpoint;
    if (s.refresh !== undefined) $('refresh').value = String(s.refresh);
    for (const k of ['x', 'z', 'sortBy', 'colorBy']) if (s[k]) this.setLabelSelect(k, s[k]);
    this.syncVisibility();
  }

  getState() {
    const viz = $('viz').value;
    const queries = Object.fromEntries(AXES.map(k => [k, $(QUERY_IDS[k]).value.trim()]));
    return {
      id: this.activeId,
      title: this.title,
      viz,
      query: queries.x,
      queries,
      axesMeta: this.axesMeta,
      range: Number($('range').value),
      days: Number($('days').value),
      log: $('log').checked,
      x: $('x').value || 'auto',
      z: $('z').value || 'auto',
      sortBy: $('sortBy').value || 'auto',
      colorBy: $('colorBy').value || 'auto',
      unit: $('unit').value,
      endpoint: $('endpoint').value.trim(),
      refresh: Number($('refresh').value),
    };
  }

  isRangeViz(viz = $('viz').value) { return VIZ_MODE[viz] === 'range'; }

  syncVisibility() {
    const viz = $('viz').value;
    for (const el of document.querySelectorAll('[data-viz]')) el.hidden = !el.dataset.viz.split(' ').includes(viz);
    $('query-title').textContent = isMultiViz(viz) ? 'Queries — X, Y (height), Z' : 'Query';
    const entry = this.activeId && this.catalog.find(e => e.id === this.activeId);
    $('viz-hint').textContent = entry ? entry.description : VIZ_HINTS[viz] || '';
  }

  /** Fill the label pickers with labels seen in the latest result. */
  setLabels(labels) {
    this.labels = labels;
    for (const k of ['x', 'z', 'sortBy', 'colorBy']) {
      const v = $(k).value;
      this.setLabelSelect(k, labels.includes(v) ? v : 'auto');
    }
  }

  setLabelSelect(id, value) {
    const sel = $(id);
    const opts = ['auto', ...this.labels];
    if (value && !opts.includes(value)) opts.push(value);
    sel.textContent = '';
    for (const o of opts) sel.add(new Option(o, o));
    sel.value = value || 'auto';
  }

  setDashboard(active) {
    this.dashboardActive = active;
    $('dash-toggle').classList.toggle('on', active);
    $('dash-toggle').textContent = active ? '◱ Back to single view' : '▦ Dashboard';
    $('dash-overview').hidden = !active;
  }

  setStatus(text, kind = '') {
    const el = $('status');
    el.textContent = text;
    el.className = 'status ' + kind;
  }

  /** reason: null when VR works, else an HTML-free explanation shown under the buttons. */
  setXRSupport({ vr, ar, reason = null, note = null }) {
    $('enter-vr').disabled = !vr;
    $('enter-ar').disabled = !ar;
    $('enter-vr').title = vr ? '' : reason || 'WebXR VR not available';
    $('enter-ar').title = ar ? '' : 'WebXR AR (passthrough) not available on this device';
    const el = $('xr-reason');
    el.hidden = !reason && !note;
    el.textContent = reason ? `VR unavailable: ${reason}` : note || '';
  }

  setXRActive(active) {
    $('enter-vr').textContent = active ? 'Exit XR' : 'Enter VR';
    $('enter-vr').disabled = false;
  }

  run() { this.onRun(this.getState()); }

  toHash() {
    const s = this.getState();
    const p = new URLSearchParams();
    if (this.dashboardActive) p.set('dashboard', '1');
    if (s.id) p.set('id', s.id);
    else {
      p.set('viz', s.viz);
      p.set('q', s.queries.x);
      if (isMultiViz(s.viz)) { p.set('qy', s.queries.y); p.set('qz', s.queries.z); }
      if (['surface', 'ribbons', 'trails'].includes(s.viz)) p.set('range', s.range);
      if (s.viz === 'calendar') p.set('days', s.days);
      if (s.log) p.set('log', '1');
      for (const k of ['x', 'z', 'sortBy', 'colorBy', 'unit']) if (s[k] && s[k] !== 'auto') p.set(k, s[k]);
    }
    if (s.endpoint && s.endpoint !== PLAYGROUND_URL) p.set('endpoint', s.endpoint);
    if (s.refresh !== DEFAULT_REFRESH) p.set('refresh', s.refresh);
    return p.toString();
  }

  /** Restore state from location.hash. Returns true if anything was loaded. */
  fromHash(defaultEndpoint) {
    const p = new URLSearchParams(location.hash.slice(1));
    this.setState({ endpoint: p.get('endpoint') || defaultEndpoint, refresh: Number(p.get('refresh') ?? DEFAULT_REFRESH) });
    const entry = p.get('id') && this.catalog.find(e => e.id === p.get('id'));
    if (entry) { this.loadEntry(entry, { run: false }); return true; }
    if (p.get('q')) {
      this.setState({
        query: p.get('q'), queryY: p.get('qy') || '', queryZ: p.get('qz') || '',
        viz: p.get('viz') || 'surface', range: Number(p.get('range') || 3600), days: Number(p.get('days') || 14),
        log: p.get('log') === '1', x: p.get('x') || 'auto', z: p.get('z') || 'auto',
        sortBy: p.get('sortBy') || 'auto', colorBy: p.get('colorBy') || 'auto', unit: p.get('unit') || 'auto',
      });
      return true;
    }
    return false;
  }
}

function ensureOption(sel, value, label) {
  if (![...sel.options].some(o => o.value === String(value))) sel.add(new Option(label, String(value)));
  sel.value = String(value);
}

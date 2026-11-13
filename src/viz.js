import * as THREE from 'three';
import { makeLabel, makeFlatLabel } from './text.js';
import { formatValue, formatTime, formatTick } from './format.js';
import {
  varyingLabels, seriesName, compareLabelValues, isHistogramLabel, isOrderedLabel, prettyBucket,
} from './prom.js';

// Plot footprint in metres. The whole plot sits on a "table" in front of you.
const W = 1.6;   // x extent
const D = 1.1;   // z extent
const H = 0.7;   // max height

// ── colour helpers ────────────────────────────────────────────────────────

// Sequential ramp (dark indigo → teal → yellow), readable on dark backgrounds.
const RAMP = ['#3b2f80', '#2f5fb3', '#1f8fb0', '#25b38f', '#7fcf5a', '#f2e24b'].map(c => new THREE.Color(c));
export function rampColor(t, out = new THREE.Color()) {
  t = Math.min(1, Math.max(0, t || 0));
  const f = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(f));
  return out.copy(RAMP[i]).lerp(RAMP[i + 1], f - i);
}

const CATEGORICAL = [
  '#4e9cf5', '#f5a524', '#3ecf8e', '#f2555a', '#b07cf7', '#2fc6d6',
  '#f37ac4', '#c3d64a', '#ff8a4c', '#8f9cff', '#5ad1a8', '#e8c547',
].map(c => new THREE.Color(c));
const catColor = i => CATEGORICAL[i % CATEGORICAL.length];

// ── scaling ───────────────────────────────────────────────────────────────

// zero: anchor linear scales at 0 (honest for heights). Scatter axes pass
// zero:false so they span the data extent and small differences stay visible.
function makeScale(values, log, { zero = true } = {}) {
  let min = Infinity, max = -Infinity, minPos = Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    if (v > 0 && v < minPos) minPos = v;
  }
  if (!Number.isFinite(min)) { min = 0; max = 1; }

  if (log && Number.isFinite(minPos) && max > 0) {
    const hi = Math.log10(max);
    let lo = Math.log10(minPos);
    if (hi - lo < 1e-9) lo = hi - 1;
    lo -= (hi - lo) * 0.08; // so the smallest value is still visible
    return {
      log: true, min: minPos, max,
      t: v => (Number.isFinite(v) && v > 0 ? Math.max(0, (Math.log10(v) - lo) / (hi - lo)) : 0),
      inv: t => 10 ** (lo + t * (hi - lo)),
    };
  }
  let lo, hi;
  if (zero) {
    lo = Math.min(0, min);
    hi = Math.max(0, max);
  } else {
    const pad = (max - min) * 0.06 || Math.abs(max) * 0.05 || 1;
    lo = min - pad;
    hi = max + pad;
    if (min >= 0 && lo < 0) lo = 0;
  }
  if (hi - lo < 1e-12) hi = lo + 1;
  return {
    log: false, min: lo, max: hi,
    t: v => (Number.isFinite(v) ? (v - lo) / (hi - lo) : 0),
    inv: t => lo + t * (hi - lo),
  };
}

// ── shared scaffolding ────────────────────────────────────────────────────

function baseScaffold(group, { width = W, depth = D } = {}) {
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.12, 0.012, depth + 0.12),
    new THREE.MeshStandardMaterial({ color: 0x161a24, roughness: 0.9, metalness: 0.1 }),
  );
  plate.position.y = -0.007;
  group.add(plate);

  const grid = new THREE.GridHelper(Math.max(width, depth), 10, 0x2c3344, 0x232836);
  grid.scale.set(width / Math.max(width, depth), 1, depth / Math.max(width, depth));
  grid.position.y = 0.0005;
  group.add(grid);
}

function valueAxis(group, scale, unit, { x = -W / 2 - 0.06, z = -D / 2 - 0.06, height = H } = {}) {
  const pts = [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, height, z)];
  const ticks = 4;
  const lineMat = new THREE.LineBasicMaterial({ color: 0x5a6378 });
  for (let i = 0; i <= ticks; i++) {
    const y = (i / ticks) * height;
    pts.push(new THREE.Vector3(x, y, z), new THREE.Vector3(x + 0.025, y, z));
    const lbl = makeLabel(formatValue(scale.inv(i / ticks), unit), { height: 0.034, color: '#aeb7c9' });
    lbl.center.set(1, 0.5);
    lbl.position.set(x - 0.015, y, z);
    group.add(lbl);
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  // first two points form the axis, rest are tick pairs
  const idx = [0, 1];
  for (let i = 2; i < pts.length; i += 2) idx.push(i, i + 1);
  geo.setIndex(idx);
  group.add(new THREE.LineSegments(geo, lineMat));
  if (scale.log) {
    const l = makeLabel('log', { height: 0.022, color: '#6f7a90' });
    l.position.set(x, height + 0.04, z);
    group.add(l);
  }
}

function axisTitle(group, text, pos) {
  const l = makeLabel(text, { height: 0.034, color: '#c9d1e0' });
  l.position.copy(pos);
  group.add(l);
}

/** pick up to `max` evenly spaced indices from 0..n-1 */
function labelIndices(n, max) {
  if (n <= max) return [...Array(n).keys()];
  const step = Math.ceil(n / max);
  const out = [];
  for (let i = 0; i < n; i += step) out.push(i);
  return out;
}

function disposeTree(obj) {
  obj.traverse(o => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { m.map?.dispose(); m.dispose(); }
  });
}

// ── public entry point ────────────────────────────────────────────────────

/**
 * Build a 3D object for a query result.
 * Returns { group, pickables, pick(hit) -> {title, lines, point}, info, dispose }
 */
export function buildViz(data, spec) {
  const builder = {
    bars: buildBars, radial: buildRadial, surface: buildSurface, ribbons: buildRibbons,
    calendar: buildCalendar, scatter: buildScatter, trails: buildTrails,
  }[spec.viz];
  if (!builder) throw new Error(`Unknown visualisation: ${spec.viz}`);
  if (!data.entities && !data.series.length) throw new Error('Query returned no series');
  const out = builder(data, spec);
  out.dispose = () => disposeTree(out.group);
  return out;
}

// ── bars: 2-D grid of towers (label X × label Z) ──────────────────────────

function buildBars(data, spec) {
  const group = new THREE.Group();
  const keys = varyingLabels(data.series);
  // Ignore requested labels that the result doesn't have (e.g. left over from a previous query).
  const has = k => k && k !== 'auto' && data.series.some(s => k in s.labels);
  let xKey = has(spec.x) ? spec.x : null;
  let zKey = has(spec.z) && spec.z !== xKey ? spec.z : null;
  if (!xKey) xKey = keys.find(k => k !== zKey) || null;
  if (!zKey) zKey = keys.find(k => k !== xKey) || null;

  const cmp = (key) => (a, b) => compareLabelValues(key, a, b);
  const xs = [...new Set(data.series.map(s => s.labels[xKey] ?? '∅'))].sort(xKey ? cmp(xKey) : undefined);
  const zs = [...new Set(data.series.map(s => s.labels[zKey] ?? '∅'))].sort(zKey ? cmp(zKey) : undefined);

  // Several series may land in one cell if the query has more labels than X/Z.
  const cells = new Map();
  for (const s of data.series) {
    const xi = xs.indexOf(s.labels[xKey] ?? '∅');
    const zi = zs.indexOf(s.labels[zKey] ?? '∅');
    const k = xi + ':' + zi;
    if (!cells.has(k)) cells.set(k, { xi, zi, value: 0, series: [] });
    const c = cells.get(k);
    if (Number.isFinite(s.value)) c.value += s.value;
    c.series.push(s);
  }
  const items = [...cells.values()];
  const scale = makeScale(items.map(c => c.value), spec.log);

  const cw = W / xs.length;
  const cd = D / zs.length;
  const fw = Math.min(cw * 0.72, 0.12);
  const fd = Math.min(cd * 0.72, 0.12);

  baseScaffold(group);
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.15 });
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  items.forEach((c, i) => {
    const t = scale.t(c.value);
    const h = Math.max(0.003, t * H);
    c.top = new THREE.Vector3(-W / 2 + (c.xi + 0.5) * cw, h, -D / 2 + (c.zi + 0.5) * cd);
    m.compose(new THREE.Vector3(c.top.x, 0, c.top.z), new THREE.Quaternion(), new THREE.Vector3(fw, h, fd));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, rampColor(0.08 + t * 0.92, col));
  });
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);

  // axis labels
  const maxLabels = 28;
  for (const i of labelIndices(xs.length, maxLabels)) {
    // lies flat on the table in front, slanted like rotated tick labels
    const l = makeFlatLabel(prettyBucket(xKey, xs[i]), {
      height: Math.min(0.03, cw * 0.55), maxChars: 26, angle: -Math.PI / 4,
    });
    l.position.set(-W / 2 + (i + 0.5) * cw - 0.01, 0.002, D / 2 + 0.07);
    group.add(l);
  }
  for (const i of labelIndices(zs.length, maxLabels)) {
    const l = makeLabel(prettyBucket(zKey, zs[i]), { height: 0.028, color: '#aeb7c9', maxChars: 34 });
    l.center.set(0, 0.5);
    l.position.set(W / 2 + 0.06, 0.005, -D / 2 + (i + 0.5) * cd);
    group.add(l);
  }
  if (xKey) axisTitle(group, xKey, new THREE.Vector3(-W / 2 - 0.12, 0.01, D / 2 + 0.1));
  if (zKey) axisTitle(group, zKey, new THREE.Vector3(W / 2 + 0.12, 0.08, -D / 2 - 0.08));
  valueAxis(group, scale, spec.unit);

  return {
    group,
    pickables: [mesh],
    info: { xKey, zKey, labels: keys, count: items.length },
    pick(hit) {
      if (hit.object !== mesh || hit.instanceId === undefined) return null;
      const c = items[hit.instanceId];
      const lines = [
        `${xKey ?? 'x'} = ${prettyBucket(xKey, xs[c.xi])}`,
        `${zKey ?? 'z'} = ${prettyBucket(zKey, zs[c.zi])}`,
      ];
      if (c.series.length > 1) lines.push(`(${c.series.length} series summed)`);
      return { title: formatValue(c.value, spec.unit), lines, point: c.top.clone() };
    },
  };
}

// ── radial: ring of pillars, one per series ───────────────────────────────

function buildRadial(data, spec) {
  const group = new THREE.Group();
  const keys = varyingLabels(data.series);
  const items = data.series.map(s => ({ s, name: seriesName(s.labels, keys), value: s.value }));
  // Largest first, going around clockwise from the front: reads as a ranking.
  items.sort((a, b) => (b.value || 0) - (a.value || 0) || compareLabelValues('', a.name, b.name));
  const n = items.length;
  const scale = makeScale(items.map(i => i.value), spec.log);

  const R = THREE.MathUtils.clamp(0.3 + n * 0.01, 0.45, 0.8);
  const r = Math.min(0.045, ((Math.PI * R) / n) * 0.55);
  const Hr = H * 1.15;

  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(R + 0.18, R + 0.18, 0.012, 96),
    new THREE.MeshStandardMaterial({ color: 0x161a24, roughness: 0.9 }),
  );
  disc.position.y = -0.007;
  group.add(disc);
  const ringGeo = new THREE.RingGeometry(R - 0.002, R + 0.002, 128);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x2c3344 }));
  ring.position.y = 0.001;
  group.add(ring);

  const geo = new THREE.CylinderGeometry(1, 1, 1, 20);
  geo.translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 }), n);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  const showValues = n <= 24;
  items.forEach((it, i) => {
    // start at the front (towards +z, the viewer) and go around
    const a = Math.PI / 2 + (i / n) * Math.PI * 2;
    const x = Math.cos(a) * R;
    const z = Math.sin(a) * R;
    const t = scale.t(it.value);
    const h = Math.max(0.003, t * Hr);
    it.top = new THREE.Vector3(x, h, z);
    m.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(r, h, r));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, rampColor(0.08 + t * 0.92, col));

    if (n <= 64) {
      const l = makeLabel(it.name, { height: n > 30 ? 0.02 : 0.026, color: '#aeb7c9', maxChars: 30 });
      l.position.set(Math.cos(a) * (R + 0.1), 0.015, Math.sin(a) * (R + 0.1));
      group.add(l);
    }
    if (showValues) {
      const v = makeLabel(formatValue(it.value, spec.unit), { height: 0.024, color: '#f2f4f8' });
      v.position.set(x, h + 0.03, z);
      group.add(v);
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  if (!showValues) valueAxis(group, scale, spec.unit, { x: 0, z: 0, height: Hr });

  return {
    group,
    pickables: [mesh],
    info: { labels: keys, count: n },
    pick(hit) {
      if (hit.object !== mesh || hit.instanceId === undefined) return null;
      const it = items[hit.instanceId];
      return { title: formatValue(it.value, spec.unit), lines: labelLines(it.s.labels, keys), point: it.top.clone() };
    },
  };
}

function labelLines(labels, keys) {
  const ks = keys.length ? keys : Object.keys(labels);
  return ks.slice(0, 6).map(k => `${k} = ${labels[k] ?? '∅'}`);
}

// ── range helpers ─────────────────────────────────────────────────────────

function orderedSeries(data, spec, { dropZeroHistogramRows }) {
  const keys = varyingLabels(data.series);
  const wanted = spec.sortBy && spec.sortBy !== 'auto' && data.series.some(s => spec.sortBy in s.labels);
  const sortKey = wanted ? spec.sortBy : keys[0];
  let series = [...data.series];
  series.sort((a, b) => compareLabelValues(sortKey, a.labels[sortKey], b.labels[sortKey])
    || compareLabelValues('', seriesName(a.labels, keys), seriesName(b.labels, keys)));
  if (dropZeroHistogramRows && isHistogramLabel(sortKey)) {
    // Histograms have many empty buckets — trim them so the heatmap is dense.
    const nonZero = s => s.values.some(v => Number.isFinite(v) && v !== 0);
    const first = series.findIndex(nonZero);
    const last = series.findLastIndex(nonZero);
    if (first >= 0) series = series.slice(first, last + 1);
  }
  const names = series.map(s => (isOrderedLabel(sortKey) && keys.length <= 1)
    ? prettyBucket(sortKey, s.labels[sortKey])
    : seriesName(s.labels, keys));
  return { series, names, keys, sortKey };
}

function timeAxis(group, times, z) {
  const n = times.length;
  for (const i of labelIndices(n, 6)) {
    const l = makeLabel(formatTime(times[i]), { height: 0.024, color: '#aeb7c9' });
    l.position.set(-W / 2 + (n > 1 ? i / (n - 1) : 0.5) * W, 0.005, z);
    group.add(l);
  }
  axisTitle(group, 'time →', new THREE.Vector3(0, -0.02, z + 0.07));
}

function nearestVertex(hit, posAttr) {
  const { a, b, c } = hit.face;
  const local = hit.object.worldToLocal(hit.point.clone());
  let best = a, bestD = Infinity;
  const v = new THREE.Vector3();
  for (const idx of [a, b, c]) {
    v.fromBufferAttribute(posAttr, idx);
    const d = v.distanceToSquared(local);
    if (d < bestD) { bestD = d; best = idx; }
  }
  return best;
}

// ── surface: time × series → height (great for histogram heatmaps) ────────

function buildSurface(data, spec) {
  const group = new THREE.Group();
  const { series, names, sortKey } = orderedSeries(data, spec, { dropZeroHistogramRows: true });
  const times = data.times;
  const cols = times.length;
  let rows = series.length;
  const scale = makeScale(series.flatMap(s => [...s.values]), spec.log);

  // a single series still gets some depth
  const rowSeries = rows === 1 ? [series[0], series[0]] : series;
  rows = rowSeries.length;

  const pos = new Float32Array(cols * rows * 3);
  const colors = new Float32Array(cols * rows * 3);
  const col = new THREE.Color();
  for (let j = 0; j < rows; j++) {
    const z = D / 2 - (rows > 1 ? j / (rows - 1) : 0.5) * D;
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const t = scale.t(rowSeries[j].values[i]);
      pos[k * 3] = -W / 2 + (cols > 1 ? i / (cols - 1) : 0.5) * W;
      pos[k * 3 + 1] = Math.max(0.001, t * H);
      pos[k * 3 + 2] = z;
      rampColor(Number.isFinite(rowSeries[j].values[i]) ? t : 0, col);
      colors[k * 3] = col.r; colors[k * 3 + 1] = col.g; colors[k * 3 + 2] = col.b;
    }
  }
  const index = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();

  baseScaffold(group);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.05,
  }));
  group.add(mesh);
  const wire = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0x000000, wireframe: true, transparent: true, opacity: 0.12,
  }));
  group.add(wire);

  timeAxis(group, times, D / 2 + 0.06);
  for (const j of labelIndices(series.length, 18)) {
    const l = makeLabel(names[j], { height: 0.022, color: '#aeb7c9', maxChars: 34 });
    l.center.set(0, 0.5);
    const z = D / 2 - (series.length > 1 ? j / (series.length - 1) : 0.5) * D;
    l.position.set(W / 2 + 0.05, 0.005, z);
    group.add(l);
  }
  if (sortKey) axisTitle(group, `${sortKey}: low (front) → high (back)`, new THREE.Vector3(W / 2 + 0.12, 0.08, -D / 2 - 0.08));
  valueAxis(group, scale, spec.unit);

  const posAttr = geo.getAttribute('position');
  return {
    group,
    pickables: [mesh],
    info: { labels: varyingLabels(data.series), count: series.length },
    pick(hit) {
      if (hit.object !== mesh) return null;
      const v = nearestVertex(hit, posAttr);
      const j = Math.min(series.length - 1, Math.floor(v / cols));
      const i = v % cols;
      return {
        title: formatValue(series[j].values[i], spec.unit),
        lines: [names[j], formatTime(times[i])],
        point: new THREE.Vector3().fromBufferAttribute(posAttr, v),
      };
    },
  };
}

// ── ribbons: one translucent wall per series, laid out in depth ───────────

function buildRibbons(data, spec) {
  const group = new THREE.Group();
  const { series, names } = orderedSeries(data, spec, { dropZeroHistogramRows: true });
  const times = data.times;
  const cols = times.length;
  const rows = series.length;
  const scale = makeScale(series.flatMap(s => [...s.values]), spec.log);
  baseScaffold(group);

  const meshes = [];
  series.forEach((s, j) => {
    const z = D / 2 - (rows > 1 ? j / (rows - 1) : 0.5) * D;
    const pos = new Float32Array(cols * 2 * 3);
    const linePts = [];
    for (let i = 0; i < cols; i++) {
      const x = -W / 2 + (cols > 1 ? i / (cols - 1) : 0.5) * W;
      const y = Math.max(0.001, scale.t(s.values[i]) * H);
      pos.set([x, 0, z, x, y, z], i * 6);
      linePts.push(new THREE.Vector3(x, y, z));
    }
    const idx = [];
    for (let i = 0; i < cols - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const color = catColor(j);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false, roughness: 0.7,
    }));
    mesh.userData.series = j;
    mesh.renderOrder = 1;
    group.add(mesh);
    meshes.push(mesh);

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(linePts),
      new THREE.LineBasicMaterial({ color: color.clone().offsetHSL(0, 0, 0.12) }),
    );
    group.add(line);

    const l = makeLabel(names[j], { height: 0.024, color: '#' + color.getHexString(), maxChars: 34 });
    l.center.set(0, 0.5);
    l.position.set(W / 2 + 0.05, 0.02, z);
    group.add(l);
  });

  timeAxis(group, times, D / 2 + 0.06);
  valueAxis(group, scale, spec.unit);

  return {
    group,
    pickables: meshes,
    info: { labels: varyingLabels(data.series), count: rows },
    pick(hit) {
      const j = hit.object.userData.series;
      if (j === undefined) return null;
      const posAttr = hit.object.geometry.getAttribute('position');
      const v = nearestVertex(hit, posAttr);
      const i = Math.floor(v / 2);
      const top = new THREE.Vector3().fromBufferAttribute(posAttr, i * 2 + 1);
      return {
        title: formatValue(series[j].values[i], spec.unit),
        lines: [names[j], formatTime(times[i])],
        point: top,
      };
    },
  };
}


// ── calendar: day × hour-of-day towers (daily cycles become ridges) ──────

const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const pad2 = n => String(n).padStart(2, '0');

function buildCalendar(data, spec) {
  if (data.kind !== 'range') throw new Error('calendar needs a range query');
  const group = new THREE.Group();
  const { times, step } = data;

  // All series are summed: a calendar shows one signal.
  const total = new Float64Array(times.length).fill(NaN);
  for (const s of data.series) {
    s.values.forEach((v, i) => {
      if (Number.isFinite(v)) total[i] = (Number.isFinite(total[i]) ? total[i] : 0) + v;
    });
  }

  // Each sample summarises the window ending at t, so file it under the
  // window's midpoint. Several samples per hour are averaged.
  const days = new Map();
  times.forEach((t, i) => {
    if (!Number.isFinite(total[i])) return;
    const d = new Date((t - step / 2) * 1000);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!days.has(key)) {
      days.set(key, { date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), sum: new Float64Array(24), cnt: new Uint16Array(24) });
    }
    const day = days.get(key);
    day.sum[d.getHours()] += total[i];
    day.cnt[d.getHours()]++;
  });
  const dayList = [...days.values()].sort((a, b) => a.date - b.date);
  if (!dayList.length) throw new Error('No data points in range');

  const cells = [];
  dayList.forEach((day, di) => {
    for (let h = 0; h < 24; h++) {
      if (day.cnt[h]) cells.push({ di, h, value: day.sum[h] / day.cnt[h], date: day.date });
    }
  });
  const scale = makeScale(cells.map(c => c.value), spec.log);

  const nd = dayList.length;
  const cw = W / 24;
  const cd = D / nd;
  baseScaffold(group);
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.1 }), cells.length);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  const q = new THREE.Quaternion();
  cells.forEach((c, i) => {
    const t = scale.t(c.value);
    const h = Math.max(0.003, t * H);
    // oldest day at the back, today at the front
    c.top = new THREE.Vector3(-W / 2 + (c.h + 0.5) * cw, h, -D / 2 + (c.di + 0.5) * cd);
    m.compose(new THREE.Vector3(c.top.x, 0, c.top.z), q, new THREE.Vector3(cw * 0.86, h, cd * 0.86));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, rampColor(0.08 + t * 0.92, col));
  });
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);

  for (let hr = 0; hr < 24; hr += 3) {
    const l = makeLabel(`${pad2(hr)}:00`, { height: 0.028, color: '#aeb7c9' });
    l.position.set(-W / 2 + (hr + 0.5) * cw, 0.005, D / 2 + 0.06);
    group.add(l);
  }
  for (const di of labelIndices(nd, 16)) {
    const l = makeLabel(DAY_FMT.format(dayList[di].date), { height: 0.028, color: '#aeb7c9' });
    l.center.set(0, 0.5);
    l.position.set(W / 2 + 0.06, 0.005, -D / 2 + (di + 0.5) * cd);
    group.add(l);
  }
  axisTitle(group, 'hour of day (local time) →', new THREE.Vector3(0, -0.02, D / 2 + 0.14));
  axisTitle(group, 'day ↓', new THREE.Vector3(W / 2 + 0.12, 0.08, -D / 2 - 0.08));
  valueAxis(group, scale, spec.unit);

  return {
    group,
    pickables: [mesh],
    info: { days: nd },
    pick(hit) {
      if (hit.object !== mesh || hit.instanceId === undefined) return null;
      const c = cells[hit.instanceId];
      return {
        title: formatValue(c.value, spec.unit),
        lines: [`${DAY_FMT.format(c.date)} · ${pad2(c.h)}:00–${pad2((c.h + 1) % 24)}:00`],
        point: c.top.clone(),
      };
    },
  };
}

// ── scatter & trails: three metrics as coordinates, one entity per point ─

const SW = 1.2, SD = 1.2, SH = 0.85;
const AXIS_FALLBACK = { x: { label: 'X' }, y: { label: 'Y' }, z: { label: 'Z' } };

function axisSpec(spec, k) {
  return { ...AXIS_FALLBACK[k], ...(spec.axes?.[k] || {}) };
}

/** Floor + two back walls with grid lines and per-axis ticks (matplotlib-style box). */
function scatterFrame(group, scales, spec) {
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(SW + 0.1, 0.012, SD + 0.1),
    new THREE.MeshStandardMaterial({ color: 0x161a24, roughness: 0.9 }),
  );
  plate.position.y = -0.007;
  group.add(plate);

  const pts = [];
  const N = 4;
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const x = -SW / 2 + f * SW, z = SD / 2 - f * SD, y = f * SH;
    pts.push(x, 0, SD / 2, x, 0, -SD / 2);              // floor, along z
    pts.push(-SW / 2, 0, z, SW / 2, 0, z);              // floor, along x
    pts.push(x, 0, -SD / 2, x, SH, -SD / 2);            // back wall verticals
    pts.push(-SW / 2, y, -SD / 2, SW / 2, y, -SD / 2);  // back wall horizontals
    pts.push(-SW / 2, 0, z, -SW / 2, SH, z);            // left wall verticals
    pts.push(-SW / 2, y, -SD / 2, -SW / 2, y, SD / 2);  // left wall horizontals
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  group.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2c3344 })));

  const ax = axisSpec(spec, 'x'), ay = axisSpec(spec, 'y'), az = axisSpec(spec, 'z');
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const lx = makeLabel(formatTick(scales.x.inv(f), ax.unit, scales.x.inv(0), scales.x.inv(1)), { height: 0.026, color: '#9aa4b8' });
    lx.position.set(-SW / 2 + f * SW, 0.005, SD / 2 + 0.05);
    group.add(lx);
    const lz = makeLabel(formatTick(scales.z.inv(f), az.unit, scales.z.inv(0), scales.z.inv(1)), { height: 0.026, color: '#9aa4b8' });
    lz.center.set(0, 0.5);
    lz.position.set(SW / 2 + 0.04, 0.005, SD / 2 - f * SD);
    group.add(lz);
    const ly = makeLabel(formatTick(scales.y.inv(f), ay.unit, scales.y.inv(0), scales.y.inv(1)), { height: 0.026, color: '#9aa4b8' });
    ly.center.set(1, 0.5);
    ly.position.set(-SW / 2 - 0.02, f * SH, -SD / 2);
    group.add(ly);
  }
  const t = (text, pos) => {
    const l = makeLabel(text, { height: 0.034, color: '#dfe5f2', background: 'rgba(30,36,52,0.85)', maxChars: 48 });
    l.position.copy(pos);
    group.add(l);
  };
  t(`X → ${ax.label}${scales.x.log ? ' (log)' : ''}`, new THREE.Vector3(0, -0.01, SD / 2 + 0.13));
  t(`Z → ${az.label}${scales.z.log ? ' (log)' : ''}`, new THREE.Vector3(SW / 2 + 0.16, 0.06, 0));
  t(`Y ↑ ${ay.label}${scales.y.log ? ' (log)' : ''}`, new THREE.Vector3(-SW / 2, SH + 0.07, -SD / 2));
}

function pickColorKey(entities, spec) {
  if (spec.colorBy && spec.colorBy !== 'auto') {
    return entities.some(e => spec.colorBy in e.labels) ? spec.colorBy : null;
  }
  // auto: the label that splits entities into a few groups (e.g. cluster / job)
  let best = null, bestN = Infinity;
  for (const k of varyingLabels(entities)) {
    const n = new Set(entities.map(e => e.labels[k])).size;
    if (n > 1 && n <= 8 && n < entities.length && n < bestN) { best = k; bestN = n; }
  }
  return best;
}

const groupOf = (e, key) => e.labels[key] ?? 'other';

function legend(group, values, colorKey, origin) {
  axisTitle(group, colorKey, origin.clone());
  values.forEach((v, i) => {
    const l = makeLabel('● ' + v, { height: 0.032, color: '#' + catColor(i).getHexString(), maxChars: 36 });
    l.center.set(0, 0.5);
    l.position.set(origin.x - 0.05, origin.y - 0.05 * (i + 1), origin.z);
    group.add(l);
  });
}

// "Log scale" on means: log on every axis whose spec doesn't opt out (log: false).
function scatterScales(entities, spec, flat) {
  const scale = k => makeScale(flat(k), !!spec.log && axisSpec(spec, k).log !== false, { zero: false });
  return { x: scale('x'), y: scale('y'), z: scale('z') };
}

const toWorld = (scales, x, y, z, out = new THREE.Vector3()) => out.set(
  -SW / 2 + scales.x.t(x) * SW,
  scales.y.t(y) * SH,
  SD / 2 - scales.z.t(z) * SD,
);

function axisLines(spec, e) {
  const fmt = (k, v) => `${axisSpec(spec, k).label}: ${formatValue(v, axisSpec(spec, k).unit)}`;
  return [fmt('x', e.x), fmt('y', e.y), fmt('z', e.z)];
}

function buildScatter(data, spec) {
  if (!data.entities || data.kind !== 'instant') throw new Error('scatter needs three instant queries (X, Y, Z)');
  const group = new THREE.Group();
  const ents = data.entities.filter(e => [e.x, e.y, e.z].every(Number.isFinite));
  if (!ents.length) throw new Error('No entity has finite values for X, Y and Z');
  const names = varyingLabels(ents);
  const scales = scatterScales(ents, spec, k => ents.map(e => e[k]));
  scatterFrame(group, scales, spec);

  const colorKey = pickColorKey(ents, spec);
  const groups = colorKey ? [...new Set(ents.map(e => groupOf(e, colorKey)))].sort((a, b) => compareLabelValues(colorKey, a, b)) : [];
  const r = ents.length > 80 ? 0.013 : 0.02;

  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.2 }),
    ents.length,
  );
  const shadows = new THREE.InstancedMesh(
    new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }),
    ents.length,
  );
  const drop = [];
  const dropCol = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  ents.forEach((e, i) => {
    e.pos = toWorld(scales, e.x, e.y, e.z);
    e.name = seriesName(e.labels, names);
    m.compose(e.pos, q, new THREE.Vector3(r, r, r));
    mesh.setMatrixAt(i, m);
    if (colorKey) col.copy(catColor(groups.indexOf(groupOf(e, colorKey))));
    else rampColor(0.15 + scales.y.t(e.y) * 0.85, col);
    mesh.setColorAt(i, col);
    m.compose(new THREE.Vector3(e.pos.x, 0.0015, e.pos.z), q, new THREE.Vector3(r * 0.9, 1, r * 0.9));
    shadows.setMatrixAt(i, m);
    drop.push(e.pos.x, 0, e.pos.z, e.pos.x, e.pos.y, e.pos.z);
    dropCol.push(col.r * 0.5, col.g * 0.5, col.b * 0.5, col.r, col.g, col.b);
    if (ents.length <= 24) {
      const l = makeLabel(e.name, { height: 0.022, color: '#d5dbe8', maxChars: 32 });
      l.center.set(0, 0);
      l.position.set(e.pos.x + r, e.pos.y + r, e.pos.z);
      group.add(l);
    }
  });
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh, shadows);
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.Float32BufferAttribute(drop, 3));
  dg.setAttribute('color', new THREE.Float32BufferAttribute(dropCol, 3));
  group.add(new THREE.LineSegments(dg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 })));
  if (colorKey) legend(group, groups, colorKey, new THREE.Vector3(SW / 2 + 0.2, SH, -SD / 2));

  return {
    group,
    pickables: [mesh],
    info: { labels: varyingLabels(ents), count: ents.length },
    pick(hit) {
      if (hit.object !== mesh || hit.instanceId === undefined) return null;
      const e = ents[hit.instanceId];
      return { title: e.name, lines: axisLines(spec, e), point: e.pos.clone() };
    },
  };
}

const BG_COLOR = new THREE.Color(0x0d1017);

function buildTrails(data, spec) {
  if (!data.entities || data.kind !== 'range') throw new Error('trails needs three range queries (X, Y, Z)');
  const group = new THREE.Group();
  const { times } = data;
  const ents = data.entities
    .map(e => {
      const idx = [];
      for (let i = 0; i < times.length; i++) if ([e.x[i], e.y[i], e.z[i]].every(Number.isFinite)) idx.push(i);
      return { ...e, idx };
    })
    .filter(e => e.idx.length);
  if (!ents.length) throw new Error('No entity has finite values for X, Y and Z');
  const names = varyingLabels(ents);
  const scales = scatterScales(ents, spec, k => ents.flatMap(e => e.idx.map(i => e[k][i])));
  scatterFrame(group, scales, spec);

  const colorKey = pickColorKey(ents, spec);
  const groups = colorKey ? [...new Set(ents.map(e => groupOf(e, colorKey)))].sort((a, b) => compareLabelValues(colorKey, a, b)) : [];
  const r = 0.018;
  const heads = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.2 }),
    ents.length,
  );
  const lines = [];
  const drop = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();

  ents.forEach((e, ei) => {
    e.name = seriesName(e.labels, names);
    const color = colorKey ? catColor(groups.indexOf(groupOf(e, colorKey))) : catColor(ei);
    const pos = [];
    const cols = [];
    e.idx.forEach((i, k) => {
      const p = toWorld(scales, e.x[i], e.y[i], e.z[i]);
      pos.push(p.x, p.y, p.z);
      // older samples fade into the background
      c.copy(BG_COLOR).lerp(color, 0.12 + 0.88 * (k / Math.max(1, e.idx.length - 1)));
      cols.push(c.r, c.g, c.b);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true }));
    line.userData.entity = ei;
    group.add(line);
    lines.push(line);

    const last = e.idx[e.idx.length - 1];
    e.head = toWorld(scales, e.x[last], e.y[last], e.z[last]);
    m.compose(e.head, q, new THREE.Vector3(r, r, r));
    heads.setMatrixAt(ei, m);
    heads.setColorAt(ei, color);
    drop.push(e.head.x, 0, e.head.z, e.head.x, e.head.y, e.head.z);
    if (ents.length <= 24) {
      const l = makeLabel(e.name, { height: 0.022, color: '#' + color.getHexString(), maxChars: 32 });
      l.center.set(0, 0);
      l.position.set(e.head.x + r, e.head.y + r, e.head.z);
      group.add(l);
    }
  });
  heads.instanceMatrix.needsUpdate = true;
  group.add(heads);
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.Float32BufferAttribute(drop, 3));
  group.add(new THREE.LineSegments(dg, new THREE.LineBasicMaterial({ color: 0x5a6378, transparent: true, opacity: 0.6 })));
  if (colorKey) legend(group, groups, colorKey, new THREE.Vector3(SW / 2 + 0.2, SH, -SD / 2));
  const tl = makeLabel(`trails: ${formatTime(times[0])} → ${formatTime(times[times.length - 1])} · ● = now`, { height: 0.026, color: '#8d97ab' });
  tl.position.set(0, SH + 0.13, -SD / 2);
  group.add(tl);

  const at = (e, i) => ({ x: e.x[i], y: e.y[i], z: e.z[i] });
  return {
    group,
    pickables: [heads, ...lines],
    info: { labels: varyingLabels(ents), count: ents.length },
    pick(hit) {
      if (hit.object === heads && hit.instanceId !== undefined) {
        const e = ents[hit.instanceId];
        const i = e.idx[e.idx.length - 1];
        return { title: e.name, lines: [...axisLines(spec, at(e, i)), `now (${formatTime(times[i])})`], point: e.head.clone() };
      }
      const ei = hit.object.userData.entity;
      if (ei === undefined || hit.index === undefined) return null;
      const e = ents[ei];
      const k = Math.min(hit.index, e.idx.length - 1);
      const i = e.idx[k];
      const p = new THREE.Vector3().fromBufferAttribute(hit.object.geometry.getAttribute('position'), k);
      return { title: e.name, lines: [...axisLines(spec, at(e, i)), formatTime(times[i])], point: p };
    },
  };
}

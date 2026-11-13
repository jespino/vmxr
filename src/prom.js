// Minimal Prometheus HTTP API client + normalisation of results into a
// shape every visualisation can consume.

export async function runQuery({ baseUrl, query, mode, range = 3600, points = 120, step: fixedStep, signal }) {
  const base = baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ query });
  let path = '/api/v1/query';
  let end = Math.floor(Date.now() / 1000);
  let step = 0;
  if (mode === 'range') {
    path = '/api/v1/query_range';
    step = fixedStep || Math.max(15, Math.round(range / points));
    // VictoriaMetrics aligns timestamps to multiples of step; do the same so
    // every returned point lands exactly on our grid.
    end = Math.floor(end / step) * step;
    params.set('start', String(end - range));
    params.set('end', String(end));
    params.set('step', String(step));
  }
  const res = await fetch(base + path, { method: 'POST', body: params, signal });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}: response is not JSON`);
  }
  if (body.status !== 'success') throw new Error(body.error || `HTTP ${res.status}`);

  const { resultType, result } = body.data;
  if (resultType === 'scalar') {
    return { kind: 'instant', series: [{ labels: {}, value: Number(result[1]) }] };
  }
  if (resultType === 'vector') {
    return {
      kind: 'instant',
      series: result.map(r => ({ labels: r.metric, value: Number(r.value[1]) })),
    };
  }
  if (resultType === 'matrix') {
    // Align every series on a shared time grid so surfaces line up.
    const start = end - range;
    const n = Math.floor(range / step) + 1;
    const times = Array.from({ length: n }, (_, i) => start + i * step);
    const series = result.map(r => {
      const values = new Float64Array(n).fill(NaN);
      for (const [t, v] of r.values) {
        const i = Math.round((t - start) / step);
        if (i >= 0 && i < n) values[i] = Number(v);
      }
      return { labels: r.metric, values };
    });
    return { kind: 'range', times, step, series };
  }
  throw new Error(`Unsupported result type: ${resultType}`);
}

/** Labels whose value differs between series (i.e. the ones worth showing). */
export function varyingLabels(series) {
  const seen = new Map();
  for (const s of series) {
    for (const [k, v] of Object.entries(s.labels)) {
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(v);
    }
  }
  const keys = [];
  for (const [k, vals] of seen) {
    const presentInAll = series.every(s => k in s.labels);
    if (vals.size > 1 || !presentInAll) keys.push({ key: k, distinct: vals.size });
  }
  return keys.sort((a, b) => b.distinct - a.distinct).map(k => k.key);
}

export function seriesName(labels, keys) {
  if (!keys.length) {
    const entries = Object.entries(labels);
    if (!entries.length) return '{}';
    return labels.__name__ || entries.map(([k, v]) => `${k}=${v}`).join(', ');
  }
  return keys.map(k => labels[k] ?? '∅').join(' · ');
}

const HIST_LABELS = new Set(['vmrange', 'le']);
export const isHistogramLabel = l => HIST_LABELS.has(l);
const QUANTILE_LABELS = new Set(['phi', 'quantile']);
/** Labels whose values form a numeric scale (buckets, quantiles). */
export const isOrderedLabel = l => HIST_LABELS.has(l) || QUANTILE_LABELS.has(l);

/** Sort key for a label value: histogram buckets numerically, else natural order. */
export function bucketLowerBound(label, value) {
  if (value === undefined) return Infinity;
  if (label === 'vmrange') return parseFloat(value.split('...')[0]);
  if (label === 'le') return value === '+Inf' ? Infinity : parseFloat(value);
  return NaN;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function compareLabelValues(label, a, b) {
  if (isHistogramLabel(label)) return bucketLowerBound(label, a) - bucketLowerBound(label, b);
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return collator.compare(a ?? '', b ?? '');
}

export function prettyBucket(label, value) {
  if (QUANTILE_LABELS.has(label) && value !== undefined && Number.isFinite(Number(value))) {
    const q = Number(value);
    return q === 0 ? 'min' : q === 1 ? 'max' : 'p' + +(q * 100).toPrecision(4);
  }
  if (label === 'vmrange' && value) {
    const [lo, hi] = value.split('...');
    return `${fmtNum(parseFloat(lo))}…${fmtNum(parseFloat(hi))}`;
  }
  return value;
}

function fmtNum(v) {
  if (!isFinite(v)) return String(v);
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e4 || a < 1e-2) return v.toExponential(1).replace('e+', 'e');
  return String(+v.toPrecision(3));
}

/**
 * Join three results (x, y, z) into entities. Series are matched on the label
 * names every series of every result carries (ignoring __name__), so
 * `... by (job)` queries line up naturally. Works for instant and range data.
 * Returns { kind, times?, keys, entities: [{ labels, x, y, z }] } where x/y/z
 * are numbers (instant) or Float64Arrays (range).
 */
export function joinAxes({ x, y, z }) {
  const all = [x, y, z];
  if (all.some(r => !r.series.length)) {
    const which = ['X', 'Y', 'Z'].filter((_, i) => !all[i].series.length).join(', ');
    throw new Error(`Query ${which} returned no series`);
  }
  let common = null;
  for (const r of all) {
    for (const s of r.series) {
      const ks = new Set(Object.keys(s.labels).filter(k => k !== '__name__'));
      common = common ? new Set([...common].filter(k => ks.has(k))) : ks;
    }
  }
  const keys = [...common].sort();
  const sig = labels => keys.map(k => labels[k]).join('\u0000');
  const pick = s => (x.kind === 'range' ? s.values : s.value);
  const index = r => {
    const m = new Map();
    for (const s of r.series) m.set(sig(s.labels), s);
    return m;
  };
  // Without unique join keys the match would be arbitrary: refuse instead.
  for (const [name, r] of [['X', x], ['Y', y], ['Z', z]]) {
    const sigs = new Set(r.series.map(s => sig(s.labels)));
    if (sigs.size !== r.series.length) {
      const why = keys.length
        ? `query ${name} has several series with the same {${keys.join(', ')}}`
        : 'the three queries share no labels';
      throw new Error(`Can't match X/Y/Z series: ${why}. Aggregate all three by the same labels, e.g. sum(...) by (job).`);
    }
  }
  const iy = index(y), iz = index(z);
  const entities = [];
  for (const sx of x.series) {
    const k = sig(sx.labels);
    const sy = iy.get(k), sz = iz.get(k);
    if (!sy || !sz) continue;
    const { __name__, ...labels } = sx.labels;
    entities.push({ labels, x: pick(sx), y: pick(sy), z: pick(sz) });
  }
  if (!entities.length) {
    throw new Error(`No series matched across X/Y/Z on labels {${keys.join(', ')}} — make all three queries aggregate by the same labels`);
  }
  return { kind: x.kind, times: x.times, keys, entities };
}

import { runQuery, joinAxes } from './prom.js';

export const VIZ_MODE = {
  bars: 'instant', radial: 'instant', scatter: 'instant',
  surface: 'range', ribbons: 'range', trails: 'range', calendar: 'range',
};
export const isMultiViz = viz => viz === 'scatter' || viz === 'trails';
export const AXES = ['x', 'y', 'z'];

/** Run whatever queries a spec needs and return data ready for buildViz. */
export async function fetchForSpec(spec, { baseUrl, signal }) {
  const mode = VIZ_MODE[spec.viz];
  if (!mode) throw new Error(`Unknown visualisation: ${spec.viz}`);
  const opts = { baseUrl, mode, signal, range: spec.range || 3600 };
  if (spec.viz === 'calendar') {
    opts.range = (spec.days || 14) * 86400;
    opts.step = 3600;
  }
  if (isMultiViz(spec.viz)) {
    const missing = AXES.filter(k => !spec.axes?.[k]?.query);
    if (missing.length) throw new Error(`Missing ${missing.join(', ').toUpperCase()} query`);
    const [x, y, z] = await Promise.all(AXES.map(k => runQuery({ ...opts, query: spec.axes[k].query })));
    return joinAxes({ x, y, z });
  }
  if (!spec.query) throw new Error('Empty query');
  return runQuery({ ...opts, query: spec.query });
}

/** Best-effort unit for a query we know nothing about. */
export function guessUnit(query = '') {
  if (/_bytes\b|_bytes_total|bytes\{|bytes\[/.test(query)) return /\b(i?rate|increase|deriv)\(/.test(query) ? 'bps' : 'bytes';
  if (/_seconds_bucket|histogram_quantiles?\(/.test(query) && /quantile/.test(query)) return 'seconds';
  return 'short';
}

/** Short axis title for a custom query: its most specific metric name. */
export function guessLabel(query = '', fallback = '') {
  const names = (query.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) || []).filter(n => n.includes('_') && !/^(label_|histogram_|count_|sum_|avg_|max_|min_)/.test(n));
  if (!names.length) return fallback;
  return names.sort((a, b) => b.length - a.length)[0].replace(/_total$|_seconds_total$/, '');
}

/** A catalog entry as the UI-state shape (also what the dashboard loads). */
export function entryToState(e) {
  const multi = isMultiViz(e.viz);
  return {
    id: e.id,
    title: e.title,
    viz: e.viz,
    query: multi ? e.axes.x.query : e.query,
    queries: multi
      ? { x: e.axes.x.query, y: e.axes.y.query, z: e.axes.z.query }
      : { x: e.query, y: '', z: '' },
    axesMeta: e.axes || null,
    range: e.range || 3600,
    days: e.days || 14,
    log: !!e.log,
    x: e.x || 'auto', z: e.z || 'auto', sortBy: e.sortBy || 'auto', colorBy: e.colorBy || 'auto',
    unit: e.unit || 'auto',
  };
}

/** UI state → the spec the fetch layer and visualisations consume. */
export function stateToSpec(state) {
  const spec = { ...state, unit: state.unit === 'auto' ? guessUnit(state.query) : state.unit };
  if (isMultiViz(state.viz)) {
    // Catalog entries carry axis titles/units; custom queries get guessed ones.
    spec.axes = Object.fromEntries(AXES.map(k => {
      const q = state.queries[k];
      const meta = state.axesMeta?.[k];
      const same = meta && meta.query === q;
      return [k, {
        query: q,
        label: same ? meta.label : guessLabel(q, k.toUpperCase()),
        unit: same ? meta.unit : guessUnit(q),
        log: same ? meta.log : undefined,
      }];
    }));
  }
  return spec;
}

/** One-line description of what a spec queries, for info boards. */
export function specQueryText(spec) {
  if (!spec.axes) return spec.query;
  return AXES.map(k => `${k.toUpperCase()}: ${spec.axes[k].query}`).join('   ');
}

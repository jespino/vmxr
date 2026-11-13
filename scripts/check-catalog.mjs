// Validates every catalog entry against the playground using the same fetch
// path as the app: non-empty data, joins succeed, labels exist, not all zero.
import { CATALOG, PLAYGROUND_URL } from '../src/catalog.js';
import { fetchForSpec, isMultiViz } from '../src/fetch.js';

const baseUrl = process.env.VM_URL || PLAYGROUND_URL;
let failed = 0;
for (const e of CATALOG) {
  const t0 = Date.now();
  let problem = null, detail = '';
  try {
    const d = await fetchForSpec(e, { baseUrl });
    if (isMultiViz(e.viz)) {
      detail = `entities=${d.entities.length}`;
      if (d.entities.length < 3) problem = 'fewer than 3 entities';
      if (e.colorBy && !d.entities.some(x => e.colorBy in x.labels)) problem = `colorBy ${e.colorBy} missing`;
    } else {
      const r = d.series;
      detail = `series=${r.length}` + (d.times ? ` points=${d.times.length}` : '');
      if (!r.length) problem = 'empty result';
      if (e.viz === 'bars') for (const l of [e.x, e.z]) if (!r.some(s => l in s.labels)) problem = `label ${l} missing`;
      if (e.sortBy && !r.some(s => e.sortBy in s.labels)) problem = `sortBy ${e.sortBy} missing`;
      if (d.kind === 'range' && r.every(s => s.values.every(v => !Number.isFinite(v) || v === 0))) problem = 'all zeros';
    }
  } catch (err) {
    problem = err.message.slice(0, 200);
  }
  if (problem) failed++;
  console.log(`${problem ? 'FAIL' : ' ok '} ${e.id.padEnd(24)} ${e.viz.padEnd(9)} ${detail.padEnd(26)} ${String(Date.now() - t0).padStart(5)}ms ${problem || ''}`);
}
process.exit(failed ? 1 : 0);

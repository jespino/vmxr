const SI = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
const BIN = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

function scaled(v, base, units, sep = '') {
  if (!isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a < 1 && units[0] === '') return trim(v);
  let i = 0;
  let x = a;
  while (x >= base && i < units.length - 1) { x /= base; i++; }
  return (v < 0 ? '-' : '') + trim(x) + sep + units[i];
}

function trim(v) {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
  if (a >= 0.01) return v.toFixed(2).replace(/\.?0+$/, '');
  return v.toExponential(1);
}

export function formatValue(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  switch (unit) {
    case 'bytes': return scaled(v, 1024, BIN, ' ');
    case 'bps': return scaled(v, 1024, BIN, ' ') + '/s';
    case 'percent': return trim(v * 100) + '%';
    case 'seconds':
      if (Math.abs(v) < 1) return trim(v * 1000) + ' ms';
      return trim(v) + ' s';
    default: return scaled(v, 1000, SI);
  }
}

export function formatTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const PRECISE = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 5 });

/** Axis tick: like formatValue, but adds digits when the axis span is narrow. */
export function formatTick(v, unit, lo, hi) {
  const narrow = Math.abs(hi - lo) < Math.max(Math.abs(hi), Math.abs(lo)) * 0.02;
  if (!narrow || !Number.isFinite(v)) return formatValue(v, unit);
  if (!unit || unit === 'short') return PRECISE.format(v);
  return formatValue(v, unit);
}

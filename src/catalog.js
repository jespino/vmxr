// Predefined demo queries for https://play.victoriametrics.com
//
// Design rule: the floor axes of a 3D plot must be *ordered* (time, histogram
// bucket, quantile, hour of day, day). Unordered labels such as `instance` or
// `job` are never an axis — they become entities: points, trails or pillars.
//
// Entry fields:
//   id, group, title, description (says why the shape fits the data)
//   viz      – 'surface' | 'ribbons' | 'calendar' | 'scatter' | 'trails' | 'radial' | 'bars'
//   query    – MetricsQL / PromQL (single-query shapes)
//   axes     – { x, y, z: { label, query, unit, log } } for scatter / trails;
//              all three queries must aggregate by the same labels
//   colorBy  – (scatter / trails) label used to colour entities
//   x, z     – (bars) label names for the two grid axes
//   sortBy   – (surface / ribbons) label ordering the depth axis
//   range    – lookback in seconds (surface, ribbons, trails)
//   days     – lookback in days (calendar, sampled hourly — use [1h] windows)
//   log      – log scaling (for scatter / trails: on every axis without log:false)
//   unit     – 'bytes' | 'bps' | 'percent' | 'short' | 'seconds'

export const PLAYGROUND_URL = 'https://play.victoriametrics.com/select/0/prometheus';

// Adds a `product` label (vm / vl / vt) derived from the job name.
const product = q => `label_replace(${q}, "product", "$1", "job", "(?:.*/)?(vm|vl|vt).*")`;
// Adds an `area` label (indexdb / storage / …) derived from the cache type.
const area = q => `label_replace(${q}, "area", "$1", "type", "([^/]+)/.*")`;
const BENCH_STORAGE = 'job=~"vmstorage-benchmark.*"';

export const CATALOG = [
  // ───────────── Daily rhythm: day × hour-of-day ─────────────
  {
    id: 'cal-vlogs-ingest',
    group: 'Daily rhythm',
    title: 'VictoriaLogs ingestion — 14 days',
    description: 'Rows/s ingested by VictoriaLogs, one tower per hour. A batch job that runs nearly every day shows up as a ridge at the same hour (06:00 UTC) cutting through the days.',
    query: 'sum(rate(vl_rows_ingested_total[1h]))',
    viz: 'calendar', days: 14, unit: 'short',
  },
  {
    id: 'cal-cache-misses',
    group: 'Daily rhythm',
    title: 'Cache misses — 14 days',
    description: 'VictoriaMetrics cache misses/s per hour (log scale). On some nights, not all, misses jump 25–50× between 00:00 and 02:00 UTC. Open “Background merges” next: the spikes land on the same nights.',
    query: 'sum(rate(vm_cache_misses_total[1h]))',
    viz: 'calendar', days: 14, log: true, unit: 'short',
  },
  {
    id: 'cal-merges',
    group: 'Daily rhythm',
    title: 'Background merges — 14 days',
    description: 'Average active merges across all vmstorage nodes, per hour. Big merges right after midnight UTC line up with the cache-miss spikes in the previous calendar.',
    query: 'sum(avg_over_time(vm_active_merges[1h]))',
    viz: 'calendar', days: 14, unit: 'short',
  },
  {
    id: 'cal-node-cpu',
    group: 'Daily rhythm',
    title: 'Cluster CPU — 14 days',
    description: 'Total busy CPU cores across all Kubernetes nodes, per hour.',
    query: 'sum(rate(node_cpu_seconds_total{mode!="idle"}[1h]))',
    viz: 'calendar', days: 14, unit: 'short',
  },
  {
    id: 'cal-new-series',
    group: 'Daily rhythm',
    title: 'New time series created — 14 days',
    description: 'Churn: brand-new series registered per second, per hour. Deploys and pod restarts leave isolated spikes.',
    query: 'sum(rate(vm_new_timeseries_created_total[1h]))',
    viz: 'calendar', days: 14, unit: 'short',
  },

  // ───────────── Heatmaps: time × histogram bucket ─────────────
  {
    id: 'hist-vmselect-latency',
    group: 'Heatmaps',
    title: 'vmselect latency heatmap — 1h',
    description: 'Request-duration histogram over time. Both floor axes are ordered (time, bucket), so the terrain is real: the ridge is the typical latency, the long slope behind it is the tail.',
    query: 'sum(rate(vmselect_request_duration_seconds_bucket[5m])) by (vmrange)',
    viz: 'surface', range: 3600, sortBy: 'vmrange', unit: 'short',
  },
  {
    id: 'hist-rows-read',
    group: 'Heatmaps',
    title: 'Rows read per query — 1h',
    description: 'How many rows each query touches, as a distribution over time. Separate ridges are separate query populations, from tiny lookups to scans of millions of rows.',
    query: 'sum(rate(vm_rows_read_per_query_bucket[5m])) by (vmrange)',
    viz: 'surface', range: 3600, sortBy: 'vmrange', unit: 'short',
  },
  {
    id: 'hist-remotewrite',
    group: 'Heatmaps',
    title: 'vmagent remote-write latency — 3h',
    description: 'Remote-write request duration distribution of every vmagent, over three hours.',
    query: 'sum(rate(vmagent_remotewrite_duration_seconds_bucket[5m])) by (vmrange)',
    viz: 'surface', range: 10800, sortBy: 'vmrange', unit: 'short',
  },
  {
    id: 'hist-rows-per-insert',
    group: 'Heatmaps',
    title: 'Rows per insert request — 1h',
    description: 'Batch-size distribution of incoming writes over time.',
    query: 'sum(rate(vm_rows_per_insert_bucket[5m])) by (vmrange)',
    viz: 'surface', range: 3600, sortBy: 'vmrange', unit: 'short',
  },

  // ───────────── Percentiles: time × quantile ─────────────
  {
    id: 'pct-vmselect',
    group: 'Percentiles',
    title: 'vmselect latency percentiles — 3h',
    description: 'p50 → p99.9 front to back. The quantile axis is ordered, so the slope of the surface is the shape of the tail; a tail spike rises only at the back (log scale).',
    query: 'histogram_quantiles("phi", 0.5, 0.75, 0.9, 0.95, 0.99, 0.999, sum(rate(vmselect_request_duration_seconds_bucket[5m])) by (vmrange))',
    viz: 'surface', range: 10800, sortBy: 'phi', log: true, unit: 'seconds',
  },
  {
    id: 'pct-remotewrite',
    group: 'Percentiles',
    title: 'Remote-write latency percentile ribbons — 3h',
    description: 'One ribbon per percentile, stacked in depth from p50 to p99.9.',
    query: 'histogram_quantiles("phi", 0.5, 0.75, 0.9, 0.95, 0.99, 0.999, sum(rate(vmagent_remotewrite_duration_seconds_bucket[5m])) by (vmrange))',
    viz: 'ribbons', range: 10800, sortBy: 'phi', unit: 'seconds',
  },
  {
    id: 'pct-fleet-cpu',
    group: 'Percentiles',
    title: 'CPU across the fleet — 6h',
    description: 'Instead of one row per node (unordered), the depth axis is the distribution across nodes: min, p10 … p90, max. A wide gap at the back means one hot node.',
    query: 'quantiles("phi", 0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) by (instance))',
    viz: 'surface', range: 21600, sortBy: 'phi', unit: 'short',
  },
  {
    id: 'pct-fleet-net',
    group: 'Percentiles',
    title: 'Network receive across the fleet — 6h',
    description: 'Distribution of inbound throughput across nodes over time, as ribbons from min to max.',
    query: 'quantiles("phi", 0, 0.25, 0.5, 0.75, 0.9, 1, sum(rate(node_network_receive_bytes_total[5m])) by (instance))',
    viz: 'ribbons', range: 21600, sortBy: 'phi', unit: 'bps',
  },

  // ───────────── Relationships: three metrics as coordinates ─────────────
  {
    id: 'sc-jobs',
    group: 'Relationships',
    title: 'Every service: CPU × memory × goroutines',
    description: 'Each point is one service; three resource metrics are its coordinates. Coloured by product (VictoriaMetrics / Logs / Traces) to compare their footprints; heavyweights and goroutine-hungry outliers float away from the crowd (log axes).',
    axes: {
      x: { label: 'CPU cores', unit: 'short', query: product('sum(rate(process_cpu_seconds_total[5m])) by (job)') },
      y: { label: 'resident memory', unit: 'bytes', query: product('sum(process_resident_memory_bytes) by (job)') },
      z: { label: 'goroutines', unit: 'short', query: product('sum(go_goroutines) by (job)') },
    },
    viz: 'scatter', colorBy: 'product', log: true,
  },
  {
    id: 'sc-vmstorage',
    group: 'Relationships',
    title: 'Benchmark vmstorage nodes: ingestion × CPU × memory',
    description: 'One point per vmstorage node of the LTS, stable and staging benchmark clusters, which receive identical load. Clusters separating along an axis means that release uses more CPU or memory for the same work.',
    axes: {
      x: { label: 'rows ingested/s', unit: 'short', query: `sum(rate(vm_rows_added_to_storage_total{${BENCH_STORAGE}}[5m])) by (job, instance)` },
      y: { label: 'CPU cores', unit: 'short', query: `sum(rate(process_cpu_seconds_total{${BENCH_STORAGE}}[5m])) by (job, instance)` },
      z: { label: 'resident memory', unit: 'bytes', query: `sum(process_resident_memory_bytes{${BENCH_STORAGE}}) by (job, instance)` },
    },
    viz: 'scatter', colorBy: 'job', log: false,
  },
  {
    id: 'sc-caches',
    group: 'Relationships',
    title: 'Caches: traffic × miss ratio × size',
    description: 'Each point is an internal cache. Height is the miss ratio, so struggling caches float to the top; the floor shows how busy and how big each one is.',
    axes: {
      x: { label: 'requests/s', unit: 'short', query: area('sum(rate(vm_cache_requests_total[5m])) by (type) > 0') },
      y: { label: 'miss ratio', unit: 'percent', log: false, query: area('sum(rate(vm_cache_misses_total[5m])) by (type) / sum(rate(vm_cache_requests_total[5m])) by (type)') },
      z: { label: 'size', unit: 'bytes', query: area('sum(vm_cache_size_bytes) by (type) > 0') },
    },
    viz: 'scatter', colorBy: 'area', log: true,
  },
  {
    id: 'tr-nodes',
    group: 'Relationships',
    title: 'Kubernetes nodes: CPU × memory × network — 1h',
    description: 'Each node traces its last hour through CPU, memory and network-receive space.',
    axes: {
      x: { label: 'CPU cores', unit: 'short', query: 'sum(rate(node_cpu_seconds_total{mode!="idle"}[5m])) by (instance)' },
      y: { label: 'memory used', unit: 'percent', query: 'sum(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) by (instance)' },
      z: { label: 'network receive', unit: 'bps', query: 'sum(rate(node_network_receive_bytes_total[5m])) by (instance)' },
    },
    viz: 'trails', range: 3600, log: false,
  },

  // ───────────── Snapshots ─────────────
  {
    id: 'snap-cpu-ranking',
    group: 'Snapshots',
    title: 'CPU ranking of every service',
    description: 'A one-dimensional ranking wrapped around you: the tallest pillar is in front and heights fall off clockwise (log scale).',
    query: 'sum(rate(process_cpu_seconds_total[5m])) by (job)',
    viz: 'radial', log: true, unit: 'short',
  },
  {
    id: 'snap-data-size',
    group: 'Snapshots',
    title: 'Data size: cluster × part type',
    description: 'A small cross-tab with no interpolation: how each cluster’s bytes split across storage part types (log scale).',
    query: 'sum(vm_data_size_bytes) by (job, type) > 0',
    viz: 'bars', x: 'type', z: 'job', log: true, unit: 'bytes',
  },
];

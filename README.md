# vmxr — metrics in 3D / WebXR

Write a PromQL / MetricsQL query, get a 3D shape you can orbit on desktop or
walk around in a VR / AR headset. Ships with a catalog of demo queries for the
public [VictoriaMetrics playground](https://play.victoriametrics.com).

**Live demo:** https://jespino.github.io/vmxr/ — open it in a headset browser for VR, or on desktop (a Meta Quest 3 is emulated when no headset is present).

```sh
npm install
npm run dev          # http://localhost:5173 (WebXR works on localhost)
npm run dev:lan      # https on your LAN, open it from a Quest / Vision Pro browser
npm run build        # static build in dist/
npm run check-catalog  # verify every catalog query still returns data
```

## Shapes

**Design rule:** a floor axis must be *ordered* — time, histogram bucket,
quantile, hour of day, day — otherwise neighbouring rows imply a relationship
that isn't there. Unordered labels (`instance`, `job`, …) are never an axis;
they become *entities*: points, trails or pillars.

| Shape | Queries | Floor axes → height | Good for |
|-------|---------|---------------------|----------|
| **Surface**  | 1 range | time × bucket / quantile → value | histogram heatmaps (`by (vmrange)`), percentile surfaces (`histogram_quantiles`), fleet distributions (`quantiles(...) by (instance)`) |
| **Ribbons**  | 1 range | time × ordered lanes → value | percentile bands, min…max across a fleet |
| **Calendar** | 1 range, hourly | hour of day × day → value | daily cycles and nightly jobs; use `[1h]` windows |
| **Scatter**  | 3 instant (X, Y, Z) | metric × metric → metric | one point per entity: outliers, clusters, release comparisons |
| **Trails**   | 3 range (X, Y, Z) | same, over time | how each entity moves through metric space |
| **Radial**   | 1 instant | ring → value | a ranking you stand inside |
| **Bars**     | 1 instant | label × label → value | small cross-tabs only |

Bucket (`vmrange`, `le`) and quantile (`phi`, `quantile`) labels are sorted
numerically, smallest at the front, so tails rise behind the body. Scatter and
trails join the three queries on the labels they share — aggregate all three
`by` the same labels. Scatter axes span the data range (not from zero) so
small differences between similar entities stay visible.

## Auto-refresh

Queries re-run every **5 s** by default. The panel's selector offers off / 1 s /
5 s / 10 s / 15 s / 30 s / 1 min; the headset menu's *Auto* button cycles
through them, and `refresh=N` in the URL hash sets it (`refresh=0` = off).
Refreshes are silent, never overlap (a tick is skipped while the previous one
is still running) and pause while the tab is hidden. A plot whose data didn't
change keeps its 3D objects untouched, so even 1 s is cheap when little
changes; plots that did change are rebuilt one at a time so frames keep
rendering in between.

## Dashboard mode

**▦ Dashboard** (panel or headset menu, or `#dashboard=1` in the URL) shows
every catalog plot at once on a curved wall around you: a section of a sphere
centred on your head, 150° left→right and 150° bottom→top, one row per catalog
group (first group at eye level, then above, below, …). Each plot is tilted so
you see it from the same angle as in single view.

- **Desktop:** opens on a wide-angle overview from the centre. Click any plot
  (or its catalog entry) to fly in; **Esc** or **⤢ Overview** zooms back out.
  Scroll / drag still orbit and zoom freely.
- **Headset:** you stand at the centre. Point anywhere at a plot and pull the
  trigger to bring it to you at full size; trigger again sends it back.
  **Grip + move your hand** rotates the plot you point at, in place, like a
  turntable: left/right spins it around its own vertical axis, up/down tilts
  it (±80°, never upside down); ~30 cm of hand travel ≈ 90°. The rotation is
  kept when you bring the plot closer, and reset when it goes back to the wall
  (trigger again, or ⤢ Overview). The thumbstick moves the wall nearer/farther
  and turns it.
- The floor is hidden while the dashboard is up (the lower rows sit below it).
- **Run** or changing a query option returns to the single view.

The wall's spans, radius and plot size are constants at the top of
`src/dashboard.js`.

## Controls

- **Desktop:** drag to orbit, right-drag to pan, scroll to zoom, hover for values.
- **Headset:** point + trigger on the floating menu to pick a catalog query,
  page through it, refresh, toggle log scale or auto-refresh. Hold **grip**
  and move your hand to rotate the plot in place (left/right spins, up/down
  tilts); the **thumbstick** scales it. Point at the data to read values.
- Typing custom queries happens in the 2D panel (before entering XR, or in the
  headset's browser window).
- **No headset?** The app embeds Meta's [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime)
  (pinned at 2.7.0): when the browser reports no VR device it emulates a Meta
  Quest 3, so **Enter VR** / **Enter AR** work on any desktop browser with
  WebXR (Chrome, Chromium, Edge). Inside the session an overlay lets you move
  the headset and controllers and press trigger / grip / sticks; leave with the
  exit button in its toolbar. It is lazy-loaded and never replaces a real
  headset. `?emulate=0` turns it off, `?emulate=1` forces it on.
  `?vrpreview` shows the headset menu on the desktop page itself.
  `?devui=0` runs the emulator without its overlay; dev builds expose
  `window.__iwer` / `window.__vmxr` so scripts can drive the controllers.

## Other data sources

Open **Data source** in the panel and point it at any Prometheus-compatible
`/api/v1/query` endpoint that sends CORS headers (VictoriaMetrics single-node:
`http://host:8428`, cluster: `http://vmselect:8481/select/0/prometheus`).

## Layout

- `src/catalog.js` – demo queries (one object per entry, documented at the top)
- `src/prom.js` – HTTP API client, label ordering, X/Y/Z join
- `src/fetch.js` – which queries a shape needs (shared with `check-catalog`)
- `src/viz.js` – the 3D builders + picking
- `src/vrpanels.js` – in-headset menu, info board, tooltip
- `src/ui.js` – 2D side panel
- `src/slot.js` – one plot in the world: fetch + build + info board + hit box
- `src/dashboard.js` – the curved multi-row wall of slots and its focus animation
- `src/main.js` – scene, modes, camera flights, XR session, controllers

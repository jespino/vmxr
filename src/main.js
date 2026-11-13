import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

import { CATALOG, PLAYGROUND_URL } from './catalog.js';
import { varyingLabels } from './prom.js';
import { UI } from './ui.js';
import { VRMenu, Tooltip3D } from './vrpanels.js';
import { PlotSlot, slotOf } from './slot.js';
import { Dashboard } from './dashboard.js';
import { maybeInstallEmulator } from './emulator.js';

// ── renderer / scene ──────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.getElementById('app').append(renderer.domElement);

const scene = new THREE.Scene();
const BG = new THREE.Color(0x0d1017);
scene.background = BG;
const FOG_SINGLE = new THREE.Fog(BG, 6, 16);
const FOG_DASHBOARD = new THREE.Fog(BG, 14, 36);
scene.fog = FOG_SINGLE;

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 80);
camera.position.set(0.3, 2.0, 1.05);

scene.add(new THREE.HemisphereLight(0xc8d6ff, 0x1a1d26, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(2, 4, 2.5);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x7fa2ff, 0.6);
rim.position.set(-3, 2, -3);
scene.add(rim);

// Environment (hidden in AR so you see your room).
const environment = new THREE.Group();
environment.add(new THREE.GridHelper(24, 48, 0x222838, 0x161b26));
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(12, 64).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x0f131c }),
);
floor.position.y = -0.001;
environment.add(floor);
scene.add(environment);

// Single view: one plot on a "table" in front of you.
const PLOT_HOME = new THREE.Vector3(0, 0.82, -1.15);
const single = new PlotSlot();
single.root.position.copy(PLOT_HOME);
scene.add(single.root);
const singleScale = new THREE.Vector3(1, 1, 1); // VR thumbstick scales it
const IDENTITY_Q = new THREE.Quaternion();

// Dashboard: every catalog plot on a ring around you (created on demand).
let dashboard = null;
let deskFocus = null; // slot the desktop camera is zoomed into
let panelHiddenByDashboard = false;

const marker = new THREE.Mesh(
  new THREE.SphereGeometry(0.012, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }),
);
marker.renderOrder = 30;
marker.visible = false;
scene.add(marker);

const tooltip3d = new Tooltip3D();
scene.add(tooltip3d.mesh);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(PLOT_HOME.x, PLOT_HOME.y + 0.25, PLOT_HOME.z);
controls.enableDamping = true;
controls.maxDistance = 30;
controls.update();

// ── desktop camera flights ────────────────────────────────────────────────

const BASE_FOV = 55;
let flight = null;
function flyTo({ pos, target, fov = BASE_FOV }) { flight = { pos: pos.clone(), target: target.clone(), fov }; }
controls.addEventListener('start', () => { flight = null; }); // the user took over

const SINGLE_VIEW = {
  pos: new THREE.Vector3(0.3, 2.0, 1.05),
  target: new THREE.Vector3(PLOT_HOME.x, PLOT_HOME.y + 0.25, PLOT_HOME.z),
};

function overviewView() {
  const R = dashboard.radius;
  const c = dashboard.center;
  // stand where your head would be in VR (just behind it) with a wide-angle
  // view, so the whole 150° × 150° wall fits; zooming in narrows it again
  return {
    pos: new THREE.Vector3(c.x, c.y, c.z + R * 0.5),
    target: new THREE.Vector3(c.x, c.y, c.z - R),
    fov: 112,
  };
}

function slotView(slot) {
  const s = slot.root.getWorldScale(new THREE.Vector3()).x;
  const target = slot.root.localToWorld(new THREE.Vector3(0, 0.3, 0));
  // back off along the direction the plot is meant to be read from
  const pos = target.clone().addScaledVector(dashboard.viewDirection(slot), 2.4 * s);
  return { pos, target };
}

// ── state & UI ────────────────────────────────────────────────────────────

let refreshTimer = null;
const baseUrl = () => ui.getState().endpoint || PLAYGROUND_URL;

const ui = new UI({
  catalog: CATALOG,
  onRun: state => run(state),
  onXR: mode => toggleXR(mode),
  onRefreshChange: secs => setAutoRefresh(secs),
  onPick: entry => pickEntry(entry),
  onDashboard: () => toggleDashboard(),
  onOverview: () => overview(),
});

const vrMenu = new VRMenu({
  catalog: CATALOG,
  onSelect: entry => pickEntry(entry),
  onAction: action => {
    const s = ui.getState();
    if (action === 'dashboard') toggleDashboard();
    if (action === 'refresh') refresh();
    if (action === 'log' && !dashboard) { ui.setState({ log: !s.log }); ui.run(); }
    if (action === 'auto') {
      const next = { 0: 1, 1: 5, 5: 10, 10: 15, 15: 30, 30: 60, 60: 0 }[s.refresh] ?? 0;
      ui.setState({ refresh: next });
      setAutoRefresh(next);
    }
  },
});
vrMenu.mesh.position.set(-1.15, 1.3, -0.55);
vrMenu.mesh.rotation.y = 0.9;
vrMenu.mesh.visible = false;
scene.add(vrMenu.mesh);

/** Catalog click (panel or headset menu). */
function pickEntry(entry) {
  if (!dashboard) { ui.loadEntry(entry); return; }
  ui.loadEntry(entry, { run: false }); // show its query in the editor
  const slot = dashboard.slotById(entry.id);
  if (slot) focusSlot(slot, { toggle: false });
}

async function run(state, { quiet = false } = {}) {
  if (dashboard) exitDashboard({ runSingle: false }); // Run always shows the single view
  if (!quiet) ui.setStatus('Querying…');
  vrMenu.setState({ activeId: state.id, log: state.log, refresh: state.refresh });
  try {
    const r = await single.load(state, { baseUrl: state.endpoint || PLAYGROUND_URL });
    if (!r) return; // superseded by a newer run
    if (!quiet) hideHover(); // a background refresh keeps the tooltip you're reading
    ui.setLabels(varyingLabels(r.data.entities || r.data.series));
    ui.setStatus(`${r.summary} · ${r.ms} ms · updated ${new Date().toLocaleTimeString()}`, 'ok');
    history.replaceState(null, '', '#' + ui.toHash());
  } catch (err) {
    console.error(err);
    ui.setStatus(err.message, 'error');
  }
}

let refreshing = false;

/** Re-query whatever is on screen. Manual refreshes show progress; auto ones are silent. */
async function refresh({ quiet = false } = {}) {
  if (refreshing) return; // the previous refresh is still running: skip, don't pile up
  refreshing = true;
  try {
    if (dashboard) await loadDashboard({ quiet });
    else await run(ui.getState(), { quiet });
  } finally {
    refreshing = false;
  }
}

function setAutoRefresh(secs) {
  clearInterval(refreshTimer);
  refreshTimer = secs > 0
    ? setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, secs * 1000)
    : null;
  vrMenu.setState({ refresh: secs });
}

// ── dashboard mode ────────────────────────────────────────────────────────

function toggleDashboard() {
  if (dashboard) exitDashboard();
  else enterDashboard();
}

function enterDashboard() {
  if (dashboard) return;
  dashboard = new Dashboard(CATALOG);
  scene.add(dashboard.root);
  single.root.visible = false;
  deskFocus = null;
  hideHover();
  if (scene.fog) scene.fog = FOG_DASHBOARD;
  environment.visible = false; // the wall extends below floor level
  ui.setDashboard(true);
  vrMenu.setState({ dashboard: true, activeId: null });
  // give the ring the whole screen; ☰ brings the panel back
  if (!document.body.classList.contains('panel-hidden')) {
    document.body.classList.add('panel-hidden');
    panelHiddenByDashboard = true;
  }
  if (!renderer.xr.isPresenting) flyTo(overviewView());
  history.replaceState(null, '', '#' + ui.toHash());
  loadDashboard();
}

async function loadDashboard({ quiet = false } = {}) {
  const dash = dashboard;
  const { ok, failed } = await dash.loadAll({
    baseUrl: baseUrl(),
    onProgress: p => !quiet && dash === dashboard && ui.setStatus(`Dashboard: loading ${p.ok + p.failed} / ${p.total}…`),
  });
  if (dash !== dashboard) return; // left the dashboard meanwhile
  const how = renderer.xr.isPresenting
    ? 'trigger: bring a plot to you / send it back · grip + move hand: rotate a plot · thumbstick: move / turn the wall'
    : 'click a plot to zoom in; Esc or Overview to zoom out';
  const when = ` · updated ${new Date().toLocaleTimeString()}`;
  ui.setStatus(`Dashboard: ${ok} plots${failed ? `, ${failed} failed (see console)` : ''}${when} · ${how}`, failed ? 'error' : 'ok');
}

function exitDashboard({ runSingle = true } = {}) {
  if (!dashboard) return;
  dashboard.dispose();
  dashboard = null;
  deskFocus = null;
  hideHover();
  single.root.visible = true;
  if (scene.fog) scene.fog = FOG_SINGLE;
  environment.visible = !isARSession;
  ui.setDashboard(false);
  vrMenu.setState({ dashboard: false });
  if (panelHiddenByDashboard) document.body.classList.remove('panel-hidden');
  panelHiddenByDashboard = false;
  if (!renderer.xr.isPresenting) flyTo(SINGLE_VIEW);
  history.replaceState(null, '', '#' + ui.toHash());
  if (runSingle) run(ui.getState());
}

/** Zoom into one dashboard plot: desktop flies the camera, VR brings the plot to you. */
function focusSlot(slot, { toggle = true } = {}) {
  if (!dashboard) return;
  vrMenu.setState({ activeId: slot.entry.id });
  if (renderer.xr.isPresenting) {
    if (toggle && dashboard.isOffWall(slot)) dashboard.sendHome(slot);
    else dashboard.focus(slot, inFrontOfViewer());
    return;
  }
  deskFocus = slot;
  flyTo(slotView(slot));
}

function overview() {
  if (!dashboard) return;
  dashboard.sendAllHome();
  deskFocus = null;
  vrMenu.setState({ activeId: null });
  if (!renderer.xr.isPresenting) flyTo(overviewView());
}

/** World pose 1.15 m in front of the headset, facing it, at table height. */
function inFrontOfViewer() {
  const cam = renderer.xr.getCamera();
  const head = cam.getWorldPosition(new THREE.Vector3());
  const dir = cam.getWorldDirection(new THREE.Vector3()).setY(0);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
  dir.normalize();
  const pos = head.clone().addScaledVector(dir, 1.15).setY(PLOT_HOME.y);
  const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-dir.x, -dir.z));
  return new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
}

window.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !dashboard) return;
  if (/^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName)) return;
  overview();
});

// ── hover / picking ───────────────────────────────────────────────────────

const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0.012; // trails are picked by their lines
const tooltipEl = document.getElementById('tooltip');

const activeSlots = () => (dashboard ? dashboard.slots : [single]);

function hideHover() {
  marker.visible = false;
  tooltip3d.hide();
  tooltipEl.hidden = true;
}

/** Closest data element under the current ray, across every visible plot. */
function pickData() {
  const hits = raycaster.intersectObjects(activeSlots().flatMap(s => s.pickables), false);
  for (const h of hits) {
    const info = slotOf(h.object)?.pick(h);
    if (info) return { hit: h, info };
  }
  return null;
}

function infoLines(info) {
  return dashboard ? [info.slot.title, ...info.lines] : info.lines;
}

function showMarker(info) {
  marker.position.copy(info.worldPoint);
  marker.visible = true;
}

const pointer = new THREE.Vector2();
let pointerInside = false;
let downAt = null;
renderer.domElement.addEventListener('pointermove', e => {
  // projection matrix already includes the view offset, so plain canvas NDC is right
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  pointerInside = true;
  tooltipEl.style.left = e.clientX + 16 + 'px';
  tooltipEl.style.top = e.clientY + 12 + 'px';
});
renderer.domElement.addEventListener('pointerleave', () => { pointerInside = false; hideHover(); });
renderer.domElement.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; });

// ?vrpreview shows the in-headset menu on desktop and makes it mouse-clickable.
const VR_PREVIEW = new URLSearchParams(location.search).has('vrpreview');
if (VR_PREVIEW) {
  vrMenu.mesh.visible = true;
  vrMenu.mesh.position.set(-0.75, 1.3, -1.2);
  vrMenu.mesh.rotation.y = 0.35;
}
function menuUV() {
  if (!vrMenu.mesh.visible) return null;
  return raycaster.intersectObject(vrMenu.mesh, false)[0]?.uv ?? null;
}

renderer.domElement.addEventListener('click', e => {
  // ignore the click that ends an orbit drag
  if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
  raycaster.setFromCamera(pointer, camera);
  const uv = menuUV();
  if (uv) { vrMenu.click(uv); return; }
  if (!dashboard) return;
  // anything belonging to a plot (bars, labels, board, base) zooms into it
  for (const h of raycaster.intersectObject(dashboard.root, true)) {
    const slot = slotOf(h.object);
    if (slot) {
      ui.loadEntry(slot.entry, { run: false });
      focusSlot(slot);
      return;
    }
  }
});

function desktopHover() {
  if (!pointerInside) return;
  raycaster.setFromCamera(pointer, camera);
  const uv = menuUV();
  vrMenu.hover(uv);
  if (uv) { hideHover(); return; }
  const res = pickData();
  if (!res) { hideHover(); return; }
  showMarker(res.info);
  tooltipEl.textContent = '';
  const v = document.createElement('div');
  v.className = 'val';
  v.textContent = res.info.title;
  tooltipEl.append(v);
  for (const l of infoLines(res.info)) {
    const d = document.createElement('div');
    d.className = 'line';
    d.textContent = l;
    tooltipEl.append(d);
  }
  tooltipEl.hidden = false;
}

// ── XR ────────────────────────────────────────────────────────────────────

let xrSession = null;
let isARSession = false;

async function detectXR() {
  if (!window.isSecureContext) {
    ui.setXRSupport({ vr: false, ar: false, reason: `WebXR only works on https:// or localhost, and this page is ${location.origin}. Run \`npm run dev:lan\` (https) or open it via localhost.` });
    return;
  }
  if (!navigator.xr) {
    ui.setXRSupport({ vr: false, ar: false, reason: 'this browser has no WebXR support (e.g. Firefox, desktop Safari). Use Chrome or Edge, or a headset browser.' });
    return;
  }
  const [vr, ar] = await Promise.all([
    navigator.xr.isSessionSupported('immersive-vr').catch(() => false),
    navigator.xr.isSessionSupported('immersive-ar').catch(() => false),
  ]);
  ui.setXRSupport({
    vr, ar,
    note: vr && emulated
      ? 'No headset found, so an emulated Meta Quest 3 (IWER) is active. Enter VR, then drive the headset and controllers with the on-screen overlay. Add ?emulate=0 to the URL to turn it off.'
      : null,
    reason: vr ? null : new URLSearchParams(location.search).get('emulate') === '0'
      ? 'no VR device found and the built-in headset emulator is off (?emulate=0). Remove it from the URL to emulate a Meta Quest 3.'
      : 'no VR device found and the headset emulator could not start (see the browser console). Open this page on a headset with `npm run dev:lan`.',
  });
}

// The emulator extension or a newly connected headset changes the answer.
navigator.xr?.addEventListener?.('devicechange', detectXR);

async function toggleXR(mode) {
  if (xrSession) { await xrSession.end(); return; }
  try {
    const session = await navigator.xr.requestSession(mode, {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    xrSession = session;
    const isAR = mode === 'immersive-ar';
    isARSession = isAR;
    scene.background = isAR ? null : BG;
    scene.fog = isAR ? null : (dashboard ? FOG_DASHBOARD : FOG_SINGLE);
    environment.visible = !isAR && !dashboard;
    vrMenu.mesh.visible = true;
    tooltipEl.hidden = true;
    session.addEventListener('end', onXREnd);
    await renderer.xr.setSession(session);
    ui.setXRActive(true);
  } catch (err) {
    xrSession = null;
    ui.setStatus(`Could not start XR: ${err.message}`, 'error');
  }
}

function onXREnd() {
  xrSession = null;
  isARSession = false;
  scene.background = BG;
  scene.fog = dashboard ? FOG_DASHBOARD : FOG_SINGLE;
  environment.visible = !dashboard;
  vrMenu.mesh.visible = VR_PREVIEW;
  hideHover();
  for (const c of controllers) stopRotate(c);
  if (dashboard) {
    dashboard.sendAllHome();
    dashboard.root.position.set(0, 0, 0);
    dashboard.root.rotation.set(0, 0, 0);
    dashboard.setDistance(1);
  }
  ui.setXRActive(false);
  layoutCamera();
  detectXR();
}

const controllerModels = new XRControllerModelFactory();
const controllers = [0, 1].map(i => {
  const c = renderer.xr.getController(i);
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.8 }));
  ray.scale.z = 3;
  c.add(ray);
  c.userData = { ray, gamepad: null, hover: null };

  c.addEventListener('connected', e => {
    c.userData.gamepad = e.data.gamepad || null;
    ray.visible = e.data.targetRayMode !== 'gaze';
  });
  c.addEventListener('disconnected', () => { c.userData.gamepad = null; });
  c.addEventListener('select', () => {
    const h = c.userData.hover;
    if (h?.kind === 'menu') vrMenu.click(h.uv);
    else if (h?.kind === 'slot') focusSlot(h.slot);
  });
  // grip + hand movement rotates a plot in place (turntable)
  c.addEventListener('squeezestart', () => startRotate(c));
  c.addEventListener('squeezeend', () => stopRotate(c));
  scene.add(c);

  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModels.createControllerModel(grip));
  scene.add(grip);
  return c;
});

// Turntable rotation: while grip is held, hand movement turns the plot about
// its own centre. Left/right (relative to your view) spins it around its
// vertical axis, up/down tilts it. The plot itself does not move.
const ROTATE_GAIN = 5;                // radians per metre of hand travel
const MAX_PITCH = 80 * Math.PI / 180; // never tip a chart over

function startRotate(c) {
  if (c.userData.rotating) return;
  let slot = single;
  if (dashboard) {
    slot = c.userData.hover?.kind === 'slot' ? c.userData.hover.slot : null;
    if (!slot) return;
    vrMenu.setState({ activeId: slot.entry.id });
  }
  const cam = renderer.xr.getCamera();
  // "right" as the viewer sees it, kept horizontal
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())).setY(0).normalize();
  c.userData.rotating = {
    slot,
    start: c.getWorldPosition(new THREE.Vector3()),
    yaw0: slot.userYaw,
    pitch0: slot.userPitch,
    right,
  };
}

function stopRotate(c) { c.userData.rotating = null; }

function updateRotate(c) {
  const r = c.userData.rotating;
  if (!r) return;
  if (dashboard ? !dashboard.slots.includes(r.slot) : r.slot !== single) { c.userData.rotating = null; return; }
  const d = c.getWorldPosition(new THREE.Vector3()).sub(r.start);
  r.slot.userYaw = r.yaw0 + d.dot(r.right) * ROTATE_GAIN;
  r.slot.userPitch = THREE.MathUtils.clamp(r.pitch0 - d.y * ROTATE_GAIN, -MAX_PITCH, MAX_PITCH);
}

const xrCamPos = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function rotateAbout(obj, pivot, angle) {
  obj.position.sub(pivot).applyAxisAngle(Y_AXIS, angle).add(pivot);
  obj.rotateOnWorldAxis(Y_AXIS, angle);
}

function xrFrame(dt) {
  renderer.xr.getCamera().getWorldPosition(xrCamPos);
  let shown = false;
  let menuHover = null;
  // in the dashboard, boards and hit boxes make whole plots easy to point at
  const extra = dashboard ? dashboard.slots.flatMap(s => (s.hitbox ? [s.board.mesh, s.hitbox] : [s.board.mesh])) : [];
  for (const c of controllers) {
    c.userData.hover = null;
    raycaster.setFromXRController(c);
    const targets = [vrMenu.mesh, ...activeSlots().flatMap(s => s.pickables), ...extra];
    const hits = raycaster.intersectObjects(targets, false);
    let dist = 6;
    let pointedSlot = null;
    for (const h of hits) {
      if (h.object === vrMenu.mesh) {
        if (!pointedSlot) { c.userData.hover = { kind: 'menu', uv: h.uv }; menuHover = h.uv; dist = h.distance; }
        break;
      }
      const slot = slotOf(h.object);
      if (!slot) continue;
      if (!pointedSlot) { pointedSlot = slot; dist = h.distance; }
      if (slot !== pointedSlot) break;      // only look inside the first plot hit
      if (h.object.userData.hitbox || h.object === slot.board.mesh) continue; // keep looking for data inside it
      const info = slot.pick(h);
      if (info) {
        dist = h.distance;
        if (!shown) {
          showMarker(info);
          tooltip3d.show({ ...info, lines: infoLines(info) }, info.worldPoint, xrCamPos);
          shown = true;
        }
        break;
      }
    }
    if (dashboard && pointedSlot) c.userData.hover = { kind: 'slot', slot: pointedSlot };
    c.userData.ray.scale.z = dist;

    updateRotate(c);

    // thumbstick: dashboard → move / turn the wall; single view → scale the plot
    const gp = c.userData.gamepad;
    if (gp && gp.axes.length >= 4) {
      const [, , x, y] = gp.axes;
      if (dashboard) {
        // push forward: the wall comes closer (plots look bigger); pull back: it recedes
        if (Math.abs(y) > 0.2) dashboard.setDistance(dashboard.distance * (1 + y * dt * 0.9));
        if (Math.abs(x) > 0.2) rotateAbout(dashboard.root, new THREE.Vector3(xrCamPos.x, 0, xrCamPos.z), -x * dt * 1.2);
      } else if (Math.abs(y) > 0.2) {
        singleScale.setScalar(THREE.MathUtils.clamp(singleScale.x * (1 - y * dt * 0.9), 0.2, 6));
      }
    }
  }
  vrMenu.hover(menuHover);
  if (!shown) { marker.visible = false; tooltip3d.hide(); }
}

// dev-only handle for scripted tests (stripped from production builds)
if (import.meta.env.DEV) window.__vmxr = { controllers, raycaster, slotOf, renderer, single, get dashboard() { return dashboard; } };

// ── loop ──────────────────────────────────────────────────────────────────

let lastTime = 0;
renderer.setAnimationLoop(time => {
  const dt = Math.min((time - lastTime) / 1000 || 0, 0.1);
  lastTime = time;
  if (renderer.xr.isPresenting) {
    xrFrame(dt);
  } else {
    if (flight) {
      const k = 1 - Math.exp(-dt * 4);
      camera.position.lerp(flight.pos, k);
      controls.target.lerp(flight.target, k);
      camera.fov += (flight.fov - camera.fov) * k;
      camera.updateProjectionMatrix();
      if (camera.position.distanceTo(flight.pos) < 0.01 && Math.abs(camera.fov - flight.fov) < 0.1) flight = null;
    }
    controls.update();
    desktopHover();
  }
  if (single.root.visible) single.applyPose(PLOT_HOME, IDENTITY_Q, singleScale, 1 - Math.exp(-dt * 12));
  if (dashboard) {
    dashboard.update(dt);
    dashboard.faceBoards(renderer.xr.isPresenting ? xrCamPos : camera.position);
  }
  renderer.render(scene, camera);
});

// Shift the projection centre right so the plot isn't hidden under the side panel.
function layoutCamera() {
  if (renderer.xr.isPresenting) return; // the XR session owns the framebuffer
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  const panelOpen = !document.body.classList.contains('panel-hidden');
  const panelW = document.getElementById('panel').offsetWidth + 24;
  if (panelOpen && w > 900) camera.setViewOffset(w, h, -panelW / 2, 0, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', layoutCamera);
new MutationObserver(layoutCamera).observe(document.body, { attributes: true, attributeFilter: ['class'] });
layoutCamera();

// ── boot ──────────────────────────────────────────────────────────────────

// Emulate a headset (IWER) when none is present, then check what XR we have.
let emulated = null;
maybeInstallEmulator()
  .then(device => { emulated = device; })
  .catch(err => console.warn('IWER emulator failed to load:', err))
  .finally(detectXR);

if (!ui.fromHash(PLAYGROUND_URL)) ui.loadEntry(CATALOG[0], { run: false });
const initial = ui.getState();
setAutoRefresh(initial.refresh);
if (new URLSearchParams(location.hash.slice(1)).get('dashboard') === '1') {
  enterDashboard();
  // jump straight to the overview instead of flying in from the single view
  if (flight) {
    camera.position.copy(flight.pos);
    controls.target.copy(flight.target);
    camera.fov = flight.fov;
    camera.updateProjectionMatrix();
    flight = null;
  }
} else {
  run(initial);
}

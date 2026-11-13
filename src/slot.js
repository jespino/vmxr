import * as THREE from 'three';
import { fetchForSpec, stateToSpec, specQueryText } from './fetch.js';
import { buildViz } from './viz.js';
import { InfoBoard } from './vrpanels.js';

// not rendered, but still hit by raycasts; double-sided so a ray that starts
// inside the box (a big plot close to you) still hits it
const HITBOX_MATERIAL = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
const DEFAULT_PIVOT = new THREE.Vector3(0, 0.3, 0);
const TMP_Q = new THREE.Quaternion(), TMP_Q2 = new THREE.Quaternion();
const TMP_E = new THREE.Euler();
const TMP_V = new THREE.Vector3(), TMP_V2 = new THREE.Vector3();

/**
 * One plot in the world: its query state, the 3D visualisation and the info
 * board above it, all under `root` so it can be placed, moved or scaled as a
 * unit. Single view uses one slot; the dashboard uses one per catalog entry.
 */

export class PlotSlot {
  constructor({ title = '' } = {}) {
    this.root = new THREE.Group();
    this.root.userData.slot = this;
    this.board = new InfoBoard();
    this.board.mesh.position.set(0, 1.0, -0.78);
    this.root.add(this.board.mesh);
    this.title = title;
    this.state = null;
    this.spec = null;
    this.viz = null;
    this.data = null;
    this.seq = 0;
    this.abort = null;
    // turntable rotation the viewer applied by hand (radians), about the
    // plot's own centre: yaw around its vertical axis, pitch = tilt
    this.userYaw = 0;
    this.userPitch = 0;
  }

  resetRotation() { this.userYaw = 0; this.userPitch = 0; }

  /**
   * Move toward a base pose (position / quaternion / scale of the plot's
   * origin) with the hand rotation applied around the plot's centre, so the
   * plot turns in place instead of swinging around its base. k = easing
   * factor (1 = snap).
   */
  applyPose(pos, quat, scale, k = 1) {
    const user = TMP_Q.setFromEuler(TMP_E.set(this.userPitch, this.userYaw, 0, 'XYZ'));
    const q = TMP_Q2.copy(quat).multiply(user);
    const c = this.hitbox ? this.hitbox.position : DEFAULT_PIVOT;
    // pos + quat·(c·s) − q·(c·s): keeps the centre where it would be unrotated
    const cs = TMP_V.copy(c).multiply(scale);
    const p = TMP_V2.copy(cs).applyQuaternion(quat).add(pos).sub(cs.applyQuaternion(q));
    this.root.position.lerp(p, k);
    this.root.quaternion.slerp(q, k);
    this.root.scale.lerp(scale, k);
  }

  get pickables() { return this.viz ? this.viz.pickables : []; }

  /**
   * Fetch and (re)build. Resolves to { data, viz, ms, summary }, or null when
   * superseded by a newer load. Rejects on query/build errors (also shown on
   * the board).
   */
  async load(state, { baseUrl }) {
    this.state = state;
    this.title = state.title || this.title;
    const spec = stateToSpec(state);
    const seq = ++this.seq;
    this.abort?.abort();
    this.abort = new AbortController();
    const t0 = performance.now();
    try {
      const data = await fetchForSpec(spec, { baseUrl, signal: this.abort.signal });
      if (seq !== this.seq) return null;
      const ms = Math.round(performance.now() - t0);
      // Fast auto-refresh mostly returns identical data (range queries only
      // gain a point per step): keep the current 3D objects in that case.
      // Nothing is redrawn, not even the board (its texture upload is not free).
      const fp = JSON.stringify(spec) + fingerprint(data);
      if (this.viz && fp === this.fp) {
        return { data, viz: this.viz, ms, summary: describe(data, spec, this.viz), unchanged: true };
      }
      // one rebuild at a time, with frames rendered in between (no hitch when
      // many plots change in the same refresh)
      await nextBuildTurn();
      if (seq !== this.seq) return null;
      this.fp = fp;
      const viz = buildViz(data, spec);
      if (this.viz) { this.root.remove(this.viz.group); this.viz.dispose(); }
      this.viz = viz;
      this.spec = spec;
      this.data = data;
      // keep the board clear of tall plots (measured before parenting = local units)
      const box = new THREE.Box3().setFromObject(viz.group);
      this.board.mesh.position.y = Math.max(1.0, box.max.y + 0.22);
      this.root.add(viz.group);
      this.setHitbox(box);
      const summary = describe(data, spec, viz);
      this.board.set({
        title: this.title, query: specQueryText(spec),
        status: `${summary} · ${ms} ms · updated ${new Date().toLocaleTimeString()}`,
      });
      return { data, viz, ms, summary };
    } catch (err) {
      if (err.name === 'AbortError' || seq !== this.seq) return null;
      this.board.set({ title: this.title, query: specQueryText(spec), status: '⚠ ' + err.message, error: true });
      throw err;
    }
  }

  /**
   * Invisible box around the whole plot, so a controller ray pointed anywhere
   * at it selects the plot, even where the data itself is sparse or low.
   */
  setHitbox(box) {
    if (this.hitbox) { this.hitbox.geometry.dispose(); this.root.remove(this.hitbox); }
    const size = box.getSize(new THREE.Vector3());
    const geo = new THREE.BoxGeometry(size.x, Math.max(size.y, 0.3), size.z);
    this.hitbox = new THREE.Mesh(geo, HITBOX_MATERIAL);
    box.getCenter(this.hitbox.position);
    this.hitbox.position.y = box.min.y + Math.max(size.y, 0.3) / 2;
    this.hitbox.userData.hitbox = true;
    this.root.add(this.hitbox);
  }

  /** Hover info for a raycast hit on one of this slot's pickables, with a world-space point. */
  pick(hit) {
    const info = this.viz?.pick(hit);
    if (!info) return null;
    info.worldPoint = this.viz.group.localToWorld(info.point.clone());
    info.slot = this;
    return info;
  }

  dispose() {
    this.abort?.abort();
    this.hitbox?.geometry.dispose();
    if (this.viz) this.viz.dispose();
    this.root.removeFromParent();
  }
}

/** The slot that owns a scene object, if any. */
export function slotOf(obj) {
  for (let o = obj; o; o = o.parent) if (o.userData?.slot) return o.userData.slot;
  return null;
}

let buildQueue = Promise.resolve();
/** Resolves when it's this caller's turn to build; turns are ~a frame apart. */
function nextBuildTurn() {
  const turn = buildQueue.then(() => new Promise(r => setTimeout(r, 12)));
  buildQueue = turn;
  return turn;
}

/** Cheap content hash of a query result (labels, times and every value). */
function fingerprint(data) {
  let h = 0;
  const mix = x => { h = (Math.imul(h ^ x, 0x5bd1e995) + 0x9e3779b9) | 0; };
  const num = v => mix(Number.isFinite(v) ? Math.round(v * 1e6) | 0 : -1);
  const str = t => { for (let i = 0; i < t.length; i++) mix(t.charCodeAt(i)); };
  if (data.times) { mix(data.times.length); num(data.times[0]); }
  const rows = data.entities || data.series;
  mix(rows.length);
  for (const r of rows) {
    str(JSON.stringify(r.labels));
    for (const k of data.entities ? ['x', 'y', 'z'] : ['value', 'values']) {
      const v = r[k];
      if (v === undefined) continue;
      if (typeof v === 'number') num(v); else for (let i = 0; i < v.length; i++) num(v[i]);
    }
  }
  return h.toString(36);
}

function describe(data, spec, viz) {
  if (data.entities) return `${data.entities.length} entities joined on {${data.keys.join(', ')}}`;
  if (spec.viz === 'calendar') return `${viz.info.days} days × 24 h`;
  return `${data.series.length} series${data.times ? ` × ${data.times.length} points` : ''}`;
}

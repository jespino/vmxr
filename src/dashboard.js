import * as THREE from 'three';
import { PlotSlot } from './slot.js';
import { entryToState } from './fetch.js';
import { makeLabel } from './text.js';

// The dashboard is a section of a sphere centred on the viewer's head:
// H_SPAN degrees left→right, V_SPAN degrees bottom→top, one catalog group per
// row. Every plot is tilted to face the centre from the angle a plot is best
// read at (VIEW_ELEV above its front), like in single view.
const DEG = Math.PI / 180;
const H_SPAN = 150 * DEG;
const V_SPAN = 150 * DEG;
const RADIUS = 3.4;        // metres from your head to the plots
const MAX_SCALE = 0.6;     // plots never grow beyond 0.6 × single-view size
const PLOT_W = 2.3;        // footprint of a plot + its labels at scale 1 (m)
const PLOT_H = 1.7;        // height of a plot + its info board at scale 1 (m)
const EYE = new THREE.Vector3(0, 1.6, 0);
const VIEW_ELEV = 22 * DEG;
const CONCURRENCY = 4;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export class Dashboard {
  constructor(catalog) {
    this.root = new THREE.Group();
    this.slots = [];
    this.labels = [];
    this.focused = null;
    this.distance = 1; // wall distance factor (VR thumbstick)
    this.radius = RADIUS;
    this.center = EYE.clone();

    const groups = [];
    for (const e of catalog) {
      let g = groups.find(x => x.name === e.group);
      if (!g) groups.push(g = { name: e.group, entries: [] });
      g.entries.push(e);
    }

    // Row elevations split V_SPAN evenly; groups are assigned centre-out
    // (first group at eye level, then above, below, above, …).
    const rows = groups.length;
    const rowAng = V_SPAN / rows;
    const elevs = Array.from({ length: rows }, (_, i) => -V_SPAN / 2 + (i + 0.5) * rowAng);
    const rank = e => Math.round(Math.abs(e) / DEG) * 2 + (e < 0 ? 1 : 0);
    const order = elevs.map((_, i) => i).sort((a, b) => rank(elevs[a]) - rank(elevs[b]));
    const rowOf = groups.map((g, gi) => ({ g, e: elevs[order[gi]] }));

    // Each row spreads across the full H_SPAN. One plot size for the whole
    // wall: the largest that fits the most crowded row and the row height.
    const spacing = ({ g, e }) => (H_SPAN / g.entries.length) * RADIUS * Math.cos(e);
    const scale = Math.min(
      MAX_SCALE,
      (rowAng * RADIUS * 0.9) / PLOT_H,
      ...rowOf.map(r => spacing(r) * 0.92 / PLOT_W),
    );
    this.slotScale = scale;

    for (const { g, e } of rowOf) {
      const n = g.entries.length;
      const step = H_SPAN / n;
      g.entries.forEach((entry, j) => {
        const az = -H_SPAN / 2 + (j + 0.5) * step;
        const slot = new PlotSlot({ title: entry.title });
        slot.entry = entry;
        slot.dir = new THREE.Vector3(Math.sin(az) * Math.cos(e), Math.sin(e), -Math.cos(az) * Math.cos(e));
        // yaw to face the centre, then pitch so the ideal viewing angle points at it
        const quat = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, -az)
          .multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, VIEW_ELEV + e));
        slot.home = { pos: new THREE.Vector3(), quat, scale: new THREE.Vector3().setScalar(scale) };
        slot.board.set({ title: entry.title, query: '', status: 'loading…' });
        this.root.add(slot.root);
        this.slots.push(slot);
      });
      // row title just outside the left end of the row
      const azL = -H_SPAN / 2 - 0.06;
      const label = makeLabel(g.name.toUpperCase(), { height: 0.16, color: '#cdd7ff', background: 'rgba(30,36,60,0.85)' });
      label.center.set(1, 0.5);
      label.userData.dir = new THREE.Vector3(Math.sin(azL) * Math.cos(e), Math.sin(e) + 0.05, -Math.cos(azL) * Math.cos(e));
      this.root.add(label);
      this.labels.push(label);
    }

    this.layout();
    for (const s of this.slots) {
      s.root.position.copy(s.home.pos);
      s.root.quaternion.copy(s.home.quat);
      s.root.scale.copy(s.home.scale);
    }
  }

  /** Recompute home positions for the current wall distance. */
  layout() {
    const r = RADIUS * this.distance;
    this.radius = r;
    for (const s of this.slots) s.home.pos.copy(this.center).addScaledVector(s.dir, r);
    for (const l of this.labels) l.position.copy(this.center).addScaledVector(l.userData.dir, r * 0.97);
  }

  /** Move the whole wall nearer (k < 1) or farther (k > 1); plots keep their size. */
  setDistance(factor) {
    this.distance = THREE.MathUtils.clamp(factor, 0.3, 2.5);
    this.layout();
  }

  slotById(id) { return this.slots.find(s => s.entry.id === id) || null; }

  /** Load every plot, a few at a time. Resolves to { ok, failed }. */
  async loadAll({ baseUrl, onProgress }) {
    let next = 0, ok = 0, failed = 0;
    const worker = async () => {
      while (next < this.slots.length) {
        const slot = this.slots[next++];
        try {
          const r = await slot.load(entryToState(slot.entry), { baseUrl });
          if (r) ok++;
        } catch (err) {
          failed++;
          console.warn(`dashboard: ${slot.entry.id}:`, err.message);
        }
        onProgress?.({ ok, failed, total: this.slots.length });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return { ok, failed };
  }

  /**
   * Pull a slot off the wall to a world-space pose (VR: full size in front of
   * you), sending the previously focused one home. Pass null to just send the
   * focused slot back. A plot keeps its hand rotation when brought closer.
   */
  focus(slot, worldMatrix = null) {
    if (this.focused && this.focused !== slot) this.sendHome(this.focused);
    this.focused = slot;
    if (slot) slot.focusWorld = worldMatrix;
  }

  /** Is this slot off the wall (brought in front of the viewer)? */
  isOffWall(slot) { return !!slot.focusWorld; }

  /** Back to its place on the wall, facing the centre again. */
  sendHome(slot) {
    slot.focusWorld = null;
    slot.resetRotation();
    if (this.focused === slot) this.focused = null;
  }

  sendAllHome() {
    for (const s of this.slots) { s.focusWorld = null; s.resetRotation(); }
    this.focused = null;
  }

  /** Ease every slot toward its target pose. Call once per frame. */
  update(dt) {
    const k = 1 - Math.exp(-dt * 7);
    const inv = new THREE.Matrix4();
    this.root.updateMatrixWorld();
    for (const s of this.slots) {
      let target = s.home;
      if (s.focusWorld) {
        // express the world pose in wall-local coordinates (the wall may be turned)
        inv.copy(this.root.matrixWorld).invert().multiply(s.focusWorld);
        const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
        inv.decompose(pos, quat, scale);
        target = { pos, quat, scale };
      }
      s.applyPose(target.pos, target.quat, target.scale, k);
    }
  }

  /** Turn every info board to face the viewer so none is read at an angle or mirrored. */
  faceBoards(viewerWorldPos) {
    for (const s of this.slots) s.board.mesh.lookAt(viewerWorldPos);
  }

  /** World-space direction a plot is best viewed from (for the desktop camera). */
  viewDirection(slot) {
    const local = new THREE.Vector3(0, Math.sin(VIEW_ELEV), Math.cos(VIEW_ELEV));
    return local.applyQuaternion(slot.root.getWorldQuaternion(new THREE.Quaternion())).normalize();
  }

  dispose() {
    for (const s of this.slots) s.dispose();
    this.root.removeFromParent();
  }
}

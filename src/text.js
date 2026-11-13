import * as THREE from 'three';

const FONT = '500 48px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/**
 * Camera-facing text label. `height` is the world-space height of one line.
 */
export function makeLabel(text, { height = 0.03, color = '#e6e9ef', background = null, maxChars = 40 } = {}) {
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '…';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = FONT;
  const pad = background ? 18 : 6;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = 64;
  canvas.width = w;
  canvas.height = h;
  ctx.font = FONT;
  if (background) {
    ctx.fillStyle = background;
    roundRect(ctx, 0, 0, w, h, 14);
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, h / 2 + 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(height * (w / h), height, 1);
  sprite.userData.isLabel = true;
  return sprite;
}

/**
 * Text lying flat on the table, anchored at its left end and turned by
 * `angle` around Y (0 = reads along +x, -π/2 = reads toward the viewer).
 */
export function makeFlatLabel(text, { height = 0.03, color = '#aeb7c9', maxChars = 40, angle = 0 } = {}) {
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '…';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = FONT;
  const w = Math.ceil(ctx.measureText(text).width) + 12;
  const h = 64;
  canvas.width = w;
  canvas.height = h;
  ctx.font = FONT;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 6, h / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const gw = height * (w / h);
  const geo = new THREE.PlaneGeometry(gw, height);
  geo.translate(gw / 2, 0, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  mesh.rotation.set(-Math.PI / 2, angle, 0, 'YXZ');
  return mesh;
}

/** A flat panel whose content is drawn into a canvas via `draw(ctx, w, h)`. */
export class CanvasPanel {
  constructor(widthM, heightM, pxPerM = 1400) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(widthM * pxPerM);
    this.canvas.height = Math.round(heightM * pxPerM);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(widthM, heightM),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.mesh.renderOrder = 10;
  }

  redraw(draw) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    draw(ctx, canvas.width, canvas.height);
    this.texture.needsUpdate = true;
  }

  /** uv (0..1, origin bottom-left) → canvas pixel coords */
  toPx(uv) {
    return { x: uv.x * this.canvas.width, y: (1 - uv.y) * this.canvas.height };
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function wrapText(ctx, text, maxWidth) {
  const words = text.split(/(\s+)/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line + w;
    if (ctx.measureText(test).width > maxWidth && line.trim()) {
      lines.push(line.trimEnd());
      line = w.trimStart();
    } else {
      line = test;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  // Hard-break very long tokens (PromQL has few spaces).
  return lines.flatMap(l => {
    if (ctx.measureText(l).width <= maxWidth) return [l];
    const out = [];
    let cur = '';
    for (const ch of l) {
      if (ctx.measureText(cur + ch).width > maxWidth) { out.push(cur); cur = ch; } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  });
}

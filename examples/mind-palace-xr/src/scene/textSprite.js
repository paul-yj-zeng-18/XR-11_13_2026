import * as THREE from 'three';

export function wrapText(ctx, text, maxWidth) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
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

export function canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const FONT = '"Inter", "Segoe UI", system-ui, sans-serif';

function drawLabel(canvas, { title, body, accent = '#8ecae6', maxLines = 3, plain = false, size = 1 }) {
  const ctx = canvas.getContext('2d');
  const W = 512;
  const pad = 22;
  const titleFont = `700 ${Math.round(30 * size)}px ${FONT}`;
  const bodyFont = `500 ${Math.round(28 * size)}px ${FONT}`;
  ctx.font = bodyFont;
  let lines = body ? wrapText(ctx, body, W - pad * 2) : [];
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] += '…';
  }
  const titleH = title ? 40 * size : 0;
  const H = Math.ceil(pad + titleH + lines.length * 34 * size + pad * 0.7);
  canvas.width = W;
  canvas.height = H;

  if (!plain) {
    roundRect(ctx, 3, 3, W - 6, H - 6, 18);
    ctx.fillStyle = 'rgba(8, 10, 20, 0.78)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = accent;
    ctx.stroke();
  }
  ctx.textBaseline = 'top';
  let y = pad * 0.8;
  if (title) {
    ctx.font = titleFont;
    ctx.fillStyle = accent;
    ctx.fillText(title.toUpperCase(), pad, y);
    y += titleH;
  }
  ctx.font = bodyFont;
  ctx.fillStyle = '#f1f5ff';
  if (plain) {
    ctx.shadowColor = accent;
    ctx.shadowBlur = 16;
  }
  for (const l of lines) {
    ctx.fillText(l, pad, y);
    y += 34 * size;
  }
  return { W, H };
}

/** Billboard label that always faces the viewer. Call sprite.userData.update(opts) to redraw. */
export function makeLabel(opts) {
  const canvas = document.createElement('canvas');
  const texture = canvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  const width = opts.width ?? 0.9;

  const update = (next) => {
    Object.assign(opts, next);
    const { W, H } = drawLabel(canvas, opts);
    texture.needsUpdate = true;
    sprite.scale.set(width, (width * H) / W, 1);
  };
  update({});
  sprite.userData.update = update;
  sprite.userData.isLabel = true;
  return sprite;
}

/** Big glowing text with no background (room titles, lobby sign). */
export function makeTitle(text, { width = 3, accent = '#ffffff', size = 1.6 } = {}) {
  return makeLabel({ body: text, width, accent, plain: true, size, maxLines: 2 });
}

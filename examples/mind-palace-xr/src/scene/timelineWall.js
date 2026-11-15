import * as THREE from 'three';
import { canvasTexture, roundRect, wrapText } from './textSprite.js';
import { styleColor } from './roomGenerator.js';

const FONT = '"Inter", "Segoe UI", system-ui, sans-serif';

function drawCard(convo, index, style) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 384;
  const ctx = c.getContext('2d');
  const h = Math.round(style.hue * 360);

  roundRect(ctx, 4, 4, 504, 376, 22);
  ctx.fillStyle = 'rgba(10, 12, 24, 0.9)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = `hsl(${h}, 80%, 65%)`;
  ctx.stroke();

  const d = new Date(convo.date);
  ctx.textBaseline = 'top';
  ctx.fillStyle = `hsl(${h}, 80%, 72%)`;
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText(`#${index + 1} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`, 24, 22);

  ctx.fillStyle = '#cfd8ff';
  ctx.font = `500 22px ${FONT}`;
  let y = 62;
  if (convo.where) {
    ctx.fillText(`📍 ${convo.where}`.slice(0, 40), 24, y);
    y += 30;
  }
  if (convo.howMet) {
    ctx.fillText(`🤝 ${convo.howMet}`.slice(0, 40), 24, y);
    y += 30;
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = `500 23px ${FONT}`;
  const lines = wrapText(ctx, convo.summary || '', 464).slice(0, 5);
  y += 8;
  for (const l of lines) {
    ctx.fillText(l, 24, y);
    y += 30;
  }

  let x = 24;
  ctx.font = `600 18px ${FONT}`;
  for (const k of (convo.keywords || []).slice(0, 4)) {
    const w = ctx.measureText(k).width + 20;
    if (x + w > 490) break;
    roundRect(ctx, x, 334, w, 30, 15);
    ctx.fillStyle = `hsla(${h}, 70%, 50%, 0.35)`;
    ctx.fill();
    ctx.fillStyle = '#e8ecff';
    ctx.fillText(k, x + 10, 340);
    x += w + 8;
  }
  return canvasTexture(c);
}

/**
 * Past conversations laid out left->right (oldest->newest) along the back wall.
 * Returns { group, interactables }.
 */
export function buildTimeline(conversations, style, room) {
  const group = new THREE.Group();
  group.name = 'timeline';
  const interactables = [];
  const sorted = [...conversations].sort((a, b) => new Date(a.date) - new Date(b.date));
  const usable = room.W - 1.4;
  const perRow = 5;
  const n = Math.max(sorted.length, 1);
  const cols = Math.min(n, perRow);
  const cardW = Math.min(1.5, usable / cols - 0.15);
  const cardH = cardW * 0.75;
  const z = room.backWallZ + 0.04;
  const topY = Math.min(2.25, room.H - 1.0);

  const accent = styleColor(style, 0.9, 0.65);
  const lineMat = new THREE.MeshBasicMaterial({ color: accent });
  const rows = Math.ceil(n / perRow);

  for (let r = 0; r < rows; r++) {
    const y = topY - r * (cardH + 0.35);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(usable, 0.025, 0.02), lineMat);
    rail.position.set(0, y + cardH / 2 + 0.14, z);
    group.add(rail);
  }

  if (!sorted.length) {
    const tex = drawCard(
      { date: new Date().toISOString(), summary: 'No conversations yet. Start an encounter to add the first one.', keywords: [] },
      0,
      style,
    );
    const card = new THREE.Mesh(new THREE.PlaneGeometry(cardW, cardH), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.6 }));
    card.position.set(0, topY, z);
    group.add(card);
    return { group, interactables };
  }

  sorted.forEach((convo, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const inRow = Math.min(perRow, sorted.length - row * perRow);
    const x = (col - (inRow - 1) / 2) * (cardW + 0.15);
    const y = topY - row * (cardH + 0.35);

    const card = new THREE.Mesh(
      new THREE.PlaneGeometry(cardW, cardH),
      new THREE.MeshBasicMaterial({ map: drawCard(convo, i, style), transparent: true }),
    );
    card.position.set(x, y, z);
    card.userData = { kind: 'convo', convoId: convo.id };
    group.add(card);
    interactables.push(card);

    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), lineMat);
    dot.position.set(x, y + cardH / 2 + 0.14, z + 0.02);
    group.add(dot);
  });

  return { group, interactables };
}

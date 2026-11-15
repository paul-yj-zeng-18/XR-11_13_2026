import * as THREE from 'three';
import { canvasTexture, makeLabel, makeTitle } from './textSprite.js';

// ---------------------------------------------------------------------------
// Voiceprint -> room style. Same voice always produces the same room.
//   pitch        -> base hue (deep voices = indigo/teal, high voices = coral/amber)
//   pitch spread -> saturation (expressive speakers get more vivid rooms)
//   brightness   -> ceiling height + width (bright voices = airy rooms)
//   MFCC shape   -> the wallpaper waves + the ribbon across the ceiling
// ---------------------------------------------------------------------------

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashVoiceprint(vp, fallback) {
  if (!vp?.mfccMean) return hashString(fallback || 'guest');
  const q = vp.mfccMean.map((v) => Math.round(v / 2)).join(',') + `|${Math.round((vp.pitch || 0) / 8)}`;
  return hashString(q);
}

export function deriveRoomStyle(vp, overrides = {}, name = '') {
  const pitch = vp?.pitch || 150;
  const t = clamp01((Math.log(pitch) - Math.log(85)) / (Math.log(300) - Math.log(85)));
  const brightness = clamp01(((vp?.centroid || 1600) - 800) / 2600);
  const expressiveness = clamp01((vp?.pitchStd || 20) / 55);
  const seed = hashVoiceprint(vp, name);
  const rng = mulberry32(seed);

  const coeffs = vp?.mfccMean?.slice(1, 7) ?? Array.from({ length: 6 }, () => rng() * 2 - 1);
  const maxAbs = Math.max(...coeffs.map(Math.abs), 1e-6);
  const wave = coeffs.map((c) => c / maxAbs);

  const scale = overrides.scale ?? 1;
  return {
    seed,
    hue: (((lerp(0.62, 0.02, t) + (overrides.hueShift ?? 0)) % 1) + 1) % 1,
    saturation: lerp(0.35, 0.85, expressiveness),
    width: lerp(7, 11, brightness) * scale,
    depth: lerp(8, 12, rng()) * scale,
    height: lerp(3.2, 4.8, brightness),
    wave,
    phase: rng() * Math.PI * 2,
    pattern: overrides.pattern ?? 'voice',
    brightness: overrides.brightness ?? 1,
    accentCss: `hsl(${Math.round((((lerp(0.62, 0.02, t) + (overrides.hueShift ?? 0)) % 1) + 1) % 1 * 360)}, 85%, 70%)`,
  };
}

export const styleColor = (style, s = style.saturation, l = 0.5, hueOffset = 0) =>
  new THREE.Color().setHSL((style.hue + hueOffset + 1) % 1, s, l);

// ---------------------------------------------------------------------------

function makeWallTexture(style) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const ctx = c.getContext('2d');
  const h = Math.round(style.hue * 360);
  const s = Math.round(style.saturation * 100);

  const g = ctx.createLinearGradient(0, 0, 0, c.height);
  g.addColorStop(0, `hsl(${h}, ${s * 0.6}%, 24%)`);
  g.addColorStop(1, `hsl(${h}, ${s * 0.5}%, 9%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);

  if (style.pattern === 'voice') {
    // "voice wallpaper": interfering sine waves whose shape comes from the MFCCs
    for (let line = 0; line < 6; line++) {
      ctx.beginPath();
      ctx.strokeStyle = `hsla(${(h + line * 12) % 360}, ${s}%, 65%, ${0.18 + line * 0.03})`;
      ctx.lineWidth = 2 + (line % 2);
      const base = 70 + line * 70;
      for (let x = 0; x <= c.width; x += 4) {
        let y = 0;
        style.wave.forEach((w, j) => {
          y += w * Math.sin(x * 0.006 * (j + 1) * (1 + line * 0.12) + style.phase + line);
        });
        const py = base + y * 14;
        if (x === 0) ctx.moveTo(x, py);
        else ctx.lineTo(x, py);
      }
      ctx.stroke();
    }
    // spectral "barcode" along the skirting
    style.wave.forEach((w, i) => {
      const bw = c.width / style.wave.length;
      ctx.fillStyle = `hsla(${(h + i * 20) % 360}, ${s}%, 60%, 0.35)`;
      const bh = 10 + Math.abs(w) * 30;
      ctx.fillRect(i * bw + 6, c.height - bh, bw - 12, bh);
    });
  } else if (style.pattern === 'grid') {
    ctx.strokeStyle = `hsla(${h}, ${s}%, 70%, 0.15)`;
    ctx.lineWidth = 2;
    for (let x = 0; x < c.width; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, c.height);
      ctx.stroke();
    }
    for (let y = 0; y < c.height; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(c.width, y);
      ctx.stroke();
    }
  }
  return canvasTexture(c);
}

function makeFloorTexture(style) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  const h = Math.round(style.hue * 360);
  ctx.fillStyle = `hsl(${h}, 25%, 8%)`;
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = `hsla(${h}, 70%, 60%, 0.25)`;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 510, 510);
  ctx.strokeStyle = `hsla(${h}, 70%, 60%, 0.08)`;
  for (let i = 64; i < 512; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }
  const tex = canvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Mark a material so passthrough/AR mode can fade it out. */
export function fadeable(material, arOpacity = 0.15) {
  material.userData.arFade = true;
  material.userData.baseOpacity = material.opacity;
  material.userData.arOpacity = arOpacity;
  return material;
}

export function buildDoorway(color, label, { width = 1.3, height = 2.3 } = {}) {
  const group = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1d29, metalness: 0.6, roughness: 0.3 });
  const t = 0.12;
  const left = new THREE.Mesh(new THREE.BoxGeometry(t, height, t), frameMat);
  left.position.set(-width / 2, height / 2, 0);
  const right = left.clone();
  right.position.x = width / 2;
  const top = new THREE.Mesh(new THREE.BoxGeometry(width + t, t, t), frameMat);
  top.position.y = height;

  const portalMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const portal = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.05, height - 0.05), portalMat);
  portal.position.y = height / 2;
  portal.name = 'portal';
  group.add(left, right, top, portal);

  if (label) {
    const sign = makeLabel({ body: label, width: 1.4, accent: `#${color.getHexString()}`, maxLines: 2 });
    sign.position.y = height + 0.45;
    group.add(sign);
  }
  group.userData.portal = portal;
  return group;
}

/**
 * Builds the room shell for one person. Origin is the room centre on the floor.
 * Entrance (exit door) on +Z, timeline wall on -Z.
 */
export function buildRoom(style, profile) {
  const group = new THREE.Group();
  group.name = 'room';
  const W = style.width;
  const D = style.depth;
  const H = style.height;
  const b = style.brightness;

  // floor
  const floorTex = makeFloorTexture(style);
  floorTex.repeat.set(W / 2, D / 2);
  const floorMat = fadeable(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85, metalness: 0.1 }), 0.08);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.name = 'floor';
  group.add(floor);

  // walls
  const wallTex = makeWallTexture(style);
  const makeWall = (len, x, z, rotY) => {
    const mat = fadeable(new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9, side: THREE.DoubleSide }), 0.14);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, H), mat);
    m.position.set(x, H / 2, z);
    m.rotation.y = rotY;
    group.add(m);
    return m;
  };
  makeWall(W, 0, -D / 2, 0); // back (timeline)
  makeWall(W, 0, D / 2, Math.PI); // front (door)
  makeWall(D, -W / 2, 0, Math.PI / 2);
  makeWall(D, W / 2, 0, -Math.PI / 2);

  // glowing skirting + cornice lines make the room read well in passthrough too
  const lineMat = new THREE.LineBasicMaterial({ color: styleColor(style, 0.9, 0.65), transparent: true, opacity: 0.8 });
  for (const y of [0.02, H]) {
    const pts = [
      new THREE.Vector3(-W / 2, y, -D / 2),
      new THREE.Vector3(W / 2, y, -D / 2),
      new THREE.Vector3(W / 2, y, D / 2),
      new THREE.Vector3(-W / 2, y, D / 2),
      new THREE.Vector3(-W / 2, y, -D / 2),
    ];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
  }

  // ceiling
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(W, D),
    new THREE.MeshStandardMaterial({ color: styleColor(style, style.saturation * 0.3, 0.06), side: THREE.DoubleSide }),
  );
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = H;
  ceil.userData.hideInAR = true;
  group.add(ceil);

  // voice ribbon: a tube across the ceiling shaped by the MFCC curve
  const pts = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    let y = 0;
    let z = 0;
    style.wave.forEach((w, j) => {
      y += w * Math.sin(u * Math.PI * (j + 1) + style.phase) * 0.12;
      z += w * Math.cos(u * Math.PI * (j + 1.5) + style.phase) * 0.35;
    });
    pts.push(new THREE.Vector3(lerp(-W / 2 + 0.6, W / 2 - 0.6, u), H - 0.55 + y, z));
  }
  const ribbonMat = new THREE.MeshStandardMaterial({
    color: styleColor(style, 0.9, 0.6),
    emissive: styleColor(style, 0.9, 0.5),
    emissiveIntensity: 0.9,
    roughness: 0.3,
  });
  const ribbon = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.035, 8), ribbonMat);
  ribbon.name = 'ribbon';
  group.add(ribbon);

  // lighting
  const hemi = new THREE.HemisphereLight(styleColor(style, 0.5, 0.75), 0x111122, 1.1 * b);
  const point = new THREE.PointLight(styleColor(style, 0.8, 0.6), 22 * b, 0, 2);
  point.position.set(0, H - 0.4, 0);
  const fill = new THREE.PointLight(0xffffff, 6 * b, 0, 2);
  fill.position.set(0, 2.2, D / 2 - 1.5);
  group.add(hemi, point, fill, new THREE.AmbientLight(0xffffff, 0.25 * b));

  // floating dust motes
  const count = 260;
  const rng = mulberry32(style.seed);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (rng() - 0.5) * W;
    positions[i * 3 + 1] = rng() * H;
    positions[i * 3 + 2] = (rng() - 0.5) * D;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const dust = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({
      color: styleColor(style, 0.8, 0.75),
      size: 0.022,
      transparent: true,
      opacity: 0.7,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  dust.name = 'dust';
  group.add(dust);

  // exit door back to the lobby
  const exit = buildDoorway(styleColor(style, 0.6, 0.6), '↩ Lobby');
  exit.position.set(0, 0, D / 2 - 0.08);
  exit.rotation.y = Math.PI;
  exit.userData.kind = 'exit';
  group.add(exit);

  // name banner over the timeline
  const title = makeTitle(profile?.name || 'Guest', { width: Math.min(5, W * 0.6), accent: style.accentCss });
  title.position.set(0, Math.min(H - 0.45, 3.4), -D / 2 + 0.3);
  title.name = 'title';
  group.add(title);

  return {
    group,
    bounds: { minX: -W / 2 + 0.4, maxX: W / 2 - 0.4, minZ: -D / 2 + 0.4, maxZ: D / 2 - 0.4 },
    entrance: { x: 0, z: D / 2 - 1.3, yaw: 0 },
    backWallZ: -D / 2,
    W,
    D,
    H,
    exit,
    ribbon,
    dust,
  };
}

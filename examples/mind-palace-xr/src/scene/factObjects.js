import * as THREE from 'three';
import { makeLabel } from './textSprite.js';

// Each fact type gets its own "memory object" so you can tell them apart
// at a glance from across the room (method of loci works better with
// distinct, vivid objects).
export const FACT_TYPES = {
  name: { label: 'Name', color: 0xffd166, geo: () => new THREE.TorusKnotGeometry(0.15, 0.045, 96, 12) },
  work: { label: 'Work', color: 0x4cc9f0, geo: () => new THREE.BoxGeometry(0.38, 0.27, 0.12) },
  study: { label: 'Studies', color: 0x80ed99, geo: () => new THREE.ConeGeometry(0.21, 0.34, 4) },
  place: { label: 'Place', color: 0x90be6d, geo: () => new THREE.IcosahedronGeometry(0.2, 1) },
  likes: { label: 'Likes', color: 0xf72585, geo: () => new THREE.TorusGeometry(0.15, 0.06, 16, 40) },
  family: { label: 'Family', color: 0xf8961e, geo: null },
  project: { label: 'Project', color: 0x9d4edd, geo: () => new THREE.DodecahedronGeometry(0.2) },
  note: { label: 'Note', color: 0xe0e1dd, geo: () => new THREE.OctahedronGeometry(0.2) },
};

export const COLOR_CYCLE = [0x4cc9f0, 0xf72585, 0xffd166, 0x80ed99, 0x9d4edd, 0xf8961e, 0xe0e1dd, 0xff6b6b];

function makeBody(type, material) {
  if (type === 'family') {
    // a little cluster of orbs
    const g = new THREE.Group();
    const offsets = [
      [0, 0.08, 0, 0.11],
      [-0.13, -0.06, 0.03, 0.085],
      [0.13, -0.06, -0.02, 0.085],
    ];
    for (const [x, y, z, r] of offsets) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), material);
      m.position.set(x, y, z);
      g.add(m);
    }
    return g;
  }
  return new THREE.Mesh(FACT_TYPES[type].geo(), material);
}

export function createFactObject(fact) {
  const type = FACT_TYPES[fact.type] ? fact.type : 'note';
  const meta = FACT_TYPES[type];
  const colorHex = fact.transform?.color ?? meta.color;
  const color = new THREE.Color(colorHex);

  const group = new THREE.Group();
  group.userData = { kind: 'fact', factId: fact.id, color: colorHex, baseScale: fact.transform?.scale ?? 1 };

  const material = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.3,
    metalness: 0.35,
    roughness: 0.35,
    flatShading: type === 'place',
  });
  const body = makeBody(type, material);
  body.name = 'body';
  group.add(body);

  // soft glow disc so objects read in passthrough
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(0.3, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }),
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -0.28;
  halo.name = 'halo';
  group.add(halo);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.012, 8, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.27;
  ring.visible = false;
  ring.name = 'selection';
  group.add(ring);

  const label = makeLabel({ title: meta.label, body: fact.text, accent: `#${color.getHexString()}`, width: 0.75 });
  label.position.y = 0.48;
  label.name = 'label';
  group.add(label);

  group.userData.bobPhase = Math.random() * Math.PI * 2;
  applyTransform(group, fact.transform);
  return group;
}

export function applyTransform(group, t) {
  if (!t) return;
  if (t.position) group.position.fromArray(t.position);
  group.rotation.set(0, t.rotationY ?? 0, 0);
  group.userData.baseScale = t.scale ?? 1;
  group.scale.setScalar(group.userData.baseScale);
}

export function getTransform(group) {
  return {
    position: group.position.toArray().map((v) => +v.toFixed(3)),
    rotationY: +group.rotation.y.toFixed(3),
    scale: +(group.userData.baseScale ?? 1).toFixed(3),
    color: group.userData.color,
  };
}

export function setFactColor(group, hex) {
  group.userData.color = hex;
  const c = new THREE.Color(hex);
  group.traverse((o) => {
    if (o.isMesh && o.material && o.name !== 'selection') {
      o.material.color?.copy(c);
      o.material.emissive?.copy(c);
    }
  });
}

/** Spread facts around the room on concentric ellipses, leaving the entrance clear. */
export function defaultFactPosition(index, room) {
  const perRing = 7;
  const ring = Math.floor(index / perRing);
  const slot = index % perRing;
  // arc from left wall round the back to the right wall (skip the door side)
  const angle = Math.PI * (0.95 + (slot / (perRing - 1)) * 1.1) + ring * 0.25;
  const rx = Math.max(1.2, room.W * 0.36 - ring * 0.9);
  const rz = Math.max(1.0, room.D * 0.3 - ring * 0.9);
  return [Math.cos(angle) * rx, 1.25 + (ring % 2) * 0.25, Math.sin(angle) * rz + 0.2];
}

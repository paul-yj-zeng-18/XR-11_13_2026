import * as THREE from 'three';
import { buildRoom, buildDoorway, deriveRoomStyle, styleColor, fadeable } from './roomGenerator.js';
import { createFactObject, defaultFactPosition, getTransform } from './factObjects.js';
import { buildTimeline } from './timelineWall.js';
import { makeTitle, makeLabel } from './textSprite.js';

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      m.map?.dispose?.();
      m.dispose?.();
    }
  });
}

/** Walks up from a raycast hit to the object that carries interaction info. */
export function findTagged(obj) {
  let o = obj;
  while (o) {
    if (o.userData?.kind) return o;
    o = o.parent;
  }
  return null;
}

/**
 * Owns what's in the world: either the Lobby (a ring of doors, one per person)
 * or a single person's Room (facts + timeline).
 */
export class MindPalace {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = new THREE.Group();
    this.root.name = 'palace';
    ctx.scene.add(this.root);

    this.mode = 'lobby';
    this.profile = null;
    this.room = null;
    this.style = null;
    this.factLayer = null;
    this.timeline = null;
    this.factObjects = new Map();
    this.interactables = [];
    this.bounds = { minX: -6, maxX: 6, minZ: -6, maxZ: 6 };
    this.arMode = false;

    // hooks wired up in main.js
    this.onTeleport = null; // (x, z, yaw) => void
    this.onAutoPlace = null; // (factId, transform) => void
  }

  _clear() {
    for (const child of [...this.root.children]) {
      this.root.remove(child);
      disposeTree(child);
    }
    this.factObjects.clear();
    this.interactables = [];
    this.room = null;
    this.timeline = null;
    this.factLayer = null;
  }

  // ------------------------------------------------------------------ lobby
  showLobby(profiles, { teleport = true } = {}) {
    this._clear();
    this.mode = 'lobby';
    this.profile = null;
    const n = profiles.length;
    const R = Math.max(4.5, n * 0.8);
    // up to 7 people: an arc in front of you so everyone is visible at once.
    // more than that: a full ring you can turn around in.
    const arc = n <= 7 ? Math.min(Math.PI * 0.85, Math.max(n - 1, 0) * 0.45) : Math.PI * 2 * (1 - 1 / n);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(R + 1.5, 64),
      fadeable(new THREE.MeshStandardMaterial({ color: 0x0b0d16, roughness: 0.9 }), 0.05),
    );
    floor.rotation.x = -Math.PI / 2;
    this.root.add(floor);

    const ringMat = new THREE.MeshBasicMaterial({ color: 0x6c7cff, transparent: true, opacity: 0.6 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(R - 0.02, R + 0.02, 96), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    this.root.add(ring);
    const grid = new THREE.GridHelper((R + 1.5) * 2, Math.round((R + 1.5) * 2), 0x2a3170, 0x161a3a);
    grid.position.y = 0.005;
    this.root.add(grid);

    this.root.add(new THREE.HemisphereLight(0x9fb3ff, 0x0b0b18, 1.2), new THREE.AmbientLight(0xffffff, 0.3));

    const title = makeTitle('Mind Palace', { width: 3.4, accent: '#8ea2ff', size: 2 });
    title.position.set(0, 4.3, -R - 0.3);
    this.root.add(title);
    const sub = makeLabel({
      body: n ? 'Walk through a door to enter someone’s room' : 'Press “Start encounter” to meet someone and build their room',
      width: 2.2,
      accent: '#8ea2ff',
      maxLines: 2,
    });
    sub.position.set(0, 3.75, -R - 0.3);
    this.root.add(sub);

    profiles.forEach((p, i) => {
      const style = deriveRoomStyle(p.voiceprint, p.room, p.name);
      const angle = n > 1 ? -arc / 2 + (arc * i) / (n - 1) : 0;
      const door = buildDoorway(styleColor(style, 0.85, 0.55), p.name);
      door.position.set(Math.sin(angle) * R, 0, -Math.cos(angle) * R);
      door.rotation.y = -angle;
      door.userData.kind = 'door';
      door.userData.profileId = p.id;
      const stats = makeLabel({
        body: `${p.facts.length} facts · ${p.conversations.length} chats`,
        width: 1.1,
        accent: style.accentCss,
        maxLines: 1,
      });
      stats.position.y = 3.2;
      door.add(stats);
      this.root.add(door);
      this.interactables.push(door.userData.portal);
    });

    this.bounds = { minX: -R, maxX: R, minZ: -R, maxZ: R };
    if (teleport) this.onTeleport?.(0, n > 7 ? 0 : R * 0.45, 0);
    this._applyAR();
  }

  // ------------------------------------------------------------------- room
  enterRoom(profile) {
    this._buildRoom(profile);
    this.onTeleport?.(this.room.entrance.x, this.room.entrance.z, this.room.entrance.yaw);
  }

  /** Rebuild without moving the player (after customising, renaming, etc.). */
  refreshRoom(profile) {
    if (this.mode !== 'room' || this.profile?.id !== profile.id) return;
    this._buildRoom(profile);
  }

  _buildRoom(profile) {
    this._clear();
    this.mode = 'room';
    this.profile = profile;
    this.style = deriveRoomStyle(profile.voiceprint, profile.room, profile.name);
    this.room = buildRoom(this.style, profile);
    this.root.add(this.room.group);
    this.bounds = this.room.bounds;
    this.interactables.push(this.room.exit.userData.portal);

    this.factLayer = new THREE.Group();
    this.factLayer.name = 'facts';
    this.root.add(this.factLayer);
    profile.facts.forEach((f, i) => this._spawnFact(f, i, false));

    this._buildTimeline(profile);
    this._applyAR();
  }

  _buildTimeline(profile) {
    if (this.timeline) {
      this.root.remove(this.timeline.group);
      disposeTree(this.timeline.group);
      this.interactables = this.interactables.filter((o) => !this.timeline.interactables.includes(o));
    }
    this.timeline = buildTimeline(profile.conversations, this.style, this.room);
    this.root.add(this.timeline.group);
    this.interactables.push(...this.timeline.interactables);
  }

  refreshTimeline(profile) {
    if (this.mode === 'room' && this.profile?.id === profile.id) {
      this.profile = profile;
      this._buildTimeline(profile);
    }
  }

  _spawnFact(fact, index, animate) {
    const obj = createFactObject(fact);
    if (!fact.transform) {
      obj.position.fromArray(defaultFactPosition(index, this.room));
      this.onAutoPlace?.(fact.id, getTransform(obj));
    }
    if (animate) {
      obj.userData.spawnT = 0;
      obj.scale.setScalar(0.001);
    }
    this.factLayer.add(obj);
    this.factObjects.set(fact.id, obj);
    obj.traverse((o) => {
      if (o.isMesh && o.name !== 'selection' && o.name !== 'halo') this.interactables.push(o);
    });
    return obj;
  }

  addFact(fact, { animate = true, profileId } = {}) {
    if (this.mode !== 'room' || (profileId && this.profile?.id !== profileId)) return null;
    if (this.factObjects.has(fact.id)) return this.factObjects.get(fact.id);
    return this._spawnFact(fact, this.factObjects.size, animate);
  }

  removeFact(factId) {
    const obj = this.factObjects.get(factId);
    if (!obj) return;
    const meshes = new Set();
    obj.traverse((o) => meshes.add(o));
    this.interactables = this.interactables.filter((o) => !meshes.has(o));
    obj.parent?.remove(obj);
    disposeTree(obj);
    this.factObjects.delete(factId);
  }

  // ------------------------------------------------------------- AR / misc
  setARMode(on) {
    this.arMode = on;
    this._applyAR();
  }

  _applyAR() {
    const on = this.arMode;
    this.root.traverse((o) => {
      if (o.userData?.hideInAR) o.visible = !on;
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (!m.userData?.arFade) continue;
        m.transparent = on || m.userData.baseOpacity < 1;
        m.opacity = on ? m.userData.arOpacity : m.userData.baseOpacity;
        m.depthWrite = !on;
        m.needsUpdate = true;
      }
    });
  }

  clampToBounds(v, margin = 0) {
    const b = this.bounds;
    v.x = Math.min(b.maxX - margin, Math.max(b.minX + margin, v.x));
    v.z = Math.min(b.maxZ - margin, Math.max(b.minZ + margin, v.z));
    return v;
  }

  update(dt, t) {
    for (const obj of this.factObjects.values()) {
      const body = obj.getObjectByName('body');
      if (body) {
        body.position.y = Math.sin(t * 1.3 + obj.userData.bobPhase) * 0.04;
        if (!obj.userData.held) body.rotation.y += dt * 0.5;
      }
      if (obj.userData.spawnT !== undefined) {
        obj.userData.spawnT = Math.min(1, obj.userData.spawnT + dt * 1.6);
        const k = obj.userData.spawnT;
        const c = 1.70158;
        const ease = 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2; // easeOutBack
        obj.scale.setScalar(Math.max(0.001, ease * obj.userData.baseScale));
        if (k >= 1) delete obj.userData.spawnT;
      }
    }
    if (this.room) {
      this.room.dust.rotation.y += dt * 0.02;
      this.room.ribbon.material.emissiveIntensity = 0.8 + Math.sin(t * 1.5) * 0.25;
    }
    const pulse = 0.45 + Math.sin(t * 2) * 0.12;
    for (const o of this.interactables) if (o.name === 'portal') o.material.opacity = pulse;
  }
}

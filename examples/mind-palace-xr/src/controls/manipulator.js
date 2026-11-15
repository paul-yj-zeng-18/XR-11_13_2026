import * as THREE from 'three';
import { findTagged } from '../scene/palace.js';
import { COLOR_CYCLE, getTransform, setFactColor } from '../scene/factObjects.js';
import { isTyping } from './desktopControls.js';

/**
 * Mouse interaction on desktop:
 *   click object    select           drag object  move it along the floor
 *   scroll          raise / lower    R / Shift+R  rotate
 *   [ / ]           shrink / grow    C            cycle colour
 *   Delete          remove fact      Esc          deselect
 *   click a door / timeline card to open it
 */
export class Manipulator {
  constructor(ctx, palace, handlers) {
    this.ctx = ctx;
    this.palace = palace;
    this.h = handlers;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.camera = ctx.camera;
    this.pointer = new THREE.Vector2();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.offset = new THREE.Vector3();
    this.selected = null;
    this.dragging = null;
    this._cache = { e: null, hit: null };
    this._saveTimer = null;

    const el = ctx.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this._key(e));
  }

  _ray(e) {
    const r = this.ctx.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.ctx.camera);
  }

  /** Returns the tagged object under the cursor (cached per event). */
  pick(e) {
    if (this._cache.e === e) return this._cache.hit;
    this._ray(e);
    const hits = this.raycaster.intersectObjects(this.palace.interactables, false);
    let hit = null;
    for (const h of hits) {
      const tagged = findTagged(h.object);
      if (tagged) {
        hit = { object: tagged, point: h.point };
        break;
      }
    }
    this._cache = { e, hit };
    return hit;
  }

  _down(e) {
    if (e.button !== 0) return;
    const hit = this.pick(e);
    this._downAt = { x: e.clientX, y: e.clientY, hit };
    if (!hit) return;
    const { kind } = hit.object.userData;
    if (kind === 'fact') {
      this.select(hit.object);
      this.dragging = hit.object;
      this.plane.constant = -hit.object.position.y;
      const p = new THREE.Vector3();
      this.raycaster.ray.intersectPlane(this.plane, p);
      this.offset.copy(hit.object.position).sub(p);
      this.ctx.renderer.domElement.setPointerCapture(e.pointerId);
    }
  }

  _move(e) {
    const el = this.ctx.renderer.domElement;
    if (this.dragging) {
      this._ray(e);
      const p = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.plane, p)) {
        p.add(this.offset);
        this.palace.clampToBounds(p, 0.2);
        this.dragging.position.x = p.x;
        this.dragging.position.z = p.z;
      }
      el.style.cursor = 'grabbing';
      return;
    }
    if (e.buttons) return;
    const hit = this.pick(e);
    el.style.cursor = hit ? (hit.object.userData.kind === 'fact' ? 'grab' : 'pointer') : '';
  }

  _up(e) {
    if (this.dragging) {
      this._persist(this.dragging);
      this.dragging = null;
      return;
    }
    const d = this._downAt;
    if (!d || e.button !== 0) return;
    const clicked = Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5;
    if (!clicked) return;
    if (!d.hit) {
      this.deselect();
      return;
    }
    const o = d.hit.object;
    if (o.userData.kind === 'door') this.h.onDoor?.(o.userData.profileId);
    if (o.userData.kind === 'exit') this.h.onExit?.();
    if (o.userData.kind === 'convo') this.h.onConvo?.(o.userData.convoId);
  }

  _wheel(e) {
    if (!this.selected) return;
    e.preventDefault();
    const o = this.selected;
    o.position.y = Math.min(3.2, Math.max(0.35, o.position.y - e.deltaY * 0.0015));
    this._persistSoon(o);
  }

  _key(e) {
    if (!this.selected || isTyping(e)) return;
    const o = this.selected;
    switch (e.code) {
      case 'KeyR':
        o.rotation.y += (e.shiftKey ? -1 : 1) * (Math.PI / 8);
        break;
      case 'BracketRight':
      case 'Equal':
        o.userData.baseScale = Math.min(3, o.userData.baseScale * 1.12);
        o.scale.setScalar(o.userData.baseScale);
        break;
      case 'BracketLeft':
      case 'Minus':
        o.userData.baseScale = Math.max(0.4, o.userData.baseScale / 1.12);
        o.scale.setScalar(o.userData.baseScale);
        break;
      case 'KeyC': {
        const i = COLOR_CYCLE.indexOf(o.userData.color);
        setFactColor(o, COLOR_CYCLE[(i + 1) % COLOR_CYCLE.length]);
        break;
      }
      case 'Delete':
      case 'Backspace': {
        const id = o.userData.factId;
        this.deselect();
        this.h.onDelete?.(id);
        return;
      }
      case 'Escape':
        this.deselect();
        return;
      default:
        return;
    }
    this._persist(o);
  }

  select(obj) {
    if (this.selected === obj) return;
    this.deselect();
    this.selected = obj;
    obj.getObjectByName('selection').visible = true;
    this.h.onSelect?.(obj);
  }

  deselect() {
    if (!this.selected) return;
    const sel = this.selected.getObjectByName('selection');
    if (sel) sel.visible = false;
    this.selected = null;
    this.h.onSelect?.(null);
  }

  _persist(obj) {
    this.h.onTransform?.(obj.userData.factId, getTransform(obj));
  }

  _persistSoon(obj) {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._persist(obj), 250);
  }
}

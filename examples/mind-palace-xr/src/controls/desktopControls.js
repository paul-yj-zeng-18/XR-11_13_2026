import * as THREE from 'three';
import { CONFIG } from '../config.js';

export const isTyping = (e) => {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

/**
 * Laptop "headset simulator":
 *   WASD / arrows   walk & turn      Shift  sprint
 *   drag mouse      look around      Q / E  crouch / tiptoe
 *   Space           re-centre view (like a headset recenter)
 * Movement has a gentle head-bob and is clamped to the room walls.
 */
export class DesktopControls {
  constructor(ctx, palace) {
    this.ctx = ctx;
    this.palace = palace;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.eyeOffset = 0;
    this.bob = 0;
    this.dragging = false;
    this.last = { x: 0, y: 0 };
    this.canStartLook = () => true; // replaced by main.js so dragging an object doesn't spin the view

    const el = ctx.renderer.domElement;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 2 || (e.button === 0 && this.canStartLook(e))) {
        this.dragging = true;
        this.last = { x: e.clientX, y: e.clientY };
        el.setPointerCapture(e.pointerId);
        el.style.cursor = 'grabbing';
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const s = CONFIG.player.lookSensitivity;
      this.yaw -= (e.clientX - this.last.x) * s;
      this.pitch -= (e.clientY - this.last.y) * s;
      this.pitch = Math.max(-1.35, Math.min(1.35, this.pitch));
      this.last = { x: e.clientX, y: e.clientY };
    });
    const end = () => {
      this.dragging = false;
      el.style.cursor = '';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      this.keys.add(e.code);
      if (e.code === 'Space') {
        e.preventDefault();
        this.pitch = 0;
      }
      if (e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    ctx.renderer.xr.addEventListener('sessionend', () => {
      ctx.camera.position.set(0, CONFIG.player.eyeHeight, 0);
      ctx.camera.rotation.set(this.pitch, 0, 0);
    });
  }

  setPose(x, z, yaw = 0) {
    this.ctx.dolly.position.set(x, 0, z);
    this.yaw = yaw;
    this.pitch = 0;
    this.ctx.dolly.rotation.set(0, yaw, 0);
  }

  update(dt) {
    const { dolly, camera } = this.ctx;
    const k = this.keys;
    const p = CONFIG.player;

    if (k.has('ArrowLeft')) this.yaw += p.turnSpeed * dt;
    if (k.has('ArrowRight')) this.yaw -= p.turnSpeed * dt;

    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const speed = p.walkSpeed * (k.has('ShiftLeft') || k.has('ShiftRight') ? p.sprintMultiplier : 1);

    const move = new THREE.Vector3(
      -Math.sin(this.yaw) * fwd + Math.cos(this.yaw) * strafe,
      0,
      -Math.cos(this.yaw) * fwd - Math.sin(this.yaw) * strafe,
    );
    const moving = move.lengthSq() > 0;
    if (moving) {
      move.normalize().multiplyScalar(speed * dt);
      dolly.position.add(move);
      this.palace.clampToBounds(dolly.position, 0.1);
      this.bob += dt * speed * 4.2;
    }

    if (k.has('KeyQ')) this.eyeOffset = Math.max(-0.7, this.eyeOffset - dt * 1.2);
    else if (k.has('KeyE')) this.eyeOffset = Math.min(0.3, this.eyeOffset + dt * 1.2);
    else this.eyeOffset *= 1 - Math.min(1, dt * 3);

    const bobY = moving ? Math.sin(this.bob) * 0.025 : 0;
    dolly.rotation.set(0, this.yaw, 0);
    camera.rotation.set(this.pitch, 0, moving ? Math.sin(this.bob * 0.5) * 0.004 : 0);
    camera.position.y += (p.eyeHeight + this.eyeOffset + bobY - camera.position.y) * Math.min(1, dt * 12);
  }
}

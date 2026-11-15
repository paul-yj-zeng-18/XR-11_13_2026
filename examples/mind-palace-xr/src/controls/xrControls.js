import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { findTagged } from '../scene/palace.js';
import { getTransform } from '../scene/factObjects.js';
import { CONFIG } from '../config.js';

/**
 * Real headset (or Immersive Web Emulator) input:
 *   trigger on object   grab it, move your hand, release to drop
 *   trigger on door     walk through / open timeline card
 *   left stick          smooth locomotion (head-relative)
 *   right stick         30° snap turn
 */
export class XRControls {
  constructor(ctx, palace, handlers) {
    this.ctx = ctx;
    this.palace = palace;
    this.h = handlers;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.camera = ctx.camera;
    this.tmp = new THREE.Matrix4();
    this.snapReady = true;
    this.controllers = [];

    const factory = new XRControllerModelFactory();
    const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);

    for (let i = 0; i < 2; i++) {
      const c = ctx.renderer.xr.getController(i);
      c.addEventListener('selectstart', () => this._selectStart(c));
      c.addEventListener('selectend', () => this._selectEnd(c));
      const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0x9fb3ff, transparent: true, opacity: 0.7 }));
      ray.scale.z = 5;
      ray.name = 'ray';
      c.add(ray);
      ctx.dolly.add(c);

      const grip = ctx.renderer.xr.getControllerGrip(i);
      grip.add(factory.createControllerModel(grip));
      ctx.dolly.add(grip);
      this.controllers.push(c);
    }
  }

  _hit(controller) {
    this.tmp.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tmp);
    for (const h of this.raycaster.intersectObjects(this.palace.interactables, false)) {
      const tagged = findTagged(h.object);
      if (tagged) return { object: tagged, distance: h.distance };
    }
    return null;
  }

  _selectStart(controller) {
    const hit = this._hit(controller);
    if (!hit) return;
    const o = hit.object;
    switch (o.userData.kind) {
      case 'fact':
        controller.attach(o);
        o.userData.held = true;
        controller.userData.held = o;
        break;
      case 'door':
        this.h.onDoor?.(o.userData.profileId);
        break;
      case 'exit':
        this.h.onExit?.();
        break;
      case 'convo':
        this.h.onConvo?.(o.userData.convoId);
        break;
    }
  }

  _selectEnd(controller) {
    const o = controller.userData.held;
    if (!o) return;
    (this.palace.factLayer ?? this.palace.root).attach(o);
    o.rotation.set(0, o.rotation.y, 0);
    o.position.y = Math.max(0.35, o.position.y);
    o.userData.held = false;
    controller.userData.held = null;
    this.h.onTransform?.(o.userData.factId, getTransform(o));
  }

  update(dt) {
    const session = this.ctx.renderer.xr.getSession();
    if (!session) return;
    const { dolly } = this.ctx;
    const cam = this.ctx.renderer.xr.getCamera();

    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp || gp.axes.length < 2) continue;
      const x = gp.axes[2] ?? gp.axes[0];
      const y = gp.axes[3] ?? gp.axes[1];

      if (src.handedness === 'left' && (Math.abs(x) > 0.15 || Math.abs(y) > 0.15)) {
        const fwd = new THREE.Vector3();
        cam.getWorldDirection(fwd);
        fwd.y = 0;
        fwd.normalize();
        const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
        dolly.position.addScaledVector(fwd, -y * CONFIG.player.walkSpeed * dt);
        dolly.position.addScaledVector(right, x * CONFIG.player.walkSpeed * dt);
        this.palace.clampToBounds(dolly.position, 0.1);
      }

      if (src.handedness === 'right') {
        if (Math.abs(x) > 0.7 && this.snapReady) {
          this._snapTurn(x > 0 ? -Math.PI / 6 : Math.PI / 6, cam);
          this.snapReady = false;
        } else if (Math.abs(x) < 0.3) this.snapReady = true;
      }
    }

    // shorten the laser to whatever it's pointing at
    for (const c of this.controllers) {
      const hit = this._hit(c);
      c.getObjectByName('ray').scale.z = hit ? hit.distance : 5;
    }
  }

  _snapTurn(angle, cam) {
    // rotate around the player's head, not the rig origin
    const { dolly } = this.ctx;
    const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
    dolly.position.sub(head).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).add(head);
    dolly.rotation.y += angle;
  }
}

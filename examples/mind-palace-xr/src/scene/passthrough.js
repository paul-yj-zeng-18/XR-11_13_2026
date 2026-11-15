import * as THREE from 'three';

/**
 * "AR on a laptop": the webcam feed becomes the scene background and the room
 * walls fade to translucent glass, so the palace overlays the real world.
 * On a real AR headset (Quest 3 passthrough) the XR session does this natively
 * and we just clear the background - see main.js sessionstart handler.
 */
export class Passthrough {
  constructor(ctx, palace) {
    this.ctx = ctx;
    this.palace = palace;
    this.on = false;
    this.stream = null;
    this.video = null;
    this.texture = null;
  }

  async enable() {
    if (this.on) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video = document.createElement('video');
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();

    this.texture = new THREE.VideoTexture(this.video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.ctx.scene.background = this.texture;
    this.palace.setARMode(true);
    this.on = true;
  }

  disable() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.texture?.dispose();
    this.stream = null;
    this.video = null;
    this.texture = null;
    this.ctx.scene.background = this.ctx.defaultBackground;
    this.palace.setARMode(false);
    this.on = false;
  }

  async toggle() {
    if (this.on) this.disable();
    else await this.enable();
    return this.on;
  }
}

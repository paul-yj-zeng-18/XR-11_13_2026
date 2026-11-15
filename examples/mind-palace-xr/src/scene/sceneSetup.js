import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { CONFIG } from '../config.js';

/**
 * Renderer, scene and a camera "dolly" (rig). We move the dolly for
 * locomotion so it works the same on desktop and inside a real XR session,
 * where the headset owns the camera's local transform.
 */
export function createSceneContext(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const defaultBackground = new THREE.Color(0x05060b);
  scene.background = defaultBackground;

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.position.set(0, CONFIG.player.eyeHeight, 0);
  camera.rotation.order = 'YXZ';

  const dolly = new THREE.Group();
  dolly.name = 'dolly';
  dolly.add(camera);
  scene.add(dolly);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Enter VR / Enter AR buttons. On a plain laptop these say "not supported"
  // unless you install the Immersive Web Emulator extension (see README).
  const vrButton = VRButton.createButton(renderer);
  const arButton = ARButton.createButton(renderer, {
    optionalFeatures: ['dom-overlay', 'local-floor', 'hand-tracking'],
    domOverlay: { root: document.getElementById('hud') },
  });
  document.body.appendChild(vrButton);
  document.body.appendChild(arButton);

  return { renderer, scene, camera, dolly, defaultBackground };
}

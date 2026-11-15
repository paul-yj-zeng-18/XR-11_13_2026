import * as THREE from 'three';
import { CONFIG, loadSettings, saveSettings } from './config.js';
import { createSceneContext } from './scene/sceneSetup.js';
import { MindPalace } from './scene/palace.js';
import { Passthrough } from './scene/passthrough.js';
import { makeLabel } from './scene/textSprite.js';
import { FACT_TYPES } from './scene/factObjects.js';
import { DesktopControls } from './controls/desktopControls.js';
import { Manipulator } from './controls/manipulator.js';
import { XRControls } from './controls/xrControls.js';
import { ProfileStore } from './profiles/profileStore.js';
import { createDemoProfiles } from './profiles/demoData.js';
import { CONSENT_SCRIPT } from './profiles/consent.js';
import { MicStream } from './audio/micStream.js';
import { SpeechTranscriber } from './audio/speechTranscriber.js';
import { Hud } from './ui/hud.js';
import { EncounterFlow } from './ui/encounterFlow.js';
import { $ } from './ui/dom.js';
import { startPicavoiceBridge } from './picavoice/bridge.js';

loadSettings();

// ---------------------------------------------------------------- core setup
const ctx = createSceneContext($('app'));
const store = new ProfileStore();
const hud = new Hud();
const palace = new MindPalace(ctx);
const passthrough = new Passthrough(ctx, palace);
const desktop = new DesktopControls(ctx, palace);
const mic = new MicStream();
const transcriber = new SpeechTranscriber();

palace.onTeleport = (x, z, yaw) => desktop.setPose(x, z, yaw);
palace.onAutoPlace = (factId, transform) => {
  if (palace.profile) store.updateFact(palace.profile.id, factId, { transform }, { silent: true });
};

const currentProfile = () => (palace.profile ? store.get(palace.profile.id) : null);

function setActiveProfile(profile) {
  hud.renderPerson(profile, personHandlers);
  hud.renderPeople(store.all(), profile?.id, enterProfile);
  if (!flow?.busy) hud.setStatus(profile ? `In ${profile.name}'s room` : 'Lobby');
}

function enterProfile(id) {
  const p = store.get(id);
  if (!p) return;
  palace.enterRoom(p);
  setActiveProfile(p);
}

function goLobby() {
  manipulator.deselect();
  palace.showLobby(store.all());
  setActiveProfile(null);
}

// interaction callbacks shared by mouse + XR controllers
const interaction = {
  onDoor: enterProfile,
  onExit: goLobby,
  onConvo: (convoId) => {
    const cv = currentProfile()?.conversations.find((c) => c.id === convoId);
    if (cv) hud.showConversation(cv);
  },
  onTransform: (factId, transform) => {
    const p = currentProfile();
    if (p) store.updateFact(p.id, factId, { transform }, { silent: true });
  },
  onDelete: (factId) => {
    const p = currentProfile();
    if (!p) return;
    store.removeFact(p.id, factId);
    palace.removeFact(factId);
    hud.toast('Fact removed.');
  },
  onSelect: (obj) => {
    if (!obj) return hud.showSelection(null);
    const fact = currentProfile()?.facts.find((f) => f.id === obj.userData.factId);
    hud.showSelection(
      `${FACT_TYPES[fact?.type]?.label ?? 'Fact'}: “${fact?.text ?? ''}” · drag to move · scroll height · R rotate · [ ] size · C colour · Del remove`,
    );
  },
};

const manipulator = new Manipulator(ctx, palace, interaction);
desktop.canStartLook = (e) => !manipulator.pick(e);
const xr = new XRControls(ctx, palace, interaction);

const flow = new EncounterFlow({ mic, transcriber, store, palace, hud, onProfileActive: setActiveProfile });

// ------------------------------------------------------------ in-headset HUD
// The HTML overlay isn't visible inside VR, so mirror status onto a panel
// floating just below your line of sight.
const xrPanel = makeLabel({ title: 'Mind Palace', body: 'Ready', width: 0.55, accent: '#8ea2ff', maxLines: 3 });
xrPanel.position.set(0, -0.28, -0.9);
xrPanel.visible = false;
ctx.camera.add(xrPanel);
hud.onStatus = (text) => xrPanel.userData.update({ body: text });

ctx.renderer.xr.addEventListener('sessionstart', () => {
  xrPanel.visible = true;
  const session = ctx.renderer.xr.getSession();
  // real AR passthrough (e.g. Quest 3): let the camera feed show through
  if (session.environmentBlendMode && session.environmentBlendMode !== 'opaque') {
    ctx.scene.background = null;
    palace.setARMode(true);
  }
});
ctx.renderer.xr.addEventListener('sessionend', () => {
  xrPanel.visible = false;
  if (!passthrough.on) {
    ctx.scene.background = ctx.defaultBackground;
    palace.setARMode(false);
  }
});

// ------------------------------------------------------------- DOM wiring
const personHandlers = {
  onDeleteFact: (factId) => interaction.onDelete(factId),
};

$('consent-script').textContent = `“${CONSENT_SCRIPT}”`;
hud.setSpeechSupport(SpeechTranscriber.supported);

$('btn-start').addEventListener('click', () => flow.start());
document.querySelectorAll('.cancel-btn').forEach((b) => b.addEventListener('click', () => flow.cancel()));
$('btn-match-yes').addEventListener('click', () => flow.confirmMatch(true));
$('btn-match-no').addEventListener('click', () => flow.confirmMatch(false));
$('btn-consent-yes').addEventListener('click', () => flow.giveConsent('button'));
$('btn-consent-no').addEventListener('click', () => flow.declineConsent());
$('btn-end').addEventListener('click', () => flow.end());

$('context-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  flow.submitContext({ name: f.name.value.trim(), where: f.where.value.trim(), howMet: f.howMet.value.trim() });
});

$('note-form').addEventListener('submit', (e) => {
  e.preventDefault();
  flow.addTypedNote(e.target.note.value);
  e.target.note.value = '';
});

$('fact-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const p = currentProfile();
  if (!p) return;
  const saved = store.addFact(p.id, { type: e.target.type.value, text: e.target.text.value, source: 'manual' });
  if (saved) palace.addFact(saved, { animate: true, profileId: p.id });
  else hud.toast('That fact is already in the room.', 'warn');
  e.target.text.value = '';
});

// room customisation (debounced: rebuilding regenerates textures)
let custTimer;
const customise = (patch) => {
  const p = currentProfile();
  if (!p) return;
  store.updateRoom(p.id, patch);
  clearTimeout(custTimer);
  custTimer = setTimeout(() => palace.refreshRoom(store.get(p.id)), 120);
};
$('cust-hue').addEventListener('input', (e) => customise({ hueShift: +e.target.value }));
$('cust-scale').addEventListener('input', (e) => customise({ scale: +e.target.value }));
$('cust-light').addEventListener('input', (e) => customise({ brightness: +e.target.value }));
$('cust-pattern').addEventListener('change', (e) => customise({ pattern: e.target.value }));

$('btn-reset-layout').addEventListener('click', () => {
  const p = currentProfile();
  if (!p) return;
  p.facts.forEach((f) => store.updateFact(p.id, f.id, { transform: null }, { silent: true }));
  palace.refreshRoom(store.get(p.id));
});

$('btn-revoke').addEventListener('click', () => {
  const p = currentProfile();
  if (!p) return;
  if (!window.confirm(`Delete ${p.name}'s voiceprint, facts and conversations? This can't be undone.`)) return;
  store.remove(p.id);
  goLobby();
  hud.toast(`Consent revoked. ${p.name}'s room was deleted.`, 'ok');
});

$('btn-passthrough').addEventListener('click', async () => {
  try {
    hud.setPassthroughLabel(await passthrough.toggle());
  } catch {
    hud.toast('Could not open the webcam. Check camera permissions.', 'error');
  }
});
$('btn-lobby').addEventListener('click', goLobby);

// settings
const syncSettingsUI = () => {
  $('set-threshold').value = CONFIG.matching.threshold;
  $('threshold-val').textContent = `${Math.round(CONFIG.matching.threshold * 100)}%`;
  $('set-seconds').value = CONFIG.voiceprint.captureSeconds;
  $('seconds-val').textContent = `${CONFIG.voiceprint.captureSeconds}s`;
};
$('set-threshold').addEventListener('input', (e) => {
  CONFIG.matching.threshold = +e.target.value;
  saveSettings();
  syncSettingsUI();
});
$('set-seconds').addEventListener('input', (e) => {
  CONFIG.voiceprint.captureSeconds = +e.target.value;
  saveSettings();
  syncSettingsUI();
});
syncSettingsUI();

$('btn-demo').addEventListener('click', () => {
  const existing = new Set(store.all().map((p) => p.name));
  const fresh = createDemoProfiles().filter((p) => !existing.has(p.name));
  if (!fresh.length) return hud.toast('Demo people are already loaded.');
  store.importJSON(JSON.stringify({ profiles: fresh }));
  hud.toast(`Added ${fresh.length} demo people. Check the lobby!`, 'ok');
});

$('btn-export').addEventListener('click', () => {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `palace-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const added = store.importJSON(await file.text());
    hud.toast(`Imported (${added} new people).`, 'ok');
  } catch (err) {
    hud.toast(`Import failed: ${err.message}`, 'error');
  }
  e.target.value = '';
});

$('btn-clear').addEventListener('click', () => {
  if (!window.confirm('Erase every profile, voiceprint and conversation in this browser?')) return;
  flow.cancel();
  store.clear();
  goLobby();
});

// keep the panels and lobby in sync with data changes
store.addEventListener('change', () => {
  hud.renderPeople(store.all(), palace.profile?.id, enterProfile);
  hud.renderPerson(currentProfile(), personHandlers);
  if (palace.mode === 'lobby') palace.showLobby(store.all(), { teleport: false });
});

// ------------------------------------------------------------------- start
palace.showLobby(store.all());
setActiveProfile(null);
if (!store.all().length) {
  setTimeout(() => hud.toast('Tip: Palace tab → “Load demo people” to see rooms instantly. Press H for controls.'), 600);
}

const timer = new THREE.Timer();
ctx.renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (ctx.renderer.xr.isPresenting) xr.update(dt);
  else desktop.update(dt);
  palace.update(dt, timer.getElapsed());
  ctx.renderer.render(ctx.scene, ctx.camera);
});

// Picavoice: rooms and live facts from the glasses when served by the Picavoice server
startPicavoiceBridge({ store, palace, hud });

// handy for poking at things from the devtools console during the demo
window.mindPalace = { ctx, store, palace, flow, CONFIG };

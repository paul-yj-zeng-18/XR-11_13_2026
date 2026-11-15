import { CONFIG } from '../config.js';

export const uid = (prefix = 'id') =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;

const now = () => new Date().toISOString();
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Local-only persistence (localStorage). Nothing leaves the device.
 * Fires a 'change' event whenever data is written.
 *
 * Profile shape:
 * {
 *   id, name, createdAt, updatedAt, demo?,
 *   consent: { given, at, method },
 *   voiceprint: { mfccMean[], mfccStd[], pitch, pitchStd, centroid, frames, samples },
 *   facts: [{ id, type, text, source, convoId, createdAt, transform }],
 *   conversations: [{ id, date, where, howMet, transcript, summary, keywords[] }],
 *   room: { hueShift, scale, pattern, brightness }
 * }
 */
export class ProfileStore extends EventTarget {
  constructor(storage = globalThis.localStorage, key = CONFIG.storageKey) {
    super();
    this.storage = storage;
    this.key = key;
    this.profiles = this._load();
  }

  _load() {
    try {
      const raw = this.storage?.getItem(this.key);
      const data = raw ? JSON.parse(raw) : null;
      return Array.isArray(data?.profiles) ? data.profiles : [];
    } catch {
      return [];
    }
  }

  _commit() {
    this.storage?.setItem(this.key, JSON.stringify({ version: 1, profiles: this.profiles }));
    this.dispatchEvent(new Event('change'));
  }

  all() {
    return this.profiles;
  }

  get(id) {
    return this.profiles.find((p) => p.id === id) ?? null;
  }

  create({ name, voiceprint = null, consent, demo = false }) {
    if (!consent?.given) throw new Error('Refusing to create a profile without consent');
    const profile = {
      id: uid('p'),
      name: name || 'Unknown',
      createdAt: now(),
      updatedAt: now(),
      demo,
      consent,
      voiceprint,
      facts: [],
      conversations: [],
      room: { hueShift: 0, scale: 1, pattern: 'voice', brightness: 1 },
    };
    this.profiles.push(profile);
    this._commit();
    return profile;
  }

  update(id, patch) {
    const p = this.get(id);
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: now() });
    this._commit();
    return p;
  }

  updateRoom(id, roomPatch) {
    const p = this.get(id);
    if (!p) return null;
    p.room = { ...p.room, ...roomPatch };
    this._commit();
    return p;
  }

  updateVoiceprint(id, voiceprint) {
    return this.update(id, { voiceprint });
  }

  /** Returns the saved fact, or null if it's a duplicate. */
  addFact(id, fact) {
    const p = this.get(id);
    if (!p || !fact?.text) return null;
    const key = `${fact.type}:${norm(fact.text)}`;
    if (p.facts.some((f) => `${f.type}:${norm(f.text)}` === key)) return null;
    const saved = {
      id: uid('f'),
      type: fact.type || 'note',
      text: fact.text.trim(),
      source: fact.source || 'manual',
      convoId: fact.convoId ?? null,
      createdAt: now(),
      transform: fact.transform ?? null,
    };
    p.facts.push(saved);
    p.updatedAt = now();
    this._commit();
    return saved;
  }

  updateFact(id, factId, patch, { silent = false } = {}) {
    const f = this.get(id)?.facts.find((x) => x.id === factId);
    if (!f) return null;
    Object.assign(f, patch);
    if (silent) this.storage?.setItem(this.key, JSON.stringify({ version: 1, profiles: this.profiles }));
    else this._commit();
    return f;
  }

  removeFact(id, factId) {
    const p = this.get(id);
    if (!p) return;
    p.facts = p.facts.filter((f) => f.id !== factId);
    this._commit();
  }

  addConversation(id, convo) {
    const p = this.get(id);
    if (!p) return null;
    const saved = { id: convo.id || uid('c'), ...convo };
    p.conversations.push(saved);
    p.updatedAt = now();
    this._commit();
    return saved;
  }

  remove(id) {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this._commit();
  }

  clear() {
    this.profiles = [];
    this._commit();
  }

  exportJSON() {
    return JSON.stringify({ version: 1, exportedAt: now(), profiles: this.profiles }, null, 2);
  }

  importJSON(text) {
    const data = JSON.parse(text);
    if (!Array.isArray(data?.profiles)) throw new Error('Not a Mind Palace export');
    let added = 0;
    for (const p of data.profiles) {
      if (!p?.id || !p.consent?.given) continue;
      const idx = this.profiles.findIndex((x) => x.id === p.id);
      if (idx >= 0) this.profiles[idx] = p;
      else {
        this.profiles.push(p);
        added++;
      }
    }
    this._commit();
    return added;
  }
}

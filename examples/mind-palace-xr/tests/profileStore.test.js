import { describe, it, expect, beforeEach } from 'vitest';
import { ProfileStore } from '../src/profiles/profileStore.js';
import { classifyConsent } from '../src/profiles/consent.js';

class MemoryStorage {
  constructor() {
    this.data = {};
  }
  getItem(k) {
    return this.data[k] ?? null;
  }
  setItem(k, v) {
    this.data[k] = v;
  }
}

describe('ProfileStore', () => {
  let storage;
  let store;
  beforeEach(() => {
    storage = new MemoryStorage();
    store = new ProfileStore(storage, 'test');
  });

  it('refuses to create a profile without consent', () => {
    expect(() => store.create({ name: 'X' })).toThrow();
  });

  it('persists and reloads profiles', () => {
    const p = store.create({ name: 'Maya', consent: { given: true, at: 'now', method: 'test' } });
    store.addFact(p.id, { type: 'likes', text: 'bouldering' });
    const reloaded = new ProfileStore(storage, 'test');
    expect(reloaded.get(p.id).facts[0].text).toBe('bouldering');
  });

  it('dedupes facts', () => {
    const p = store.create({ name: 'Maya', consent: { given: true } });
    expect(store.addFact(p.id, { type: 'likes', text: 'Bouldering' })).not.toBeNull();
    expect(store.addFact(p.id, { type: 'likes', text: 'bouldering!' })).toBeNull();
  });

  it('removes everything on revoke', () => {
    const p = store.create({ name: 'Maya', consent: { given: true } });
    store.remove(p.id);
    expect(store.all()).toHaveLength(0);
  });
});

describe('classifyConsent', () => {
  it.each([
    ['Yes, that is fine', 'yes'],
    ["Sure go ahead", 'yes'],
    ["I don't mind", 'yes'],
    ['No thanks', 'no'],
    ["I'd rather not", 'no'],
    ['hmm what is it for', null],
  ])('%s -> %s', (text, expected) => {
    expect(classifyConsent(text)).toBe(expected);
  });
});

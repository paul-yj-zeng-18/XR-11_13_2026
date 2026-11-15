import { describe, expect, it, vi } from 'vitest';
import { PV_PREFIX, startPicavoiceBridge, toPalaceProfile } from '../src/picavoice/bridge.js';
import { ProfileStore } from '../src/profiles/profileStore.js';

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
};

const maya = {
  id: 7, display_name: 'Maya Chen', role: 'Product designer', met_at: 'Demo booth', notes: null,
  voice_consent: 1, consent_at: 1_700_000_000_000, created_at: 1_700_000_000_000,
  conversations: [{ run_id: 'r1', started_at: 1_700_000_000_000, lines: 2, transcript: 'I work at a design studio. Onboarding should start with a voice tutorial.' }],
};

/** A fake Picavoice server: people, one live run, and lines we can add to. */
function fakeServer() {
  const s = { people: [maya, { id: 8, display_name: 'Priya', voice_consent: 0 }], lines: [], run: 'r2' };
  s.fetch = vi.fn(async (path) => {
    const ok = (body) => ({ ok: true, json: async () => body });
    if (path === '/api/people') return ok({ people: s.people });
    const m = path.match(/^\/api\/people\/(\d+)$/);
    if (m) return ok({ person: s.people.find((p) => p.id === Number(m[1])) });
    if (path === '/api/live') return ok({ live: { run_id: s.run, started_at: 1_700_000_100_000, ended_at: null } });
    const u = path.match(/utterances\?after=(\d+)$/);
    if (u) {
      const rows = s.lines.filter((l) => l.id > Number(u[1]));
      return ok({ utterances: rows, lastId: rows.length ? rows.at(-1).id : Number(u[1]) });
    }
    return { ok: false, status: 404 };
  });
  return s;
}

describe('Picavoice bridge', () => {
  it('turns a Picavoice person into a consented profile with facts and a timeline', () => {
    const p = toPalaceProfile(maya);
    expect(p.id).toBe('pv_7');
    expect(p.consent.given).toBe(true);
    expect(p.facts.map((f) => [f.type, f.text])).toEqual([
      ['name', 'Maya Chen'], ['work', 'Product designer'], ['place', 'met at Demo booth'],
    ]);
    expect(p.conversations).toHaveLength(1);
    expect(p.conversations[0].howMet).toBe('Picavoice glasses');
    expect(p.conversations[0].summary.length).toBeGreaterThan(0);
  });

  it('syncs consented people, adds live facts, and removes deleted people', async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const store = new ProfileStore(memoryStorage(), 'test');
    const palace = { profile: null, refreshRoom: vi.fn() };
    const started = await startPicavoiceBridge({ store, palace, hud: { toast() {} }, intervalMs: 1000, fetchImpl: server.fetch });
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.all().map((p) => p.name)).toEqual(['Maya Chen']); // Priya chose name only

    server.lines.push({ id: 1, speech_final: 1, person_id: 7, text: "I'm building a plant-watering drone." });
    server.lines.push({ id: 2, speech_final: 1, person_id: null, text: 'Someone not saved.' });
    await vi.advanceTimersByTimeAsync(1000);
    const p = store.get(`${PV_PREFIX}7`);
    expect(p.facts.some((f) => f.type === 'project' && f.source === 'glasses')).toBe(true);
    const live = p.conversations.find((c) => c.id === 'pv_c_r2');
    expect(live.transcript).toBe("I'm building a plant-watering drone.");

    // A new person mid-conversation makes the bridge re-read the run: no line is added twice.
    server.people.push({ ...maya, id: 9, display_name: 'Jo', conversations: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.get(`${PV_PREFIX}7`).conversations.find((c) => c.id === 'pv_c_r2').transcript).toBe("I'm building a plant-watering drone.");
    expect(store.get(`${PV_PREFIX}9`).name).toBe('Jo');

    server.people = server.people.filter((x) => x.id !== 7);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.get(`${PV_PREFIX}7`)).toBeNull();
    vi.useRealTimers();
  });

  it('does nothing when not served by Picavoice', async () => {
    const store = new ProfileStore(memoryStorage(), 'test');
    const started = await startPicavoiceBridge({ store, palace: {}, fetchImpl: async () => ({ ok: false, status: 404 }) });
    expect(started).toBe(false);
    expect(store.all()).toEqual([]);
  });
});

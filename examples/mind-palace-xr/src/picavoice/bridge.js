/**
 * Picavoice bridge (added for the Picavoice example; not in the original Mind Palace XR).
 *
 * When this app is served by the Picavoice server (`bun run ingest` → /palace/):
 * - everyone in Picavoice who agreed to a voice profile gets a room;
 * - each Picavoice conversation becomes a card on their timeline wall;
 * - what they say through the glasses is added live: new facts appear as
 *   objects in their room and the conversation card updates;
 * - deleting someone in Picavoice removes their room here.
 * On any other host (e.g. `npm run dev`) /api/people is missing and this does nothing.
 */
import { extractFacts, summarizeConversation } from '../profiles/factExtractor.js';

export const PV_PREFIX = 'pv_';
const iso = (ms) => new Date(ms ?? Date.now()).toISOString();
const convoId = (runId) => `${PV_PREFIX}c_${runId}`;

/** A Picavoice person (GET /api/people/:id) as a Mind Palace profile. */
export function toPalaceProfile(d, { skipRun = null } = {}) {
  const facts = [];
  const fact = (type, text) => text && facts.push({
    id: `${PV_PREFIX}f_${d.id}_${facts.length}`, type, text, source: 'picavoice',
    convoId: null, createdAt: iso(d.created_at), transform: null,
  });
  fact('name', d.display_name);
  fact('work', d.role);
  fact('place', d.met_at ? `met at ${d.met_at}` : null);
  fact('note', d.notes);
  return {
    id: PV_PREFIX + d.id,
    name: d.display_name,
    createdAt: iso(d.created_at),
    updatedAt: iso(),
    demo: false,
    consent: { given: true, at: iso(d.consent_at ?? d.created_at), method: 'spoken (Picavoice)' },
    voiceprint: null,
    facts,
    // The live conversation is built line by line by the bridge, so it is skipped here.
    conversations: (d.conversations || []).filter((c) => c.run_id !== skipRun).reverse().map((c) => ({
      id: convoId(c.run_id),
      date: iso(c.started_at),
      where: d.met_at || '',
      howMet: 'Picavoice glasses',
      transcript: c.transcript || '',
      ...summarizeConversation(c.transcript || ''),
    })),
    room: { hueShift: 0, scale: 1, pattern: 'voice', brightness: 1 },
  };
}

export function startPicavoiceBridge({ store, palace, hud, intervalMs = 2500, fetchImpl = fetch }) {
  const st = { run: null, after: 0, busy: false, done: new Set() };
  const get = async (path) => {
    const r = await fetchImpl(path, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  };

  async function syncPeople(liveRun) {
    const { people } = await get('/api/people');
    const consented = people.filter((p) => p.voice_consent);
    const missing = consented.filter((p) => !store.get(PV_PREFIX + p.id));
    if (missing.length) {
      const details = await Promise.all(missing.map((p) => get(`/api/people/${p.id}`).then((r) => r.person)));
      store.importJSON(JSON.stringify({ profiles: details.map((d) => toPalaceProfile(d, { skipRun: liveRun })) }));
      st.after = 0; // re-read the live conversation so the new people get their lines from it
      hud?.toast(`${missing.length} ${missing.length === 1 ? 'person' : 'people'} from Picavoice`);
    }
    for (const p of consented) {
      const have = store.get(PV_PREFIX + p.id);
      if (have && have.name !== p.display_name) store.update(have.id, { name: p.display_name });
    }
    // Deleted in Picavoice: their room goes too.
    const keep = new Set(consented.map((p) => PV_PREFIX + p.id));
    for (const p of [...store.all()]) if (p.id.startsWith(PV_PREFIX) && !keep.has(p.id)) store.remove(p.id);
  }

  async function pollSpeech(live) {
    if (!live) return;
    if (live.run_id !== st.run) { st.run = live.run_id; st.after = 0; st.done.clear(); }
    const { utterances, lastId } = await get(`/api/sessions/${encodeURIComponent(st.run)}/utterances?after=${st.after}`);
    st.after = lastId;
    const touched = new Set();
    for (const u of utterances) {
      if (!u.speech_final || !u.person_id || !u.text || st.done.has(u.id)) continue;
      const id = PV_PREFIX + u.person_id;
      const p = store.get(id);
      if (!p) continue;
      st.done.add(u.id);
      const cid = convoId(st.run);
      let convo = p.conversations.find((c) => c.id === cid);
      if (!convo) {
        convo = store.addConversation(id, {
          id: cid, date: iso(live.started_at), where: p.facts.find((f) => f.type === 'place')?.text.replace(/^met at /, '') || '',
          howMet: 'Picavoice glasses', transcript: '', summary: '', keywords: [],
        });
      }
      convo.transcript = `${convo.transcript} ${u.text}`.trim();
      Object.assign(convo, summarizeConversation(convo.transcript));
      for (const f of extractFacts(u.text)) if (f.type !== 'name') store.addFact(id, { ...f, source: 'glasses', convoId: cid });
      touched.add(id);
    }
    for (const id of touched) {
      store.update(id, {}); // saves the conversation edits
      if (palace.profile?.id === id) palace.refreshRoom(store.get(id));
    }
  }

  async function tick() {
    if (st.busy) return;
    st.busy = true;
    try {
      const { live } = await get('/api/live');
      await syncPeople(live?.run_id ?? null);
      await pollSpeech(live);
    } catch (e) { console.warn('[picavoice]', e.message); } finally { st.busy = false; }
  }

  return fetchImpl('/api/people', { cache: 'no-store' })
    .then((r) => {
      if (!r.ok) return false;
      tick();
      setInterval(tick, intervalMs);
      return true;
    })
    .catch(() => false);
}

import { $, h, fmtDate } from './dom.js';
import { FACT_TYPES } from '../scene/factObjects.js';
import { isTyping } from '../controls/desktopControls.js';

const FACT_ICON = { name: '🪪', work: '💼', study: '🎓', place: '📍', likes: '❤️', family: '👪', project: '🛠️', note: '📝' };

/** All the 2D overlay rendering. Logic lives in encounterFlow.js / main.js. */
export class Hud {
  constructor() {
    this.onStatus = null; // mirrored into the in-headset panel
    this.meter = $('meter').getContext('2d');
    this.levels = [];

    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => this.setTab(b.dataset.tab)));
    $('btn-help').addEventListener('click', () => this.toggleModal('help'));
    document.querySelectorAll('.modal').forEach((m) =>
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.classList.contains('modal-close')) m.hidden = true;
      }),
    );
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (e.code === 'KeyH') this.toggleModal('help');
      if (e.code === 'Escape') document.querySelectorAll('.modal').forEach((m) => (m.hidden = true));
      if (e.code === 'KeyP') $('panel').classList.toggle('collapsed');
    });

    const typeSelect = document.querySelector('#fact-form select');
    for (const [key, meta] of Object.entries(FACT_TYPES)) typeSelect.append(h('option', { value: key }, meta.label));
  }

  setStatus(text, tone = 'info') {
    const el = $('status');
    el.textContent = text;
    el.dataset.tone = tone;
    this.onStatus?.(text);
  }

  showStep(step) {
    document.querySelectorAll('#tab-encounter .step').forEach((s) => s.classList.toggle('active', s.dataset.step === step));
  }

  setTab(tab) {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${tab}`));
    $('panel').classList.remove('collapsed');
  }

  toggleModal(id) {
    const m = $(id);
    m.hidden = !m.hidden;
  }

  setSpeechSupport(ok) {
    $('speech-support').textContent = ok
      ? 'Live transcription: on (Web Speech API).'
      : 'Live transcription needs Chrome or Edge. You can still type notes.';
  }

  progress(p) {
    $('capture-progress').style.width = `${Math.round(p * 100)}%`;
  }

  drawMeter(level) {
    const ctx = this.meter;
    const { width: W, height: H } = ctx.canvas;
    this.levels.push(Math.min(1, level * 12));
    if (this.levels.length > 60) this.levels.shift();
    ctx.clearRect(0, 0, W, H);
    const bw = W / 60;
    this.levels.forEach((l, i) => {
      const bh = Math.max(2, l * H);
      ctx.fillStyle = `hsl(${220 - l * 160}, 90%, 65%)`;
      ctx.fillRect(i * bw + 1, (H - bh) / 2, bw - 2, bh);
    });
  }

  setTranscript(finalText, interim) {
    $('transcript-final').textContent = finalText;
    $('transcript-interim').textContent = interim ? ` ${interim}` : '';
    $('transcript').classList.toggle('visible', !!(finalText || interim));
  }

  showMatch(name, score, ranking = []) {
    $('match-name').textContent = name;
    $('match-score').textContent = `${Math.round(score * 100)}% match`;
    this.showMatchDebug(ranking);
  }

  showMatchDebug(ranking = []) {
    // shown so you can tune the threshold live during the demo
    const items = () => ranking.slice(0, 3).map((r) => h('li', {}, `closest: ${r.profile.name} ${Math.round(r.score * 100)}%`));
    $('match-debug').replaceChildren(...items());
    $('match-debug-2').replaceChildren(...items());
  }

  fillContext({ name = '', where = '', howMet = '' }) {
    const f = $('context-form');
    f.name.value = name;
    f.where.value = where;
    f.howMet.value = howMet;
    setTimeout(() => f.name.focus(), 50);
  }

  clearLiveFacts() {
    $('live-facts').replaceChildren();
  }

  addLiveFact(fact) {
    $('live-facts').prepend(h('li', { class: 'pop' }, `${FACT_ICON[fact.type] ?? '•'} `, h('b', {}, FACT_TYPES[fact.type]?.label ?? 'Note'), ` ${fact.text}`));
  }

  renderPeople(profiles, currentId, onEnter) {
    const list = $('people-list');
    if (!profiles.length) {
      list.replaceChildren(h('li', { class: 'empty' }, 'No one yet. Start an encounter or load the demo people.'));
      return;
    }
    list.replaceChildren(
      ...profiles.map((p) =>
        h(
          'li',
          { class: p.id === currentId ? 'current' : '' },
          h('button', { class: 'link', onclick: () => onEnter(p.id) }, p.name),
          h('span', { class: 'hint' }, ` ${p.facts.length} facts · ${p.conversations.length} chats${p.demo ? ' · demo' : ''}`),
        ),
      ),
    );
  }

  renderPerson(profile, handlers) {
    $('person-empty').hidden = !!profile;
    $('person-detail').hidden = !profile;
    if (!profile) return;

    $('person-name').textContent = profile.name;
    const c = profile.consent;
    $('person-consent').textContent = c?.given
      ? `Consent given ${fmtDate(c.at)} (${c.method}). Voiceprint samples: ${profile.voiceprint?.samples ?? 0}.`
      : 'No consent on file.';

    $('person-facts').replaceChildren(
      ...(profile.facts.length
        ? profile.facts.map((f) =>
            h(
              'li',
              {},
              `${FACT_ICON[f.type] ?? '•'} `,
              h('b', {}, FACT_TYPES[f.type]?.label ?? 'Note'),
              ` ${f.text} `,
              h('button', { class: 'icon', title: 'Delete fact', onclick: () => handlers.onDeleteFact(f.id) }, '✕'),
            ),
          )
        : [h('li', { class: 'empty' }, 'No facts yet.')]),
    );

    const convos = [...profile.conversations].reverse();
    $('person-convos').replaceChildren(
      ...(convos.length
        ? convos.map((cv) =>
            h(
              'li',
              {},
              h('button', { class: 'link', onclick: () => this.showConversation(cv) }, fmtDate(cv.date)),
              h('div', { class: 'hint' }, [cv.where, cv.howMet].filter(Boolean).join(' · ')),
            ),
          )
        : [h('li', { class: 'empty' }, 'No conversations yet.')]),
    );

    const room = profile.room ?? {};
    $('cust-hue').value = room.hueShift ?? 0;
    $('cust-scale').value = room.scale ?? 1;
    $('cust-pattern').value = room.pattern ?? 'voice';
    $('cust-light').value = room.brightness ?? 1;
  }

  showConversation(cv) {
    $('convo-body').replaceChildren(
      h('h2', {}, fmtDate(cv.date)),
      cv.where ? h('p', {}, h('b', {}, 'Where: '), cv.where) : null,
      cv.howMet ? h('p', {}, h('b', {}, 'How we met: '), cv.howMet) : null,
      h('p', {}, h('b', {}, 'Summary: '), cv.summary || '—'),
      cv.keywords?.length ? h('p', { class: 'chips' }, ...cv.keywords.map((k) => h('span', { class: 'chip' }, k))) : null,
      h('h3', {}, 'Transcript'),
      h('p', { class: 'transcript-full' }, cv.transcript || '(empty)'),
    );
    $('convo-modal').hidden = false;
  }

  showSelection(text) {
    const el = $('selection-hint');
    el.hidden = !text;
    el.textContent = text || '';
  }

  setPassthroughLabel(on) {
    $('btn-passthrough').textContent = `Passthrough: ${on ? 'on' : 'off'}`;
    $('btn-passthrough').classList.toggle('on', on);
  }

  toast(msg, tone = 'info') {
    const t = h('div', { class: `toast ${tone}` }, msg);
    $('toasts').append(t);
    setTimeout(() => t.classList.add('out'), 3200);
    setTimeout(() => t.remove(), 3800);
  }
}

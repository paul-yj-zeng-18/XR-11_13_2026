import { uid } from './profileStore.js';

// Two pre-built people so the palace isn't empty when judges walk up.
// Their voiceprints are synthetic, so they won't match a real voice -
// enroll a teammate live to show recognition.

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function fakePrint(seed, pitch) {
  const r = (i) => Math.sin(seed * 12.9898 + i * 78.233) * 0.5;
  return {
    version: 1,
    mfccMean: Array.from({ length: 13 }, (_, i) => (i === 0 ? -40 : (12 - i) * 1.4 + r(i) * 6)),
    mfccStd: Array.from({ length: 13 }, (_, i) => 3 + Math.abs(r(i + 20)) * 3),
    pitch,
    pitchStd: 18 + seed * 4,
    centroid: 1200 + seed * 450,
    frames: 200,
    samples: 3,
  };
}

function fact(type, text, convoId) {
  return { id: uid('f'), type, text, source: 'demo', convoId, createdAt: daysAgo(1), transform: null };
}

export function createDemoProfiles() {
  const c1 = uid('c');
  const c2 = uid('c');
  const c3 = uid('c');
  return [
    {
      id: uid('p'),
      name: 'Maya Chen',
      demo: true,
      createdAt: daysAgo(30),
      updatedAt: daysAgo(2),
      consent: { given: true, at: daysAgo(30), method: 'demo' },
      voiceprint: fakePrint(1, 215),
      facts: [
        fact('name', 'Maya Chen', c1),
        fact('work', 'hardware engineer at Rivian', c1),
        fact('study', 'electrical engineering at UIUC', c1),
        fact('likes', 'bouldering', c1),
        fact('place', 'Champaign', c2),
        fact('project', 'building a haptic glove', c2),
        fact('family', 'dog named Pixel', c2),
      ],
      conversations: [
        {
          id: c1,
          date: daysAgo(30),
          where: 'HackIllinois, Siebel Center',
          howMet: 'Same table at the opening ceremony',
          transcript: 'Hi I am Maya Chen. I work at Rivian as a hardware engineer. I love bouldering.',
          summary: 'Hardware engineer at Rivian, studied EE at UIUC. Big into bouldering.',
          keywords: ['hardware', 'rivian', 'bouldering'],
        },
        {
          id: c2,
          date: daysAgo(2),
          where: 'Coffee at Siebel',
          howMet: 'Follow-up',
          transcript: "I'm working on a haptic glove for VR. My dog Pixel keeps chewing the prototypes.",
          summary: 'Building a haptic glove for VR; her dog Pixel keeps chewing the prototypes.',
          keywords: ['haptic', 'glove', 'pixel'],
        },
      ],
      room: { hueShift: 0, scale: 1, pattern: 'voice', brightness: 1 },
    },
    {
      id: uid('p'),
      name: 'Jordan Alvarez',
      demo: true,
      createdAt: daysAgo(10),
      updatedAt: daysAgo(10),
      consent: { given: true, at: daysAgo(10), method: 'demo' },
      voiceprint: fakePrint(2, 112),
      facts: [
        fact('name', 'Jordan Alvarez', c3),
        fact('work', 'product designer at a fintech startup', c3),
        fact('place', 'Chicago', c3),
        fact('likes', 'jazz and vinyl records', c3),
      ],
      conversations: [
        {
          id: c3,
          date: daysAgo(10),
          where: 'Chicago XR Meetup',
          howMet: 'Introduced by Maya',
          transcript: "I'm a product designer. I live in Chicago and I'm really into jazz and vinyl records.",
          summary: 'Product designer from Chicago who collects jazz records.',
          keywords: ['designer', 'chicago', 'jazz'],
        },
      ],
      room: { hueShift: 0, scale: 1, pattern: 'voice', brightness: 1 },
    },
  ];
}

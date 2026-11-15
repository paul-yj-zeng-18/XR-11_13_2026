// Rule-based fact extraction from transcribed speech. Runs fully offline.
// Deliberately conservative: a missed fact can be added by hand, but a junk
// fact floating in someone's room is awkward in a demo.

const STOPWORDS = new Set(
  `a an the and or but if so to of in on at for with from by about as is are was were be been being
  i me my we our you your he she they them it its this that these those there here what which who
  do does did have has had just really very like um uh yeah okay ok so well kind sort lot also then
  than too can could would should will gonna wanna get got go going know think mean thing things
  right yes no not dont im its thats youre were theyre ive id ill some any all much many more most`.split(/\s+/),
);

const NOT_NAMES = new Set(
  `going gonna just here so really not a an the from working looking trying doing good fine great sorry
  happy excited new in at with on still also very currently originally glad sure ready back done tired
  okay ok actually kind thinking hoping super pretty interested curious`.split(/\s+/),
);

const JUNK = new Set(['it', 'that', 'this', 'you', 'them', 'him', 'her', 'to', 'the', 'stuff', 'things', 'everything']);

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function cleanFragment(fragment, maxWords = 7) {
  let s = fragment.split(/\b(?:and then|and (?:i|i'm|my|we|she|he|they)|but|because|although|though|which|who|so i|so we)\b/i)[0];
  s = s.replace(/[.,!?;:].*$/, '').trim();
  const words = s.split(/\s+/).filter(Boolean).slice(0, maxWords);
  return words
    .join(' ')
    .replace(/\s+(?:and|or|the|a|an|to|of|in|at|with|for|um|uh)$/i, '')
    .trim();
}

const PATTERNS = [
  { type: 'name', re: /\b(?:my name is|my name's|call me|i go by)\s+([a-z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)/gi, name: true },
  { type: 'name', re: /\b(?:I'm|I am|this is|it's)\s+([A-Z][a-z'-]+(?:\s+[A-Z][a-z'-]+)?)/g, name: true },
  {
    type: 'work',
    re: /\bi(?: work|'m working| am working| worked| intern|'m interning| am interning| do research) (?:at|for|with)\s+([^.,!?;]+)/gi,
  },
  {
    type: 'work',
    re: /\bi(?:'m| am| work as) an? ((?:[a-z-]+\s){0,3}(?:engineer|developer|designer|student|researcher|scientist|teacher|professor|doctor|nurse|manager|founder|artist|writer|analyst|consultant|intern|lawyer|architect|musician|chef|photographer))\b/gi,
  },
  {
    type: 'study',
    re: /\bi(?: study|'m studying| am studying| major in|'m majoring in| am majoring in| majored in| studied)\s+([^.,!?;]+)/gi,
  },
  { type: 'place', re: /\bi(?: live| grew up| was born|'m based| am based)\s+(?:in|near|out of)\s+([^.,!?;]+)/gi },
  { type: 'place', re: /\b(?:i'm|i am|i come|i'm originally|i am originally) from\s+([^.,!?;]+)/gi },
  {
    type: 'likes',
    re: /\bi(?: really| absolutely| also| kind of)?(?: love| like| enjoy|'m into| am into|'m obsessed with| am obsessed with|'m a big fan of)\s+([^.,!?;]+)/gi,
  },
  {
    type: 'likes',
    re: /\bmy (?:favorite|favourite) ([a-z]+) is\s+([^.,!?;]+)/gi,
    combine: (m) => `${cleanFragment(m[2], 5)} (favorite ${m[1]})`,
  },
  {
    type: 'family',
    re: /\bmy (wife|husband|partner|boyfriend|girlfriend|son|daughter|kids?|children|brother|sister|mom|mother|dad|father|dog|cat|parents|roommate)\b([^.,!?;]*)/gi,
    combine: (m) => `${m[1]} ${cleanFragment(m[2], 6)}`.trim(),
  },
  {
    type: 'project',
    re: /\bi(?:'m| am|'ve been| have been) (?:working on|building|making|developing|planning to|trying to|hoping to)\s+([^.,!?;]+)/gi,
  },
];

export function extractFacts(text) {
  if (!text) return [];
  const t = text.replace(/[’‘]/g, "'");
  const out = [];
  const seen = new Set();

  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(t))) {
      let value;
      if (p.combine) value = p.combine(m);
      else if (p.name) {
        const words = m[1]
          .split(/\s+/)
          .filter((w) => !NOT_NAMES.has(w.toLowerCase()) && !STOPWORDS.has(w.toLowerCase()));
        if (!words.length || NOT_NAMES.has(m[1].split(/\s+/)[0].toLowerCase())) continue;
        value = titleCase(words.slice(0, 2).join(' '));
      } else value = cleanFragment(m[1]);

      if (!value || value.length < 2 || JUNK.has(value.toLowerCase())) continue;
      const key = `${p.type}:${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: p.type, text: value });
    }
  }
  return out;
}

export function extractName(text) {
  return extractFacts(text).find((f) => f.type === 'name')?.text ?? null;
}

/** Cheap extractive summary + keywords for the timeline cards. */
export function summarizeConversation(transcript) {
  const clean = (transcript || '').trim();
  if (!clean) return { summary: 'No notes captured.', keywords: [] };

  const words = clean.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/);
  const freq = new Map();
  for (const w of words) {
    const k = w.replace(/'/g, '');
    if (k.length < 4 || STOPWORDS.has(k)) continue;
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const keywords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);

  const sentences = clean.split(/(?<=[.!?])\s+/).filter((s) => s.split(/\s+/).length >= 3);
  if (!sentences.length) return { summary: clean.slice(0, 200), keywords };

  const scored = sentences.map((s, i) => {
    const ws = s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/);
    const score = ws.reduce((acc, w) => acc + (freq.get(w) || 0), 0) / Math.sqrt(ws.length);
    return { s, i, score };
  });
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);

  let summary = top.join(' ');
  if (summary.length > 220) summary = `${summary.slice(0, 217)}...`;
  return { summary, keywords };
}

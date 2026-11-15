import { describe, it, expect } from 'vitest';
import { extractFacts, extractName, summarizeConversation } from '../src/profiles/factExtractor.js';

const types = (text) => extractFacts(text).map((f) => `${f.type}:${f.text}`);

describe('extractFacts', () => {
  it('pulls a name from an introduction', () => {
    expect(extractName('Hi, my name is maya chen and I study physics')).toBe('Maya Chen');
    expect(extractName("Hey I'm Jordan, nice to meet you")).toBe('Jordan');
  });

  it('does not mistake "I\'m going" for a name', () => {
    expect(extractName("I'm going to grab coffee")).toBeNull();
    expect(extractName("I'm Really tired")).toBeNull();
  });

  it('finds work, study, place and likes', () => {
    const facts = types(
      "I work at Rivian on battery systems. I'm studying computer engineering. I grew up in Chicago. I really love bouldering.",
    );
    expect(facts).toContain('work:Rivian on battery systems');
    expect(facts).toContain('study:computer engineering');
    expect(facts).toContain('place:Chicago');
    expect(facts).toContain('likes:bouldering');
  });

  it('handles job titles and family', () => {
    const facts = types("I'm a product designer. My dog is called Pixel.");
    expect(facts).toContain('work:product designer');
    expect(facts.some((f) => f.startsWith('family:dog'))).toBe(true);
  });

  it('cuts fragments at conjunctions', () => {
    expect(types('I live in Urbana but I work remotely')).toContain('place:Urbana');
  });

  it('stops before a new clause starting with "and I"', () => {
    const facts = types('I work at Google on maps and I really love jazz');
    expect(facts).toContain('work:Google on maps');
    expect(facts).toContain('likes:jazz');
  });

  it('ignores junk objects', () => {
    expect(extractFacts('I like that.')).toEqual([]);
  });
});

describe('summarizeConversation', () => {
  it('returns keywords and a short summary', () => {
    const { summary, keywords } = summarizeConversation(
      'I build haptic gloves. The haptic glove uses tiny motors. My dog chews the gloves. Anyway nice weather.',
    );
    expect(summary.length).toBeGreaterThan(10);
    expect(keywords).toContain('haptic');
  });

  it('handles empty input', () => {
    expect(summarizeConversation('').summary).toMatch(/no notes/i);
  });
});

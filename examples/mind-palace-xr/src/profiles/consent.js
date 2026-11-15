// Classifies a spoken reply to the consent question.
// Returns 'yes' | 'no' | null (unclear -> keep waiting / use the buttons).

const NOT_MIND = /\b(?:don'?t|do not)\s+(?:mind|care)\b/i;
const NO = /\b(?:no|nope|nah|don'?t|do not|rather not|decline|not okay|not ok)\b/i;
const YES = /\b(?:yes|yeah|yep|yup|sure|of course|absolutely|i consent|i agree|that'?s fine|go ahead|okay|ok|fine by me|sounds good)\b/i;

export function classifyConsent(text) {
  if (!text) return null;
  const t = text.replace(/’/g, "'");
  if (NOT_MIND.test(t)) return 'yes';
  if (NO.test(t)) return 'no';
  if (YES.test(t)) return 'yes';
  return null;
}

export const CONSENT_SCRIPT =
  "I use a memory app that saves a short voice signature and notes from our chat so I can remember you next time. No audio is recorded. Is that OK with you?";

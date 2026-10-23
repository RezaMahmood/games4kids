// Pure: no DOM, no network. data/content.ts and data/score.ts hold the same rules for the server, and
// test/timedetectives/parity.test.mjs keeps the two equal. The admin page holds a byte for byte copy.

export const QUESTION_KINDS = {
  who: { label: 'Who is it?' },
  where: { label: 'Where is it?' },
  when: { label: 'When was it?' },
};

/** @typedef {keyof typeof CONFIDENCE} Confidence */
export const CONFIDENCE = {
  lots: { label: 'Yes, I know a lot about this subject', paragraph: 'brief', choices: 4, bonus: 1.5 },
  bit: { label: 'I know a bit about the subject', paragraph: 'full', choices: 4, bonus: 1.2 },
  easy: { label: 'No, please go easy on me', paragraph: 'full', choices: 3, bonus: 1 },
};

export const POINTS = { firstTry: 10, secondTry: 5, hint: 3 };

/** One question's points, so the page can say "+10" the moment a child taps. The server marks the round again. */
export function questionPoints({ tries, hint }, answer) {
  const base = tries[0] === answer ? POINTS.firstTry : tries[1] === answer ? POINTS.secondTry : 0;
  return Math.max(0, base - (hint ? POINTS.hint : 0));
}

/** The answers a child picks from at a confidence: the answer and as many decoys as it allows. */
export const offeredChoices = (question, confidence) => [question.answer, ...question.decoys.slice(0, CONFIDENCE[confidence].choices - 1)];

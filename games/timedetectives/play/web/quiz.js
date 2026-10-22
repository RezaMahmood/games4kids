// Pure: no DOM, no network. One question's state as the child answers it.

/** @typedef {{ tries: string[], hint: boolean }} Answer */

const MAX_TRIES = 2;

export const fresh = () => ({ tries: [], hint: false });

/**
 * Where a question stands: waiting for a first tap, waiting for a second after a wrong one, or done.
 * @param {Answer} answer @param {string} correct
 * @returns {'open' | 'retry' | 'right' | 'missed'}
 */
export function phase({ tries }, correct) {
  if (tries.includes(correct)) return 'right';
  if (tries.length >= MAX_TRIES) return 'missed';
  return tries.length === 0 ? 'open' : 'retry';
}

export const isDone = (answer, correct) => ['right', 'missed'].includes(phase(answer, correct));

/** A tap on a choice. A finished question, or a choice already tried, stays as it was. @returns {Answer} */
export function tap(answer, choice, correct) {
  if (isDone(answer, correct) || answer.tries.includes(choice)) return answer;
  return { ...answer, tries: [...answer.tries, choice] };
}

/** Shuffles a copy, so the answer is not always first. */
export function shuffled(list, random = Math.random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

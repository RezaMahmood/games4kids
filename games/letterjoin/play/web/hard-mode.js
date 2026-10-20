/**
 * Hard mode: the child writes the text themselves on guide lines, with no outline, and the app reads it.
 * A site-wide switch sets every card, and a card's own toggle then changes just that card. Only the cards someone
 * toggled away from the site-wide choice are stored, so turning the switch again starts every card afresh.
 * @typedef {{ all: boolean, cards: Record<string, boolean> }} HardChoices
 */

export const HARD_KEY = 'letterjoin.hard';
/** Letters are single shapes to trace, with no words to read, so they never have hard mode. */
export const HARD_TYPES = new Set(['sentence', 'paragraph', 'words']);

/** @type {HardChoices} */
const NONE = { all: false, cards: {} };

/** @returns {HardChoices} whatever was stored that makes sense, and hard mode off otherwise */
export function parseHardChoices(text) {
  let raw;
  try {
    raw = JSON.parse(text ?? 'null');
  } catch {
    return NONE;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NONE;
  const all = raw.all === true;
  const stored = raw.cards && typeof raw.cards === 'object' && !Array.isArray(raw.cards) ? raw.cards : {};
  return { all, cards: Object.fromEntries(Object.entries(stored).filter(([, on]) => typeof on === 'boolean' && on !== all)) };
}

/** @param {HardChoices} choices @param {{ id: string, type: string }} activity */
export function isHard(choices, activity) {
  return HARD_TYPES.has(activity.type) && (Object.hasOwn(choices.cards, activity.id) ? choices.cards[activity.id] : choices.all);
}

/** The site-wide switch means "every card now", so it clears what was set card by card. @returns {HardChoices} */
export function setAll(choices, on) {
  return { all: on, cards: {} };
}

/** @param {HardChoices} choices @param {string} id @param {boolean} on @returns {HardChoices} */
export function setCard(choices, id, on) {
  const { [id]: _, ...others } = choices.cards;
  return { all: choices.all, cards: on === choices.all ? others : { ...others, [id]: on } };
}

/**
 * Hard mode as this device last left it. Storage can be missing or blocked (private browsing), so every read and
 * write is a hint and the choices still hold for this page.
 * @param {() => Storage} storage
 * @param {string} key
 * @param {boolean} [byDefault] what the site-wide switch starts as on a device that has chosen nothing yet
 */
export function createHardMode(storage, key, byDefault = false) {
  let choices = { all: byDefault, cards: {} };
  try {
    const kept = storage().getItem(key);
    if (kept !== null) choices = parseHardChoices(kept);
  } catch {
    // Nothing remembered on this device.
  }
  const keep = (next) => {
    choices = next;
    try {
      storage().setItem(key, JSON.stringify(choices));
    } catch {
      // Not remembered on this device; it still holds until the page is reloaded.
    }
  };
  return {
    all: () => choices.all,
    /** @param {{ id: string, type: string }} activity */
    isHard: (activity) => isHard(choices, activity),
    setAll: (on) => keep(setAll(choices, on)),
    setCard: (id, on) => keep(setCard(choices, id, on)),
  };
}

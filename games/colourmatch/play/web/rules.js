// Pure: no DOM, no network. games/colourmatch/data/ holds the same rules for the server, and
// test/colourmatch/parity.test.mjs keeps the two equal. The admin page holds a byte for byte copy.

export const DEFAULT_TUNING_ID = 'default';

/** Every knob the admin turns, with its bounds. */
export const TUNING_FIELDS = {
  openingTurns: { label: 'Opening turns where the word and its ink match', min: 0, max: 10, integer: true, default: 3 },
  startChance: { label: 'Chance of a mismatch in round 1', min: 0, max: 1, integer: false, default: 0.25 },
  perRound: { label: 'Added chance per round', min: 0, max: 0.5, integer: false, default: 0.1 },
  fastBonus: { label: 'Added chance when the child is answering fast', min: 0, max: 0.5, integer: false, default: 0.15 },
  fastMs: { label: 'Fast means a median answer under this many ms', min: 200, max: 5000, integer: true, default: 1200 },
  maxChance: { label: 'Highest chance of a mismatch', min: 0, max: 1, integer: false, default: 0.8 },
  firstTurns: { label: 'Words in round 1', min: 1, max: 20, integer: true, default: 5 },
  maxTurns: { label: 'Most words in a round', min: 1, max: 30, integer: true, default: 10 },
  firstSecondsPerTurn: { label: 'Seconds per word in round 1', min: 1, max: 10, integer: false, default: 4 },
  decay: { label: 'Seconds per word shrink by this factor each round', min: 0.5, max: 1, integer: false, default: 0.9 },
  minSecondsPerTurn: { label: 'Fewest seconds per word', min: 0.5, max: 10, integer: false, default: 1.2 },
  maxMistakes: { label: 'Mistakes in a row that end the game', min: 1, max: 10, integer: true, default: 3 },
  basePoints: { label: 'Points for a correct answer before bonuses', min: 1, max: 1000, integer: true, default: 100 },
  roundMultiplierStep: { label: 'Points multiplier grows by this each round', min: 0, max: 2, integer: false, default: 0.25 },
  hardMultiplier: { label: 'Points multiplier in hard mode', min: 1, max: 5, integer: false, default: 1.5 },
};

export const TUNING_FIELD_NAMES = Object.keys(TUNING_FIELDS);

export const DEFAULT_TUNING = Object.fromEntries(TUNING_FIELD_NAMES.map((name) => [name, TUNING_FIELDS[name].default]));

/** @returns {{ ok: true, value: Record<string, number> } | { ok: false, problems: string[] }} */
export function parseTuning(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problems: ['tuning must be an object'] };
  const problems = [];
  const tuning = {};
  for (const name of TUNING_FIELD_NAMES) {
    const spec = TUNING_FIELDS[name];
    const value = raw[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${name} must be a number`);
    else if (value < spec.min || value > spec.max) problems.push(`${name} must be between ${spec.min} and ${spec.max}`);
    else if (spec.integer && !Number.isInteger(value)) problems.push(`${name} must be a whole number`);
    else tuning[name] = value;
  }
  const atMost = (low, high) => {
    const a = tuning[low];
    const b = tuning[high];
    if (a !== undefined && b !== undefined && a > b) problems.push(`${low} must be at most ${high}`);
  };
  atMost('firstTurns', 'maxTurns');
  atMost('minSecondsPerTurn', 'firstSecondsPerTurn');
  atMost('startChance', 'maxChance');
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: tuning };
}

export const COLOURS = [
  { id: 'red', name: 'Red', hex: '#FF5A5A' },
  { id: 'orange', name: 'Orange', hex: '#FF9630' },
  { id: 'yellow', name: 'Yellow', hex: '#FFD93B' },
  { id: 'green', name: 'Green', hex: '#4FD36B' },
  { id: 'blue', name: 'Blue', hex: '#5AA0FF' },
  { id: 'purple', name: 'Purple', hex: '#B07CF0' },
  { id: 'pink', name: 'Pink', hex: '#FF8AD0' },
  { id: 'brown', name: 'Brown', hex: '#C08A5A' },
];
export const COLOUR_IDS = COLOURS.map((colour) => colour.id);
export const WORD_BACKGROUND = '#1F2430';
export const colourById = (id) => COLOURS.find((colour) => colour.id === id);

export const turnsIn = (tuning, round) => Math.min(tuning.maxTurns, tuning.firstTurns + round - 1);
export const secondsPerTurn = (tuning, round) => Math.max(tuning.minSecondsPerTurn, tuning.firstSecondsPerTurn * tuning.decay ** (round - 1));
export const roundClockMs = (tuning, round) => Math.round(turnsIn(tuning, round) * secondsPerTurn(tuning, round) * 1000);
export const roundMultiplier = (tuning, round) => 1 + tuning.roundMultiplierStep * (round - 1);

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mismatchChance(tuning, round, recentCorrectMs) {
  const recent = median(recentCorrectMs.slice(-3));
  const fast = recent !== null && recent < tuning.fastMs;
  return Math.min(tuning.maxChance, tuning.startChance + tuning.perRound * (round - 1) + (fast ? tuning.fastBonus : 0));
}

const pick = (from, rng) => from[Math.floor(rng() * from.length)];

function shuffle(items, rng) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export const rightColour = (mode, turn) => (mode === 'normal' ? turn.word : turn.ink);
export const isCongruent = (turn) => turn.word === turn.ink;

/** @returns {{ word: string, ink: string, squares: string[] }} */
export function makeTurn(tuning, context, rng) {
  const word = pick(COLOUR_IDS, rng);
  const mismatch = context.turnInGame >= tuning.openingTurns && rng() < mismatchChance(tuning, context.round, context.recentCorrectMs);
  const ink = mismatch ? pick(COLOUR_IDS.filter((id) => id !== word), rng) : word;
  const chosen = [word, ...(ink === word ? [] : [ink])];
  while (chosen.length < 4) chosen.push(pick(COLOUR_IDS.filter((id) => !chosen.includes(id)), rng));
  return { word, ink, squares: shuffle(chosen, rng) };
}

export const speedFactor = (answerMs, perTurnMs) => 0.5 + 0.5 * Math.max(0, 1 - answerMs / perTurnMs);

export function turnPoints(tuning, mode, round, answerMs) {
  const speed = speedFactor(answerMs, secondsPerTurn(tuning, round) * 1000);
  return Math.round(tuning.basePoints * speed * roundMultiplier(tuning, round) * (mode === 'hard' ? tuning.hardMultiplier : 1));
}

const thousandths = (n) => Math.round(n * 1000) / 1000;

/** The 15 slots of a turn as the server reads them. The tap position keeps 3 decimals, so a long game fits a keepalive request. */
export const packTurn = ({ round, turn, word, ink, squares, answer, shownAtMs, clockLeftMs }) => [
  round, turn, word, ink, squares[0], squares[1], squares[2], squares[3],
  answer?.tapped ?? null, shownAtMs, answer?.answerMs ?? null, answer ? thousandths(answer.x) : null, answer ? thousandths(answer.y) : null, answer?.pointer ?? null, clockLeftMs,
];

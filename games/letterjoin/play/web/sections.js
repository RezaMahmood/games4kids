import { LEVELS, groupByLevel } from './activity.js';

/**
 * Which level sections are open on one screen of this device. Only the levels someone opened or closed by hand are
 * stored, as { [level]: boolean }, so a level nobody touched keeps following the screen's default.
 * @typedef {Partial<Record<import('./activity.js').Level, boolean>>} OpenChoices
 */

export const SECTIONS_KEY = { child: 'letterjoin.sections.child', admin: 'letterjoin.sections.admin' };

/** @returns {OpenChoices} Whatever was stored, keeping only known levels with a true or false. */
export function parseChoices(text) {
  let raw;
  try {
    raw = JSON.parse(text ?? '{}');
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(LEVELS.filter((level) => typeof raw[level] === 'boolean').map((level) => [level, raw[level]]));
}

/**
 * The level a child is working through, open when they have not chosen: the first with an activity not done yet,
 * or the first level once everything is done.
 * @param {{ level: string, items: { result?: unknown }[] }[]} groups the non-empty levels, in list order
 */
export function workingLevel(groups) {
  return (groups.find((g) => g.items.some((a) => !a.result)) ?? groups[0])?.level ?? null;
}

/**
 * The child's list: each level in admin order, but with what they have not done yet ahead of what they have, so
 * finished activities sink to the bottom. The admin list keeps plain {@link groupByLevel}.
 * @template {{ level: import('./activity.js').Level, order: number, updatedAt: string, id: string, result?: unknown }} T
 * @param {T[]} activities
 * @returns {{ level: import('./activity.js').Level, items: T[] }[]}
 */
export function childGroups(activities) {
  return groupByLevel(activities).map(({ level, items }) => ({
    level,
    items: [...items.filter((a) => !a.result), ...items.filter((a) => a.result)],
  }));
}

/**
 * Where Next goes: the first activity not done yet, other than this one, so Next keeps leading to something new.
 * When everything else is done, the one after this in the list.
 * @template {{ id: string, result?: unknown }} T
 * @param {T[]} list the playable activities in child list order
 * @param {{ id: string }} current
 * @returns {T | null}
 */
export function nextActivity(list, current) {
  return list.find((a) => !a.result && a.id !== current.id) ?? list[list.findIndex((a) => a.id === current.id) + 1] ?? null;
}

/**
 * Remembered choices for one screen. Storage can be missing or blocked (private browsing), so every read and write
 * is a hint and the choices still hold for this page.
 * @param {() => Storage} storage
 * @param {string} key
 */
export function createSections(storage, key) {
  let choices = {};
  try {
    choices = parseChoices(storage().getItem(key));
  } catch {
    // Nothing remembered on this device.
  }
  return {
    isOpen: (level, byDefault) => choices[level] ?? byDefault,
    choose(level, open) {
      choices = { ...choices, [level]: open };
      try {
        storage().setItem(key, JSON.stringify(choices));
      } catch {
        // Not remembered on this device; it still holds until the page is reloaded.
      }
    },
  };
}

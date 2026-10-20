import test from 'node:test';
import assert from 'node:assert/strict';
import { childGroups, createSections, nextActivity, parseChoices, workingLevel } from '../../games/letterjoin/play/web/sections.js';

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), data };
};
const blocked = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};

test('stored choices keep only known levels set to true or false', () => {
  assert.deepEqual(parseChoices('{"starter":false,"champion":true}'), { starter: false, champion: true });
  assert.deepEqual(parseChoices('{"starter":"yes","explorer":1,"wizard":true,"__proto__":true}'), {});
  for (const junk of [null, '', 'not json', '[]', 'null', '42', '"open"']) assert.deepEqual(parseChoices(junk), {}, String(junk));
});

test('the working level is the first with something left to do, or the first once all are done', () => {
  const done = { result: { score: 0.9 } };
  assert.equal(workingLevel([{ level: 'starter', items: [done, {}] }, { level: 'explorer', items: [{}] }]), 'starter');
  assert.equal(workingLevel([{ level: 'starter', items: [done] }, { level: 'explorer', items: [done, {}] }, { level: 'champion', items: [{}] }]), 'explorer');
  assert.equal(workingLevel([{ level: 'explorer', items: [done] }, { level: 'champion', items: [done] }]), 'explorer');
  assert.equal(workingLevel([]), null);
});

test('a level nobody touched follows the default, and a choice is remembered on the device', () => {
  const storage = memory();
  const first = createSections(() => storage, 'k');
  assert.equal(first.isOpen('starter', true), true);
  assert.equal(first.isOpen('explorer', false), false);
  first.choose('starter', false);
  first.choose('explorer', true);
  assert.equal(first.isOpen('starter', true), false);
  const reloaded = createSections(() => storage, 'k');
  assert.equal(reloaded.isOpen('starter', true), false);
  assert.equal(reloaded.isOpen('explorer', false), true);
  assert.equal(reloaded.isOpen('champion', true), true, 'champion was never touched');
  assert.equal(createSections(() => storage, 'other').isOpen('starter', true), true, 'each screen has its own key');
});

test('blocked or failing storage still lets choices hold for the page', () => {
  const sections = createSections(blocked, 'k');
  assert.equal(sections.isOpen('starter', true), true);
  sections.choose('starter', false);
  assert.equal(sections.isOpen('starter', true), false);
  const full = { getItem: () => '{"champion":false}', setItem: () => { throw new DOMException('Quota', 'QuotaExceededError'); } };
  const quota = createSections(() => full, 'k');
  assert.equal(quota.isOpen('champion', true), false);
  quota.choose('champion', true);
  assert.equal(quota.isOpen('champion', false), true);
});

const act = (id, level, order, done = false) => ({ id, level, order, updatedAt: '2026-01-01T00:00:00Z', ...(done ? { result: { score: 0.9 } } : {}) });
const ids = (groups, level) => groups.find((g) => g.level === level).items.map((a) => a.id);

test('the child list puts what is not done first, then what is done, each part in admin order, level by level', () => {
  const input = [act('s3', 'starter', 3), act('s1', 'starter', 1, true), act('e1', 'explorer', 1, true), act('s2', 'starter', 2), act('s4', 'starter', 4, true), act('e2', 'explorer', 2)];
  const copy = structuredClone(input);
  const groups = childGroups(input);
  assert.deepEqual(ids(groups, 'starter'), ['s2', 's3', 's1', 's4']);
  assert.deepEqual(ids(groups, 'explorer'), ['e2', 'e1']);
  assert.deepEqual(ids(groups, 'champion'), []);
  assert.deepEqual(input, copy, 'the input is left as it was');
});

test('with nothing done, or everything done, the child list is the admin order', () => {
  const todo = [act('b', 'starter', 2), act('a', 'starter', 1)];
  assert.deepEqual(ids(childGroups(todo), 'starter'), ['a', 'b']);
  const done = todo.map((a) => ({ ...a, result: { score: 1 } }));
  assert.deepEqual(ids(childGroups(done), 'starter'), ['a', 'b']);
});

const walk = (activities) => childGroups(activities).flatMap((g) => g.items);

test('Next skips done activities and the current one, even one just finished and moved to the bottom', () => {
  const list = walk([act('s1', 'starter', 1, true), act('s2', 'starter', 2), act('s3', 'starter', 3), act('s4', 'starter', 4)]);
  assert.equal(nextActivity(list, act('s2', 'starter', 2)).id, 's3');
  assert.equal(nextActivity(list, act('s1', 'starter', 1, true)).id, 's2');
  const justFinished = walk([act('s1', 'starter', 1, true), act('s2', 'starter', 2, true), act('s3', 'starter', 3, true), act('s4', 'starter', 4)]);
  assert.equal(nextActivity(justFinished, act('s2', 'starter', 2, true)).id, 's4');
});

test('Next crosses into the next level when the current level has nothing left to do', () => {
  const list = walk([act('s1', 'starter', 1, true), act('s2', 'starter', 2, true), act('e1', 'explorer', 1), act('e2', 'explorer', 2)]);
  assert.equal(nextActivity(list, act('s2', 'starter', 2, true)).id, 'e1');
});

test('with everything done Next is the one after this in the list, and null at the very end', () => {
  const list = walk([act('s1', 'starter', 1, true), act('s2', 'starter', 2, true), act('e1', 'explorer', 1, true)]);
  assert.equal(nextActivity(list, list[0]).id, 's2');
  assert.equal(nextActivity(list, list[1]).id, 'e1');
  assert.equal(nextActivity(list, list[2]), null);
  assert.equal(nextActivity([act('only', 'starter', 1)], act('only', 'starter', 1)), null, 'a lone activity has no next');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { TABS, tabFromHash } from '../../games/letterjoin/admin/web/admin-tabs.js';

test('the hash picks the tab, and anything unknown opens the first one', () => {
  for (const tab of TABS) assert.equal(tabFromHash(`#${tab}`), tab);
  for (const junk of ['', '#', '#nope', '#Users', '#users?x=1', '#__proto__']) assert.equal(tabFromHash(junk), 'activities', junk);
});

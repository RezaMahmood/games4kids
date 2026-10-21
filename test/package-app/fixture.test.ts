import { test } from 'node:test';
import { assertStartsOnItsOwn, FIXTURES, skip, unpack } from '../support/packed.ts';

const dir = skip ? '' : unpack('fixture', FIXTURES);

test('the fixture zip starts on its own and stops only for its missing settings', { skip }, () => assertStartsOnItsOwn('fixture', dir));

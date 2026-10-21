import { test } from 'node:test';
import { assertStartsOnItsOwn, skip, unpack } from '../support/packed.ts';

const dir = skip ? '' : unpack('drawpad', 'games');

test('the drawpad zip starts on its own and stops only for its missing settings', { skip }, () => assertStartsOnItsOwn('drawpad', dir));

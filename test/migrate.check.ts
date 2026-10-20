import type { Row } from '@g4k/sdk';
import type { OldAccount, OldAccounts, TargetReader, TargetWriter } from '../tools/migrate/model.ts';
import { migratePlayerData, parseConfirmation, type PlayerDataConfirmation, type PlayerDataMapping } from '../tools/migrate/player-data.ts';

/**
 * Type-checked by `tsc -b` and never run. Each @ts-expect-error line is a claim about what the migration tools refuse;
 * if a line starts compiling, tsc reports the unused directive.
 */

declare const old: OldAccount;
declare const accounts: OldAccounts;
declare const row: Row;
declare const bytes: Uint8Array;
declare const reader: TargetReader;
declare const writer: TargetWriter;
declare const mapping: PlayerDataMapping;
declare const confirmation: PlayerDataConfirmation;

void old.table('pictures').list();
void old.container('pictures').get('a/b.png');

// @ts-expect-error an old table handle has no insert
void old.table('pictures').insertIfAbsent(row);
// @ts-expect-error an old table handle has no put
void old.table('pictures').put(row);
// @ts-expect-error an old table handle has no remove
void old.table('pictures').remove('p', 'a');
// @ts-expect-error an old container handle has no put
void old.container('pictures').put('a/b.png', bytes, 'image/png');
// @ts-expect-error an old container handle has no remove
void old.container('pictures').remove('a/b.png');

// @ts-expect-error a dry run target is a reader, and a reader cannot insert
void reader.insertIfAbsent('drawpad', 'drawings', row);

// @ts-expect-error apply without a confirmation does not compile
void migratePlayerData({ mode: 'apply', mapping, target: writer }, accounts);
// @ts-expect-error a plain string is not a confirmation
void migratePlayerData({ mode: 'apply', mapping, target: writer, confirmation: 'confirm-player-data' }, accounts);
// @ts-expect-error apply needs a target that can write
void migratePlayerData({ mode: 'apply', mapping, target: reader, confirmation }, accounts);
// @ts-expect-error parseConfirmation can answer null, which is not a confirmation
void migratePlayerData({ mode: 'apply', mapping, target: writer, confirmation: parseConfirmation([]) }, accounts);

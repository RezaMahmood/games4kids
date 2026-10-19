import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueueServiceClient } from '@azure/storage-queue';
import { accountName, memoryAccounts } from '@g4k/host';
import { azureAccounts } from '@g4k/host/azure';
import { AZURITE_SKIP, startAzurite } from './support/azurite.ts';
import { gameId } from './support/ids.ts';
import { storageContract } from './support/storage-contract.ts';

test('accountName joins g4k, the owner and the suffix', () => {
	assert.equal(accountName(gameId('drawpad'), 'x7k2q'), 'g4kdrawpadx7k2q');
	assert.equal(accountName('portal', 'x7k2q'), 'g4kportalx7k2q');
});

storageContract('memory', async () => ({ accounts: memoryAccounts(), close: async () => {} }));

storageContract(
	'azurite',
	async () => {
		const azurite = await startAzurite();
		return { accounts: azureAccounts({ kind: 'azurite', connectionString: azurite.connectionString }), close: azurite.stop };
	},
	{ skip: AZURITE_SKIP },
);

test('azurite: a queue send arrives as base64 JSON for the Functions trigger', { skip: AZURITE_SKIP }, async () => {
	const azurite = await startAzurite();
	try {
		await azureAccounts({ kind: 'azurite', connectionString: azurite.connectionString }).open(gameId('fixture')).queue('jobs').send({ id: 7 });
		const queue = QueueServiceClient.fromConnectionString(azurite.connectionString).getQueueClient('fixture-jobs');
		const [message] = (await queue.receiveMessages()).receivedMessageItems;
		assert.deepEqual(JSON.parse(Buffer.from(message?.messageText ?? '', 'base64').toString()), { id: 7 });
	} finally {
		await azurite.stop();
	}
});

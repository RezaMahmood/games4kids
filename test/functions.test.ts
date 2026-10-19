import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpRequest } from '@azure/functions';
import { toHostRequest, toResponse } from '@g4k/host/functions';

test('the Functions adapter turns an HttpRequest into a HostRequest with path, query, headers and a capped body', async () => {
	const request = new HttpRequest({
		method: 'PUT',
		url: 'https://func-g4k-fixture.azurewebsites.net/api/g/fixture/scores/one?x=1',
		headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
		body: { string: '{"points":7}' },
	});
	const host = toHostRequest(request);
	assert.equal(host.method, 'PUT');
	assert.equal(host.path, '/api/g/fixture/scores/one');
	assert.equal(host.query.get('x'), '1');
	assert.equal(host.headers.get('authorization'), 'Bearer t');
	assert.equal(new TextDecoder().decode(await host.bytes(100)), '{"points":7}');
	const big = toHostRequest(new HttpRequest({ method: 'POST', url: 'https://x/api/g/fixture/u', body: { string: 'x'.repeat(101) } }));
	await assert.rejects(big.bytes(100), (error: unknown) => error instanceof Error && 'status' in error && error.status === 413);
});

test('the Functions adapter passes a HostReply through and sends no body for an empty one', () => {
	assert.deepEqual(toResponse({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }), { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' });
	assert.deepEqual(toResponse({ status: 204, headers: {}, body: null }), { status: 204, headers: {} });
});

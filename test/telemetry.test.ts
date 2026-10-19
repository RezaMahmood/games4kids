import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { adminFunctionName } from '@g4k/host';
import { cloudRoleName, otelTelemetry, ROUTE_ATTRIBUTE, USER_ATTRIBUTE } from '@g4k/host/telemetry';
import { gameId, portalUserId } from './support/ids.ts';

function recorder() {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	const span = provider.getTracer('test').startSpan('request');
	return { span, finished: () => (span.end(), exporter.getFinishedSpans()[0]) };
}

test('the active request span carries the player id and the route template', () => {
	const { span, finished } = recorder();
	const telemetry = otelTelemetry(() => span);
	telemetry.setUser(portalUserId('00000000-0000-4000-8000-00000000000a'));
	telemetry.setRoute('/api/g/drawpad/drawings/{id}');
	const done = finished();
	assert.equal(done?.attributes[USER_ATTRIBUTE], '00000000-0000-4000-8000-00000000000a');
	assert.equal(done?.attributes[ROUTE_ATTRIBUTE], '/api/g/drawpad/drawings/{id}');
});

test('an exception is recorded on the span and marks it failed', () => {
	const { span, finished } = recorder();
	otelTelemetry(() => span).exception(new Error('boom'));
	const done = finished();
	assert.equal(done?.status.code, 2);
	assert.equal(done?.events[0]?.name, 'exception');
	assert.equal(done?.events[0]?.attributes?.['exception.message'], 'boom');
});

test('a log line becomes an event with its level', () => {
	const { span, finished } = recorder();
	otelTelemetry(() => span).log('warn', 'slow picture');
	assert.deepEqual(finished()?.events.map((event) => [event.name, event.attributes?.['level'], event.attributes?.['line']]), [['g4k.log', 'warn', 'slow picture']]);
});

test('with no active span every call does nothing', () => {
	const telemetry = otelTelemetry(() => undefined);
	assert.doesNotThrow(() => {
		telemetry.setUser(portalUserId('00000000-0000-4000-8000-00000000000a'));
		telemetry.setRoute('/x');
		telemetry.log('info', 'x');
		telemetry.exception(new Error('x'));
	});
});

test('each app reports as func-g4k-<app>, and the admin app names a game function <owner>-<name>', () => {
	assert.equal(cloudRoleName(gameId('drawpad')), 'func-g4k-drawpad');
	assert.equal(cloudRoleName('portal'), 'func-g4k-portal');
	assert.equal(cloudRoleName('admin'), 'func-g4k-admin');
	assert.equal(adminFunctionName(gameId('drawpad'), 'stencilJobs'), 'drawpad-stencilJobs');
	assert.equal(adminFunctionName('portal', 'members-save'), 'portal-members-save');
});

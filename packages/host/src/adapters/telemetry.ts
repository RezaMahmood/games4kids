import { useAzureMonitor } from '@azure/monitor-opentelemetry';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { GameId } from '@g4k/sdk';
import type { Telemetry } from '../telemetry.ts';

export const USER_ATTRIBUTE = 'g4k.user';
export const ROUTE_ATTRIBUTE = 'http.route';

/** func-g4k-<id> for a game's player app, func-g4k-portal and func-g4k-admin for the other two. It is the cloud_RoleName of every row the app sends. */
export const cloudRoleName = (app: GameId | 'portal' | 'admin'): string => `func-g4k-${app}`;

/**
 * Spans come from the Functions host and the OpenTelemetry instrumentation, so this only annotates the active one.
 * Outside a request there is no active span and every call is a no-op. The user is a PortalUserId, never an email.
 */
export function otelTelemetry(active: () => Span | undefined = () => trace.getActiveSpan()): Telemetry {
	return {
		setUser: (user) => void active()?.setAttribute(USER_ATTRIBUTE, user),
		setRoute: (route) => void active()?.setAttribute(ROUTE_ATTRIBUTE, route),
		log: (level, line) => void active()?.addEvent('g4k.log', { level, line }),
		exception(error) {
			const span = active();
			span?.recordException(error instanceof Error ? error : new Error(String(error)));
			span?.setStatus({ code: SpanStatusCode.ERROR });
		},
	};
}

/** Application Insights with no sampling. service.name becomes cloud_RoleName, so code never names its own game. */
export function startAzureMonitor(options: { readonly app: GameId | 'portal' | 'admin'; readonly connectionString: string }): void {
	useAzureMonitor({
		azureMonitorExporterOptions: { connectionString: options.connectionString },
		resource: resourceFromAttributes({ 'service.name': cloudRoleName(options.app) }),
		samplingRatio: 1,
		tracesPerSecond: 0,
	});
}

import type { AdminPlatform } from '@g4k/sdk';
import type manifest from '../../manifest.ts';
import { AiFailure, type FoundryDeps } from './foundry.ts';

/** The Foundry account this app was deployed with, called with the platform's Cognitive Services token. */
export function foundryFor(platform: AdminPlatform<typeof manifest>): FoundryDeps {
	const endpoint = platform.settings.FOUNDRY_ENDPOINT;
	if (!endpoint) throw new AiFailure('failed', 'redraw_unavailable', 'FOUNDRY_ENDPOINT is not set');
	return { endpoint, token: platform.tokens.cognitiveServices };
}

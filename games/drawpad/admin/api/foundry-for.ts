import { meterTo, type AdminPlatform, type UsageSubject } from '@g4k/sdk';
import type manifest from '../../manifest.ts';
import { AiFailure, type FoundryDeps } from './foundry.ts';

/** Every call made with these deps bills its tokens to `subject`, so a job's asks, retries and redraws sum into the job. */
export function foundryFor(platform: AdminPlatform<typeof manifest>, subject: UsageSubject): FoundryDeps {
	const endpoint = platform.settings.FOUNDRY_ENDPOINT;
	if (!endpoint) throw new AiFailure('failed', 'redraw_unavailable', 'FOUNDRY_ENDPOINT is not set');
	return { endpoint, token: platform.tokens.cognitiveServices, meter: meterTo(platform.usage, subject) };
}

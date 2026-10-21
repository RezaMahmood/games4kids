import type { Refusal } from '@g4k/sdk';

export type RefusalHandling = 'retry-after-refresh' | 'screen';

/** A switch with a `never` default, so a new Refusal fails the shell's build until it is handled. */
export function onRefusal(code: Refusal): RefusalHandling {
	switch (code) {
		case 'unauthenticated':
		case 'invalid_token':
			return 'retry-after-refresh';
		case 'not_invited':
		case 'no_profile':
		case 'not_entitled':
		case 'game_paused':
			return 'screen';
		default: {
			const unhandled: never = code;
			return unhandled;
		}
	}
}

const REFUSALS: readonly Refusal[] = ['unauthenticated', 'invalid_token', 'not_invited', 'no_profile', 'not_entitled', 'game_paused'];

export const asRefusal = (code: string): Refusal | null => REFUSALS.find((refusal) => refusal === code) ?? null;

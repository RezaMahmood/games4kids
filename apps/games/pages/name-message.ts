import { ApiFailure } from '../shell/v1/index.ts';

/** What a child reads when a name was not saved, for /welcome/ and /profile/ alike. */
export function nameMessage(error: unknown): string {
	if (!(error instanceof ApiFailure)) return 'We could not save your name. Try again.';
	if (error.code === 'name_taken') return 'Someone already has that name. Try another.';
	if (error.code === 'name_not_allowed') return 'Please choose a kinder name. Try another.';
	if (error.code === 'rename_tomorrow') return 'You can change your name again tomorrow.';
	return error.problems[0] ?? error.message;
}

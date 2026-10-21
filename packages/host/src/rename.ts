import type { Profile } from '@g4k/sdk';

/** A profiles row: the profile plus when the child last renamed themselves. Only the portal app reads or writes `renamedAt`. */
export type StoredProfile = Profile & { readonly renamedAt?: string };

const localDay = (at: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/** Whether `renamedAt` falls on today's calendar day in the child's own time zone. */
export function renamedToday(renamedAt: string | undefined, timeZone: string, now: Date): boolean {
	return renamedAt !== undefined && localDay(new Date(renamedAt), timeZone) === localDay(now, timeZone);
}

export type Save = { readonly kind: 'refused' } | { readonly kind: 'write'; readonly renamedAt: string | undefined };

/**
 * What a save may do to a profiles row. The first name, and any save that keeps the name (a time zone change), are
 * not renames and keep `renamedAt` as it was. A rename is once a day, by the stored time zone.
 */
export function planSave(stored: StoredProfile | undefined, next: Profile, now: Date): Save {
	if (stored === undefined || stored.displayName === next.displayName) return { kind: 'write', renamedAt: stored?.renamedAt };
	return renamedToday(stored.renamedAt, stored.timeZone, now) ? { kind: 'refused' } : { kind: 'write', renamedAt: now.toISOString() };
}

import type { UsageToday } from './types.ts';

export const DEFAULT_DAILY_LIMIT_MINUTES = 60;
export const MAX_HEARTBEAT_SECONDS = 90;

export function resolveLimitMinutes(childOverride: number | undefined, settingsDefault: number | undefined): number {
	return childOverride ?? settingsDefault ?? DEFAULT_DAILY_LIMIT_MINUTES;
}

export function usageToday(usedSeconds: number, limitMinutes: number): UsageToday {
	const limitSeconds = limitMinutes * 60;
	return { usedSeconds, limitSeconds, remainingSeconds: Math.max(0, limitSeconds - usedSeconds) };
}

export function clampHeartbeatSeconds(seconds: number): number {
	return Math.min(MAX_HEARTBEAT_SECONDS, Math.max(0, Math.floor(seconds)));
}

/** The calendar day in the child's own zone, so the day rolls over at their midnight and not at UTC's. */
export function localDate(now: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

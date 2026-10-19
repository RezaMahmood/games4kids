/** Where /welcome/ sends a child afterwards: a path on this site, never another origin and never /welcome/ itself. */
export function safeReturn(raw: string | null, origin: string): string {
	if (!raw?.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
	const target = new URL(raw, origin);
	return target.origin === origin && !target.pathname.startsWith('/welcome/') ? `${target.pathname}${target.search}${target.hash}` : '/';
}

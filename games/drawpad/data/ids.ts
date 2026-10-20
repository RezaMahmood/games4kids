const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export const isValidId = (id: string) => ID_PATTERN.test(id);

export function starsFor(total: number): 1 | 2 | 3 | 4 | 5 {
	return Math.min(5, Math.max(1, Math.round(total / 20))) as 1 | 2 | 3 | 4 | 5;
}

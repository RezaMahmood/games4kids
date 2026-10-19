export async function getJson(path: string): Promise<unknown> {
	const response = await fetch(path, { cache: 'no-cache' });
	if (!response.ok) throw new Error(`${path} answered ${response.status}`);
	return response.json();
}

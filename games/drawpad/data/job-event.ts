import type { JobStepKey } from './types.ts';

/** The photo an upload job works from. */
export const jobPhotoPath = (id: string) => `${id}/photo.jpg`;

/** The PNG a done trace or scene step leaves behind. */
export const jobStepPngPath = (id: string, key: JobStepKey) => `${id}/${key}.png`;

/** An empty blob written after everything else a job needs, so its BlobCreated event, which Event Grid sends to the job queue, starts the job. */
export const jobReadyPath = (id: string) => `${id}/ready`;

const BLOB_CREATED = 'Microsoft.Storage.BlobCreated';
const SUBJECT = /^\/blobServices\/default\/containers\/jobs\/blobs\/([A-Za-z0-9-]{1,64})\/ready$/;

/** The part of an Event Grid schema BlobCreated event the worker reads, for a job's ready blob. */
export const jobReadyEvent = (id: string, now: Date) => ({
	id: `local-${id}`,
	eventType: BLOB_CREATED,
	subject: `/blobServices/default/containers/jobs/blobs/${jobReadyPath(id)}`,
	eventTime: now.toISOString(),
	data: {},
	dataVersion: '',
});

/** The job id of a BlobCreated event for a job's ready blob, or undefined for any other message. */
export function jobIdOf(message: unknown): string | undefined {
	let event = message;
	if (typeof event === 'string') {
		try {
			event = JSON.parse(event);
		} catch {
			return undefined;
		}
	}
	const { eventType, subject } = (event ?? {}) as { eventType?: unknown; subject?: unknown };
	if (eventType !== BLOB_CREATED || typeof subject !== 'string') return undefined;
	return SUBJECT.exec(subject)?.[1];
}

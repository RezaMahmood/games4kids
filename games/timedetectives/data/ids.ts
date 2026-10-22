import type { Brand } from '@g4k/sdk';

export type TopicId = Brand<string, 'TopicId'>;
export type RoundId = Brand<string, 'RoundId'>;
/** One picture a round has had. Each one gets a new id, so a picture is never written over. */
export type PictureId = Brand<string, 'PictureId'>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isGuid = (value: unknown): value is string => typeof value === 'string' && GUID.test(value);

const asId = <T extends TopicId | RoundId | PictureId>(raw: unknown): T | undefined => (isGuid(raw) ? (raw.toLowerCase() as T) : undefined);

export const topicId = (raw: unknown) => asId<TopicId>(raw);
export const roundId = (raw: unknown) => asId<RoundId>(raw);
export const pictureId = (raw: unknown) => asId<PictureId>(raw);

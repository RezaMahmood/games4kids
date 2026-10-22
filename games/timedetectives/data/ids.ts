import type { Brand } from '@g4k/sdk';

export type TopicId = Brand<string, 'TopicId'>;
export type RoundId = Brand<string, 'RoundId'>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isGuid = (value: unknown): value is string => typeof value === 'string' && GUID.test(value);

const asId = <T extends TopicId | RoundId>(raw: unknown): T | undefined => (isGuid(raw) ? (raw.toLowerCase() as T) : undefined);

export const topicId = (raw: unknown) => asId<TopicId>(raw);
export const roundId = (raw: unknown) => asId<RoundId>(raw);

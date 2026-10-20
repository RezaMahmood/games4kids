import { defineAdminApi, HttpError, type AdminPlatform } from '@g4k/sdk';
import { jobPhotoPath, jobIdOf, jobStepPngPath } from '../../data/job-event.ts';
import { jobSteps, newJobRow, STEP_WRITES_PNG, toJob, type JobRow } from '../../data/model.ts';
import {
	idParam,
	isPicturePng,
	parseDescriptionJob,
	parseLimit,
	parseNewPicture,
	parsePhotoJob,
	parseRedraw,
	parseRename,
	requiredPictureFiles,
} from '../../data/parse.ts';
import { IMMUTABLE, imageReply, nothingHere, PICTURE_FILES, REVALIDATE } from '../../data/reply.ts';
import { adminStore, type JobStore } from '../../data/stores.ts';
import type { Picture } from '../../data/types.ts';
import manifest from '../../manifest.ts';
import { foundryFor } from './foundry-for.ts';
import { runJob } from './worker.ts';

/** Hours of AI work at 20 to 45 seconds a redraw, so a stuck page cannot fill the queue. */
const MAX_ACTIVE_JOBS = 20;
const LIST_MAX = 50;
/** The lifecycle rule in infra.bicep deletes job blobs after 7 days, so older jobs have nothing to show. */
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;

const isActive = (row: JobRow) => row.status !== 'done';

/** The worker reaches a queued job after whatever it is processing and the queued jobs created earlier. */
const aheadOf = (row: JobRow, active: JobRow[]) =>
	row.status !== 'queued' ? 0 : active.filter((other) => other.status === 'processing' || other.createdAt < row.createdAt).length;

async function bumpGuard(platform: AdminPlatform<typeof manifest>, jobs: JobStore): Promise<JobRow[]> {
	if (!platform.settings.FOUNDRY_ENDPOINT) throw new HttpError(503, 'redraw_unavailable', 'Picture making is not set up yet.');
	const active = (await jobs.all()).filter(isActive);
	if (active.length >= MAX_ACTIVE_JOBS) throw new HttpError(429, 'too_many_jobs', 'There are already a lot of pictures being made.');
	return active;
}

export const createAdminApi = defineAdminApi(manifest, (platform) => {
	const store = adminStore(platform);
	const jobs = store.jobs;
	const sendsOwnEvents = platform.settings.LOCAL_JOB_EVENTS === 1;

	async function create(row: JobRow, photo: Uint8Array | null, now: Date): Promise<void> {
		await jobs.put(row);
		try {
			if (photo) await jobs.putPhoto(row.rowKey, photo);
			await jobs.signalReady(row.rowKey, now, sendsOwnEvents);
		} catch (error) {
			// A queued row that is never ready would never run and would count against every later job.
			await jobs.remove(row.rowKey);
			throw error;
		}
	}

	return {
		routes: [
			{
				name: 'limits',
				method: 'GET',
				path: 'limits',
				body: 'none',
				async run({ now }) {
					const players = await platform.roster.list();
					const children = players.map((player) => ({ userId: player.userId, name: player.profile?.displayName ?? 'No name yet', timeZone: player.profile?.timeZone ?? 'UTC' }));
					return { status: 200, json: await store.limits(children, now) };
				},
			},
			{
				name: 'setChildLimit',
				method: 'PUT',
				path: 'limits/{userId}',
				body: 'json',
				async run({ params, body }) {
					const userId = params['userId'] ?? '';
					const dailyLimitMinutes = parseLimit(body);
					if (!(await platform.roster.list()).some((player) => player.userId === userId)) throw nothingHere();
					await store.setChildLimit(userId, dailyLimitMinutes);
					return { status: 204 };
				},
			},
			{
				name: 'gallery',
				method: 'GET',
				path: 'drawings',
				body: 'none',
				async run() {
					const [drawings, players] = await Promise.all([store.gallery(), platform.roster.list()]);
					const names = new Map(players.map((player) => [player.userId as string, player.profile?.displayName ?? 'unknown']));
					return { status: 200, json: drawings.map((drawing) => ({ ...drawing, userName: names.get(drawing.userId) ?? 'unknown' })) };
				},
			},
			{
				name: 'drawingImage',
				method: 'GET',
				path: 'drawings/{userId}/{id}/image',
				body: 'none',
				async run({ params, ifNoneMatch }) {
					return imageReply(await store.drawingImage(params['userId'] ?? '', idParam(params['id']), ifNoneMatch), 'image/png', REVALIDATE);
				},
			},
			{
				name: 'pictures',
				method: 'GET',
				path: 'pictures',
				body: 'none',
				async run() {
					return { status: 200, json: await store.pictures() };
				},
			},
			{
				name: 'pictureFile',
				method: 'GET',
				path: 'pictures/{id}/{file}',
				body: 'none',
				async run({ params, ifNoneMatch }) {
					const file = params['file'] ?? '';
					const contentType = PICTURE_FILES.get(file);
					if (!contentType) throw nothingHere();
					return imageReply(await store.pictureFile(`${idParam(params['id'])}/${file}`, ifNoneMatch), contentType, IMMUTABLE);
				},
			},
			{
				name: 'putPictureImage',
				method: 'POST',
				path: 'pictures/{id}/png/{file}',
				body: 'png',
				async run({ params, body }) {
					const file = params['file'];
					if (!isPicturePng(file)) throw nothingHere();
					await store.putPictureFile(idParam(params['id']), file, body, 'image/png');
					return { status: 204 };
				},
			},
			{
				name: 'putPictureOriginal',
				method: 'POST',
				path: 'pictures/{id}/original',
				body: 'jpeg',
				async run({ params, body }) {
					await store.putPictureFile(idParam(params['id']), 'original.jpg', body, 'image/jpeg');
					return { status: 204 };
				},
			},
			{
				name: 'addPicture',
				method: 'POST',
				path: 'pictures/{id}',
				body: 'json',
				async run({ params, body, now }) {
					const id = idParam(params['id']);
					const upload = parseNewPicture(body);
					const have = new Set(await store.pictureFiles(id));
					const missing = requiredPictureFiles(upload).filter((file) => !have.has(file));
					if (missing.length > 0) throw new HttpError(400, 'invalid', 'The picture is missing files.', missing);
					const { pbn, ...details } = upload;
					const picture: Picture = { id, ...details, createdAt: now.toISOString() };
					if (pbn) await store.putPictureFile(id, 'pbn.json', new TextEncoder().encode(JSON.stringify(pbn)), 'application/json');
					await store.addPicture(picture);
					return { status: 201, json: picture };
				},
			},
			{
				name: 'renamePicture',
				method: 'PUT',
				path: 'pictures/{id}',
				body: 'json',
				async run({ params, body }) {
					const renamed = await store.renamePicture(idParam(params['id']), parseRename(body));
					if (!renamed) throw nothingHere();
					return { status: 200, json: renamed };
				},
			},
			{
				name: 'deletePicture',
				method: 'DELETE',
				path: 'pictures/{id}',
				body: 'none',
				async run({ params }) {
					await store.deletePicture(idParam(params['id']));
					return { status: 204 };
				},
			},
			{
				name: 'createDescriptionJob',
				method: 'POST',
				path: 'jobs',
				body: 'json',
				async run({ body, now }) {
					const job = parseDescriptionJob(body);
					const active = await bumpGuard(platform, jobs);
					const row = newJobRow(job, platform.newId(), now.toISOString());
					await create(row, null, now);
					return { status: 202, json: toJob(row, aheadOf(row, active)) };
				},
			},
			{
				name: 'createPhotoJob',
				method: 'POST',
				path: 'jobs/photo',
				body: 'jpeg',
				async run({ query, body, now }) {
					const job = parsePhotoJob(query, body);
					const active = await bumpGuard(platform, jobs);
					const row = newJobRow(job, platform.newId(), now.toISOString());
					await create(row, body, now);
					return { status: 202, json: toJob(row, aheadOf(row, active)) };
				},
			},
			{
				name: 'redrawJob',
				method: 'POST',
				path: 'jobs/{id}/redraw',
				body: 'json',
				/**
				 * Asks a finished photo job for one AI outline, made fresh even when the job already has it: the job keeps
				 * the photo and every outline it made, so Review never uploads the photo again or pays twice for an outline,
				 * and making one again is always this explicit request. A job still at work answers 409 `job_busy`, since
				 * the worker would overwrite the step added here when it saves.
				 */
				async run({ params, body, now }) {
					const id = idParam(params['id']);
					const key = parseRedraw(body);
					const row = await jobs.get(id);
					if (!row) throw nothingHere();
					if (row.source !== 'photo') throw new HttpError(400, 'invalid', 'Only a photo job makes outlines.');
					if (isActive(row)) throw new HttpError(409, 'job_busy', 'That picture is still being made.');
					const active = await bumpGuard(platform, jobs);
					const steps = [...jobSteps(row).filter((step) => step.key !== key), { key, state: 'pending' as const }];
					const queued: JobRow = { ...row, status: 'queued', steps: JSON.stringify(steps), attempts: 0 };
					if (!(await jobs.replaceIfPresent(queued))) throw nothingHere();
					await jobs.signalReady(id, now, sendsOwnEvents);
					return { status: 202, json: toJob(queued, aheadOf(queued, active)) };
				},
			},
			{
				name: 'jobs',
				method: 'GET',
				path: 'jobs',
				body: 'none',
				async run({ now }) {
					const rows = await jobs.all();
					const active = rows.filter(isActive);
					const since = new Date(now.getTime() - KEPT_MS).toISOString();
					const recent = rows
						.filter((row) => row.createdAt > since)
						.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
						.slice(0, LIST_MAX);
					return { status: 200, json: recent.map((row) => toJob(row, aheadOf(row, active))) };
				},
			},
			{
				name: 'job',
				method: 'GET',
				path: 'jobs/{id}',
				body: 'none',
				async run({ params }) {
					const row = await jobs.get(idParam(params['id']));
					if (!row) throw nothingHere();
					const active = row.status === 'queued' ? (await jobs.all()).filter(isActive) : [];
					return { status: 200, json: toJob(row, aheadOf(row, active)) };
				},
			},
			{
				name: 'jobFile',
				method: 'GET',
				path: 'jobs/{id}/{file}',
				body: 'none',
				/** A photo job's photo, so a finished job can be reopened, and each AI picture once its step is done. */
				async run({ params, ifNoneMatch }) {
					const id = idParam(params['id']);
					const file = params['file'];
					const row = await jobs.get(id);
					if (row?.source === 'photo' && file === 'photo.jpg') return imageReply(await jobs.fileRead(jobPhotoPath(id), ifNoneMatch), 'image/jpeg', IMMUTABLE);
					const step = row && jobSteps(row).find((s) => STEP_WRITES_PNG[s.key] && s.state === 'done' && `${s.key}.png` === file);
					if (!step) throw nothingHere();
					return imageReply(await jobs.fileRead(jobStepPngPath(id, step.key), ifNoneMatch), 'image/png', REVALIDATE);
				},
			},
			{
				name: 'deleteJob',
				method: 'DELETE',
				path: 'jobs/{id}',
				body: 'none',
				async run({ params }) {
					const id = idParam(params['id']);
					if (!(await jobs.get(id))) throw nothingHere();
					await jobs.remove(id);
					await jobs.removeFiles(id);
					return { status: 204 };
				},
			},
		],
		workers: [
			{
				queue: 'stencil-jobs',
				async run(message, { log, dequeueCount }) {
					const jobId = jobIdOf(message);
					if (!jobId) return log('ignored a queue message that is not the BlobCreated event of a job ready blob');
					await runJob(jobs, { foundry: () => foundryFor(platform), log }, jobId, dequeueCount);
				},
			},
		],
	};
});

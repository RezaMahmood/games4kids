import { jobPhotoPath, jobStepPngPath } from '../../data/job-event.ts';
import { jobSteps, type DescriptionJobRow, type JobRow, type Photo, type PhotoJobRow } from '../../data/model.ts';
import type { JobStore } from '../../data/stores.ts';
import type { AiErrorCode, JobStep, JobStepKey, PhotoStepKey, RedrawQuality, SceneStepKey } from '../../data/types.ts';
import { AiFailure, type FoundryDeps } from './foundry.ts';
import { redraw } from './redraw.ts';
import { drawScene, writePrompts } from './scene.ts';
import { suggestTitles } from './titles.ts';

/** Equal to extensions.queues.maxDequeueCount in host.json, so the last attempt settles the job instead of poisoning it. */
export const MAX_ATTEMPTS = 3;

export type JobDeps = { foundry: () => FoundryDeps; log: (message: string) => void };

type Ctx = { id: string; foundry: () => FoundryDeps; files: JobStore };

/**
 * How the worker runs one step of a job made from `I`: the code the step settles with when it cannot finish, and the
 * work, which returns what the step adds to the job row.
 */
type Step<R extends JobRow, I> = { failed: AiErrorCode; run: (row: R, input: I, ctx: Ctx) => Promise<Partial<R>> };

const trace = (quality: RedrawQuality): Step<PhotoJobRow, Photo> => ({
	failed: 'redraw_failed',
	run: async (_row, photo, ctx) => {
		await ctx.files.putFile(jobStepPngPath(ctx.id, `trace-${quality}`), await redraw(ctx.foundry(), photo, quality), 'image/png');
		return {};
	},
});

const PHOTO_STEPS: Record<PhotoStepKey, Step<PhotoJobRow, Photo>> = {
	titles: { failed: 'title_failed', run: async (_row, photo, ctx) => ({ titles: JSON.stringify(await suggestTitles(ctx.foundry(), photo)) }) },
	'trace-standard': trace('standard'),
	'trace-best': trace('best'),
};

const scene = (n: 1 | 2 | 3): Step<DescriptionJobRow, null> => ({
	failed: 'redraw_failed',
	run: async (row, _input, ctx) => {
		const prompt = row.prompts && (JSON.parse(row.prompts) as string[])[n - 1];
		// Settled like a refusal: once the prompts step has failed, no retry can draw this scene.
		if (!prompt) throw new AiFailure('refused', 'redraw_failed', 'the prompts step failed');
		await ctx.files.putFile(jobStepPngPath(ctx.id, `scene-${n}`), await drawScene(ctx.foundry(), prompt, row.quality), 'image/png');
		return {};
	},
});

const DESCRIPTION_STEPS: Record<SceneStepKey, Step<DescriptionJobRow, null>> = {
	prompts: {
		failed: 'scene_failed',
		run: async (row, _input, ctx) => {
			const { prompts, titles } = await writePrompts(ctx.foundry(), row.description);
			return { prompts: JSON.stringify(prompts), ...(titles.length ? { titles: JSON.stringify(titles) } : {}) };
		},
	},
	'scene-1': scene(1),
	'scene-2': scene(2),
	'scene-3': scene(3),
};

const describe = (error: unknown) => (error instanceof AiFailure ? `${error.code}: ${error.detail}` : `${(error as Error).name}: ${(error as Error).message}`);

type Attempt = { store: JobStore; deps: JobDeps; dequeueCount: number };

/**
 * Runs the pending steps one at a time, and saves after each so a retried message or a duplicate event never pays for
 * a finished step again. A refusal settles its step. Any other failure rethrows so the queue retries the message, until
 * the last attempt settles every pending step as failed. `load` resolves undefined when the job's input has expired.
 */
async function runSteps<R extends JobRow, K extends JobStepKey, I>(
	{ store, deps, dequeueCount }: Attempt,
	start: R,
	steps: JobStep<K>[],
	registry: Record<K, Step<R, I>>,
	load: () => Promise<I | undefined>,
): Promise<void> {
	let row = start;
	const save = (status: JobRow['status']) => store.replaceIfPresent({ ...row, status, steps: JSON.stringify(steps), attempts: dequeueCount });
	const settle = (step: JobStep<K>, error: AiErrorCode) => Object.assign(step, { state: 'failed', error });
	const pending = steps.filter((step) => step.state === 'pending');
	if (!pending.length) return;
	const input = await load();
	if (input === undefined) {
		for (const step of pending) settle(step, registry[step.key].failed);
		await save('done');
		return;
	}

	const ctx: Ctx = { id: row.rowKey, foundry: deps.foundry, files: store };
	if (!(await save('processing'))) return;
	for (const step of pending) {
		if (step.state !== 'pending') continue;
		try {
			row = { ...row, ...(await registry[step.key].run(row, input, ctx)) };
			step.state = 'done';
		} catch (error) {
			if (error instanceof AiFailure && error.kind === 'refused') settle(step, error.code);
			else {
				deps.log(`job ${row.rowKey} ${step.key} attempt ${dequeueCount} of ${MAX_ATTEMPTS}: ${describe(error)}`);
				if (dequeueCount < MAX_ATTEMPTS) throw error;
				for (const left of steps) if (left.state === 'pending') settle(left, registry[left.key].failed);
			}
		}
		// False once an admin has deleted the job mid-run. A result blob written after that is left to the lifecycle rule.
		if (!(await save(steps.some((left) => left.state === 'pending') ? 'processing' : 'done'))) return;
	}
}

export async function runJob(store: JobStore, deps: JobDeps, jobId: string, dequeueCount: number): Promise<void> {
	const row = await store.get(jobId);
	if (!row) return;
	const attempt = { store, deps, dequeueCount };
	switch (row.source) {
		case 'photo': {
			const photo = async () => {
				const jpeg = await store.file(jobPhotoPath(jobId));
				return jpeg && { jpeg, width: row.width, height: row.height };
			};
			return runSteps(attempt, row, jobSteps(row), PHOTO_STEPS, photo);
		}
		case 'description':
			return runSteps(attempt, row, jobSteps(row), DESCRIPTION_STEPS, async () => null);
	}
}

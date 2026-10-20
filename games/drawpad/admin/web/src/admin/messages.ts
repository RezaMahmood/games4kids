import { ApiFailure } from '../api';

const PLAIN: Partial<Record<ApiFailure['code'], string>> = {
  redraw_refused: 'The AI service declined this photo. Use the free option instead.',
  redraw_failed: 'The AI service did not answer. Try again, or use the free option.',
  redraw_unavailable: 'The AI service is not set up on this server. Use the free option.',
  too_many_jobs: 'Too many photos are waiting for the AI. Wait for some to finish, then add this one again.',
  scene_failed: 'The AI service did not answer. Try again.',
  job_busy: 'The AI is still working on this photo. Try again in a minute.',
};

/** Why one of the three pictures from a description is missing, short enough to sit where the picture would. */
export function sceneFailure(code: string): string {
  if (code === 'redraw_refused') return "The AI's safety check refused this picture.";
  return 'The AI could not draw this picture.';
}

/** Why a description made no pictures at all. */
export function describeScenesFailed(codes: string[]): string {
  return `None of the 3 pictures could be drawn. ${sceneFailure(codes[0] ?? 'redraw_failed')}`;
}

/** Why the AI could not turn a description into image prompts, which leaves it no pictures to draw. */
export function describePromptsFailure(error: Error): string {
  if (error instanceof ApiFailure && error.code === 'scene_refused') {
    return "The AI's safety check refused this description. Try describing the picture another way.";
  }
  return describeFailure('The AI could not make pictures from this description.', error);
}

/**
 * One plain sentence for the admin: what failed, then the server's status and code and its explanation when there are any.
 * A failed upload job step has a code but no HTTP status of its own, so its status is 0 and left out.
 */
export function describeFailure(what: string, error: unknown): string {
  if (error instanceof ApiFailure) {
    const plain = PLAIN[error.code];
    return `${what} (${error.status ? `${error.status} ` : ''}${error.code}).${plain ? ` ${plain}` : ''}${error.message ? ` ${error.message}` : ''}`;
  }
  if (error instanceof Error && error.message) return `${what} ${error.message}`;
  return `${what} Please try again.`;
}

/** What a finished upload says in the Processing list and in Recent uploads. */
export const READY_TO_REVIEW = 'Ready to review';
export const READY_TO_PICK = 'Ready to pick a picture';

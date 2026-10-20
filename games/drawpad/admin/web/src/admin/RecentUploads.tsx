import type { Job } from '../../../../data/types';
import { useState } from 'preact/hooks';
import { describeFailure } from './messages';
import { describeJob, notLive, recentJobs, useRecentJobs, type JobRow } from './recentJobs';
import { reopenJob } from './uploadStore';

/** What a row is doing besides sitting there. */
type RowUi = { kind: 'idle' } | { kind: 'confirming' } | { kind: 'busy'; what: string } | { kind: 'failed'; message: string };

function RecentRow({ job, row, onOpened }: { job: Job; row: JobRow; onOpened: (itemId: number) => void }) {
  const [ui, setUi] = useState<RowUi>({ kind: 'idle' });
  const label = `${row.kind.toLowerCase()} ${row.text}`;

  const run = async (what: string, failed: string, work: () => Promise<void>) => {
    setUi({ kind: 'busy', what });
    try {
      await work();
    } catch (e) {
      setUi({ kind: 'failed', message: describeFailure(failed, e) });
    }
  };
  const review = () => run('Opening…', 'Could not open this upload.', async () => onOpened(await reopenJob(job)));
  const discard = () => run('Discarding…', 'Could not discard this upload.', () => recentJobs.discard(row.id));

  return (
    <li class="queue-row recent-row">
      <div class="queue-info">
        <span class="recent-kind">{row.kind}</span>
        <span class="queue-title">{row.text}</span>
        <span class={`status${row.tone === 'working' ? '' : row.tone === 'ok' ? ' ok' : ' bad'}`}>{row.status}</span>
        <span class="hint">{row.age}</span>
        {ui.kind === 'failed' && <span class="status bad" role="alert">{ui.message}</span>}
      </div>
      {ui.kind === 'busy' && <span class="hint" role="status">{ui.what}</span>}
      {ui.kind === 'confirming' && (
        <div class="row-gap" role="group" aria-label={`Discard ${label}?`}>
          <span class="field-label">Discard?</span>
          <button type="button" class="danger" onClick={discard}>Yes</button>
          <button type="button" class="plain" onClick={() => setUi({ kind: 'idle' })}>No</button>
        </div>
      )}
      {(ui.kind === 'idle' || ui.kind === 'failed') && (
        <div class="row-gap">
          {row.reviewable && <button type="button" class="primary" aria-label={`Review ${label}`} onClick={review}>Review</button>}
          <button type="button" class="plain" aria-label={`Discard ${label}`} onClick={() => setUi({ kind: 'confirming' })}>Discard</button>
        </div>
      )}
    </li>
  );
}

type Props = {
  /** Jobs that are already items in the Processing list. */
  liveJobIds: ReadonlySet<string>;
  /** Changes whenever the admin adds an item, so the list asks the server again. */
  refreshKey: string;
  onOpened: (itemId: number) => void;
};

/** The server's recent jobs, so a reload never loses one the AI is still running or has finished. */
export function RecentUploads({ liveJobIds, refreshKey, onOpened }: Props) {
  const state = useRecentJobs(refreshKey);
  const now = new Date();
  const jobs = state.kind === 'loading' ? [] : notLive(state.jobs, liveJobIds);

  return (
    <section class="panel" aria-label="Recent uploads">
      <h2>Recent uploads</h2>
      {state.kind === 'loading' && <p class="hint" role="status">Loading recent uploads</p>}
      {state.kind === 'error' && (
        <p class="alert" role="alert">
          {state.message}
          <button type="button" class="plain" onClick={() => void recentJobs.refresh()}>Retry</button>
        </p>
      )}
      {state.kind === 'ready' && jobs.length === 0 && <p class="hint">Nothing from the last 7 days is waiting here.</p>}
      {jobs.length > 0 && (
        <ul class="queue">
          {jobs.map((job) => <RecentRow key={job.id} job={job} row={describeJob(job, now)} onOpened={onOpened} />)}
        </ul>
      )}
    </section>
  );
}

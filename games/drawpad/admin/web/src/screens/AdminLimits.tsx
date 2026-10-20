import { useEffect, useState } from 'preact/hooks';
import type { ChildLimit, Limits } from '../../../../data/types';
import { api } from '../api';
import { describeFailure } from '../admin/messages';
import '../admin/admin.css';

const minutes = (seconds: number) => `${Math.floor(seconds / 60)} min`;

const saved = (child: ChildLimit) => (child.dailyLimitMinutes === null ? '' : String(child.dailyLimitMinutes));

/** Remounted by its key whenever the saved limit changes, so the field always starts from what the server holds. */
function LimitCell({ child, onSave }: { child: ChildLimit; onSave: (limit: number | null) => Promise<void> }) {
  const initial = saved(child);
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const entered = text.trim();
  const valid = entered === '' || (/^\d+$/.test(entered) && Number(entered) <= 24 * 60);
  const changed = entered !== initial;

  const save = async () => {
    setSaving(true);
    try {
      await onSave(entered === '' ? null : Number(entered));
    } finally {
      setSaving(false);
    }
  };

  return (
    <span class="limit">
      <input
        class="text-input narrow"
        type="text"
        inputMode="numeric"
        aria-label={`Daily limit in minutes for ${child.name}`}
        aria-invalid={!valid}
        placeholder="Default"
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <button type="button" class="plain" disabled={!changed || !valid || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
    </span>
  );
}

export function AdminLimits() {
  const [data, setData] = useState<Limits | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api.limits().then(
      (loaded) => live && (setData(loaded), setLoadFailed(false)),
      () => live && setLoadFailed(true),
    );
    return () => { live = false; };
  }, [attempt]);

  const save = async (child: ChildLimit, limit: number | null) => {
    setProblem(null);
    try {
      await api.setChildLimit(child.userId, limit);
      setAttempt((n) => n + 1);
    } catch (e) {
      setProblem(describeFailure(`Could not save the limit for ${child.name}.`, e));
    }
  };

  if (!data) {
    return (
      <div class="page">
        {loadFailed ? (
          <p class="alert" role="alert">Could not load the children. <button type="button" class="plain" onClick={() => setAttempt((n) => n + 1)}>Try again</button></p>
        ) : (
          <p class="hint">Loading…</p>
        )}
      </div>
    );
  }

  return (
    <div class="page">
      <section class="panel">
        <h1>Daily limits</h1>
        <p class="hint">Children with no limit of their own get {data.defaultMinutes} minutes a day. Add or remove children on the Members page.</p>
        {problem && <p class="alert" role="alert">{problem}</p>}
        {data.children.length === 0 ? (
          <p class="empty">No children have Draw Pad switched on yet.</p>
        ) : (
          <div class="table-scroll">
            <table>
              <thead>
                <tr><th scope="col">Child</th><th scope="col">Today</th><th scope="col">Daily limit (minutes)</th></tr>
              </thead>
              <tbody>
                {data.children.map((child) => (
                  <tr key={child.userId}>
                    <td><strong>{child.name}</strong></td>
                    <td>{minutes(child.usedSecondsToday)}</td>
                    <td><LimitCell key={`${child.userId}:${saved(child)}`} child={child} onSave={(limit) => save(child, limit)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

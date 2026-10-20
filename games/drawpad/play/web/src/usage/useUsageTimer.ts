import { useEffect, useRef } from 'preact/hooks';
import type { UsageToday } from '../../../../data/types';
import { api } from '../api';
import { drain, HEARTBEAT_MS, interact, requeue, setVisible, startTracker, tick } from './tracker';

const UNBLOCK_POLL_MS = 60_000;
const INTERACTION_EVENTS = ['pointerdown', 'pointermove', 'keydown'] as const;

export function useUsageTimer(enabled: boolean, timeUp: boolean, onUsage: (usage: UsageToday) => void): void {
  const report = useRef(onUsage);
  report.current = onUsage;

  useEffect(() => {
    if (!enabled) return;
    let t = startTracker(Date.now(), !document.hidden);

    const flush = () => {
      const [next, seconds] = drain(t);
      t = next;
      if (seconds === null) return;
      api.heartbeat(seconds).then(
        (u) => report.current(u),
        () => { t = requeue(t, seconds); },
      );
    };

    const onInteraction = () => { t = interact(t, Date.now()); };
    const onVisibility = () => {
      t = setVisible(t, !document.hidden);
      if (document.hidden) flush();
    };

    api.heartbeat(0).then((u) => report.current(u), () => {});
    const tickId = setInterval(() => { t = tick(t, Date.now()); }, 1000);
    const beatId = setInterval(flush, HEARTBEAT_MS);
    for (const e of INTERACTION_EVENTS) window.addEventListener(e, onInteraction, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);

    return () => {
      clearInterval(tickId);
      clearInterval(beatId);
      for (const e of INTERACTION_EVENTS) window.removeEventListener(e, onInteraction);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [enabled]);

  // Midnight in the server's zone resets the day, so only the server can say time is back.
  useEffect(() => {
    if (!enabled || !timeUp) return;
    const check = () => { if (!document.hidden) api.usage().then((u) => report.current(u), () => {}); };
    const id = setInterval(check, UNBLOCK_POLL_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [enabled, timeUp]);
}

import { Icon } from './Icon';

function TimeLeft({ minutes }: { minutes: number }) {
  return (
    <span class={minutes <= 5 ? 'time-left low' : 'time-left'} role="timer" aria-label={`${minutes} minutes left today`}>
      <Icon name="clock" size={18} />
      {minutes} min left
    </span>
  );
}

type Props = {
  canGoBack: boolean;
  historyActive: boolean;
  minutesLeft: number | null;
  onBack: () => void;
  onHistory: () => void;
};

/** Draw Pad's own controls. The brand, who is playing and sign-out belong to the portal bar above. */
export function PlayerBar(p: Props) {
  return (
    <header class="top-bar">
      <nav class="bar-side" aria-label="Main">
        {p.canGoBack && (
          <button type="button" class="bar-btn" onClick={p.onBack}>
            <Icon name="back" />
            Back
          </button>
        )}
        <button type="button" class="bar-btn" aria-current={p.historyActive ? 'page' : undefined} onClick={p.onHistory}>
          <Icon name="clock" />
          History
        </button>
      </nav>
      <div class="bar-side end">{p.minutesLeft !== null && <TimeLeft minutes={p.minutesLeft} />}</div>
    </header>
  );
}

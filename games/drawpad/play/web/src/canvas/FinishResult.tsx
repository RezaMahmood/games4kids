import type { Score } from '../../../../data/types';

export type ResultRow = { label: string; value: number; max: number };

const MESSAGES: Record<Score['stars'], string> = {
  5: 'Amazing work! That is a masterpiece.',
  4: 'Wow, great job! So neat and colourful.',
  3: 'Nice one! You are getting really good.',
  2: 'Good effort! A little more next time.',
  1: 'Great start! Give it another go.',
};

const CONFETTI = ['#D9573B', '#F2B33D', '#6DB65B', '#2B54D6', '#E77FB0', '#7A4FD0'];
const PIECES = Array.from({ length: 28 }, (_, i) => ({
  left: (i * 37) % 100,
  delay: (i % 7) * 0.12,
  fall: 1.6 + (i % 5) * 0.25,
  spin: (i % 2 ? 1 : -1) * (180 + (i % 4) * 120),
  color: CONFETTI[i % CONFETTI.length]!,
}));

function Star({ earned, index }: { earned: boolean; index: number }) {
  return (
    <svg
      class={earned ? 'cv-star cv-star-on' : 'cv-star'}
      style={{ animationDelay: `${0.25 + index * 0.18}s` }}
      viewBox="0 0 24 24"
      width="64"
      height="64"
      aria-hidden="true"
    >
      <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" />
    </svg>
  );
}

export function FinishResult({ score, rows, onAgain }: { score: Score; rows: ResultRow[]; onAgain: () => void }) {
  return (
    <div class="cv-result" role="dialog" aria-modal="true" aria-label="Your result">
      <div class="cv-confetti" aria-hidden="true">
        {PIECES.map((p) => (
          <span
            style={{ left: `${p.left}%`, background: p.color, animationDelay: `${p.delay}s`, animationDuration: `${p.fall}s`, '--spin': `${p.spin}deg` }}
          />
        ))}
      </div>
      <div class="cv-result-card">
        <div class="cv-stars" role="img" aria-label={`${score.stars} out of 5 stars`}>
          {[1, 2, 3, 4, 5].map((n) => <Star earned={n <= score.stars} index={n - 1} />)}
        </div>
        <h2>{MESSAGES[score.stars]}</h2>
        <p class="cv-result-total">{score.total} points</p>
        <ul class="cv-breakdown">
          {rows.map((row) => (
            <li>
              <span>{row.label}</span>
              <span class="cv-meter"><span style={{ width: `${(100 * row.value) / row.max}%` }} /></span>
              <span class="cv-points">{row.value} / {row.max}</span>
            </li>
          ))}
        </ul>
        <button type="button" class="primary cv-again" onClick={onAgain}>Do again</button>
      </div>
    </div>
  );
}

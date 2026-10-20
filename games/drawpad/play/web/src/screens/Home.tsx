import type { PictureKind } from '../../../../data/types';

type Props = { name: string; timeUp: boolean; onStart: (mode: PictureKind) => void };

function FreestyleArt() {
  return (
    <svg viewBox="0 0 400 260" aria-hidden="true">
      <g fill="none" stroke="#1F2430" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.28">
        <path d="M90 140 C130 80 240 80 280 140 C240 200 130 200 90 140 Z" />
        <path d="M280 140 L340 100 L330 140 L340 180 Z" />
        <path d="M200 95 C215 75 245 80 250 102" />
      </g>
      <path d="M90 140 C130 80 240 80 280 140 C250 185 190 196 150 186" fill="none" stroke="#E8772E" stroke-width="7" stroke-linecap="round" />
      <path d="M120 120 C150 135 170 160 160 175 M150 110 C185 128 205 160 195 182" fill="none" stroke="#2B54D6" stroke-width="10" stroke-linecap="round" opacity="0.85" />
      <circle cx="135" cy="132" r="7" fill="#1F2430" />
      <path d="M290 230 q20 -30 50 -10" fill="none" stroke="#1E7A46" stroke-width="7" stroke-linecap="round" />
    </svg>
  );
}

function PbnArt() {
  return (
    <svg viewBox="0 0 400 260" aria-hidden="true">
      <rect x="0" y="0" width="400" height="220" fill="#A9CBEF" />
      <rect x="0" y="220" width="400" height="40" fill="#FFFFFF" />
      <path d="M95 125 L200 40 L305 125 Z" fill="#D9573B" />
      <rect x="110" y="120" width="180" height="100" fill="#FFFFFF" />
      <g fill="none" stroke="#1F2430" stroke-width="4" stroke-linejoin="round">
        <path d="M0 220 H400" />
        <path d="M95 125 L200 40 L305 125 Z" />
        <rect x="110" y="120" width="180" height="100" />
        <rect x="180" y="160" width="40" height="60" />
        <rect x="130" y="140" width="35" height="35" />
        <rect x="235" y="140" width="35" height="35" />
      </g>
      <g font-family="Atkinson Hyperlegible, sans-serif" font-weight="700" font-size="20" fill="#1F2430" text-anchor="middle">
        <text x="200" y="110">4</text><text x="200" y="198">5</text><text x="147" y="164">6</text><text x="252" y="164">6</text><text x="60" y="246">7</text><text x="340" y="246">7</text>
      </g>
    </svg>
  );
}

export function Home({ name, timeUp, onStart }: Props) {
  return (
    <main class="page home">
      <h1>{timeUp ? `That’s all for today, ${name}` : `What do you want to do, ${name}?`}</h1>
      {timeUp && <p class="lead-soft">You’ve used your drawing time. You can still look at your drawings in History. See you tomorrow!</p>}
      <div class="home-grid">
        <button type="button" class="journey" disabled={timeUp} onClick={() => onStart('trace')}>
          <FreestyleArt />
          <span class="journey-text">
            <span class="journey-name">Freestyle</span>
            <span class="journey-hint">Trace over a picture or colour it in your way.</span>
          </span>
        </button>
        <button type="button" class="journey" disabled={timeUp} onClick={() => onStart('pbn')}>
          <PbnArt />
          <span class="journey-text">
            <span class="journey-name">Paint by numbers</span>
            <span class="journey-hint">Match each number to its colour.</span>
          </span>
        </button>
      </div>
    </main>
  );
}

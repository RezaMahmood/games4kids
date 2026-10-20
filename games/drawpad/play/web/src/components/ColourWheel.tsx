import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { hexToHsv, hsvToHex, parseHex, type Hsv } from '../canvas/colour';

type Props = { initial: string; onChange: (hex: string) => void };

const HUE_STEP = 5;
const HUE_BIG_STEP = 30;
const SAT_STEP = 0.05;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const DEG = 180 / Math.PI;

/** A hue and saturation disc, a brightness slider and a hex field. Hue runs clockwise from red at the top, saturation grows outwards. */
export function ColourWheel({ initial, onChange }: Props) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(initial));
  const [typed, setTyped] = useState(initial);
  const hex = hsvToHex(hsv);

  const set = (next: Hsv) => {
    const out = hsvToHex(next);
    setHsv(next);
    setTyped(out);
    onChange(out);
  };

  const pick = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    set({ ...hsv, h: (Math.atan2(dx, -dy) * DEG + 360) % 360, s: clamp01(Math.hypot(dx, dy) / (r.width / 2)) });
  };

  const onKey = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const hue = e.shiftKey ? HUE_BIG_STEP : HUE_STEP;
    const moves: Record<string, Partial<Hsv>> = {
      ArrowRight: { h: (hsv.h + hue) % 360 },
      ArrowLeft: { h: (hsv.h - hue + 360) % 360 },
      ArrowUp: { s: clamp01(hsv.s + SAT_STEP) },
      ArrowDown: { s: clamp01(hsv.s - SAT_STEP) },
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    set({ ...hsv, ...move });
  };

  const onType = (text: string) => {
    setTyped(text);
    const parsed = parseHex(text);
    if (!parsed) return;
    setHsv(hexToHsv(parsed));
    onChange(parsed);
  };

  const angle = hsv.h / DEG;
  return (
    <div class="cw">
      <div
        class="cw-disc"
        role="slider"
        tabIndex={0}
        aria-label="Colour wheel. Left and right change the colour, up and down make it stronger or paler."
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(hsv.h)}
        aria-valuetext={`Hue ${Math.round(hsv.h)} degrees, strength ${Math.round(hsv.s * 100)} percent`}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e); }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && pick(e)}
        onKeyDown={onKey}
      >
        <span class="cw-shade" style={{ opacity: 1 - hsv.v }} />
        <span class="cw-thumb" style={{ left: `${50 + Math.sin(angle) * hsv.s * 50}%`, top: `${50 - Math.cos(angle) * hsv.s * 50}%`, background: hex }} />
      </div>
      <label class="cw-field">
        <span>Brightness</span>
        <input
          type="range"
          class="cw-range"
          min={0}
          max={100}
          value={Math.round(hsv.v * 100)}
          style={{ '--full': hsvToHex({ ...hsv, v: 1 }) }}
          onInput={(e) => set({ ...hsv, v: Number(e.currentTarget.value) / 100 })}
        />
      </label>
      <div class="cw-row">
        <span class="cw-preview" style={{ background: hex }} aria-hidden="true" />
        <label class="cw-field grow">
          <span>Colour code</span>
          <input
            class={`cw-hex${parseHex(typed) ? '' : ' bad'}`}
            value={typed}
            maxLength={7}
            spellcheck={false}
            autocomplete="off"
            onInput={(e) => onType(e.currentTarget.value)}
          />
        </label>
      </div>
    </div>
  );
}

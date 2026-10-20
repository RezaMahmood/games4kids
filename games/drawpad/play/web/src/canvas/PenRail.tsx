import { DRAWING_PALETTE } from './palette';

export const PEN_SIZES = [{ name: 'Thin pen', size: 3, dot: 6 }, { name: 'Medium pen', size: 8, dot: 14 }, { name: 'Thick brush', size: 20, dot: 24 }];
export const ERASER_FACTOR = 2;
export const DEFAULT_PEN_COLOUR = 9;
export const DEFAULT_PEN_SIZE = 1;

const ICON = { width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true } as const;
const EraserIcon = () => <svg {...ICON}><path d="M4 16l9-9 6 6-6 6H8z" /><path d="M14 20h6" /></svg>;
export const UndoIcon = () => <svg {...ICON}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>;

/** A palette colour by its index, or the player's own colour from the wheel. */
export type PenColour = number | 'mine';

export const penHex = (colour: PenColour, mine: string) => (colour === 'mine' ? mine : DRAWING_PALETTE[colour]!.hex);

type Props = {
  colour: PenColour;
  mine: string;
  sizeIndex: number;
  erasing: boolean;
  canUndo: boolean;
  onColour: (colour: number) => void;
  onPickMine: () => void;
  onSize: (index: number) => void;
  onEraser: () => void;
  onUndo: () => void;
};

/** The drawing colours and tools, shared by Freestyle and the free draw mode of paint by numbers. */
export function PenRail({ colour, mine, sizeIndex, erasing, canUndo, onColour, onPickMine, onSize, onEraser, onUndo }: Props) {
  const hex = penHex(colour, mine);
  return (
    <aside class="pbn-rail fs-rail" role="toolbar" aria-label="Colours and tools">
      <div class="fs-grid">
        {DRAWING_PALETTE.map((swatch, i) => (
          <button
            type="button"
            class="fs-swatch"
            style={{ background: swatch.hex }}
            aria-label={swatch.name}
            aria-pressed={!erasing && i === colour}
            onClick={() => onColour(i)}
          />
        ))}
        <button
          type="button"
          class="fs-swatch"
          style={{ background: mine }}
          aria-label={`My colour, ${mine}. Opens the colour wheel`}
          aria-pressed={!erasing && colour === 'mine'}
          onClick={onPickMine}
        >
          <span class="wheel" />
        </button>
      </div>
      <hr />
      <div class="fs-grid">
        {PEN_SIZES.map((s, i) => (
          <button type="button" class="fs-tool" aria-label={s.name} aria-pressed={i === sizeIndex} onClick={() => onSize(i)}>
            <i style={{ width: s.dot, height: s.dot, background: erasing ? 'var(--muted)' : hex }} />
          </button>
        ))}
        <button type="button" class="fs-tool" aria-label="Eraser" aria-pressed={erasing} onClick={onEraser}>
          <EraserIcon />
        </button>
        <button type="button" class="fs-tool" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>
          <UndoIcon />
        </button>
      </div>
    </aside>
  );
}

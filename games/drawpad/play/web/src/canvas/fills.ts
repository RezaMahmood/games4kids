import type { DrawingMeta, PbnData, PbnRegion } from '../../../../data/types';

/** What a tap paints with: one of the picture's numbered colours, or the player's own colour. */
export type Brush = { index: number } | { hex: string };
export type Stroke = 'painted' | 'repainted' | 'ignored';

/** A region as it was before a stroke changed it. */
type Change = { id: number; filled: boolean; custom: string | undefined };

/**
 * Which regions are painted, and which of those carry another colour than their number's: the player's own, or
 * another number's. Any colour paints any region; whether to follow the numbers is the player's choice.
 */
export class Fills {
  readonly filled: Set<number>;
  readonly custom: Map<number, string>;
  private readonly byId: Map<number, PbnRegion>;
  private readonly history: Change[] = [];

  constructor(private readonly data: PbnData, saved: Pick<DrawingMeta, 'filledRegions' | 'customFills'>) {
    this.byId = new Map(data.regions.map((r) => [r.id, r]));
    this.filled = new Set((saved.filledRegions ?? []).filter((id) => this.byId.has(id)));
    this.custom = new Map(
      Object.entries(saved.customFills ?? {})
        .map(([id, hex]) => [Number(id), hex] as const)
        .filter(([id]) => this.byId.has(id)),
    );
    for (const id of this.custom.keys()) this.filled.add(id);
  }

  /** Paints a region with any brush, repaints included. Painting it the colour it already has changes nothing. */
  apply(id: number, brush: Brush): Stroke {
    const region = this.byId.get(id);
    if (!region) return 'ignored';
    const was = this.filled.has(id);
    const before: Change = { id, filled: was, custom: this.custom.get(id) };
    if ('index' in brush && brush.index === region.colorIndex) {
      if (was && !this.custom.has(id)) return 'ignored';
      this.custom.delete(id);
    } else {
      const hex = 'hex' in brush ? brush.hex : this.data.palette[brush.index]!;
      if (this.custom.get(id) === hex) return 'ignored';
      this.custom.set(id, hex);
    }
    this.filled.add(id);
    this.history.push(before);
    return was ? 'repainted' : 'painted';
  }

  get canUndo(): boolean {
    return this.history.length > 0;
  }

  /** Puts back the region the last stroke changed, as it was before. Returns that region, or undefined with no strokes left. */
  undo(): number | undefined {
    const last = this.history.pop();
    if (!last) return undefined;
    if (last.custom === undefined) this.custom.delete(last.id);
    else this.custom.set(last.id, last.custom);
    if (last.filled) this.filled.add(last.id);
    else this.filled.delete(last.id);
    return last.id;
  }

  numberOf(id: number): number | undefined {
    return this.byId.get(id)?.colorIndex;
  }

  /** Regions painted with their own number's colour. */
  get matched(): number {
    return this.filled.size - this.custom.size;
  }

  hexOf(id: number): string | undefined {
    if (!this.filled.has(id)) return undefined;
    return this.custom.get(id) ?? this.data.palette[this.byId.get(id)!.colorIndex];
  }

  /** Regions of this number not yet painted with its colour. */
  remaining(index: number): number {
    return this.data.regions.filter((r) => r.colorIndex === index && (!this.filled.has(r.id) || this.custom.has(r.id))).length;
  }

  toPatch(): { filledRegions: number[]; customFills: Record<number, string> } {
    return { filledRegions: [...this.filled], customFills: Object.fromEntries(this.custom) };
  }
}

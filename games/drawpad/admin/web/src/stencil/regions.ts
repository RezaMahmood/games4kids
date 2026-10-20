export type Segmentation = {
  /** Region id per pixel, 1..count, in order of first appearance in reading order. */
  ids: Int32Array;
  /** Colour cluster of region `id`, at index `id - 1`. */
  colours: Uint8Array;
  /** Graph node behind region `id`, at index `id - 1`, for merging it further. */
  nodes: Int32Array;
  count: number;
};

/** 4-connected components of equal cluster label. */
function components(labels: Uint8Array, w: number, _h: number) {
  const comp = new Int32Array(labels.length).fill(-1);
  const colours: number[] = [];
  const stack = new Int32Array(labels.length);
  for (let seed = 0; seed < labels.length; seed++) {
    if (comp[seed] !== -1) continue;
    const id = colours.length;
    colours.push(labels[seed]!);
    comp[seed] = id;
    let top = 0;
    stack[top++] = seed;
    while (top) {
      const i = stack[--top]!;
      const x = i % w;
      if (x > 0 && comp[i - 1] === -1 && labels[i - 1] === labels[seed]) {
        comp[i - 1] = id;
        stack[top++] = i - 1;
      }
      if (x < w - 1 && comp[i + 1] === -1 && labels[i + 1] === labels[seed]) {
        comp[i + 1] = id;
        stack[top++] = i + 1;
      }
      if (i >= w && comp[i - w] === -1 && labels[i - w] === labels[seed]) {
        comp[i - w] = id;
        stack[top++] = i - w;
      }
      if (i + w < labels.length && comp[i + w] === -1 && labels[i + w] === labels[seed]) {
        comp[i + w] = id;
        stack[top++] = i + w;
      }
    }
  }
  return { comp, colours: Uint8Array.from(colours) };
}

/** Region adjacency graph that merges a region into the neighbour it shares the longest border with. */
export class RegionGraph {
  private readonly parent: Int32Array;
  private readonly area: Float64Array;
  private readonly adj: Map<number, number>[];
  private alive = 0;

  constructor(private readonly comp: Int32Array, readonly colours: Uint8Array, w: number, h: number) {
    const n = colours.length;
    this.parent = Int32Array.from({ length: n }, (_, i) => i);
    this.area = new Float64Array(n);
    this.adj = Array.from({ length: n }, () => new Map());
    this.alive = n;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const a = comp[i]!;
        this.area[a]! += 1;
        if (x + 1 < w && comp[i + 1] !== a) this.link(a, comp[i + 1]!);
        if (y + 1 < h && comp[i + w] !== a) this.link(a, comp[i + w]!);
      }
    }
  }

  private link(a: number, b: number) {
    this.adj[a]!.set(b, (this.adj[a]!.get(b) ?? 0) + 1);
    this.adj[b]!.set(a, (this.adj[b]!.get(a) ?? 0) + 1);
  }

  isAlive(r: number) {
    return this.parent[r] === r;
  }

  private aliveIds(): number[] {
    return Array.from(this.parent.keys()).filter((r) => this.parent[r] === r);
  }

  private longestBorderNeighbour(r: number): number {
    let best = -1;
    let bestLen = 0;
    for (const [n, len] of this.adj[r]!) {
      if (len > bestLen || (len === bestLen && n < best)) {
        best = n;
        bestLen = len;
      }
    }
    return best;
  }

  /** Returns false when the region has no neighbour (it is the whole picture). */
  mergeIntoNeighbour(r: number): boolean {
    const into = this.longestBorderNeighbour(r);
    if (into === -1) return false;
    this.absorb(r, into);
    for (let same = this.sameColourNeighbour(into); same !== -1; same = this.sameColourNeighbour(into)) this.absorb(same, into);
    return true;
  }

  private sameColourNeighbour(r: number): number {
    for (const n of this.adj[r]!.keys()) if (this.colours[n] === this.colours[r]) return n;
    return -1;
  }

  private absorb(from: number, into: number) {
    this.area[into]! += this.area[from]!;
    this.adj[into]!.delete(from);
    for (const [n, len] of this.adj[from]!) {
      if (n === into) continue;
      this.adj[n]!.delete(from);
      this.adj[n]!.set(into, (this.adj[n]!.get(into) ?? 0) + len);
      this.adj[into]!.set(n, (this.adj[into]!.get(n) ?? 0) + len);
    }
    this.adj[from]!.clear();
    this.parent[from] = into;
    this.alive -= 1;
  }

  private root(r: number): number {
    let top = r;
    while (this.parent[top] !== top) top = this.parent[top]!;
    for (let cur = r; this.parent[cur] !== top; ) {
      const next = this.parent[cur]!;
      this.parent[cur] = top;
      cur = next;
    }
    return top;
  }

  private pixelRoots(): Int32Array {
    return this.comp.map((c) => this.root(c));
  }

  mergeSmall(minArea: number) {
    const bySize = (a: number, b: number) => this.area[a]! - this.area[b]! || a - b;
    for (let pass = 0; pass < 12; pass++) {
      let merged = false;
      for (const r of this.aliveIds().filter((id) => this.area[id]! < minArea).sort(bySize)) {
        if (this.isAlive(r) && this.area[r]! < minArea && this.mergeIntoNeighbour(r)) merged = true;
      }
      if (!merged) return;
    }
  }

  mergeSmallestUntil(maxRegions: number) {
    const bySize = (a: number, b: number) => this.area[a]! - this.area[b]! || a - b;
    while (this.alive > maxRegions) {
      let merged = false;
      for (const r of this.aliveIds().sort(bySize)) {
        if (this.alive <= maxRegions) break;
        if (this.isAlive(r) && this.mergeIntoNeighbour(r)) merged = true;
      }
      if (!merged) return;
    }
  }

  segmentation(): Segmentation {
    const roots = this.pixelRoots();
    const idOfRoot = new Map<number, number>();
    const colours: number[] = [];
    const nodes: number[] = [];
    const ids = new Int32Array(roots.length);
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i]!;
      let id = idOfRoot.get(root);
      if (id === undefined) {
        id = idOfRoot.size + 1;
        idOfRoot.set(root, id);
        colours.push(this.colours[root]!);
        nodes.push(root);
      }
      ids[i] = id;
    }
    return { ids, colours: Uint8Array.from(colours), nodes: Int32Array.from(nodes), count: nodes.length };
  }
}

export function buildRegionGraph(labels: Uint8Array, w: number, h: number): RegionGraph {
  const { comp, colours } = components(labels, w, h);
  return new RegionGraph(comp, colours, w, h);
}

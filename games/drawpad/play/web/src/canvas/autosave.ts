export type Autosave = {
  schedule: () => void;
  flush: () => Promise<void>;
  cancel: () => void;
};

const writing = new Set<Promise<void>>();

// Resolves once every write started so far has finished, so a screen opened right after a canvas reads what it saved.
export const savesSettled = (): Promise<void> => Promise.all(writing).then(() => undefined);

// Writes run one at a time so an older snapshot can never land after a newer one.
export function createAutosave(write: () => Promise<unknown>, delayMs: number): Autosave {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let queue: Promise<void> = Promise.resolve();

  const flush = () => {
    clearTimeout(timer);
    if (!dirty) return queue;
    dirty = false;
    queue = queue.then(() => write().then(() => undefined, () => { dirty = true; }));
    const mine = queue;
    writing.add(mine);
    void mine.then(() => writing.delete(mine));
    return queue;
  };

  return {
    schedule() {
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      clearTimeout(timer);
      dirty = false;
    },
  };
}

import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

type Props = { title: string; children: ComponentChildren; actions: ComponentChildren; onClose: () => void };

export function Dialog({ title, children, actions, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog ref={ref} class="dialog" aria-labelledby="dialog-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2 id="dialog-title">{title}</h2>
      <div class="dialog-body">{children}</div>
      <div class="dialog-actions">{actions}</div>
    </dialog>
  );
}

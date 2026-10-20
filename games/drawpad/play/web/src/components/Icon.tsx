const PATHS = {
  add: <path d="M12 5v14M5 12h14" />,
  back: <path d="M15 5l-7 7 7 7" />,
  check: <path d="M5 12l5 5 9-10" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  delete: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></>,
  edit: <path d="M4 20l4-1 11-11-3-3L5 16z" />,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  signIn: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3" /></>,
  signOut: <><path d="M14 4h5v16h-5" /><path d="M9 8l-4 4 4 4" /><path d="M5 12h10" /></>,
  warning: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 17h.01" /></>,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, width = 2.2 }: { name: IconName; size?: number; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={width} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** How long a finger must stay on a hold button before it acts. */
export const HOLD_MS = 800;

/**
 * A button that acts only once it has been held down for `ms`, so a hand brushing past it cannot wipe the page.
 * A fill sweeps across while it is held. A keyboard press acts at once, since nobody presses a key by accident.
 * @param {HTMLButtonElement} button
 * @param {() => void} run
 */
export function holdToPress(button, run, ms = HOLD_MS) {
  let timer = 0;
  let at = { x: 0, y: 0 };
  button.style.setProperty('--hold', `${ms}ms`);
  const stop = () => {
    clearTimeout(timer);
    button.removeAttribute('data-holding');
  };
  // The page may change under a held finger: the timer ends the attempt, or a question opens over it.
  const stillHeld = () => !button.disabled && button.contains(document.elementFromPoint(at.x, at.y));
  button.addEventListener('pointerdown', (event) => {
    stop();
    if (button.disabled || event.button !== 0) return;
    at = { x: event.clientX, y: event.clientY };
    button.setAttribute('data-holding', '');
    timer = setTimeout(() => {
      stop();
      if (stillHeld()) run();
    }, ms);
  });
  button.addEventListener('pointermove', (event) => {
    at = { x: event.clientX, y: event.clientY };
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, stop);
  button.addEventListener('contextmenu', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    if (event.detail === 0) run();
  });
}

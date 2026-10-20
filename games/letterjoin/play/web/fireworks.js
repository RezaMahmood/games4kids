/**
 * A firework show in the middle of the screen. The model is pure, with an injected random source, so it runs
 * under node:test. `startFireworks` is the only part that touches a canvas.
 * @typedef {{ x: number, y: number, vx: number, vy: number, age: number, life: number, hue: number, size: number }} Particle
 * @typedef {{ at: number, x: number, y: number, hue: number }} Launch
 */

export const SHOW_MS = 3200;
const GRAVITY = 380;
const DRAG = 0.985;
const HUES = [48, 330, 190, 120, 280, 20];

/**
 * When and where each burst goes off. They cluster in the middle third of the screen and spread out over time.
 * @param {() => number} rng
 * @param {{ width: number, height: number, bursts?: number }} options
 * @returns {Launch[]}
 */
export function planShow(rng, { width, height, bursts = 7 }) {
  return Array.from({ length: bursts }, (_, i) => ({
    at: Math.round((i / bursts) * (SHOW_MS * 0.65) + rng() * 120),
    x: width * (0.3 + rng() * 0.4),
    y: height * (0.25 + rng() * 0.3),
    hue: HUES[Math.floor(rng() * HUES.length)],
  }));
}

/** @returns {Particle[]} A ring of sparks that fly outwards at slightly different speeds. */
export function createBurst(rng, { x, y, hue, count = 84 }) {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + rng() * 0.2;
    const speed = 140 + rng() * 260;
    return { x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, age: 0, life: 1.1 + rng() * 0.9, hue: hue + (rng() - 0.5) * 24, size: 2.5 + rng() * 3 };
  });
}

/** @param {Particle[]} particles @param {number} dt seconds @returns {Particle[]} the sparks still alive */
export function stepParticles(particles, dt) {
  return particles
    .map((p) => ({ ...p, age: p.age + dt, x: p.x + p.vx * dt, y: p.y + p.vy * dt, vx: p.vx * DRAG, vy: p.vy * DRAG + GRAVITY * dt }))
    .filter((p) => p.age < p.life);
}

/** How bright a spark is, from 1 down to 0 as it dies. */
export const fade = (p) => Math.max(0, 1 - p.age / p.life) ** 1.4;

/**
 * Runs the show on a canvas and resolves when it is over. A `prefers-reduced-motion` visitor gets no show.
 * @param {HTMLCanvasElement} canvas
 * @param {{ rng?: () => number, now?: () => number, requestFrame?: (fn: () => void) => void, reduced?: boolean }} [env]
 * @returns {{ done: Promise<void>, stop: () => void }}
 */
export function startFireworks(canvas, { rng = Math.random, now = () => performance.now(), requestFrame = (fn) => requestAnimationFrame(fn), reduced = false } = {}) {
  if (reduced) return { done: Promise.resolve(), stop() {} };
  const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const launches = planShow(rng, { width, height });
  let particles = [];
  let last = now();
  const start = last;
  let stopped = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const stop = () => {
    stopped = true;
    ctx.clearRect(0, 0, width, height);
    finish();
  };
  const frame = () => {
    if (stopped) return;
    const t = now();
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    while (launches.length && launches[0].at <= t - start) particles.push(...createBurst(rng, launches.shift()));
    particles = stepParticles(particles, dt);
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';
    for (const p of particles) {
      const alpha = fade(p);
      ctx.fillStyle = `hsla(${p.hue}, 100%, 62%, ${alpha * 0.28})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `hsla(${p.hue}, 100%, 72%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    if (launches.length === 0 && particles.length === 0) stop();
    else requestFrame(frame);
  };
  requestFrame(frame);
  return { done, stop };
}

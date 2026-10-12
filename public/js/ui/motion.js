// Small animation helpers. Everything is skipped when the person has asked their system for
// less motion.
import { money } from '../core/format.js';

export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const easeOut = (t) => 1 - (1 - t) ** 3;
const running = new WeakMap();

// Count a money figure up (or down) from what it showed before to `to`
export function countUp(el, to, { duration = 900, format = money } = {}) {
  const from = Number(el.dataset.value);
  el.dataset.value = String(to);
  cancelAnimationFrame(running.get(el));
  if (reducedMotion() || !Number.isFinite(from) && to === 0) {
    el.textContent = format(to);
    return;
  }
  const start = Number.isFinite(from) ? from : 0;
  if (start === to) {
    el.textContent = format(to);
    return;
  }
  const began = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - began) / duration);
    el.textContent = format(start + (to - start) * easeOut(t));
    if (t < 1) running.set(el, requestAnimationFrame(step));
  };
  running.set(el, requestAnimationFrame(step));
}

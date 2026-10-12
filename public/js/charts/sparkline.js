// A tiny line-and-fill chart for the summary cards. It stretches to the card's width, so it is
// drawn in a 100 x 32 box with the stroke kept at a constant width.
import { html, uid } from '../core/dom.js';

export function sparkline(values, { colour = '#22c55e', height = 44 } = {}) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  // A figure that hasn't moved is a level line across the middle
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, span ? 30 - ((v - min) / span) * 28 : 16]);
  const line = `M${pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L')}`;
  const id = uid('spark');
  return html`
    <svg class="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" height="${height}" aria-hidden="true">
      <defs>
        <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${colour}" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="${colour}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path class="spark-fill" d="${line}L100,32L0,32Z" fill="url(#${id})"/>
      <path class="spark-line" d="${line}" fill="none" stroke="${colour}" stroke-width="2"
        vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

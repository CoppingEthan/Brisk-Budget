// Balance-over-time chart: green above zero, red below, with an optional dashed forecast and
// its confidence band. Pure SVG. Points sit by date, so one-day history steps and five-day
// forecast steps share one time scale.
import { html, render, raw, uid } from '../core/dom.js';
import { compactMoney, date as formatDate, money } from '../core/format.js';
import { addDays, addMonths, diffDays, startOfMonth, toLocalDate } from '../shared/dates.js';
import { textWidth } from './text.js';

const GREEN = '#22c55e';
const RED = '#ef4444';
const GREY = '#94a3b8';
const LINE = 2.5;

function niceScale(min, max) {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  const span = hi - lo;
  if (span === 0) return { min: -100, max: 100, step: 50 };
  const rough = span / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const r = rough / magnitude;
  const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * magnitude;
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

const monthIndex = (iso) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
const label = (iso, options) => toLocalDate(iso).toLocaleDateString('en-GB', options);

// Axis labels in one unambiguous format across the whole axis: days (whole steps back from the
// last date) for up to three months, otherwise the first of the month with the year on the
// first label and each January, or just years. `room` is the axis width in px. Each tick has
// its `full` text and a `short` one for when the year is already clear from the one before.
function timeTicks(first, last, room) {
  const span = diffDays(first, last);
  if (span <= 92) {
    const style = span <= 8 ? { weekday: 'short', day: 'numeric' } : { day: 'numeric', month: 'short' };
    const most = Math.max(2, Math.min(9, Math.floor(room / (span <= 8 ? 56 : 64)) + 1));
    const step = Math.max(1, Math.ceil(span / (most - 1)));
    const ticks = [];
    for (let back = 0; back <= span; back += step) {
      const date = addDays(last, -back);
      const text = label(date, style);
      ticks.unshift({ date, full: text, short: text });
    }
    return ticks;
  }
  const most = Math.max(2, Math.min(7, Math.floor(room / 80) + 1));
  const firstOfMonth = first.endsWith('-01') ? first : addMonths(startOfMonth(first), 1);
  const monthsFor = (interval) => {
    let date = firstOfMonth;
    while (monthIndex(date) % interval !== 0) date = addMonths(date, 1);
    const dates = [];
    for (; date <= last; date = addMonths(date, interval)) dates.push(date);
    return dates;
  };
  const interval = [1, 2, 3, 4, 6, 12, 24, 36, 60, 120].find(n => monthsFor(n).length <= most) || 120;
  return monthsFor(interval).map(date => (interval >= 12
    ? { date, full: date.slice(0, 4), short: date.slice(0, 4) }
    : { date, full: label(date, { month: 'short', year: 'numeric' }), short: label(date, { month: 'short' }) }));
}

// `animate` draws the line in from the left (new data); a redraw after a resize doesn't
export function renderBalanceChart(container, { history, forecast = [] }, { animate = false } = {}) {
  if (!history.length) {
    render(container, html`<div class="empty"><p>No balance history yet.</p></div>`);
    return;
  }
  const all = [...history.map(p => ({ ...p })), ...forecast.slice(1).map(p => ({ ...p, isForecast: true }))];
  // Draw at the box's real width, so nothing is scaled and the tooltip lines up
  const width = Math.max(200, Math.round(container.clientWidth) || 800);
  const height = width < 600 ? 260 : 340;
  const pad = { top: 16, right: 12, bottom: 30, left: width < 600 ? 50 : 64 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const values = all.map(p => p.value);
  for (const p of forecast) values.push(p.lower, p.upper);
  const scale = niceScale(Math.min(...values), Math.max(...values));
  const first = all[0].date;
  const last = all[all.length - 1].date;
  const totalDays = diffDays(first, last);
  const x = (iso) => pad.left + (totalDays <= 0 ? innerW / 2 : (diffDays(first, iso) / totalDays) * innerW);
  const y = (v) => pad.top + innerH - ((v - scale.min) / (scale.max - scale.min)) * innerH;
  const xs = all.map(p => x(p.date));
  const zeroY = y(0);
  const id = uid('chart');

  const hist = history.map((p, i) => `${xs[i].toFixed(1)},${y(p.value).toFixed(1)}`);
  const linePath = `M${hist.join('L')}`;
  const lastX = xs[history.length - 1];
  const areaPath = `M${xs[0].toFixed(1)},${zeroY.toFixed(1)}L${hist.join('L')}L${lastX.toFixed(1)},${zeroY.toFixed(1)}Z`;

  let forecastPath = '';
  let bandPath = '';
  if (forecast.length > 1) {
    const fx = (p) => x(p.date).toFixed(1);
    forecastPath = `M${forecast.map((p, j) => `${fx(p)},${y(j === 0 ? history[history.length - 1].value : p.value).toFixed(1)}`).join('L')}`;
    const upper = forecast.map(p => `${fx(p)},${y(p.upper).toFixed(1)}`);
    const lower = forecast.map(p => `${fx(p)},${y(p.lower).toFixed(1)}`).reverse();
    bandPath = `M${upper.join('L')}L${lower.join('L')}Z`;
  }

  const ticks = [];
  for (let v = scale.min; v <= scale.max + scale.step / 2; v += scale.step) ticks.push(v);
  // Whole pounds would repeat labels on a small scale (£1, £1, £2…)
  const tickText = (v) => (scale.step < 1 ? money(v) : compactMoney(v));

  // Labels near an edge are anchored to it, any that would touch the one before are dropped, and
  // the year is shown on the first label and wherever it changes
  const family = getComputedStyle(container).fontFamily || 'sans-serif';
  const xLabels = [];
  let right = -Infinity;
  for (const t of timeTicks(first, last, innerW)) {
    const year = t.date.slice(0, 4);
    const text = xLabels.at(-1)?.year === year ? t.short : t.full;
    const lx = x(t.date);
    const w = textWidth(text, { size: 11, family });
    const anchor = lx - pad.left < w / 2 ? 'start' : width - pad.right - lx < w / 2 ? 'end' : 'middle';
    const at = anchor === 'start' ? Math.max(lx, pad.left) : anchor === 'end' ? Math.min(lx, width - pad.right) : lx;
    const from = anchor === 'start' ? at : anchor === 'end' ? at - w : at - w / 2;
    if (from < right + 12) continue;
    right = from + w;
    xLabels.push({ x: at, anchor, text, year });
  }

  const latest = history[history.length - 1];
  const summary = `Balance ${money(history[0].value)} on ${formatDate(history[0].date)}, now ${money(latest.value)}${forecast.length > 1 ? `, forecast ${money(forecast[forecast.length - 1].value)} by ${formatDate(forecast[forecast.length - 1].date)}` : ''}`;
  // A line sitting exactly on £0 stays green: the green half reaches half a line width past zero
  const split = zeroY + LINE / 2;

  render(container, html`
    <svg class="balance-svg ${animate ? 'animate' : ''}" viewBox="0 0 ${width} ${height}" height="${height}" role="img" aria-label="${summary}">
      <defs>
        <linearGradient id="${id}-up" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${GREEN}" stop-opacity="0.38"/>
          <stop offset="100%" stop-color="${GREEN}" stop-opacity="0.03"/>
        </linearGradient>
        <linearGradient id="${id}-down" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${RED}" stop-opacity="0.03"/>
          <stop offset="100%" stop-color="${RED}" stop-opacity="0.38"/>
        </linearGradient>
        <clipPath id="${id}-above"><rect x="0" y="0" width="${width}" height="${Math.max(0, split)}"/></clipPath>
        <clipPath id="${id}-below"><rect x="0" y="${split}" width="${width}" height="${Math.max(0, height - split)}"/></clipPath>
      </defs>
      ${ticks.map(v => html`
        <line x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}"
          stroke="rgba(148,163,184,${v === 0 ? 0.55 : 0.16})" stroke-width="${v === 0 ? 1.5 : 1}" ${v === 0 ? '' : raw('stroke-dasharray="4 4"')}/>
        <text x="${pad.left - 8}" y="${y(v) + 4}" text-anchor="end" fill="${v === 0 ? '#e2e8f0' : GREY}" font-size="11" font-weight="${v === 0 ? 600 : 400}">${tickText(v)}</text>
      `)}
      <path class="bc-area" d="${areaPath}" fill="url(#${id}-up)" clip-path="url(#${id}-above)"/>
      <path class="bc-area" d="${areaPath}" fill="url(#${id}-down)" clip-path="url(#${id}-below)"/>
      ${bandPath ? html`<path class="bc-forecast" d="${bandPath}" fill="rgba(148,163,184,0.16)"/>` : ''}
      ${forecastPath ? html`
        <line x1="${lastX}" x2="${lastX}" y1="${pad.top}" y2="${height - pad.bottom}" stroke="${GREY}" stroke-dasharray="3 4" opacity="0.45"/>
        <text x="${lastX + 6}" y="${pad.top + 10}" fill="${GREY}" font-size="10">Forecast</text>
        <path class="bc-forecast" d="${forecastPath}" fill="none" stroke="${GREY}" stroke-width="2" stroke-dasharray="7 5" stroke-linecap="round" stroke-linejoin="round"/>
      ` : ''}
      <path class="bc-line" pathLength="1" d="${linePath}" fill="none" stroke="${GREEN}" stroke-width="${LINE}" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#${id}-above)"/>
      <path class="bc-line" pathLength="1" d="${linePath}" fill="none" stroke="${RED}" stroke-width="${LINE}" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#${id}-below)"/>
      ${xLabels.map(l => html`<text x="${l.x}" y="${height - 8}" text-anchor="${l.anchor}" fill="${GREY}" font-size="11">${l.text}</text>`)}
      <line data-hover-line x1="0" x2="0" y1="${pad.top}" y2="${height - pad.bottom}" stroke="#e2e8f0" stroke-dasharray="3 3" opacity="0"/>
      <circle data-hover-dot r="5" cx="0" cy="0" fill="${GREEN}" stroke="#0f172a" stroke-width="2" opacity="0"/>
      <rect data-hover-area x="${pad.left}" y="${pad.top}" width="${innerW}" height="${innerH}" fill="transparent" style="cursor:crosshair;touch-action:pan-y"/>
    </svg>
    <div class="chart-tooltip hidden" data-tooltip></div>
    ${forecast.length > 1 ? html`
      <div class="chart-legend">
        <span><span class="legend-line"></span>Forecast from recurring payments</span>
        <span><span class="legend-band"></span>Likely range, based on your everyday spending</span>
      </div>` : ''}
  `);

  const svg = container.querySelector('svg');
  const area = container.querySelector('[data-hover-area]');
  const lineEl = container.querySelector('[data-hover-line]');
  const dot = container.querySelector('[data-hover-dot]');
  const tip = container.querySelector('[data-tooltip]');

  // The point nearest in time to a horizontal position
  const nearest = (px) => {
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= px) lo = mid;
      else hi = mid;
    }
    return Math.abs(xs[hi] - px) < Math.abs(px - xs[lo]) ? hi : lo;
  };

  let hideTimer = null;
  const show = (event) => {
    clearTimeout(hideTimer);
    const rect = svg.getBoundingClientRect();
    const i = nearest((event.clientX - rect.left) * (width / rect.width));
    const p = all[i];
    const cx = xs[i];
    const cy = y(p.value);
    const colour = p.isForecast ? GREY : p.value >= 0 ? GREEN : RED;
    lineEl.setAttribute('x1', cx);
    lineEl.setAttribute('x2', cx);
    lineEl.setAttribute('opacity', '0.6');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('fill', colour);
    dot.setAttribute('opacity', '1');
    render(tip, html`
      <div class="tt-date">${formatDate(p.date)}${p.isForecast ? ' · forecast' : ''}</div>
      <div class="tt-value" style="color:${colour}">${money(p.value)}</div>
      ${p.isForecast ? html`<div class="tt-range">likely ${money(p.lower)} to ${money(p.upper)}</div>` : ''}
    `);
    tip.classList.remove('hidden');
    const left = (cx / width) * rect.width;
    const top = (cy / height) * rect.height;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.max(half, Math.min(rect.width - half, left))}px`;
    tip.style.top = `${top}px`;
    // Near the top it would cover the controls above the chart, so it goes under the point
    tip.classList.toggle('below', top < tip.offsetHeight + 18);
  };
  const hide = () => {
    clearTimeout(hideTimer);
    lineEl.setAttribute('opacity', '0');
    dot.setAttribute('opacity', '0');
    tip.classList.add('hidden');
  };
  // A finger lifting fires pointerleave straight away, so on touch the value stays up for a
  // few seconds, or until a tap elsewhere
  const leave = (event) => {
    if (event.pointerType !== 'touch') return hide();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 4000);
  };
  area.addEventListener('pointermove', show);
  area.addEventListener('pointerdown', show);
  area.addEventListener('pointerleave', leave);
  area.addEventListener('pointercancel', leave);
  const outside = (event) => {
    if (!svg.isConnected) document.removeEventListener('pointerdown', outside);
    else if (!svg.contains(event.target)) hide();
  };
  document.addEventListener('pointerdown', outside);
}

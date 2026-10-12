// Money flow: income categories on the left, cash flow in the middle, spending on the right.
import { html, render, uid } from '../core/dom.js';
import { money } from '../core/format.js';
import { textWidth, fitText } from './text.js';

const INCOME = '#34d399';
const OTHER = '#94a3b8';
const SHORTFALL = '#f87171';

// Node heights in proportion to amount, but none shorter than `min`: small nodes get the
// minimum and the rest share what's left, so the column always fits its space.
function heights(rows, usable, min) {
  const floor = Math.min(min, usable / Math.max(1, rows.length));
  const fixed = new Set();
  for (;;) {
    const free = rows.filter((r, i) => !fixed.has(i));
    const freeTotal = free.reduce((s, r) => s + r.amount, 0);
    const room = usable - fixed.size * floor;
    const share = (r) => (freeTotal > 0 ? (r.amount / freeTotal) * room : room / Math.max(1, free.length));
    let changed = false;
    rows.forEach((r, i) => {
      if (!fixed.has(i) && share(r) < floor) { fixed.add(i); changed = true; }
    });
    if (!changed) return rows.map((r, i) => (fixed.has(i) ? floor : share(r)));
  }
}

export function renderSankey(container, flows) {
  const { income, expenses, totalIncome, totalExpenses, net } = flows;
  if (totalIncome === 0 && totalExpenses === 0) {
    render(container, html`<div class="empty"><p>No income or spending in this period.</p></div>`);
    return;
  }
  // Draw at the box's real width so text keeps its size on narrow phones
  const width = Math.max(200, Math.round(container.clientWidth) || 800);
  // Sizes scale smoothly from a phone (360px) to a desktop panel (900px and up), rather than
  // jumping from one layout to another at a breakpoint
  const mobile = width < 560;
  const t = Math.min(1, Math.max(0, (width - 360) / 540));
  const lerp = (a, b) => a + (b - a) * t;
  const family = getComputedStyle(container).fontFamily || 'sans-serif';
  const font = { label: lerp(9.5, 12), amount: lerp(8.5, 10.5), title: lerp(11, 13), total: lerp(10, 13) };
  const nodeW = Math.round(lerp(8, 12));
  const labelSpace = Math.round(Math.min(lerp(Math.min(76, width * 0.25), 150), width * 0.22));
  const labelGap = Math.round(lerp(6, 10));
  const side = Math.round(lerp(8, 24));
  const maxNodes = mobile ? 6 : 8;

  // Totals sit under their columns when there's room, otherwise one per line
  const deficit = net < 0;
  const totals = [
    { text: `${mobile ? 'In' : 'Income'}: ${money(totalIncome)}`, colour: '#22c55e' },
    { text: `${deficit ? 'Deficit' : 'Surplus'}: ${money(Math.abs(net))}`, colour: deficit ? '#ef4444' : '#22c55e' },
    { text: `${mobile ? 'Out' : 'Spending'}: ${money(totalExpenses)}`, colour: '#ef4444' }
  ].map(t => ({ ...t, w: textWidth(t.text, { size: font.total, weight: 700, family }) }));
  const leftX = side + labelSpace;
  const rightX = width - side - labelSpace - nodeW;
  const centreX = width / 2;
  const centres = [leftX + nodeW / 2, centreX, rightX + nodeW / 2];
  const inRow = centres.every((c, i) => c - totals[i].w / 2 >= 2 && c + totals[i].w / 2 <= width - 2)
    && centres[0] + totals[0].w / 2 + 12 <= centres[1] - totals[1].w / 2
    && centres[1] + totals[1].w / 2 + 12 <= centres[2] - totals[2].w / 2;
  const lineH = font.total + 5;
  const height = Math.round(Math.max(400, Math.min(520, width * 0.45)));
  const pad = { top: Math.round(lerp(26, 30)), bottom: inRow ? Math.round(lerp(40, 48)) : 3 * lineH + 16 };

  const squash = (rows, label, limit) => {
    if (rows.length <= limit) return rows;
    const kept = rows.slice(0, limit - 1);
    const rest = rows.slice(limit - 1);
    return [...kept, { id: 'other', name: `${label} (${rest.length})`, amount: rest.reduce((s, r) => s + r.amount, 0), color: OTHER }];
  };
  // Both sides share one scale, so a shortfall shows as money coming from your balances
  const left = squash(income, 'Other income', deficit ? maxNodes - 1 : maxNodes);
  if (deficit) left.push({ id: 'shortfall', name: 'Shortfall', amount: -net, color: SHORTFALL });
  const right = squash(expenses, 'Other', maxNodes);
  const scaleTotal = Math.max(totalIncome, totalExpenses);

  const available = height - pad.top - pad.bottom;
  const gap = 6;
  const layout = (rows, x) => {
    const hs = heights(rows, available - Math.max(0, rows.length - 1) * gap, mobile ? 20 : 24);
    let cursor = pad.top;
    return rows.map((r, i) => {
      const node = { ...r, x, y: cursor, h: hs[i] };
      cursor += hs[i] + gap;
      return node;
    });
  };
  const leftNodes = layout(left, leftX);
  const rightNodes = layout(right, rightX);

  const centreH = available * 0.86;
  const centreY = pad.top + (available - centreH) / 2;
  const curve = (x1, y1, h1, x2, y2, h2) => {
    const c = Math.abs(x2 - x1) * 0.5;
    return `M${x1},${y1}C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}L${x2},${y2 + h2}C${x2 - c},${y2 + h2} ${x1 + c},${y1 + h1} ${x1},${y1 + h1}Z`;
  };
  const ribbon = (amount) => (scaleTotal > 0 ? (amount / scaleTotal) * centreH : 0);

  let inCursor = centreY;
  const inFlows = leftNodes.map(n => {
    const h = ribbon(n.amount);
    const d = curve(n.x + nodeW, n.y, n.h, centreX - nodeW / 2, inCursor, h);
    inCursor += h;
    return { d, color: n.color || INCOME };
  });
  let outCursor = centreY;
  const outFlows = rightNodes.map(n => {
    const h = ribbon(n.amount);
    const d = curve(centreX + nodeW / 2, outCursor, h, n.x, n.y, n.h);
    outCursor += h;
    return { d, color: n.color };
  });

  // Labels are cut to the space beside their column; the full name is in a tooltip
  const labelX = (n, where) => (where === 'left' ? n.x - labelGap : n.x + nodeW + labelGap);
  const labelRoom = (n, where) => (where === 'left' ? labelX(n, where) : width - labelX(n, where)) - 2;
  const named = (nodes, where) => nodes.map(n => ({ ...n, short: fitText(n.name, labelRoom(n, where), { size: font.label, weight: 600, family }) }));
  const id = uid('flow');

  const nodeLabels = (n, where) => html`
    <text x="${labelX(n, where)}" y="${n.y + n.h / 2 - 1}" text-anchor="${where === 'left' ? 'end' : 'start'}" fill="${n.color || INCOME}" font-size="${font.label}" font-weight="600">${n.short !== n.name ? html`<title>${n.name}</title>` : ''}${n.short}</text>
    <text x="${labelX(n, where)}" y="${n.y + n.h / 2 + font.amount + 2}" text-anchor="${where === 'left' ? 'end' : 'start'}" fill="#94a3b8" font-size="${font.amount}">${money(n.amount)}</text>`;

  const totalsRow = inRow
    ? totals.map((t, i) => html`<text x="${centres[i]}" y="${height - 14}" text-anchor="middle" fill="${t.colour}" font-size="${font.total}" font-weight="700">${t.text}</text>`)
    : [totals[0], totals[2], totals[1]].map((t, i) => html`<text x="${centreX}" y="${height - 12 - (2 - i) * lineH}" text-anchor="middle" fill="${t.colour}" font-size="${font.total}" font-weight="700">${t.text}</text>`);

  render(container, html`
    <svg viewBox="0 0 ${width} ${height}" height="${height}" role="img"
      aria-label="Money in ${money(totalIncome)}, money out ${money(totalExpenses)}, ${deficit ? 'deficit' : 'surplus'} ${money(Math.abs(net))}">
      <defs>
        ${leftNodes.map((n, i) => html`
          <linearGradient id="${id}-in-${i}" x1="0" x2="1"><stop offset="0%" stop-color="${n.color || INCOME}" stop-opacity="0.6"/><stop offset="100%" stop-color="${n.color || INCOME}" stop-opacity="0.18"/></linearGradient>`)}
        ${rightNodes.map((n, i) => html`
          <linearGradient id="${id}-out-${i}" x1="0" x2="1"><stop offset="0%" stop-color="${INCOME}" stop-opacity="0.16"/><stop offset="100%" stop-color="${n.color}" stop-opacity="0.65"/></linearGradient>`)}
      </defs>
      ${inFlows.map((f, i) => html`<path d="${f.d}" fill="url(#${id}-in-${i})"/>`)}
      ${outFlows.map((f, i) => html`<path d="${f.d}" fill="url(#${id}-out-${i})"/>`)}
      ${named(leftNodes, 'left').map(n => html`
        <rect x="${n.x}" y="${n.y}" width="${nodeW}" height="${n.h}" rx="3" fill="${n.color || INCOME}"/>
        ${nodeLabels(n, 'left')}`)}
      <rect x="${centreX - nodeW / 2}" y="${centreY}" width="${nodeW}" height="${centreH}" fill="#22c55e" rx="2"/>
      <text x="${centreX}" y="${centreY - 10}" text-anchor="middle" fill="#f1f5f9" font-size="${font.title}" font-weight="600">Cash flow</text>
      ${named(rightNodes, 'right').map(n => html`
        <rect x="${n.x}" y="${n.y}" width="${nodeW}" height="${n.h}" rx="3" fill="${n.color}"/>
        ${nodeLabels(n, 'right')}`)}
      ${totalsRow}
    </svg>
  `);
}

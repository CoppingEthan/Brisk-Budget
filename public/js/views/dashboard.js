import { html, render, on, $, $$, storage, store, toElement } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { state, activeAccounts, groups } from '../core/state.js';
import { money, tone, date as formatDate, initial, plural } from '../core/format.js';
import { renderBalanceChart } from '../charts/balance-chart.js';
import { renderSankey } from '../charts/sankey.js';
import { sparkline } from '../charts/sparkline.js';
import { setTitle } from '../shell/title.js';
import { toastError } from '../ui/toast.js';
import { closeMenu } from '../ui/menu.js';
import { countUp } from '../ui/motion.js';
import { addMonths, startOfMonth, endOfMonth, today } from '../shared/dates.js';
import { accountAvatar } from '../shell/sidebar.js';

const SELECTION_KEY = 'chartSelectedAccounts';
const RANGE_KEY = 'briskBudget_chartRange';
const FORECAST_KEY = 'briskBudget_chartForecast';
const RANGES = ['1w', '1m', '3m', '6m', '1y', '5y'];
const FORECASTS = ['0', '1m', '3m', '6m', '1y', '5y'];
// Saved instead of a list when every account is chosen, so accounts added later join in
const ALL = 'all';

// The summary cards. Choosing one shows its accounts in the chart. For debt, going down is good.
const CARDS = [
  { key: 'netWorth', label: 'Net worth', icon: 'activity', types: null, note: 'Everything you own minus what you owe, as of today' },
  { key: 'cash', label: 'Cash', icon: 'wallet', types: ['bank'], note: 'Bank accounts' },
  { key: 'savings', label: 'Savings', icon: 'sparkles', types: ['savings', 'investment'], note: 'Savings and investments (at their current value, if you set one)' },
  { key: 'debt', label: 'Debt', icon: 'database', types: ['credit', 'loan', 'mortgage'], note: 'Cards, loans and mortgages', downIsGood: true }
];
const GREEN = '#22c55e';
const RED = '#ef4444';

export function dashboardView() {
  let root;
  let range = storage(RANGE_KEY, '1m');
  let forecast = storage(FORECAST_KEY, '0');
  if (!RANGES.includes(range)) range = '1m';
  if (!FORECASTS.includes(forecast)) forecast = '0';
  let flowFrom = addMonths(today(), -1);
  let flowTo = today();
  let seriesData = null;
  let flowData = null;
  let seriesAbort = null;
  let flowAbort = null;
  let summaryRequest = 0;
  let selected = [];
  let picker = null;
  let cleanup = [];

  function loadSelection() {
    const accounts = activeAccounts();
    const ids = new Set(accounts.map(a => a.id));
    const saved = storage(SELECTION_KEY, null);
    if (saved === ALL) selected = accounts.map(a => a.id);
    else selected = Array.isArray(saved) ? saved.filter(id => ids.has(id)) : [];
    if (!selected.length) selected = accounts.filter(a => a.type === 'bank' || a.type === 'credit').map(a => a.id);
    if (!selected.length) selected = accounts.map(a => a.id);
  }

  function saveSelection() {
    const accounts = activeAccounts();
    const all = accounts.length > 0 && accounts.every(a => selected.includes(a.id));
    store(SELECTION_KEY, all ? ALL : selected);
  }

  function chartTitle() {
    const accounts = activeAccounts();
    const chosen = accounts.filter(a => selected.includes(a.id));
    if (!chosen.length) return 'No accounts selected';
    if (chosen.length === accounts.length) return 'Net worth';
    const card = CARDS.find(c => c.types && sameSet(chosen.map(a => a.id), cardAccounts(c)));
    if (card) return card.label;
    if (chosen.every(a => a.type === 'bank' || a.type === 'credit') && chosen.some(a => a.type === 'bank') && chosen.some(a => a.type === 'credit')) return 'Cash in hand';
    if (chosen.every(a => a.type === 'bank')) return chosen.length === 1 ? chosen[0].name : 'Bank balance';
    if (chosen.length === 1) return chosen[0].name;
    return `${chosen.length} accounts`;
  }

  const cardAccounts = (card) => activeAccounts().filter(a => !card.types || card.types.includes(a.type)).map(a => a.id);
  const sameSet = (a, b) => a.length === b.length && a.every(id => b.includes(id));

  function greeting() {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    return state.settings.name ? `${part}, ${state.settings.name}` : part;
  }

  // ----- Summary cards -----

  function cardsSkeleton() {
    return CARDS.map((c, i) => html`
      <div class="stat-card ${i === 0 ? 'hero' : ''}"><span class="stat-label">${icon(c.icon, { size: 16 })}${c.label}</span><span class="skeleton" style="height:30px;width:60%"></span></div>`);
  }

  // How a figure has moved over the last 30 days, from the trend
  function change(card, trend) {
    const values = trend?.[card.key];
    if (!values || values.length < 31) return null;
    const now = values[values.length - 1];
    const then = values[values.length - 31];
    const delta = Math.round((now - then) * 100) / 100;
    const pct = then !== 0 ? (delta / Math.abs(then)) * 100 : null;
    const good = card.downIsGood ? delta < 0 : delta > 0;
    return { delta, pct, good };
  }

  // The cards are as of today, like the chart's "now"; anything dated later is in the forecast
  function renderCards(summary, trend) {
    const box = $('[data-cards]', root);
    // Each figure counts from what it showed before (nothing the first time)
    const shown = Object.fromEntries($$('[data-card-value]', box).map(el => [el.dataset.cardValue, el.dataset.value]));
    render(box, html`${CARDS.map((c, i) => {
      const value = summary[c.key];
      const cls = c.key === 'debt' ? (value > 0 ? 'negative' : '') : tone(value);
      const move = change(c, trend);
      const pressed = activeAccounts().length > 0 && sameSet(selected, cardAccounts(c));
      const lineColour = c.key === 'debt' ? RED : value < 0 ? RED : GREEN;
      return html`
        <button type="button" class="stat-card ${i === 0 ? 'hero' : ''}" data-card="${c.key}" aria-pressed="${String(pressed)}"
          title="${c.note}. Choose to show in the chart.">
          <span class="stat-label">${icon(c.icon, { size: 16 })}${c.label}</span>
          <span class="stat-value ${cls}" data-card-value="${c.key}" data-value="${shown[c.key] ?? ''}">${money(value)}</span>
          ${move ? html`
            <span class="stat-change ${move.delta === 0 ? '' : move.good ? 'good' : 'bad'}">
              ${move.delta === 0 ? 'No change' : html`${icon(move.delta > 0 ? 'chevronUp' : 'chevronDown', { size: 14 })}${money(Math.abs(move.delta))}${move.pct !== null && Math.abs(move.pct) >= 0.1 ? ` (${Math.abs(move.pct).toFixed(1)}%)` : ''}`}
              <span class="faint">in 30 days</span>
            </span>` : html`<span class="stat-change faint">&nbsp;</span>`}
          ${trend ? sparkline(trend[c.key], { colour: lineColour, height: i === 0 ? 64 : 40 }) : ''}
        </button>`;
    })}`);
    $$('[data-card-value]', box).forEach(el => countUp(el, summary[el.dataset.cardValue]));
  }

  function syncCards() {
    $$('[data-card]', root).forEach(el => {
      const card = CARDS.find(c => c.key === el.dataset.card);
      el.setAttribute('aria-pressed', String(sameSet(selected, cardAccounts(card))));
    });
  }

  // Only the newest request's answer is shown, however the replies arrive
  function loadSummary() {
    const request = ++summaryRequest;
    return Promise.all([api.summary(), api.trend().catch(() => null)])
      .then(([summary, trend]) => { if (request === summaryRequest && root.isConnected) renderCards(summary, trend); })
      .catch(err => { if (request === summaryRequest) toastError(err); });
  }

  // ----- Chart account toggles -----

  const groupPressed = (groupId) => {
    const ids = activeAccounts().filter(a => a.groupId === groupId).map(a => a.id);
    const count = ids.filter(id => selected.includes(id)).length;
    return count === 0 ? 'false' : count === ids.length ? 'true' : 'mixed';
  };

  function renderToggles() {
    closePicker();
    const container = $('[data-toggles]', root);
    const accounts = activeAccounts();
    const useGroups = state.settings.groupChartToggles !== false && state.groups.length > 0;
    const pill = (a) => html`
      <button type="button" class="chart-toggle" data-toggle-account="${a.id}" aria-pressed="${String(selected.includes(a.id))}">
        ${accountAvatar(a)}<span>${a.name}</span>
      </button>`;
    if (!useGroups) {
      render(container, html`${accounts.map(pill)}`);
      return;
    }
    const grouped = new Set();
    const groupPills = groups().map(g => {
      const children = accounts.filter(a => a.groupId === g.id);
      if (!children.length) return '';
      children.forEach(c => grouped.add(c.id));
      return html`
        <span class="chart-toggle-split">
          <button type="button" class="chart-toggle" data-toggle-group="${g.id}" aria-pressed="${groupPressed(g.id)}" title="Show or hide every account in ${g.name}">
            ${g.icon ? html`<span class="avatar square"><img src="${g.icon}" alt=""></span>` : html`<span class="avatar square">${initial(g.name)}</span>`}
            <span>${g.name}</span>
          </button>
          <button type="button" class="chart-toggle-more" data-group-menu="${g.id}" aria-expanded="false" aria-label="Choose accounts in ${g.name}">${icon('chevronDown')}</button>
        </span>`;
    });
    render(container, html`${groupPills}${accounts.filter(a => !grouped.has(a.id)).map(pill)}`);
  }

  // Update the pressed states in place (re-rendering would close an open picker)
  function syncToggles() {
    $$('[data-toggle-account]', root).forEach(b => b.setAttribute('aria-pressed', String(selected.includes(b.dataset.toggleAccount))));
    $$('[data-toggle-group]', root).forEach(b => b.setAttribute('aria-pressed', groupPressed(b.dataset.toggleGroup)));
    picker?.el.querySelectorAll('input').forEach(box => { box.checked = selected.includes(box.value); });
    syncCards();
  }

  function setSelection(ids) {
    selected = ids;
    saveSelection();
    syncToggles();
    loadSeries();
  }

  function closePicker({ focus = false } = {}) {
    if (!picker) return;
    const { el, anchor, stop } = picker;
    picker = null;
    stop();
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    anchor.removeAttribute('aria-controls');
    if (focus) anchor.focus();
  }

  // A small list of checkboxes under a group's arrow button, to pick accounts one by one. It
  // sits next to the button in the page, so Tab moves through it naturally and it scrolls along.
  function openGroupPicker(anchor, groupId) {
    if (picker?.anchor === anchor) {
      closePicker();
      return;
    }
    closePicker();
    closeMenu();
    const group = state.groups.find(g => g.id === groupId);
    const children = activeAccounts().filter(a => a.groupId === groupId);
    const el = toElement(html`
      <div class="menu chart-picker" id="chart-picker" role="group" aria-label="Accounts in ${group?.name || 'this group'}">
        ${children.map(a => html`
          <label class="menu-item check"><input type="checkbox" class="checkbox" value="${a.id}"><span>${a.name}</span></label>`)}
      </div>`);
    const boxes = [...el.querySelectorAll('input')];
    boxes.forEach(box => { box.checked = selected.includes(box.value); });
    anchor.after(el);
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', 'chart-picker');
    if (el.getBoundingClientRect().right > window.innerWidth - 8) el.classList.add('align-end');
    const wrap = anchor.parentElement;

    const onChange = (event) => {
      const id = event.target.value;
      setSelection(event.target.checked ? [...new Set([...selected, id])] : selected.filter(x => x !== id));
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePicker({ focus: true });
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && boxes.length) {
        event.preventDefault();
        const i = boxes.indexOf(document.activeElement);
        const next = event.key === 'ArrowDown' ? (i + 1) % boxes.length : (i <= 0 ? boxes.length : i) - 1;
        boxes[next].focus();
      } else if (event.key === 'Enter' && boxes.includes(event.target)) {
        event.preventDefault();
        event.target.click();
      }
    };
    const onFocusOut = (event) => { if (event.relatedTarget && !wrap.contains(event.relatedTarget)) closePicker(); };
    const onOutside = (event) => { if (!wrap.contains(event.target)) closePicker(); };
    el.addEventListener('change', onChange);
    wrap.addEventListener('keydown', onKey);
    wrap.addEventListener('focusout', onFocusOut);
    const timer = setTimeout(() => document.addEventListener('pointerdown', onOutside), 0);
    picker = {
      el,
      anchor,
      stop: () => {
        clearTimeout(timer);
        el.removeEventListener('change', onChange);
        wrap.removeEventListener('keydown', onKey);
        wrap.removeEventListener('focusout', onFocusOut);
        document.removeEventListener('pointerdown', onOutside);
      }
    };
    boxes[0]?.focus();
  }

  // ----- Balance chart -----

  async function loadSeries() {
    $('[data-chart-title]', root).textContent = chartTitle();
    const box = $('[data-chart]', root);
    seriesAbort?.abort();
    seriesAbort = null;
    if (!selected.length) {
      // Forget the old chart too, so a resize doesn't draw it back
      seriesData = null;
      box.removeAttribute('aria-busy');
      render(box, html`<div class="empty"><p>Pick at least one account above to see its balance.</p></div>`);
      return;
    }
    const controller = new AbortController();
    seriesAbort = controller;
    box.setAttribute('aria-busy', 'true');
    try {
      const data = await api.series({ accounts: selected.join(','), range, forecast }, { signal: controller.signal });
      if (seriesAbort !== controller) return;
      seriesData = data;
      drawSeries({ animate: true });
    } catch (err) {
      if (err.name === 'AbortError' || seriesAbort !== controller) return;
      seriesData = null;
      render(box, html`<div class="empty"><p>${err.message}</p></div>`);
    } finally {
      // A newer request still loading keeps the box busy
      if (seriesAbort === controller) box.removeAttribute('aria-busy');
    }
  }

  function drawSeries({ animate = false } = {}) {
    if (seriesData && root.isConnected) renderBalanceChart($('[data-chart]', root), seriesData, { animate });
  }

  // ----- Money flow -----

  async function loadFlows() {
    flowAbort?.abort();
    const controller = new AbortController();
    flowAbort = controller;
    try {
      const data = await api.flows({ from: flowFrom, to: flowTo }, { signal: controller.signal });
      if (flowAbort !== controller) return;
      flowData = data;
      drawFlows({ animate: true });
    } catch (err) {
      if (err.name === 'AbortError' || flowAbort !== controller) return;
      flowData = null;
      render($('[data-flows]', root), html`<div class="empty"><p>${err.message}</p></div>`);
    }
  }

  function drawFlows({ animate = false } = {}) {
    if (!flowData || !root.isConnected) return;
    const box = $('[data-flows]', root);
    renderSankey(box, flowData);
    if (animate) box.querySelector('svg')?.classList.add('animate');
  }

  function setFlowRange(from, to) {
    flowFrom = from;
    flowTo = to;
    $('[name="flowFrom"]', root).value = from;
    $('[name="flowTo"]', root).value = to;
    $$('[data-flow]', root).forEach(b => b.setAttribute('aria-pressed', 'false'));
    loadFlows();
  }

  // Payments due but not yet logged, for the line under the greeting
  function overdueCount() {
    const now = today();
    return state.recurring.filter(t => !t.paused && t.status !== 'ended' && t.nextDueDate && t.nextDueDate < now).length;
  }

  // ----- Page -----

  function renderSubtitle(overdue) {
    const status = overdue ? `${plural(overdue, 'payment')} waiting to be logged` : "here's your financial overview";
    $('[data-subtitle]', root).textContent = `${formatDate(today(), 'long')} · ${status}`;
  }

  // With no accounts yet only the welcome shows. Re-checked on every refresh, so restoring an
  // archived account from Settings brings the dashboard back.
  function renderWelcome() {
    const empty = activeAccounts().length === 0;
    $('[data-welcome]', root).classList.toggle('hidden', !empty);
    $$('[data-needs-accounts]', root).forEach(el => el.classList.toggle('hidden', empty));
    return !empty;
  }

  async function loadAll() {
    loadSelection();
    renderToggles();
    renderSubtitle(overdueCount());
    if (!renderWelcome()) {
      seriesAbort?.abort();
      flowAbort?.abort();
      seriesData = null;
      flowData = null;
      return;
    }
    await Promise.all([loadSummary(), loadSeries(), loadFlows()]);
  }

  return {
    async mount(container) {
      setTitle('Dashboard');
      root = document.createElement('div');
      root.className = 'view-inner dashboard';
      container.append(root);
      render(root, html`
        <header class="page-header">
          <div class="dashboard-greeting">
            <img src="/images/brisk-budget-icon.svg" alt="" width="46" height="46">
            <div>
              <h1 style="font-size:var(--text-xl)">${greeting()}</h1>
              <p class="page-subtitle" data-subtitle>${formatDate(today(), 'long')}</p>
            </div>
          </div>
        </header>
        <div class="page-body">
          <div class="empty hidden" data-welcome>
            ${icon('wallet')}
            <h3>Welcome to Brisk Budget</h3>
            <p>Start by adding your first account: a bank account, savings, credit card, loan or mortgage.</p>
            <button type="button" class="btn btn-primary" data-first-account>${icon('plus')}Add an account</button>
          </div>
          <section class="stat-grid dash-cards reveal" style="--i:0" data-cards data-needs-accounts aria-label="Summary">${cardsSkeleton()}</section>
          <div class="dash-grid" data-needs-accounts>
            <section class="panel chart-panel reveal" style="--i:1" aria-labelledby="chart-title">
              <div class="panel-header">
                <h2 class="panel-title" id="chart-title" data-chart-title>Balance</h2>
                <div class="chart-controls">
                  <div class="segmented" role="group" aria-label="History">
                    ${RANGES.map(r => html`<button type="button" data-range="${r}" aria-pressed="${String(r === range)}">${r.toUpperCase()}</button>`)}
                  </div>
                  <div class="segmented forecast" role="group" aria-label="Forecast">
                    <span class="segmented-label">Forecast</span>
                    ${FORECASTS.map(f => html`<button type="button" data-forecast="${f}" aria-pressed="${String(f === forecast)}">${f === '0' ? 'Off' : f.toUpperCase()}</button>`)}
                  </div>
                </div>
              </div>
              <div class="chart-toggles" data-toggles></div>
              <div class="chart-box balance-box" data-chart><div class="skeleton" style="height:300px"></div></div>
            </section>
            <section class="panel flow-panel reveal" style="--i:2" aria-labelledby="flow-title">
              <div class="panel-header">
                <h2 class="panel-title" id="flow-title">Money flow by category</h2>
                <div class="flow-dates">
                  <div class="segmented" role="group" aria-label="Quick ranges">
                    <button type="button" data-flow="this-month" aria-pressed="false">This month</button>
                    <button type="button" data-flow="last-month" aria-pressed="false">Last month</button>
                    <button type="button" data-flow="3m" aria-pressed="false">3M</button>
                    <button type="button" data-flow="ytd" aria-pressed="false">This year</button>
                  </div>
                  <input class="input" type="date" name="flowFrom" value="${flowFrom}" aria-label="From">
                  <span class="muted">to</span>
                  <input class="input" type="date" name="flowTo" value="${flowTo}" aria-label="To">
                </div>
              </div>
              <div class="chart-box" data-flows><div class="skeleton" style="height:360px"></div></div>
            </section>
          </div>
        </div>
      `);

      cleanup.push(on(root, 'click', '[data-first-account]', async () => {
        const { openAccountDialog } = await import('../dialogs/account.js');
        openAccountDialog();
      }));
      cleanup.push(on(root, 'click', '[data-card]', (event, el) => {
        setSelection(cardAccounts(CARDS.find(c => c.key === el.dataset.card)));
      }));
      cleanup.push(on(root, 'click', '[data-range]', (event, el) => {
        range = el.dataset.range;
        store(RANGE_KEY, range);
        $$('[data-range]', root).forEach(b => b.setAttribute('aria-pressed', String(b === el)));
        loadSeries();
      }));
      cleanup.push(on(root, 'click', '[data-forecast]', (event, el) => {
        forecast = el.dataset.forecast;
        store(FORECAST_KEY, forecast);
        $$('[data-forecast]', root).forEach(b => b.setAttribute('aria-pressed', String(b === el)));
        loadSeries();
      }));
      cleanup.push(on(root, 'click', '[data-toggle-account]', (event, el) => {
        const id = el.dataset.toggleAccount;
        setSelection(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
      }));
      cleanup.push(on(root, 'click', '[data-toggle-group]', (event, el) => {
        const ids = activeAccounts().filter(a => a.groupId === el.dataset.toggleGroup).map(a => a.id);
        const all = ids.every(id => selected.includes(id));
        setSelection(all ? selected.filter(id => !ids.includes(id)) : [...new Set([...selected, ...ids])]);
      }));
      cleanup.push(on(root, 'click', '[data-group-menu]', (event, el) => {
        openGroupPicker(el, el.dataset.groupMenu);
      }));
      cleanup.push(on(root, 'keydown', '[data-group-menu]', (event, el) => {
        if (event.key === 'ArrowDown' && picker?.anchor !== el) {
          event.preventDefault();
          openGroupPicker(el, el.dataset.groupMenu);
        }
      }));
      cleanup.push(on(root, 'click', '[data-flow]', (event, el) => {
        const now = today();
        const kind = el.dataset.flow;
        if (kind === 'this-month') setFlowRange(startOfMonth(now), now);
        if (kind === 'last-month') { const last = addMonths(startOfMonth(now), -1); setFlowRange(last, endOfMonth(last)); }
        if (kind === '3m') setFlowRange(addMonths(now, -3), now);
        if (kind === 'ytd') setFlowRange(`${now.slice(0, 4)}-01-01`, now);
        el.setAttribute('aria-pressed', 'true');
      }));
      cleanup.push(on(root, 'change', '[name="flowFrom"], [name="flowTo"]', () => {
        const from = $('[name="flowFrom"]', root).value;
        const to = $('[name="flowTo"]', root).value;
        if (from && to && from <= to) {
          flowFrom = from;
          flowTo = to;
          $$('[data-flow]', root).forEach(b => b.setAttribute('aria-pressed', 'false'));
          loadFlows();
        }
      }));
      // Charts are drawn at their box's real width, so redraw as soon as a box changes width
      // (window resizes, the layout switching columns, the sidebar opening), at most once a frame
      const widths = new WeakMap();
      let frame = 0;
      const pending = new Set();
      const resized = new ResizeObserver(entries => {
        for (const entry of entries) {
          const width = Math.round(entry.contentRect.width);
          if (widths.get(entry.target) === width) continue;
          const first = !widths.has(entry.target);
          widths.set(entry.target, width);
          if (!first) pending.add(entry.target);
        }
        if (!pending.size || frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (pending.has($('[data-chart]', root))) drawSeries();
          if (pending.has($('[data-flows]', root))) drawFlows();
          pending.clear();
        });
      });
      resized.observe($('[data-chart]', root));
      resized.observe($('[data-flows]', root));
      cleanup.push(() => { resized.disconnect(); cancelAnimationFrame(frame); });

      await loadAll();
    },
    refresh() {
      return loadAll();
    },
    destroy() {
      closePicker();
      seriesAbort?.abort();
      flowAbort?.abort();
      summaryRequest++;
      cleanup.forEach(fn => fn());
      cleanup = [];
    }
  };
}

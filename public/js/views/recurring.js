import { html, render, on, $, $$, storage, store } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { state, account as findAccount, category, changed, isLiability } from '../core/state.js';
import { money, tone, relativeDay, plural, date as formatDate, initial } from '../core/format.js';
import { setTitle } from '../shell/title.js';
import { toast, toastError } from '../ui/toast.js';
import { busy } from '../ui/forms.js';
import { confirmDialog } from '../ui/dialog.js';
import { countUp, reducedMotion } from '../ui/motion.js';
import { openRecurringDialog } from '../dialogs/recurring.js';
import { addDays, addMonths, diffDays, today, startOfMonth, endOfMonth, toLocalDate } from '../shared/dates.js';
import { upcoming, frequencyLabel, monthlyEquivalent, normaliseFrequency, anchorDayFor } from '../shared/recurrence.js';
import { round2 } from '../shared/money.js';

const COLLAPSED_KEY = 'briskBudget_collapsedRecurCats';
// Due dates listed on each waiting payment before the rest are summed up as "+N more"
const DATES_SHOWN = 8;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATUS_LABEL = { done: 'Done', overdue: 'Waiting', today: 'Due today', upcoming: 'Coming up' };

// "today", "in 3 days", "5 days ago", "1 Nov", and "1 Nov 2027" when it isn't this year
function when(iso) {
  const days = diffDays(today(), iso);
  if (days > -30 && days < 7) return relativeDay(iso);
  return formatDate(iso, iso.slice(0, 4) === today().slice(0, 4) ? 'short' : 'medium');
}

const count = (n) => Math.round(n).toLocaleString('en-GB');
const monthLabel = (iso) => toLocalDate(iso).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const longDay = (iso) => toLocalDate(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const wait = (ms) => new Promise(resolve => setTimeout(resolve, reducedMotion() ? 0 : ms));

// Waiting to be logged or skipped from a day already gone
const isOverdue = (t) => t.status !== 'ended' && !t.paused && t.nextDueDate < today();

// Every payment due today or earlier that hasn't been logged or skipped yet, oldest first
function waitingDates(t) {
  if (t.paused || t.status === 'ended') return [];
  return upcoming(t, today(), { limit: 1000 }).map(d => d.date);
}

// The schedule's step backwards, to place payments already dealt with on the calendar
function previousDate(t, iso) {
  const { type, interval } = normaliseFrequency(t.frequency);
  if (type === 'days') return addDays(iso, -interval);
  if (type === 'weeks') return addDays(iso, -interval * 7);
  return addMonths(iso, -(type === 'years' ? interval * 12 : interval), anchorDayFor(t));
}

export function recurringView() {
  let root;
  let suggestions = [];
  let cleanup = [];
  // The calendar's month and chosen day. Hovering a day previews it without choosing it.
  let calMonth = startOfMonth(today());
  let selectedDay = today();
  let calendar = new Map();
  // One batch of logging or skipping at a time, so two can't both try the same payment
  let working = false;

  const accountName = (id) => findAccount(id)?.name || 'a deleted account';
  const nameOf = (t) => (t.type === 'transfer' ? `${accountName(t.fromAccountId)} → ${accountName(t.toAccountId)}` : t.payee || '(no payee)');
  const live = () => state.recurring.filter(t => t.status !== 'ended');
  const find = (id) => state.recurring.find(t => t.id === id);

  // Paying a card, loan or mortgage from a bank or savings account is money leaving day-to-day
  // accounts just like a bill, so it counts as an outgoing here. Other transfers just move money.
  const isDebtPayment = (t) => t.type === 'transfer'
    && ['bank', 'savings'].includes(findAccount(t.fromAccountId)?.type) && isLiability(findAccount(t.toAccountId));

  // income, out or move (a transfer between your own accounts)
  function kindOf(t) {
    if (t.type === 'transfer') return isDebtPayment(t) ? 'out' : 'move';
    return t.amount >= 0 ? 'in' : 'out';
  }

  // What the payment does to day-to-day money: debt payments count as money out
  const effect = (t) => (isDebtPayment(t) ? -Math.abs(t.amount) : t.type === 'transfer' ? 0 : t.amount);

  function avatar(t, cls = '') {
    if (t.type === 'transfer') {
      return html`<span class="rec-avatar transfer ${cls}" aria-hidden="true">${icon('transfer')}</span>`;
    }
    const cat = category(t.categoryId);
    return html`<span class="rec-avatar ${cls}" style="--cat:${cat.color || '#94a3b8'}" aria-hidden="true">${cat.emoji || initial(nameOf(t))}</span>`;
  }

  function dateTile(iso, cls = '') {
    const d = toLocalDate(iso);
    return html`<span class="date-tile ${cls}" aria-hidden="true">
      <span class="date-tile-day">${d.getDate()}</span><span class="date-tile-month">${d.toLocaleDateString('en-GB', { month: 'short' })}</span>
    </span>`;
  }

  // ----- Summary cards -----

  function summary() {
    let income = 0;
    let spending = 0;
    let debt = 0;
    let incomeCount = 0;
    let outCount = 0;
    for (const t of state.recurring) {
      if (t.paused || t.status === 'ended') continue;
      const debtPayment = isDebtPayment(t);
      if (t.type === 'transfer' && !debtPayment) continue;
      const amount = effect(t);
      const monthly = monthlyEquivalent(amount, t.frequency);
      if (debtPayment) debt += Math.abs(monthly);
      else if (amount >= 0) income += monthly;
      else spending += Math.abs(monthly);
      if (amount >= 0) incomeCount++;
      else outCount++;
    }
    const waiting = waitingGroups();
    let waitingIn = 0;
    let waitingOut = 0;
    for (const { t, dates } of waiting) {
      const amount = effect(t) * dates.length;
      if (amount > 0) waitingIn += amount;
      else waitingOut -= amount;
    }
    return {
      income: round2(income),
      spending: round2(spending + debt),
      debt: round2(debt),
      net: round2(income - spending - debt),
      incomeCount,
      outCount,
      waiting: waiting.reduce((n, g) => n + g.dates.length, 0),
      waitingIn: round2(waitingIn),
      waitingOut: round2(waitingOut)
    };
  }

  function renderSummary() {
    const s = summary();
    const box = $('[data-summary]', root);
    // Each figure counts from what it showed before (nothing the first time)
    const shown = Object.fromEntries($$('[data-count]', box).map(el => [el.dataset.count, el.dataset.value]));
    const committed = s.income > 0 ? Math.min(100, (s.spending / s.income) * 100) : s.spending > 0 ? 100 : 0;
    box.classList.remove('grown');
    render(box, html`
      <div class="stat-card">
        <span class="stat-label">${icon('wallet', { size: 16 })}Monthly income</span>
        <span class="stat-value positive" data-count="income" data-value="${shown.income ?? ''}">${money(s.income)}</span>
        <span class="stat-note">${s.incomeCount ? `From ${plural(s.incomeCount, 'regular payment')}` : 'No regular income set up'}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">${icon('file', { size: 16 })}Monthly outgoings</span>
        <span class="stat-value negative" data-count="spending" data-value="${shown.spending ?? ''}">${money(s.spending)}</span>
        <span class="stat-note">${s.debt ? `Including ${money(s.debt)} paid to cards, loans and mortgages` : `${plural(s.outCount, 'bill')} and subscriptions`}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">${icon('activity', { size: 16 })}Left each month</span>
        <span class="stat-value ${tone(s.net)}" data-count="net" data-value="${shown.net ?? ''}">${money(s.net)}</span>
        ${s.income > 0 || s.spending > 0 ? html`
          <span class="rec-committed">
            <span class="bar-track thin"><span class="bar-fill ${committed >= 100 ? 'out' : ''}" style="--w:${committed}%;--bar:${committed >= 90 ? '#f59e0b' : '#818cf8'}"></span></span>
            <span class="stat-note">${s.income > 0 ? `${Math.round((s.spending / s.income) * 100)}% of regular income is spoken for` : 'Outgoings with no regular income'}</span>
          </span>` : html`<span class="stat-note">Income minus outgoings</span>`}
      </div>
      ${s.waiting ? html`
        <button type="button" class="stat-card rec-waiting-card" data-jump-waiting title="Go to the payments waiting to be logged">
          <span class="stat-label">${icon('clock', { size: 16 })}Waiting to be logged</span>
          <span class="stat-value warning-text" data-count="waiting" data-value="${shown.waiting ?? ''}">${count(s.waiting)}</span>
          <span class="stat-note">${[s.waitingOut ? `${money(s.waitingOut)} out` : '', s.waitingIn ? `${money(s.waitingIn)} in` : ''].filter(Boolean).join(' · ') || 'Transfers between your accounts'}</span>
        </button>` : html`
        <div class="stat-card rec-waiting-card done">
          <span class="stat-label">${icon('check', { size: 16 })}Waiting to be logged</span>
          <span class="stat-value" data-count="waiting" data-value="${shown.waiting ?? ''}">0</span>
          <span class="stat-note">All caught up</span>
        </div>`}
    `);
    $$('[data-count]', box).forEach(el => {
      const key = el.dataset.count;
      countUp(el, s[key], key === 'waiting' ? { format: count } : {});
    });
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('grown')));
  }

  // ----- Waiting to be logged -----

  function waitingGroups() {
    return live()
      .map(t => ({ t, dates: waitingDates(t) }))
      .filter(g => g.dates.length)
      .sort((a, b) => a.dates[0].localeCompare(b.dates[0]) || nameOf(a.t).localeCompare(nameOf(b.t)));
  }

  function waitingRow({ t, dates }) {
    const isTransfer = t.type === 'transfer';
    const now = today();
    const first = dates[0];
    const n = dates.length;
    const total = round2(t.amount * n);
    const where = isTransfer ? 'Transfer' : accountName(t.accountId);
    const status = n > 1 ? `${n} waiting since ${formatDate(first, 'short')}` : first === now ? 'Due today' : `Due ${when(first)}`;
    return html`
      <div class="waiting-row" data-id="${t.id}">
        ${avatar(t)}
        <div class="waiting-main">
          <span class="waiting-name truncate">${nameOf(t)}</span>
          <span class="waiting-meta truncate">${where} · <span class="warning-text">${status}</span></span>
          ${n > 1 ? html`
            <span class="waiting-dates">
              ${dates.slice(0, DATES_SHOWN).map((d, i) => html`<span class="waiting-date ${d === now ? 'today' : ''}" data-chip="${d}" style="--i:${i}">${formatDate(d, 'short')}</span>`)}
              ${n > DATES_SHOWN ? html`<span class="waiting-date more">+${n - DATES_SHOWN} more</span>` : ''}
            </span>` : ''}
        </div>
        <div class="waiting-amounts">
          <span class="tabular waiting-amount ${isTransfer ? '' : tone(t.amount)}">${money(t.amount, { signed: !isTransfer })}</span>
          ${n > 1 ? html`<span class="waiting-total">${money(Math.abs(total))} in all</span>` : ''}
        </div>
        <div class="waiting-actions">
          <button type="button" class="btn ${n > 1 ? 'btn-secondary' : 'btn-primary'} btn-sm" data-log-due="${first}"
            title="Log the payment due ${formatDate(first)}, dated ${formatDate(first)}" aria-label="Log ${nameOf(t)} due ${formatDate(first)}">${icon('check', { size: 14 })}Log</button>
          <button type="button" class="btn btn-ghost btn-sm" data-skip-due="${first}"
            title="Skip the payment due ${formatDate(first)} without logging it" aria-label="Skip ${nameOf(t)} due ${formatDate(first)}">${icon('skip', { size: 14 })}Skip</button>
          ${n > 1 ? html`<button type="button" class="btn btn-primary btn-sm" data-log-all
            title="Log all ${n}, each dated on its own due date" aria-label="Log all ${n} waiting payments for ${nameOf(t)}">${icon('check', { size: 14 })}Log all ${n}</button>` : ''}
        </div>
      </div>`;
  }

  function renderWaiting() {
    const panel = $('[data-waiting]', root);
    const groups = waitingGroups();
    const total = groups.reduce((n, g) => n + g.dates.length, 0);
    panel.classList.toggle('hidden', !groups.length);
    if (!groups.length) {
      render(panel, '');
      return;
    }
    render(panel, html`
      <div class="panel-header">
        <div>
          <h2 class="panel-title" id="waiting-title">${icon('clock', { size: 17 })}Waiting to be logged <span class="badge warning">${count(total)}</span></h2>
          <p class="panel-hint">Each one is logged on the date it was due, so your balances stay right.</p>
        </div>
        ${total > 1 ? html`<button type="button" class="btn btn-primary btn-sm" data-log-everything>${icon('check', { size: 14 })}Log all ${count(total)}</button>` : ''}
      </div>
      <div class="waiting-list" role="list">${groups.map(g => html`<div role="listitem">${waitingRow(g)}</div>`)}</div>
    `);
  }

  // Log (or skip) payments one at a time, oldest first, each on its own due date. The server
  // names the next due date after each one, so a payment moved by hand is followed correctly.
  async function settle(batches, { skip = false, progress } = {}) {
    const now = today();
    const planned = batches.reduce((n, b) => n + b.count, 0);
    let done = 0;
    for (const { t, count: n } of batches) {
      let due = t.nextDueDate;
      for (let i = 0; i < n && due && due <= now; i++) {
        const result = skip
          ? await api.skipRecurring(t.id, { dueDate: due })
          : await api.approveRecurring(t.id, { date: due, dueDate: due });
        done++;
        progress?.(done, planned, t, due);
        if (result?.status === 'ended') break;
        due = result?.nextDueDate;
      }
    }
    return done;
  }

  async function runSettle(batches, { skip = false, button, label, rows = [] }) {
    if (working) return;
    working = true;
    const panel = $('[data-waiting]', root);
    panel.setAttribute('aria-busy', 'true');
    $$('[data-waiting] button', root).forEach(b => { b.disabled = true; });
    const original = button?.innerHTML;
    let done = 0;
    try {
      done = await settle(batches, {
        skip,
        progress: (n, planned, t, due) => {
          root.querySelector(`.waiting-row[data-id="${CSS.escape(t.id)}"] [data-chip="${due}"]`)?.classList.add('done');
          if (button && planned > 1) button.textContent = `${skip ? 'Skipping' : 'Logging'} ${n} of ${planned}…`;
        }
      });
      rows.forEach(r => r?.classList.add('settled'));
      await wait(rows.length ? 280 : 0);
      toast(label(done), { kind: 'success' });
    } catch (err) {
      if (done) toast(`${skip ? 'Skipped' : 'Logged'} ${plural(done, 'payment')} before stopping`, { kind: 'warning' });
      if (err.status === 409) toast(err.message, { kind: 'warning' });
      else toastError(err);
    } finally {
      working = false;
      panel.removeAttribute('aria-busy');
      if (button?.isConnected && original) button.innerHTML = original;
      await changed().catch(() => {});
      // A refresh that ran meanwhile drew the buttons disabled; this one draws them ready
      if (root?.isConnected) renderWaiting();
    }
  }

  function logOne(el, { skip = false } = {}) {
    const row = el.closest('[data-id]');
    const t = find(row.dataset.id);
    const due = skip ? el.dataset.skipDue : el.dataset.logDue;
    if (!t || t.nextDueDate !== due) return;
    const only = waitingDates(t).length === 1;
    runSettle([{ t, count: 1 }], {
      skip,
      button: el,
      rows: only ? [row] : [],
      label: () => `${skip ? 'Skipped' : 'Logged'} ${nameOf(t)} for ${formatDate(due)}`
    });
  }

  function logAllFor(el) {
    const row = el.closest('[data-id]');
    const t = find(row.dataset.id);
    if (!t) return;
    const n = waitingDates(t).length;
    runSettle([{ t, count: n }], { button: el, rows: [row], label: (done) => `Logged ${plural(done, 'payment')} for ${nameOf(t)}` });
  }

  async function logEverything(el) {
    const groups = waitingGroups();
    const total = groups.reduce((n, g) => n + g.dates.length, 0);
    const ok = await confirmDialog({
      title: 'Log every waiting payment?',
      message: `This logs ${plural(total, 'payment')} from ${plural(groups.length, 'recurring payment')}, each dated on the day it was due.`,
      detail: 'You can still edit or delete any of them in the account afterwards.',
      confirmLabel: `Log ${count(total)}`,
      danger: false
    });
    if (!ok || !root?.isConnected) return;
    // Waiting dates may have changed while the question was open, so count again
    const fresh = waitingGroups();
    runSettle(fresh.map(g => ({ t: g.t, count: g.dates.length })), {
      button: $('[data-log-everything]', root) || el,
      rows: $$('.waiting-row', root),
      label: (done) => `Logged ${plural(done, 'payment')}`
    });
  }

  // ----- Month at a glance -----

  // Every payment in the month: those already dealt with (stepping back from the next due
  // date), those waiting, and those still to come. Paused and finished ones show only the past.
  function monthPayments(from, to) {
    const now = today();
    const days = new Map();
    const add = (date, entry) => {
      if (!days.has(date)) days.set(date, []);
      days.get(date).push(entry);
    };
    for (const t of state.recurring) {
      if (!t.nextDueDate) continue;
      const kind = kindOf(t);
      let date = previousDate(t, t.scheduledDate || t.nextDueDate);
      let guard = 0;
      while (date >= from && (!t.startDate || date >= t.startDate) && guard++ < 1000) {
        if (date <= to && date < t.nextDueDate) add(date, { t, kind, status: 'done' });
        date = previousDate(t, date);
      }
      if (t.paused || t.status === 'ended') continue;
      for (const { date: d } of upcoming(t, to)) {
        if (d < from) continue;
        add(d, { t, kind, status: d < now ? 'overdue' : d === now ? 'today' : 'upcoming' });
      }
    }
    const order = { overdue: 0, today: 1, upcoming: 2, done: 3 };
    for (const list of days.values()) list.sort((a, b) => order[a.status] - order[b.status] || Math.abs(b.t.amount) - Math.abs(a.t.amount));
    return days;
  }

  function dayLabel(iso, items) {
    const parts = [longDay(iso)];
    if (iso === today()) parts.push('today');
    parts.push(items.length ? plural(items.length, 'payment') : 'nothing due');
    for (const { t, status } of items.slice(0, 6)) parts.push(`${nameOf(t)} ${money(t.amount, { signed: t.type !== 'transfer' })}, ${STATUS_LABEL[status].toLowerCase()}`);
    return parts.join(', ');
  }

  function renderCalendar({ animate = false } = {}) {
    const from = calMonth;
    const to = endOfMonth(calMonth);
    const now = today();
    calendar = monthPayments(from, to);
    if (selectedDay < from || selectedDay > to) selectedDay = now >= from && now <= to ? now : ([...calendar.keys()].sort()[0] || from);

    let moneyIn = 0;
    let moneyOut = 0;
    let n = 0;
    for (const list of calendar.values()) {
      for (const { t } of list) {
        const value = effect(t);
        if (value > 0) moneyIn += value;
        else moneyOut -= value;
        n++;
      }
    }

    const lead = (toLocalDate(from).getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(html`<span class="cal-blank" aria-hidden="true"></span>`);
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const items = calendar.get(date) || [];
      const chosen = date === selectedDay;
      const states = new Set(items.map(i => i.status));
      const flag = states.has('overdue') ? 'has-overdue' : states.has('today') ? 'has-today' : '';
      cells.push(html`
        <button type="button" class="cal-day ${date === now ? 'today' : ''} ${date < now ? 'past' : ''} ${items.length ? 'has' : ''} ${flag}"
          data-day="${date}" aria-pressed="${String(chosen)}" tabindex="${chosen ? '0' : '-1'}" aria-label="${dayLabel(date, items)}">
          <span class="cal-num">${Number(date.slice(8))}</span>
          ${items.length ? html`
            <span class="cal-chips" aria-hidden="true">
              ${items.slice(0, 3).map(({ t, kind, status }) => html`<span class="cal-chip k-${kind} s-${status}"><span class="truncate">${nameOf(t)}</span><span class="cal-chip-amount tabular">${money(Math.abs(t.amount))}</span></span>`)}
              ${items.length > 3 ? html`<span class="cal-more">+${items.length - 3} more</span>` : ''}
            </span>
            <span class="cal-dots" aria-hidden="true">
              ${items.slice(0, 4).map(({ kind, status }) => html`<span class="cal-dot k-${kind} s-${status}"></span>`)}
            </span>` : ''}
        </button>`);
    }

    const panel = $('[data-calendar]', root);
    $('[data-cal-title]', panel).textContent = monthLabel(from);
    $('[data-cal-today]', panel).classList.toggle('hidden', from === startOfMonth(now));
    const grid = $('[data-cal-grid]', panel);
    render(grid, html`
      ${WEEKDAYS.map(d => html`<span class="cal-weekday" aria-hidden="true">${d}</span>`)}
      ${cells}
    `);
    if (animate && !reducedMotion()) {
      grid.classList.remove('anim');
      void grid.offsetWidth;
      grid.classList.add('anim');
    }
    render($('[data-cal-totals]', panel), html`
      <span>${plural(n, 'payment')} in ${toLocalDate(from).toLocaleDateString('en-GB', { month: 'long' })}</span>
      ${moneyIn ? html`<span class="positive tabular">+${money(moneyIn)}</span>` : ''}
      ${moneyOut ? html`<span class="negative tabular">−${money(moneyOut)}</span>` : ''}
    `);
    renderDay(selectedDay);
  }

  function renderDay(iso) {
    const items = calendar.get(iso) || [];
    const box = $('[data-cal-detail]', root);
    const days = diffDays(today(), iso);
    const rel = Math.abs(days) < 7 ? relativeDay(iso) : '';
    render(box, html`
      <div class="cal-detail-head">
        ${dateTile(iso, iso === today() ? 'today' : '')}
        <div>
          <h3 class="cal-detail-title">${longDay(iso)}</h3>
          <p class="cal-detail-sub">${rel ? `${rel[0].toUpperCase()}${rel.slice(1)} · ` : ''}${items.length ? plural(items.length, 'payment') : 'Nothing due'}</p>
        </div>
      </div>
      ${items.length ? html`
        <ul class="cal-detail-list">
          ${items.map(({ t, status }, i) => html`
            <li class="cal-detail-item s-${status}" style="--i:${i}">
              ${avatar(t, 'sm')}
              <span class="cal-detail-main">
                <span class="truncate cal-detail-name">${nameOf(t)}</span>
                <span class="cal-detail-meta"><span class="cal-status s-${status}">${STATUS_LABEL[status]}</span>${t.type === 'transfer' ? '' : ` · ${accountName(t.accountId)}`}</span>
              </span>
              <span class="tabular cal-detail-amount ${t.type === 'transfer' ? '' : tone(t.amount)}">${money(t.amount, { signed: t.type !== 'transfer' })}</span>
            </li>`)}
        </ul>` : html`<p class="cal-detail-empty">No recurring payments on this day.</p>`}
    `);
  }

  function selectDay(iso, { focus = false } = {}) {
    if (iso < calMonth || iso > endOfMonth(calMonth)) {
      calMonth = startOfMonth(iso);
      selectedDay = iso;
      renderCalendar({ animate: true });
    } else {
      selectedDay = iso;
      $$('[data-day]', root).forEach(b => {
        const on = b.dataset.day === iso;
        b.setAttribute('aria-pressed', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      renderDay(iso);
    }
    if (focus) $(`[data-day="${iso}"]`, root)?.focus();
  }

  function moveMonth(step) {
    calMonth = addMonths(calMonth, step);
    const now = today();
    selectedDay = startOfMonth(now) === calMonth ? now : '';
    renderCalendar({ animate: true });
  }

  // ----- Schedules -----

  function progress(t) {
    const end = t.endCondition;
    if (!end || end.type === 'never') return '';
    if (end.type === 'after_occurrences') {
      const total = Number(end.value) || 0;
      const done = Math.min(total, Number(t.occurrencesCompleted) || 0);
      if (!total) return '';
      return html`
        <span class="rec-progress" title="${done} of ${total} payments logged">
          <span class="bar-track thin"><span class="bar-fill" style="--w:${(done / total) * 100}%;--bar:#818cf8"></span></span>
          <span class="rec-progress-text">${done} of ${total} paid</span>
        </span>`;
    }
    if (end.type === 'on_date' && end.value) {
      const span = Math.max(1, diffDays(t.startDate || today(), end.value));
      const gone = Math.min(span, Math.max(0, diffDays(t.startDate || today(), today())));
      return html`
        <span class="rec-progress" title="Ends ${formatDate(end.value)}">
          <span class="bar-track thin"><span class="bar-fill" style="--w:${(gone / span) * 100}%;--bar:#818cf8"></span></span>
          <span class="rec-progress-text">${t.status === 'ended' ? 'Ended' : 'Ends'} ${formatDate(end.value, 'short')}</span>
        </span>`;
    }
    return '';
  }

  function row(t, i = 0) {
    const isTransfer = t.type === 'transfer';
    const monthly = Math.abs(monthlyEquivalent(t.amount, t.frequency));
    const cat = category(t.categoryId);
    const overdue = isOverdue(t);
    const ended = t.status === 'ended';
    const meta = [
      frequencyLabel(t.frequency),
      isTransfer ? null : accountName(t.accountId),
      isTransfer ? null : cat.name
    ].filter(Boolean).join(' · ');
    return html`
      <div class="recurring-row ${t.paused ? 'paused' : ''} ${ended ? 'ended' : ''} ${overdue ? 'overdue' : ''}" data-id="${t.id}" style="--i:${i}">
        ${avatar(t)}
        <button type="button" class="recurring-row-main" data-edit>
          <span class="recurring-row-name">
            <span class="truncate">${nameOf(t)}</span>
            ${t.paused ? html`<span class="status-tag paused">Paused</span>` : ''}
            ${overdue ? html`<span class="status-tag overdue" title="Due ${formatDate(t.nextDueDate)} and not logged or skipped yet">Overdue</span>` : ''}
            ${t.autoLog && !t.paused && !ended ? html`<span class="status-tag auto" title="Logged automatically on the due date">Auto</span>` : ''}
          </span>
          <span class="recurring-row-meta truncate">${meta}</span>
          ${progress(t)}
        </button>
        <div class="recurring-row-next">
          ${ended ? html`<span class="recurring-row-when">Finished</span>` : html`
            ${dateTile(t.nextDueDate, overdue ? 'overdue' : t.paused ? 'quiet' : '')}
            <span class="recurring-row-when"><span class="faint">${t.paused && t.nextDueDate < today() ? 'Was due' : overdue ? 'Due' : 'Next'}</span>${when(t.nextDueDate)}</span>`}
        </div>
        <div class="recurring-row-amounts">
          <span class="recurring-row-amount ${isTransfer ? '' : tone(t.amount)}">${money(t.amount, { signed: !isTransfer })}</span>
          <span class="recurring-row-monthly">≈ ${money(monthly)}/mo</span>
        </div>
        <div class="recurring-row-actions">
          ${ended ? '' : html`
            <button type="button" class="icon-btn" data-log title="${overdue ? `Log the payment due ${formatDate(t.nextDueDate)}` : 'Log the next one now'}" aria-label="Log ${nameOf(t)} now">${icon('plus')}</button>
            <button type="button" class="icon-btn" data-pause title="${t.paused ? 'Resume' : 'Pause'}" aria-label="${t.paused ? 'Resume' : 'Pause'} ${nameOf(t)}">${icon(t.paused ? 'play' : 'pause')}</button>`}
          <button type="button" class="icon-btn" data-edit title="Edit" aria-label="Edit ${nameOf(t)}">${icon('pencil')}</button>
        </div>
      </div>`;
  }

  function sectionHeader(title, iconName, n, subtotal, cls = '') {
    return html`
      <div class="panel-header">
        <h2 class="panel-title">${icon(iconName, { size: 17 })}${title} <span class="badge">${n}</span></h2>
        ${subtotal !== null ? html`<span class="tabular rec-section-total ${cls}">${money(Math.abs(subtotal))}<span class="faint">/mo</span></span>` : ''}
      </div>`;
  }

  const monthlyTotal = (items) => items.filter(t => !t.paused).reduce((s, t) => s + monthlyEquivalent(t.amount, t.frequency), 0);
  // Soonest first, with paused ones at the end
  const byNext = (a, b) => Number(!!a.paused) - Number(!!b.paused) || a.nextDueDate.localeCompare(b.nextDueDate);

  function renderSections() {
    const box = $('[data-sections]', root);
    if (!state.recurring.length) {
      render(box, html`<div class="empty">${icon('repeat')}<h3>No recurring payments yet</h3>
        <p>Add regular bills, salary and transfers to see what's coming and forecast your balance.</p>
        <button type="button" class="btn btn-primary" data-add>${icon('plus')}Add recurring payment</button></div>`);
      return;
    }
    const active = live().sort(byNext);
    const income = active.filter(t => t.type !== 'transfer' && t.amount >= 0);
    const spending = active.filter(t => t.type !== 'transfer' && t.amount < 0);
    const transfers = active.filter(t => t.type === 'transfer');
    const ended = state.recurring.filter(t => t.status === 'ended');

    const groups = new Map();
    for (const t of spending) {
      const cat = category(t.categoryId);
      if (!groups.has(cat.parentId)) groups.set(cat.parentId, { name: cat.parentName, emoji: cat.emoji, color: cat.color, items: [] });
      groups.get(cat.parentId).items.push(t);
    }
    const orderedGroups = [...groups.entries()].sort((a, b) => Math.abs(monthlyTotal(b[1].items)) - Math.abs(monthlyTotal(a[1].items)));
    const spendTotal = Math.abs(monthlyTotal(spending)) || 1;
    const collapsed = storage(COLLAPSED_KEY, {});

    render(box, html`
      ${income.length ? html`<section class="panel recurring-section">${sectionHeader('Income', 'wallet', income.length, monthlyTotal(income), 'positive')}<div class="rec-list">${income.map(row)}</div></section>` : ''}
      ${spending.length ? html`
        <section class="panel recurring-section">
          ${sectionHeader('Bills and spending', 'file', spending.length, monthlyTotal(spending), 'negative')}
          ${orderedGroups.map(([, g]) => {
            const total = Math.abs(monthlyTotal(g.items));
            return html`
              <div class="cat-group ${collapsed[g.name] ? 'collapsed' : ''}" data-cat="${g.name}" style="--cat:${g.color || '#94a3b8'}">
                <button type="button" class="cat-group-header" aria-expanded="${String(!collapsed[g.name])}">
                  <span class="chevron">${icon('chevronDown')}</span>
                  <span class="cat-group-emoji" aria-hidden="true">${g.emoji}</span>
                  <span class="cat-group-name">${g.name}</span>
                  <span class="badge">${g.items.length}</span>
                  <span class="cat-group-share" aria-hidden="true"><span class="bar-track thin"><span class="bar-fill" style="--w:${(total / spendTotal) * 100}%;--bar:${g.color || '#94a3b8'}"></span></span></span>
                  <span class="tabular negative cat-group-total">${money(total)}/mo</span>
                </button>
                <div class="cat-group-rows">${g.items.map(row)}</div>
              </div>`;
          })}
        </section>` : ''}
      ${transfers.length ? html`<section class="panel recurring-section">${sectionHeader('Transfers', 'transfer', transfers.length, null)}${transfers.some(isDebtPayment) ? html`<p class="panel-hint recurring-hint">Payments to cards, loans and mortgages count towards monthly outgoings.</p>` : ''}<div class="rec-list">${transfers.map(row)}</div></section>` : ''}
      ${ended.length ? html`
        <details class="panel recurring-section rec-finished">
          <summary class="panel-title">${icon('chevronRight', { size: 16 })}Finished <span class="badge">${ended.length}</span></summary>
          <div class="rec-list">${ended.map(row)}</div>
        </details>` : ''}
    `);
    box.classList.remove('grown');
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('grown')));
  }

  // ----- Suggestions -----

  async function loadSuggestions() {
    const box = $('[data-suggestions]', root);
    try {
      suggestions = await api.suggestions();
    } catch {
      suggestions = [];
    }
    if (!root?.isConnected) return;
    box.classList.toggle('hidden', !suggestions.length);
    if (!suggestions.length) {
      render(box, '');
      return;
    }
    render(box, html`
      <div class="panel-header">
        <div>
          <h2 class="panel-title">${icon('sparkles', { size: 17 })}Suggested for you <span class="badge primary">${suggestions.length}</span></h2>
          <p class="panel-hint">Regular payments spotted in your transactions. Set one up to see it coming.</p>
        </div>
      </div>
      <div class="suggestion-grid">
        ${suggestions.map((s, i) => {
          const cat = category(s.categoryId);
          return html`
            <article class="suggestion-card" data-suggestion="${i}" style="--i:${i}" aria-label="${s.payee}">
              <div class="suggestion-top">
                <span class="rec-avatar" style="--cat:${cat.color || '#94a3b8'}" aria-hidden="true">${cat.emoji || initial(s.payee)}</span>
                <span class="suggestion-who">
                  <span class="suggestion-payee truncate">${s.payee}</span>
                  <span class="suggestion-meta truncate">${s.accountName}${cat.name ? ` · ${cat.name}` : ''}</span>
                </span>
              </div>
              <div class="suggestion-figure">
                <span class="tabular suggestion-amount ${tone(s.amount)}">${money(s.amount, { signed: true })}</span>
                <span class="suggestion-freq">${frequencyLabel(s.frequency)}</span>
              </div>
              <p class="suggestion-facts">Seen ${plural(s.occurrences, 'time')} · next ${when(s.nextDueDate)}</p>
              <div class="suggestion-actions">
                <button type="button" class="btn btn-primary btn-sm" data-setup>${icon('plus', { size: 14 })}Set up</button>
                <button type="button" class="btn btn-ghost btn-sm" data-dismiss aria-label="Dismiss ${s.payee}">Dismiss</button>
              </div>
            </article>`;
        })}
      </div>
    `);
  }

  // ----- Row actions -----

  async function logNow(t, button) {
    // An overdue payment is logged on the day it was due; a future one is being paid early, today
    const due = t.nextDueDate;
    const date = due < today() ? due : today();
    await busy(button, async () => {
      try {
        // dueDate is the payment shown here; if another tab has logged or skipped it since, the
        // server says so (409) rather than logging the next one as well
        await api.approveRecurring(t.id, { date, dueDate: due });
        await changed();
        toast(`Logged ${nameOf(t)}${date !== today() ? ` for ${formatDate(date)}` : ''}`, { kind: 'success' });
      } catch (err) {
        if (err.status === 409) {
          toast(err.message, { kind: 'warning' });
          await changed().catch(() => {});
        } else {
          toastError(err);
        }
      }
    });
  }

  async function togglePause(t) {
    try {
      const saved = await api.updateRecurring(t.id, { paused: !t.paused });
      await changed();
      const logged = saved?.logged > 0 ? `. Logged ${plural(saved.logged, 'payment')} that ${saved.logged === 1 ? 'was' : 'were'} due` : '';
      toast(`${t.paused ? 'Resumed' : 'Paused'} ${nameOf(t)}${logged}`);
    } catch (err) {
      toastError(err);
    }
  }

  function renderSubtitle() {
    const active = live();
    const paused = active.filter(t => t.paused).length;
    const parts = [active.length ? plural(active.length - paused, 'active payment') : 'Regular income, bills and transfers'];
    if (paused) parts.push(`${paused} paused`);
    $('[data-subtitle]', root).textContent = parts.join(' · ');
  }

  function renderAll() {
    renderSubtitle();
    renderSummary();
    renderWaiting();
    if (working) $$('[data-waiting] button', root).forEach(b => { b.disabled = true; });
    const hasAny = state.recurring.length > 0;
    $('[data-calendar]', root).classList.toggle('hidden', !hasAny);
    $('[data-summary]', root).classList.toggle('hidden', !hasAny);
    if (hasAny) renderCalendar();
    renderSections();
  }

  return {
    async mount(container) {
      setTitle('Recurring');
      root = document.createElement('div');
      root.className = 'view-inner recurring-view';
      container.append(root);
      render(root, html`
        <header class="page-header">
          <div class="page-title">
            <div>
              <h1>Recurring</h1>
              <p class="page-subtitle" data-subtitle>Regular income, bills and transfers</p>
            </div>
          </div>
          <div class="page-actions">
            <button type="button" class="btn btn-primary" data-add title="Add recurring payment (N)">${icon('plus')}Add recurring</button>
          </div>
        </header>
        <div class="page-body">
          <section class="stat-grid rec-cards reveal" style="--i:0" data-summary aria-label="Summary"></section>
          <section class="panel waiting-panel reveal hidden" style="--i:1" data-waiting aria-labelledby="waiting-title"></section>
          <section class="panel cal-panel reveal" style="--i:2" data-calendar aria-labelledby="cal-heading">
            <div class="panel-header">
              <h2 class="panel-title" id="cal-heading">${icon('calendar', { size: 17 })}<span data-cal-title></span></h2>
              <div class="cal-nav">
                <button type="button" class="btn btn-ghost btn-sm hidden" data-cal-today>Today</button>
                <button type="button" class="icon-btn sm bordered" data-cal-step="-1" aria-label="Previous month">${icon('chevronLeft')}</button>
                <button type="button" class="icon-btn sm bordered" data-cal-step="1" aria-label="Next month">${icon('chevronRight')}</button>
              </div>
            </div>
            <div class="cal-layout">
              <div class="cal-main">
                <div class="cal-grid" data-cal-grid role="group" aria-label="Days of the month. Use the arrow keys to move between days."></div>
                <div class="cal-legend" aria-hidden="true">
                  <span><i class="cal-dot k-in"></i>Money in</span>
                  <span><i class="cal-dot k-out"></i>Money out</span>
                  <span><i class="cal-dot k-move"></i>Transfer</span>
                  <span><i class="cal-dot k-out s-overdue"></i>Waiting</span>
                  <span><i class="cal-dot k-out s-done"></i>Done</span>
                </div>
              </div>
              <aside class="cal-detail" data-cal-detail aria-live="polite"></aside>
            </div>
            <div class="cal-totals" data-cal-totals></div>
          </section>
          <div class="rec-sections reveal" style="--i:3" data-sections></div>
          <section class="panel suggestion-panel reveal hidden" style="--i:4" data-suggestions aria-label="Suggestions"></section>
          <div class="rec-footer"><button type="button" class="btn btn-ghost btn-sm" data-reset-dismissed>${icon('refresh')}Show suggestions I dismissed</button></div>
        </div>
      `);
      renderAll();

      const findEl = (el) => find(el.closest('[data-id]').dataset.id);
      cleanup.push(on(root, 'click', '[data-add]', () => openRecurringDialog()));
      cleanup.push(on(root, 'click', '[data-edit]', (event, el) => openRecurringDialog(findEl(el))));
      cleanup.push(on(root, 'click', '[data-log]', (event, el) => logNow(findEl(el), el)));
      cleanup.push(on(root, 'click', '[data-pause]', (event, el) => togglePause(findEl(el))));
      cleanup.push(on(root, 'click', '[data-log-due]', (event, el) => logOne(el)));
      cleanup.push(on(root, 'click', '[data-skip-due]', (event, el) => logOne(el, { skip: true })));
      cleanup.push(on(root, 'click', '[data-log-all]', (event, el) => logAllFor(el)));
      cleanup.push(on(root, 'click', '[data-log-everything]', (event, el) => logEverything(el)));
      cleanup.push(on(root, 'click', '[data-jump-waiting]', () => {
        const panel = $('[data-waiting]', root);
        panel.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
        $('button', panel)?.focus({ preventScroll: true });
      }));
      cleanup.push(on(root, 'click', '.cat-group-header', (event, el) => {
        const group = el.closest('[data-cat]');
        const collapsed = storage(COLLAPSED_KEY, {});
        collapsed[group.dataset.cat] = !group.classList.contains('collapsed');
        store(COLLAPSED_KEY, collapsed);
        group.classList.toggle('collapsed', collapsed[group.dataset.cat]);
        el.setAttribute('aria-expanded', String(!collapsed[group.dataset.cat]));
      }));

      // Calendar: choosing a day shows its payments beside the month; with a mouse, hovering
      // previews a day and leaving the grid goes back to the chosen one
      cleanup.push(on(root, 'click', '[data-day]', (event, el) => selectDay(el.dataset.day)));
      cleanup.push(on(root, 'click', '[data-cal-step]', (event, el) => moveMonth(Number(el.dataset.calStep))));
      cleanup.push(on(root, 'click', '[data-cal-today]', () => {
        calMonth = startOfMonth(today());
        selectedDay = today();
        renderCalendar({ animate: true });
      }));
      cleanup.push(on(root, 'pointerover', '[data-day]', (event, el) => {
        if (event.pointerType === 'mouse') renderDay(el.dataset.day);
      }));
      // pointerleave doesn't bubble, so it's caught on the way down and only the grid's own counts
      cleanup.push(on(root, 'pointerleave', '[data-cal-grid]', (event, el) => {
        if (event.target === el && event.pointerType === 'mouse') renderDay(selectedDay);
      }, true));
      cleanup.push(on(root, 'keydown', '[data-day]', (event, el) => {
        const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        let target = null;
        if (event.key in steps) target = addDays(el.dataset.day, steps[event.key]);
        else if (event.key === 'PageUp' || event.key === 'PageDown') target = addMonths(el.dataset.day, event.key === 'PageUp' ? -1 : 1);
        else if (event.key === 'Home') target = startOfMonth(el.dataset.day);
        else if (event.key === 'End') target = endOfMonth(el.dataset.day);
        if (!target) return;
        event.preventDefault();
        selectDay(target, { focus: true });
      }));

      cleanup.push(on(root, 'click', '[data-setup]', (event, el) => {
        const s = suggestions[Number(el.closest('[data-suggestion]').dataset.suggestion)];
        openRecurringDialog(null, { type: 'transaction', accountId: s.accountId, payee: s.payee, amount: s.amount, categoryId: s.categoryId, frequency: s.frequency, startDate: s.nextDueDate, anchorDay: s.anchorDay });
      }));
      cleanup.push(on(root, 'click', '[data-dismiss]', async (event, el) => {
        const card = el.closest('[data-suggestion]');
        const s = suggestions[Number(card.dataset.suggestion)];
        el.disabled = true;
        try {
          await api.dismissSuggestion(s.signature);
          card.classList.add('leaving');
          await wait(220);
          await loadSuggestions();
        } catch (err) {
          el.disabled = false;
          toastError(err);
        }
      }));
      cleanup.push(on(root, 'click', '[data-reset-dismissed]', async () => {
        const before = suggestions.length;
        try {
          await api.resetDismissed();
          await loadSuggestions();
          const back = suggestions.length - before;
          toast(back > 0 ? `Brought back ${plural(back, 'suggestion')}` : 'There are no dismissed suggestions to bring back');
        } catch (err) {
          toastError(err);
        }
      }));
      await loadSuggestions();
    },
    async refresh() {
      if (!root) return;
      renderAll();
      await loadSuggestions();
    },
    shortcut(key) {
      if (key === 'n') { openRecurringDialog(); return true; }
      return false;
    },
    destroy() {
      cleanup.forEach(fn => fn());
      cleanup = [];
    }
  };
}

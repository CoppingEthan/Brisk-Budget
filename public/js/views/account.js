import { html, render, on, $, $$, debounce } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { state, account as findAccount, category, changed, isLiability, accountTypeLabel, ASSET_VALUE_TYPES } from '../core/state.js';
import { money, tone, dayHeading, relativeDay, initial, accountBalanceView, plural, date as formatDate } from '../core/format.js';
import { navigate } from '../core/router.js';
import { setTitle } from '../shell/title.js';
import { accountAvatar, moveInSidebar } from '../shell/sidebar.js';
import { openMenu } from '../ui/menu.js';
import { confirmDialog } from '../ui/dialog.js';
import { toast, toastError } from '../ui/toast.js';
import { busy, categoryOptions } from '../ui/forms.js';
import { openTransactionDialog, openTransferDialog } from '../dialogs/transaction.js';
import { openAccountDialog } from '../dialogs/account.js';
import { openImportDialog } from '../dialogs/import.js';
import { openCategorizeDialog, openConvertDialog, undoChanges } from '../dialogs/bulk.js';
import { sparkline } from '../charts/sparkline.js';
import { countUp, reducedMotion } from '../ui/motion.js';
import { addDays, addMonths, endOfMonth, minDate, startOfMonth, today, toLocalDate } from '../shared/dates.js';
import { upcoming, frequencyLabel } from '../shared/recurrence.js';
import { round2 } from '../shared/money.js';

const PAGE = 150;
const MAX_PAGE = 1000; // the most rows the server sends in one go
const LONG_PRESS_MS = 500;
const GREEN = '#22c55e';
const RED = '#ef4444';
const ANIMATED_DAYS = 8; // on a fresh load the first few days rise into place, one after another

export function accountView(accountId) {
  let host = null; // the page's container, kept so a restored archived account can show itself
  let root = null;
  let items = [];
  let total = 0;
  let totals = { in: 0, out: 0 };
  let request = null; // the ledger request in flight: { controller, kind }
  let observer = null;
  let headerObserver = null;
  let viewObserver = null; // tucks the header's balance away while the big one is on screen
  let trend = null; // this account's balance over the last 90 days: [{ date, value }]
  let trendRequest = 0;
  let monthRequest = 0;
  let loaded = false; // the ledger has been shown once
  let heroDrawn = false; // the trend line draws itself in once, not after every save
  let press = null; // a touch long-press being timed
  let cleanup = [];
  const selectedIds = new Set();
  const filters = { q: '', categoryId: '', direction: '', from: '', to: '' };

  const account = () => findAccount(accountId);
  const filtersActive = () => Object.values(filters).some(Boolean);

  // ----- Header -----

  // What the account is worth or owes. For a loan or mortgage, the property's (or car's) value
  // less what is owed is the equity. For an investment or asset, the current value is what it is
  // worth, and the balance is just what has been paid in.
  function figures(a) {
    const view = accountBalanceView(a);
    const assetValue = ASSET_VALUE_TYPES.includes(a.type) && a.assetValue ? a.assetValue : null;
    const secured = a.type === 'mortgage' || a.type === 'loan';
    const valued = assetValue !== null && !secured;
    const equity = secured && assetValue !== null ? round2(assetValue + a.balance) : null;
    return { view, assetValue, secured, valued, equity };
  }

  // A compact title bar. Its balance pill only shows once the big figure below has scrolled
  // away (the header sticks to the top on wide screens), so the two never sit side by side.
  function renderHeader() {
    const a = account();
    const { view, assetValue, valued } = figures(a);
    const pill = (label, text, cls = '') => html`<span class="pill balance-pill" aria-hidden="true"><span class="pill-label">${label}</span><strong class="${cls}">${text}</strong></span>`;
    setTitle(a.name);
    render($('[data-header]', root), html`
      <div class="page-title">
        ${accountAvatar(a, 'lg')}
        <div class="account-heading">
          <h1>${a.name}</h1>
          <div class="account-pills">
            <span class="pill type-pill">${accountTypeLabel(a.type)}</span>
            ${valued ? pill('Value', money(assetValue)) : pill(view.label, view.text, view.tone)}
          </div>
        </div>
      </div>
      <div class="page-actions" data-actions>
        <button type="button" class="btn btn-primary" data-add title="Add transaction (N)">${icon('plus')}Add transaction</button>
        <button type="button" class="btn btn-secondary" data-transfer title="Transfer (T)">${icon('transfer')}<span class="transfer-label">Transfer</span></button>
        <button type="button" class="icon-btn bordered" data-more aria-label="More account options" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>
      </div>
    `);
  }

  // ----- Balance card -----

  // The trend as the big figure reads it: what is owed for a card or loan, the balance otherwise
  const shownTrend = (a) => (trend ? trend.map(p => (isLiability(a) ? -p.value : p.value)) : null);

  // How the figure has moved over the last 30 days. For debt, going down is good.
  function trendChange(a, values) {
    if (!values || values.length < 31) return null;
    const now = values[values.length - 1];
    const then = values[values.length - 31];
    const delta = round2(now - then);
    const pct = then !== 0 ? (delta / Math.abs(then)) * 100 : null;
    return { delta, pct, good: isLiability(a) ? delta < 0 : delta > 0 };
  }

  function renderHero() {
    const a = account();
    const box = $('[data-hero]', root);
    if (!a || !box) return;
    const { view, assetValue, secured, valued, equity } = figures(a);
    const values = shownTrend(a);
    const move = trendChange(a, values);
    const shown = $('[data-hero-value]', box)?.dataset.value ?? '';
    const main = valued
      ? { label: 'Current value', amount: assetValue, text: money(assetValue), cls: tone(assetValue) }
      : { label: view.label, amount: view.amount, text: view.text, cls: view.tone };
    const owes = isLiability(a) && view.label === 'Owed' && view.amount > 0.004;
    const lineColour = owes || (!isLiability(a) && main.amount < 0) ? RED : GREEN;

    const facts = [];
    if (secured) {
      if (assetValue !== null) {
        facts.push({ label: a.type === 'mortgage' ? 'Property value' : 'Value', text: money(assetValue) });
        facts.push({ label: 'Equity', text: money(equity), cls: tone(equity) });
      }
      if (a.interestRate) facts.push({ label: 'Interest rate', text: `${a.interestRate}%` });
    } else if (valued) {
      const gain = round2(assetValue - a.balance);
      const pct = a.balance > 0 ? ` (${((gain / a.balance) * 100).toFixed(1)}%)` : '';
      facts.push({ label: 'Paid in', text: money(a.balance) });
      facts.push({ label: gain < 0 ? 'Loss' : 'Growth', text: `${money(gain, { signed: true })}${pct}`, cls: tone(gain) });
    } else if (values && Math.max(...values) !== Math.min(...values)) {
      // For a card, the most and least owed (a card paid off past zero is "in credit")
      const owedText = (v) => (v < -0.004 ? `${money(-v)} in credit` : money(v));
      const liability = isLiability(a);
      facts.push({ label: liability ? 'Most owed' : '90-day high', text: liability ? owedText(Math.max(...values)) : money(Math.max(...values)) });
      facts.push({ label: liability ? 'Least owed' : '90-day low', text: liability ? owedText(Math.min(...values)) : money(Math.min(...values)) });
    }

    // For a loan or mortgage, how much of the property (or car) is yours so far
    const owned = secured && assetValue ? Math.min(1, Math.max(0, equity / assetValue)) : null;
    const changeText = move && (move.delta === 0
      ? 'No change'
      : html`${icon(move.delta > 0 ? 'chevronUp' : 'chevronDown', { size: 14 })}${money(Math.abs(move.delta))}${!valued && move.pct !== null && Math.abs(move.pct) >= 0.1 ? ` (${Math.abs(move.pct).toFixed(1)}%)` : ''}`);

    render(box, html`
      <div class="hero-main">
        <div class="hero-figure">
          <span class="stat-label">${icon(valued ? 'sparkles' : isLiability(a) ? 'database' : 'wallet', { size: 16 })}${main.label}</span>
          <span class="hero-value tabular ${main.cls}" data-hero-value data-value="${shown}">${main.text}</span>
          ${move ? html`
            <span class="stat-change ${move.delta === 0 || valued ? '' : move.good ? 'good' : 'bad'}">
              ${changeText}<span class="faint">${valued ? 'paid in over 30 days' : 'in 30 days'}</span>
            </span>` : ''}
        </div>
        ${facts.length ? html`
          <dl class="hero-facts">
            ${facts.map(f => html`<div class="hero-fact"><dt>${f.label}</dt><dd class="tabular ${f.cls || ''}">${f.text}</dd></div>`)}
          </dl>` : ''}
      </div>
      ${owned !== null ? html`
        <div class="hero-owned ${heroDrawn ? 'grown' : ''}">
          <div class="hero-owned-text"><span>You own <strong>${Math.round(owned * 100)}%</strong></span><span class="faint">${money(Math.max(0, equity))} of ${money(assetValue)}</span></div>
          <span class="bar-track" role="img" aria-label="You own ${Math.round(owned * 100)}% of it"><span class="bar-fill in" style="--w:${owned * 100}%"></span></span>
        </div>` : ''}
      ${values && values.length > 1 ? html`
        <div class="hero-trend ${heroDrawn ? 'still' : ''}">
          ${sparkline(values, { colour: lineColour, height: 88 })}
          <div class="hero-trend-axis" aria-hidden="true"><span>${formatDate(trend[0].date, 'short')}</span><span>Today</span></div>
        </div>` : ''}
    `);
    countUp($('[data-hero-value]', box), main.amount);
    if (!heroDrawn) {
      heroDrawn = true;
      // Let the browser lay out the empty bar first, so it grows into place
      const bar = $('.hero-owned', box);
      if (bar) requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('grown')));
    }
  }

  // Only the newest request's answer is drawn, however the replies arrive. Without a trend
  // (an error) the card still shows the balance.
  async function loadTrend() {
    const request = ++trendRequest;
    try {
      const data = await api.series({ accounts: accountId, range: '3m' });
      if (request !== trendRequest || !root?.isConnected) return;
      trend = data.history?.length ? data.history : null;
    } catch {
      if (request !== trendRequest || !root?.isConnected) return;
      trend = null;
    }
    renderHero();
  }

  // ----- This month -----

  const monthName = (iso) => toLocalDate(iso).toLocaleDateString('en-GB', { month: 'long' });
  const monthTotals = (from, to) => api.ledger(accountId, { from, to, limit: 1 });

  // Money in and out of this account so far this month, against the same days of last month.
  // When nothing has happened yet this month, last month is shown in full instead.
  async function loadMonth() {
    const request = ++monthRequest;
    const now = today();
    const start = startOfMonth(now);
    const lastStart = addMonths(start, -1);
    const stale = () => request !== monthRequest || !root?.isConnected;
    try {
      const [current, previous] = await Promise.all([
        monthTotals(start, now),
        monthTotals(lastStart, minDate(addMonths(now, -1), endOfMonth(lastStart)))
      ]);
      if (stale()) return;
      if (current.total) {
        renderMonth(current, previous, { title: `${monthName(now)} so far`, compareTo: `this point in ${monthName(lastStart)}`, from: start, to: now });
        return;
      }
      const beforeStart = addMonths(lastStart, -1);
      const [last, before] = await Promise.all([
        monthTotals(lastStart, endOfMonth(lastStart)),
        monthTotals(beforeStart, endOfMonth(beforeStart))
      ]);
      if (stale()) return;
      renderMonth(last, before, {
        title: last.total ? monthName(lastStart) : `${monthName(now)} so far`,
        compareTo: monthName(beforeStart),
        note: last.total ? `Nothing in or out yet in ${monthName(now)}, so this is ${monthName(lastStart)}.` : '',
        from: lastStart,
        to: endOfMonth(lastStart)
      });
    } catch (err) {
      if (!stale()) render($('[data-month-body]', root), html`<p class="muted">${err.message}</p>`);
    }
  }

  function renderMonth(current, previous, { title, compareTo, note = '', from, to }) {
    $('[data-month-title]', root).textContent = title;
    const body = $('[data-month-body]', root);
    body.classList.remove('grown');
    const moneyIn = current.totals.in;
    const out = Math.abs(current.totals.out);
    if (!current.total) {
      render(body, html`<p class="muted month-empty">Nothing in or out this month or last. Transactions you add or import show up here.</p>`);
      return;
    }
    const top = Math.max(moneyIn, out, 1);
    const net = round2(moneyIn - out);
    const outBefore = Math.abs(previous.totals.out);
    const diff = round2(out - outBefore);
    render(body, html`
      ${note ? html`<p class="month-note">${note}</p>` : ''}
      <div class="month-bars">
        <div class="month-bar">
          <span class="month-bar-label">Money in</span>
          <span class="month-bar-value positive tabular">${money(moneyIn)}</span>
          <span class="bar-track"><span class="bar-fill in" style="--w:${(moneyIn / top) * 100}%"></span></span>
        </div>
        <div class="month-bar">
          <span class="month-bar-label">Money out</span>
          <span class="month-bar-value negative tabular">${money(out)}</span>
          <span class="bar-track"><span class="bar-fill out" style="--w:${(out / top) * 100}%"></span></span>
        </div>
      </div>
      <div class="month-net ${net >= 0 ? 'good' : 'bad'}">
        ${net >= 0 ? html`<strong>${money(net)}</strong> more in than out` : html`<strong>${money(-net)}</strong> more out than in`}
      </div>
      ${outBefore > 0 || out > 0 ? html`
        <p class="month-compare">
          ${diff === 0 ? 'Money out is level with' : html`Money out is <strong class="${diff < 0 ? 'positive' : 'negative'}">${money(Math.abs(diff))} ${diff < 0 ? 'lower' : 'higher'}</strong> than`}
          ${compareTo}
        </p>` : ''}
      <div class="month-foot">
        <span class="faint">${plural(current.total, 'transaction')}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-show-month data-from="${from}" data-to="${to}">${icon('filter', { size: 14 })}Show in the list</button>
      </div>
    `);
    // Let the browser lay out the empty bars first, so they grow into place
    requestAnimationFrame(() => requestAnimationFrame(() => body.classList.add('grown')));
  }

  // ----- Upcoming recurring payments for this account -----
  function pendingFor() {
    const until = addDays(today(), 3);
    const out = [];
    for (const t of state.recurring) {
      if (t.paused || t.status === 'ended') continue;
      const applies = t.type === 'transfer' ? [t.fromAccountId, t.toAccountId].includes(accountId) : t.accountId === accountId;
      if (!applies) continue;
      upcoming(t, until, { limit: 6 }).forEach(({ date }, i) => out.push({ t, date, first: i === 0 }));
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  function dateTile(iso, overdue) {
    const d = toLocalDate(iso);
    return html`<span class="date-tile ${overdue ? 'overdue' : ''}" aria-hidden="true">
      <span class="date-tile-day">${d.getDate()}</span><span class="date-tile-month">${d.toLocaleDateString('en-GB', { month: 'short' })}</span>
    </span>`;
  }

  // A payment's next one can be logged (with its date and amount adjusted) or skipped; later
  // ones due soon wait their turn
  function upcomingItem({ t, date, first }, now) {
    const accountName = (id) => findAccount(id)?.name || 'a deleted account';
    const isTransfer = t.type === 'transfer';
    const outgoing = isTransfer ? t.fromAccountId === accountId : t.amount < 0;
    const name = isTransfer ? (outgoing ? `Transfer to ${accountName(t.toAccountId)}` : `Transfer from ${accountName(t.fromAccountId)}`) : t.payee;
    const amount = Math.abs(t.amount);
    const overdue = date < now;
    const when = overdue ? `Overdue · due ${relativeDay(date)}` : date === now ? 'Due today' : `Due ${relativeDay(date)}`;
    return html`
      <div class="upcoming-item ${first ? '' : 'later'} ${overdue ? 'overdue' : ''}" data-recurring="${t.id}" data-due="${t.nextDueDate}">
        ${dateTile(date, overdue)}
        <div class="upcoming-main">
          <div class="upcoming-name">${isTransfer ? icon('transfer', { size: 14 }) : ''}<span class="truncate">${name}</span></div>
          <div class="upcoming-when"><span class="${overdue ? 'warning-text' : ''}">${when}</span> · ${first ? frequencyLabel(t.frequency) : 'after the one above'}</div>
        </div>
        ${first ? html`
          <div class="upcoming-edit">
            <input class="input" type="date" value="${date}" aria-label="Date for ${name}" data-field="date">
            <div class="input-group">
              <span class="input-prefix ${outgoing ? 'negative' : 'positive'}">${outgoing ? '−' : '+'}${state.settings.currencySymbol}</span>
              <input class="input tabular" type="number" step="0.01" min="0" value="${amount.toFixed(2)}" aria-label="Amount for ${name}" data-field="amount">
            </div>
          </div>
          <div class="upcoming-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-approve aria-label="Log ${name}" title="Log it">${icon('check', { size: 14 })}Log</button>
            <button type="button" class="icon-btn bordered" data-skip aria-label="Skip ${name}" title="Skip this one">${icon('skip')}</button>
          </div>
        ` : html`<span class="tabular upcoming-later-amount ${outgoing ? 'negative' : 'positive'}">${money(outgoing ? -amount : amount)}</span>`}
      </div>`;
  }

  function renderUpcoming() {
    const box = $('[data-upcoming]', root);
    const list = pendingFor();
    box.classList.toggle('hidden', list.length === 0);
    if (!list.length) return;
    const now = today();
    const overdue = list.filter(p => p.date < now);
    const soon = list.filter(p => p.date >= now);
    const group = (title, items) => (items.length ? html`
      <div class="upcoming-group">
        <h3 class="upcoming-group-title">${title}</h3>
        ${items.map(p => upcomingItem(p, now))}
      </div>` : '');
    render(box, html`
      <div class="panel-header">
        <h2 class="panel-title" id="account-upcoming-title">${icon('calendar', { size: 17 })}Upcoming payments
          <span class="badge ${overdue.length ? 'warning' : ''}">${overdue.length ? `${overdue.length} overdue` : list.length}</span></h2>
        <a href="#/recurring" class="btn btn-ghost btn-sm">All recurring ${icon('chevronRight')}</a>
      </div>
      <div class="upcoming-items">
        ${group('Waiting to be logged', overdue)}
        ${group(overdue.length ? 'Due soon' : 'Due in the next few days', soon)}
      </div>
    `);
  }

  // ----- Ledger -----
  function renderToolbar() {
    render($('[data-toolbar]', root), html`
      <div class="input-icon search">
        ${icon('search')}
        <input class="input" type="search" name="q" placeholder="Search payee, notes, amount…" value="${filters.q}" aria-label="Search transactions (/)">
      </div>
      <select class="select" name="categoryId" aria-label="Filter by category">
        ${categoryOptions(state.categories, filters.categoryId, { includeTransfer: true, placeholder: 'All categories' })}
      </select>
      <div class="segmented" role="group" aria-label="Money in or out">
        <button type="button" data-direction="" aria-pressed="${String(filters.direction === '')}">All</button>
        <button type="button" data-direction="in" aria-pressed="${String(filters.direction === 'in')}">In</button>
        <button type="button" data-direction="out" aria-pressed="${String(filters.direction === 'out')}">Out</button>
      </div>
      <input class="input" type="date" name="from" value="${filters.from}" aria-label="From date" title="From">
      <input class="input" type="date" name="to" value="${filters.to}" aria-label="To date" title="To">
      <button type="button" class="btn btn-ghost btn-sm ${filtersActive() ? '' : 'hidden'}" data-clear-filters>${icon('x')}Clear</button>
    `);
  }

  function renderSummary() {
    const box = $('[data-summary]', root);
    if (!filtersActive()) {
      render(box, html`<span>${plural(total, 'transaction')}</span>`);
      return;
    }
    render(box, html`
      <span>${plural(total, 'match', 'matches')}</span>
      <span>In <strong class="positive">${money(totals.in)}</strong></span>
      <span>Out <strong class="negative">${money(Math.abs(totals.out))}</strong></span>
      <span>Net <strong class="${tone(totals.in + totals.out)}">${money(round2(totals.in + totals.out), { signed: true })}</strong></span>
    `);
  }

  // The balance after each row, the way the header shows it: a card or loan shows what is owed
  // (or "in credit"), not a negative number
  function runningBalance(a, tx) {
    if (!isLiability(a)) return html`<div class="tx-balance" title="Balance after this transaction">${money(tx.runningBalance)}</div>`;
    const view = accountBalanceView(a, tx.runningBalance);
    const credit = view.label === 'In credit';
    return html`<div class="tx-balance" title="${credit ? 'In credit' : 'Owed'} after this transaction">${view.text}${credit ? ' in credit' : ''}</div>`;
  }

  function txRow(tx) {
    const a = account();
    const cat = category(tx.categoryId);
    const selected = selectedIds.has(tx.id);
    const meta = [tx.description, tx.notes].filter(Boolean).join(' · ');
    // The payee is the row's button: Enter opens the editor (which can also delete), at any width.
    // The pencil does the same for the mouse, so it stays out of the Tab order.
    return html`
      <div class="tx-row ${tx.transferId ? 'transfer' : ''} ${selected ? 'selected' : ''}" data-tx="${tx.id}">
        <input type="checkbox" class="checkbox" data-select="${tx.id}" ${selected ? 'checked' : ''} aria-label="Select ${tx.payee}">
        <span class="avatar" style="--cat:${tx.transferId ? '#818cf8' : cat.color}" aria-hidden="true">${tx.transferId ? icon('transfer', { size: 16 }) : initial(tx.payee)}</span>
        <div class="tx-main">
          <button type="button" class="tx-payee" data-open aria-haspopup="dialog">${tx.payee}</button>
          ${meta || tx.autoInterest || tx.recurringId ? html`<div class="tx-meta">
            ${tx.autoInterest ? html`<span>${icon('bolt')} Added automatically</span>` : ''}
            ${tx.recurringId && !tx.autoInterest ? html`<span>${icon('repeat')}</span>` : ''}
            ${meta ? html`<span class="truncate">${meta}</span>` : ''}
          </div>` : ''}
        </div>
        <span class="cat-badge" style="--cat:${cat.color}" title="${cat.isSub ? `${cat.parentName} › ${cat.name}` : cat.name}">${cat.emoji} ${cat.name}</span>
        <div class="tx-amounts">
          <div class="tx-amount ${tone(tx.amount)}">${money(tx.amount)}</div>
          ${runningBalance(a, tx)}
        </div>
        <div class="tx-actions">
          <button type="button" class="icon-btn sm" data-edit="${tx.id}" tabindex="-1" aria-label="Edit ${tx.payee}">${icon('pencil')}</button>
          <button type="button" class="icon-btn sm danger" data-delete="${tx.id}" aria-label="Delete ${tx.payee}">${icon('trash')}</button>
        </div>
      </div>`;
  }

  // Rows to draw. While more pages are to come, the last day loaded may be cut short, so it
  // waits for the next page: each day's count, total and "select day" box then cover the whole
  // day. (A single day bigger than a page is drawn as it is.)
  function shownItems() {
    if (items.length >= total) return items;
    const lastDate = items[items.length - 1]?.date;
    const cut = items.findIndex(t => t.date === lastDate);
    return cut > 0 ? items.slice(0, cut) : items;
  }

  // `enter` is how a fresh list arrives: the first days 'rise' into place when the page opens,
  // and new search results 'fade' in. A refresh or a page added at the bottom just appears, so
  // rows already on screen never jump.
  function renderList({ enter = '' } = {}) {
    const list = $('[data-list]', root);
    list.dataset.enter = enter;
    if (!items.length) {
      observer?.disconnect();
      render(list, filtersActive()
        ? html`<div class="empty compact ledger-empty">${icon('search')}<h3>Nothing matches</h3><p>Try a different search, or clear the filters to see everything.</p>
            <button type="button" class="btn btn-secondary btn-sm" data-reset-filters>${icon('x')}Clear filters</button></div>`
        : html`<div class="empty ledger-empty"><span class="empty-badge">${icon('file')}</span><h3>No transactions yet</h3><p>Add one, or import a CSV file from your bank.</p>
            <div class="page-actions" style="justify-content:center"><button type="button" class="btn btn-primary" data-add>${icon('plus')}Add transaction</button><button type="button" class="btn btn-secondary" data-import>${icon('upload')}Import CSV</button></div></div>`);
      return;
    }
    const days = [];
    for (const tx of shownItems()) {
      const last = days[days.length - 1];
      if (last && last.date === tx.date) last.items.push(tx);
      else days.push({ date: tx.date, items: [tx] });
    }
    render(list, html`
      <div class="ledger-days">${days.map((day, i) => {
        const dayTotal = round2(day.items.reduce((s, t) => s + t.amount, 0));
        const allSelected = day.items.every(t => selectedIds.has(t.id));
        return html`
          <section class="day-group" data-day="${day.date}" style="--i:${Math.min(i, ANIMATED_DAYS)}">
            <div class="day-header">
              <div class="day-header-left">
                <input type="checkbox" class="checkbox" data-select-day="${day.date}" ${allSelected ? 'checked' : ''} aria-label="Select all on ${formatDate(day.date, 'long')}">
                <h3 class="day-date">${dayHeading(day.date)}</h3>
                <span class="day-count">${plural(day.items.length, 'transaction')}</span>
              </div>
              <span class="day-total ${tone(dayTotal)}">${money(dayTotal, { signed: true })}</span>
            </div>
            <div class="day-items">${day.items.map(txRow)}</div>
          </section>`;
      })}</div>
      <div class="ledger-more" data-more-sentinel>${items.length < total ? html`<span class="spinner"></span>` : html`<span>${total > 20 ? 'That’s everything' : ''}</span>`}</div>
    `);
    syncDayBoxes();
    watchSentinel();
  }

  function watchSentinel() {
    observer?.disconnect();
    const sentinel = $('[data-more-sentinel]', root);
    if (!sentinel || items.length >= total) return;
    observer = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) loadMore();
    }, { rootMargin: '600px' });
    observer.observe(sentinel);
  }

  function renderSelection() {
    const bar = $('[data-selection]', root);
    const count = selectedIds.size;
    const anchor = bar.classList.contains('hidden') === (count === 0) ? null : scrollAnchor();
    root.querySelector('.ledger')?.classList.toggle('selecting', count > 0);
    bar.classList.toggle('hidden', count === 0);
    if (count) {
      const chosen = items.filter(t => selectedIds.has(t.id));
      const hasNormal = chosen.some(t => !t.transferId);
      const hasTransfers = chosen.some(t => t.transferId);
      render(bar, html`
        <span class="count">${count} selected</span>
        <div class="actions">
          ${hasNormal ? html`<button type="button" class="btn" data-bulk="categorize">${icon('tag')}Categorise</button>` : ''}
          ${hasNormal ? html`<button type="button" class="btn" data-bulk="convert">${icon('link')}Make transfer</button>` : ''}
          ${hasTransfers ? html`<button type="button" class="btn" data-bulk="unlink">${icon('unlink')}Unlink transfer</button>` : ''}
          <button type="button" class="btn" data-bulk="delete">${icon('trash')}Delete</button>
          <button type="button" class="btn" data-bulk="clear">Clear</button>
        </div>
      `);
    }
    // The bar appearing or going above the rows mustn't push the row you tapped out of place
    restoreScroll(anchor);
  }

  function syncDayBoxes() {
    for (const box of $$('[data-select-day]', root)) {
      const dayItems = items.filter(t => t.date === box.dataset.selectDay);
      const count = dayItems.filter(t => selectedIds.has(t.id)).length;
      box.checked = count === dayItems.length;
      box.indeterminate = count > 0 && count < dayItems.length;
    }
  }

  function updateSelectionVisuals() {
    for (const row of $$('[data-tx]', root)) {
      const on_ = selectedIds.has(row.dataset.tx);
      row.classList.toggle('selected', on_);
      const box = row.querySelector('[data-select]');
      if (box) box.checked = on_;
    }
    syncDayBoxes();
    renderSelection();
  }

  function toggleSelected(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    updateSelectionVisuals();
  }

  // Re-drawing the list replaces every row, so note where the rows on screen are and put them
  // back afterwards: saving, deleting or logging deep in the ledger then doesn't move the page.
  function scrollAnchor() {
    if (!root || window.scrollY < 1) return null;
    const rows = $$('[data-tx]', root);
    const first = rows.findIndex(r => r.getBoundingClientRect().bottom > 0);
    if (first < 0) return null;
    return rows.slice(first, first + 40).map(r => ({ id: r.dataset.tx, top: r.getBoundingClientRect().top }));
  }

  function restoreScroll(anchor) {
    if (!anchor) return;
    for (const { id, top } of anchor) {
      const row = root.querySelector(`[data-tx="${CSS.escape(id)}"]`);
      if (!row) continue; // deleted: line up the next one instead
      const shift = row.getBoundingClientRect().top - top;
      if (Math.abs(shift) >= 1) window.scrollBy(0, shift);
      return;
    }
  }

  // Load the ledger. 'reset' starts again from the top (the filters changed), 'refresh' reloads
  // everything already loaded (the data changed) and 'more' adds the next page. A newer request
  // cancels an older one, but 'more' never cancels anything: it waits its turn.
  async function loadLedger(kind) {
    if (kind === 'more' && (request || items.length >= total)) return;
    if (kind === 'refresh' && request?.kind === 'reset') kind = 'reset'; // the loaded rows are for old filters
    request?.controller.abort();
    const mine = { controller: new AbortController(), kind };
    request = mine;
    const { signal } = mine.controller;
    try {
      let result;
      if (kind === 'more') {
        result = await api.ledger(accountId, { ...filters, offset: items.length, limit: PAGE }, { signal });
      } else {
        const wanted = kind === 'refresh' ? Math.max(PAGE, items.length) : PAGE;
        result = await api.ledger(accountId, { ...filters, offset: 0, limit: Math.min(wanted, MAX_PAGE) }, { signal });
        const rows = result.items;
        while (rows.length < wanted && rows.length < result.total) {
          const next = await api.ledger(accountId, { ...filters, offset: rows.length, limit: Math.min(wanted - rows.length, MAX_PAGE) }, { signal });
          if (!next.items.length) break;
          rows.push(...next.items);
          result = { ...next, items: rows };
        }
      }
      if (request !== mine) return;
      const anchor = kind === 'refresh' ? scrollAnchor() : null;
      if (kind === 'more') {
        const seen = new Set(items.map(t => t.id));
        items = [...items, ...result.items.filter(t => !seen.has(t.id))];
      } else {
        items = result.items;
        // Keep the selection, less any rows that have gone (or no longer match the filters)
        const present = new Set(items.map(t => t.id));
        for (const id of [...selectedIds]) if (!present.has(id)) selectedIds.delete(id);
      }
      total = result.total;
      totals = result.totals;
      renderSummary();
      renderList({ enter: kind !== 'reset' ? '' : loaded ? 'fade' : 'rise' });
      loaded = true;
      renderSelection();
      restoreScroll(anchor);
    } catch (err) {
      if (request !== mine || err.name === 'AbortError') return;
      if (err.status === 404) navigate('/', { replace: true });
      else toastError(err);
    } finally {
      if (request === mine) request = null;
    }
  }

  const loadMore = () => loadLedger('more');

  // ----- Actions -----
  async function deleteWithUndo(ids) {
    let result;
    try {
      result = ids.length === 1
        ? await api.deleteTransaction(accountId, ids[0])
        : await api.bulk(accountId, { action: 'delete', ids });
    } catch (err) {
      toastError(err);
      return;
    }
    for (const id of ids) selectedIds.delete(id);
    try {
      await changed();
    } catch (err) {
      toastError(err);
    }
    const count = ids.length;
    toast(`Deleted ${plural(count, 'transaction')}${result.removed.length > count ? ' (and the other side of the transfer)' : ''}`, {
      action: { label: 'Undo', run: () => undoChanges(result.undo) }
    });
  }

  async function runBulk(action, button) {
    const ids = [...selectedIds];
    if (action === 'clear') { selectedIds.clear(); updateSelectionVisuals(); return; }
    if (action === 'delete') return busy(button, () => deleteWithUndo(ids));
    const chosen = items.filter(t => selectedIds.has(t.id));
    if (action === 'categorize') {
      const ok = await openCategorizeDialog(accountId, chosen.filter(t => !t.transferId).map(t => t.id));
      if (ok) { selectedIds.clear(); await changed(); }
      return;
    }
    if (action === 'convert') {
      const ok = await openConvertDialog(accountId, chosen.filter(t => !t.transferId));
      if (ok) { selectedIds.clear(); await changed(); }
      return;
    }
    if (action === 'unlink') {
      const transfers = chosen.filter(t => t.transferId);
      const ok = await confirmDialog({
        title: 'Unlink transfers',
        message: `Turn ${plural(transfers.length, 'transfer')} back into normal transactions?`,
        detail: 'Where Brisk Budget created the other side, it is removed. Where two real transactions were linked, both are kept.',
        confirmLabel: 'Unlink',
        danger: false
      });
      if (!ok) return;
      let result;
      try {
        result = await api.bulk(accountId, { action: 'unlinkTransfer', ids: transfers.map(t => t.id) });
      } catch (err) {
        toastError(err);
        return;
      }
      selectedIds.clear();
      try {
        await changed();
      } catch (err) {
        toastError(err);
      }
      toast(`Unlinked ${plural(result.done, 'transfer')}`, {
        kind: 'success',
        action: result.undo?.length ? { label: 'Undo', run: () => undoChanges(result.undo) } : null
      });
    }
  }

  // Log or skip the next upcoming payment. Both buttons are off while either runs, so the same
  // payment can't be logged and skipped at once. The server checks the due date it was shown:
  // if it was logged or skipped elsewhere meanwhile, it says so and the panel catches up.
  async function settleUpcoming(itemEl, button, action) {
    if (!itemEl || itemEl.dataset.busy) return;
    const t = state.recurring.find(r => r.id === itemEl.dataset.recurring);
    if (!t) return;
    const dueDate = itemEl.dataset.due;
    let body = { dueDate };
    if (action === 'approve') {
      const date = itemEl.querySelector('[data-field="date"]').value;
      const amount = Math.abs(parseFloat(itemEl.querySelector('[data-field="amount"]').value));
      if (!date || !Number.isFinite(amount) || amount === 0) {
        toast('Enter a date and an amount first', { kind: 'warning' });
        return;
      }
      body = { date, amount: t.type === 'transfer' ? amount : (t.amount < 0 ? -amount : amount), dueDate };
    }
    const name = t.type === 'transfer' ? 'transfer' : t.payee;
    itemEl.dataset.busy = 'true';
    const others = $$('button', itemEl).filter(b => b !== button);
    others.forEach(b => { b.disabled = true; });
    try {
      await busy(button, async () => {
        let done = false;
        try {
          if (action === 'approve') await api.approveRecurring(t.id, body);
          else await api.skipRecurring(t.id, body);
          done = true;
        } catch (err) {
          toastError(err);
          if (err.status !== 409) return;
        }
        try {
          await changed();
        } catch (err) {
          toastError(err);
        }
        if (done) toast(action === 'approve' ? `Logged ${name}` : `Skipped ${name}`, { kind: action === 'approve' ? 'success' : 'info' });
      });
    } finally {
      delete itemEl.dataset.busy;
      others.forEach(b => { if (b.isConnected) b.disabled = false; });
    }
  }

  async function moveAccount(a, delta) {
    try {
      const moved = await moveInSidebar('account', a.id, delta);
      if (moved === false) toast(`"${a.name}" is already at the ${delta < 0 ? 'top' : 'bottom'}`);
    } catch (err) {
      toastError(err);
    }
  }

  function openMore(button) {
    const a = account();
    openMenu(button, [
      { label: 'Import CSV', icon: 'upload', run: () => openImportDialog(a) },
      { label: 'Edit account', icon: 'pencil', run: () => openAccountDialog(a) },
      // Reordering without dragging, for touch screens and keyboards
      { label: 'Move up in the sidebar', icon: 'chevronUp', run: () => moveAccount(a, -1) },
      { label: 'Move down in the sidebar', icon: 'chevronDown', run: () => moveAccount(a, 1) },
      'separator',
      {
        label: 'Archive account',
        icon: 'archive',
        danger: true,
        run: async () => {
          const ok = await confirmDialog({
            title: 'Archive account',
            message: `Archive "${a.name}"?`,
            detail: 'It disappears from the sidebar and charts, but every transaction is kept. Its recurring payments are paused. You can restore it any time from Settings › Accounts.',
            confirmLabel: 'Archive'
          });
          if (!ok) return;
          try {
            await api.archiveAccount(a.id);
            navigate('/');
            await changed();
            toast(`Archived "${a.name}"`, {
              action: { label: 'Undo', run: async () => { await api.restoreAccount(a.id); await changed(); navigate(`/accounts/${a.id}`); } }
            });
          } catch (err) {
            toastError(err);
          }
        }
      }
    ]);
  }

  function openRow(id) {
    const tx = items.find(t => t.id === id);
    if (tx) openTransactionDialog({ accountId, transaction: tx });
  }

  function cancelPress() {
    if (!press) return;
    clearTimeout(press.timer);
    if (!press.fired) press = null;
  }

  function bindEvents() {
    cleanup.push(on(root, 'click', '[data-add]', () => openTransactionDialog({ accountId })));
    cleanup.push(on(root, 'click', '[data-transfer]', () => openTransferDialog({ fromAccountId: accountId })));
    cleanup.push(on(root, 'click', '[data-import]', () => openImportDialog(account())));
    cleanup.push(on(root, 'click', '[data-more]', (event, el) => openMore(el)));
    cleanup.push(on(root, 'click', '[data-approve]', (event, el) => settleUpcoming(el.closest('[data-recurring]'), el, 'approve')));
    cleanup.push(on(root, 'click', '[data-skip]', (event, el) => settleUpcoming(el.closest('[data-recurring]'), el, 'skip')));
    cleanup.push(on(root, 'click', '[data-bulk]', (event, el) => runBulk(el.dataset.bulk, el)));
    cleanup.push(on(root, 'click', '[data-edit]', (event, el) => {
      event.stopPropagation();
      openRow(el.dataset.edit);
    }));
    cleanup.push(on(root, 'click', '[data-delete]', (event, el) => {
      event.stopPropagation();
      busy(el, () => deleteWithUndo([el.dataset.delete]));
    }));
    cleanup.push(on(root, 'change', '[data-select]', (event, el) => {
      if (el.checked) selectedIds.add(el.dataset.select);
      else selectedIds.delete(el.dataset.select);
      updateSelectionVisuals();
    }));
    cleanup.push(on(root, 'change', '[data-select-day]', (event, el) => {
      for (const t of items.filter(x => x.date === el.dataset.selectDay)) {
        if (el.checked) selectedIds.add(t.id);
        else selectedIds.delete(t.id);
      }
      updateSelectionVisuals();
    }));
    // A click opens the editor, or ticks the row while selecting. Enter on the payee always
    // opens the editor (the keyboard has the tick boxes for selecting).
    cleanup.push(on(root, 'click', '[data-tx]', (event, row) => {
      const keyboard = event.detail === 0;
      // The end of a long-press, which has already selected the row
      if (press?.fired && !keyboard) { press = null; return; }
      if (event.target.closest('button:not([data-open]), input, a')) return;
      const id = row.dataset.tx;
      if (selectedIds.size > 0 && !keyboard) toggleSelected(id);
      else openRow(id);
    }));

    // Long-press on a touch screen starts selecting. iOS never fires contextmenu for a long
    // press, so it is timed here; moving or scrolling cancels it.
    cleanup.push(on(root, 'pointerdown', '[data-tx]', (event, row) => {
      press = null;
      if (event.pointerType === 'mouse' || event.target.closest('input, button:not([data-open])')) return;
      const mine = { x: event.clientX, y: event.clientY, fired: false };
      mine.timer = setTimeout(() => {
        mine.fired = true;
        toggleSelected(row.dataset.tx);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
      press = mine;
    }));
    cleanup.push(on(root, 'pointermove', '[data-tx]', (event) => {
      if (press && !press.fired && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress();
    }));
    cleanup.push(on(root, 'pointerup', '[data-tx]', () => { if (press) clearTimeout(press.timer); }));
    cleanup.push(on(root, 'pointercancel', '[data-tx]', cancelPress));
    window.addEventListener('scroll', cancelPress, { passive: true });
    cleanup.push(() => window.removeEventListener('scroll', cancelPress));
    // Android fires contextmenu on a long press too: use whichever comes first, and keep the
    // browser's own menu away. A mouse right-click keeps the browser menu.
    cleanup.push(on(root, 'contextmenu', '[data-tx]', (event, row) => {
      if (!press && !matchMedia('(hover: none)').matches) return;
      event.preventDefault();
      if (press && !press.fired) {
        clearTimeout(press.timer);
        press.fired = true;
        toggleSelected(row.dataset.tx);
      }
    }));

    const search = debounce(() => loadLedger('reset'), 250);
    cleanup.push(on(root, 'input', '[name="q"]', (event, el) => { filters.q = el.value.trim(); renderClear(); search(); }));
    cleanup.push(on(root, 'change', '[data-toolbar] [name="categoryId"], [data-toolbar] [name="from"], [data-toolbar] [name="to"]', (event, el) => {
      filters[el.name] = el.value;
      renderClear();
      loadLedger('reset');
    }));
    cleanup.push(on(root, 'click', '[data-toolbar] [data-direction]', (event, el) => {
      filters.direction = el.dataset.direction;
      $$('[data-toolbar] [data-direction]', root).forEach(b => b.setAttribute('aria-pressed', String(b === el)));
      renderClear();
      loadLedger('reset');
    }));
    cleanup.push(on(root, 'click', '[data-clear-filters], [data-reset-filters]', () => {
      Object.keys(filters).forEach(k => { filters[k] = ''; });
      renderToolbar();
      loadLedger('reset');
    }));

    // The selection bar sticks just below the page header, whose height changes as it wraps
    const header = $('[data-header]', root);
    headerObserver = new ResizeObserver(() => root.style.setProperty('--page-header-height', `${header.offsetHeight}px`));
    headerObserver.observe(header);

    // The header's balance pill shows once the big figure has mostly scrolled away. On phones,
    // where the header scrolls off, a round Add button keeps adding a transaction one tap away.
    const hero = $('[data-hero]', root);
    const fab = $('[data-fab]', root);
    viewObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === hero) header.classList.toggle('hero-in-view', entry.isIntersecting && entry.intersectionRatio >= 0.3);
        else fab.classList.toggle('show', !entry.isIntersecting);
      }
    }, { threshold: [0, 0.3] });
    viewObserver.observe(hero);
    viewObserver.observe(header);

    // "Show in the list" on This month: filter the ledger to that month and scroll to it
    cleanup.push(on(root, 'click', '[data-show-month]', (event, el) => {
      filters.from = el.dataset.from;
      filters.to = el.dataset.to;
      renderToolbar();
      loadLedger('reset');
      $('.ledger', root).scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }));
  }

  function renderClear() {
    $('[data-clear-filters]', root)?.classList.toggle('hidden', !filtersActive());
  }

  return {
    async mount(container) {
      host = container;
      const a = account();
      if (!a) {
        navigate('/', { replace: true });
        return;
      }
      if (a.active === false) {
        setTitle(a.name);
        render(container, html`<div class="page-body"><div class="empty">${icon('archive')}<h3>This account is archived</h3>
          <p>Restore it from Settings › Accounts to see it again.</p></div></div>`);
        return;
      }
      container.replaceChildren(); // the archived message, when an account is restored
      root = document.createElement('div');
      root.className = 'view-inner account-view';
      container.append(root);
      trend = null;
      loaded = false;
      heroDrawn = false;
      render(root, html`
        <header class="page-header account-header hero-in-view" data-header></header>
        <div class="page-body">
          <div class="account-top">
            <section class="panel account-hero reveal" style="--i:0" data-hero aria-label="Balance">
              <div class="hero-main"><div class="hero-figure">
                <span class="skeleton" style="height:14px;width:90px"></span>
                <span class="skeleton" style="height:42px;width:min(240px, 70%)"></span>
              </div></div>
              <div class="skeleton" style="height:88px;margin-top:var(--space-5)"></div>
            </section>
            <section class="panel account-month reveal" style="--i:1" aria-labelledby="account-month-title">
              <div class="panel-header">
                <h2 class="panel-title" id="account-month-title">${icon('activity', { size: 17 })}<span data-month-title>This month</span></h2>
              </div>
              <div class="month-body" data-month-body><div class="skeleton" style="height:140px"></div></div>
            </section>
          </div>
          <section class="panel account-upcoming reveal hidden" style="--i:2" data-upcoming aria-labelledby="account-upcoming-title"></section>
          <section class="ledger reveal" style="--i:3" aria-labelledby="ledger-title">
            <div class="ledger-bar">
              <div class="ledger-head">
                <h2 class="panel-title" id="ledger-title">${icon('file', { size: 17 })}Transactions</h2>
                <div class="ledger-summary" data-summary></div>
              </div>
              <div class="ledger-toolbar" data-toolbar></div>
            </div>
            <div class="selection-bar hidden" data-selection role="region" aria-label="Selected transactions"></div>
            <div class="ledger-list" data-list>
              ${[1, 2, 3].map(() => html`<div class="skeleton" style="height:120px"></div>`)}
            </div>
          </section>
        </div>
        <button type="button" class="account-fab" data-add data-fab aria-label="Add transaction" title="Add transaction (N)">${icon('plus', { size: 22 })}</button>
      `);
      renderHeader();
      renderUpcoming();
      renderToolbar();
      bindEvents();
      await Promise.all([loadLedger('reset'), loadTrend(), loadMonth()]);
    },
    async refresh() {
      if (!host) return;
      const a = account();
      if (!a) {
        navigate('/', { replace: true });
        return;
      }
      if (!root) {
        // Showing "this account is archived": come back to life if it has been restored
        if (a.active !== false) await this.mount(host);
        else setTitle(a.name);
        return;
      }
      if (a.active === false) {
        navigate('/', { replace: true });
        return;
      }
      const anchor = scrollAnchor();
      renderHeader();
      renderUpcoming();
      restoreScroll(anchor);
      await Promise.all([loadLedger('refresh'), loadTrend(), loadMonth()]);
    },
    shortcut(key) {
      if (!root) return false;
      if (key === 'n') { openTransactionDialog({ accountId }); return true; }
      if (key === 't') { openTransferDialog({ fromAccountId: accountId }); return true; }
      if (key === '/') { $('[name="q"]', root)?.focus(); return true; }
      if (key === 'Escape' && selectedIds.size) { selectedIds.clear(); updateSelectionVisuals(); return true; }
      return false;
    },
    destroy() {
      request?.controller.abort();
      request = null;
      observer?.disconnect();
      headerObserver?.disconnect();
      viewObserver?.disconnect();
      trendRequest++;
      monthRequest++;
      if (press) clearTimeout(press.timer);
      cleanup.forEach(fn => fn());
      cleanup = [];
      host = null;
    }
  };
}

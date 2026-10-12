import { badRequest, conflict, notFound } from '../lib/errors.js';
import { has, requireObject, str, money, num, date as dateField, oneOf, id as idField, bool } from '../lib/validate.js';
import { newId } from '../lib/ids.js';
import { addDays, dayOfMonth, daysInMonth, maxDate, minDate, parts } from '../../public/js/shared/dates.js';
import {
  FREQUENCY_TYPES, firstOnOrAfter, isEnded, monthlyEquivalent, nextDate, normaliseFrequency, occurrenceAllowed, statusOf
} from '../../public/js/shared/recurrence.js';
import { round2 } from '../../public/js/shared/money.js';
import { TRANSFER_CATEGORY_ID, UNCATEGORIZED_ID } from '../store/defaults.js';

export function createRecurring(app) {
  const { store, clock } = app;
  const svc = () => app.services;
  const templates = () => store.data.recurring;

  function serialize(t) {
    const amount = t.type === 'transfer' ? Math.abs(t.amount) : t.amount;
    const cat = svc().categories.info(t.categoryId);
    return {
      ...t,
      amount,
      category: cat.name,
      categoryEmoji: cat.emoji,
      categoryColor: cat.color,
      categoryParentId: cat.parentId,
      status: statusOf(t),
      monthlyAmount: round2(monthlyEquivalent(amount, t.frequency))
    };
  }

  function list() {
    return templates().filter(t => t.active !== false).map(serialize);
  }

  function find(id) {
    const t = templates().find(x => x.id === id && x.active !== false);
    if (!t) throw notFound('Recurring payment not found');
    return t;
  }

  function anchorFor(t) {
    const { type } = normaliseFrequency(t.frequency);
    return type === 'months' || type === 'years' ? dayOfMonth(t.startDate) : null;
  }

  // A schedule that starts on the last day of a short month can still mean "the 31st"
  function requestedAnchor(body, t) {
    if (!has(body, 'anchorDay') || body.anchorDay === null || t.anchorDay === null) return t.anchorDay;
    const day = num(body.anchorDay, 'Day of the month', { min: 1, max: 31, integer: true });
    const start = dayOfMonth(t.startDate);
    const { year, month } = parts(t.startDate);
    if (day === start || (day > start && start === daysInMonth(year, month))) return day;
    throw badRequest("The day of the month doesn't match the first payment date");
  }

  const PERIOD_DAYS = { days: 1, weeks: 7, months: 30, years: 365 };
  const periodDays = (frequency) => {
    const { type, interval } = normaliseFrequency(frequency);
    return PERIOD_DAYS[type] * interval;
  };

  // Latest date this schedule has already put in the ledger
  function lastPosted(t) {
    let last = null;
    for (const accountId of [t.accountId, t.fromAccountId].filter(Boolean)) {
      for (const tx of store.data.transactions[accountId] || []) {
        if (tx.recurringId === t.id && (!last || tx.date > last)) last = tx.date;
      }
    }
    return last;
  }

  // Where the next payment lands when the start date or frequency changes: the first one on the
  // new schedule from whichever is earlier, the old next date or today, and never on or before a
  // payment already logged. When only the day moves, the payment due on the old next date counts
  // as this period's, so moving a payday by a few days neither adds a payment nor loses one.
  function rescheduled(t, draft, before) {
    const today = clock.today();
    let target = minDate(before.next, today);
    const sameFrequency = JSON.stringify(draft.frequency) === before.frequency;
    if (sameFrequency && before.next > today) target = maxDate(today, addDays(before.next, -Math.floor(periodDays(before.frequencyValue) / 2)));
    const last = lastPosted(t);
    if (last && last >= target) target = addDays(last, 1);
    return firstOnOrAfter(draft, target);
  }

  // A paused payment didn't happen while it was paused: resuming starts from today rather than
  // asking for (or automatically logging) every payment that fell in between
  function skipMissed(t) {
    const today = clock.today();
    let guard = 0;
    while (t.nextDueDate < today && occurrenceAllowed(t, t.nextDueDate, 0) && guard++ < 5000) advance(t);
  }

  function readFields(body, t, { partial }) {
    if (!partial || has(body, 'type')) t.type = oneOf(body.type, 'Type', ['transaction', 'transfer'], { fallback: 'transaction' });
    if (t.type === 'transfer') {
      if (!partial || has(body, 'fromAccountId')) t.fromAccountId = idField(body.fromAccountId, 'From account', { required: true });
      if (!partial || has(body, 'toAccountId')) t.toAccountId = idField(body.toAccountId, 'To account', { required: true });
      if (t.fromAccountId === t.toAccountId) throw badRequest("You can't transfer to the same account");
      svc().accounts.get(t.fromAccountId);
      svc().accounts.get(t.toAccountId);
      t.accountId = null;
      t.payee = '';
      t.categoryId = TRANSFER_CATEGORY_ID;
      if (!partial || has(body, 'amount')) {
        t.amount = Math.abs(money(body.amount, 'Amount', { required: true }));
        if (!t.amount) throw badRequest('Amount must be more than zero');
      }
    } else {
      if (!partial || has(body, 'accountId')) t.accountId = idField(body.accountId, 'Account', { required: true });
      svc().accounts.get(t.accountId);
      t.fromAccountId = null;
      t.toAccountId = null;
      if (!partial || has(body, 'payee')) t.payee = str(body.payee, 'Payee', { required: true, max: 200 });
      if (!partial || has(body, 'amount')) {
        t.amount = money(body.amount, 'Amount', { required: true });
        if (!t.amount) throw badRequest('Amount must not be zero');
      }
      if (has(body, 'categoryId') || has(body, 'category')) t.categoryId = svc().categories.pick(body) || UNCATEGORIZED_ID;
      else if (!t.categoryId || t.categoryId === TRANSFER_CATEGORY_ID) t.categoryId = UNCATEGORIZED_ID;
    }
    if (!partial || has(body, 'frequency')) {
      const f = body.frequency || {};
      t.frequency = {
        type: oneOf(f.type, 'Frequency', FREQUENCY_TYPES, { fallback: 'months' }),
        interval: num(f.interval, 'Frequency interval', { min: 1, max: 1000, integer: true, fallback: 1 })
      };
    }
    if (!partial || has(body, 'startDate')) t.startDate = dateField(body.startDate, 'Start date', { required: true });
    if (!partial || has(body, 'endCondition')) {
      const end = body.endCondition || { type: 'never' };
      const type = oneOf(end.type, 'End condition', ['never', 'after_occurrences', 'on_date'], { fallback: 'never' });
      if (type === 'after_occurrences') t.endCondition = { type, value: num(end.value, 'Number of payments', { required: true, min: 1, max: 10000, integer: true }) };
      else if (type === 'on_date') t.endCondition = { type, value: dateField(end.value, 'End date', { required: true }) };
      else t.endCondition = { type: 'never', value: null };
    }
    if (!partial || has(body, 'description')) t.description = str(body.description, 'Description', { max: 500 });
    if (!partial || has(body, 'notes')) t.notes = str(body.notes, 'Notes', { max: 2000 });
    if (has(body, 'paused')) t.paused = bool(body.paused, 'paused');
    if (has(body, 'autoLog')) t.autoLog = bool(body.autoLog, 'autoLog');
  }

  function create(body) {
    requireObject(body);
    const t = {
      id: newId(),
      type: 'transaction',
      accountId: null,
      fromAccountId: null,
      toAccountId: null,
      payee: '',
      amount: 0,
      categoryId: UNCATEGORIZED_ID,
      description: '',
      notes: '',
      frequency: { type: 'months', interval: 1 },
      startDate: clock.today(),
      nextDueDate: clock.today(),
      anchorDay: null,
      endCondition: { type: 'never', value: null },
      occurrencesCompleted: 0,
      active: true,
      paused: false,
      autoLog: false,
      createdAt: clock.now().toISOString()
    };
    readFields(body, t, { partial: false });
    t.nextDueDate = t.startDate;
    t.anchorDay = anchorFor(t);
    t.anchorDay = requestedAnchor(body, t);
    if (t.paused) t.pausedAt = clock.today();
    templates().push(t);
    store.save('recurring');
    if (t.type !== 'transfer' && svc().payees.ensure(t.payee, { save: false })) store.save('payees');
    const logged = t.autoLog ? runAutoLog() : 0;
    return { ...serialize(t), logged };
  }

  function update(id, body) {
    requireObject(body);
    const t = find(id);
    const before = { startDate: t.startDate, frequency: JSON.stringify(t.frequency), frequencyValue: t.frequency, next: t.nextDueDate, paused: !!t.paused };
    // Validate on a deep copy, so a rejected edit changes nothing
    const draft = structuredClone(t);
    readFields(body, draft, { partial: true });
    // A new start date or frequency moves the schedule: the next payment becomes the first one
    // on the new schedule from whichever is earlier, the old next date or today.
    const scheduleChanged = draft.startDate !== before.startDate || JSON.stringify(draft.frequency) !== before.frequency;
    if (scheduleChanged) {
      draft.anchorDay = anchorFor(draft);
      draft.anchorDay = requestedAnchor(body, draft);
      draft.nextDueDate = rescheduled(t, draft, before);
      delete draft.scheduledDate;
    }
    if (has(body, 'nextDueDate')) {
      const moved = dateField(body.nextDueDate, 'Next due date', { required: true });
      // Moving one payment (paid late or early) keeps the schedule: remember where it should
      // have been, so the payment after it still lands on its usual day
      if (!scheduleChanged && moved !== draft.nextDueDate) {
        const onSchedule = draft.scheduledDate || draft.nextDueDate;
        if (moved === onSchedule) delete draft.scheduledDate;
        else draft.scheduledDate = onSchedule;
      }
      draft.nextDueDate = moved;
    }
    if (draft.paused && !before.paused) draft.pausedAt = clock.today();
    if (!draft.paused && before.paused) {
      delete draft.pausedByArchive;
      delete draft.pausedAt;
      skipMissed(draft);
    }
    for (const key of Object.keys(t)) if (!(key in draft)) delete t[key];
    Object.assign(t, draft);
    store.save('recurring');
    if (t.type !== 'transfer' && svc().payees.ensure(t.payee, { save: false })) store.save('payees');
    const logged = t.autoLog ? runAutoLog() : 0;
    return { ...serialize(t), logged };
  }

  // Called when restoring an archived account resumes this payment
  function resume(t) {
    t.paused = false;
    delete t.pausedByArchive;
    delete t.pausedAt;
    skipMissed(t);
  }

  function remove(id) {
    const t = find(id);
    t.active = false;
    store.save('recurring');
    return { success: true };
  }

  function restore(id) {
    const t = templates().find(x => x.id === id);
    if (!t) throw notFound('Recurring payment not found');
    t.active = true;
    store.save('recurring');
    return serialize(t);
  }

  // Post one occurrence as real transaction(s). `date`/`amount` let the person adjust it.
  function post(t, { date, amount }) {
    const tx = svc().transactions;
    if (t.type === 'transfer') {
      return tx.createTransfer({
        fromAccountId: t.fromAccountId, toAccountId: t.toAccountId, amount: Math.abs(amount), date,
        description: t.description, notes: t.notes
      }, { recurringId: t.id });
    }
    svc().accounts.getActive(t.accountId);
    const created = tx.newTransaction({
      date,
      amount,
      payee: t.payee,
      categoryId: svc().categories.exists(t.categoryId) ? t.categoryId : UNCATEGORIZED_ID,
      description: t.description,
      notes: t.notes,
      recurringId: t.id
    });
    tx.listFor(t.accountId).push(created);
    store.saveTransactions(t.accountId);
    return tx.serialize(created, t.accountId);
  }

  // Step to the next payment. A payment moved by hand steps from where it should have been,
  // never landing on or before the date it was moved to.
  function advance(t) {
    let next = nextDate(t, t.scheduledDate || t.nextDueDate);
    let guard = 0;
    while (next <= t.nextDueDate && guard++ < 1000) next = nextDate(t, next);
    t.nextDueDate = next;
    delete t.scheduledDate;
  }

  // The app sends the due date it was showing: if that's no longer the next one, this payment
  // was already logged or skipped somewhere else (another tab, another device)
  function checkStillDue(t, body) {
    if (has(body, 'dueDate') && body.dueDate && body.dueDate !== t.nextDueDate) {
      throw conflict('This payment has already been logged or skipped, perhaps in another window.');
    }
  }

  function approve(id, body = {}) {
    requireObject(body);
    const t = find(id);
    if (isEnded(t)) throw conflict('This recurring payment has finished');
    checkStillDue(t, body);
    const date = has(body, 'date') && body.date ? dateField(body.date, 'Date', { required: true }) : t.nextDueDate;
    const amount = has(body, 'amount') && body.amount !== null && body.amount !== ''
      ? money(body.amount, 'Amount', { required: true })
      : (t.type === 'transfer' ? Math.abs(t.amount) : t.amount);
    if (!amount) throw badRequest('Amount must not be zero');
    const created = post(t, { date, amount });
    t.occurrencesCompleted = (t.occurrencesCompleted || 0) + 1;
    advance(t);
    store.save('recurring');
    return { success: true, nextDueDate: t.nextDueDate, status: statusOf(t), created };
  }

  function skip(id, body = {}) {
    requireObject(body);
    const t = find(id);
    if (isEnded(t)) throw conflict('This recurring payment has finished');
    checkStillDue(t, body);
    advance(t);
    store.save('recurring');
    return { success: true, nextDueDate: t.nextDueDate, status: statusOf(t) };
  }

  // Log every due occurrence of templates set to log automatically. Returns how many.
  function runAutoLog() {
    const today = clock.today();
    let logged = 0;
    for (const t of templates()) {
      if (t.active === false || t.paused || !t.autoLog) continue;
      let guard = 0;
      while (t.nextDueDate <= today && occurrenceAllowed(t, t.nextDueDate, 0) && guard++ < 400) {
        try {
          post(t, { date: t.nextDueDate, amount: t.type === 'transfer' ? Math.abs(t.amount) : t.amount });
        } catch (err) {
          app.log.warn(`Couldn't auto-log recurring "${t.payee || t.id}": ${err.message}`);
          break;
        }
        t.occurrencesCompleted = (t.occurrencesCompleted || 0) + 1;
        advance(t);
        logged++;
      }
    }
    if (logged) store.save('recurring');
    return logged;
  }

  return { list, find, serialize, create, update, resume, remove, restore, approve, skip, runAutoLog };
}

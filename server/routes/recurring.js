const { accountsFile, recurringFile, dismissedFile, getTransactionsFile } = require('../config/paths');
const { readJSON, writeJSON, generateId, parseBody, sendJSON } = require('../utils/helpers');

function calculateNextDueDate(template) {
  const current = new Date(template.nextDueDate);
  const { type, interval } = template.frequency;

  switch (type) {
    case 'days':
      current.setDate(current.getDate() + interval);
      break;
    case 'weeks':
      current.setDate(current.getDate() + (interval * 7));
      break;
    case 'months':
      current.setMonth(current.getMonth() + interval);
      break;
    case 'years':
      current.setFullYear(current.getFullYear() + interval);
      break;
  }
  return current.toISOString().split('T')[0];
}

// --- Suggestion detection helpers (Phase 2) ---

const normalisePayee = (name) => (name || '').toLowerCase().trim().replace(/\s+/g, ' ');

const median = (numbers) => {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const mostCommon = (values) => {
  const counts = {};
  let best = values[0];
  let bestCount = 0;
  for (const v of values) {
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] > bestCount) { bestCount = counts[v]; best = v; }
  }
  return best;
};

const addFrequency = (date, frequency) => {
  const d = new Date(date);
  const { type, interval } = frequency;
  switch (type) {
    case 'days': d.setDate(d.getDate() + interval); break;
    case 'weeks': d.setDate(d.getDate() + interval * 7); break;
    case 'months': d.setMonth(d.getMonth() + interval); break;
    case 'years': d.setFullYear(d.getFullYear() + interval); break;
  }
  return d;
};

const dayGap = (aStr, bStr) => Math.round((new Date(bStr) - new Date(aStr)) / 86400000);

// Known cadences with day-gap tolerance windows (kept non-overlapping)
const CADENCES = [
  { freq: { type: 'weeks', interval: 1 }, min: 5, max: 10 },
  { freq: { type: 'weeks', interval: 2 }, min: 11, max: 18 },
  { freq: { type: 'months', interval: 1 }, min: 25, max: 38 },
  { freq: { type: 'months', interval: 3 }, min: 80, max: 104 },
  { freq: { type: 'months', interval: 6 }, min: 165, max: 200 },
  { freq: { type: 'years', interval: 1 }, min: 330, max: 400 }
];

// Ignore tiny recurring amounts (e.g. pennies of savings interest) as suggestion noise
const MIN_SUGGESTION_AMOUNT = 1;

const recurring = {
  getRecurring: (req, res) => {
    const recurringList = readJSON(recurringFile) || [];
    sendJSON(res, recurringList.filter(r => r.active !== false));
  },

  createRecurring: async (req, res) => {
    const body = await parseBody(req);
    const recurringList = readJSON(recurringFile) || [];
    const newRecurring = {
      id: generateId(),
      type: body.type || 'transaction',
      accountId: body.accountId || null,
      fromAccountId: body.fromAccountId || null,
      toAccountId: body.toAccountId || null,
      payee: body.payee || '',
      amount: parseFloat(body.amount) || 0,
      category: body.category || 'Uncategorized',
      description: body.description || '',
      notes: body.notes || '',
      frequency: body.frequency || { type: 'months', interval: 1 },
      startDate: body.startDate || new Date().toISOString().split('T')[0],
      nextDueDate: body.startDate || new Date().toISOString().split('T')[0],
      endCondition: body.endCondition || { type: 'never', value: null },
      occurrencesCompleted: 0,
      active: true,
      paused: body.paused || false,
      createdAt: new Date().toISOString()
    };
    recurringList.push(newRecurring);
    writeJSON(recurringFile, recurringList);
    sendJSON(res, newRecurring, 201);
  },

  updateRecurring: async (req, res, recurringId) => {
    const body = await parseBody(req);
    const recurringList = readJSON(recurringFile) || [];
    const index = recurringList.findIndex(r => r.id === recurringId);
    if (index === -1) {
      sendJSON(res, { error: 'Recurring not found' }, 404);
      return;
    }
    recurringList[index] = { ...recurringList[index], ...body };
    writeJSON(recurringFile, recurringList);
    sendJSON(res, recurringList[index]);
  },

  deleteRecurring: (req, res, recurringId) => {
    const recurringList = readJSON(recurringFile) || [];
    const index = recurringList.findIndex(r => r.id === recurringId);
    if (index === -1) {
      sendJSON(res, { error: 'Recurring not found' }, 404);
      return;
    }
    recurringList[index].active = false;
    writeJSON(recurringFile, recurringList);
    sendJSON(res, { success: true });
  },

  approveRecurring: async (req, res, recurringId) => {
    const body = await parseBody(req);
    const recurringList = readJSON(recurringFile) || [];
    const index = recurringList.findIndex(r => r.id === recurringId);
    if (index === -1) {
      sendJSON(res, { error: 'Recurring not found' }, 404);
      return;
    }

    const template = recurringList[index];
    const approvedDate = body.date || template.nextDueDate;
    const approvedAmount = body.amount !== undefined ? parseFloat(body.amount) : template.amount;

    if (template.type === 'transfer') {
      const transferId1 = generateId();
      const transferId2 = generateId();
      const now = new Date().toISOString();

      const accounts = readJSON(accountsFile) || [];
      const fromAccount = accounts.find(a => a.id === template.fromAccountId);
      const toAccount = accounts.find(a => a.id === template.toAccountId);

      const fromTransaction = {
        id: transferId1,
        payee: `Transfer to ${toAccount?.name || 'Unknown'}`,
        amount: -Math.abs(approvedAmount),
        date: approvedDate,
        category: 'Transfer',
        description: template.description || '',
        notes: template.notes || '',
        createdAt: now,
        transferId: transferId2,
        transferAccountId: template.toAccountId
      };

      const toTransaction = {
        id: transferId2,
        payee: `Transfer from ${fromAccount?.name || 'Unknown'}`,
        amount: Math.abs(approvedAmount),
        date: approvedDate,
        category: 'Transfer',
        description: template.description || '',
        notes: template.notes || '',
        createdAt: now,
        transferId: transferId1,
        transferAccountId: template.fromAccountId
      };

      const fromTransactions = readJSON(getTransactionsFile(template.fromAccountId)) || [];
      const toTransactions = readJSON(getTransactionsFile(template.toAccountId)) || [];
      fromTransactions.push(fromTransaction);
      toTransactions.push(toTransaction);
      writeJSON(getTransactionsFile(template.fromAccountId), fromTransactions);
      writeJSON(getTransactionsFile(template.toAccountId), toTransactions);
    } else {
      const transactions = readJSON(getTransactionsFile(template.accountId)) || [];
      const newTransaction = {
        id: generateId(),
        payee: template.payee,
        amount: approvedAmount,
        date: approvedDate,
        category: template.category,
        description: template.description || '',
        notes: template.notes || '',
        createdAt: new Date().toISOString(),
        transferId: null,
        transferAccountId: null
      };
      transactions.push(newTransaction);
      writeJSON(getTransactionsFile(template.accountId), transactions);
    }

    template.occurrencesCompleted += 1;
    template.nextDueDate = calculateNextDueDate(template);
    writeJSON(recurringFile, recurringList);

    sendJSON(res, { success: true, nextDueDate: template.nextDueDate });
  },

  skipRecurring: async (req, res, recurringId) => {
    const recurringList = readJSON(recurringFile) || [];
    const index = recurringList.findIndex(r => r.id === recurringId);
    if (index === -1) {
      sendJSON(res, { error: 'Recurring not found' }, 404);
      return;
    }

    const template = recurringList[index];
    template.nextDueDate = calculateNextDueDate(template);
    writeJSON(recurringFile, recurringList);

    sendJSON(res, { success: true, nextDueDate: template.nextDueDate });
  },

  // Detect likely recurring payments from transaction history (Phase 2)
  getSuggestions: (req, res) => {
    const accounts = readJSON(accountsFile) || [];
    const templates = (readJSON(recurringFile) || []).filter(r => r.active !== false);
    const dismissed = new Set(readJSON(dismissedFile) || []);

    // Signatures that already have a transaction template (avoid duplicates)
    const templated = new Set();
    for (const t of templates) {
      if (t.type === 'transaction' && t.accountId && t.payee) {
        templated.add(`${t.accountId}|${normalisePayee(t.payee)}`);
      }
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const suggestions = [];

    for (const account of accounts) {
      if (account.active === false) continue;

      const txs = (readJSON(getTransactionsFile(account.id)) || [])
        .filter(tx => tx.category !== 'Transfer' && !tx.transferId);

      // Group by normalised payee
      const groups = {};
      for (const tx of txs) {
        const key = normalisePayee(tx.payee);
        if (!key) continue;
        (groups[key] = groups[key] || []).push(tx);
      }

      for (const [normPayee, group] of Object.entries(groups)) {
        if (group.length < 3) continue;

        const signature = `${account.id}|${normPayee}`;
        if (templated.has(signature) || dismissed.has(signature)) continue;

        // Skip payees mixing income & expense (likely refunds)
        const hasPositive = group.some(tx => tx.amount > 0);
        const hasNegative = group.some(tx => tx.amount < 0);
        if (hasPositive && hasNegative) continue;

        // Day-gaps between consecutive occurrences
        const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
        const gaps = [];
        for (let i = 1; i < sorted.length; i++) {
          const g = dayGap(sorted[i - 1].date, sorted[i].date);
          if (g > 0) gaps.push(g);
        }
        if (gaps.length < 2) continue;

        // Median gap must match a cadence, and >=60% of gaps must fit it
        const medGap = median(gaps);
        const cadence = CADENCES.find(c => medGap >= c.min && medGap <= c.max);
        if (!cadence) continue;
        const fitting = gaps.filter(g => g >= cadence.min && g <= cadence.max).length;
        if (fitting / gaps.length < 0.6) continue;

        const amount = Math.round(median(group.map(tx => tx.amount)) * 100) / 100;
        if (Math.abs(amount) < MIN_SUGGESTION_AMOUNT) continue; // skip micro-interest noise
        const category = mostCommon(group.map(tx => tx.category || 'Uncategorized'));
        const payee = mostCommon(group.map(tx => tx.payee));

        // Project next-due forward from last occurrence to today or later
        let nextDue = addFrequency(sorted[sorted.length - 1].date, cadence.freq);
        let guard = 0;
        while (nextDue < today && guard < 200) {
          nextDue = addFrequency(nextDue, cadence.freq);
          guard++;
        }

        suggestions.push({
          signature,
          accountId: account.id,
          accountName: account.name,
          payee,
          amount,
          category,
          frequency: cadence.freq,
          nextDueDate: nextDue.toISOString().split('T')[0],
          occurrences: group.length
        });
      }
    }

    suggestions.sort((a, b) => b.occurrences - a.occurrences);
    sendJSON(res, suggestions);
  },

  dismissSuggestion: async (req, res) => {
    const body = await parseBody(req);
    const signature = body.signature;
    if (!signature) {
      sendJSON(res, { error: 'signature required' }, 400);
      return;
    }
    const dismissed = readJSON(dismissedFile) || [];
    if (!dismissed.includes(signature)) {
      dismissed.push(signature);
      writeJSON(dismissedFile, dismissed);
    }
    sendJSON(res, { success: true });
  }
};

module.exports = recurring;

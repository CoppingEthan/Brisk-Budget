// Recurring Payments Management
const Recurring = {
  list: [],
  suggestions: [],
  currentEdit: null,

  async load() {
    this.list = await API.getRecurring();
    if (this.isViewActive()) this.renderView();
  },

  isViewActive() {
    const view = document.getElementById('recurringView');
    return view && !view.classList.contains('hidden');
  },

  // ---------- Monthly-equivalent maths ----------
  // daily ×30.44/interval; weekly ×(52/12)/interval; monthly ÷interval; yearly ÷(12×interval)
  monthlyEquivalent(item) {
    const freq = item.frequency || { type: 'months', interval: 1 };
    const n = freq.interval || 1;
    const amt = item.amount || 0;
    switch (freq.type) {
      case 'days': return amt * 30.44 / n;
      case 'weeks': return amt * (52 / 12) / n;
      case 'months': return amt / n;
      case 'years': return amt / (12 * n);
      default: return amt;
    }
  },

  activeItems() {
    return this.list.filter(item => !item.paused);
  },

  // ---------- Collapsed expense category state ----------
  getCollapsedCats() {
    try {
      return JSON.parse(localStorage.getItem('briskBudget_collapsedRecurCats') || '{}');
    } catch { return {}; }
  },

  setCollapsedCat(name, collapsed) {
    const state = this.getCollapsedCats();
    state[name] = collapsed;
    localStorage.setItem('briskBudget_collapsedRecurCats', JSON.stringify(state));
  },

  // ---------- View ----------
  renderView() {
    this.renderSummary();
    this.renderSections();
    this.loadSuggestions();
  },

  renderSummary() {
    let income = 0, expenses = 0;
    for (const item of this.activeItems()) {
      if (item.type === 'transfer') continue;
      const mo = this.monthlyEquivalent(item);
      if (item.amount >= 0) income += mo;
      else expenses += Math.abs(mo);
    }
    const net = income - expenses;
    const next30 = this.next30DaysCashflow();

    const set = (id, value, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = App.formatCurrency(value);
      if (cls !== undefined) el.className = 'dashboard-card-value ' + cls;
    };

    set('recurringMonthlyIncome', income);
    set('recurringMonthlyExpenses', expenses);
    set('recurringMonthlyNet', net, net > 0 ? 'positive' : net < 0 ? 'negative' : '');
    set('recurringNext30', next30, next30 > 0 ? 'positive' : next30 < 0 ? 'negative' : '');
  },

  // Actual signed income/expense cashflow scheduled over the coming 30 days
  next30DaysCashflow() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    const end = new Date(today);
    end.setDate(end.getDate() + 30);
    const endStr = end.toISOString().split('T')[0];

    let total = 0;
    for (const item of this.activeItems()) {
      if (item.type === 'transfer') continue; // internal movement, no net cashflow
      let dueDate = item.nextDueDate;
      let offset = 0;
      while (dueDate <= endStr && !this.hasEnded(item, offset)) {
        if (dueDate >= todayStr) total += item.amount;
        dueDate = this.calculateNextDate(item.frequency, dueDate);
        offset++;
        if (offset > 400) break;
      }
    }
    return total;
  },

  renderSections() {
    const container = document.getElementById('recurringSections');
    if (!container) return;

    if (this.list.length === 0) {
      container.innerHTML = '<p class="empty-state">No recurring payments yet. Click "Add Recurring" to create one.</p>';
      return;
    }

    const income = this.list.filter(i => i.type !== 'transfer' && i.amount >= 0);
    const expenses = this.list.filter(i => i.type !== 'transfer' && i.amount < 0);
    const transfers = this.list.filter(i => i.type === 'transfer');

    let html = '';
    html += this.renderIncomeSection(income);
    html += this.renderExpensesSection(expenses);
    html += this.renderTransfersSection(transfers);
    container.innerHTML = html;

    this.bindRowHandlers(container);
  },

  sectionHeader(title, count, subtotal, subtotalClass = '') {
    const subtotalHtml = subtotal !== null
      ? `<span class="recurring-section-subtotal ${subtotalClass}">${App.formatCurrency(Math.abs(subtotal))}/mo</span>`
      : '';
    return `
      <div class="recurring-section-header">
        <span class="recurring-section-title">${title} <span class="recurring-section-count">${count}</span></span>
        ${subtotalHtml}
      </div>
    `;
  },

  monthlySubtotal(items) {
    return items
      .filter(i => !i.paused)
      .reduce((sum, i) => sum + this.monthlyEquivalent(i), 0);
  },

  renderIncomeSection(items) {
    if (items.length === 0) return '';
    const subtotal = this.monthlySubtotal(items);
    return `
      <div class="recurring-section">
        ${this.sectionHeader('Income', items.length, subtotal, 'positive')}
        <div class="recurring-rows">
          ${items.map(i => this.renderRow(i)).join('')}
        </div>
      </div>
    `;
  },

  renderTransfersSection(items) {
    if (items.length === 0) return '';
    return `
      <div class="recurring-section">
        ${this.sectionHeader('Transfers', items.length, null)}
        <div class="recurring-rows">
          ${items.map(i => this.renderRow(i)).join('')}
        </div>
      </div>
    `;
  },

  renderExpensesSection(items) {
    if (items.length === 0) return '';

    // Group by parent category
    const groups = {};
    for (const item of items) {
      const info = (typeof Categories !== 'undefined' && Categories.list.length)
        ? Categories.getCategoryInfo(item.category)
        : null;
      const parent = info && info.category ? info.category.name : (item.category || 'Uncategorized');
      const emoji = info && info.emoji ? info.emoji : '📁';
      if (!groups[parent]) groups[parent] = { items: [], emoji };
      groups[parent].items.push(item);
    }

    // Largest monthly subtotal first
    const orderedNames = Object.keys(groups).sort((a, b) =>
      Math.abs(this.monthlySubtotal(groups[b].items)) - Math.abs(this.monthlySubtotal(groups[a].items))
    );

    const collapsed = this.getCollapsedCats();
    const totalSubtotal = this.monthlySubtotal(items);

    let inner = '';
    for (const name of orderedNames) {
      const group = groups[name];
      const isCollapsed = !!collapsed[name];
      const subtotal = this.monthlySubtotal(group.items);
      inner += `
        <div class="recurring-cat-group ${isCollapsed ? 'collapsed' : ''}">
          <div class="recurring-cat-header" data-cat="${name}">
            <span class="recurring-cat-chevron">▼</span>
            <span class="recurring-cat-emoji">${group.emoji}</span>
            <span class="recurring-cat-name">${name}</span>
            <span class="recurring-cat-count">${group.items.length}</span>
            <span class="recurring-cat-subtotal negative">${App.formatCurrency(Math.abs(subtotal))}/mo</span>
          </div>
          <div class="recurring-cat-rows">
            ${group.items.map(i => this.renderRow(i)).join('')}
          </div>
        </div>
      `;
    }

    return `
      <div class="recurring-section">
        ${this.sectionHeader('Expenses', items.length, totalSubtotal, 'negative')}
        <div class="recurring-cat-groups">
          ${inner}
        </div>
      </div>
    `;
  },

  renderRow(item) {
    const isTransfer = item.type === 'transfer';
    const name = isTransfer ? this.getAccountName(item) : (item.payee || '(no payee)');
    const freqText = this.getFrequencyText(item.frequency);
    const nextDate = new Date(item.nextDueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const mo = this.monthlyEquivalent(item);
    const paused = !!item.paused;

    const displayAmount = isTransfer ? Math.abs(item.amount) : item.amount;
    const amountClass = isTransfer ? '' : (item.amount < 0 ? 'negative' : 'positive');

    const metaParts = [freqText, `Next ${nextDate}`];
    if (!isTransfer && item.category) metaParts.push(item.category);

    return `
      <div class="recurring-row ${paused ? 'paused' : ''}" data-id="${item.id}">
        <div class="recurring-row-main">
          <span class="recurring-row-name">${name}${paused ? '<span class="recurring-badge">Paused</span>' : ''}</span>
          <span class="recurring-row-meta">${metaParts.join(' · ')}</span>
        </div>
        <div class="recurring-row-amounts">
          <span class="recurring-row-amount ${amountClass}">${App.formatCurrency(displayAmount)}</span>
          <span class="recurring-row-mo">≈ ${App.formatCurrency(Math.abs(mo))}/mo</span>
        </div>
        <div class="recurring-row-actions">
          <button class="btn-icon btn-log" title="Log now">+</button>
          <button class="btn-icon btn-pause" title="${paused ? 'Resume' : 'Pause'}">${paused ? '▶' : '❚❚'}</button>
          <button class="btn-icon btn-edit" title="Edit">✎</button>
        </div>
      </div>
    `;
  },

  bindRowHandlers(container) {
    // Row actions
    container.querySelectorAll('.recurring-row').forEach(row => {
      const id = row.dataset.id;

      row.querySelector('.btn-log')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.logNow(id);
      });
      row.querySelector('.btn-pause')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePause(id);
      });
      row.querySelector('.btn-edit')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editById(id);
      });
      row.querySelector('.recurring-row-main')?.addEventListener('click', () => {
        this.editById(id);
      });
    });

    // Collapsible expense categories
    container.querySelectorAll('.recurring-cat-header').forEach(header => {
      header.addEventListener('click', () => {
        const name = header.dataset.cat;
        const group = header.closest('.recurring-cat-group');
        const nowCollapsed = !group.classList.contains('collapsed');
        group.classList.toggle('collapsed', nowCollapsed);
        this.setCollapsedCat(name, nowCollapsed);
      });
    });
  },

  editById(id) {
    const item = this.list.find(r => r.id === id);
    if (item) this.showModal(item);
  },

  async logNow(id) {
    const item = this.list.find(r => r.id === id);
    if (!item) return;
    const today = new Date().toISOString().split('T')[0];
    const result = await API.approveRecurring(id, { date: today, amount: item.amount });
    if (result && result.success) {
      await this.load();
      await Accounts.refreshAllBalances();
      Accounts.render();
      if (Accounts.current) await Transactions.load(Accounts.current.id);
    }
  },

  async togglePause(id) {
    const item = this.list.find(r => r.id === id);
    if (!item) return;
    await API.updateRecurring(id, { paused: !item.paused });
    await this.load();
  },

  // ---------- Suggestions (Phase 2) ----------
  async loadSuggestions() {
    const container = document.getElementById('recurringSuggestions');
    if (!container) return;

    let suggestions = [];
    try {
      suggestions = await API.getRecurringSuggestions();
    } catch {
      suggestions = [];
    }
    this.suggestions = Array.isArray(suggestions) ? suggestions : [];

    if (this.suggestions.length === 0) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    container.classList.remove('hidden');
    container.innerHTML = `
      <div class="recurring-section-header">
        <span class="recurring-section-title">Suggested <span class="recurring-section-count">${this.suggestions.length}</span></span>
        <span class="recurring-section-hint">Detected from your transaction history</span>
      </div>
      <div class="suggestion-list">
        ${this.suggestions.map((s, i) => this.renderSuggestion(s, i)).join('')}
      </div>
    `;
    this.bindSuggestionHandlers(container);
  },

  renderSuggestion(s, index) {
    const freqText = this.getFrequencyText(s.frequency);
    const amountClass = s.amount < 0 ? 'negative' : 'positive';
    return `
      <div class="suggestion-item" data-index="${index}">
        <div class="suggestion-main">
          <span class="suggestion-payee">${s.payee}</span>
          <span class="suggestion-meta">${s.accountName} · ${freqText} · seen ${s.occurrences}×</span>
        </div>
        <span class="suggestion-amount ${amountClass}">${App.formatCurrency(s.amount)}</span>
        <div class="suggestion-actions">
          <button class="btn btn-small btn-primary btn-setup">Set up</button>
          <button class="btn btn-small btn-secondary btn-dismiss">Dismiss</button>
        </div>
      </div>
    `;
  },

  bindSuggestionHandlers(container) {
    container.querySelectorAll('.suggestion-item').forEach(el => {
      const index = parseInt(el.dataset.index, 10);
      el.querySelector('.btn-setup')?.addEventListener('click', () => {
        this.setupSuggestion(index);
      });
      el.querySelector('.btn-dismiss')?.addEventListener('click', () => {
        this.dismissSuggestion(index);
      });
    });
  },

  setupSuggestion(index) {
    const s = this.suggestions[index];
    if (!s) return;
    this.showModal(null, {
      accountId: s.accountId,
      payee: s.payee,
      amount: s.amount,
      category: s.category,
      frequency: s.frequency,
      nextDueDate: s.nextDueDate
    });
  },

  async dismissSuggestion(index) {
    const s = this.suggestions[index];
    if (!s) return;
    await API.dismissRecurringSuggestion(s.signature);
    this.suggestions.splice(index, 1);
    this.loadSuggestions();
  },

  // ---------- Helpers shared with dashboard / account view ----------
  getAccountName(item) {
    if (item.type === 'transfer') {
      const from = Accounts.list.find(a => a.id === item.fromAccountId);
      const to = Accounts.list.find(a => a.id === item.toAccountId);
      return `${from?.name || '?'} → ${to?.name || '?'}`;
    }
    const account = Accounts.list.find(a => a.id === item.accountId);
    return account?.name || 'Unknown';
  },

  getFrequencyText(frequency) {
    const { type, interval } = frequency;
    if (interval === 1) {
      switch (type) {
        case 'days': return 'Daily';
        case 'weeks': return 'Weekly';
        case 'months': return 'Monthly';
        case 'years': return 'Yearly';
      }
    }
    if (interval === 2 && type === 'weeks') return 'Fortnightly';
    if (interval === 3 && type === 'months') return 'Quarterly';
    if (interval === 6 && type === 'months') return 'Every 6 months';
    return `Every ${interval} ${type}`;
  },

  // ---------- Add / Edit modal ----------
  async showModal(recurring = null, prefill = null) {
    this.currentEdit = recurring;
    const modal = document.getElementById('recurringModal');
    const title = document.getElementById('recurringModalTitle');
    const deleteBtn = document.getElementById('deleteRecurringBtn');

    title.textContent = recurring ? 'Edit Recurring Payment' : 'Add Recurring Payment';
    deleteBtn.classList.toggle('hidden', !recurring);

    // Populate dropdowns. Preselect category from the item being edited or the prefill.
    await this.populateAccountDropdowns();
    await this.populateCategoryDropdown(recurring?.category || prefill?.category || null);
    await this.populatePayeeDatalist();

    if (recurring) {
      const mode = recurring.type === 'transfer'
        ? 'transfer'
        : (recurring.amount >= 0 ? 'income' : 'expense');
      this.setMode(mode);

      if (recurring.type === 'transfer') {
        document.getElementById('recurringFromAccount').value = recurring.fromAccountId || '';
        document.getElementById('recurringToAccount').value = recurring.toAccountId || '';
        document.getElementById('recurringTransferAmount').value = Math.abs(recurring.amount) || '';
      } else {
        document.getElementById('recurringAccount').value = recurring.accountId || '';
        document.getElementById('recurringPayee').value = recurring.payee || '';
        document.getElementById('recurringAmount').value = Math.abs(recurring.amount) || '';
      }

      document.getElementById('recurringDescription').value = recurring.description || '';
      document.getElementById('recurringStartDate').value = recurring.startDate || '';

      this.setFrequencyUI(recurring.frequency);

      const endCond = recurring.endCondition || { type: 'never', value: null };
      document.querySelector(`input[name="endCondition"][value="${endCond.type}"]`).checked = true;
      this.updateEndConditionInputs(endCond.type);
      if (endCond.type === 'after_occurrences') {
        document.getElementById('endAfterCount').value = endCond.value || 12;
      } else if (endCond.type === 'on_date') {
        document.getElementById('endOnDate').value = endCond.value || '';
      }
    } else {
      // New (blank or prefilled from a suggestion)
      document.getElementById('recurringForm').reset();
      document.querySelector('input[name="endCondition"][value="never"]').checked = true;
      this.updateEndConditionInputs('never');

      if (prefill) {
        const mode = prefill.amount >= 0 ? 'income' : 'expense';
        this.setMode(mode);
        document.getElementById('recurringAccount').value = prefill.accountId || '';
        document.getElementById('recurringPayee').value = prefill.payee || '';
        document.getElementById('recurringAmount').value = Math.abs(prefill.amount) || '';
        // category already selected by populateCategoryDropdown
        this.setFrequencyUI(prefill.frequency);
        document.getElementById('recurringStartDate').value = prefill.nextDueDate || new Date().toISOString().split('T')[0];
      } else {
        this.setMode('expense');
        this.setFrequencyUI({ type: 'months', interval: 1 });
        document.getElementById('recurringStartDate').value = new Date().toISOString().split('T')[0];
      }
    }

    modal.classList.remove('hidden');
  },

  hideModal() {
    document.getElementById('recurringModal').classList.add('hidden');
    this.currentEdit = null;
    if (this.isViewActive()) this.renderView();
  },

  setMode(mode) {
    const radio = document.querySelector(`input[name="recurringMode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    this.toggleModeFields(mode);
  },

  getMode() {
    const checked = document.querySelector('input[name="recurringMode"]:checked');
    return checked ? checked.value : 'expense';
  },

  toggleModeFields(mode) {
    const transactionFields = document.getElementById('recurringTransactionFields');
    const transferFields = document.getElementById('recurringTransferFields');
    const isTransfer = mode === 'transfer';

    transactionFields.classList.toggle('hidden', isTransfer);
    transferFields.classList.toggle('hidden', !isTransfer);

    document.getElementById('recurringPayee').required = !isTransfer;
    document.getElementById('recurringAmount').required = !isTransfer;
    document.getElementById('recurringAccount').required = !isTransfer;
  },

  setFrequencyUI(frequency) {
    const freq = frequency || { type: 'months', interval: 1 };
    let preset = 'custom';
    if (freq.interval === 1 && freq.type === 'weeks') preset = 'weekly';
    else if (freq.interval === 2 && freq.type === 'weeks') preset = 'fortnightly';
    else if (freq.interval === 1 && freq.type === 'months') preset = 'monthly';
    else if (freq.interval === 3 && freq.type === 'months') preset = 'quarterly';
    else if (freq.interval === 1 && freq.type === 'years') preset = 'yearly';

    document.querySelector(`input[name="frequencyPreset"][value="${preset}"]`).checked = true;
    document.getElementById('customFrequency').classList.toggle('hidden', preset !== 'custom');
    document.getElementById('frequencyInterval').value = freq.interval;
    document.getElementById('frequencyType').value = freq.type;
  },

  updateEndConditionInputs(type) {
    document.getElementById('endAfterCount').disabled = type !== 'after_occurrences';
    document.getElementById('endOnDate').disabled = type !== 'on_date';
  },

  async populateAccountDropdowns() {
    const options = Accounts.list.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
    document.getElementById('recurringAccount').innerHTML = options;
    document.getElementById('recurringFromAccount').innerHTML = options;
    document.getElementById('recurringToAccount').innerHTML = options;
  },

  async populateCategoryDropdown(selectedValue = null) {
    await Categories.loadSelect('recurringCategory', selectedValue);
  },

  async populatePayeeDatalist() {
    const payees = await API.getPayees();
    const datalist = document.getElementById('recurringPayeeDatalist');
    datalist.innerHTML = payees.map(p => `<option value="${p.name}">`).join('');
  },

  getFormData() {
    const mode = this.getMode();
    const type = mode === 'transfer' ? 'transfer' : 'transaction';
    const frequencyPreset = document.querySelector('input[name="frequencyPreset"]:checked').value;
    const endConditionType = document.querySelector('input[name="endCondition"]:checked').value;

    let frequency;
    switch (frequencyPreset) {
      case 'weekly': frequency = { type: 'weeks', interval: 1 }; break;
      case 'fortnightly': frequency = { type: 'weeks', interval: 2 }; break;
      case 'monthly': frequency = { type: 'months', interval: 1 }; break;
      case 'quarterly': frequency = { type: 'months', interval: 3 }; break;
      case 'yearly': frequency = { type: 'years', interval: 1 }; break;
      case 'custom':
        frequency = {
          type: document.getElementById('frequencyType').value,
          interval: parseInt(document.getElementById('frequencyInterval').value) || 1
        };
        break;
    }

    let endCondition = { type: endConditionType, value: null };
    if (endConditionType === 'after_occurrences') {
      endCondition.value = parseInt(document.getElementById('endAfterCount').value) || 12;
    } else if (endConditionType === 'on_date') {
      endCondition.value = document.getElementById('endOnDate').value;
    }

    const data = {
      type,
      frequency,
      startDate: document.getElementById('recurringStartDate').value,
      endCondition,
      description: document.getElementById('recurringDescription').value
    };

    if (type === 'transfer') {
      data.fromAccountId = document.getElementById('recurringFromAccount').value;
      data.toAccountId = document.getElementById('recurringToAccount').value;
      data.amount = -Math.abs(parseFloat(document.getElementById('recurringTransferAmount').value));
    } else {
      data.accountId = document.getElementById('recurringAccount').value;
      data.payee = document.getElementById('recurringPayee').value;
      data.category = document.getElementById('recurringCategory').value;
      const rawAmount = Math.abs(parseFloat(document.getElementById('recurringAmount').value) || 0);
      // Income positive, expense negative
      data.amount = mode === 'income' ? rawAmount : -rawAmount;
    }

    return data;
  },

  async save() {
    const data = this.getFormData();

    if (this.currentEdit) {
      await API.updateRecurring(this.currentEdit.id, data);
    } else {
      await API.createRecurring(data);
    }

    await this.load();
    this.hideModal();

    if (Accounts.current) {
      await Transactions.load(Accounts.current.id);
    }
  },

  async delete() {
    if (!this.currentEdit) return;

    await API.deleteRecurring(this.currentEdit.id);
    await this.load();
    this.hideModal();

    if (Accounts.current) {
      await Transactions.load(Accounts.current.id);
    }
  },

  // ---------- In-account "upcoming payments" prompt ----------
  // Items due today or earlier, plus items coming up in the next 3 days
  getPendingForAccount(accountId) {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    const upcomingCutoff = new Date(today);
    upcomingCutoff.setDate(upcomingCutoff.getDate() + 3);
    const upcomingCutoffStr = upcomingCutoff.toISOString().split('T')[0];

    const pending = [];

    for (const item of this.list) {
      if (item.paused) continue; // paused items never prompt

      let appliesTo = false;
      if (item.type === 'transaction' && item.accountId === accountId) {
        appliesTo = true;
      } else if (item.type === 'transfer') {
        if (item.fromAccountId === accountId || item.toAccountId === accountId) {
          appliesTo = true;
        }
      }
      if (!appliesTo) continue;

      if (this.hasEnded(item)) continue;

      let dueDate = item.nextDueDate;
      let occurrenceOffset = 0;

      while (dueDate <= upcomingCutoffStr && !this.hasEnded(item, occurrenceOffset)) {
        const pendingTx = this.createPendingTransaction(item, dueDate, accountId, occurrenceOffset);
        pendingTx.isUpcoming = dueDate > todayStr;
        pending.push(pendingTx);

        dueDate = this.calculateNextDate(item.frequency, dueDate);
        occurrenceOffset++;

        if (occurrenceOffset > 100) break;
      }
    }

    pending.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    return pending;
  },

  hasEnded(item, additionalOccurrences = 0) {
    const { endCondition, occurrencesCompleted } = item;
    if (!endCondition || endCondition.type === 'never') return false;
    if (endCondition.type === 'after_occurrences') {
      return (occurrencesCompleted + additionalOccurrences) >= endCondition.value;
    }
    if (endCondition.type === 'on_date') {
      return new Date() > new Date(endCondition.value);
    }
    return false;
  },

  calculateNextDate(frequency, fromDate) {
    const current = new Date(fromDate);
    const { type, interval } = frequency;

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
  },

  createPendingTransaction(item, dueDate, viewingAccountId, occurrenceOffset) {
    const isTransfer = item.type === 'transfer';

    let amount = item.amount;
    let payee = item.payee;

    if (isTransfer) {
      const fromAccount = Accounts.list.find(a => a.id === item.fromAccountId);
      const toAccount = Accounts.list.find(a => a.id === item.toAccountId);

      if (viewingAccountId === item.fromAccountId) {
        amount = -Math.abs(item.amount);
        payee = `Transfer to ${toAccount?.name || 'Unknown'}`;
      } else {
        amount = Math.abs(item.amount);
        payee = `Transfer from ${fromAccount?.name || 'Unknown'}`;
      }
    }

    return {
      isPending: true,
      recurringId: item.id,
      occurrenceOffset,
      dueDate,
      payee,
      amount,
      category: isTransfer ? 'Transfer' : item.category,
      description: item.description,
      isTransfer,
      frequency: item.frequency
    };
  },

  async approvePending(recurringId, date, amount) {
    const result = await API.approveRecurring(recurringId, { date, amount });
    if (result.success) {
      await this.load();
      if (Accounts.current) {
        await Transactions.load(Accounts.current.id);
        await Accounts.updateBalance();
      }
    }
    return result;
  },

  async skipPending(recurringId) {
    const result = await API.skipRecurring(recurringId);
    if (result.success) {
      await this.load();
      if (Accounts.current) {
        await Transactions.load(Accounts.current.id);
      }
    }
    return result;
  },

  init() {
    // Sidebar Recurring button -> full page
    document.getElementById('recurringBtn')?.addEventListener('click', () => {
      App.showRecurring();
    });

    // Add button in the view header
    document.getElementById('addRecurringViewBtn')?.addEventListener('click', () => {
      this.showModal();
    });

    // Modal close handlers
    App.bindModalClose('recurringModal');

    // Mode toggle (Income / Expense / Transfer)
    document.querySelectorAll('input[name="recurringMode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.toggleModeFields(e.target.value);
      });
    });

    // Frequency preset toggle
    document.querySelectorAll('input[name="frequencyPreset"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        document.getElementById('customFrequency').classList.toggle('hidden', e.target.value !== 'custom');
      });
    });

    // End condition toggle
    document.querySelectorAll('input[name="endCondition"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.updateEndConditionInputs(e.target.value);
      });
    });

    // Form submit
    document.getElementById('recurringForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.save();
    });

    // Delete button (styled confirm modal, consistent with the rest of the app)
    document.getElementById('deleteRecurringBtn')?.addEventListener('click', () => {
      if (!this.currentEdit) return;
      const item = this.currentEdit;
      const label = item.type === 'transfer' ? `the transfer ${this.getAccountName(item)}` : `"${item.payee}"`;
      // Hide the edit modal first so the confirm dialog isn't stacked behind it
      document.getElementById('recurringModal').classList.add('hidden');
      App.confirm(
        'Delete Recurring Payment',
        `Delete ${label}? This stops all future occurrences.`,
        () => this.delete()
      );
    });
  }
};

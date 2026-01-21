// Recurring Payments Management
const Recurring = {
  list: [],
  currentEdit: null,

  async load() {
    this.list = await API.getRecurring();
    this.renderList();
  },

  renderList() {
    const container = document.getElementById('recurringListContainer');
    if (!container) return;

    if (this.list.length === 0) {
      container.innerHTML = '<p class="empty-state">No recurring payments yet. Click "+ Add Recurring" to create one.</p>';
      return;
    }

    container.innerHTML = this.list.map(item => {
      const accountName = this.getAccountName(item);
      const freqText = this.getFrequencyText(item.frequency);
      const amountClass = item.amount < 0 ? 'negative' : 'positive';
      const nextDate = new Date(item.nextDueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

      return `
        <div class="recurring-item" data-id="${item.id}">
          <div class="recurring-item-info">
            <span class="recurring-item-name">${item.type === 'transfer' ? 'Transfer' : item.payee}</span>
            <div class="recurring-item-details">
              <span class="recurring-item-account">${accountName}</span>
              <span class="recurring-item-freq">${freqText}</span>
              <span class="recurring-item-next">Next: ${nextDate}</span>
            </div>
          </div>
          <span class="recurring-item-amount ${amountClass}">${App.formatCurrency(item.amount)}</span>
        </div>
      `;
    }).join('');

    // Add click handlers
    container.querySelectorAll('.recurring-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        const recurring = this.list.find(r => r.id === id);
        if (recurring) this.showModal(recurring);
      });
    });
  },

  showListModal() {
    this.renderList();
    document.getElementById('recurringListModal').classList.remove('hidden');
  },

  hideListModal() {
    document.getElementById('recurringListModal').classList.add('hidden');
  },

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
    return `Every ${interval} ${type}`;
  },

  async showModal(recurring = null) {
    // Hide list modal when opening edit modal
    this.hideListModal();

    this.currentEdit = recurring;
    const modal = document.getElementById('recurringModal');
    const title = document.getElementById('recurringModalTitle');
    const deleteBtn = document.getElementById('deleteRecurringBtn');

    title.textContent = recurring ? 'Edit Recurring Payment' : 'Add Recurring Payment';
    deleteBtn.classList.toggle('hidden', !recurring);

    // Populate account dropdowns
    await this.populateAccountDropdowns();
    await this.populateCategoryDropdown(recurring?.category || null);
    await this.populatePayeeDatalist();

    // Set form values
    if (recurring) {
      // Type
      document.querySelector(`input[name="recurringType"][value="${recurring.type}"]`).checked = true;
      this.toggleTypeFields(recurring.type);

      if (recurring.type === 'transaction') {
        document.getElementById('recurringAccount').value = recurring.accountId || '';
        document.getElementById('recurringPayee').value = recurring.payee || '';
        document.getElementById('recurringAmount').value = recurring.amount || '';
        // Category is already set by populateCategoryDropdown with the selectedValue
      } else {
        document.getElementById('recurringFromAccount').value = recurring.fromAccountId || '';
        document.getElementById('recurringToAccount').value = recurring.toAccountId || '';
        document.getElementById('recurringTransferAmount').value = Math.abs(recurring.amount) || '';
      }

      document.getElementById('recurringDescription').value = recurring.description || '';
      document.getElementById('recurringStartDate').value = recurring.startDate || '';

      // Frequency
      const freq = recurring.frequency;
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

      // End condition
      const endCond = recurring.endCondition;
      document.querySelector(`input[name="endCondition"][value="${endCond.type}"]`).checked = true;
      this.updateEndConditionInputs(endCond.type);
      if (endCond.type === 'after_occurrences') {
        document.getElementById('endAfterCount').value = endCond.value || 12;
      } else if (endCond.type === 'on_date') {
        document.getElementById('endOnDate').value = endCond.value || '';
      }
    } else {
      // Reset form
      document.getElementById('recurringForm').reset();
      document.querySelector('input[name="recurringType"][value="transaction"]').checked = true;
      this.toggleTypeFields('transaction');
      document.querySelector('input[name="frequencyPreset"][value="monthly"]').checked = true;
      document.getElementById('customFrequency').classList.add('hidden');
      document.querySelector('input[name="endCondition"][value="never"]').checked = true;
      this.updateEndConditionInputs('never');
      document.getElementById('recurringStartDate').value = new Date().toISOString().split('T')[0];
    }

    modal.classList.remove('hidden');
  },

  hideModal(returnToList = true) {
    document.getElementById('recurringModal').classList.add('hidden');
    this.currentEdit = null;
    if (returnToList) {
      this.showListModal();
    }
  },

  toggleTypeFields(type) {
    const transactionFields = document.getElementById('recurringTransactionFields');
    const transferFields = document.getElementById('recurringTransferFields');

    if (type === 'transaction') {
      transactionFields.classList.remove('hidden');
      transferFields.classList.add('hidden');
      document.getElementById('recurringPayee').required = true;
      document.getElementById('recurringAmount').required = true;
      document.getElementById('recurringAccount').required = true;
    } else {
      transactionFields.classList.add('hidden');
      transferFields.classList.remove('hidden');
      document.getElementById('recurringPayee').required = false;
      document.getElementById('recurringAmount').required = false;
      document.getElementById('recurringAccount').required = false;
    }
  },

  updateEndConditionInputs(type) {
    document.getElementById('endAfterCount').disabled = type !== 'after_occurrences';
    document.getElementById('endOnDate').disabled = type !== 'on_date';
  },

  async populateAccountDropdowns() {
    const accounts = Accounts.list;
    const options = accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('');

    document.getElementById('recurringAccount').innerHTML = options;
    document.getElementById('recurringFromAccount').innerHTML = options;
    document.getElementById('recurringToAccount').innerHTML = options;
  },

  async populateCategoryDropdown(selectedValue = null) {
    // Use the same category loading as transactions to show subcategories
    await Categories.loadSelect('recurringCategory', selectedValue);
  },

  async populatePayeeDatalist() {
    const payees = await API.getPayees();
    const datalist = document.getElementById('recurringPayeeDatalist');
    datalist.innerHTML = payees.map(p => `<option value="${p.name}">`).join('');
  },

  getFormData() {
    const type = document.querySelector('input[name="recurringType"]:checked').value;
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

    if (type === 'transaction') {
      data.accountId = document.getElementById('recurringAccount').value;
      data.payee = document.getElementById('recurringPayee').value;
      data.amount = parseFloat(document.getElementById('recurringAmount').value);
      data.category = document.getElementById('recurringCategory').value;
    } else {
      data.fromAccountId = document.getElementById('recurringFromAccount').value;
      data.toAccountId = document.getElementById('recurringToAccount').value;
      data.amount = -Math.abs(parseFloat(document.getElementById('recurringTransferAmount').value));
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

    // Refresh transactions if viewing an account
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

  // Calculate pending recurring items for a specific account
  // Shows items that are due today or earlier, plus items coming up in the next 3 days
  getPendingForAccount(accountId) {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    // Calculate the cutoff date (3 days from now)
    const upcomingCutoff = new Date(today);
    upcomingCutoff.setDate(upcomingCutoff.getDate() + 3);
    const upcomingCutoffStr = upcomingCutoff.toISOString().split('T')[0];

    const pending = [];

    for (const item of this.list) {
      // Check if this recurring applies to the current account
      let appliesTo = false;
      if (item.type === 'transaction' && item.accountId === accountId) {
        appliesTo = true;
      } else if (item.type === 'transfer') {
        if (item.fromAccountId === accountId || item.toAccountId === accountId) {
          appliesTo = true;
        }
      }

      if (!appliesTo) continue;

      // Check if ended
      if (this.hasEnded(item)) continue;

      // Calculate all due occurrences (could be multiple if overdue)
      // Also include upcoming items within 3 days
      let dueDate = item.nextDueDate;
      let occurrenceOffset = 0;

      while (dueDate <= upcomingCutoffStr && !this.hasEnded(item, occurrenceOffset)) {
        // Create a pending transaction object
        const pendingTx = this.createPendingTransaction(item, dueDate, accountId, occurrenceOffset);
        // Mark if it's upcoming (not yet due) vs overdue/due today
        pendingTx.isUpcoming = dueDate > todayStr;
        pending.push(pendingTx);

        // Calculate next occurrence
        dueDate = this.calculateNextDate(item.frequency, dueDate);
        occurrenceOffset++;

        // Safety limit to prevent infinite loops
        if (occurrenceOffset > 100) break;
      }
    }

    // Sort by due date (oldest first)
    pending.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    return pending;
  },

  hasEnded(item, additionalOccurrences = 0) {
    const { endCondition, occurrencesCompleted } = item;
    if (endCondition.type === 'never') return false;
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

    // For transfers, determine the amount sign based on which account we're viewing
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
    // Recurring button in sidebar footer
    document.getElementById('recurringBtn')?.addEventListener('click', () => {
      this.showListModal();
    });

    // Add recurring button (in list modal)
    document.getElementById('addRecurringBtn')?.addEventListener('click', () => {
      this.showModal();
    });

    // Modal close handlers
    App.bindModalClose('recurringListModal');
    App.bindModalClose('recurringModal');

    // Type toggle
    document.querySelectorAll('input[name="recurringType"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        this.toggleTypeFields(e.target.value);
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

    // Delete button
    document.getElementById('deleteRecurringBtn')?.addEventListener('click', async () => {
      if (confirm('Delete this recurring payment?')) {
        await this.delete();
      }
    });
  }
};

// Transaction Management
const Transactions = {
  list: [],
  currentEdit: null,

  async load(accountId) {
    this.list = await API.getTransactions(accountId);
    this.render();
  },

  selectedIds: new Set(),

  render() {
    const container = document.getElementById('transactionsList');

    // Get pending recurring items for current account
    const pendingRecurring = Accounts.current ? Recurring.getPendingForAccount(Accounts.current.id) : [];

    if (this.list.length === 0 && pendingRecurring.length === 0) {
      container.innerHTML = '<p class="empty-state">No transactions yet. Click "Add Transaction" to get started.</p>';
      this.updateSelectionUI();
      return;
    }

    let html = '';

    // Render pending recurring section if there are any
    if (pendingRecurring.length > 0) {
      html += `
        <div class="pending-recurring-section">
          <div class="pending-recurring-header">
            <span class="pending-recurring-title">UPCOMING PAYMENTS</span>
            <span class="pending-recurring-count">${pendingRecurring.length}</span>
          </div>
          <div class="pending-recurring-items">
            ${pendingRecurring.map(item => this.renderPendingRecurring(item)).join('')}
          </div>
        </div>
      `;
    }

    // Group transactions by date
    const grouped = this.groupByDate(this.list);

    html += Object.entries(grouped).map(([date, transactions]) => {
      const dateObj = new Date(date);
      const dateStr = dateObj.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      }).toUpperCase();
      const dayTotal = transactions.reduce((sum, tx) => sum + tx.amount, 0);
      const totalClass = dayTotal < 0 ? 'negative' : 'positive';

      return `
        <div class="transaction-group" data-date="${date}">
          <div class="transaction-group-header">
            <div class="group-header-left">
              <input type="checkbox" class="group-checkbox" data-date="${date}">
              <span class="group-date">${dateStr}</span>
              <span class="group-count">${transactions.length}</span>
            </div>
            <span class="group-total ${totalClass}">${App.formatCurrency(dayTotal)}</span>
          </div>
          <div class="transaction-group-items">
            ${transactions.map(tx => this.renderTransaction(tx)).join('')}
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = html;

    this.bindEventHandlers(container);
    this.bindPendingHandlers(container);
    this.updateSelectionUI();
  },

  renderPendingRecurring(item) {
    const amountClass = item.amount < 0 ? 'negative' : 'positive';
    const initial = (item.payee || 'R')[0].toUpperCase();
    const categoryClass = this.getCategoryClass(item.category);
    const categoryEmoji = this.getCategoryEmoji(item.category);
    const freqText = Recurring.getFrequencyText(item.frequency);
    const upcomingClass = item.isUpcoming ? 'upcoming' : '';
    const statusLabel = item.isUpcoming ? 'Coming up' : 'Due';

    return `
      <div class="pending-recurring-item ${upcomingClass}" data-recurring-id="${item.recurringId}" data-offset="${item.occurrenceOffset}">
        <div class="transaction-avatar pending-avatar">
          <span class="avatar-letter">${initial}</span>
        </div>
        <div class="transaction-details">
          <div class="transaction-payee">${item.payee}</div>
          <div class="transaction-freq">${freqText} &middot; ${statusLabel}</div>
        </div>
        <div class="transaction-category-badge ${categoryClass}">
          <span class="category-emoji">${categoryEmoji}</span>
          ${item.category}
        </div>
        <div class="pending-editable">
          <input type="date" class="pending-date-input" value="${item.dueDate}">
          <input type="number" class="pending-amount-input" value="${item.amount}" step="0.01">
        </div>
        <div class="pending-actions">
          <button class="btn-icon btn-approve" title="Approve">✓</button>
          <button class="btn-icon btn-skip" title="Skip">✗</button>
        </div>
      </div>
    `;
  },

  bindPendingHandlers(container) {
    container.querySelectorAll('.pending-recurring-item').forEach(item => {
      const recurringId = item.dataset.recurringId;

      // Approve button
      item.querySelector('.btn-approve')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const dateInput = item.querySelector('.pending-date-input');
        const amountInput = item.querySelector('.pending-amount-input');
        await Recurring.approvePending(recurringId, dateInput.value, parseFloat(amountInput.value));
      });

      // Skip button
      item.querySelector('.btn-skip')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await Recurring.skipPending(recurringId);
      });
    });
  },

  groupByDate(transactions) {
    const groups = {};
    for (const tx of transactions) {
      if (!groups[tx.date]) {
        groups[tx.date] = [];
      }
      groups[tx.date].push(tx);
    }
    return groups;
  },

  renderTransaction(tx) {
    const amountClass = tx.amount < 0 ? 'negative' : 'positive';
    const isTransfer = tx.transferId ? 'transfer' : '';
    const isSelected = this.selectedIds.has(tx.id) ? 'selected' : '';
    const initial = (tx.payee || 'U')[0].toUpperCase();
    const categoryClass = this.getCategoryClass(tx.category);
    const categoryEmoji = this.getCategoryEmoji(tx.category);

    return `
      <div class="transaction-item ${isTransfer} ${isSelected}" data-id="${tx.id}">
        <input type="checkbox" class="transaction-checkbox" ${this.selectedIds.has(tx.id) ? 'checked' : ''}>
        <div class="transaction-avatar">
          <span class="avatar-letter">${initial}</span>
        </div>
        <div class="transaction-details">
          <div class="transaction-payee">${tx.payee}</div>
          <div class="transaction-account">${Accounts.current?.name || ''}</div>
        </div>
        <div class="transaction-category-badge ${categoryClass}">
          <span class="category-emoji">${categoryEmoji}</span>
          ${tx.category}
        </div>
        <div class="transaction-amount ${amountClass}">${App.formatCurrency(tx.amount)}</div>
        <div class="transaction-actions">
          <button class="btn-icon btn-edit" title="Edit">✎</button>
          <button class="btn-icon btn-danger btn-delete" title="Delete">✕</button>
        </div>
      </div>
    `;
  },

  getCategoryClass(category) {
    // Get category info from Categories module if available
    if (typeof Categories !== 'undefined' && Categories.list.length > 0) {
      const info = Categories.getCategoryInfo(category);
      if (info.category) {
        // Map master category to color class
        const colorMap = {
          'Food & Drink': 'cat-orange',
          'Bills & Utilities': 'cat-yellow',
          'Housing': 'cat-blue',
          'Transport': 'cat-indigo',
          'Shopping': 'cat-pink',
          'Entertainment': 'cat-purple',
          'Health & Wellbeing': 'cat-red',
          'Insurance': 'cat-teal',
          'Travel & Holidays': 'cat-cyan',
          'Children': 'cat-rose',
          'Pets': 'cat-amber',
          'Income': 'cat-emerald',
          'Savings & Investments': 'cat-green',
          'Fees & Charges': 'cat-slate',
          'Subscriptions': 'cat-violet',
          'Education': 'cat-sky',
          'Charity & Donations': 'cat-fuchsia',
          'Transfer': 'cat-indigo',
          'Uncategorized': 'cat-gray'
        };
        return colorMap[info.category.name] || 'cat-gray';
      }
    }

    // Fallback color map for when categories not loaded
    const fallbackMap = {
      'Transfer': 'cat-indigo',
      'Uncategorized': 'cat-gray'
    };
    return fallbackMap[category] || 'cat-gray';
  },

  getCategoryEmoji(category) {
    if (typeof Categories !== 'undefined' && Categories.list.length > 0) {
      const info = Categories.getCategoryInfo(category);
      return info.emoji || '❓';
    }
    return '❓';
  },

  bindEventHandlers(container) {
    // Transaction item handlers
    container.querySelectorAll('.transaction-item').forEach(item => {
      const id = item.dataset.id;

      // Checkbox
      item.querySelector('.transaction-checkbox').addEventListener('change', (e) => {
        e.stopPropagation();
        this.toggleSelection(id);
      });

      // Edit button
      item.querySelector('.btn-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        this.edit(id);
      });

      // Delete button
      item.querySelector('.btn-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        this.confirmDelete(id);
      });

      // Click on row to toggle selection
      item.addEventListener('click', (e) => {
        if (e.target.closest('.btn-icon') || e.target.type === 'checkbox') return;
        this.toggleSelection(id);
      });
    });

    // Group checkbox handlers
    container.querySelectorAll('.group-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const date = e.target.dataset.date;
        this.toggleGroupSelection(date, e.target.checked);
      });
    });
  },

  toggleSelection(id) {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
    this.updateSelectionUI();
  },

  toggleGroupSelection(date, selected) {
    const transactions = this.list.filter(tx => tx.date === date);
    for (const tx of transactions) {
      if (selected) {
        this.selectedIds.add(tx.id);
      } else {
        this.selectedIds.delete(tx.id);
      }
    }
    this.updateSelectionUI();
  },

  clearSelection() {
    this.selectedIds.clear();
    this.updateSelectionUI();
  },

  updateSelectionUI() {
    const count = this.selectedIds.size;
    const toolbar = document.getElementById('selectionToolbar');
    const countEl = document.getElementById('selectedCount');
    const convertBtn = document.getElementById('convertToTransferBtn');
    const unlinkBtn = document.getElementById('unlinkTransferBtn');

    if (count > 0) {
      toolbar.classList.remove('hidden');
      countEl.textContent = `${count} selected`;

      // Check what types are selected
      const selectedTxs = this.list.filter(tx => this.selectedIds.has(tx.id));
      const hasNonTransfers = selectedTxs.some(tx => !tx.transferId);
      const hasTransfers = selectedTxs.some(tx => tx.transferId);

      // Show/hide buttons based on selection
      convertBtn.classList.toggle('hidden', !hasNonTransfers);
      unlinkBtn.classList.toggle('hidden', !hasTransfers);
    } else {
      toolbar.classList.add('hidden');
    }

    // Update checkboxes
    document.querySelectorAll('.transaction-item').forEach(item => {
      const id = item.dataset.id;
      const checkbox = item.querySelector('.transaction-checkbox');
      const isSelected = this.selectedIds.has(id);
      checkbox.checked = isSelected;
      item.classList.toggle('selected', isSelected);
    });

    // Update group checkboxes
    document.querySelectorAll('.group-checkbox').forEach(checkbox => {
      const date = checkbox.dataset.date;
      const groupTxs = this.list.filter(tx => tx.date === date);
      const allSelected = groupTxs.length > 0 && groupTxs.every(tx => this.selectedIds.has(tx.id));
      const someSelected = groupTxs.some(tx => this.selectedIds.has(tx.id));
      checkbox.checked = allSelected;
      checkbox.indeterminate = someSelected && !allSelected;
    });
  },

  async showModal(transaction = null) {
    this.currentEdit = transaction;
    const modal = document.getElementById('transactionModal');
    const title = document.getElementById('transactionModalTitle');

    title.textContent = transaction ? 'Edit Transaction' : 'Add Transaction';

    // Load categories
    await Categories.loadSelect('transactionCategory', transaction?.category);

    // Load payees for autocomplete
    await this.loadPayeeDatalist();

    // Fill form
    const payeeInput = document.getElementById('transactionPayee');
    payeeInput.value = transaction?.payee || '';
    document.getElementById('transactionAmount').value = transaction?.amount || '';
    document.getElementById('transactionDate').value = transaction?.date || new Date().toISOString().split('T')[0];
    document.getElementById('transactionDescription').value = transaction?.description || '';
    document.getElementById('transactionNotes').value = transaction?.notes || '';

    // Set up payee auto-fill for category (only for new transactions)
    this.setupPayeeCategoryAutofill(payeeInput, !transaction);

    modal.classList.remove('hidden');
  },

  setupPayeeCategoryAutofill(payeeInput, isNewTransaction) {
    // Remove any existing listener by cloning and replacing
    const newInput = payeeInput.cloneNode(true);
    payeeInput.parentNode.replaceChild(newInput, payeeInput);

    if (isNewTransaction) {
      newInput.addEventListener('change', async (e) => {
        const payeeName = e.target.value.trim();
        if (!payeeName) return;

        const categorySelect = document.getElementById('transactionCategory');
        const currentCategory = categorySelect.value;

        // Only auto-fill if category is still default (first option or Uncategorized)
        const isDefaultCategory = categorySelect.selectedIndex === 0 ||
          currentCategory === 'Uncategorized';

        if (isDefaultCategory) {
          const result = await API.getPayeeLastCategory(payeeName);
          if (result.category) {
            categorySelect.value = result.category;
          }
        }
      });
    }
  },

  async loadPayeeDatalist() {
    const payees = await API.getPayees();
    const datalist = document.getElementById('payeeDatalist');
    datalist.innerHTML = payees.map(p => `<option value="${p.name}"></option>`).join('');
  },

  hideModal() {
    document.getElementById('transactionModal').classList.add('hidden');
    this.currentEdit = null;
  },

  async save(formData) {
    const accountId = Accounts.current.id;

    // Auto-add payee if it doesn't exist
    await this.ensurePayeeExists(formData.payee);

    if (this.currentEdit) {
      await API.updateTransaction(accountId, this.currentEdit.id, formData);
    } else {
      await API.createTransaction(accountId, formData);
    }

    await this.load(accountId);
    await Accounts.updateBalance();
    this.hideModal();
  },

  async ensurePayeeExists(payeeName) {
    if (!payeeName || !payeeName.trim()) return;

    const payees = await API.getPayees();
    const exists = payees.some(p => p.name.toLowerCase() === payeeName.trim().toLowerCase());

    if (!exists) {
      await API.createPayee({ name: payeeName.trim() });
    }
  },

  edit(id) {
    const transaction = this.list.find(t => t.id === id);
    if (transaction) {
      this.showModal(transaction);
    }
  },

  confirmDelete(id) {
    const transaction = this.list.find(t => t.id === id);
    if (!transaction) return;

    let message = `Delete transaction "${transaction.payee}" for ${App.formatCurrency(transaction.amount)}?`;
    if (transaction.transferId) {
      message += '\n\nThis is a transfer. The linked transaction will also be deleted.';
    }

    App.confirm('Delete Transaction', message, async () => {
      await API.deleteTransaction(Accounts.current.id, id);
      await this.load(Accounts.current.id);
      await Accounts.updateBalance();
    });
  }
};

// Transfer handling
const Transfers = {
  async showModal() {
    const modal = document.getElementById('transferModal');
    const accounts = Accounts.list;

    if (accounts.length < 2) {
      alert('You need at least 2 accounts to make a transfer.');
      return;
    }

    // Populate account selects
    const fromSelect = document.getElementById('transferFrom');
    const toSelect = document.getElementById('transferTo');

    const options = accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
    fromSelect.innerHTML = options;
    toSelect.innerHTML = options;

    // Default: current account as "from", first other as "to"
    if (Accounts.current) {
      fromSelect.value = Accounts.current.id;
      const otherAccount = accounts.find(a => a.id !== Accounts.current.id);
      if (otherAccount) toSelect.value = otherAccount.id;
    }

    document.getElementById('transferAmount').value = '';
    document.getElementById('transferDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('transferDescription').value = '';
    document.getElementById('transferNotes').value = '';

    modal.classList.remove('hidden');
  },

  hideModal() {
    document.getElementById('transferModal').classList.add('hidden');
  },

  async save(formData) {
    if (formData.fromAccountId === formData.toAccountId) {
      alert('Cannot transfer to the same account.');
      return;
    }

    await API.createTransfer(formData);

    // Reload current account if it was involved
    if (Accounts.current) {
      await Transactions.load(Accounts.current.id);
      await Accounts.updateBalance();
    }

    this.hideModal();
  }
};

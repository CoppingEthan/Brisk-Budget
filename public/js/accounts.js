// Account Management
const Accounts = {
  list: [],
  groups: [],
  current: null,
  pendingIcon: null,
  pendingGroupIcon: null,
  draggedItem: null,
  draggedType: null, // 'account' or 'group'
  draggedSourceGroupId: null,
  _groupDragHandle: null, // tracks which group element initiated drag via handle
  _mouseupBound: false,
  editingGroupId: null,

  async load() {
    this.list = await API.getAccounts();
    this.groups = await API.getAccountGroups();
    // Pre-fetch balances for all accounts so sidebar shows correct values
    await this.refreshAllBalances();
    this.render();
  },

  getCollapsedGroups() {
    try {
      return JSON.parse(localStorage.getItem('briskBudget_collapsedGroups') || '{}');
    } catch { return {}; }
  },

  setCollapsedGroup(groupId, collapsed) {
    const state = this.getCollapsedGroups();
    state[groupId] = collapsed;
    localStorage.setItem('briskBudget_collapsedGroups', JSON.stringify(state));
  },

  // Build ordered top-level items (groups + ungrouped accounts interleaved by sortOrder)
  buildSidebarItems() {
    const groupedAccountIds = new Set();
    const groupAccountsMap = {};

    for (const group of this.groups) {
      groupAccountsMap[group.id] = [];
    }

    for (const account of this.list) {
      if (account.groupId && groupAccountsMap[account.groupId]) {
        groupAccountsMap[account.groupId].push(account);
        groupedAccountIds.add(account.id);
      }
    }

    // Sort accounts within each group
    for (const groupId of Object.keys(groupAccountsMap)) {
      groupAccountsMap[groupId].sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
    }

    // Build top-level items
    const items = [];
    for (const group of this.groups) {
      items.push({ type: 'group', group, accounts: groupAccountsMap[group.id] });
    }
    for (const account of this.list) {
      if (!groupedAccountIds.has(account.id)) {
        items.push({ type: 'account', account });
      }
    }

    items.sort((a, b) => {
      const orderA = a.type === 'group' ? (a.group.sortOrder ?? Infinity) : (a.account.sortOrder ?? Infinity);
      const orderB = b.type === 'group' ? (b.group.sortOrder ?? Infinity) : (b.account.sortOrder ?? Infinity);
      return orderA - orderB;
    });

    return items;
  },

  getGroupBalance(accounts) {
    return accounts.reduce((sum, a) => sum + (a._cachedBalance ?? a.startingBalance), 0);
  },

  getGroupBalanceClass(balance) {
    if (balance === 0) return '';
    return balance < 0 ? 'negative' : 'positive';
  },

  render() {
    const container = document.getElementById('accountsList');
    if (this.list.length === 0 && this.groups.length === 0) {
      container.innerHTML = '<p class="empty-state" style="padding: 1rem 1.5rem; font-size: 0.875rem;">No accounts yet</p>';
      return;
    }

    const items = this.buildSidebarItems();
    const collapsedState = this.getCollapsedGroups();

    let html = '';

    for (const item of items) {
      if (item.type === 'group') {
        const group = item.group;
        const accounts = item.accounts;
        const isExpanded = !collapsedState[group.id];
        const expandedClass = isExpanded ? 'expanded' : '';
        const groupBalance = this.getGroupBalance(accounts);
        const balanceClass = this.getGroupBalanceClass(groupBalance);

        const groupIconHtml = group.icon
          ? `<div class="account-group-icon"><img src="${group.icon}" alt=""></div>`
          : '';

        html += `
          <div class="account-group ${expandedClass}" data-group-id="${group.id}" draggable="true">
            <div class="account-group-header" data-group-id="${group.id}">
              <div class="drag-handle">&#8942;&#8942;</div>
              <span class="account-group-chevron">&#9656;</span>
              ${groupIconHtml}
              <span class="account-group-name">${group.name}</span>
              <span class="account-group-balance ${balanceClass}">${App.formatCurrency(groupBalance)}</span>
              <div class="account-group-actions">
                <button class="btn-icon btn-edit-group" data-group-id="${group.id}" title="Edit">&#9998;</button>
                <button class="btn-icon btn-danger btn-delete-group" data-group-id="${group.id}" title="Delete">&#10005;</button>
              </div>
            </div>
            <div class="account-group-children">
        `;

        if (accounts.length === 0) {
          html += '<div class="account-group-empty">Drag accounts here</div>';
        } else {
          for (const account of accounts) {
            html += this.renderAccountItem(account);
          }
        }

        html += '</div></div>';
      } else {
        html += this.renderAccountItem(item.account);
      }
    }

    container.innerHTML = html;

    this.bindAccountClickHandlers(container);
    this.bindDragAndDrop(container);
  },

  renderAccountItem(account) {
    const balance = this.getDisplayBalance(account);
    let balanceClass = '';
    if (balance !== 0) {
      if (account.type === 'credit' || account.type === 'loan') {
        balanceClass = balance > 0 ? 'negative' : 'positive';
      } else {
        balanceClass = balance < 0 ? 'negative' : 'positive';
      }
    }
    const isActive = this.current?.id === account.id ? 'active' : '';
    const iconHtml = this.getIconHtml(account, 'small');

    return `
      <div class="account-item ${isActive}" data-id="${account.id}" draggable="true">
        <div class="drag-handle">&#8942;&#8942;</div>
        <div class="account-item-info">
          ${iconHtml}
          <span class="account-item-name">${account.name}</span>
        </div>
        <span class="account-item-balance ${balanceClass}">${App.formatCurrency(balance)}</span>
      </div>
    `;
  },

  bindAccountClickHandlers(container) {
    // Account item click
    container.querySelectorAll('.account-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('drag-handle')) return;
        const id = item.dataset.id;
        this.select(id);
      });
    });

    // Group header click (expand/collapse)
    container.querySelectorAll('.account-group-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.classList.contains('drag-handle')) return;
        if (e.target.closest('.account-group-actions')) return;
        const groupId = header.dataset.groupId;
        this.toggleGroup(groupId);
      });
    });

    // Group edit buttons
    container.querySelectorAll('.btn-edit-group').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const groupId = btn.dataset.groupId;
        const group = this.groups.find(g => g.id === groupId);
        if (group) this.showGroupModal(group);
      });
    });

    // Group delete buttons
    container.querySelectorAll('.btn-delete-group').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const groupId = btn.dataset.groupId;
        const group = this.groups.find(g => g.id === groupId);
        if (group) {
          App.confirm(
            'Delete Group',
            `Delete group "${group.name}"? Accounts in this group will become ungrouped.`,
            () => this.deleteGroup(groupId)
          );
        }
      });
    });
  },

  bindDragAndDrop(container) {
    // Account item drag
    container.querySelectorAll('.account-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        e.stopPropagation(); // Prevent bubbling to parent .account-group's dragstart
        this.draggedItem = item;
        this.draggedType = 'account';
        // Track which group (if any) this account is in
        const parentGroup = item.closest('.account-group');
        this.draggedSourceGroupId = parentGroup ? parentGroup.dataset.groupId : null;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.id);
      });

      item.addEventListener('dragend', (e) => {
        e.stopPropagation();
        item.classList.remove('dragging');
        this.draggedItem = null;
        this.draggedType = null;
        this.draggedSourceGroupId = null;
        this.clearDragStyles(container);
      });

      // Account-on-account drop (reorder)
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.draggedType === 'account' && this.draggedItem !== item) {
          item.classList.add('drag-over');
        }
      });

      item.addEventListener('dragleave', (e) => {
        e.stopPropagation();
        item.classList.remove('drag-over');
      });

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.classList.remove('drag-over');
        if (this.draggedType === 'account' && this.draggedItem !== item) {
          this.handleAccountDrop(item);
        }
      });
    });

    // Bind global mouseup once to clear stale drag handle state
    if (!this._mouseupBound) {
      document.addEventListener('mouseup', () => { this._groupDragHandle = null; });
      this._mouseupBound = true;
    }

    // Group header drag (reorder groups)
    container.querySelectorAll('.account-group').forEach(groupEl => {
      const handle = groupEl.querySelector('.account-group-header .drag-handle');

      if (handle) {
        handle.addEventListener('mousedown', () => {
          this._groupDragHandle = groupEl;
        });
      }

      groupEl.addEventListener('dragstart', (e) => {
        // Only start group drag from the header's drag handle
        if (this._groupDragHandle !== groupEl) { e.preventDefault(); return; }
        this._groupDragHandle = null;
        this.draggedItem = groupEl;
        this.draggedType = 'group';
        groupEl.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', groupEl.dataset.groupId);
      });

      groupEl.addEventListener('dragend', () => {
        groupEl.classList.remove('dragging');
        this.draggedItem = null;
        this.draggedType = null;
        this.clearDragStyles(container);
      });
    });

    // Group header as drop target (for dropping accounts into group or reordering groups)
    container.querySelectorAll('.account-group-header').forEach(header => {
      header.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.draggedType === 'account') {
          header.classList.add('drag-over');
        } else if (this.draggedType === 'group') {
          const targetGroup = header.closest('.account-group');
          if (targetGroup !== this.draggedItem) {
            targetGroup.classList.add('drag-over-top');
          }
        }
      });

      header.addEventListener('dragleave', (e) => {
        e.stopPropagation();
        header.classList.remove('drag-over');
        header.closest('.account-group')?.classList.remove('drag-over-top');
      });

      header.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        header.classList.remove('drag-over');
        const targetGroup = header.closest('.account-group');
        targetGroup?.classList.remove('drag-over-top');

        if (this.draggedType === 'account') {
          const groupId = header.dataset.groupId;
          const accountId = this.draggedItem.dataset.id;
          this.moveAccountToGroup(accountId, groupId);
        } else if (this.draggedType === 'group' && targetGroup !== this.draggedItem) {
          this.handleGroupReorder(targetGroup);
        }
      });
    });

    // Group children area as drop target (for dropping accounts into group body)
    container.querySelectorAll('.account-group-children').forEach(children => {
      children.addEventListener('dragover', (e) => {
        if (this.draggedType !== 'account') return;
        // Only handle if the drop is on the container itself or the empty placeholder
        if (e.target === children || e.target.classList.contains('account-group-empty')) {
          e.preventDefault();
          e.stopPropagation();
          const header = children.closest('.account-group')?.querySelector('.account-group-header');
          if (header) header.classList.add('drag-over');
        }
      });

      children.addEventListener('dragleave', (e) => {
        e.stopPropagation();
        const header = children.closest('.account-group')?.querySelector('.account-group-header');
        if (header) header.classList.remove('drag-over');
      });

      children.addEventListener('drop', (e) => {
        if (this.draggedType !== 'account') return;
        if (e.target === children || e.target.classList.contains('account-group-empty')) {
          e.preventDefault();
          e.stopPropagation();
          const groupEl = children.closest('.account-group');
          const header = groupEl?.querySelector('.account-group-header');
          if (header) header.classList.remove('drag-over');
          const groupId = groupEl?.dataset.groupId;
          const accountId = this.draggedItem.dataset.id;
          if (groupId) this.moveAccountToGroup(accountId, groupId);
        }
      });
    });

    // Root container as drop zone (for ungrouping accounts)
    container.addEventListener('dragover', (e) => {
      if (this.draggedType !== 'account') return;
      // Only trigger if dropping directly on the container (not on a child)
      if (e.target === container || e.target.classList.contains('accounts-list')) {
        e.preventDefault();
      }
    });

    container.addEventListener('drop', (e) => {
      if (this.draggedType !== 'account') return;
      if (e.target === container || e.target.classList.contains('accounts-list')) {
        e.preventDefault();
        const accountId = this.draggedItem.dataset.id;
        const account = this.list.find(a => a.id === accountId);
        if (account && account.groupId) {
          this.moveAccountToGroup(accountId, null);
        }
      }
    });
  },

  clearDragStyles(container) {
    container.querySelectorAll('.drag-over, .drag-over-top').forEach(el => {
      el.classList.remove('drag-over', 'drag-over-top');
    });
  },

  async handleAccountDrop(targetItem) {
    const draggedId = this.draggedItem.dataset.id;
    const targetId = targetItem.dataset.id;
    const draggedAccount = this.list.find(a => a.id === draggedId);
    const targetAccount = this.list.find(a => a.id === targetId);
    if (!draggedAccount || !targetAccount) return;

    // If dropping on an account in a different group, move to that group
    const targetGroupEl = targetItem.closest('.account-group');
    const targetGroupId = targetGroupEl ? targetGroupEl.dataset.groupId : null;

    if ((draggedAccount.groupId || null) !== (targetGroupId || null)) {
      // Move to the target's group
      await this.moveAccountToGroup(draggedId, targetGroupId);
      return;
    }

    // Same group (or both ungrouped) - reorder
    if (targetGroupId) {
      // Reorder within group
      const groupAccounts = this.list
        .filter(a => a.groupId === targetGroupId)
        .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
      const dragIdx = groupAccounts.findIndex(a => a.id === draggedId);
      const targetIdx = groupAccounts.findIndex(a => a.id === targetId);
      if (dragIdx === -1 || targetIdx === -1) return;
      const [removed] = groupAccounts.splice(dragIdx, 1);
      groupAccounts.splice(targetIdx, 0, removed);
      await API.reorderAccounts(groupAccounts.map(a => a.id));
    } else {
      // Reorder ungrouped accounts — build order from current sidebar layout
      const currentItems = this.buildSidebarItems();
      const ungrouped = currentItems.filter(i => i.type === 'account').map(i => i.account);
      const dragIdx = ungrouped.findIndex(a => a.id === draggedId);
      const targetIdx = ungrouped.findIndex(a => a.id === targetId);
      if (dragIdx === -1 || targetIdx === -1) return;
      const [removed] = ungrouped.splice(dragIdx, 1);
      ungrouped.splice(targetIdx, 0, removed);

      // Rebuild full order preserving group positions with rearranged ungrouped
      let ungroupedIdx = 0;
      const order = currentItems.map(item => {
        if (item.type === 'group') {
          return { type: 'group', id: item.group.id };
        }
        return { type: 'account', id: ungrouped[ungroupedIdx++].id };
      });
      await API.reorderAccountGroups(order);
    }
    await this.load();
  },

  async handleGroupReorder(targetGroupEl) {
    const items = this.buildSidebarItems();
    const draggedGroupId = this.draggedItem.dataset.groupId;
    const targetGroupId = targetGroupEl.dataset.groupId;

    const dragIdx = items.findIndex(i => i.type === 'group' && i.group.id === draggedGroupId);
    const targetIdx = items.findIndex(i => i.type === 'group' && i.group.id === targetGroupId);
    if (dragIdx === -1 || targetIdx === -1) return;

    const [removed] = items.splice(dragIdx, 1);
    items.splice(targetIdx, 0, removed);

    // Build order array
    const order = items.map(item => ({
      type: item.type,
      id: item.type === 'group' ? item.group.id : item.account.id
    }));

    await API.reorderAccountGroups(order);
    await this.load();
  },

  async moveAccountToGroup(accountId, groupId) {
    await API.setAccountGroup(accountId, groupId);
    await this.load();
  },

  async saveTopLevelOrder() {
    const items = this.buildSidebarItems();
    const order = items.map(item => ({
      type: item.type,
      id: item.type === 'group' ? item.group.id : item.account.id
    }));
    await API.reorderAccountGroups(order);
  },

  toggleGroup(groupId) {
    const collapsed = this.getCollapsedGroups();
    const isCurrentlyCollapsed = !!collapsed[groupId];
    this.setCollapsedGroup(groupId, !isCurrentlyCollapsed);

    // Toggle visually without full re-render
    const groupEl = document.querySelector(`.account-group[data-group-id="${groupId}"]`);
    if (groupEl) {
      groupEl.classList.toggle('expanded', isCurrentlyCollapsed);
    }
  },

  // Group modal
  showGroupModal(group = null) {
    this.editingGroupId = group?.id || null;
    const modal = document.getElementById('accountGroupModal');
    const title = document.getElementById('accountGroupModalTitle');
    const deleteBtn = document.getElementById('deleteGroupModalBtn');

    title.textContent = group ? 'Edit Group' : 'Create Group';
    document.getElementById('groupNameInput').value = group?.name || '';

    // Handle icon
    this.pendingGroupIcon = group?.icon || null;
    this.updateGroupIconPreview();

    if (group) {
      deleteBtn.classList.remove('hidden');
    } else {
      deleteBtn.classList.add('hidden');
    }

    modal.classList.remove('hidden');
    document.getElementById('groupNameInput').focus();
  },

  updateGroupIconPreview() {
    const preview = document.getElementById('groupIconPreview');
    const removeBtn = document.getElementById('removeGroupIconBtn');

    if (this.pendingGroupIcon) {
      preview.innerHTML = `<img src="${this.pendingGroupIcon}" alt="">`;
      preview.classList.add('has-icon');
      removeBtn.style.display = 'block';
    } else {
      preview.innerHTML = '<span class="icon-placeholder">+</span>';
      preview.classList.remove('has-icon');
      removeBtn.style.display = 'none';
    }
  },

  hideGroupModal() {
    document.getElementById('accountGroupModal').classList.add('hidden');
    this.editingGroupId = null;
    this.pendingGroupIcon = null;
  },

  async saveGroup(formData) {
    formData.icon = this.pendingGroupIcon || null;

    if (this.editingGroupId) {
      await API.updateAccountGroup(this.editingGroupId, formData);
    } else {
      await API.createAccountGroup(formData);
    }
    await this.load();
    this.hideGroupModal();
  },

  async deleteGroup(groupId) {
    await API.deleteAccountGroup(groupId);
    await this.load();
  },

  getIconHtml(account, size = 'small') {
    const className = size === 'small' ? 'account-item-icon' : 'account-header-icon';
    if (account.icon) {
      return `<div class="${className}"><img src="${account.icon}" alt=""></div>`;
    }
    const letter = account.name.charAt(0);
    return `<div class="${className}"><span class="icon-letter">${letter}</span></div>`;
  },

  async select(id) {
    this.current = this.list.find(a => a.id === id);
    if (!this.current) return;

    // Close mobile menu if open
    if (window.innerWidth <= 1400 && typeof App.closeMobileMenu === 'function') {
      App.closeMobileMenu();
    }

    // Update sidebar
    document.querySelectorAll('.account-item').forEach(item => {
      item.classList.toggle('active', item.dataset.id === id);
    });
    document.querySelector('.nav-dashboard').classList.remove('active');

    // Show account view
    document.getElementById('dashboardView').classList.add('hidden');
    document.getElementById('accountView').classList.remove('hidden');

    // Update header with icon
    this.updateHeaderDisplay();

    // Load transactions
    await Transactions.load(id);
    this.updateBalance();
  },

  updateHeaderDisplay() {
    if (!this.current) return;

    // Update account name
    const nameEl = document.getElementById('accountName');
    if (nameEl) {
      nameEl.textContent = this.current.name;
    }

    // Update account type badge
    const typeBadge = document.getElementById('accountTypeBadge');
    if (typeBadge) {
      typeBadge.textContent = this.current.type;
    }

    // Update or add the account icon in the name row
    const nameRow = document.querySelector('.account-name-row');
    if (nameRow) {
      // Remove existing icon if present
      const existingIcon = nameRow.querySelector('.account-header-icon');
      if (existingIcon) {
        existingIcon.remove();
      }

      // Create and insert new icon before the h2
      const iconHtml = this.getIconHtml(this.current, 'large');
      const iconWrapper = document.createElement('div');
      iconWrapper.innerHTML = iconHtml;
      const iconEl = iconWrapper.firstElementChild;
      if (iconEl) {
        nameRow.insertBefore(iconEl, nameRow.firstChild);
      }
    }
  },

  async getAccountBalance(account) {
    const transactions = await API.getTransactions(account.id);
    const transactionTotal = transactions.reduce((sum, t) => sum + t.amount, 0);
    return account.startingBalance + transactionTotal;
  },

  getDisplayBalance(account) {
    if (account._cachedBalance !== undefined) {
      return this.formatForDisplay(account, account._cachedBalance);
    }
    return this.formatForDisplay(account, account.startingBalance);
  },

  formatForDisplay(account, balance) {
    if (account.type === 'credit' || account.type === 'loan') {
      return -balance;
    }
    return balance;
  },

  async updateBalance() {
    // Update all account balances to ensure sidebar is always current
    await this.refreshAllBalances();

    if (!this.current) return;

    const displayBalance = this.formatForDisplay(this.current, this.current._cachedBalance);

    const balanceEl = document.getElementById('accountBalance');
    const balanceBadge = document.getElementById('balanceBadge');
    balanceEl.textContent = App.formatCurrency(Math.abs(displayBalance));
    balanceEl.className = 'stat-value';

    // Only add color class if not zero
    if (this.current._cachedBalance !== 0) {
      if (this.current.type === 'credit' || this.current.type === 'loan') {
        if (displayBalance > 0) {
          balanceEl.classList.add('negative');
        }
      } else {
        if (this.current._cachedBalance < 0) {
          balanceEl.classList.add('negative');
        } else if (this.current._cachedBalance > 0) {
          balanceEl.classList.add('positive');
        }
      }
    }

    // Update asset value display for loan/investment/asset types
    this.updateAssetValueDisplay();

    this.render();
  },

  updateAssetValueDisplay() {
    const assetValueBadge = document.getElementById('assetValueBadge');
    const equityBadge = document.getElementById('equityBadge');
    const assetTypes = ['loan', 'investment', 'asset'];

    if (!this.current || !assetTypes.includes(this.current.type) || !this.current.assetValue) {
      assetValueBadge.classList.add('hidden');
      equityBadge.classList.add('hidden');
      return;
    }

    // Show asset value
    assetValueBadge.classList.remove('hidden');
    document.getElementById('accountAssetValue').textContent = App.formatCurrency(this.current.assetValue);

    // Calculate and show equity (asset value + balance)
    const equity = this.current.assetValue + this.current._cachedBalance;

    equityBadge.classList.remove('hidden');
    const equityEl = document.getElementById('accountEquity');
    equityEl.textContent = App.formatCurrency(equity);
    equityEl.className = 'stat-value';
    if (equity > 0) {
      equityEl.classList.add('positive');
    } else if (equity < 0) {
      equityEl.classList.add('negative');
    }
  },

  async refreshAllBalances() {
    // Fetch and cache balances for all accounts in parallel
    await Promise.all(this.list.map(async (account) => {
      const transactions = await API.getTransactions(account.id);
      const transactionTotal = transactions.reduce((sum, t) => sum + t.amount, 0);
      account._cachedBalance = account.startingBalance + transactionTotal;
    }));
  },

  showModal(account = null) {
    const modal = document.getElementById('accountModal');
    const title = document.getElementById('accountModalTitle');
    const form = document.getElementById('accountForm');
    const deleteBtn = document.getElementById('deleteAccountModalBtn');

    title.textContent = account ? 'Edit Account' : 'Add Account';
    form.dataset.editId = account?.id || '';

    document.getElementById('accountNameInput').value = account?.name || '';
    document.getElementById('accountTypeInput').value = account?.type || 'bank';
    document.getElementById('startingBalanceInput').value = account?.startingBalance || 0;
    document.getElementById('assetValueInput').value = account?.assetValue || 0;

    // Show/hide asset value field based on type
    this.toggleAssetValueField(account?.type || 'bank');

    // Show/hide delete button (only when editing)
    if (account) {
      deleteBtn.classList.remove('hidden');
    } else {
      deleteBtn.classList.add('hidden');
    }

    // Handle icon
    this.pendingIcon = account?.icon || null;
    this.updateIconPreview();

    modal.classList.remove('hidden');
  },

  toggleAssetValueField(type) {
    const assetValueGroup = document.getElementById('assetValueGroup');
    const showForTypes = ['loan', 'investment', 'asset'];
    if (showForTypes.includes(type)) {
      assetValueGroup.classList.remove('hidden');
    } else {
      assetValueGroup.classList.add('hidden');
    }
  },

  updateIconPreview() {
    const preview = document.getElementById('accountIconPreview');
    const removeBtn = document.getElementById('removeIconBtn');

    if (this.pendingIcon) {
      preview.innerHTML = `<img src="${this.pendingIcon}" alt="">`;
      preview.classList.add('has-icon');
      removeBtn.style.display = 'block';
    } else {
      preview.innerHTML = '<span class="icon-placeholder">+</span>';
      preview.classList.remove('has-icon');
      removeBtn.style.display = 'none';
    }
  },

  async processIconFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 256;
          canvas.height = 256;
          const ctx = canvas.getContext('2d');

          const size = Math.min(img.width, img.height);
          const x = (img.width - size) / 2;
          const y = (img.height - size) / 2;

          ctx.drawImage(img, x, y, size, size, 0, 0, 256, 256);

          const base64 = canvas.toDataURL('image/jpeg', 0.85);
          resolve(base64);
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  hideModal() {
    document.getElementById('accountModal').classList.add('hidden');
    this.pendingIcon = null;
  },

  async save(formData) {
    const editId = document.getElementById('accountForm').dataset.editId;

    // Add icon to form data
    formData.icon = this.pendingIcon || null;

    if (editId) {
      await API.updateAccount(editId, formData);
    } else {
      await API.createAccount(formData);
    }

    await this.load();
    this.hideModal();

    if (editId && this.current?.id === editId) {
      this.current = this.list.find(a => a.id === editId);
      this.updateHeaderDisplay();
    }
  },

  async delete(id) {
    await API.deleteAccount(id);
    await this.load();

    if (this.current?.id === id) {
      this.current = null;
      document.getElementById('accountView').classList.add('hidden');
      document.getElementById('dashboardView').classList.remove('hidden');
      document.querySelector('.nav-dashboard').classList.add('active');
    }
  }
};

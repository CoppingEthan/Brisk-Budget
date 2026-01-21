// Account Management
const Accounts = {
  list: [],
  current: null,
  pendingIcon: null,
  draggedItem: null,

  async load() {
    this.list = await API.getAccounts();
    // Pre-fetch balances for all accounts so sidebar shows correct values
    await this.refreshAllBalances();
    this.render();
  },

  render() {
    const container = document.getElementById('accountsList');
    if (this.list.length === 0) {
      container.innerHTML = '<p class="empty-state" style="padding: 1rem 1.5rem; font-size: 0.875rem;">No accounts yet</p>';
      return;
    }

    container.innerHTML = this.list.map(account => {
      const balance = this.getDisplayBalance(account);
      let balanceClass = '';
      if (balance !== 0) {
        if (account.type === 'credit' || account.type === 'loan') {
          // For credit/loan: positive display = owed money = red, negative = overpaid = green
          balanceClass = balance > 0 ? 'negative' : 'positive';
        } else {
          // For bank/cash: positive = good = green, negative = overdrawn = red
          balanceClass = balance < 0 ? 'negative' : 'positive';
        }
      }
      const isActive = this.current?.id === account.id ? 'active' : '';
      const iconHtml = this.getIconHtml(account, 'small');

      return `
        <div class="account-item ${isActive}" data-id="${account.id}" draggable="true">
          <div class="drag-handle">⋮⋮</div>
          <div class="account-item-info">
            ${iconHtml}
            <span class="account-item-name">${account.name}</span>
          </div>
          <span class="account-item-balance ${balanceClass}">${App.formatCurrency(balance)}</span>
        </div>
      `;
    }).join('');

    // Add click handlers
    container.querySelectorAll('.account-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // Don't select when dragging
        if (e.target.classList.contains('drag-handle')) return;
        const id = item.dataset.id;
        this.select(id);
      });

      // Drag and drop handlers
      item.addEventListener('dragstart', (e) => {
        this.draggedItem = item;
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        this.draggedItem = null;
        container.querySelectorAll('.account-item').forEach(i => i.classList.remove('drag-over'));
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (this.draggedItem && this.draggedItem !== item) {
          item.classList.add('drag-over');
        }
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over');
      });

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        if (this.draggedItem && this.draggedItem !== item) {
          this.handleDrop(this.draggedItem, item);
        }
      });
    });
  },

  async handleDrop(draggedEl, targetEl) {
    const draggedId = draggedEl.dataset.id;
    const targetId = targetEl.dataset.id;

    // Find indices
    const draggedIndex = this.list.findIndex(a => a.id === draggedId);
    const targetIndex = this.list.findIndex(a => a.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    // Reorder the list
    const [removed] = this.list.splice(draggedIndex, 1);
    this.list.splice(targetIndex, 0, removed);

    // Re-render immediately for visual feedback
    this.render();

    // Save new order to server
    const accountIds = this.list.map(a => a.id);
    await API.reorderAccounts(accountIds);
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
    // For loans: positive balance means owed money (negative), so equity = assetValue - owed
    // Balance is stored negative for loans, so _cachedBalance is negative when you owe
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
          // Create canvas for cropping/resizing to 256x256
          const canvas = document.createElement('canvas');
          canvas.width = 256;
          canvas.height = 256;
          const ctx = canvas.getContext('2d');

          // Calculate crop dimensions (center crop to square)
          const size = Math.min(img.width, img.height);
          const x = (img.width - size) / 2;
          const y = (img.height - size) / 2;

          // Draw cropped and resized image
          ctx.drawImage(img, x, y, size, size, 0, 0, 256, 256);

          // Convert to base64 (JPEG for smaller size)
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

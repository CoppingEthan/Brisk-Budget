// Main Application
const App = {
  settings: { currencySymbol: '£' },

  async init() {
    await this.loadSettings();
    await Categories.load();
    await Accounts.load();
    await Recurring.load();
    this.bindEvents();
    this.initSidebarResize();
    this.initMobileMenu();
    Recurring.init();
    Dashboard.init();
    // Load dashboard on startup
    await Dashboard.load();
  },

  async loadSettings() {
    this.settings = await API.getSettings();
    this.updateWelcomeMessage();
  },

  updateWelcomeMessage() {
    const greetingEl = document.querySelector('.dashboard-greeting h2');
    if (greetingEl) {
      const name = this.settings.name;
      greetingEl.textContent = name ? `Welcome back, ${name}` : 'Welcome back';
    }
  },

  formatCurrency(amount) {
    const absAmount = Math.abs(amount);
    const formatted = absAmount.toLocaleString('en-GB', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    const sign = amount < 0 ? '-' : '';
    return `${sign}${this.settings.currencySymbol}${formatted}`;
  },

  bindEvents() {
    // Dashboard navigation
    document.querySelector('.nav-dashboard').addEventListener('click', (e) => {
      e.preventDefault();
      this.showDashboard();
    });

    // Add Account button
    document.getElementById('addAccountBtn').addEventListener('click', () => {
      Accounts.showModal();
    });

    // Account Modal
    this.bindModal('accountModal', 'accountForm', async (form) => {
      const type = form.querySelector('#accountTypeInput').value;
      const formData = {
        name: form.querySelector('#accountNameInput').value,
        type: type,
        startingBalance: parseFloat(form.querySelector('#startingBalanceInput').value) || 0
      };
      // Include assetValue for loan/investment/asset types
      if (['loan', 'investment', 'asset'].includes(type)) {
        formData.assetValue = parseFloat(form.querySelector('#assetValueInput').value) || 0;
      } else {
        formData.assetValue = null;
      }
      await Accounts.save(formData);
    });

    // Account type change - show/hide asset value field
    document.getElementById('accountTypeInput').addEventListener('change', (e) => {
      Accounts.toggleAssetValueField(e.target.value);
    });

    // Account Icon Upload
    const iconInput = document.getElementById('accountIconInput');
    const iconPreview = document.getElementById('accountIconPreview');

    document.getElementById('uploadIconBtn').addEventListener('click', () => {
      iconInput.click();
    });

    iconPreview.addEventListener('click', () => {
      iconInput.click();
    });

    iconInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        try {
          Accounts.pendingIcon = await Accounts.processIconFile(file);
          Accounts.updateIconPreview();
        } catch (err) {
          console.error('Error processing icon:', err);
          alert('Failed to process image. Please try a different file.');
        }
      }
      iconInput.value = '';
    });

    document.getElementById('removeIconBtn').addEventListener('click', () => {
      Accounts.pendingIcon = null;
      Accounts.updateIconPreview();
    });

    // Account Settings dropdown
    const accountSettingsBtn = document.getElementById('accountSettingsBtn');
    const accountSettingsMenu = document.getElementById('accountSettingsMenu');

    accountSettingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      accountSettingsMenu.classList.toggle('hidden');
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!accountSettingsMenu.contains(e.target) && e.target !== accountSettingsBtn) {
        accountSettingsMenu.classList.add('hidden');
      }
    });

    // Edit Account button (in dropdown)
    document.getElementById('editAccountBtn').addEventListener('click', () => {
      accountSettingsMenu.classList.add('hidden');
      Accounts.showModal(Accounts.current);
    });

    // Import CSV button (in dropdown)
    document.getElementById('importCsvBtn').addEventListener('click', () => {
      accountSettingsMenu.classList.add('hidden');
      Import.showModal();
    });

    // Delete Account button (in edit modal)
    document.getElementById('deleteAccountModalBtn').addEventListener('click', () => {
      if (!Accounts.current) return;
      document.getElementById('accountModal').classList.add('hidden');
      this.confirm(
        'Delete Account',
        `Delete account "${Accounts.current.name}"? The account will be marked as inactive and hidden, but data will be preserved.`,
        () => Accounts.delete(Accounts.current.id)
      );
    });

    // Transaction Modal
    document.getElementById('addTransactionBtn').addEventListener('click', () => {
      Transactions.showModal();
    });

    this.bindModal('transactionModal', 'transactionForm', async (form) => {
      const formData = {
        payee: form.querySelector('#transactionPayee').value,
        amount: parseFloat(form.querySelector('#transactionAmount').value),
        date: form.querySelector('#transactionDate').value,
        category: form.querySelector('#transactionCategory').value,
        description: form.querySelector('#transactionDescription').value,
        notes: form.querySelector('#transactionNotes').value
      };
      await Transactions.save(formData);
    });

    // Transfer Modal
    document.getElementById('transferBtn').addEventListener('click', () => {
      Transfers.showModal();
    });

    this.bindModal('transferModal', 'transferForm', async (form) => {
      const formData = {
        fromAccountId: form.querySelector('#transferFrom').value,
        toAccountId: form.querySelector('#transferTo').value,
        amount: parseFloat(form.querySelector('#transferAmount').value),
        date: form.querySelector('#transferDate').value,
        description: form.querySelector('#transferDescription').value,
        notes: form.querySelector('#transferNotes').value
      };
      await Transfers.save(formData);
    });

    // Import CSV Modal
    this.bindModalClose('importModal');

    document.getElementById('csvFileInput').addEventListener('change', (e) => {
      Import.handleFileSelect(e.target.files[0]);
    });

    document.getElementById('csvHasHeaders').addEventListener('change', () => {
      const fileInput = document.getElementById('csvFileInput');
      if (fileInput.files[0]) {
        Import.handleFileSelect(fileInput.files[0]);
      }
    });

    document.getElementById('dateFormatSelect').addEventListener('change', () => {
      Import.onMappingChange();
    });

    document.getElementById('importBtn').addEventListener('click', () => {
      Import.doImport();
    });

    // Settings Modal
    document.getElementById('settingsBtn').addEventListener('click', () => {
      this.showSettings();
    });

    // Settings tabs
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        this.switchSettingsTab(tab);
      });
    });

    // Backup/Restore (Data tab)
    document.getElementById('downloadBackupBtn').addEventListener('click', () => {
      API.downloadBackup();
    });

    const restoreFileInput = document.getElementById('restoreFileInput');
    const restoreFilename = document.getElementById('restoreFilename');
    const restoreBtn = document.getElementById('restoreBackupBtn');

    document.getElementById('selectRestoreFileBtn').addEventListener('click', () => {
      restoreFileInput.click();
    });

    restoreFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        restoreFilename.textContent = file.name;
        restoreBtn.disabled = false;
      } else {
        restoreFilename.textContent = '';
        restoreBtn.disabled = true;
      }
    });

    restoreBtn.addEventListener('click', () => {
      const file = restoreFileInput.files[0];
      if (!file) return;

      this.confirm(
        'Restore Backup',
        'This will overwrite ALL existing data with the backup. This cannot be undone. Are you sure?',
        async () => {
          try {
            const result = await API.restoreBackup(file);
            if (result.success) {
              alert('Backup restored successfully. The page will now reload.');
              window.location.reload();
            } else {
              alert('Restore failed: ' + (result.error || 'Unknown error'));
            }
          } catch (err) {
            alert('Restore failed: ' + err.message);
          }
        }
      );
    });

    // Settings form (Interface tab)
    document.getElementById('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = {
        name: document.getElementById('settingsName').value,
        currencySymbol: document.getElementById('currencySymbol').value
      };
      await API.updateSettings(formData);
      await this.loadSettings();
      this.updateWelcomeMessage();
      await Accounts.load();
      if (Accounts.current) {
        await Accounts.updateBalance();
      }
    });

    // Category Edit Modal
    this.bindModalClose('categoryEditModal');
    document.getElementById('categoryEditForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await Categories.saveCategoryEdit();
    });

    // Payee Edit Modal
    this.bindModalClose('payeeEditModal');
    document.getElementById('payeeEditForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await Payees.saveEdit();
    });

    this.bindModalClose('settingsModal');

    // Category Delete Modal
    this.bindModalClose('categoryDeleteModal');
    document.getElementById('categoryDeleteConfirmBtn').addEventListener('click', () => {
      Categories.confirmDelete();
    });

    // Payee Delete Modal
    this.bindModalClose('payeeDeleteModal');
    document.getElementById('payeeDeleteConfirmBtn').addEventListener('click', () => {
      Payees.confirmDelete();
    });

    // Confirm Modal
    this.bindModalClose('confirmModal');

    // Selection Toolbar
    document.getElementById('clearSelectionBtn').addEventListener('click', () => {
      Transactions.clearSelection();
    });

    document.getElementById('deleteSelectedBtn').addEventListener('click', () => {
      this.deleteSelectedTransactions();
    });

    document.getElementById('convertToTransferBtn').addEventListener('click', () => {
      this.showConvertToTransferModal();
    });

    // Convert to Transfer Modal
    this.bindModalClose('convertToTransferModal');
    document.getElementById('confirmConvertBtn').addEventListener('click', () => {
      this.doConvertToTransfer();
    });

    // Unlink Transfer button
    document.getElementById('unlinkTransferBtn').addEventListener('click', () => {
      this.unlinkTransfers();
    });
  },

  async deleteSelectedTransactions() {
    const selectedIds = Array.from(Transactions.selectedIds);
    if (selectedIds.length === 0) return;

    const count = selectedIds.length;
    this.confirm(
      'Delete Transactions',
      `Delete ${count} selected transaction${count > 1 ? 's' : ''}? This cannot be undone.`,
      async () => {
        const accountId = Accounts.current.id;
        for (const id of selectedIds) {
          await API.deleteTransaction(accountId, id);
        }
        Transactions.clearSelection();
        await Transactions.load(accountId);
        await Accounts.updateBalance();
      }
    );
  },

  async showConvertToTransferModal() {
    const selectedIds = Array.from(Transactions.selectedIds);
    if (selectedIds.length === 0) return;

    // Only allow converting non-transfer transactions
    const selectedTxs = Transactions.list.filter(tx => selectedIds.includes(tx.id));
    const nonTransfers = selectedTxs.filter(tx => !tx.transferId);

    if (nonTransfers.length === 0) {
      alert('All selected transactions are already transfers.');
      return;
    }

    // Populate account select (exclude current account)
    const select = document.getElementById('convertTargetAccount');
    const accounts = Accounts.list.filter(a => a.id !== Accounts.current.id);

    if (accounts.length === 0) {
      alert('You need at least one other account to convert to a transfer.');
      return;
    }

    select.innerHTML = accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('');

    // Show preview
    const preview = document.getElementById('convertPreview');
    const transferCount = selectedTxs.length - nonTransfers.length;
    let previewText = `${nonTransfers.length} transaction${nonTransfers.length > 1 ? 's' : ''} will be converted.`;
    if (transferCount > 0) {
      previewText += ` ${transferCount} already ${transferCount > 1 ? 'are' : 'is a'} transfer${transferCount > 1 ? 's' : ''} and will be skipped.`;
    }
    preview.textContent = previewText;

    document.getElementById('convertToTransferModal').classList.remove('hidden');
  },

  async doConvertToTransfer() {
    const targetAccountId = document.getElementById('convertTargetAccount').value;
    const selectedIds = Array.from(Transactions.selectedIds);
    const accountId = Accounts.current.id;

    // Filter to only non-transfer transactions
    const selectedTxs = Transactions.list.filter(tx => selectedIds.includes(tx.id) && !tx.transferId);

    let converted = 0;
    let errors = 0;

    for (const tx of selectedTxs) {
      try {
        const result = await API.convertToTransfer(accountId, tx.id, targetAccountId);
        if (result.success) {
          converted++;
        } else {
          errors++;
        }
      } catch (e) {
        errors++;
      }
    }

    document.getElementById('convertToTransferModal').classList.add('hidden');
    Transactions.clearSelection();
    await Transactions.load(accountId);
    await Accounts.updateBalance();

    if (errors > 0) {
      alert(`Converted ${converted} transaction${converted !== 1 ? 's' : ''}. ${errors} failed.`);
    }
  },

  async unlinkTransfers() {
    const selectedIds = Array.from(Transactions.selectedIds);
    if (selectedIds.length === 0) return;

    // Only allow unlinking transfer transactions
    const selectedTxs = Transactions.list.filter(tx => selectedIds.includes(tx.id));
    const transfers = selectedTxs.filter(tx => tx.transferId);

    if (transfers.length === 0) {
      alert('No transfers selected to unlink.');
      return;
    }

    const count = transfers.length;
    this.confirm(
      'Unlink Transfers',
      `Convert ${count} transfer${count > 1 ? 's' : ''} back to regular transaction${count > 1 ? 's' : ''}? The linked transaction${count > 1 ? 's' : ''} in the other account${count > 1 ? 's' : ''} will be deleted.`,
      async () => {
        const accountId = Accounts.current.id;
        let unlinked = 0;
        let errors = 0;

        for (const tx of transfers) {
          try {
            const result = await API.convertToTransaction(accountId, tx.id);
            if (result.success) {
              unlinked++;
            } else {
              errors++;
            }
          } catch (e) {
            errors++;
          }
        }

        Transactions.clearSelection();
        await Transactions.load(accountId);
        await Accounts.updateBalance();

        if (errors > 0) {
          alert(`Unlinked ${unlinked} transfer${unlinked !== 1 ? 's' : ''}. ${errors} failed.`);
        }
      }
    );
  },

  bindModal(modalId, formId, onSubmit) {
    const modal = document.getElementById(modalId);
    const form = document.getElementById(formId);

    // Close on backdrop click
    modal.querySelector('.modal-backdrop').addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    // Close on X button
    modal.querySelector('.modal-close').addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    // Cancel button
    const cancelBtn = modal.querySelector('.modal-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }

    // Form submit
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await onSubmit(form);
    });
  },

  bindModalClose(modalId) {
    const modal = document.getElementById(modalId);

    modal.querySelector('.modal-backdrop').addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    modal.querySelector('.modal-close').addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    const cancelBtn = modal.querySelector('.modal-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }
  },

  async showDashboard() {
    // Close mobile menu if open
    if (window.innerWidth <= 1400 && typeof this.closeMobileMenu === 'function') {
      this.closeMobileMenu();
    }

    Accounts.current = null;
    document.getElementById('accountView').classList.add('hidden');
    document.getElementById('dashboardView').classList.remove('hidden');
    document.querySelector('.nav-dashboard').classList.add('active');
    document.querySelectorAll('.account-item').forEach(item => {
      item.classList.remove('active');
    });
    // Reload dashboard data
    await Dashboard.load();
  },

  async showSettings() {
    document.getElementById('settingsName').value = this.settings.name || '';
    document.getElementById('currencySymbol').value = this.settings.currencySymbol;
    // Load and render categories
    await Categories.load();
    Categories.render();
    // Load and render payees
    await Payees.load();
    Payees.render();
    // Reset to interface tab
    this.switchSettingsTab('interface');
    document.getElementById('settingsModal').classList.remove('hidden');
  },

  switchSettingsTab(tab) {
    // Update nav
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    // Update content
    document.getElementById('settingsTabInterface').classList.toggle('active', tab === 'interface');
    document.getElementById('settingsTabCategories').classList.toggle('active', tab === 'categories');
    document.getElementById('settingsTabPayees').classList.toggle('active', tab === 'payees');
    document.getElementById('settingsTabData').classList.toggle('active', tab === 'data');
  },

  confirm(title, message, onConfirm) {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;

    const confirmBtn = document.getElementById('confirmBtn');
    const newBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);

    newBtn.addEventListener('click', async () => {
      await onConfirm();
      modal.classList.add('hidden');
    });

    modal.classList.remove('hidden');
  },

  // Cookie helpers
  setCookie(name, value, days = 365) {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
  },

  getCookie(name) {
    const cookies = document.cookie.split('; ');
    for (const cookie of cookies) {
      const [cookieName, cookieValue] = cookie.split('=');
      if (cookieName === name) {
        return decodeURIComponent(cookieValue);
      }
    }
    return null;
  },

  // Sidebar resize functionality
  initSidebarResize() {
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('sidebarResizeHandle');

    // Load saved width from cookie
    const savedWidth = this.getCookie('sidebarWidth');
    if (savedWidth) {
      const width = parseInt(savedWidth, 10);
      if (width >= 200 && width <= 450) {
        sidebar.style.width = `${width}px`;
      }
    }

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const startResize = (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    };

    const doResize = (e) => {
      if (!isResizing) return;
      const delta = e.clientX - startX;
      let newWidth = startWidth + delta;
      // Clamp to min/max
      newWidth = Math.max(200, Math.min(450, newWidth));
      sidebar.style.width = `${newWidth}px`;
    };

    const stopResize = () => {
      if (!isResizing) return;
      isResizing = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Save width to cookie
      this.setCookie('sidebarWidth', sidebar.offsetWidth);
    };

    handle.addEventListener('mousedown', startResize);
    document.addEventListener('mousemove', doResize);
    document.addEventListener('mouseup', stopResize);
  },

  // Mobile menu functionality
  initMobileMenu() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const menuBtn = document.getElementById('mobileMenuBtn');
    const closeBtn = document.getElementById('sidebarCloseBtn');

    const openMenu = () => {
      sidebar.classList.add('open');
      overlay.classList.add('active');
      menuBtn.classList.add('active');
      document.body.style.overflow = 'hidden';
    };

    const closeMenu = () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
      menuBtn.classList.remove('active');
      document.body.style.overflow = '';
    };

    // Toggle menu on hamburger click
    menuBtn.addEventListener('click', () => {
      if (sidebar.classList.contains('open')) {
        closeMenu();
      } else {
        openMenu();
      }
    });

    // Close on overlay click
    overlay.addEventListener('click', closeMenu);

    // Close on close button click
    closeBtn.addEventListener('click', closeMenu);

    // Close menu when selecting an account or dashboard
    document.querySelectorAll('.account-item, .nav-dashboard').forEach(item => {
      item.addEventListener('click', () => {
        // Only close if we're on mobile (sidebar is position fixed)
        if (window.innerWidth <= 1400) {
          closeMenu();
        }
      });
    });

    // Close menu when clicking settings or recurring buttons
    document.getElementById('settingsBtn').addEventListener('click', () => {
      if (window.innerWidth <= 1400) {
        closeMenu();
      }
    });

    document.getElementById('recurringBtn').addEventListener('click', () => {
      if (window.innerWidth <= 1400) {
        closeMenu();
      }
    });

    // Handle window resize - close menu if resizing to desktop
    window.addEventListener('resize', () => {
      if (window.innerWidth > 1400 && sidebar.classList.contains('open')) {
        closeMenu();
      }
    });

    // Handle escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sidebar.classList.contains('open')) {
        closeMenu();
      }
    });

    // Expose close method for other modules
    this.closeMobileMenu = closeMenu;
  },

  // Close mobile menu (called from other modules)
  closeMobileMenu() {
    // This will be overridden by initMobileMenu
  }
};

// Initialize on load
document.addEventListener('DOMContentLoaded', () => App.init());

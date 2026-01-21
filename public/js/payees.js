// Payees Management
const Payees = {
  list: [],
  pendingDeleteId: null,
  editingId: null,

  async load() {
    this.list = await API.getPayees();
  },

  render() {
    const container = document.getElementById('payeesList');

    let html = `
      <div class="payees-toolbar">
        <button class="btn btn-small btn-primary" id="addPayeeBtn">+ Add Payee</button>
      </div>
      <div class="payees-list" id="payeesListItems">
    `;

    if (this.list.length === 0) {
      html += '<p class="empty-state">No payees yet. Click "Add Payee" to get started.</p>';
    } else {
      for (const payee of this.list) {
        const initial = (payee.name || 'P')[0].toUpperCase();
        html += `
          <div class="payee-item" data-id="${payee.id}">
            <div class="payee-avatar">
              <span class="avatar-letter">${initial}</span>
            </div>
            <span class="payee-name-text">${payee.name}</span>
            <div class="payee-actions">
              <button class="btn-icon btn-edit" data-id="${payee.id}" title="Edit">✎</button>
              <button class="btn-icon btn-danger btn-delete" data-id="${payee.id}" title="Delete">✕</button>
            </div>
          </div>
        `;
      }
    }

    html += '</div>';
    container.innerHTML = html;

    this.bindEventHandlers();
  },

  bindEventHandlers() {
    // Add Payee button
    document.getElementById('addPayeeBtn')?.addEventListener('click', () => {
      this.showEditModal();
    });

    // Edit buttons
    document.querySelectorAll('#payeesListItems .btn-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        this.showEditModal(id);
      });
    });

    // Delete buttons
    document.querySelectorAll('#payeesListItems .btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        this.showDeleteModal(id);
      });
    });

    // Row click to edit
    document.querySelectorAll('.payee-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.btn-icon')) return;
        const id = item.dataset.id;
        this.showEditModal(id);
      });
    });
  },

  showEditModal(id = null) {
    this.editingId = id;
    const modal = document.getElementById('payeeEditModal');
    const title = document.getElementById('payeeEditModalTitle');
    const nameInput = document.getElementById('payeeEditName');

    if (id) {
      const payee = this.list.find(p => p.id === id);
      title.textContent = 'Edit Payee';
      nameInput.value = payee?.name || '';
    } else {
      title.textContent = 'Add Payee';
      nameInput.value = '';
    }

    modal.classList.remove('hidden');
    nameInput.focus();
  },

  hideEditModal() {
    document.getElementById('payeeEditModal').classList.add('hidden');
    this.editingId = null;
  },

  async saveEdit() {
    const name = document.getElementById('payeeEditName').value.trim();

    if (!name) {
      alert('Payee name is required.');
      return;
    }

    if (this.editingId) {
      await API.updatePayee(this.editingId, { name });
    } else {
      await API.createPayee({ name });
    }

    await this.load();
    this.render();
    this.hideEditModal();
  },

  showDeleteModal(id) {
    this.pendingDeleteId = id;
    const payee = this.list.find(p => p.id === id);

    const modal = document.getElementById('payeeDeleteModal');
    const message = document.getElementById('payeeDeleteMessage');
    const select = document.getElementById('replacementPayee');

    message.textContent = `Select a replacement payee for existing transactions using "${payee.name}":`;

    // Populate replacement options
    const otherPayees = this.list.filter(p => p.id !== id);
    select.innerHTML = otherPayees.map(p =>
      `<option value="${p.name}">${p.name}</option>`
    ).join('');

    modal.classList.remove('hidden');
  },

  async confirmDelete() {
    if (!this.pendingDeleteId) return;

    const replacementPayee = document.getElementById('replacementPayee').value;
    await API.deletePayee(this.pendingDeleteId, { replacementPayee });

    this.pendingDeleteId = null;
    document.getElementById('payeeDeleteModal').classList.add('hidden');

    await this.load();
    this.render();
  }
};

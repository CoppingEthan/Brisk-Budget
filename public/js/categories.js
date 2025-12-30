// Category Management with Nested Structure
const Categories = {
  list: [],
  pendingDeleteId: null,
  pendingDeleteType: null, // 'category' or 'subcategory'
  pendingDeleteParentId: null,
  editingId: null,
  editingType: null,
  editingParentId: null,
  draggedItem: null,
  draggedType: null,
  draggedParentId: null,

  async load() {
    this.list = await API.getCategories();
  },

  // Load categories into a select dropdown with visual hierarchy
  async loadSelect(selectId, selectedValue = null) {
    await this.load();
    const select = document.getElementById(selectId);

    let html = '';
    for (const cat of this.list) {
      // Add parent category as selectable option
      html += `<option value="${cat.name}" ${cat.name === selectedValue ? 'selected' : ''}>${cat.emoji} ${cat.name}</option>`;
      // Add subcategories indented
      if (cat.subcategories && cat.subcategories.length > 0) {
        for (const sub of cat.subcategories) {
          html += `<option value="${sub.name}" ${sub.name === selectedValue ? 'selected' : ''}>      ${sub.name}</option>`;
        }
      }
    }

    select.innerHTML = html;
  },

  // Get flat list of all category names (for validation/lookup)
  getAllCategoryNames() {
    const names = [];
    for (const cat of this.list) {
      names.push(cat.name);
      if (cat.subcategories) {
        for (const sub of cat.subcategories) {
          names.push(sub.name);
        }
      }
    }
    return names;
  },

  // Find parent category for a subcategory name
  findParentCategory(subcategoryName) {
    for (const cat of this.list) {
      if (cat.subcategories) {
        const sub = cat.subcategories.find(s => s.name === subcategoryName);
        if (sub) return cat;
      }
    }
    return null;
  },

  // Get category info by name (returns { category, subcategory, emoji })
  getCategoryInfo(name) {
    for (const cat of this.list) {
      if (cat.name === name) {
        return { category: cat, subcategory: null, emoji: cat.emoji };
      }
      if (cat.subcategories) {
        const sub = cat.subcategories.find(s => s.name === name);
        if (sub) {
          return { category: cat, subcategory: sub, emoji: cat.emoji };
        }
      }
    }
    return { category: null, subcategory: null, emoji: '❓' };
  },

  render() {
    const container = document.getElementById('categoriesList');

    let html = `
      <div class="categories-toolbar">
        <button class="btn btn-small btn-secondary" id="addCategoryBtn">+ Add Category</button>
        <button class="btn btn-small btn-secondary" id="resetCategoriesBtn">Reset to Defaults</button>
      </div>
      <div class="categories-tree" id="categoriesTree">
    `;

    for (const cat of this.list) {
      const isSystem = cat.isSystem;
      const hasSubcategories = cat.subcategories && cat.subcategories.length > 0;

      html += `
        <div class="category-group ${isSystem ? 'system-category' : ''}" data-id="${cat.id}" draggable="${!isSystem}">
          <div class="category-header">
            <div class="category-drag-handle" ${isSystem ? 'style="visibility:hidden"' : ''}>⋮⋮</div>
            <span class="category-emoji" data-id="${cat.id}">${cat.emoji}</span>
            <span class="category-name-text">${cat.name}</span>
            ${isSystem ? '<span class="category-badge">System</span>' : ''}
            <div class="category-actions">
              ${!isSystem ? `
                <button class="btn-icon btn-add-sub" data-id="${cat.id}" title="Add Subcategory">+</button>
                <button class="btn-icon btn-edit" data-id="${cat.id}" title="Edit">✎</button>
                <button class="btn-icon btn-danger btn-delete" data-id="${cat.id}" title="Delete">✕</button>
              ` : ''}
            </div>
          </div>
      `;

      if (hasSubcategories) {
        html += `<div class="subcategories-list" data-parent-id="${cat.id}">`;
        for (const sub of cat.subcategories) {
          html += `
            <div class="subcategory-item" data-id="${sub.id}" data-parent-id="${cat.id}" draggable="true">
              <div class="subcategory-drag-handle">⋮⋮</div>
              <span class="subcategory-name-text">${sub.name}</span>
              <div class="subcategory-actions">
                <button class="btn-icon btn-edit" data-id="${sub.id}" data-parent-id="${cat.id}" title="Edit">✎</button>
                <button class="btn-icon btn-danger btn-delete" data-id="${sub.id}" data-parent-id="${cat.id}" title="Delete">✕</button>
              </div>
            </div>
          `;
        }
        html += '</div>';
      }

      html += '</div>';
    }

    html += '</div>';
    container.innerHTML = html;

    this.bindEventHandlers();
  },

  bindEventHandlers() {
    // Add Category button
    document.getElementById('addCategoryBtn')?.addEventListener('click', () => {
      this.showAddCategoryModal();
    });

    // Reset Categories button
    document.getElementById('resetCategoriesBtn')?.addEventListener('click', () => {
      this.confirmReset();
    });

    // Category emoji click (to edit emoji)
    document.querySelectorAll('.category-emoji').forEach(el => {
      el.addEventListener('click', (e) => {
        const id = e.target.dataset.id;
        this.showEmojiPicker(id);
      });
    });

    // Category actions
    document.querySelectorAll('.category-header .btn-add-sub').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        this.showAddSubcategoryModal(id);
      });
    });

    document.querySelectorAll('.category-header .btn-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        this.startEditCategory(id);
      });
    });

    document.querySelectorAll('.category-header .btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        this.showDeleteModal(id, 'category');
      });
    });

    // Subcategory actions
    document.querySelectorAll('.subcategory-item .btn-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const parentId = btn.dataset.parentId;
        this.startEditSubcategory(id, parentId);
      });
    });

    document.querySelectorAll('.subcategory-item .btn-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const parentId = btn.dataset.parentId;
        this.showDeleteModal(id, 'subcategory', parentId);
      });
    });

    // Drag and drop for categories
    this.setupDragAndDrop();
  },

  setupDragAndDrop() {
    // Category drag
    document.querySelectorAll('.category-group[draggable="true"]').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        this.draggedItem = el;
        this.draggedType = 'category';
        this.draggedParentId = null;
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        this.draggedItem = null;
        this.draggedType = null;
        document.querySelectorAll('.drag-over').forEach(d => d.classList.remove('drag-over'));
      });

      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (this.draggedType === 'category' && el !== this.draggedItem) {
          el.classList.add('drag-over');
        }
      });

      el.addEventListener('dragleave', () => {
        el.classList.remove('drag-over');
      });

      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drag-over');
        if (this.draggedType === 'category' && el !== this.draggedItem) {
          this.handleCategoryDrop(el);
        }
      });
    });

    // Subcategory drag
    document.querySelectorAll('.subcategory-item').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        this.draggedItem = el;
        this.draggedType = 'subcategory';
        this.draggedParentId = el.dataset.parentId;
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        this.draggedItem = null;
        this.draggedType = null;
        this.draggedParentId = null;
        document.querySelectorAll('.drag-over').forEach(d => d.classList.remove('drag-over'));
      });

      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.draggedType === 'subcategory' &&
            el !== this.draggedItem &&
            el.dataset.parentId === this.draggedParentId) {
          el.classList.add('drag-over');
        }
      });

      el.addEventListener('dragleave', () => {
        el.classList.remove('drag-over');
      });

      el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drag-over');
        if (this.draggedType === 'subcategory' &&
            el !== this.draggedItem &&
            el.dataset.parentId === this.draggedParentId) {
          this.handleSubcategoryDrop(el);
        }
      });
    });
  },

  async handleCategoryDrop(targetEl) {
    const container = document.getElementById('categoriesTree');
    const categories = [...container.querySelectorAll('.category-group')];
    const draggedIndex = categories.indexOf(this.draggedItem);
    const targetIndex = categories.indexOf(targetEl);

    if (draggedIndex < targetIndex) {
      targetEl.after(this.draggedItem);
    } else {
      targetEl.before(this.draggedItem);
    }

    // Get new order
    const newOrder = [...container.querySelectorAll('.category-group')].map(el => el.dataset.id);
    await API.reorderCategories(newOrder);
    await this.load();
  },

  async handleSubcategoryDrop(targetEl) {
    const parentId = targetEl.dataset.parentId;
    const container = document.querySelector(`.subcategories-list[data-parent-id="${parentId}"]`);
    const subcategories = [...container.querySelectorAll('.subcategory-item')];
    const draggedIndex = subcategories.indexOf(this.draggedItem);
    const targetIndex = subcategories.indexOf(targetEl);

    if (draggedIndex < targetIndex) {
      targetEl.after(this.draggedItem);
    } else {
      targetEl.before(this.draggedItem);
    }

    // Get new order
    const newOrder = [...container.querySelectorAll('.subcategory-item')].map(el => el.dataset.id);
    await API.reorderSubcategories(parentId, newOrder);
    await this.load();
  },

  showAddCategoryModal() {
    const modal = document.getElementById('categoryEditModal');
    document.getElementById('categoryEditModalTitle').textContent = 'Add Category';
    document.getElementById('categoryEditName').value = '';
    document.getElementById('categoryEditEmoji').value = '📁';
    document.getElementById('categoryEditId').value = '';
    document.getElementById('categoryEditType').value = 'category';
    document.getElementById('categoryEditParentId').value = '';
    modal.classList.remove('hidden');
    document.getElementById('categoryEditName').focus();
  },

  showAddSubcategoryModal(parentId) {
    const modal = document.getElementById('categoryEditModal');
    document.getElementById('categoryEditModalTitle').textContent = 'Add Subcategory';
    document.getElementById('categoryEditName').value = '';
    document.getElementById('categoryEditEmoji').value = '';
    document.getElementById('categoryEditId').value = '';
    document.getElementById('categoryEditType').value = 'subcategory';
    document.getElementById('categoryEditParentId').value = parentId;

    // Hide emoji field for subcategories
    document.getElementById('categoryEmojiGroup').classList.add('hidden');

    modal.classList.remove('hidden');
    document.getElementById('categoryEditName').focus();
  },

  startEditCategory(id) {
    const category = this.list.find(c => c.id === id);
    if (!category) return;

    const modal = document.getElementById('categoryEditModal');
    document.getElementById('categoryEditModalTitle').textContent = 'Edit Category';
    document.getElementById('categoryEditName').value = category.name;
    document.getElementById('categoryEditEmoji').value = category.emoji || '📁';
    document.getElementById('categoryEditId').value = id;
    document.getElementById('categoryEditType').value = 'category';
    document.getElementById('categoryEditParentId').value = '';

    // Show emoji field for categories
    document.getElementById('categoryEmojiGroup').classList.remove('hidden');

    modal.classList.remove('hidden');
    document.getElementById('categoryEditName').focus();
  },

  startEditSubcategory(id, parentId) {
    const category = this.list.find(c => c.id === parentId);
    if (!category) return;

    const sub = category.subcategories?.find(s => s.id === id);
    if (!sub) return;

    const modal = document.getElementById('categoryEditModal');
    document.getElementById('categoryEditModalTitle').textContent = 'Edit Subcategory';
    document.getElementById('categoryEditName').value = sub.name;
    document.getElementById('categoryEditEmoji').value = '';
    document.getElementById('categoryEditId').value = id;
    document.getElementById('categoryEditType').value = 'subcategory';
    document.getElementById('categoryEditParentId').value = parentId;

    // Hide emoji field for subcategories
    document.getElementById('categoryEmojiGroup').classList.add('hidden');

    modal.classList.remove('hidden');
    document.getElementById('categoryEditName').focus();
  },

  hideCategoryEditModal() {
    document.getElementById('categoryEditModal').classList.add('hidden');
    // Reset emoji group visibility
    document.getElementById('categoryEmojiGroup').classList.remove('hidden');
  },

  async saveCategoryEdit() {
    const name = document.getElementById('categoryEditName').value.trim();
    const emoji = document.getElementById('categoryEditEmoji').value.trim() || '📁';
    const id = document.getElementById('categoryEditId').value;
    const type = document.getElementById('categoryEditType').value;
    const parentId = document.getElementById('categoryEditParentId').value;

    if (!name) {
      alert('Name is required.');
      return;
    }

    if (type === 'category') {
      if (id) {
        // Update existing category
        await API.updateCategory(id, { name, emoji });
      } else {
        // Create new category
        await API.createCategory({ name, emoji });
      }
    } else {
      // Subcategory
      if (id) {
        // Update existing subcategory
        await API.updateSubcategory(parentId, id, { name });
      } else {
        // Create new subcategory
        await API.addSubcategory(parentId, { name });
      }
    }

    await this.load();
    this.render();
    this.hideCategoryEditModal();
  },

  showEmojiPicker(categoryId) {
    const category = this.list.find(c => c.id === categoryId);
    if (!category || category.isSystem) return;

    // Simple prompt for now - could be enhanced with emoji picker UI
    const emoji = prompt('Enter emoji for this category:', category.emoji || '📁');
    if (emoji && emoji.trim()) {
      this.updateCategoryEmoji(categoryId, emoji.trim());
    }
  },

  async updateCategoryEmoji(categoryId, emoji) {
    await API.updateCategory(categoryId, { emoji });
    await this.load();
    this.render();
  },

  showDeleteModal(id, type, parentId = null) {
    this.pendingDeleteId = id;
    this.pendingDeleteType = type;
    this.pendingDeleteParentId = parentId;

    let itemName = '';
    if (type === 'category') {
      const category = this.list.find(c => c.id === id);
      itemName = category?.name || '';
    } else {
      const category = this.list.find(c => c.id === parentId);
      const sub = category?.subcategories?.find(s => s.id === id);
      itemName = sub?.name || '';
    }

    // Populate replacement options
    const select = document.getElementById('replacementCategory');
    let options = '';
    for (const cat of this.list) {
      if (type === 'category' && cat.id === id) continue;
      options += `<option value="${cat.name}">${cat.emoji} ${cat.name}</option>`;
      if (cat.subcategories) {
        for (const sub of cat.subcategories) {
          if (type === 'subcategory' && sub.id === id) continue;
          options += `<option value="${sub.name}">  └ ${sub.name}</option>`;
        }
      }
    }
    select.innerHTML = options;

    document.getElementById('categoryDeleteMessage').textContent =
      `Delete "${itemName}"? Select a replacement category for existing transactions:`;

    document.getElementById('categoryDeleteModal').classList.remove('hidden');
  },

  hideDeleteModal() {
    document.getElementById('categoryDeleteModal').classList.add('hidden');
    this.pendingDeleteId = null;
    this.pendingDeleteType = null;
    this.pendingDeleteParentId = null;
  },

  async confirmDelete() {
    if (!this.pendingDeleteId) return;

    const replacementCategory = document.getElementById('replacementCategory').value;

    if (this.pendingDeleteType === 'category') {
      await API.deleteCategory(this.pendingDeleteId, replacementCategory);
    } else {
      await API.deleteSubcategory(this.pendingDeleteParentId, this.pendingDeleteId, replacementCategory);
    }

    await this.load();
    this.render();
    this.hideDeleteModal();
  },

  confirmReset() {
    if (confirm('Reset all categories to defaults? This will remove all custom categories and restore the default UK household categories. Existing transactions will be updated to "Uncategorized".')) {
      this.resetToDefaults();
    }
  },

  async resetToDefaults() {
    await API.resetCategories();
    await this.load();
    this.render();
  }
};

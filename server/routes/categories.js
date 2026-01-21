const fs = require('fs');
const { accountsFile, categoriesFile, recurringFile, getTransactionsFile } = require('../config/paths');
const { defaultCategories } = require('../config/defaults');
const { readJSON, writeJSON, generateId, parseBody, sendJSON } = require('../utils/helpers');

const categories = {
  getCategories: (req, res) => {
    let catList = readJSON(categoriesFile) || [];
    catList.sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
    catList.forEach(cat => {
      if (cat.subcategories) {
        cat.subcategories.sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
      }
    });
    sendJSON(res, catList);
  },

  createCategory: async (req, res) => {
    const body = await parseBody(req);
    const catList = readJSON(categoriesFile) || [];

    const maxOrder = catList.reduce((max, c) => Math.max(max, c.sortOrder ?? 0), 0);

    const newCategory = {
      id: generateId(),
      name: body.name,
      emoji: body.emoji || '📁',
      isDefault: false,
      sortOrder: maxOrder + 1,
      subcategories: body.subcategories || []
    };
    catList.push(newCategory);
    writeJSON(categoriesFile, catList);
    sendJSON(res, newCategory, 201);
  },

  updateCategory: async (req, res, categoryId) => {
    const body = await parseBody(req);
    const catList = readJSON(categoriesFile) || [];
    const index = catList.findIndex(c => c.id === categoryId);
    if (index === -1) {
      sendJSON(res, { error: 'Category not found' }, 404);
      return;
    }

    if (body.name !== undefined) catList[index].name = body.name;
    if (body.emoji !== undefined) catList[index].emoji = body.emoji;
    if (body.sortOrder !== undefined) catList[index].sortOrder = body.sortOrder;
    if (body.subcategories !== undefined) catList[index].subcategories = body.subcategories;

    writeJSON(categoriesFile, catList);
    sendJSON(res, catList[index]);
  },

  deleteCategory: async (req, res, categoryId) => {
    const body = await parseBody(req);
    const replacementCategory = body.replacementCategory;

    let catList = readJSON(categoriesFile) || [];
    const category = catList.find(c => c.id === categoryId);
    if (!category) {
      sendJSON(res, { error: 'Category not found' }, 404);
      return;
    }
    if (category.isSystem) {
      sendJSON(res, { error: 'Cannot delete system category' }, 400);
      return;
    }
    if (!replacementCategory) {
      sendJSON(res, { error: 'Replacement category required' }, 400);
      return;
    }

    const namesToReplace = [category.name];
    if (category.subcategories) {
      namesToReplace.push(...category.subcategories.map(s => s.name));
    }

    const accounts = readJSON(accountsFile) || [];
    for (const account of accounts) {
      const txFile = getTransactionsFile(account.id);
      if (fs.existsSync(txFile)) {
        let transactions = readJSON(txFile) || [];
        let modified = false;
        for (const tx of transactions) {
          if (namesToReplace.includes(tx.category)) {
            tx.category = replacementCategory;
            modified = true;
          }
        }
        if (modified) {
          writeJSON(txFile, transactions);
        }
      }
    }

    const recurring = readJSON(recurringFile) || [];
    let recurringModified = false;
    for (const item of recurring) {
      if (namesToReplace.includes(item.category)) {
        item.category = replacementCategory;
        recurringModified = true;
      }
    }
    if (recurringModified) {
      writeJSON(recurringFile, recurring);
    }

    catList = catList.filter(c => c.id !== categoryId);
    writeJSON(categoriesFile, catList);
    sendJSON(res, { success: true });
  },

  addSubcategory: async (req, res, categoryId) => {
    const body = await parseBody(req);
    const catList = readJSON(categoriesFile) || [];
    const category = catList.find(c => c.id === categoryId);

    if (!category) {
      sendJSON(res, { error: 'Category not found' }, 404);
      return;
    }

    if (!category.subcategories) {
      category.subcategories = [];
    }

    const maxOrder = category.subcategories.reduce((max, s) => Math.max(max, s.sortOrder ?? 0), 0);

    const newSub = {
      id: generateId(),
      name: body.name,
      sortOrder: maxOrder + 1
    };

    category.subcategories.push(newSub);
    writeJSON(categoriesFile, catList);
    sendJSON(res, newSub, 201);
  },

  updateSubcategory: async (req, res, categoryId, subcategoryId) => {
    const body = await parseBody(req);
    const catList = readJSON(categoriesFile) || [];
    const category = catList.find(c => c.id === categoryId);

    if (!category) {
      sendJSON(res, { error: 'Category not found' }, 404);
      return;
    }

    const subIndex = category.subcategories?.findIndex(s => s.id === subcategoryId);
    if (subIndex === -1 || subIndex === undefined) {
      sendJSON(res, { error: 'Subcategory not found' }, 404);
      return;
    }

    const oldName = category.subcategories[subIndex].name;
    if (body.name !== undefined) category.subcategories[subIndex].name = body.name;
    if (body.sortOrder !== undefined) category.subcategories[subIndex].sortOrder = body.sortOrder;

    if (body.name && body.name !== oldName) {
      const accounts = readJSON(accountsFile) || [];
      for (const account of accounts) {
        const txFile = getTransactionsFile(account.id);
        if (fs.existsSync(txFile)) {
          let transactions = readJSON(txFile) || [];
          let modified = false;
          for (const tx of transactions) {
            if (tx.category === oldName) {
              tx.category = body.name;
              modified = true;
            }
          }
          if (modified) {
            writeJSON(txFile, transactions);
          }
        }
      }
    }

    writeJSON(categoriesFile, catList);
    sendJSON(res, category.subcategories[subIndex]);
  },

  deleteSubcategory: async (req, res, categoryId, subcategoryId) => {
    const body = await parseBody(req);
    const catList = readJSON(categoriesFile) || [];
    const category = catList.find(c => c.id === categoryId);

    if (!category) {
      sendJSON(res, { error: 'Category not found' }, 404);
      return;
    }

    const subIndex = category.subcategories?.findIndex(s => s.id === subcategoryId);
    if (subIndex === -1 || subIndex === undefined) {
      sendJSON(res, { error: 'Subcategory not found' }, 404);
      return;
    }

    const subName = category.subcategories[subIndex].name;
    const replacementCategory = body.replacementCategory || category.name;

    const accounts = readJSON(accountsFile) || [];
    for (const account of accounts) {
      const txFile = getTransactionsFile(account.id);
      if (fs.existsSync(txFile)) {
        let transactions = readJSON(txFile) || [];
        let modified = false;
        for (const tx of transactions) {
          if (tx.category === subName) {
            tx.category = replacementCategory;
            modified = true;
          }
        }
        if (modified) {
          writeJSON(txFile, transactions);
        }
      }
    }

    category.subcategories.splice(subIndex, 1);
    writeJSON(categoriesFile, catList);
    sendJSON(res, { success: true });
  },

  reorderCategories: async (req, res) => {
    const body = await parseBody(req);
    const { categoryIds } = body;

    if (!Array.isArray(categoryIds)) {
      sendJSON(res, { error: 'categoryIds array required' }, 400);
      return;
    }

    const catList = readJSON(categoriesFile) || [];

    for (let i = 0; i < categoryIds.length; i++) {
      const category = catList.find(c => c.id === categoryIds[i]);
      if (category) {
        category.sortOrder = i;
      }
    }

    writeJSON(categoriesFile, catList);
    sendJSON(res, { success: true });
  },

  reorderSubcategories: async (req, res, categoryId) => {
    const body = await parseBody(req);
    const { subcategoryIds } = body;

    if (!Array.isArray(subcategoryIds)) {
      sendJSON(res, { error: 'subcategoryIds array required' }, 400);
      return;
    }

    const catList = readJSON(categoriesFile) || [];
    const category = catList.find(c => c.id === categoryId);

    if (!category) {
      sendJSON(res, { error: 'Category not found' }, 404);
      return;
    }

    for (let i = 0; i < subcategoryIds.length; i++) {
      const sub = category.subcategories?.find(s => s.id === subcategoryIds[i]);
      if (sub) {
        sub.sortOrder = i;
      }
    }

    writeJSON(categoriesFile, catList);
    sendJSON(res, { success: true });
  },

  resetCategories: async (req, res) => {
    writeJSON(categoriesFile, defaultCategories);
    sendJSON(res, { success: true, categories: defaultCategories });
  }
};

module.exports = categories;

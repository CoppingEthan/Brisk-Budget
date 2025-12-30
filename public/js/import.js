// CSV Import Management
const Import = {
  parsedData: [],
  headers: [],
  columnMapping: {
    date: -1,
    payee: -1,
    amount: -1,
    category: -1,
    description: -1,
    notes: -1
  },
  dateFormat: 'DD/MM/YYYY',

  fields: [
    { key: 'date', label: 'Date', required: true },
    { key: 'payee', label: 'Payee', required: false },
    { key: 'amount', label: 'Amount', required: true },
    { key: 'category', label: 'Category', required: false },
    { key: 'description', label: 'Description', required: false },
    { key: 'notes', label: 'Notes', required: false }
  ],

  showModal() {
    this.reset();
    document.getElementById('importModal').classList.remove('hidden');
  },

  hideModal() {
    document.getElementById('importModal').classList.add('hidden');
    this.reset();
  },

  reset() {
    this.parsedData = [];
    this.headers = [];
    this.columnMapping = {
      date: -1,
      payee: -1,
      amount: -1,
      category: -1,
      description: -1,
      notes: -1
    };

    document.getElementById('csvFileInput').value = '';
    document.getElementById('csvHasHeaders').checked = true;
    document.getElementById('columnMappingSection').classList.add('hidden');
    document.getElementById('dateFormatSection').classList.add('hidden');
    document.getElementById('previewSection').classList.add('hidden');
    document.getElementById('importBtn').disabled = true;
  },

  handleFileSelect(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      this.parsedData = this.parseCSV(text);

      if (this.parsedData.length === 0) {
        alert('No data found in CSV file.');
        return;
      }

      const hasHeaders = document.getElementById('csvHasHeaders').checked;
      if (hasHeaders && this.parsedData.length > 0) {
        this.headers = this.parsedData[0];
      } else {
        this.headers = this.parsedData[0].map((_, i) => `Column ${i + 1}`);
      }

      this.renderColumnMapping();
      this.autoDetectDateFormat();
    };
    reader.readAsText(file);
  },

  parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    return lines.map(line => {
      const values = [];
      let current = '';
      let inQuotes = false;

      for (const char of line) {
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim());
      return values;
    });
  },

  renderColumnMapping() {
    const grid = document.getElementById('columnMappingGrid');
    const columnOptions = this.headers.map((h, i) =>
      `<option value="${i}">${h}</option>`
    ).join('');

    grid.innerHTML = this.fields.map(field => {
      const requiredMark = field.required ? ' *' : '';
      return `
        <div class="mapping-row">
          <label>${field.label}${requiredMark}</label>
          <select id="map_${field.key}" data-field="${field.key}">
            <option value="-1">-- Skip --</option>
            ${columnOptions}
          </select>
          <span class="mapping-sample" id="sample_${field.key}"></span>
        </div>
      `;
    }).join('');

    // Auto-detect column mappings based on header names
    this.autoDetectMappings();

    // Bind change handlers
    grid.querySelectorAll('select').forEach(select => {
      select.addEventListener('change', () => this.onMappingChange());
    });

    document.getElementById('columnMappingSection').classList.remove('hidden');
    document.getElementById('dateFormatSection').classList.remove('hidden');
    this.onMappingChange();
  },

  autoDetectMappings() {
    const headerLower = this.headers.map(h => h.toLowerCase());

    // Date detection
    const datePatterns = ['date', 'transaction date', 'trans date', 'posted'];
    const dateIdx = headerLower.findIndex(h => datePatterns.some(p => h.includes(p)));
    if (dateIdx >= 0) {
      document.getElementById('map_date').value = dateIdx;
      this.columnMapping.date = dateIdx;
    }

    // Amount detection
    const amountPatterns = ['amount', 'value', 'sum', 'debit', 'credit'];
    const amountIdx = headerLower.findIndex(h => amountPatterns.some(p => h.includes(p)));
    if (amountIdx >= 0) {
      document.getElementById('map_amount').value = amountIdx;
      this.columnMapping.amount = amountIdx;
    }

    // Payee detection
    const payeePatterns = ['payee', 'description', 'merchant', 'name', 'recipient', 'memo'];
    const payeeIdx = headerLower.findIndex(h => payeePatterns.some(p => h.includes(p)));
    if (payeeIdx >= 0) {
      document.getElementById('map_payee').value = payeeIdx;
      this.columnMapping.payee = payeeIdx;
    }

    // Category detection
    const catPatterns = ['category', 'type'];
    const catIdx = headerLower.findIndex(h => catPatterns.some(p => h.includes(p)));
    if (catIdx >= 0) {
      document.getElementById('map_category').value = catIdx;
      this.columnMapping.category = catIdx;
    }
  },

  autoDetectDateFormat() {
    const hasHeaders = document.getElementById('csvHasHeaders').checked;
    const dataStartIdx = hasHeaders ? 1 : 0;

    if (this.parsedData.length <= dataStartIdx || this.columnMapping.date < 0) {
      return;
    }

    // Get first few date values
    const dateValues = [];
    for (let i = dataStartIdx; i < Math.min(dataStartIdx + 10, this.parsedData.length); i++) {
      const val = this.parsedData[i][this.columnMapping.date];
      if (val) dateValues.push(val);
    }

    if (dateValues.length === 0) return;

    const testDate = dateValues[0];

    // Try to detect format
    if (/^\d{4}-\d{2}-\d{2}/.test(testDate)) {
      this.dateFormat = 'YYYY-MM-DD';
    } else if (/^\d{2}\/\d{2}\/\d{4}/.test(testDate)) {
      // Could be DD/MM/YYYY or MM/DD/YYYY
      // Check across multiple dates - if any first part > 12, it must be DD/MM/YYYY
      let hasFirstPartOver12 = false;
      let hasSecondPartOver12 = false;

      for (const dateVal of dateValues) {
        const parts = dateVal.split('/');
        const first = parseInt(parts[0], 10);
        const second = parseInt(parts[1], 10);
        if (first > 12) hasFirstPartOver12 = true;
        if (second > 12) hasSecondPartOver12 = true;
      }

      // If first part ever > 12, it must be day (DD/MM/YYYY)
      // If second part ever > 12, it must be day (MM/DD/YYYY)
      // Default to DD/MM/YYYY (UK format) if ambiguous
      if (hasFirstPartOver12) {
        this.dateFormat = 'DD/MM/YYYY';
      } else if (hasSecondPartOver12) {
        this.dateFormat = 'MM/DD/YYYY';
      } else {
        this.dateFormat = 'DD/MM/YYYY'; // Default to UK
      }
    } else if (/^\d{2}-\d{2}-\d{4}/.test(testDate)) {
      this.dateFormat = 'DD-MM-YYYY';
    }

    document.getElementById('dateFormatSelect').value = this.dateFormat;
  },

  onMappingChange() {
    // Update column mapping from form
    this.fields.forEach(field => {
      const select = document.getElementById(`map_${field.key}`);
      this.columnMapping[field.key] = parseInt(select.value, 10);
    });

    // Update samples
    const hasHeaders = document.getElementById('csvHasHeaders').checked;
    const sampleRowIdx = hasHeaders ? 1 : 0;

    if (this.parsedData.length > sampleRowIdx) {
      const sampleRow = this.parsedData[sampleRowIdx];
      this.fields.forEach(field => {
        const sampleEl = document.getElementById(`sample_${field.key}`);
        const colIdx = this.columnMapping[field.key];
        if (colIdx >= 0 && sampleRow[colIdx]) {
          sampleEl.textContent = `"${sampleRow[colIdx]}"`;
        } else {
          sampleEl.textContent = '';
        }
      });
    }

    // Check if required fields are mapped and render preview
    const hasDate = this.columnMapping.date >= 0;
    const hasAmount = this.columnMapping.amount >= 0;

    if (hasDate && hasAmount) {
      this.renderPreview();
      document.getElementById('importBtn').disabled = false;
    } else {
      document.getElementById('previewSection').classList.add('hidden');
      document.getElementById('importBtn').disabled = true;
    }
  },

  parseDate(dateStr) {
    if (!dateStr) return null;

    const format = document.getElementById('dateFormatSelect').value;
    let day, month, year;

    try {
      if (format === 'YYYY-MM-DD') {
        const parts = dateStr.split('-');
        year = parts[0];
        month = parts[1];
        day = parts[2];
      } else if (format === 'DD/MM/YYYY') {
        const parts = dateStr.split('/');
        day = parts[0];
        month = parts[1];
        year = parts[2];
      } else if (format === 'MM/DD/YYYY') {
        const parts = dateStr.split('/');
        month = parts[0];
        day = parts[1];
        year = parts[2];
      } else if (format === 'DD-MM-YYYY') {
        const parts = dateStr.split('-');
        day = parts[0];
        month = parts[1];
        year = parts[2];
      }

      // Validate and format
      if (year && month && day) {
        // Ensure we have clean numeric strings
        year = String(year).trim().padStart(4, '20');
        month = String(month).trim().padStart(2, '0');
        day = String(day).trim().padStart(2, '0');

        // Validate month and day are in valid ranges
        const monthNum = parseInt(month, 10);
        const dayNum = parseInt(day, 10);

        if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) {
          console.warn(`Invalid date values: day=${day}, month=${month}, year=${year}`);
          return null;
        }

        return `${year}-${month}-${day}`;
      }
    } catch (e) {
      console.error('Date parsing error:', e);
    }

    return null;
  },

  parseAmount(amountStr) {
    if (!amountStr) return NaN;

    // Remove currency symbols and whitespace
    let cleaned = amountStr.replace(/[£$€\s]/g, '');

    // Handle parentheses as negative (accounting format)
    if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
      cleaned = '-' + cleaned.slice(1, -1);
    }

    // Handle comma as thousand separator or decimal
    // If there's both comma and period, comma is thousand separator
    if (cleaned.includes(',') && cleaned.includes('.')) {
      cleaned = cleaned.replace(/,/g, '');
    } else if (cleaned.includes(',')) {
      // Could be decimal separator (European) or thousand separator
      // If comma is followed by exactly 2 digits at end, treat as decimal
      if (/,\d{2}$/.test(cleaned)) {
        cleaned = cleaned.replace(',', '.');
      } else {
        cleaned = cleaned.replace(/,/g, '');
      }
    }

    return parseFloat(cleaned);
  },

  getDataRows() {
    const hasHeaders = document.getElementById('csvHasHeaders').checked;
    return hasHeaders ? this.parsedData.slice(1) : this.parsedData;
  },

  buildTransaction(row) {
    const dateStr = this.columnMapping.date >= 0 ? row[this.columnMapping.date] : '';
    const amountStr = this.columnMapping.amount >= 0 ? row[this.columnMapping.amount] : '';
    const payee = this.columnMapping.payee >= 0 ? row[this.columnMapping.payee] : '';
    const category = this.columnMapping.category >= 0 ? row[this.columnMapping.category] : '';
    const description = this.columnMapping.description >= 0 ? row[this.columnMapping.description] : '';
    const notes = this.columnMapping.notes >= 0 ? row[this.columnMapping.notes] : '';

    return {
      date: this.parseDate(dateStr),
      amount: this.parseAmount(amountStr),
      payee: payee || 'Unknown',
      category: category || 'Uncategorized',
      description: description || '',
      notes: notes || ''
    };
  },

  renderPreview() {
    const dataRows = this.getDataRows();
    const previewRows = dataRows.slice(0, 5);

    const table = document.getElementById('importPreviewTable');
    table.innerHTML = `
      <thead>
        <tr>
          <th>Date</th>
          <th>Payee</th>
          <th>Amount</th>
          <th>Category</th>
        </tr>
      </thead>
      <tbody>
        ${previewRows.map(row => {
          const tx = this.buildTransaction(row);
          const amountClass = tx.amount < 0 ? 'negative' : 'positive';
          return `
            <tr>
              <td>${tx.date || 'Invalid'}</td>
              <td>${tx.payee}</td>
              <td class="${amountClass}">${isNaN(tx.amount) ? 'Invalid' : App.formatCurrency(tx.amount)}</td>
              <td>${tx.category}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    `;

    const validCount = dataRows.filter(row => {
      const tx = this.buildTransaction(row);
      return tx.date && !isNaN(tx.amount);
    }).length;

    document.getElementById('importCount').textContent =
      `${validCount} of ${dataRows.length} transactions ready to import`;

    document.getElementById('previewSection').classList.remove('hidden');
  },

  async doImport() {
    const dataRows = this.getDataRows();
    const transactions = [];

    for (const row of dataRows) {
      const tx = this.buildTransaction(row);
      if (tx.date && !isNaN(tx.amount)) {
        transactions.push(tx);
      }
    }

    if (transactions.length === 0) {
      alert('No valid transactions to import.');
      return;
    }

    const accountId = Accounts.current.id;

    try {
      // Import transactions
      const result = await API.importTransactions(accountId, transactions);

      // Auto-add new payees
      const uniquePayees = [...new Set(transactions.map(tx => tx.payee))];
      for (const payee of uniquePayees) {
        await Transactions.ensurePayeeExists(payee);
      }

      // Reload transactions and balance
      await Transactions.load(accountId);
      await Accounts.updateBalance();

      this.hideModal();

      // Show success message
      if (result.errors && result.errors.length > 0) {
        alert(`Imported ${result.imported} transactions.\n${result.errors.length} rows had errors.`);
      } else {
        alert(`Successfully imported ${result.imported} transactions.`);
      }
    } catch (err) {
      console.error('Import error:', err);
      alert('Failed to import transactions. Please try again.');
    }
  }
};

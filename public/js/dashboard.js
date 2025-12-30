// Dashboard Management
const Dashboard = {
  currentRange: '1m',
  currentSankeyRange: '1m',
  currentForecast: '0',
  currentSankeyForecast: '0',
  allTransactions: [],
  categories: [],
  recurringList: [],
  chartData: [], // Store for hover functionality
  selectedAccounts: [], // Account IDs selected for chart

  // Category color mapping (same as transactions.js)
  categoryColors: {
    'Food & Drink': { solid: '#fb923c', light: 'rgba(249, 115, 22, 0.3)' },
    'Bills & Utilities': { solid: '#facc15', light: 'rgba(234, 179, 8, 0.3)' },
    'Housing': { solid: '#60a5fa', light: 'rgba(59, 130, 246, 0.3)' },
    'Transport': { solid: '#818cf8', light: 'rgba(99, 102, 241, 0.3)' },
    'Shopping': { solid: '#f472b6', light: 'rgba(236, 72, 153, 0.3)' },
    'Entertainment': { solid: '#c084fc', light: 'rgba(168, 85, 247, 0.3)' },
    'Health & Wellbeing': { solid: '#f87171', light: 'rgba(239, 68, 68, 0.3)' },
    'Insurance': { solid: '#2dd4bf', light: 'rgba(20, 184, 166, 0.3)' },
    'Travel & Holidays': { solid: '#22d3ee', light: 'rgba(34, 211, 238, 0.3)' },
    'Children': { solid: '#fb7185', light: 'rgba(251, 113, 133, 0.3)' },
    'Pets': { solid: '#f59e0b', light: 'rgba(245, 158, 11, 0.3)' },
    'Income': { solid: '#34d399', light: 'rgba(16, 185, 129, 0.3)' },
    'Savings & Investments': { solid: '#4ade80', light: 'rgba(34, 197, 94, 0.3)' },
    'Fees & Charges': { solid: '#94a3b8', light: 'rgba(100, 116, 139, 0.3)' },
    'Subscriptions': { solid: '#a78bfa', light: 'rgba(139, 92, 246, 0.3)' },
    'Education': { solid: '#38bdf8', light: 'rgba(56, 189, 248, 0.3)' },
    'Charity & Donations': { solid: '#e879f9', light: 'rgba(232, 121, 249, 0.3)' },
    'Transfer': { solid: '#818cf8', light: 'rgba(99, 102, 241, 0.3)' },
    'Uncategorized': { solid: '#94a3b8', light: 'rgba(148, 163, 184, 0.3)' }
  },

  getCategoryColor(category) {
    return this.categoryColors[category] || { solid: '#94a3b8', light: 'rgba(148, 163, 184, 0.3)' };
  },

  async load() {
    await Accounts.refreshAllBalances();

    this.allTransactions = [];
    for (const account of Accounts.list) {
      const transactions = await API.getTransactions(account.id);
      transactions.forEach(tx => {
        tx._accountId = account.id;
        tx._accountType = account.type;
      });
      this.allTransactions.push(...transactions);
    }

    this.categories = await API.getCategories();
    this.recurringList = await API.getRecurring();

    // Load account selection for chart
    this.loadAccountSelection();
    this.renderAccountToggles();

    this.renderCards();
    this.renderNetWorthChart();
    this.renderSankeyChart();
  },

  loadAccountSelection() {
    // Load from localStorage or use default (bank + credit accounts)
    const saved = localStorage.getItem('chartSelectedAccounts');
    if (saved) {
      try {
        const savedIds = JSON.parse(saved);
        // Validate that saved IDs still exist
        this.selectedAccounts = savedIds.filter(id =>
          Accounts.list.some(a => a.id === id)
        );
        // If all saved accounts were deleted, reset to default
        if (this.selectedAccounts.length === 0) {
          this.setDefaultAccountSelection();
        }
      } catch {
        this.setDefaultAccountSelection();
      }
    } else {
      this.setDefaultAccountSelection();
    }
  },

  setDefaultAccountSelection() {
    // Default: Bank accounts and Credit cards (Cash in Hand)
    this.selectedAccounts = Accounts.list
      .filter(a => a.type === 'bank' || a.type === 'credit')
      .map(a => a.id);
  },

  saveAccountSelection() {
    localStorage.setItem('chartSelectedAccounts', JSON.stringify(this.selectedAccounts));
  },

  renderAccountToggles() {
    const container = document.getElementById('chartAccountToggles');
    if (!container) return;

    container.innerHTML = Accounts.list.map(account => {
      const isActive = this.selectedAccounts.includes(account.id);
      const iconHtml = account.icon
        ? `<img src="${account.icon}" alt="">`
        : `<span>${account.name.charAt(0)}</span>`;

      return `
        <button class="account-toggle ${isActive ? 'active' : ''}" data-account-id="${account.id}">
          <span class="account-toggle-icon">${iconHtml}</span>
          <span class="account-toggle-name">${account.name}</span>
        </button>
      `;
    }).join('');

    // Add click handlers
    container.querySelectorAll('.account-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const accountId = btn.dataset.accountId;
        this.toggleAccount(accountId);
      });
    });

    this.updateChartTitle();
  },

  toggleAccount(accountId) {
    const index = this.selectedAccounts.indexOf(accountId);
    if (index === -1) {
      this.selectedAccounts.push(accountId);
    } else {
      this.selectedAccounts.splice(index, 1);
    }

    this.saveAccountSelection();

    // Update UI
    const btn = document.querySelector(`.account-toggle[data-account-id="${accountId}"]`);
    if (btn) {
      btn.classList.toggle('active', this.selectedAccounts.includes(accountId));
    }

    this.updateChartTitle();
    this.renderNetWorthChart();
  },

  updateChartTitle() {
    const titleEl = document.getElementById('balanceChartTitle');
    if (!titleEl) return;

    const selected = this.selectedAccounts.length;
    const total = Accounts.list.length;

    if (selected === 0) {
      titleEl.textContent = 'No Accounts Selected';
    } else if (selected === total) {
      titleEl.textContent = 'Net Worth';
    } else {
      // Check if it's the default "Cash in Hand" selection
      const selectedAccounts = Accounts.list.filter(a => this.selectedAccounts.includes(a.id));
      const allBank = selectedAccounts.every(a => a.type === 'bank');
      const allBankAndCredit = selectedAccounts.every(a => a.type === 'bank' || a.type === 'credit');
      const hasBank = selectedAccounts.some(a => a.type === 'bank');
      const hasCredit = selectedAccounts.some(a => a.type === 'credit');

      if (allBankAndCredit && hasBank && hasCredit) {
        titleEl.textContent = 'Cash in Hand';
      } else if (allBank) {
        titleEl.textContent = 'Bank Balance';
      } else if (selected === 1) {
        titleEl.textContent = selectedAccounts[0].name;
      } else {
        titleEl.textContent = `${selected} Accounts`;
      }
    }
  },

  renderCards() {
    let cash = 0;
    let savings = 0;
    let debt = 0;
    let netWorth = 0;

    for (const account of Accounts.list) {
      const balance = account._cachedBalance || account.startingBalance;

      // Categorize for display cards
      switch (account.type) {
        case 'bank':
        case 'asset':
          cash += balance;
          break;
        case 'savings':
        case 'investment':
          savings += balance;
          break;
        case 'credit':
        case 'loan':
          // Debt is shown as positive (amount owed)
          debt += Math.abs(balance);
          break;
      }

      // Net worth calculation - same logic as chart
      // For accounts with assetValue (loan/investment/asset): netWorth = assetValue + balance
      // For other accounts: netWorth = balance
      if (['loan', 'investment', 'asset'].includes(account.type) && account.assetValue) {
        netWorth += account.assetValue + balance;
      } else {
        netWorth += balance;
      }
    }

    const netWorthEl = document.getElementById('dashboardNetWorth');
    netWorthEl.textContent = App.formatCurrency(netWorth);
    netWorthEl.className = 'dashboard-card-value';
    if (netWorth > 0) netWorthEl.classList.add('positive');
    else if (netWorth < 0) netWorthEl.classList.add('negative');

    document.getElementById('dashboardCash').textContent = App.formatCurrency(cash);
    document.getElementById('dashboardSavings').textContent = App.formatCurrency(savings);
    document.getElementById('dashboardDebt').textContent = App.formatCurrency(debt);
  },

  getDateRange(range) {
    const end = new Date();
    const start = new Date();

    switch (range) {
      case '1w': start.setDate(start.getDate() - 7); break;
      case '1m': start.setMonth(start.getMonth() - 1); break;
      case '3m': start.setMonth(start.getMonth() - 3); break;
      case '6m': start.setMonth(start.getMonth() - 6); break;
      case '1y': start.setFullYear(start.getFullYear() - 1); break;
      case '5y': start.setFullYear(start.getFullYear() - 5); break;
    }

    return { start, end };
  },

  getForecastEndDate(forecastRange) {
    const end = new Date();
    switch (forecastRange) {
      case '1m': end.setMonth(end.getMonth() + 1); break;
      case '3m': end.setMonth(end.getMonth() + 3); break;
      case '6m': end.setMonth(end.getMonth() + 6); break;
      case '1y': end.setFullYear(end.getFullYear() + 1); break;
      case '5y': end.setFullYear(end.getFullYear() + 5); break;
      default: return null;
    }
    return end;
  },

  // Calculate next due date for a recurring payment (same logic as server)
  calculateNextDueDate(currentDate, frequency) {
    const date = new Date(currentDate);
    const { type, interval } = frequency;

    switch (type) {
      case 'days':
        date.setDate(date.getDate() + interval);
        break;
      case 'weeks':
        date.setDate(date.getDate() + (interval * 7));
        break;
      case 'months':
        date.setMonth(date.getMonth() + interval);
        break;
      case 'years':
        date.setFullYear(date.getFullYear() + interval);
        break;
    }
    return date;
  },

  // Generate forecast transactions from recurring payments
  generateForecastTransactions(forecastEnd) {
    if (!forecastEnd) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const forecastTxs = [];

    for (const recurring of this.recurringList) {
      if (!recurring.active) continue;

      let nextDate = new Date(recurring.nextDueDate);
      const endDate = recurring.endCondition?.type === 'date'
        ? new Date(recurring.endCondition.date)
        : null;
      let occurrences = 0;
      const maxOccurrences = recurring.endCondition?.type === 'occurrences'
        ? recurring.endCondition.count - (recurring.completedOccurrences || 0)
        : Infinity;

      while (nextDate <= forecastEnd && occurrences < maxOccurrences) {
        if (endDate && nextDate > endDate) break;

        if (nextDate >= today) {
          if (recurring.type === 'transfer') {
            // Transfer creates two transactions
            forecastTxs.push({
              date: nextDate.toISOString().split('T')[0],
              amount: -Math.abs(recurring.amount),
              category: 'Transfer',
              _accountId: recurring.fromAccountId,
              _isForecast: true
            });
            forecastTxs.push({
              date: nextDate.toISOString().split('T')[0],
              amount: Math.abs(recurring.amount),
              category: 'Transfer',
              _accountId: recurring.toAccountId,
              _isForecast: true
            });
          } else {
            forecastTxs.push({
              date: nextDate.toISOString().split('T')[0],
              amount: recurring.amount,
              category: recurring.category,
              _accountId: recurring.accountId,
              _isForecast: true
            });
          }
        }

        nextDate = this.calculateNextDueDate(nextDate, recurring.frequency);
        occurrences++;
      }
    }

    return forecastTxs;
  },

  calculateForecastNetWorth(forecastRange) {
    const forecastEnd = this.getForecastEndDate(forecastRange);
    if (!forecastEnd) return [];

    const today = new Date();
    const forecastTxs = this.generateForecastTransactions(forecastEnd);

    // Filter to only selected accounts
    const selectedAccountSet = new Set(this.selectedAccounts);
    const accountsToUse = Accounts.list.filter(a => selectedAccountSet.has(a.id));

    // Filter forecast transactions to only selected accounts
    const filteredForecastTxs = forecastTxs.filter(tx => selectedAccountSet.has(tx._accountId));

    if (filteredForecastTxs.length === 0 && accountsToUse.length === 0) return [];

    // Get current balances as starting point for selected accounts
    const balances = {};
    for (const account of accountsToUse) {
      balances[account.id] = account._cachedBalance || account.startingBalance;
    }

    // Sort forecast transactions by date
    filteredForecastTxs.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Determine number of points based on forecast range
    let numPoints;
    switch (forecastRange) {
      case '1m': numPoints = 30; break;
      case '3m': numPoints = 90; break;
      case '6m': numPoints = 180; break;
      case '1y': numPoints = 365; break;
      case '5y': numPoints = 60; break;
      default: numPoints = 30;
    }

    const interval = (forecastEnd - today) / numPoints;
    const dataPoints = [];
    let txIndex = 0;

    for (let i = 0; i <= numPoints; i++) {
      const pointDate = new Date(today.getTime() + (interval * i));

      // Apply transactions up to this point
      while (txIndex < filteredForecastTxs.length && new Date(filteredForecastTxs[txIndex].date) <= pointDate) {
        const tx = filteredForecastTxs[txIndex];
        balances[tx._accountId] = (balances[tx._accountId] || 0) + tx.amount;
        txIndex++;
      }

      // Calculate net worth at this point for selected accounts only
      let netWorth = 0;
      for (const account of accountsToUse) {
        const balance = balances[account.id] || account.startingBalance;
        if (['loan', 'investment', 'asset'].includes(account.type) && account.assetValue) {
          netWorth += account.assetValue + balance;
        } else {
          netWorth += balance;
        }
      }

      dataPoints.push({ date: pointDate, value: netWorth, isForecast: true });
    }

    return dataPoints;
  },

  calculateNetWorthOverTime(range) {
    const { start, end } = this.getDateRange(range);
    const dataPoints = [];

    // Filter to only selected accounts
    const selectedAccountSet = new Set(this.selectedAccounts);
    const accountsToUse = Accounts.list.filter(a => selectedAccountSet.has(a.id));

    const accountStartingBalances = {};
    for (const account of accountsToUse) {
      let balance = account.startingBalance;
      const accountTxs = this.allTransactions.filter(tx => tx._accountId === account.id);
      for (const tx of accountTxs) {
        if (new Date(tx.date) < start) {
          balance += tx.amount;
        }
      }
      accountStartingBalances[account.id] = balance;
    }

    const txsInRange = this.allTransactions
      .filter(tx => {
        const txDate = new Date(tx.date);
        return txDate >= start && txDate <= end && selectedAccountSet.has(tx._accountId);
      })
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    let numPoints;
    switch (range) {
      case '1w': numPoints = 7; break;
      case '1m': numPoints = 30; break;
      case '3m': numPoints = 90; break;
      case '6m': numPoints = 180; break;
      case '1y': numPoints = 365; break;
      case '5y': numPoints = 60; break;
    }

    const interval = (end - start) / numPoints;
    const balances = { ...accountStartingBalances };
    let txIndex = 0;

    for (let i = 0; i <= numPoints; i++) {
      const pointDate = new Date(start.getTime() + (interval * i));

      while (txIndex < txsInRange.length && new Date(txsInRange[txIndex].date) <= pointDate) {
        const tx = txsInRange[txIndex];
        balances[tx._accountId] = (balances[tx._accountId] || 0) + tx.amount;
        txIndex++;
      }

      let netWorth = 0;
      for (const account of accountsToUse) {
        const balance = balances[account.id] || account.startingBalance;
        if (['loan', 'investment', 'asset'].includes(account.type) && account.assetValue) {
          netWorth += account.assetValue + balance;
        } else {
          netWorth += balance;
        }
      }

      dataPoints.push({ date: pointDate, value: netWorth });
    }

    return dataPoints;
  },

  // Calculate nice round scale bounds that include 0
  calculateNiceScale(dataMin, dataMax) {
    // Always include 0 in the scale
    const min = Math.min(0, dataMin);
    const max = Math.max(0, dataMax);

    // Calculate the range we need to cover
    const range = max - min;
    if (range === 0) return { min: -100, max: 100, step: 50 };

    // Find a nice step size (powers of 10 multiplied by 1, 2, or 5)
    const rawStep = range / 5; // We want roughly 5 divisions
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    let step;

    if (rawStep / magnitude < 1.5) {
      step = magnitude;
    } else if (rawStep / magnitude < 3) {
      step = magnitude * 2;
    } else if (rawStep / magnitude < 7) {
      step = magnitude * 5;
    } else {
      step = magnitude * 10;
    }

    // Round min down and max up to nice values
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;

    return { min: niceMin, max: niceMax, step };
  },

  renderNetWorthChart() {
    const container = document.getElementById('netWorthChart');

    // Handle no accounts selected
    if (this.selectedAccounts.length === 0) {
      container.innerHTML = '<p class="empty-state">Select accounts to view chart</p>';
      return;
    }

    const historicalData = this.calculateNetWorthOverTime(this.currentRange);
    const forecastData = this.currentForecast !== '0'
      ? this.calculateForecastNetWorth(this.currentForecast)
      : [];

    // Combine data for chart (historical + forecast)
    const allData = [...historicalData, ...forecastData.slice(1)]; // Skip first forecast point (same as last historical)
    this.chartData = allData; // Store for hover

    if (historicalData.length === 0) {
      container.innerHTML = '<p class="empty-state">No data available</p>';
      return;
    }

    const width = container.clientWidth || 800;
    const height = 364;
    const padding = { top: 20, right: 20, bottom: 40, left: 70 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const values = allData.map(d => d.value);
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);

    // Calculate nice scale that includes 0
    const scale = this.calculateNiceScale(dataMin, dataMax);
    const minVal = scale.min;
    const maxVal = scale.max;

    // Store scale info for hover
    this.chartScales = {
      width, height, padding, chartWidth, chartHeight, minVal, maxVal,
      xScale: (i) => padding.left + (i / (allData.length - 1)) * chartWidth,
      yScale: (v) => padding.top + chartHeight - ((v - minVal) / (maxVal - minVal)) * chartHeight
    };

    const { xScale, yScale } = this.chartScales;
    const zeroY = yScale(0);
    const zeroInView = minVal <= 0 && maxVal >= 0;

    // Build paths for historical data - split into above and below zero
    let historicalPathD = `M ${xScale(0)} ${yScale(historicalData[0].value)}`;
    for (let i = 1; i < historicalData.length; i++) {
      historicalPathD += ` L ${xScale(i)} ${yScale(historicalData[i].value)}`;
    }

    // Create area fills - separate for above and below zero
    const histEndX = xScale(historicalData.length - 1);
    const histStartX = xScale(0);

    // For area fills, we need to clip at zero
    // Above zero area (green)
    let aboveZeroAreaD = '';
    let belowZeroAreaD = '';

    if (zeroInView) {
      // Build path segments above zero
      let abovePoints = [];
      let belowPoints = [];

      for (let i = 0; i < historicalData.length; i++) {
        const x = xScale(i);
        const y = yScale(historicalData[i].value);
        const val = historicalData[i].value;

        // Handle crossing points
        if (i > 0) {
          const prevVal = historicalData[i - 1].value;
          const prevX = xScale(i - 1);

          // Check if we crossed zero
          if ((prevVal >= 0 && val < 0) || (prevVal < 0 && val >= 0)) {
            // Calculate intersection point
            const t = prevVal / (prevVal - val);
            const crossX = prevX + t * (x - prevX);

            abovePoints.push({ x: crossX, y: zeroY });
            belowPoints.push({ x: crossX, y: zeroY });
          }
        }

        if (val >= 0) {
          abovePoints.push({ x, y });
          // Close any gap in below points at zero line
          if (belowPoints.length > 0) {
            belowPoints.push({ x, y: zeroY });
          }
        } else {
          belowPoints.push({ x, y });
          // Close any gap in above points at zero line
          if (abovePoints.length > 0) {
            abovePoints.push({ x, y: zeroY });
          }
        }
      }

      // Build above zero area path
      if (abovePoints.length > 0) {
        aboveZeroAreaD = `M ${abovePoints[0].x} ${zeroY}`;
        for (const p of abovePoints) {
          aboveZeroAreaD += ` L ${p.x} ${p.y}`;
        }
        aboveZeroAreaD += ` L ${abovePoints[abovePoints.length - 1].x} ${zeroY} Z`;
      }

      // Build below zero area path
      if (belowPoints.length > 0) {
        belowZeroAreaD = `M ${belowPoints[0].x} ${zeroY}`;
        for (const p of belowPoints) {
          belowZeroAreaD += ` L ${p.x} ${p.y}`;
        }
        belowZeroAreaD += ` L ${belowPoints[belowPoints.length - 1].x} ${zeroY} Z`;
      }
    } else {
      // All data is on one side of zero - fill from data to zero line
      if (dataMin >= 0) {
        // All positive - fill down to zero
        aboveZeroAreaD = historicalPathD + ` L ${histEndX} ${zeroY} L ${histStartX} ${zeroY} Z`;
      } else {
        // All negative - fill up to zero
        belowZeroAreaD = historicalPathD + ` L ${histEndX} ${zeroY} L ${histStartX} ${zeroY} Z`;
      }
    }

    // Forecast path (if enabled)
    let forecastPathD = '';
    const forecastStartIndex = historicalData.length - 1;

    if (forecastData.length > 1) {
      forecastPathD = `M ${xScale(forecastStartIndex)} ${yScale(historicalData[historicalData.length - 1].value)}`;
      for (let i = 1; i < forecastData.length; i++) {
        forecastPathD += ` L ${xScale(forecastStartIndex + i)} ${yScale(forecastData[i].value)}`;
      }
    }

    // Generate y-axis labels at nice intervals
    const yLabels = [];
    for (let val = minVal; val <= maxVal; val += scale.step) {
      const y = yScale(val);
      yLabels.push({ value: val, y, label: this.formatCompactCurrency(val) });
    }

    // Generate x-axis labels
    const xLabels = [];
    const totalPoints = allData.length;
    const numXLabels = Math.min(6, totalPoints);
    for (let i = 0; i < numXLabels; i++) {
      const idx = Math.floor((i / (numXLabels - 1)) * (totalPoints - 1));
      const point = allData[idx];
      const labelRange = point.isForecast ? this.currentForecast : this.currentRange;
      xLabels.push({ x: xScale(idx), label: this.formatChartDate(point.date, labelRange) });
    }

    // Forecast colors (greyed out)
    const forecastLineColor = '#94a3b8';

    container.innerHTML = `
      <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" id="netWorthSvg">
        <defs>
          <linearGradient id="aboveZeroGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:rgba(34, 197, 94, 0.4)"/>
            <stop offset="100%" style="stop-color:rgba(34, 197, 94, 0.05)"/>
          </linearGradient>
          <linearGradient id="belowZeroGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:rgba(239, 68, 68, 0.05)"/>
            <stop offset="100%" style="stop-color:rgba(239, 68, 68, 0.4)"/>
          </linearGradient>
          <linearGradient id="forecastGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:rgba(148, 163, 184, 0.25)"/>
            <stop offset="100%" style="stop-color:rgba(148, 163, 184, 0.02)"/>
          </linearGradient>
        </defs>

        <!-- Grid lines -->
        ${yLabels.map(l => `
          <line x1="${padding.left}" y1="${l.y}" x2="${width - padding.right}" y2="${l.y}"
                stroke="${l.value === 0 ? 'rgba(148, 163, 184, 0.5)' : 'rgba(148, 163, 184, 0.2)'}"
                stroke-dasharray="${l.value === 0 ? 'none' : '4,4'}"
                stroke-width="${l.value === 0 ? '2' : '1'}"/>
        `).join('')}

        <!-- Above zero area fill (green) -->
        ${aboveZeroAreaD ? `<path d="${aboveZeroAreaD}" fill="url(#aboveZeroGradient)"/>` : ''}

        <!-- Below zero area fill (red) -->
        ${belowZeroAreaD ? `<path d="${belowZeroAreaD}" fill="url(#belowZeroGradient)"/>` : ''}

        <!-- Forecast divider line -->
        ${forecastData.length > 1 ? `
          <line x1="${histEndX}" y1="${padding.top}" x2="${histEndX}" y2="${height - padding.bottom}"
                stroke="#94a3b8" stroke-width="1" stroke-dasharray="4,4" opacity="0.5"/>
          <text x="${histEndX + 5}" y="${padding.top + 12}" fill="#94a3b8" font-size="10" font-family="system-ui">Forecast</text>
        ` : ''}

        <!-- Historical line - gradient from green (above 0) to red (below 0) -->
        <path d="${historicalPathD}" fill="none" stroke="url(#lineGradient)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>

        <!-- Line segments colored by value -->
        ${this.buildColoredLinePath(historicalData, xScale, yScale)}

        <!-- Forecast line (dashed, greyed) -->
        ${forecastPathD ? `
          <path d="${forecastPathD}" fill="none" stroke="${forecastLineColor}" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="8,4"/>
        ` : ''}

        <!-- Zero line label -->
        ${zeroInView ? `
          <text x="${padding.left - 10}" y="${zeroY + 4}" text-anchor="end"
                fill="#f1f5f9" font-size="11" font-weight="600" font-family="system-ui">${this.formatCompactCurrency(0)}</text>
        ` : ''}

        <!-- Y-axis labels -->
        ${yLabels.filter(l => l.value !== 0).map(l => `
          <text x="${padding.left - 10}" y="${l.y + 4}" text-anchor="end"
                fill="#94a3b8" font-size="11" font-family="system-ui">${l.label}</text>
        `).join('')}

        <!-- X-axis labels -->
        ${xLabels.map(l => `
          <text x="${l.x}" y="${height - 10}" text-anchor="middle"
                fill="#94a3b8" font-size="11" font-family="system-ui">${l.label}</text>
        `).join('')}

        <!-- Hover elements (hidden by default) -->
        <line id="hoverLine" x1="0" y1="${padding.top}" x2="0" y2="${height - padding.bottom}"
              stroke="#f1f5f9" stroke-width="1" stroke-dasharray="4,4" opacity="0"/>
        <circle id="hoverDot" cx="0" cy="0" r="6" fill="#22c55e" opacity="0"/>
        <g id="hoverTooltip" opacity="0">
          <rect x="0" y="0" width="140" height="50" rx="8" fill="rgba(15, 23, 42, 0.9)" stroke="#64748b" stroke-width="1"/>
          <text id="hoverDate" x="70" y="20" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="system-ui"></text>
          <text id="hoverValue" x="70" y="38" text-anchor="middle" fill="#22c55e" font-size="14" font-weight="600" font-family="system-ui"></text>
        </g>

        <!-- Invisible overlay for mouse tracking -->
        <rect x="${padding.left}" y="${padding.top}" width="${chartWidth}" height="${chartHeight}"
              fill="transparent" id="chartOverlay" style="cursor: crosshair;"/>
      </svg>
    `;

    // Add hover event listeners
    this.setupChartHover(historicalData.length);
  },

  // Build line path with segments colored by whether value is above/below zero
  buildColoredLinePath(data, xScale, yScale) {
    if (data.length < 2) return '';

    let paths = '';

    for (let i = 1; i < data.length; i++) {
      const prevVal = data[i - 1].value;
      const val = data[i].value;
      const prevX = xScale(i - 1);
      const prevY = yScale(prevVal);
      const x = xScale(i);
      const y = yScale(val);

      // Check if segment crosses zero
      if ((prevVal >= 0 && val < 0) || (prevVal < 0 && val >= 0)) {
        // Calculate intersection point
        const t = prevVal / (prevVal - val);
        const crossX = prevX + t * (x - prevX);
        const crossY = yScale(0);

        // Draw two segments
        const color1 = prevVal >= 0 ? '#22c55e' : '#ef4444';
        const color2 = val >= 0 ? '#22c55e' : '#ef4444';

        paths += `<line x1="${prevX}" y1="${prevY}" x2="${crossX}" y2="${crossY}"
                        stroke="${color1}" stroke-width="3" stroke-linecap="round"/>`;
        paths += `<line x1="${crossX}" y1="${crossY}" x2="${x}" y2="${y}"
                        stroke="${color2}" stroke-width="3" stroke-linecap="round"/>`;
      } else {
        // Single color segment
        const color = val >= 0 ? '#22c55e' : '#ef4444';
        paths += `<line x1="${prevX}" y1="${prevY}" x2="${x}" y2="${y}"
                        stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
      }
    }

    return paths;
  },

  setupChartHover(historicalLength) {
    const overlay = document.getElementById('chartOverlay');
    const hoverLine = document.getElementById('hoverLine');
    const hoverDot = document.getElementById('hoverDot');
    const hoverTooltip = document.getElementById('hoverTooltip');
    const hoverDate = document.getElementById('hoverDate');
    const hoverValue = document.getElementById('hoverValue');
    const svg = document.getElementById('netWorthSvg');

    if (!overlay) return;

    const { padding, chartWidth, xScale, yScale } = this.chartScales;
    const data = this.chartData;
    const forecastLineColor = '#94a3b8';

    overlay.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const svgX = (e.clientX - rect.left) * (svg.viewBox.baseVal.width / rect.width);

      // Find closest data point
      const relativeX = svgX - padding.left;
      const dataIndex = Math.round((relativeX / chartWidth) * (data.length - 1));
      const clampedIndex = Math.max(0, Math.min(data.length - 1, dataIndex));

      const point = data[clampedIndex];
      const x = xScale(clampedIndex);
      const y = yScale(point.value);

      // Color based on value (green above 0, red below 0) or grey for forecast
      const isForecast = point.isForecast;
      const valueColor = point.value >= 0 ? '#22c55e' : '#ef4444';
      const dotColor = isForecast ? forecastLineColor : valueColor;

      // Update hover elements
      hoverLine.setAttribute('x1', x);
      hoverLine.setAttribute('x2', x);
      hoverLine.setAttribute('opacity', '1');

      hoverDot.setAttribute('cx', x);
      hoverDot.setAttribute('cy', y);
      hoverDot.setAttribute('fill', dotColor);
      hoverDot.setAttribute('opacity', '1');

      // Position tooltip
      let tooltipX = x - 70;
      if (tooltipX < padding.left) tooltipX = padding.left;
      if (tooltipX + 140 > this.chartScales.width - padding.right) {
        tooltipX = this.chartScales.width - padding.right - 140;
      }
      let tooltipY = y - 60;
      if (tooltipY < 5) tooltipY = y + 15;

      hoverTooltip.setAttribute('transform', `translate(${tooltipX}, ${tooltipY})`);
      hoverTooltip.setAttribute('opacity', '1');

      const dateLabel = point.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      hoverDate.textContent = isForecast ? `${dateLabel} (forecast)` : dateLabel;
      hoverValue.textContent = App.formatCurrency(point.value);
      hoverValue.setAttribute('fill', dotColor);
    });

    overlay.addEventListener('mouseleave', () => {
      hoverLine.setAttribute('opacity', '0');
      hoverDot.setAttribute('opacity', '0');
      hoverTooltip.setAttribute('opacity', '0');
    });
  },

  formatCompactCurrency(value) {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    const symbol = App.settings?.currencySymbol || '£';
    if (abs >= 1000000) return sign + symbol + (abs / 1000000).toFixed(1) + 'M';
    if (abs >= 1000) return sign + symbol + (abs / 1000).toFixed(1) + 'K';
    return sign + symbol + abs.toFixed(0);
  },

  formatChartDate(date, range) {
    if (range === '1w') return date.toLocaleDateString('en-GB', { weekday: 'short' });
    if (range === '1m' || range === '3m') return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return date.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  },

  calculateCategoryFlows(range) {
    const { start, end } = this.getDateRange(range);

    const txsInRange = this.allTransactions.filter(tx => {
      const txDate = new Date(tx.date);
      return txDate >= start && txDate <= end && tx.category !== 'Transfer';
    });

    // Build category mapping (subcategory -> parent, and get subcategory info)
    const categoryMap = {};
    const subcategoryParent = {};
    for (const cat of this.categories) {
      categoryMap[cat.name] = cat.name;
      for (const sub of (cat.subcategories || [])) {
        subcategoryParent[sub.name] = cat.name;
        categoryMap[sub.name] = cat.name;
      }
    }

    // Find the Income category and its subcategories
    const incomeCategory = this.categories.find(c => c.name === 'Income');
    const incomeSubcategories = incomeCategory?.subcategories?.map(s => s.name) || [];

    // Aggregate: income by subcategory (from Income parent), expenses by parent category
    // Also track refunds (positive amounts in non-income categories) to offset against expenses
    const incomeBySubcat = {};
    const expensesByParent = {};
    const refundsByParent = {};

    for (const tx of txsInRange) {
      const parentCategory = categoryMap[tx.category] || tx.category;

      if (tx.amount > 0) {
        // Positive amount
        if (parentCategory === 'Income') {
          // True income - group by subcategory or 'Other Income'
          const subcat = incomeSubcategories.includes(tx.category) ? tx.category : 'Other Income';
          incomeBySubcat[subcat] = (incomeBySubcat[subcat] || 0) + tx.amount;
        } else {
          // Refund - track separately to offset against expenses
          refundsByParent[parentCategory] = (refundsByParent[parentCategory] || 0) + tx.amount;
        }
      } else {
        // Expense - group by parent category
        expensesByParent[parentCategory] = (expensesByParent[parentCategory] || 0) + Math.abs(tx.amount);
      }
    }

    // Apply refunds to reduce expense amounts
    for (const [parent, refund] of Object.entries(refundsByParent)) {
      if (expensesByParent[parent]) {
        expensesByParent[parent] = Math.max(0, expensesByParent[parent] - refund);
      }
    }

    // Remove zero/negative expense categories
    for (const [key, val] of Object.entries(expensesByParent)) {
      if (val <= 0) delete expensesByParent[key];
    }

    return { income: incomeBySubcat, expenses: expensesByParent };
  },

  calculateForecastCategoryFlows(forecastRange) {
    const forecastEnd = this.getForecastEndDate(forecastRange);
    if (!forecastEnd) return { income: {}, expenses: {} };

    const forecastTxs = this.generateForecastTransactions(forecastEnd);

    // Build category mapping
    const categoryMap = {};
    for (const cat of this.categories) {
      categoryMap[cat.name] = cat.name;
      for (const sub of (cat.subcategories || [])) {
        categoryMap[sub.name] = cat.name;
      }
    }

    const incomeCategory = this.categories.find(c => c.name === 'Income');
    const incomeSubcategories = incomeCategory?.subcategories?.map(s => s.name) || [];

    const incomeBySubcat = {};
    const expensesByParent = {};

    for (const tx of forecastTxs) {
      if (tx.category === 'Transfer') continue;

      const parentCategory = categoryMap[tx.category] || tx.category;

      if (tx.amount > 0) {
        if (parentCategory === 'Income') {
          const subcat = incomeSubcategories.includes(tx.category) ? tx.category : 'Other Income';
          incomeBySubcat[subcat] = (incomeBySubcat[subcat] || 0) + tx.amount;
        }
        // Ignore refunds in forecast
      } else {
        expensesByParent[parentCategory] = (expensesByParent[parentCategory] || 0) + Math.abs(tx.amount);
      }
    }

    return { income: incomeBySubcat, expenses: expensesByParent };
  },

  renderSankeyChart() {
    const container = document.getElementById('sankeyChart');
    const { income, expenses } = this.calculateCategoryFlows(this.currentSankeyRange);
    const forecast = this.currentSankeyForecast !== '0'
      ? this.calculateForecastCategoryFlows(this.currentSankeyForecast)
      : { income: {}, expenses: {} };

    const totalIncome = Object.values(income).reduce((sum, v) => sum + v, 0);
    const totalExpenses = Object.values(expenses).reduce((sum, v) => sum + v, 0);
    const forecastIncome = Object.values(forecast.income).reduce((sum, v) => sum + v, 0);
    const forecastExpenses = Object.values(forecast.expenses).reduce((sum, v) => sum + v, 0);
    const hasForecast = this.currentSankeyForecast !== '0';

    if (totalIncome === 0 && totalExpenses === 0 && !hasForecast) {
      container.innerHTML = '<p class="empty-state">No transaction data for this period</p>';
      return;
    }

    const width = container.clientWidth || 800;
    // Responsive sizing for mobile
    const isMobile = width < 500;
    const height = isMobile ? 420 : 514;
    const padding = isMobile
      ? { top: 25, right: 10, bottom: 50, left: 10 }
      : { top: 30, right: 30, bottom: 40, left: 30 };
    const nodeWidth = isMobile ? 8 : 12;
    const centerX = width / 2;
    const labelPadding = isMobile ? 70 : 120;
    const leftX = padding.left + labelPadding;
    const rightX = width - padding.right - labelPadding;
    const fontSize = isMobile ? { label: 9, amount: 7, title: 10, bottom: 9 } : { label: 12, amount: 10, title: 13, bottom: 13 };
    const maxCategories = isMobile ? 6 : 8;

    const incomeEntries = Object.entries(income).sort((a, b) => b[1] - a[1]).slice(0, maxCategories);
    const expenseEntries = Object.entries(expenses).sort((a, b) => b[1] - a[1]).slice(0, maxCategories);

    const availableHeight = height - padding.top - padding.bottom - 60; // More space for bottom labels
    const surplus = totalIncome - totalExpenses;
    const centerNodeHeight = availableHeight * 0.85;
    const centerNodeY = padding.top + (availableHeight - centerNodeHeight) / 2;

    // Income nodes - use Income category color for all subcategories
    const incomeBaseColor = this.getCategoryColor('Income');
    const incomeNodes = [];
    let incomeY = padding.top;
    const incomeGap = 6;
    const totalIncomeHeight = availableHeight - (incomeEntries.length - 1) * incomeGap;

    for (const [category, amount] of incomeEntries) {
      const nodeHeight = Math.max(24, (amount / totalIncome) * totalIncomeHeight);
      incomeNodes.push({
        category, amount, x: leftX, y: incomeY, height: nodeHeight,
        color: incomeBaseColor.solid, lightColor: incomeBaseColor.light
      });
      incomeY += nodeHeight + incomeGap;
    }

    // Expense nodes with their own category colors
    const expenseNodes = [];
    let expenseY = padding.top;
    const expenseGap = 6;
    const totalExpenseHeight = availableHeight - (expenseEntries.length - 1) * expenseGap;

    for (const [category, amount] of expenseEntries) {
      const nodeHeight = Math.max(24, (amount / totalExpenses) * totalExpenseHeight);
      const colors = this.getCategoryColor(category);
      expenseNodes.push({
        category, amount, x: rightX, y: expenseY, height: nodeHeight,
        color: colors.solid, lightColor: colors.light
      });
      expenseY += nodeHeight + expenseGap;
    }

    // Flow path generator
    const generateFlowPath = (fromX, fromY, fromHeight, toX, toY, toHeight) => {
      const cpOffset = Math.abs(toX - fromX) * 0.5;
      return `M ${fromX} ${fromY}
              C ${fromX + cpOffset} ${fromY}, ${toX - cpOffset} ${toY}, ${toX} ${toY}
              L ${toX} ${toY + toHeight}
              C ${toX - cpOffset} ${toY + toHeight}, ${fromX + cpOffset} ${fromY + fromHeight}, ${fromX} ${fromY + fromHeight}
              Z`;
    };

    // Calculate income flows to center
    let incomeCenterY = centerNodeY;
    const incomeFlows = incomeNodes.map(node => {
      const flowHeight = (node.amount / totalIncome) * centerNodeHeight;
      const path = generateFlowPath(
        node.x + nodeWidth, node.y, node.height,
        centerX - nodeWidth / 2, incomeCenterY, flowHeight
      );
      incomeCenterY += flowHeight;
      return { path, color: node.lightColor };
    });

    // Calculate expense flows from center
    let expenseCenterY = centerNodeY;
    const expenseFlowTotalHeight = totalIncome > 0 ? (totalExpenses / totalIncome) * centerNodeHeight : centerNodeHeight;
    const expenseFlows = expenseNodes.map(node => {
      const flowHeight = (node.amount / totalExpenses) * expenseFlowTotalHeight;
      const path = generateFlowPath(
        centerX + nodeWidth / 2, expenseCenterY, flowHeight,
        node.x, node.y, node.height
      );
      expenseCenterY += flowHeight;
      return { path, color: node.lightColor };
    });

    // Surplus color for label only (center bar is now single color)
    const surplusColor = surplus >= 0 ? '#22c55e' : '#ef4444';

    // Helper to create path for rounded rect with specific corners
    // roundedCorners: { tl, tr, br, bl } - radius for each corner
    const roundedRectPath = (x, y, w, h, corners) => {
      const { tl = 0, tr = 0, br = 0, bl = 0 } = corners;
      return `M ${x + tl} ${y}
              L ${x + w - tr} ${y}
              Q ${x + w} ${y} ${x + w} ${y + tr}
              L ${x + w} ${y + h - br}
              Q ${x + w} ${y + h} ${x + w - br} ${y + h}
              L ${x + bl} ${y + h}
              Q ${x} ${y + h} ${x} ${y + h - bl}
              L ${x} ${y + tl}
              Q ${x} ${y} ${x + tl} ${y}
              Z`;
    };

    container.innerHTML = `
      <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}">
        <defs>
          ${incomeNodes.map((n, i) => `
            <linearGradient id="incomeGrad${i}" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" style="stop-color:${n.color};stop-opacity:0.7"/>
              <stop offset="100%" style="stop-color:${n.color};stop-opacity:0.2"/>
            </linearGradient>
          `).join('')}
          ${expenseNodes.map((n, i) => `
            <linearGradient id="expenseGrad${i}" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" style="stop-color:${incomeBaseColor.solid};stop-opacity:0.2"/>
              <stop offset="100%" style="stop-color:${n.color};stop-opacity:0.7"/>
            </linearGradient>
          `).join('')}
        </defs>

        <!-- Income flows -->
        ${incomeFlows.map((f, i) => `<path d="${f.path}" fill="url(#incomeGrad${i})"/>`).join('')}

        <!-- Expense flows -->
        ${expenseFlows.map((f, i) => `<path d="${f.path}" fill="url(#expenseGrad${i})"/>`).join('')}

        <!-- Income nodes (rounded left side only) -->
        ${incomeNodes.map(n => `
          <path d="${roundedRectPath(n.x, n.y, nodeWidth, n.height, { tl: 6, bl: 6, tr: 0, br: 0 })}"
                fill="${n.color}"/>
        `).join('')}

        <!-- Income labels -->
        ${incomeNodes.map(n => `
          <text x="${n.x - (isMobile ? 6 : 10)}" y="${n.y + n.height / 2}" text-anchor="end" dominant-baseline="middle"
                fill="${n.color}" font-size="${fontSize.label}" font-weight="600" font-family="system-ui">${n.category}</text>
          <text x="${n.x - (isMobile ? 6 : 10)}" y="${n.y + n.height / 2 + (isMobile ? 10 : 14)}" text-anchor="end" dominant-baseline="middle"
                fill="#94a3b8" font-size="${fontSize.amount}" font-family="system-ui">${App.formatCurrency(n.amount)}</text>
        `).join('')}

        <!-- Center node (green, no rounded corners) -->
        <rect x="${centerX - nodeWidth / 2}" y="${centerNodeY}" width="${nodeWidth}"
              height="${centerNodeHeight}" fill="#22c55e"/>

        <!-- Center label -->
        <text x="${centerX}" y="${centerNodeY - 12}" text-anchor="middle"
              fill="#f1f5f9" font-size="${fontSize.title}" font-weight="600" font-family="system-ui">Cash Flow</text>

        <!-- Expense nodes (rounded right side only) -->
        ${expenseNodes.map(n => `
          <path d="${roundedRectPath(n.x, n.y, nodeWidth, n.height, { tl: 0, bl: 0, tr: 6, br: 6 })}"
                fill="${n.color}"/>
        `).join('')}

        <!-- Expense labels -->
        ${expenseNodes.map(n => `
          <text x="${n.x + nodeWidth + (isMobile ? 6 : 10)}" y="${n.y + n.height / 2}" text-anchor="start" dominant-baseline="middle"
                fill="${n.color}" font-size="${fontSize.label}" font-weight="600" font-family="system-ui">${n.category}</text>
          <text x="${n.x + nodeWidth + (isMobile ? 6 : 10)}" y="${n.y + n.height / 2 + (isMobile ? 10 : 14)}" text-anchor="start" dominant-baseline="middle"
                fill="#94a3b8" font-size="${fontSize.amount}" font-family="system-ui">${App.formatCurrency(n.amount)}</text>
        `).join('')}

        <!-- Totals at bottom (positioned below the chart area) -->
        ${isMobile ? `
        <text x="${leftX + nodeWidth / 2}" y="${height - 28}" text-anchor="middle"
              fill="#22c55e" font-size="${fontSize.bottom}" font-weight="700" font-family="system-ui">
          In: ${App.formatCurrency(totalIncome)}
        </text>
        <text x="${centerX}" y="${height - 28}" text-anchor="middle"
              fill="${surplusColor}" font-size="${fontSize.bottom}" font-weight="700" font-family="system-ui">
          ${surplus >= 0 ? '+' : ''}${App.formatCurrency(surplus)}
        </text>
        <text x="${rightX + nodeWidth / 2}" y="${height - 28}" text-anchor="middle"
              fill="#ef4444" font-size="${fontSize.bottom}" font-weight="700" font-family="system-ui">
          Out: ${App.formatCurrency(totalExpenses)}
        </text>
        <text x="${centerX}" y="${height - 10}" text-anchor="middle"
              fill="#64748b" font-size="8" font-family="system-ui">
          ${hasForecast ? `Forecast: +${App.formatCurrency(forecastIncome)} / -${App.formatCurrency(forecastExpenses)}` : ''}
        </text>
        ` : `
        <text x="${leftX + nodeWidth / 2}" y="${height - 8}" text-anchor="middle"
              fill="#22c55e" font-size="${fontSize.bottom}" font-weight="700" font-family="system-ui">
          Income: ${App.formatCurrency(totalIncome)}${hasForecast ? ` (+${App.formatCurrency(forecastIncome)})` : ''}
        </text>
        <text x="${centerX}" y="${height - 8}" text-anchor="middle"
              fill="${surplusColor}" font-size="${fontSize.bottom}" font-weight="700" font-family="system-ui">
          ${surplus >= 0 ? 'Surplus' : 'Deficit'}: ${App.formatCurrency(Math.abs(surplus))}
        </text>
        <text x="${rightX + nodeWidth / 2}" y="${height - 8}" text-anchor="middle"
              fill="#ef4444" font-size="${fontSize.bottom}" font-weight="700" font-family="system-ui">
          Expenses: ${App.formatCurrency(totalExpenses)}${hasForecast ? ` (+${App.formatCurrency(forecastExpenses)})` : ''}
        </text>
        `}

        <!-- Forecast indicator (desktop only) -->
        ${hasForecast && !isMobile ? `
          <text x="${width - padding.right}" y="${padding.top}" text-anchor="end"
                fill="#94a3b8" font-size="11" font-style="italic" font-family="system-ui">
            Forecast: +${App.formatCurrency(forecastIncome - forecastExpenses)} net
          </text>
        ` : ''}
      </svg>
    `;
  },

  init() {
    // Net worth chart range buttons
    document.querySelectorAll('[data-range]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-range]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentRange = btn.dataset.range;
        this.renderNetWorthChart();
      });
    });

    // Net worth chart forecast buttons
    document.querySelectorAll('[data-forecast]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-forecast]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentForecast = btn.dataset.forecast;
        this.renderNetWorthChart();
      });
    });

    // Sankey chart range buttons
    document.querySelectorAll('[data-sankey-range]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-sankey-range]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentSankeyRange = btn.dataset.sankeyRange;
        this.renderSankeyChart();
      });
    });

    // Sankey chart forecast buttons
    document.querySelectorAll('[data-sankey-forecast]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-sankey-forecast]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentSankeyForecast = btn.dataset.sankeyForecast;
        this.renderSankeyChart();
      });
    });

    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (!document.getElementById('dashboardView').classList.contains('hidden')) {
          this.renderNetWorthChart();
          this.renderSankeyChart();
        }
      }, 250);
    });
  }
};

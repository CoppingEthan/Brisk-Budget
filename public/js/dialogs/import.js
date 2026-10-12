import { html, render, $, $$, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { state, changed, category, UNCATEGORIZED } from '../core/state.js';
import { money, date as formatDate, plural } from '../core/format.js';
import { openDialog } from '../ui/dialog.js';
import { busy, categoryOptions } from '../ui/forms.js';
import { toast, toastError } from '../ui/toast.js';
import { decodeText, parseCSVLines, findTable, guessColumns, detectDateFormat, buildTransactions, DATE_FORMATS } from '../shared/csv.js';

const FIELDS = [
  { key: 'date', label: 'Date', required: true },
  { key: 'payee', label: 'Payee' },
  { key: 'amount', label: 'Amount', required: true, mode: 'single' },
  { key: 'paidIn', label: 'Paid in', required: true, mode: 'split' },
  { key: 'paidOut', label: 'Paid out', required: true, mode: 'split' },
  { key: 'category', label: 'Category' },
  { key: 'description', label: 'Description' },
  { key: 'notes', label: 'Notes' }
];

// The server takes at most this many rows in one import
const MAX_ROWS = 20000;
// and keeps a remembered profile under 4,000 characters
const MAX_PROFILE = 3900;

// "line 5", "lines 5 and 9", "lines 5, 9, 12, 14, 20 and 3 more"
function lineList(rows) {
  const lines = rows.map(r => r.line).filter(Boolean);
  if (!lines.length) return '';
  if (lines.length === 1) return `line ${lines[0]}`;
  if (lines.length <= 5) return `lines ${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`;
  return `lines ${lines.slice(0, 5).join(', ')} and ${lines.length - 5} more`;
}

export function openImportDialog(account) {
  const s = {
    step: 1,
    fileName: '',
    rows: [],
    lines: [],
    skipped: 0,
    hasHeaders: true,
    mapping: {},
    amountMode: 'single',
    flipSigns: false,
    dateFormat: 'DD/MM/YYYY',
    parsed: [],
    preview: null,
    categoryMap: {},
    skipDuplicates: true,
    remember: true
  };

  const dialog = openDialog({ title: `Import into ${account.name}`, size: 'xl', body: '', footer: html`<span></span>`, initialFocus: '[data-file]' });
  const body = dialog.body;
  const footer = dialog.footer;

  const dataRows = () => (s.hasHeaders ? s.rows.slice(1) : s.rows);
  const dataLines = () => (s.hasHeaders ? s.lines.slice(1) : s.lines);
  const columnCount = () => Math.max(0, ...s.rows.slice(0, 20).map(r => r.length));
  const columnNames = () => Array.from({ length: columnCount() }, (_, i) => `Column ${i + 1}`);
  const headerNames = () => (s.hasHeaders ? s.rows[0] || [] : columnNames());

  function detectDates() {
    const dateCol = s.mapping.date;
    if (dateCol >= 0) s.dateFormat = detectDateFormat(dataRows().map(r => r[dateCol]));
  }

  // Reuse last time's choices for this account, but only when they fit this file: a profile from
  // a file with column names never decides whether this one has them, and the other way round.
  function applyProfile() {
    const profile = account.importProfile;
    if (!profile || !profile.columns) return false;
    const hasHeaders = profile.hasHeaders !== false;
    if (!hasHeaders && s.hasHeaders) return false;
    const names = hasHeaders ? s.rows[0] || [] : columnNames();
    const resolved = {};
    let matched = 0;
    for (const f of FIELDS) {
      const name = profile.columns[f.key];
      const i = name ? names.indexOf(name) : -1;
      resolved[f.key] = i;
      if (i >= 0) matched++;
    }
    if (matched < 2) return false;
    s.hasHeaders = hasHeaders;
    s.mapping = resolved;
    s.amountMode = profile.amountMode === 'split' ? 'split' : 'single';
    s.flipSigns = !!profile.flipSigns;
    s.dateFormat = DATE_FORMATS.some(f => f.id === profile.dateFormat) ? profile.dateFormat : s.dateFormat;
    if (profile.categoryMap && typeof profile.categoryMap === 'object') {
      s.categoryMap = Object.fromEntries(Object.entries(profile.categoryMap).filter(([, id]) => typeof id === 'string'));
    }
    return true;
  }

  function autodetect() {
    const guess = guessColumns(s.hasHeaders ? headerNames() : null, dataRows());
    s.mapping = guess.mapping;
    s.amountMode = guess.amountMode;
    detectDates();
  }

  function reparse() {
    s.parsed = buildTransactions(dataRows(), {
      mapping: s.mapping, amountMode: s.amountMode, flipSigns: s.flipSigns, dateFormat: s.dateFormat, lines: dataLines()
    });
  }

  async function loadFile(file) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { dialog.setError('That file is over 20 MB. Split it into smaller files.'); return; }
    dialog.setError(null);
    try {
      const { rows, lines } = parseCSVLines(decodeText(await file.arrayBuffer()));
      if (!rows.length) throw new Error('That file looks empty');
      // Skip any account details above the table itself
      const table = findTable(rows);
      s.fileName = file.name;
      s.rows = rows.slice(table.start);
      s.lines = lines.slice(table.start);
      s.skipped = table.start;
      s.hasHeaders = table.hasHeaders;
      s.categoryMap = {};
      if (!applyProfile()) autodetect();
      reparse();
      s.step = 2;
      draw();
    } catch (err) {
      dialog.setError(err.message || "That file couldn't be read as CSV");
    }
  }

  function steps() {
    const label = (n, text) => html`<span data-step="${n}" class="${s.step === n ? 'current' : s.step > n ? 'done' : ''}" aria-current="${s.step === n ? 'step' : 'false'}">${text}</span>`;
    return html`<div class="steps">${label(1, 'Choose file')}${label(2, 'Match columns')}${label(3, 'Review')}</div>`;
  }

  function drawStep1() {
    render(body, html`
      ${steps()}
      <label class="drop-zone" data-drop>
        ${icon('upload')}
        <strong>Choose a CSV file, or drop one here</strong>
        <span>Export a statement from your bank's website or app as CSV.</span>
        <input type="file" accept=".csv,text/csv,.txt" class="sr-only" data-file>
      </label>
      ${account.importProfile ? html`
        <p class="field-help import-profile-note">${icon('check', { size: 14 })}<span>Your column choices from last time will be reused.</span>
          <button type="button" class="btn btn-ghost btn-sm" data-forget-profile>Forget them</button></p>` : ''}
    `);
    render(footer, html`<span class="spacer"></span><button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button>`);
    const drop = $('[data-drop]', body);
    $('[data-file]', body).addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = ''; // so choosing the same file again after Back still loads it
      loadFile(file);
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); loadFile(e.dataTransfer.files[0]); });
  }

  function previewTable() {
    // The first rows, plus the first few problem rows so the reason is on screen
    const problems = s.parsed.filter(r => r.error);
    const shown = new Set([...s.parsed.slice(0, 8), ...problems.slice(0, 3)]);
    const sample = s.parsed.filter(r => shown.has(r));
    const valid = s.parsed.length - problems.length;
    return html`
      <div class="table-wrap" style="max-height:260px">
        <table class="table">
          <thead><tr><th>Date</th><th>Payee</th><th class="num">Amount</th><th>Category</th><th><span class="sr-only">Problem</span></th></tr></thead>
          <tbody>
            ${sample.map(r => html`
              <tr class="${r.error ? 'error' : ''}">
                <td>${r.date ? formatDate(r.date) : '—'}</td>
                <td>${r.payee}</td>
                <td class="num ${r.amount > 0 ? 'positive' : r.amount < 0 ? 'negative' : ''}">${Number.isFinite(r.amount) ? money(r.amount) : '—'}</td>
                <td>${r.category || html`<span class="faint">—</span>`}</td>
                <td>${r.error ? `${r.error}${r.line ? ` (line ${r.line})` : ''}` : ''}</td>
              </tr>`)}
          </tbody>
        </table>
      </div>
      <p class="field-help" style="margin-top:var(--space-2)">${plural(valid, 'row')} ready to import${problems.length ? html`, <span class="negative">${plural(problems.length, 'row')} with problems will be skipped (${lineList(problems)} of the file)</span>` : ''}.</p>
      ${valid > MAX_ROWS ? html`<p class="field-help negative">That's more than the ${MAX_ROWS.toLocaleString('en-GB')} rows one import can take. Split the file and import it in parts.</p>` : ''}
    `;
  }

  // Card statements often list spending as positive numbers
  function flipHint() {
    if (account.type !== 'credit' || s.flipSigns) return '';
    const valid = s.parsed.filter(r => !r.error);
    if (valid.length < 3 || valid.filter(r => r.amount > 0).length / valid.length < 0.6) return '';
    return html`<p class="alert info" style="margin:0">${icon('info')}<span>Most amounts here are positive. If they're purchases, turn on <strong>Flip money in and out</strong> so they count as spending.</span></p>`;
  }

  function drawStep2() {
    const names = headerNames();
    const options = (selected) => html`<option value="-1">Not in this file</option>${names.map((n, i) => html`<option value="${i}" ${i === selected ? 'selected' : ''}>${n || `Column ${i + 1}`}</option>`)}`;
    const sampleRow = dataRows()[0] || [];
    const fileNote = s.skipped ? `${s.fileName} · skipped ${plural(s.skipped, 'line')} of account details at the top` : s.fileName;
    render(body, html`
      ${steps()}
      <div class="form-stack">
        <div class="field-row">
          <label class="switch"><input type="checkbox" data-headers ${s.hasHeaders ? 'checked' : ''}><span class="switch-track"></span><span class="switch-text">First row is column names<small>${fileNote}</small></span></label>
          <label class="switch"><input type="checkbox" data-flip ${s.flipSigns ? 'checked' : ''}><span class="switch-track"></span><span class="switch-text">Flip money in and out<small>For files that show spending as positive numbers</small></span></label>
        </div>
        ${flipHint()}
        <div class="field">
          <span class="field-label" id="amount-mode-label">Amounts are in</span>
          <div class="segmented" role="radiogroup" aria-labelledby="amount-mode-label">
            <label><input type="radio" name="amountMode" value="single" ${s.amountMode === 'single' ? 'checked' : ''}>One column (+/−)</label>
            <label><input type="radio" name="amountMode" value="split" ${s.amountMode === 'split' ? 'checked' : ''}>Separate in and out columns</label>
          </div>
        </div>
        <div class="mapping-grid">
          ${FIELDS.filter(f => !f.mode || f.mode === s.amountMode).map(f => html`
            <label for="map-${f.key}" class="field-label">${f.label}${f.required ? ' *' : ''}</label>
            <select class="select select-sm" id="map-${f.key}" data-map="${f.key}">${options(s.mapping[f.key] ?? -1)}</select>
            <span class="sample">${s.mapping[f.key] >= 0 && sampleRow[s.mapping[f.key]] ? `e.g. "${sampleRow[s.mapping[f.key]]}"` : ''}</span>
          `)}
          <label for="date-format" class="field-label">Date format</label>
          <select class="select select-sm" id="date-format" data-date-format>${DATE_FORMATS.map(f => html`<option value="${f.id}" ${f.id === s.dateFormat ? 'selected' : ''}>${f.label}</option>`)}</select>
          <span></span>
        </div>
        <div><h3 class="field-label" style="margin-bottom:var(--space-2)">Preview</h3>${previewTable()}</div>
      </div>
    `);
    const valid = s.parsed.filter(r => !r.error).length;
    const ready = valid > 0 && valid <= MAX_ROWS;
    render(footer, html`
      <button type="button" class="btn btn-ghost" data-back>${icon('chevronLeft')}Back</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" data-next ${ready ? '' : 'disabled'}>Review ${icon('chevronRight')}</button>
    `);
  }

  // Categories named in the file that need a decision: those the server couldn't match, plus any
  // matched only because of a choice remembered from last time (so it can still be changed)
  function fileCategories(p) {
    const names = new Set(p.unmatchedCategories.map(c => c.name));
    for (const r of p.rows) if (r.category && Object.hasOwn(s.categoryMap, r.category)) names.add(r.category);
    const counts = new Map();
    for (const r of p.rows) if (names.has(r.category)) counts.set(r.category, (counts.get(r.category) || 0) + 1);
    return [...names].map(name => ({ name, count: counts.get(name) || 0 }));
  }

  function drawStep3() {
    const p = s.preview;
    const importable = p.rows.filter(r => !(r.duplicate && s.skipDuplicates));
    const choices = fileCategories(p);
    render(body, html`
      ${steps()}
      <div class="form-stack">
        <div class="stat-grid">
          <div class="stat-card"><span class="stat-label">To import</span><span class="stat-value">${importable.length.toLocaleString('en-GB')}</span></div>
          <div class="stat-card"><span class="stat-label">Already in ${account.name}</span><span class="stat-value ${p.duplicates ? 'warning-text' : ''}">${p.duplicates.toLocaleString('en-GB')}</span></div>
          <div class="stat-card"><span class="stat-label">Net amount</span><span class="stat-value">${money(importable.reduce((sum, r) => sum + r.amount, 0))}</span></div>
        </div>
        ${p.duplicates ? html`
          <label class="switch"><input type="checkbox" data-skip ${s.skipDuplicates ? 'checked' : ''}><span class="switch-track"></span>
            <span class="switch-text">Skip ${plural(p.duplicates, 'transaction')} that look already imported<small>Same date, amount and payee as one already in this account</small></span></label>` : ''}
        ${choices.length ? html`
          <div class="field">
            <span class="field-label">Categories in the file that don't match yours</span>
            <span class="field-help">Choose where each should go. Anything left as Uncategorized can be sorted later.</span>
            <div class="mapping-grid category-map">
              ${choices.map(c => html`
                <span class="truncate">${c.name} <span class="faint">(${c.count})</span></span>
                <select class="select select-sm" data-category-map="${c.name}" aria-label="Category for ${c.name}">${categoryOptions(state.categories, s.categoryMap[c.name] || UNCATEGORIZED)}</select>
              `)}
            </div>
          </div>` : ''}
        <label class="switch"><input type="checkbox" data-remember ${s.remember ? 'checked' : ''}><span class="switch-track"></span>
          <span class="switch-text">Remember these choices for ${account.name}</span></label>
        <div class="table-wrap" style="max-height:240px">
          <table class="table">
            <thead><tr><th>Date</th><th>Payee</th><th>Category</th><th class="num">Amount</th></tr></thead>
            <tbody>${p.rows.slice(0, 200).map(r => html`
              <tr class="${r.duplicate && s.skipDuplicates ? 'dim' : ''}">
                <td>${formatDate(r.date)}</td><td>${r.payee}${r.duplicate ? html` <span class="pill warning" style="padding:0 .4rem">already there</span>` : ''}</td>
                <td data-file-category="${r.category || ''}">${r.categoryName}</td><td class="num ${r.amount < 0 ? 'negative' : 'positive'}">${money(r.amount)}</td>
              </tr>`)}</tbody>
          </table>
        </div>
      </div>
    `);
    render(footer, html`
      <button type="button" class="btn btn-ghost" data-back>${icon('chevronLeft')}Back</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" data-import ${importable.length ? '' : 'disabled'}>Import ${plural(importable.length, 'transaction')}</button>
    `);
  }

  let drawnStep = 0;
  function draw() {
    dialog.setError(null);
    if (s.step === 1) drawStep1();
    if (s.step === 2) drawStep2();
    if (s.step === 3) drawStep3();
    // A new step starts at the top, not wherever the last one was scrolled to
    if (s.step !== drawnStep) body.scrollTop = 0;
    drawnStep = s.step;
  }

  const validRows = () => s.parsed.filter(r => !r.error)
    .map(({ date, amount, payee, category: name, description, notes, line }) => ({ date, amount, payee, category: name, description, notes, line }));

  function profile() {
    const names = headerNames();
    const columns = {};
    for (const f of FIELDS) {
      const i = s.mapping[f.key];
      if (i >= 0 && names[i]) columns[f.key] = names[i];
    }
    const categoryMap = Object.fromEntries(Object.entries(s.categoryMap).filter(([, id]) => id && id !== UNCATEGORIZED));
    const out = { hasHeaders: s.hasHeaders, columns, amountMode: s.amountMode, flipSigns: s.flipSigns, dateFormat: s.dateFormat, categoryMap };
    if (JSON.stringify(out).length > MAX_PROFILE) delete out.categoryMap;
    return out;
  }

  on(body, 'click', '[data-forget-profile]', async (e, button) => {
    await busy(button, async () => {
      try {
        await api.updateAccount(account.id, { importProfile: null });
        account.importProfile = null;
        await changed();
        draw();
        toast(`Forgot the import choices for ${account.name}`);
      } catch (err) {
        toastError(err);
      }
    });
  });
  on(body, 'change', '[data-headers]', (e) => { s.hasHeaders = e.target.checked; autodetect(); reparse(); draw(); });
  on(body, 'change', '[data-flip]', (e) => { s.flipSigns = e.target.checked; reparse(); draw(); });
  on(body, 'change', '[name="amountMode"]', (e) => {
    s.amountMode = e.target.value;
    if (s.amountMode === 'split' && (s.mapping.paidIn ?? -1) < 0) s.mapping.paidIn = s.mapping.amount;
    reparse();
    draw();
  });
  on(body, 'change', '[data-map]', (e) => {
    const key = e.target.dataset.map;
    s.mapping[key] = Number(e.target.value);
    // A different date column may be written differently
    if (key === 'date') detectDates();
    reparse();
    draw();
    $(`[data-map="${key}"]`, body)?.focus();
  });
  on(body, 'change', '[data-date-format]', (e) => { s.dateFormat = e.target.value; reparse(); draw(); $('[data-date-format]', body)?.focus(); });
  on(body, 'change', '[data-skip]', (e) => { s.skipDuplicates = e.target.checked; draw(); $('[data-skip]', body)?.focus(); });
  on(body, 'change', '[data-remember]', (e) => { s.remember = e.target.checked; });
  on(body, 'change', '[data-category-map]', (e) => {
    const name = e.target.dataset.categoryMap;
    s.categoryMap[name] = e.target.value;
    // Show the choice in the table straight away
    const label = category(e.target.value).name;
    for (const cell of $$('[data-file-category]', body)) if (cell.dataset.fileCategory === name) cell.textContent = label;
  });

  on(footer, 'click', '[data-back]', () => { s.step = Math.max(1, s.step - 1); draw(); });
  on(footer, 'click', '[data-next]', async (e, button) => {
    await busy(button, async () => {
      try {
        s.preview = await api.importPreview(account.id, { rows: validRows(), categoryMap: s.categoryMap });
        s.step = 3;
        draw();
      } catch (err) {
        dialog.setError(err.message);
      }
    });
  });
  on(footer, 'click', '[data-import]', async (e, button) => {
    await busy(button, async () => {
      try {
        const result = await api.importRows(account.id, {
          rows: validRows(),
          skipDuplicates: s.skipDuplicates,
          categoryMap: s.categoryMap,
          profile: s.remember ? profile() : undefined
        });
        dialog.close(true);
        await changed();
        toast(`Imported ${plural(result.imported, 'transaction')}${result.skipped ? `, skipped ${result.skipped} already there` : ''}`, {
          kind: 'success',
          action: result.imported ? {
            label: 'Undo',
            run: async () => {
              await api.bulk(account.id, { action: 'delete', importBatch: result.batch });
              await changed();
              toast('Import undone');
            }
          } : null
        });
      } catch (err) {
        if (err.status) dialog.setError(err.message);
        else toastError(err);
      }
    });
  });

  draw();
  return dialog.closed;
}

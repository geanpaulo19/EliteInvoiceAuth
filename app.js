/* ═══════════════════════════════════════════════════════════
   EliteInvoice — Application Logic
   Storage : Cloudflare KV (via Worker) + localStorage (logo only)
   AI      : Groq via Cloudflare Worker proxy
   Model   : llama-3.1-8b-instant
   FX      : Frankfurter API (primary) → open.er-api.com (fallback)
═══════════════════════════════════════════════════════════ */

const DEFAULT_TAX_RATE = 10;
const DEFAULT_BASE_CCY = 'USD';

const KV_SETTINGS  = 'eliteinvoice_settings';
const KV_INVOICES  = 'eliteinvoice_invoices';
const KV_COUNTER   = 'eliteinvoice_counter';
const KV_BASE_CCY  = 'eliteinvoice_base_currency';
const WORKER_URL   = 'https://api.geanpaulofrancois.workers.dev/';
let   currentUser  = null;  // set after whoami call

/* ── Cloudflare KV helpers (read/write via Worker) ── */
function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), ms))
  ]);
}

async function kvGet(key) {
  const res  = await withTimeout(fetch(WORKER_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action: 'kv:get', key })
  }));
  const data = await res.json();
  return data.value ?? null;
}

async function kvSet(key, value) {
  await withTimeout(fetch(WORKER_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action: 'kv:set', key, value })
  }));
}

async function kvDelete(key) {
  await withTimeout(fetch(WORKER_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action: 'kv:delete', key })
  }));
}
const LS_LOGO_KEY  = 'eliteinvoice_logo_b64';   // base64 data-URL stored in localStorage
const GROQ_MODEL   = 'llama-3.1-8b-instant';

const CCY_META = {
  '$':  { code: 'USD', symbol: '$'  },
  '€':  { code: 'EUR', symbol: '€'  },
  '£':  { code: 'GBP', symbol: '£'  },
  '₱':  { code: 'PHP', symbol: '₱'  },
  '¥':  { code: 'JPY', symbol: '¥'  },
  'A$': { code: 'AUD', symbol: 'A$' },
  'C$': { code: 'CAD', symbol: 'C$' },
};

const CODE_TO_SYM = Object.fromEntries(
  Object.entries(CCY_META).map(([sym, { code }]) => [code, sym])
);

const App = (() => {

  let currentCurrency  = '$';
  let baseCurrency     = DEFAULT_BASE_CCY;
  let fxRates          = {};
  let fxRatesOk        = false;

  /*
   * _editingIndex — tracks which invoice is currently loaded
   * for editing.  null  = composing a brand-new invoice.
   * number = index into the saved invoices array; the Update
   * button is shown and Save Invoice is hidden in this state.
   */
  let _editingIndex = null;

  let settings = {
    bizName: '', bizAddress: '',
    phone: '', email: '',
    linkedin: '', instagram: '', twitter: '', github: '',
    logoUrl: ''
  };

  let _currentDraft = { subject: '', body: '', clientEmail: '' };

  /* ══════════ INIT ══════════ */
  async function init() {
    // Set up dates and defaults immediately — never blocked by network
    const today = new Date();
    document.getElementById('invoiceDate').value  = fmtDate(today);
    const due = new Date(today); due.setDate(due.getDate() + 30);
    document.getElementById('invoiceDue').value   = fmtDate(due);
    document.getElementById('taxRateInput').value = DEFAULT_TAX_RATE;
    addRow();

    updateStatus('loading', 'Signing in…');

    // Identify current user via Worker
    try {
      const res  = await withTimeout(fetch(WORKER_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'whoami' })
      }));
      const data = await res.json();
      if (data.email) {
        currentUser = data.email;
        const userEl = document.getElementById('sidebarUserEmail');
        if (userEl) userEl.textContent = data.email;
      } else {
        updateStatus('offline', 'Not signed in');
        return;
      }
    } catch (e) {
      console.warn('whoami failed:', e);
      updateStatus('offline', 'Could not reach Worker');
      return;
    }

    updateStatus('loading', 'Connecting…');

    // Each KV call is individually wrapped — one failure won't freeze the app
    await loadBaseCurrency().catch(e => console.warn('loadBaseCurrency failed:', e));
    await loadSettings().catch(e => console.warn('loadSettings failed:', e));
    await resolveInvoiceNumber().catch(e => {
      console.warn('resolveInvoiceNumber failed:', e);
      document.getElementById('invoiceNumber').textContent = '#INV-0001';
    });

    fetchFxRates().catch(e => console.warn('FX fetch failed on init:', e));

    updateStatus('online', 'Ready');
  }

  /* ══════════ EDIT-MODE UI HELPERS ══════════ */

  /**
   * setEditMode(index)
   * Switches the invoice toolbar into "editing an existing invoice" mode.
   * Hides "Save Invoice", shows "Update Invoice" + a "Cancel Edit" button.
   * Passing null resets back to new-invoice mode.
   */
  function setEditMode(index) {
    _editingIndex = index;
    const isEditing = index !== null;

    document.getElementById('btnSaveInvoice').style.display   = isEditing ? 'none'  : '';
    document.getElementById('btnUpdateInvoice').style.display = isEditing ? ''      : 'none';
    document.getElementById('btnCancelEdit').style.display    = isEditing ? ''      : 'none';

    // Visual cue on the invoice document itself
    const doc = document.getElementById('invoiceDocument');
    if (isEditing) {
      doc.classList.add('is-editing');
    } else {
      doc.classList.remove('is-editing');
    }
  }

  /* ══════════ BASE CURRENCY ══════════ */
  async function loadBaseCurrency() {
    try {
      const saved = await kvGet(KV_BASE_CCY);
      if (saved) baseCurrency = saved;
    } catch (_) {}
    const sel = document.getElementById('baseCurrencySelect');
    if (sel) sel.value = baseCurrency;
  }

  async function saveBaseCurrency(code) {
    baseCurrency = code;
    try { await kvSet(KV_BASE_CCY, code); }
    catch (e) { console.warn('Could not persist base currency:', e); }
    await fetchFxRates();
    if (document.getElementById('view-history').classList.contains('active'))
      loadHistory();
    showToast(`Base currency set to ${code}`);
  }

  /* ══════════ LIVE FX RATES ══════════ */
  async function _fetchFrankfurter() {
    const res  = await fetch(`https://api.frankfurter.app/latest?from=${baseCurrency}`);
    if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
    const data = await res.json();
    if (!data.rates || typeof data.rates !== 'object')
      throw new Error('Frankfurter: unexpected shape');
    return { ...data.rates, [baseCurrency]: 1 };
  }

  async function _fetchOpenER() {
    const res  = await fetch(`https://open.er-api.com/v6/latest/${baseCurrency}`);
    if (!res.ok) throw new Error(`OpenER HTTP ${res.status}`);
    const data = await res.json();
    if (data.result !== 'success' || !data.rates)
      throw new Error('OpenER: result not success');
    return { ...data.rates, [baseCurrency]: 1 };
  }

  async function fetchFxRates() {
    fxRatesOk = false;
    try {
      fxRates   = await _fetchFrankfurter();
      fxRatesOk = true;
      console.info('FX: Frankfurter OK');
      return true;
    } catch (e) {
      console.warn('Frankfurter failed, trying fallback…', e.message);
    }
    try {
      fxRates   = await _fetchOpenER();
      fxRatesOk = true;
      console.info('FX: open.er-api fallback OK');
      return true;
    } catch (e) {
      console.warn('Both FX sources failed.', e.message);
    }
    fxRates   = {};
    fxRatesOk = false;
    return false;
  }

  function convertToBase(amount, fromSymbol) {
    const meta = CCY_META[fromSymbol];
    if (!meta) return amount;
    const fromCode = meta.code;
    if (fromCode === baseCurrency) return amount;
    const rate = fxRates[fromCode];
    if (!rate || rate === 0) return amount;
    return amount / rate;
  }

  function fmtBase(amount) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency', currency: baseCurrency,
        minimumFractionDigits: 2, maximumFractionDigits: 2
      }).format(amount);
    } catch (_) {
      return (CODE_TO_SYM[baseCurrency] || baseCurrency) + fmt(amount);
    }
  }

  /* ══════════ NAVIGATION ══════════ */
  function navigate(view) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => {
      n.classList.toggle('active', n.dataset.view === view);
    });
    if (view === 'history') loadHistory();
    closeSidebar();
  }

  /* ══════════ SIDEBAR ══════════ */
  function toggleSidebar() {
    const sidebar   = document.getElementById('sidebar');
    const overlay   = document.getElementById('sidebarOverlay');
    const hamburger = document.getElementById('hamburgerBtn');
    const isOpen    = sidebar.classList.toggle('is-open');
    hamburger.classList.toggle('is-open', isOpen);
    overlay.classList.toggle('visible', isOpen);
    document.body.style.overflow = isOpen ? 'hidden' : '';
  }

  function closeSidebar() {
    document.getElementById('sidebar').classList.remove('is-open');
    document.getElementById('hamburgerBtn').classList.remove('is-open');
    document.getElementById('sidebarOverlay').classList.remove('visible');
    document.body.style.overflow = '';
  }

  /* ══════════ INVOICE NUMBER ══════════ */
  async function resolveInvoiceNumber() {
    try {
      const counter = await kvGet(KV_COUNTER);
      const num = counter ? parseInt(counter) : 0;
      document.getElementById('invoiceNumber').textContent =
        '#INV-' + String(num + 1).padStart(4, '0');
    } catch (e) {
      document.getElementById('invoiceNumber').textContent = '#INV-0001';
    }
  }

  /* ══════════ ROW MANAGEMENT ══════════ */
  function addRow(desc = '', qty = 1, price = '') {
    const tbody = document.getElementById('invoiceBody');
    const tr    = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" placeholder="Item description" value="${escHtml(desc)}" oninput="App.updateTotals()" /></td>
      <td class="td-qty"><input type="number" value="${qty}" min="0" step="any" oninput="App.updateTotals()" /></td>
      <td class="td-price"><input type="number" value="${price}" min="0" step="any" placeholder="0.00" oninput="App.updateTotals()" /></td>
      <td class="td-total">—</td>
      <td class="col-del no-print">
        <button class="del-row-btn" onclick="App.deleteRow(this)" title="Remove row">×</button>
      </td>`;
    tbody.appendChild(tr);
    updateTotals();
  }

  function deleteRow(btn) {
    btn.closest('tr').remove();
    updateTotals();
  }

  /* ══════════ TOTALS ══════════ */
  function updateTotals() {
    const rows = document.querySelectorAll('#invoiceBody tr');
    const sym  = currentCurrency;
    let subtotal = 0;
    rows.forEach(row => {
      const inputs = row.querySelectorAll('input');
      const qty    = parseFloat(inputs[1].value) || 0;
      const price  = parseFloat(inputs[2].value) || 0;
      const line   = qty * price;
      subtotal    += line;
      row.querySelector('.td-total').textContent = line ? sym + fmt(line) : '—';
    });
    const taxPct = parseFloat(document.getElementById('taxRateInput').value) || 0;
    const tax    = subtotal * (taxPct / 100);
    const total  = subtotal + tax;
    document.getElementById('subtotalVal').textContent = sym + fmt(subtotal);
    document.getElementById('taxVal').textContent      = sym + fmt(tax);
    document.getElementById('totalVal').textContent    = sym + fmt(total);
  }

  /* ══════════ CURRENCY ══════════ */
  function setCurrency(sym) {
    currentCurrency = sym;
    updateTotals();
  }

  /* ══════════ NEW INVOICE ══════════ */
  async function newInvoice() {
    setEditMode(null);   // always exit edit mode on New
    document.getElementById('invoiceBody').innerHTML   = '';
    document.getElementById('clientName').value        = '';
    document.getElementById('clientEmail').value       = '';
    document.getElementById('clientAddress').value     = '';
    document.getElementById('invoiceNotes').value      = '';
    document.getElementById('magicInput').value        = '';
    document.getElementById('magicStatus').textContent = '';
    document.getElementById('taxRateInput').value      = DEFAULT_TAX_RATE;
    const today = new Date();
    document.getElementById('invoiceDate').value = fmtDate(today);
    const due = new Date(today); due.setDate(due.getDate() + 30);
    document.getElementById('invoiceDue').value = fmtDate(due);
    await resolveInvoiceNumber();
    addRow();
    showToast('Ready for a new invoice.');
  }

  /* ══════════ CANCEL EDIT ══════════ */
  function cancelEdit() {
    setEditMode(null);
    newInvoice();
    showToast('Edit cancelled — form reset.');
  }

  /* ══════════ AI MAGIC PARSE ══════════ */
  async function runMagicParse() {
    const input = document.getElementById('magicInput').value.trim();
    if (!input) { showToast('Please enter invoice details first.'); return; }

    const workerUrl = WORKER_URL;
    const btn = document.getElementById('magicBtn');
    btn.disabled = true;
    setMagicStatus('loading', 'Parsing with AI…');

    const systemPrompt =
      'You are an invoice data extractor. Extract items as a JSON array of ' +
      '{desc, qty, price}. Also, identify the currency symbol used ' +
      '(e.g., $, €, £, ₱). If no symbol is found, default to \'$\'. ' +
      'Return ONLY valid JSON in this exact shape, no markdown, no extra text: ' +
      '{"currency":"$","items":[{"desc":"...","qty":1,"price":0}]}';

    try {
      const res = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'parse',
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: input }
          ]
        })
      });
      if (!res.ok) throw new Error(`Worker responded HTTP ${res.status}`);
      const data    = await res.json();
      if (data.error) throw new Error(data.error);
      const rawText = data.content || '';

      const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                        rawText.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? jsonMatch[1].trim() : rawText.trim();
      const parsed  = JSON.parse(jsonStr);

      if (parsed.currency) {
        currentCurrency = parsed.currency;
        const sel = document.getElementById('currencySelect');
        for (let opt of sel.options) {
          if (opt.value === parsed.currency) { sel.value = parsed.currency; break; }
        }
      }
      if (Array.isArray(parsed.items) && parsed.items.length > 0) {
        document.getElementById('invoiceBody').innerHTML = '';
        parsed.items.forEach(item => addRow(item.desc, item.qty, item.price));
        setMagicStatus('ok', `✓ ${parsed.items.length} item${parsed.items.length > 1 ? 's' : ''} extracted`);
        showToast('Invoice items populated!');
      } else {
        setMagicStatus('err', 'No items found. Try rephrasing.');
      }
    } catch (err) {
      console.error('AI parse error:', err);
      setMagicStatus('err', '\u2717 ' + (err.message || 'Unknown error — open F12 Console for details.'));
      showToast('AI parsing failed. Please try again.');
    }
    btn.disabled = false;
  }

  function setMagicStatus(type, msg) {
    const el       = document.getElementById('magicStatus');
    el.innerHTML   = type === 'loading' ? `<span class="spinner"></span> ${msg}` : msg;
    el.style.color = type === 'ok'  ? 'var(--success)'
                   : type === 'err' ? 'var(--danger)'
                   : 'var(--text-secondary)';
  }

  /* ══════════ BUILD INVOICE OBJECT FROM FORM ══════════ */
  function _buildInvoiceFromForm(existingSavedAt) {
    const rows  = document.querySelectorAll('#invoiceBody tr');
    const items = [];
    rows.forEach(row => {
      const inputs = row.querySelectorAll('input');
      items.push({
        desc:  inputs[0].value,
        qty:   parseFloat(inputs[1].value) || 0,
        price: parseFloat(inputs[2].value) || 0
      });
    });
    const taxPct   = parseFloat(document.getElementById('taxRateInput').value) || 0;
    const subtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
    const tax      = subtotal * (taxPct / 100);
    const total    = subtotal + tax;
    return {
      id:          document.getElementById('invoiceNumber').textContent,
      date:        document.getElementById('invoiceDate').value,
      due:         document.getElementById('invoiceDue').value,
      clientName:  document.getElementById('clientName').value,
      clientEmail: document.getElementById('clientEmail').value,
      clientAddr:  document.getElementById('clientAddress').value,
      notes:       document.getElementById('invoiceNotes').value,
      currency:    currentCurrency,
      taxPct, items, subtotal, tax, total,
      savedAt:     existingSavedAt || new Date().toISOString(),
      updatedAt:   new Date().toISOString()
    };
  }

  /* ══════════ SAVE INVOICE (new only) ══════════ */
  async function saveInvoice() {
    const invoice = _buildInvoiceFromForm(null);
    try {
      const raw = await kvGet(KV_INVOICES);
      const invoices = raw ? JSON.parse(raw) : [];
      invoices.unshift(invoice);
      await kvSet(KV_INVOICES, JSON.stringify(invoices));
      const rawCounter = await kvGet(KV_COUNTER);
      await kvSet(KV_COUNTER, String(parseInt(rawCounter || '0') + 1));
      showToast('Invoice saved successfully!');
      await resolveInvoiceNumber();
    } catch (e) {
      console.error('Save error:', e);
      showToast('Save failed. Please try again.');
    }
  }

  /* ══════════ UPDATE INVOICE (edit existing) ══════════ */
  async function updateInvoice() {
    if (_editingIndex === null) {
      showToast('No invoice selected for update.');
      return;
    }
    try {
      const raw = await kvGet(KV_INVOICES);
      const invoices = raw ? JSON.parse(raw) : [];

      if (_editingIndex < 0 || _editingIndex >= invoices.length) {
        showToast('Invoice not found — it may have been deleted.');
        setEditMode(null);
        return;
      }

      const originalSavedAt = invoices[_editingIndex].savedAt;
      const updated          = _buildInvoiceFromForm(originalSavedAt);

      invoices[_editingIndex] = updated;
      await kvSet(KV_INVOICES, JSON.stringify(invoices));

      showToast('Invoice updated successfully!');
      setEditMode(null);
      await resolveInvoiceNumber();
    } catch (e) {
      console.error('Update error:', e);
      showToast('Update failed. Please try again.');
    }
  }

  /* ══════════ CLEAR INVOICE ══════════ */
  function clearInvoice() {
    document.getElementById('invoiceBody').innerHTML   = '';
    document.getElementById('clientName').value        = '';
    document.getElementById('clientEmail').value       = '';
    document.getElementById('clientAddress').value     = '';
    document.getElementById('invoiceNotes').value      = '';
    document.getElementById('magicInput').value        = '';
    document.getElementById('magicStatus').textContent = '';
    document.getElementById('taxRateInput').value      = DEFAULT_TAX_RATE;
    addRow();
    showToast('Invoice cleared.');
  }

  /* ══════════ OVERDUE HELPERS ══════════ */
  function daysOverdue(dueDateStr) {
    if (!dueDateStr) return null;
    const due   = new Date(dueDateStr);
    const today = new Date();
    due.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    return Math.floor((today - due) / (1000 * 60 * 60 * 24));
  }

  function getTone(days) {
    if (days === null || days < 0) return { key: 'upcoming', label: 'Gentle Heads-up',  emoji: '📅' };
    if (days <= 7)                 return { key: 'friendly', label: 'Friendly Reminder', emoji: '🔔' };
    if (days <= 13)                return { key: 'gentle',   label: 'Friendly Reminder', emoji: '🔔' };
    return                                { key: 'firm',     label: 'Firm Follow-up',    emoji: '⚠️' };
  }

  /* ══════════ REVENUE DASHBOARD ══════════ */
  async function calculateTotalRevenue(invoices) {
    let grandTotal   = 0;
    let overdueCount = 0;
    const byCurrency = {};
    invoices.forEach(inv => {
      const sym   = inv.currency || '$';
      const total = parseFloat(inv.total) || 0;
      grandTotal += convertToBase(total, sym);
      byCurrency[sym] = (byCurrency[sym] || 0) + total;
      const days = daysOverdue(inv.due);
      if (days !== null && days > 0) overdueCount++;
    });
    const count = invoices.length;
    const avg   = count > 0 ? grandTotal / count : 0;
    return { grandTotal, byCurrency, count, overdueCount, avg };
  }

  function renderRevenueDashboard(stats) {
    const { grandTotal, byCurrency, count, overdueCount, avg } = stats;
    const amountEl = document.getElementById('revenueTotalAmount');
    const labelEl  = document.getElementById('revenueBaseCcyLabel');
    amountEl.classList.add('updating');
    setTimeout(() => {
      if (fxRatesOk) {
        labelEl.textContent = `Converted to ${baseCurrency} · live rates`;
        labelEl.style.color = 'rgba(255,255,255,0.38)';
        labelEl.title       = '';
      } else {
        labelEl.textContent = '⚠️ Live rates unavailable — amounts shown in original currencies';
        labelEl.style.color = '#ffcc00';
        labelEl.title       = 'Both Frankfurter and open.er-api.com could not be reached.';
      }
      if (count === 0) {
        amountEl.textContent = '—';
        document.getElementById('revenueMultiCurrency').innerHTML  = '';
        document.getElementById('revenueInvoiceCount').textContent = '0';
        document.getElementById('revenueAvgValue').textContent     = '—';
        const ov = document.getElementById('revenueOverdueCount');
        ov.textContent = '0';
        ov.className   = 'revenue-stat-value no-overdue';
        amountEl.classList.remove('updating');
        return;
      }
      amountEl.textContent = fmtBase(grandTotal);
      amountEl.classList.remove('updating');
      const chipContainer = document.getElementById('revenueMultiCurrency');
      const currencies    = Object.keys(byCurrency);
      if (currencies.length > 1 ||
          (currencies.length === 1 && CCY_META[currencies[0]]?.code !== baseCurrency)) {
        chipContainer.innerHTML = currencies.map(sym => {
          const converted = convertToBase(byCurrency[sym], sym);
          const isSame    = CCY_META[sym]?.code === baseCurrency;
          return `<span class="rev-currency-chip" title="${escHtml(sym)}${fmt(byCurrency[sym])}">
            ${escHtml(sym)}${fmt(byCurrency[sym])}
            ${!isSame && fxRatesOk
              ? `<span class="chip-converted">≈ ${fmtBase(converted)}</span>`
              : ''}
          </span>`;
        }).join('');
      } else {
        chipContainer.innerHTML = '';
      }
      document.getElementById('revenueInvoiceCount').textContent = count;
      document.getElementById('revenueAvgValue').textContent     = fmtBase(avg);
      const overdueEl       = document.getElementById('revenueOverdueCount');
      overdueEl.textContent = overdueCount;
      overdueEl.className   = overdueCount === 0
        ? 'revenue-stat-value no-overdue'
        : 'revenue-stat-value';
    }, 150);
  }

  /* ══════════ LOAD HISTORY ══════════ */
  async function loadHistory() {
    const container = document.getElementById('historyList');
    container.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
    try {
      const rawInv = await kvGet(KV_INVOICES);
      let invoices = rawInv ? JSON.parse(rawInv) : [];
      if (!fxRatesOk) await fetchFxRates();
      const stats = await calculateTotalRevenue(invoices);
      renderRevenueDashboard(stats);
      if (!invoices.length) {
        container.innerHTML = `<div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg><p>No saved invoices yet.</p></div>`;
        return;
      }
      container.innerHTML = invoices.map((inv, idx) => {
        const days  = daysOverdue(inv.due);
        const tone  = getTone(days);
        const overdueLabel =
          days === null ? 'No due date' :
          days < 0      ? `Due in ${Math.abs(days)} day${Math.abs(days) !== 1 ? 's' : ''}` :
          days === 0    ? 'Due today' :
                          `${days} day${days !== 1 ? 's' : ''} overdue`;
        const invCode       = CCY_META[inv.currency]?.code;
        const showConverted = invCode && invCode !== baseCurrency && fxRatesOk;
        const convertedStr  = showConverted
          ? `<span class="hc-converted">≈ ${fmtBase(convertToBase(inv.total, inv.currency))}</span>`
          : '';
        // Show "Updated" timestamp if the invoice has been edited
        const timestampStr = inv.updatedAt
          ? `Updated ${new Date(inv.updatedAt).toLocaleDateString()}`
          : `Saved ${new Date(inv.savedAt).toLocaleDateString()}`;
        return `
          <div class="history-card">
            <div class="history-card-info">
              <div class="hc-number">${escHtml(inv.id)}</div>
              <div class="hc-client">${escHtml(inv.clientName || 'Unknown Client')}</div>
              <div class="hc-date">${timestampStr}</div>
              <div class="hc-overdue-badge ${tone.key}">${tone.emoji} ${overdueLabel}</div>
            </div>
            <div class="history-card-amount-group">
              <div class="history-card-amount">${escHtml(inv.currency)}${fmt(inv.total)}</div>
              ${convertedStr}
            </div>
            <div class="history-card-actions">
              <button class="btn-draft-email" onclick="App.openEmailModal(${idx})" title="Draft follow-up email">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="13" height="13">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                  <polyline points="22,6 12,13 2,6"/>
                </svg>
                Draft Email
              </button>
              <button class="btn-load" onclick="App.loadInvoiceToEditor(${idx})">Edit</button>
              <button class="btn-del-invoice" onclick="App.deleteInvoice(${idx})">Delete</button>
            </div>
          </div>`;
      }).join('');
    } catch (e) {
      console.error('loadHistory error:', e);
      container.innerHTML = '<div class="empty-state"><p>Failed to load invoices.</p></div>';
    }
  }

  /* ══════════ AI FOLLOW-UP EMAIL MODAL ══════════ */
  async function openEmailModal(idx) {
    let invoices = [];
    try {
      const rawEM = await kvGet(KV_INVOICES);
      invoices = rawEM ? JSON.parse(rawEM) : [];
    } catch (e) { showToast('Could not load invoice data.'); return; }
    const inv = invoices[idx];
    if (!inv) { showToast('Invoice not found.'); return; }

    const workerUrl = WORKER_URL;

    const modal = document.getElementById('emailModal');
    modal.classList.add('visible');
    document.body.style.overflow = 'hidden';
    document.getElementById('modalInvoiceRef').textContent = inv.id;
    document.getElementById('modalLoading').style.display  = 'flex';
    document.getElementById('modalResult').style.display   = 'none';
    document.getElementById('modalError').style.display    = 'none';

    const days = daysOverdue(inv.due);
    const tone = getTone(days);
    const dueDateFormatted = inv.due
      ? new Date(inv.due).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'No due date specified';
    const amountFormatted = `${inv.currency}${fmt(inv.total)}`;
    const overdueContext  =
      days === null ? 'The invoice has no due date.' :
      days < 0      ? `Not yet due — due in ${Math.abs(days)} day(s) on ${dueDateFormatted}.` :
      days === 0    ? `Due TODAY (${dueDateFormatted}).` :
                      `${days} day(s) overdue. Was due on ${dueDateFormatted}.`;
    const systemPrompt =
      'You are a professional business assistant. Based on the provided invoice data, ' +
      'write a polite but clear follow-up email.\n' +
      '- If it\'s not due yet, write a "Gentle Heads-up".\n' +
      '- If it\'s 1–7 days late, write a "Friendly Reminder".\n' +
      '- If it\'s 8–13 days late, write a "Friendly Reminder" with slightly more urgency.\n' +
      '- If it\'s 14+ days late, write a "Firm Follow-up".\n' +
      'Include the invoice number and a "Pay Now" link placeholder: [PAY NOW LINK].\n' +
      'Output ONLY the email in this exact format (no extra text, no markdown):\n' +
      'SUBJECT: <subject line here>\n\n<email body here>';
    const userMessage =
      `Client Name: ${inv.clientName || 'Valued Client'}\n` +
      `Client Email: ${inv.clientEmail || 'N/A'}\n` +
      `Invoice Number: ${inv.id}\n` +
      `Invoice Amount: ${amountFormatted}\n` +
      `Due Date: ${dueDateFormatted}\n` +
      `Status: ${overdueContext}\n` +
      `Tone required: ${tone.label}`;
    try {
      const res = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'email',
          model: GROQ_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userMessage }
          ]
        })
      });
      if (!res.ok) throw new Error(`Worker responded HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const rawText      = data.content || '';
      const subjectMatch = rawText.match(/^SUBJECT:\s*(.+)/im);
      const subject      = subjectMatch ? subjectMatch[1].trim() : `Follow-up: Invoice ${inv.id}`;
      const body         = rawText.replace(/^SUBJECT:\s*.+\n?/im, '').trim();
      _currentDraft = { subject, body, clientEmail: inv.clientEmail || '' };
      document.getElementById('modalLoading').style.display = 'none';
      document.getElementById('modalResult').style.display  = 'block';
      const badge       = document.getElementById('modalToneBadge');
      badge.textContent = `${tone.emoji}  ${tone.label}`;
      badge.className   = `modal-tone-badge ${tone.key}`;
      document.getElementById('modalSubject').value = subject;
      document.getElementById('modalBody').value    = body;
    } catch (err) {
      console.error('Email draft error:', err);
      document.getElementById('modalLoading').style.display = 'none';
      document.getElementById('modalError').style.display   = 'flex';
      document.getElementById('modalErrorMsg').textContent  =
        `AI drafting failed: ${err.message}`;
    }
  }

  function closeEmailModal(event) {
    if (event && event.target !== document.getElementById('emailModal')) return;
    _closeModal();
  }
  function _closeModal() {
    document.getElementById('emailModal').classList.remove('visible');
    document.body.style.overflow = '';
    setTimeout(() => {
      document.getElementById('modalLoading').style.display = 'flex';
      document.getElementById('modalResult').style.display  = 'none';
      document.getElementById('modalError').style.display   = 'none';
    }, 200);
  }

  async function copyEmailDraft() {
    const full = `Subject: ${document.getElementById('modalSubject').value}\n\n${document.getElementById('modalBody').value}`;
    try {
      await navigator.clipboard.writeText(full);
      showToast('Email draft copied to clipboard!');
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = full; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      showToast('Email draft copied!');
    }
  }

  function openInMailClient() {
    const s = encodeURIComponent(_currentDraft.subject);
    const b = encodeURIComponent(_currentDraft.body);
    const t = encodeURIComponent(_currentDraft.clientEmail);
    window.location.href = `mailto:${t}?subject=${s}&body=${b}`;
  }

  /* ══════════ LOAD INVOICE INTO EDITOR ══════════ */
  async function loadInvoiceToEditor(idx) {
    try {
      const rawInv = await kvGet(KV_INVOICES);
      let invoices = rawInv ? JSON.parse(rawInv) : [];
      const inv = invoices[idx];
      if (!inv) return;
      currentCurrency = inv.currency || '$';
      const sel = document.getElementById('currencySelect');
      for (let opt of sel.options) {
        if (opt.value === currentCurrency) { sel.value = currentCurrency; break; }
      }
      document.getElementById('invoiceNumber').textContent = inv.id;
      document.getElementById('invoiceDate').value         = inv.date;
      document.getElementById('invoiceDue').value          = inv.due;
      document.getElementById('clientName').value          = inv.clientName;
      document.getElementById('clientEmail').value         = inv.clientEmail;
      document.getElementById('clientAddress').value       = inv.clientAddr;
      document.getElementById('invoiceNotes').value        = inv.notes;
      document.getElementById('taxRateInput').value        = inv.taxPct;
      document.getElementById('invoiceBody').innerHTML     = '';
      inv.items.forEach(item => addRow(item.desc, item.qty, item.price));

      // Enter edit mode — toolbar swaps to Update + Cancel Edit
      setEditMode(idx);

      navigate('invoice');
      showToast(`Editing ${inv.id} — make changes and click Update Invoice.`);
    } catch (e) { showToast('Failed to load invoice.'); }
  }

  /* ══════════ DELETE INVOICE ══════════ */
  async function deleteInvoice(idx) {
    try {
      const rawInv = await kvGet(KV_INVOICES);
      let invoices = rawInv ? JSON.parse(rawInv) : [];
      invoices.splice(idx, 1);
      await kvSet(KV_INVOICES, JSON.stringify(invoices));
      showToast('Invoice deleted.');
      loadHistory();
    } catch (e) { showToast('Delete failed.'); }
  }

  /* ══════════ SETTINGS: LOAD ══════════ */
  async function loadSettings() {
    try {
      const saved = await kvGet(KV_SETTINGS);
      if (saved) {
        settings = JSON.parse(saved);
        document.getElementById('settingBizName').value    = settings.bizName    || '';
        document.getElementById('settingBizAddress').value = settings.bizAddress || '';
        document.getElementById('settingPhone').value      = settings.phone      || '';
        document.getElementById('settingEmail').value      = settings.email      || '';
        document.getElementById('settingLinkedin').value   = settings.linkedin   || '';
        document.getElementById('settingInstagram').value  = settings.instagram  || '';
        document.getElementById('settingTwitter').value    = settings.twitter    || '';
        document.getElementById('settingGithub').value     = settings.github     || '';
        applySettingsToInvoice();
      }
    } catch (_) {}
    const sel = document.getElementById('baseCurrencySelect');
    if (sel) sel.value = baseCurrency;
    // Restore logo from localStorage
    const logoB64 = localStorage.getItem(LS_LOGO_KEY);
    if (logoB64) {
      settings.logoUrl = logoB64;
      const preview         = document.getElementById('settingsLogoPreview');
      preview.src           = logoB64;
      preview.style.display = 'block';
      document.getElementById('logoPlaceholder').style.display = 'none';
      applySettingsToInvoice();
    }
  }

  /* ══════════ SETTINGS: SAVE ══════════ */
  async function saveSettings() {
    const statusEl      = document.getElementById('settingsSaveStatus');
    settings.bizName    = document.getElementById('settingBizName').value.trim();
    settings.bizAddress = document.getElementById('settingBizAddress').value.trim();
    settings.phone      = document.getElementById('settingPhone').value.trim();
    settings.email      = document.getElementById('settingEmail').value.trim();
    settings.linkedin   = document.getElementById('settingLinkedin').value.trim();
    settings.instagram  = document.getElementById('settingInstagram').value.trim();
    settings.twitter    = document.getElementById('settingTwitter').value.trim();
    settings.github     = document.getElementById('settingGithub').value.trim();

    try {
      await kvSet(KV_SETTINGS, JSON.stringify(settings));
      applySettingsToInvoice();
      statusEl.textContent = '✓ Settings saved';
      statusEl.className   = 'save-status ok';
      showToast('Settings saved!');
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'save-status'; }, 3000);
      updateStatus('online', 'Ready');
    } catch (e) {
      statusEl.textContent = '✗ Failed to save';
      statusEl.className   = 'save-status err';
    }
  }

  /* ══════════ APPLY SETTINGS → INVOICE ══════════ */
  function applySettingsToInvoice() {
    document.getElementById('invoiceBizName').textContent    = settings.bizName    || 'Your Business Name';
    document.getElementById('invoiceBizAddress').textContent = settings.bizAddress || '123 Main Street, City, Country';
    const contactEl = document.getElementById('invoiceBizContact');
    const parts     = [];
    if (settings.phone) parts.push(escHtml(settings.phone));
    if (settings.email) parts.push(
      `<a href="mailto:${escHtml(settings.email)}">${escHtml(settings.email)}</a>`
    );
    [
      { key: 'linkedin',  label: 'LinkedIn'  },
      { key: 'instagram', label: 'Instagram' },
      { key: 'twitter',   label: 'X'         },
      { key: 'github',    label: 'GitHub'    }
    ].forEach(({ key, label }) => {
      if (settings[key]) parts.push(
        `<a href="${escHtml(settings[key])}" target="_blank" rel="noopener">${label}</a>`
      );
    });
    contactEl.innerHTML = parts.join(' &nbsp;·&nbsp; ');
    if (settings.logoUrl) {
      const logo         = document.getElementById('invoiceLogo');
      logo.src           = settings.logoUrl;
      logo.style.display = 'block';
    }
  }

  /* ══════════ LOGO UPLOAD ══════════ */
  function uploadLogo(input) {
    const file     = input.files[0];
    const statusEl = document.getElementById('logoUploadStatus');
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      statusEl.textContent = '✗ File too large (max 2MB)';
      statusEl.className   = 'upload-status err'; return;
    }
    statusEl.innerHTML = '<span class="spinner"></span> Processing…';
    statusEl.className = 'upload-status';
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl    = e.target.result;
      settings.logoUrl = dataUrl;
      localStorage.setItem(LS_LOGO_KEY, dataUrl);
      kvSet(KV_SETTINGS, JSON.stringify(settings))
        .then(() => {
          const preview         = document.getElementById('settingsLogoPreview');
          preview.src           = dataUrl;
          preview.style.display = 'block';
          document.getElementById('logoPlaceholder').style.display = 'none';
          applySettingsToInvoice();
          statusEl.textContent = '✓ Logo saved';
          statusEl.className   = 'upload-status ok';
          showToast('Logo uploaded!');
        })
        .catch(() => {
          statusEl.textContent = '✗ Save failed — try again';
          statusEl.className   = 'upload-status err';
        });
    };
    reader.onerror = () => {
      statusEl.textContent = '✗ Read failed — try again';
      statusEl.className   = 'upload-status err';
    };
    reader.readAsDataURL(file);
  }

  /* ══════════ STATUS BAR ══════════ */
  function updateStatus(state, text) {
    const dot = document.getElementById('statusDot');
    if (dot) dot.className    = 'status-dot ' + state;
    const txt = document.getElementById('statusText');
    if (txt) txt.textContent = text;
  }

  /* ══════════ TOAST ══════════ */
  let toastTimer;
  function showToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast    = document.createElement('div');
      toast.id = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  /* ══════════ UTILITIES ══════════ */
  function fmt(n) {
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }
  function fmtDate(d) { return d.toISOString().split('T')[0]; }
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ══════════ PUBLIC API ══════════ */
  return {
    init, navigate,
    toggleSidebar, closeSidebar,
    addRow, deleteRow, updateTotals,
    setCurrency, newInvoice, cancelEdit, runMagicParse,
    saveInvoice, updateInvoice, clearInvoice, loadHistory,
    loadInvoiceToEditor, deleteInvoice,
    saveSettings, uploadLogo,
    saveBaseCurrency,
    openEmailModal, closeEmailModal,
    copyEmailDraft, openInMailClient,
    calculateTotalRevenue
  };
})();

document.addEventListener('DOMContentLoaded', () => {
  App.init().catch(err => console.warn('EliteInvoice init error:', err));
});
/* Tonnage — tool client logic */

(function () {
  const form   = document.getElementById('bidForm');
  const photo  = document.getElementById('photo');
  const drop   = document.getElementById('drop');
  const preview= document.getElementById('preview');
  const goBtn  = document.getElementById('goBtn');
  const result = document.getElementById('result');
  const errBox = document.getElementById('errBox');
  const resetBtn = document.getElementById('resetBtn');
  const anotherBtn = document.getElementById('anotherBtn');
  const refreshHistory = document.getElementById('refreshHistory');
  const historyList = document.getElementById('historyList');

  // ── Photo preview ────────────────────────────────────────
  function showPreview(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      preview.src = e.target.result;
      drop.classList.add('has-photo');
    };
    reader.readAsDataURL(file);
  }

  photo.addEventListener('change', () => {
    if (photo.files && photo.files[0]) showPreview(photo.files[0]);
  });

  ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('is-drag');
  }));
  ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('is-drag');
  }));
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      photo.files = e.dataTransfer.files;
      showPreview(photo.files[0]);
    }
  });

  resetBtn.addEventListener('click', () => {
    drop.classList.remove('has-photo');
    preview.src = '';
    result.hidden = true;
    errBox.hidden = true;
  });

  // ── Submit ───────────────────────────────────────────────
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload  = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function fmt$(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return '$' + Math.round(n).toLocaleString();
  }

  function showError(msg) {
    errBox.hidden = false;
    errBox.textContent = msg;
    result.hidden = true;
  }

  async function submitBid(e) {
    e.preventDefault();
    errBox.hidden = true;
    result.hidden = true;

    const f = photo.files && photo.files[0];
    if (!f) { showError('Add a photo first.'); return; }
    if (f.size > 10 * 1024 * 1024) { showError('Photo too big — keep it under 10MB.'); return; }

    const zip = document.getElementById('zip').value.trim();
    if (!/^\d{5}$/.test(zip)) { showError('ZIP needs to be 5 digits.'); return; }

    const dataUrl = await readAsDataURL(f);
    const photoBase64 = dataUrl.split(',')[1];
    const mime = (dataUrl.match(/data:(image\/[^;]+);/) || [])[1] || 'image/jpeg';

    const payload = {
      zip,
      access: document.getElementById('access').value,
      crew:   parseInt(document.getElementById('crew').value, 10),
      hazmat:      form.elements['hazmat']?.checked || false,
      appliances:  form.elements['appliances']?.checked || false,
      electronics: form.elements['electronics']?.checked || false,
      tires:       form.elements['tires']?.checked || false,
      photo_base64: photoBase64,
      photo_mime:   mime
    };

    goBtn.classList.add('is-loading');
    goBtn.querySelector('.btn__label').textContent = 'Sizing the load…';

    try {
      if (window.posthog) window.posthog.capture('tonnage_bid_submitted', { zip });
      const resp = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json();
      if (!resp.ok) {
        showError(data.error || 'Tonnage hit a snag. Try a clearer whole-pile photo.');
        return;
      }
      renderResult(data, zip);
      loadHistory();
      if (window.posthog) window.posthog.capture('tonnage_bid_returned', { zip, bid: data.bid_recommended });
    } catch (err) {
      console.error(err);
      showError('Network hiccup. Check your connection and try again.');
    } finally {
      goBtn.classList.remove('is-loading');
      goBtn.querySelector('.btn__label').textContent = 'Estimate this bid';
    }
  }

  form.addEventListener('submit', submitBid);

  // ── Result render ────────────────────────────────────────
  function renderResult(d, zip) {
    document.getElementById('rZip').textContent = zip;
    document.getElementById('rBidLow').textContent  = fmt$(d.bid_low);
    document.getElementById('rBidHigh').textContent = fmt$(d.bid_high);
    document.getElementById('rBidRec').textContent  = fmt$(d.bid_recommended);

    document.getElementById('rYards').textContent =
      (d.cubic_yards != null) ? (d.cubic_yards.toFixed(1) + ' yd³') : '—';
    document.getElementById('rType').textContent = d.load_type || '—';
    document.getElementById('rLabor').textContent =
      (d.labor_hours != null) ? (d.labor_hours.toFixed(1) + ' hrs') : '—';
    document.getElementById('rDump').textContent =
      (d.dump_fee_low != null) ? (fmt$(d.dump_fee_low) + ' – ' + fmt$(d.dump_fee_high)) : '—';
    document.getElementById('rSurcharges').textContent =
      (Array.isArray(d.surcharges) && d.surcharges.length)
        ? d.surcharges.join(' · ')
        : 'None detected';

    document.getElementById('rRationale').textContent = d.rationale || '';

    result.hidden = false;
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  anotherBtn.addEventListener('click', () => {
    result.hidden = true;
    drop.classList.remove('has-photo');
    preview.src = '';
    photo.value = '';
    window.scrollTo({ top: drop.offsetTop - 80, behavior: 'smooth' });
  });

  // ── History feed ─────────────────────────────────────────
  async function loadHistory() {
    try {
      const r = await fetch('/api/history?limit=10');
      if (!r.ok) throw new Error('history failed');
      const j = await r.json();
      const items = j.bids || [];
      if (!items.length) {
        historyList.innerHTML = '<li class="historylist__empty">No bids yet — be the first.</li>';
        return;
      }
      historyList.innerHTML = items.map(b => `
        <li>
          <span class="zip">${escape(b.zip || '?????')}</span>
          <span class="yards">${(b.cubic_yards || 0).toFixed(1)} yd³ &middot; ${escape(b.load_type || 'mixed')}</span>
          <span class="bid">${fmt$(b.bid_recommended)}</span>
        </li>
      `).join('');
    } catch (e) {
      historyList.innerHTML = '<li class="historylist__empty">History unavailable.</li>';
    }
  }
  function escape(s) {
    return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  refreshHistory.addEventListener('click', loadHistory);
  loadHistory();
})();

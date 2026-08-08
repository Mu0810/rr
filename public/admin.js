/* ==========================================================================
   Recruiter dashboard. Every application, filterable, with CV download,
   status pipeline, private notes and CSV export.
   ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const PAGE_SIZE = 25;

const state = {
  schema: null,
  meta: null,
  offset: 0,
  total: 0,
  openId: null,
};

/* ---------------------------------------------------------------- plumbing */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  if (res.status === 401) {
    showGate();
    throw new Error('unauthorised');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' });
}

function trackTitle(id) {
  return state.meta?.categories.find((c) => c.id === id)?.title || id;
}

/* -------------------------------------------------------------------- auth */

function showGate() {
  $('#gate').hidden = false;
  $('#app').hidden = true;
  closeDrawer();
  $('#pw').focus();
}

function showApp() {
  $('#gate').hidden = true;
  $('#app').hidden = false;
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#loginError');
  error.hidden = true;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('#pw').value }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Sign in failed');
    $('#pw').value = '';
    showApp();
    await boot();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  showGate();
});

/* ------------------------------------------------------------------- stats */

async function loadStats() {
  state.meta = await api('/api/admin/stats');

  const byStatus = Object.fromEntries(state.meta.byStatus.map((r) => [r.status, r.n]));
  const cards = [
    { k: 'Total received', n: state.meta.total },
    { k: 'Last 24 hours', n: state.meta.last24h, hot: true },
    { k: 'New / untouched', n: byStatus.new || 0 },
    { k: 'Shortlisted', n: byStatus.shortlisted || 0 },
    { k: 'Interviewing', n: byStatus.interviewing || 0 },
    { k: 'Hired', n: byStatus.hired || 0 },
  ];

  $('#stats').replaceChildren(
    ...cards.map((c) =>
      el('div', { class: `stat${c.hot ? ' stat--hot' : ''}` }, [
        el('div', { class: 'stat__n num', text: String(c.n) }),
        el('div', { class: 'stat__k', text: c.k }),
      ]),
    ),
  );

  // Delivery health: only shown when something is failing, so it stays quiet
  // when the pipeline is healthy.
  const failing = (state.meta.notifications?.health || []).filter((h) => h.status !== 'sent');
  const banner = $('#deliveryBanner');
  if (failing.length) {
    banner.hidden = false;
    banner.replaceChildren(
      el('span', {
        text:
          `Delivery issues: ` +
          failing.map((f) => `${f.n} ${f.sink} ${f.status}`).join(', ') +
          '. Applications are safe in this dashboard.',
      }),
      el('button', {
        class: 'mini',
        type: 'button',
        onclick: async (e) => {
          e.target.disabled = true;
          await api('/api/admin/deliveries/retry', { method: 'POST', body: '{}' });
          await loadStats();
          await loadList();
        },
      }, 'Retry now'),
    );
  } else {
    banner.hidden = true;
  }

  const catSelect = $('#filterCategory');
  if (catSelect.options.length === 1) {
    const counts = Object.fromEntries(state.meta.byCategory.map((r) => [r.category, r.n]));
    for (const cat of state.meta.categories) {
      catSelect.append(el('option', { value: cat.id, text: `${cat.title} (${counts[cat.id] || 0})` }));
    }
  }
  const statusSelect = $('#filterStatus');
  if (statusSelect.options.length === 1) {
    for (const s of state.meta.statuses) {
      statusSelect.append(el('option', { value: s, text: s.charAt(0).toUpperCase() + s.slice(1) }));
    }
  }
}

/* -------------------------------------------------------------------- list */

function currentQuery() {
  const params = new URLSearchParams();
  const q = $('#q').value.trim();
  const category = $('#filterCategory').value;
  const status = $('#filterStatus').value;
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  if (status) params.set('status', status);
  return params;
}

async function loadList() {
  const params = currentQuery();
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(state.offset));

  const { total, rows } = await api(`/api/admin/applications?${params}`);
  state.total = total;

  const tbody = $('#rows');
  tbody.replaceChildren(
    ...rows.map((row) => {
      const tr = el('tr', { 'data-id': row.id, tabindex: '0' }, [
        el('td', {}, [
          el('div', { class: 'cell-name', text: row.full_name }),
          el('div', { class: 'cell-sub', text: `${row.email} · ${row.phone}` }),
          el('div', { class: 'cell-ref', text: `${row.ref} · ${row.city || '—'}` }),
        ]),
        el('td', {}, el('span', { class: 'pill pill--cat', text: trackTitle(row.category) })),
        el('td', { class: 'hide-sm num', text: row.experience_years != null ? `${row.experience_years} yr` : '—' }),
        el('td', { class: 'hide-sm', text: row.expected_ctc || '—' }),
        el('td', { class: 'hide-sm', text: row.notice_period || '—' }),
        el('td', {}, el('span', { class: `pill pill--${row.status}`, text: row.status })),
        el('td', { class: 'hide-sm', text: timeAgo(row.created_at) }),
        el('td', {}, row.cv_stored_name
          ? el('a', {
              class: 'mini',
              href: `/api/admin/cv/${row.id}`,
              onclick: (e) => e.stopPropagation(),
              title: row.cv_original_name || 'Download CV',
            }, 'CV ↓')
          : el('span', { class: 'cell-sub', text: 'none' })),
      ]);
      tr.addEventListener('click', () => openDrawer(row.id));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') openDrawer(row.id);
      });
      return tr;
    }),
  );

  $('#empty').hidden = rows.length > 0;
  const from = total === 0 ? 0 : state.offset + 1;
  const to = Math.min(state.offset + PAGE_SIZE, total);
  $('#pageInfo').textContent = `${from}–${to} of ${total}`;
  $('#prevPage').disabled = state.offset === 0;
  $('#nextPage').disabled = to >= total;

  $('#exportBtn').href = `/api/admin/export.csv?${currentQuery()}`;
}

/* ------------------------------------------------------------------ drawer */

function labelFor(name) {
  const all = [
    ...(state.schema?.commonFields || []),
    ...(state.schema?.closingFields || []),
    ...(state.schema?.categories || []).flatMap((c) => c.fields),
  ];
  return all.find((f) => f.name === name)?.label || name;
}

function renderValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(' · ') : '—';
  if (value === '' || value === null || value === undefined) return '—';
  return String(value);
}

function kvRow(name, value) {
  const text = renderValue(value);
  const isLink = /^https?:\/\//i.test(text);
  const isLong = text.length > 90;

  return [
    el('dt', { text: labelFor(name) }),
    isLink
      ? el('dd', {}, el('a', { href: text, target: '_blank', rel: 'noopener noreferrer', text: text.replace(/^https?:\/\//, '') }))
      : el('dd', { class: isLong ? 'long' : '', text }),
  ];
}

async function openDrawer(id) {
  state.openId = id;
  const app = await api(`/api/admin/applications/${id}`);

  document.querySelectorAll('#rows tr').forEach((tr) => {
    tr.classList.toggle('is-open', Number(tr.dataset.id) === id);
  });

  $('#dName').textContent = app.full_name;
  $('#dMeta').textContent = `${trackTitle(app.category)} · ${app.ref} · applied ${timeAgo(app.created_at)}`;

  const answers = app.answers;
  const commonNames = (state.schema?.commonFields || []).map((f) => f.name);
  const closingNames = (state.schema?.closingFields || []).map((f) => f.name);
  const catFields = (state.schema?.categories || []).find((c) => c.id === app.category)?.fields.map((f) => f.name) || [];

  const body = $('#dBody');
  body.replaceChildren();

  /* quick actions */
  body.append(
    el('div', { class: 'drawer__actions' }, [
      app.cv_stored_name
        ? el('a', { class: 'mini mini--go', href: `/api/admin/cv/${id}` }, `Download CV (${Math.round((app.cv_size || 0) / 1024)} KB)`)
        : null,
      el('a', { class: 'mini', href: `mailto:${app.email}?subject=${encodeURIComponent(`Your application to Hack Daily (${app.ref})`)}` }, 'Email'),
      el('a', { class: 'mini', href: `https://wa.me/${app.phone.replace(/\D/g, '')}`, target: '_blank', rel: 'noopener' }, 'WhatsApp'),
    ]),
  );

  /* status + notes */
  const statusSelect = el('select', { id: 'dStatus' },
    state.meta.statuses.map((s) => el('option', { value: s, text: s.charAt(0).toUpperCase() + s.slice(1), selected: s === app.status })),
  );
  const notes = el('textarea', { id: 'dNotes', rows: 4, placeholder: 'Private notes — screening call, red flags, salary discussion…' });
  notes.value = app.recruiter_notes || '';
  const savedFlag = el('span', { class: 'saved', id: 'dSaved', text: 'Saved' });

  let timer;
  const persist = async () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await api(`/api/admin/applications/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: statusSelect.value, recruiterNotes: notes.value }),
      });
      savedFlag.classList.add('show');
      setTimeout(() => savedFlag.classList.remove('show'), 1400);
      loadStats().catch(() => {});
      loadList().catch(() => {});
    }, 400);
  };
  statusSelect.addEventListener('change', persist);
  notes.addEventListener('input', persist);

  body.append(
    el('div', { class: 'drawer__group' }, [
      el('h4', {}, ['Pipeline', savedFlag]),
      el('label', { class: 'lbl', for: 'dStatus', text: 'Status' }),
      statusSelect,
      el('label', { class: 'lbl', for: 'dNotes', text: 'Recruiter notes', style: 'margin-top:14px' }),
      notes,
    ]),
  );

  const group = (title, names) => {
    const rows = names.flatMap((n) => (n in answers ? kvRow(n, answers[n]) : []));
    if (!rows.length) return null;
    return el('div', { class: 'drawer__group' }, [el('h4', { text: title }), el('dl', { class: 'kv' }, rows)]);
  };

  const SINK_LABELS = { email: 'Email', sheet: 'Google Sheet', webhook: 'Webhook' };

  if (app.deliveries?.length) {
    body.append(
      el('div', { class: 'drawer__group' }, [
        el('h4', { text: 'Delivered to' }),
        el('dl', { class: 'kv' },
          app.deliveries.flatMap((d) => [
            el('dt', { text: SINK_LABELS[d.sink] || d.sink }),
            el('dd', {}, [
              el('span', { class: `pill pill--${d.status === 'sent' ? 'hired' : d.status === 'failed' ? 'rejected' : 'interviewing'}`, text: d.status }),
              d.attempts > 1 ? el('span', { class: 'cell-sub', text: ` after ${d.attempts} attempts` }) : null,
              d.last_error ? el('div', { class: 'cell-sub', text: d.last_error }) : null,
            ]),
          ]),
        ),
      ]),
    );
  }

  body.append(
    group('Candidate details', commonNames),
    group(`${trackTitle(app.category)} — role questions`, catFields),
    group('In their words', closingNames),
    el('div', { class: 'drawer__group' }, [
      el('h4', { text: 'Submission' }),
      el('dl', { class: 'kv' }, [
        el('dt', { text: 'Reference' }), el('dd', { text: app.ref }),
        el('dt', { text: 'Received' }), el('dd', { text: new Date(app.created_at).toLocaleString('en-IN') }),
        el('dt', { text: 'CV file' }), el('dd', { text: app.cv_original_name || '—' }),
        el('dt', { text: 'Brand' }), el('dd', { text: app.brand }),
      ]),
    ]),
  );

  $('#drawer').classList.add('is-open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('is-open');
}

function closeDrawer() {
  state.openId = null;
  $('#drawer').classList.remove('is-open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('is-open');
  document.querySelectorAll('#rows tr.is-open').forEach((tr) => tr.classList.remove('is-open'));
}

$('#dClose').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

/* ----------------------------------------------------------------- filters */

let debounce;
$('#q').addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    state.offset = 0;
    loadList();
  }, 260);
});
for (const id of ['#filterCategory', '#filterStatus']) {
  $(id).addEventListener('change', () => {
    state.offset = 0;
    loadList();
  });
}
$('#resetBtn').addEventListener('click', () => {
  $('#q').value = '';
  $('#filterCategory').value = '';
  $('#filterStatus').value = '';
  state.offset = 0;
  loadList();
});
$('#prevPage').addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - PAGE_SIZE);
  loadList();
});
$('#nextPage').addEventListener('click', () => {
  if (state.offset + PAGE_SIZE < state.total) {
    state.offset += PAGE_SIZE;
    loadList();
  }
});

/* -------------------------------------------------------------------- boot */

async function boot() {
  state.schema = await fetch('/api/schema').then((r) => r.json());
  await loadStats();
  await loadList();
}

(async function init() {
  const { authed } = await fetch('/api/admin/session').then((r) => r.json());
  if (!authed) return showGate();
  showApp();
  try {
    await boot();
  } catch {
    showGate();
  }
})();

// Light polling so a new application appears without a manual refresh.
setInterval(() => {
  if ($('#app').hidden || state.openId) return;
  loadStats().catch(() => {});
  loadList().catch(() => {});
}, 60_000);

/* ==========================================================================
   Candidate portal — schema-driven form, multi-step flow, hand-rolled motion.
   Every field is built from GET /api/schema, so adding a question server-side
   needs no change here.
   ========================================================================== */

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  schema: null,
  category: null,
  step: 1,
  startedAt: 0,
  submitting: false,
};

/* ------------------------------------------------------------------ helpers */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null && value !== false) {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

function slug(name) {
  return `f_${name}`;
}

/* --------------------------------------------------------- field rendering */

function renderField(field) {
  const id = slug(field.name);
  const wrap = el('div', { class: field.type === 'textarea' || field.type === 'multiselect' ? 'field field--full' : 'field' });

  const label = el('label', { class: 'label', for: id }, [
    document.createTextNode(field.label + ' '),
    field.required ? el('span', { class: 'req', text: '*' }) : null,
  ]);
  if (field.hint) label.append(el('span', { class: 'hint', text: field.hint }));
  wrap.append(label);

  let control;

  switch (field.type) {
    case 'select':
      control = el('select', { id, name: field.name, required: field.required }, [
        el('option', { value: '', text: 'Select…' }),
        ...field.options.map((opt) => el('option', { value: opt, text: opt })),
      ]);
      break;

    case 'multiselect': {
      control = el('div', { class: 'chips', role: 'group', 'aria-labelledby': `${id}-label` });
      label.id = `${id}-label`;
      for (const opt of field.options) {
        control.append(
          el('label', { class: 'chip' }, [
            el('input', { type: 'checkbox', name: `${field.name}[]`, value: opt }),
            el('span', { text: opt }),
          ]),
        );
      }
      break;
    }

    case 'textarea':
      control = el('textarea', {
        id,
        name: field.name,
        required: field.required,
        maxlength: field.maxLength,
        placeholder: field.placeholder,
        rows: 4,
      });
      break;

    case 'number':
      control = el('input', {
        type: 'number',
        id,
        name: field.name,
        required: field.required,
        min: field.min,
        max: field.max,
        step: field.step ?? 1,
        placeholder: field.placeholder,
      });
      break;

    default:
      control = el('input', {
        type: field.type,
        id,
        name: field.name,
        required: field.required,
        maxlength: field.maxLength,
        placeholder: field.placeholder,
        autocomplete: autocompleteFor(field.name),
      });
  }

  wrap.append(control);

  if (field.maxLength && field.type === 'textarea') {
    const counter = el('span', { class: 'counter', text: `0 / ${field.maxLength}` });
    control.addEventListener('input', () => {
      counter.textContent = `${control.value.length} / ${field.maxLength}`;
    });
    wrap.append(counter);
  }

  wrap.append(el('p', { class: 'error', id: `error-${field.name}`, hidden: true }));
  return wrap;
}

function autocompleteFor(name) {
  return (
    {
      fullName: 'name',
      email: 'email',
      phone: 'tel',
      city: 'address-level2',
      currentCompany: 'organization',
      currentRole: 'organization-title',
    }[name] || 'off'
  );
}

/* ------------------------------------------------------------ track picker */

function renderTracks() {
  const grid = $('#trackGrid');
  grid.replaceChildren();

  state.schema.categories.forEach((cat, i) => {
    const card = el('button', { class: 'track', type: 'button', role: 'listitem', 'data-id': cat.id }, [
      el('span', { class: 'track__code', text: cat.code }),
      el('h3', { class: 'track__title', text: cat.title }),
      el('p', { class: 'track__roles', text: cat.roleLine }),
      el('p', { class: 'track__blurb', text: cat.blurb }),
      el('span', { class: 'track__go' }, [
        document.createTextNode('Apply'),
        el('span', {
          html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>',
        }),
      ]),
    ]);

    card.addEventListener('click', () => selectCategory(cat.id));
    card.style.transitionDelay = REDUCED ? '0ms' : `${i * 70}ms`;
    grid.append(card);
    if (REDUCED) card.classList.add('is-in');
  });

  if (!REDUCED) observeIn(grid.querySelectorAll('.track'));
}

/* -------------------------------------------------------------- form flow */

function selectCategory(id) {
  const cat = state.schema.categories.find((c) => c.id === id);
  if (!cat) return;

  state.category = cat;
  state.step = 1;
  state.startedAt = Date.now();

  $('#categoryInput').value = cat.id;
  $('#applyTitle').textContent = cat.title;
  $('#applyRoleline').textContent = cat.roleLine;

  $('#fieldsCommon').replaceChildren(...state.schema.commonFields.map(renderField));
  $('#fieldsCategory').replaceChildren(...cat.fields.map(renderField));
  $('#fieldsClosing').replaceChildren(...state.schema.closingFields.map(renderField));

  $('#done').hidden = true;
  $('#knockout').hidden = true;
  $('#nextBtn').disabled = false;
  $('#submitBtn').disabled = false;
  const apply = $('#apply');
  apply.hidden = false;
  showStep(1);

  requestAnimationFrame(() => {
    apply.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
  });
}

function showStep(step) {
  state.step = step;

  document.querySelectorAll('.pane').forEach((pane) => {
    const isActive = Number(pane.dataset.step) === step;
    pane.hidden = !isActive;
    pane.classList.toggle('is-active', isActive);
  });

  document.querySelectorAll('.steps__item').forEach((item, i) => {
    item.classList.toggle('is-active', i + 1 === step);
    item.classList.toggle('is-done', i + 1 < step);
  });

  $('#stepsProgress').style.width = `${(step / 3) * 100}%`;
  $('#prevBtn').hidden = step === 1;
  $('#nextBtn').hidden = step === 3;
  $('#submitBtn').hidden = step !== 3;

  const firstInput = $(`.pane[data-step="${step}"] input, .pane[data-step="${step}"] select, .pane[data-step="${step}"] textarea`);
  if (firstInput && step > 1) setTimeout(() => firstInput.focus({ preventScroll: true }), 90);
}

function fieldsForStep(step) {
  if (step === 1) return state.schema.commonFields;
  if (step === 2) return state.category.fields;
  return state.schema.closingFields;
}

function showFieldError(name, message) {
  const box = $(`#error-${name}`);
  if (!box) return;
  box.textContent = message || '';
  box.hidden = !message;
  const wrap = box.closest('.field') || box.parentElement;
  wrap?.classList.toggle('is-invalid', Boolean(message));
}

function clearErrors(scope = document) {
  scope.querySelectorAll('.error').forEach((e) => {
    e.hidden = true;
    e.textContent = '';
  });
  scope.querySelectorAll('.is-invalid').forEach((e) => e.classList.remove('is-invalid'));
}

/**
 * A knockout answer (needing remote work) ends the flow on step 1 rather than
 * after twenty questions and a CV upload.
 */
function knockoutField() {
  return state.schema.commonFields.find((f) => f.knockout);
}

function checkKnockout() {
  const field = knockoutField();
  if (!field) return false;

  const control = $('#applyForm').elements[field.name];
  const hit = control && control.value === field.knockout.value;

  const box = $('#knockout');
  box.hidden = !hit;
  if (hit) {
    $('#knockoutText').textContent = field.knockout.message;
    box.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' });
  }

  $('#nextBtn').disabled = hit;
  $('#submitBtn').disabled = hit;
  return hit;
}

function showKnockout(message) {
  $('#knockoutText').textContent = message;
  $('#knockout').hidden = false;
  $('#nextBtn').disabled = true;
  $('#submitBtn').disabled = true;
  showStep(1);
  $('#knockout').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' });
}

/** Client-side mirror of the server rules — for fast feedback, not for trust. */
function validateStep(step) {
  const form = $('#applyForm');
  let firstBad = null;

  clearErrors($(`.pane[data-step="${step}"]`));

  for (const field of fieldsForStep(step)) {
    let value;
    if (field.type === 'multiselect') {
      value = [...form.querySelectorAll(`input[name="${field.name}[]"]:checked`)].map((i) => i.value);
    } else {
      value = form.elements[field.name]?.value?.trim() ?? '';
    }

    let error = '';
    const empty = Array.isArray(value) ? value.length === 0 : value === '';

    if (field.required && empty) {
      error = Array.isArray(value) ? 'Pick at least one option' : `${field.label} is required`;
    } else if (!empty && field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value)) {
      error = 'That email does not look right';
    } else if (!empty && field.type === 'tel' && !/^[+]?[\d][\d\s().-]{6,19}$/.test(value)) {
      error = 'Include your country code, e.g. +91 98765 43210';
    } else if (!empty && field.type === 'url' && !/^https?:\/\/.+\..+/i.test(value)) {
      error = 'Paste the full link, starting with https://';
    } else if (!empty && field.minLength && value.length < field.minLength) {
      error = `A little more detail please — at least ${field.minLength} characters`;
    } else if (!empty && field.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) error = 'Enter a number';
      else if (field.min !== undefined && n < field.min) error = `Cannot be below ${field.min}`;
      else if (field.max !== undefined && n > field.max) error = `Cannot be above ${field.max}`;
    }

    if (error) {
      showFieldError(field.name, error);
      firstBad ||= field.name;
    }
  }

  if (step === 3) {
    const file = $('#cv').files[0];
    const { maxBytes, extensions, maxMb } = state.schema.cvRules;
    if (!file) {
      showFieldError('cv', 'Attach your CV to continue');
      firstBad ||= 'cv';
    } else if (file.size > maxBytes) {
      showFieldError('cv', `That file is ${(file.size / 1048576).toFixed(1)}MB — the limit is ${maxMb}MB`);
      firstBad ||= 'cv';
    } else if (!extensions.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      showFieldError('cv', `Use one of: ${extensions.join(', ')}`);
      firstBad ||= 'cv';
    }

    if (!$('#consent').checked) {
      showFieldError('consent', 'Please tick the box to continue');
      firstBad ||= 'consent';
    }
  }

  if (firstBad) {
    const node = $(`#error-${firstBad}`)?.closest('.field') || $(`#error-${firstBad}`)?.parentElement;
    node?.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' });
    return false;
  }
  return true;
}

async function submitForm(event) {
  event.preventDefault();
  if (state.submitting) return;
  if (!validateStep(1)) return showStep(1);
  if (!validateStep(2)) return showStep(2);
  if (!validateStep(3)) return;

  const btn = $('#submitBtn');
  state.submitting = true;
  btn.classList.add('is-busy');
  btn.disabled = true;
  $('#error-form').hidden = true;

  const data = new FormData($('#applyForm'));
  data.set('form_elapsed_ms', String(Date.now() - state.startedAt));

  try {
    const res = await fetch('/api/apply', { method: 'POST', body: data });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 422 && body.knockout) {
        return showKnockout(body.error);
      }
      if (body.errors) {
        for (const [name, message] of Object.entries(body.errors)) showFieldError(name, message);
        const stepOf = (name) =>
          state.schema.commonFields.some((f) => f.name === name) ? 1
          : state.category.fields.some((f) => f.name === name) ? 2
          : 3;
        const target = Math.min(...Object.keys(body.errors).map(stepOf));
        if (Number.isFinite(target)) showStep(target);
      }
      const form = $('#error-form');
      form.textContent = body.error || 'Submission failed. Please try again.';
      form.hidden = false;
      return;
    }

    $('#doneRef').textContent = body.ref;
    $('#apply').hidden = true;
    const done = $('#done');
    done.hidden = false;
    done.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' });
    if (!REDUCED) burst();
  } catch {
    const form = $('#error-form');
    form.textContent = 'Network error — check your connection and try again.';
    form.hidden = false;
  } finally {
    state.submitting = false;
    btn.classList.remove('is-busy');
    btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- CV upload */

function wireUpload() {
  const drop = $('#cvDrop');
  const input = $('#cv');

  const paint = () => {
    const file = input.files[0];
    drop.classList.toggle('has-file', Boolean(file));
    $('.drop__filled').hidden = !file;
    if (file) {
      $('#cvName').textContent = file.name;
      $('#cvSize').textContent = `${(file.size / 1024).toFixed(0)} KB`;
      showFieldError('cv', '');
    }
  };

  input.addEventListener('change', paint);

  $('#cvClear').addEventListener('click', (e) => {
    e.stopPropagation();
    input.value = '';
    paint();
  });

  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('is-over'));
  }
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      paint();
    }
  });

  const { maxMb, extensions } = state.schema.cvRules;
  $('#cvHint').textContent = `${extensions.join(', ')} · up to ${maxMb}MB`;
}

/* ----------------------------------------------------------------- motion */

function observeIn(nodes) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.16, rootMargin: '0px 0px -8% 0px' },
  );
  nodes.forEach((n) => io.observe(n));
}

/** Splits headline lines into words so each can rotate in independently. */
function splitHeadline() {
  if (REDUCED) return;
  let index = 0;
  document.querySelectorAll('[data-split]').forEach((line) => {
    const words = line.textContent.trim().split(/\s+/);
    line.replaceChildren(
      ...words.flatMap((word, i) => {
        const span = el('span', { class: 'word', text: word });
        span.style.animationDelay = `${0.12 + index++ * 0.075}s`;
        return i < words.length - 1 ? [span, document.createTextNode(' ')] : [span];
      }),
    );
  });
}

function buildMarquee() {
  const track = $('#marqueeTrack');
  const items = [
    'CRM & Retention', 'Offline Marketing', 'Brand Management',
    'Graphic Design', 'Motion Design', 'Leadership / CXO',
  ];
  const once = items.map((t) => el('span', { class: 'marquee__item', text: t }));
  const twice = items.map((t) => el('span', { class: 'marquee__item', text: t }));
  track.replaceChildren(...once, ...twice);
}

/** Soft drifting particle field behind the hero — cheap, capped, pauses offscreen. */
function heroCanvas() {
  if (REDUCED) return;
  const canvas = $('#heroCanvas');
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;

  let dots = [];
  let raf = 0;
  let running = true;

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = Math.min(52, Math.round(width / 26));
    dots = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.9 + Math.random() * 2.4,
      vx: (Math.random() - 0.5) * 0.22,
      vy: -0.1 - Math.random() * 0.28,
      a: 0.16 + Math.random() * 0.3,
    }));
  }

  function frame() {
    if (!running) return;
    const { width, height } = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, width, height);
    for (const d of dots) {
      d.x += d.vx;
      d.y += d.vy;
      if (d.y < -8) { d.y = height + 8; d.x = Math.random() * width; }
      if (d.x < -8) d.x = width + 8;
      if (d.x > width + 8) d.x = -8;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(14, 59, 38, ${d.a})`;
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }

  size();
  frame();
  window.addEventListener('resize', size, { passive: true });

  new IntersectionObserver((entries) => {
    running = entries[0].isIntersecting;
    if (running) frame();
    else cancelAnimationFrame(raf);
  }).observe($('#hero'));
}

function scrollUi() {
  const bar = $('#scrollProgress');
  const nav = $('#nav');
  let queued = false;

  const paint = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = `${max > 0 ? (window.scrollY / max) * 100 : 0}%`;
    nav.classList.toggle('is-stuck', window.scrollY > 12);
    queued = false;
  };

  window.addEventListener('scroll', () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(paint);
    }
  }, { passive: true });
  paint();
}

function customCursor() {
  if (REDUCED || window.matchMedia('(hover: none)').matches) return;
  const dot = $('#cursorDot');
  let x = 0, y = 0, cx = 0, cy = 0;

  window.addEventListener('mousemove', (e) => {
    x = e.clientX;
    y = e.clientY;
    dot.classList.add('is-on');
    const hot = e.target.closest('button, a, .track, .drop, .chip, input, select, textarea');
    dot.classList.toggle('is-hot', Boolean(hot));
  }, { passive: true });

  (function loop() {
    cx += (x - cx) * 0.2;
    cy += (y - cy) * 0.2;
    dot.style.transform = `translate(${cx}px, ${cy}px)` + (dot.classList.contains('is-hot') ? ' scale(1.75)' : '');
    requestAnimationFrame(loop);
  })();
}

/** Confetti on success — pure canvas, self-removing. */
function burst() {
  const canvas = el('canvas', { style: 'position:fixed;inset:0;pointer-events:none;z-index:99' });
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);

  const colors = ['#c8f04c', '#0e3b26', '#0c0d0a', '#a8d62e'];
  const bits = Array.from({ length: 90 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 180,
    y: innerHeight / 2,
    vx: (Math.random() - 0.5) * 9,
    vy: -6 - Math.random() * 9,
    w: 4 + Math.random() * 7,
    h: 3 + Math.random() * 5,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0],
  }));

  const start = performance.now();
  (function tick(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.vy += 0.28;
      b.x += b.vx;
      b.y += b.vy;
      b.rot += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.globalAlpha = Math.max(0, 1 - elapsed / 2600);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (elapsed < 2600) requestAnimationFrame(tick);
    else canvas.remove();
  })(start);
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  splitHeadline();
  buildMarquee();
  scrollUi();
  customCursor();
  heroCanvas();
  if (!REDUCED) observeIn(document.querySelectorAll('[data-reveal]'));
  else document.querySelectorAll('[data-reveal]').forEach((n) => n.classList.add('is-in'));

  try {
    const res = await fetch('/api/schema');
    if (!res.ok) throw new Error('schema unavailable');
    state.schema = await res.json();
  } catch {
    $('#trackGrid').replaceChildren(
      el('p', { class: 'error', text: 'Could not load the open roles. Please refresh the page.' }),
    );
    return;
  }

  renderTracks();
  wireUpload();

  // All office copy comes from the server, so changing OFFICE_ADDRESS or
  // OFFICE_CITY updates the hero, the footer, the map link and the form at once.
  const office = state.schema.brand?.office;
  if (office) {
    if (office.city) $('#heroCity').textContent = office.city;
    if (office.address) {
      $('#officeAddress').textContent = office.address;
      $('#footOffice').textContent = `Onsite · ${office.address}`;
    }
    if (office.mapsUrl) $('#officeMap').href = office.mapsUrl;
  }

  $('#nextBtn').addEventListener('click', () => {
    if (checkKnockout()) return;
    if (validateStep(state.step)) showStep(state.step + 1);
  });
  $('#prevBtn').addEventListener('click', () => showStep(Math.max(1, state.step - 1)));
  $('#applyForm').addEventListener('submit', submitForm);

  // React the moment the onsite answer changes, on step 1.
  $('#applyForm').addEventListener('change', (e) => {
    if (e.target.name === knockoutField()?.name) checkKnockout();
  });

  $('#changeTrack').addEventListener('click', () => {
    $('#apply').hidden = true;
    $('#tracks').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
  });

  // Enter advances a step instead of submitting early.
  $('#applyForm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && state.step < 3) {
      e.preventDefault();
      if (validateStep(state.step)) showStep(state.step + 1);
    }
  });
}

boot();

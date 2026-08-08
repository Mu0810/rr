/**
 * Where a new application goes the moment it arrives.
 *
 * Three independent destinations, each enabled by configuration alone:
 *   email    — SMTP (Gmail app password, Zoho, SES…), zero dependencies
 *   sheet    — a Google Apps Script web app that appends a row to your Sheet
 *   webhook  — any JSON endpoint (Slack, Zapier, n8n)
 *
 * Deliveries are queued in the database, attempted immediately, and retried
 * with backoff. A destination being down never blocks or fails a candidate's
 * submission — the application is already stored before we try to notify.
 */

import {
  deliveriesFor,
  dueDeliveries,
  getApplication,
  markDelivered,
  markFailed,
  queueDelivery,
} from './db.js';
import { BRAND, CATEGORIES, COMMON_FIELDS, CLOSING_FIELDS } from './schema.js';
import { sendMail } from './smtp.js';

const HTTP_TIMEOUT_MS = 10_000;

export const config = {
  email: {
    enabled: Boolean(process.env.SMTP_HOST && process.env.MAIL_TO),
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 465),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
    to: (process.env.MAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  sheet: {
    enabled: Boolean(process.env.SHEETS_WEBHOOK_URL),
    url: process.env.SHEETS_WEBHOOK_URL || '',
    secret: process.env.SHEETS_SHARED_SECRET || '',
  },
  webhook: {
    enabled: Boolean(process.env.NOTIFY_WEBHOOK_URL),
    url: process.env.NOTIFY_WEBHOOK_URL || '',
  },
};

export function enabledSinks() {
  return Object.entries(config)
    .filter(([, c]) => c.enabled)
    .map(([name]) => name);
}

/* ------------------------------------------------------------------ helpers */

function labelFor(name, categoryId) {
  const pool = [
    ...COMMON_FIELDS,
    ...CLOSING_FIELDS,
    ...(CATEGORIES.find((c) => c.id === categoryId)?.fields || []),
  ];
  return pool.find((f) => f.name === name)?.label || name;
}

function orderedAnswers(app) {
  const category = CATEGORIES.find((c) => c.id === app.category);
  const order = [
    ...COMMON_FIELDS.map((f) => f.name),
    ...(category?.fields || []).map((f) => f.name),
    ...CLOSING_FIELDS.map((f) => f.name),
  ];
  return order
    .filter((name) => name in app.answers)
    .map((name) => ({
      name,
      label: labelFor(name, app.category),
      value: Array.isArray(app.answers[name]) ? app.answers[name].join(', ') : String(app.answers[name] ?? ''),
    }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/* -------------------------------------------------------------------- email */

export function composeEmail(app, { dashboardUrl } = {}) {
  const category = CATEGORIES.find((c) => c.id === app.category);
  const rows = orderedAnswers(app);
  const a = app.answers;

  // Kept ASCII on purpose: a non-ASCII character here would force the whole
  // subject into RFC 2047 base64, which is unreadable in logs and mail lists.
  const subject = `[${category?.code || app.category}] ${a.fullName} - ${a.experienceYears} yrs, ${a.city} (${app.ref})`;

  const headline = [
    `New application — ${category?.title || app.category}`,
    '',
    `Name       ${a.fullName}`,
    `Email      ${a.email}`,
    `Phone      ${a.phone}`,
    `City       ${a.city}`,
    `Onsite     ${a.onsiteCommitment ?? '—'}`,
    `Experience ${a.experienceYears} years`,
    `Notice     ${a.noticePeriod}`,
    `Expected   ${a.expectedCtc}`,
    `Reference  ${app.ref}`,
    '',
    'The CV is attached to this application in the dashboard.',
    dashboardUrl ? `Open it: ${dashboardUrl}` : '',
    '',
    '--- Full answers ---',
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  const text = headline + rows.map((r) => `${r.label}\n  ${r.value || '—'}`).join('\n\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f4f1e9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0c0d0a">
<div style="max-width:640px;margin:0 auto;padding:24px">
  <p style="margin:0 0 4px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#0c0d0a99">${escapeHtml(BRAND.agency)} · ${escapeHtml(BRAND.client)}</p>
  <h1 style="margin:0 0 4px;font-size:22px;line-height:1.2">${escapeHtml(a.fullName)}</h1>
  <p style="margin:0 0 20px;font-size:14px;color:#0c0d0a99">${escapeHtml(category?.title || app.category)} · ${escapeHtml(String(a.experienceYears))} yrs · ${escapeHtml(a.city)}</p>

  <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #0c0d0a1f;border-radius:6px;overflow:hidden;font-size:14px">
    ${['email', 'phone', 'onsiteCommitment', 'noticePeriod', 'expectedCtc']
      .filter((k) => a[k] !== undefined && a[k] !== '')
      .map(
        (k) => `<tr>
      <td style="padding:9px 13px;border-bottom:1px solid #0c0d0a12;color:#0c0d0a99;width:40%">${escapeHtml(labelFor(k, app.category))}</td>
      <td style="padding:9px 13px;border-bottom:1px solid #0c0d0a12;font-weight:600">${escapeHtml(Array.isArray(a[k]) ? a[k].join(', ') : a[k])}</td>
    </tr>`,
      )
      .join('')}
    <tr><td style="padding:9px 13px;color:#0c0d0a99">Reference</td><td style="padding:9px 13px;font-family:ui-monospace,Menlo,monospace">${escapeHtml(app.ref)}</td></tr>
  </table>

  ${dashboardUrl ? `<p style="margin:20px 0"><a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:12px 22px;background:#0c0d0a;color:#c8f04c;text-decoration:none;border-radius:999px;font-weight:700;font-size:13px">Open in dashboard &amp; download CV</a></p>` : ''}

  <h2 style="margin:26px 0 10px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#0c0d0a99">Full answers</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${rows
      .map(
        (r) => `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #0c0d0a12;color:#0c0d0a99;vertical-align:top;width:40%">${escapeHtml(r.label)}</td>
      <td style="padding:8px 0 8px 12px;border-bottom:1px solid #0c0d0a12;vertical-align:top">${escapeHtml(r.value) || '—'}</td>
    </tr>`,
      )
      .join('')}
  </table>
</div></body></html>`;

  return { subject, text, html };
}

async function deliverEmail(app, options) {
  const { subject, text, html } = composeEmail(app, options);
  await sendMail(
    {
      host: config.email.host,
      port: config.email.port,
      user: config.email.user,
      pass: config.email.pass,
    },
    {
      from: config.email.from,
      to: config.email.to,
      replyTo: app.answers.email, // reply goes straight to the candidate
      subject,
      text,
      html,
    },
  );
}

/* -------------------------------------------------------------------- sheet */

/** Flat one-row-per-application payload the Apps Script appends to your Sheet. */
export function sheetRow(app) {
  const a = app.answers;
  return {
    receivedAt: app.created_at,
    reference: app.ref,
    track: CATEGORIES.find((c) => c.id === app.category)?.title || app.category,
    trackCode: CATEGORIES.find((c) => c.id === app.category)?.code || '',
    name: a.fullName,
    email: a.email,
    phone: a.phone,
    city: a.city,
    onsite: a.onsiteCommitment || '',
    experienceYears: a.experienceYears,
    currentCompany: a.currentCompany || '',
    currentRole: a.currentRole || '',
    noticePeriod: a.noticePeriod || '',
    currentCtc: a.currentCtc || '',
    expectedCtc: a.expectedCtc || '',
    linkedin: a.linkedin || '',
    source: a.source || '',
    status: app.status,
    cvFile: app.cv_original_name || '',
    roleAnswers: orderedAnswers(app)
      .filter((r) => !COMMON_FIELDS.some((f) => f.name === r.name))
      .map((r) => `${r.label}: ${r.value}`)
      .join('\n'),
  };
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function deliverSheet(app) {
  const res = await postJson(config.sheet.url, {
    secret: config.sheet.secret,
    row: sheetRow(app),
  });

  // Apps Script answers 200 even when it rejected the request, carrying the
  // real outcome in the body. Without this check a wrong shared secret or an
  // undeployed script would be recorded as a successful delivery.
  const body = (await res.text()).trim();

  if (/^\s*</.test(body) || /Sign in|Google Drive|accounts\.google\.com/i.test(body)) {
    throw new Error(
      'Google returned a sign-in page instead of the script. Re-deploy the web app with access set to "Anyone", and use the /exec URL.',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`unexpected response from the Sheet script: ${body.slice(0, 160)}`);
  }

  if (parsed.error || (parsed.status && parsed.status >= 400)) {
    throw new Error(
      parsed.error === 'bad secret'
        ? 'the Sheet script rejected the shared secret — SHEETS_SHARED_SECRET must match SHARED_SECRET inside Code.gs exactly'
        : `Sheet script reported: ${parsed.error || parsed.status}`,
    );
  }
  if (parsed.ok !== true) {
    throw new Error(`Sheet script did not confirm the write: ${body.slice(0, 160)}`);
  }
}

async function deliverWebhook(app) {
  const { text } = composeEmail(app);
  await postJson(config.webhook.url, { text, application: { ref: app.ref, ...app.answers } });
}

/* ---------------------------------------------------------------- dispatch */

const SINKS = { email: deliverEmail, sheet: deliverSheet, webhook: deliverWebhook };

let options = {};

/** Called once at boot so notifications can link back to the dashboard. */
export function configure(opts) {
  options = { ...options, ...opts };
}

/** Queues every enabled destination for one application, then tries them now. */
export function dispatch(applicationId) {
  for (const sink of enabledSinks()) queueDelivery(applicationId, sink);
  drain().catch((err) => console.error('[notify] drain failed:', err.message));
}

/** Attempts all due deliveries. Safe to call concurrently — it is idempotent. */
export async function drain(limit = 20) {
  const due = dueDeliveries(limit);
  if (!due.length) return { attempted: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  await Promise.all(
    due.map(async (row) => {
      const app = getApplication(row.application_id);
      const send = SINKS[row.sink];

      if (!app || !send || !config[row.sink]?.enabled) {
        markFailed(row.id, app ? `sink "${row.sink}" is not configured` : 'application no longer exists', 1);
        failed += 1;
        return;
      }

      try {
        await send(app, options);
        markDelivered(row.id);
        sent += 1;
        console.log(`[notify] ${row.sink} ← ${app.ref}`);
      } catch (err) {
        markFailed(row.id, err.message);
        failed += 1;
        console.error(`[notify] ${row.sink} failed for ${app.ref}: ${err.message}`);
      }
    }),
  );

  return { attempted: due.length, sent, failed };
}

/** Background retry loop. Returns a stop function. */
export function startWorker(intervalMs = Number(process.env.DELIVERY_WORKER_MS || 60_000)) {
  if (!enabledSinks().length) return () => {};
  const timer = setInterval(() => {
    drain().catch((err) => console.error('[notify] worker:', err.message));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export { deliveriesFor };

/**
 * End-to-end delivery. Boots the real server with email and Sheet destinations
 * pointed at fakes, submits a real application through the public API, and
 * proves both destinations received it — and that a failing destination is
 * recorded and retried rather than silently dropped.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEST_PASSWORD,
  crmApplication,
  designerApplication,
  fakeSheet,
  fakeSmtp,
  startServer,
  waitFor,
} from './helpers.js';

const SMTP_PORT = 2540;
const SHEET_PORT = 2541;

let server;
let smtp;
let sheet;
let cookie = '';

const apply = (form) => fetch(`${server.base}/api/apply`, { method: 'POST', body: form });

const admin = (path, options = {}) =>
  fetch(`${server.base}${path}`, { ...options, headers: { ...(options.headers || {}), cookie } });

before(async () => {
  smtp = fakeSmtp({ authMech: 'LOGIN' });
  sheet = fakeSheet({ failTimes: 1 }); // first attempt fails, to exercise retry
  await smtp.listen(SMTP_PORT);
  await sheet.listen(SHEET_PORT);

  server = await startServer(4197, {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(SMTP_PORT),
    SMTP_USER: 'portal@example.com',
    SMTP_PASS: 'app-password',
    MAIL_FROM: 'Rocket Recruiters <portal@example.com>',
    MAIL_TO: 'hiring@rocketrecruiters.example,partner@rocketrecruiters.example',
    SHEETS_WEBHOOK_URL: `http://127.0.0.1:${SHEET_PORT}/exec`,
    SHEETS_SHARED_SECRET: 'sheet-secret',
    PUBLIC_URL: 'https://careers.example.com',
    // Compress the real 1-minute backoff so the retry path is testable.
    DELIVERY_BACKOFF_MS: '250',
    DELIVERY_WORKER_MS: '400',
  });

  const login = await fetch(`${server.base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server?.stop();
  smtp?.close();
  sheet?.close();
});

/* -------------------------------------------------------------------------- */

describe('delivering a new application', () => {
  let ref;

  it('reports which destinations are live', async () => {
    const stats = await admin('/api/admin/stats').then((r) => r.json());
    assert.deepEqual(stats.notifications.enabled.sort(), ['email', 'sheet']);
  });

  it('accepts the application immediately, without waiting on delivery', async () => {
    const started = Date.now();
    const res = await apply(crmApplication());
    const body = await res.json();

    assert.equal(res.status, 201);
    ref = body.ref;
    // The candidate must not be held up by SMTP or Google.
    assert.ok(Date.now() - started < 4000, 'submission should return promptly');
  });

  it('emails the application to every configured recipient', async () => {
    await waitFor(() => smtp.messages.length >= 1, { label: 'the email to be delivered' });

    const message = smtp.message;
    // Readable, not RFC 2047 base64 — the subject is deliberately ASCII.
    assert.match(message, /^Subject: \[CRM\] Ananya Sharma - 4\.5 yrs, Sector 45, Gurugram \(RR-CRM-/m);
    assert.ok(!/^Subject: =\?UTF-8\?B\?/m.test(message), 'an ASCII name should not force encoding');
    assert.match(message, /^To: hiring@rocketrecruiters\.example, partner@rocketrecruiters\.example$/m);
    assert.match(message, /^Reply-To: ananya@example\.com$/m);
    assert.match(message, /^From: Rocket Recruiters <portal@example\.com>$/m);

    // Both recipients in the SMTP envelope, not just the header.
    assert.ok(smtp.log.includes('RCPT TO:<hiring@rocketrecruiters.example>'));
    assert.ok(smtp.log.includes('RCPT TO:<partner@rocketrecruiters.example>'));

    // Body is base64; decode it to confirm the content and dashboard link.
    const decoded = Buffer.from(
      message.split('\n').filter((l) => /^[A-Za-z0-9+/=]{20,}$/.test(l)).join(''),
      'base64',
    ).toString('utf8');
    assert.match(decoded, /Ananya Sharma/);
    assert.match(decoded, /https:\/\/careers\.example\.com\/admin/);
  });

  it('authenticates to the mail server before sending', () => {
    assert.ok(smtp.log.some((l) => l.startsWith('AUTH')), 'expected an AUTH command');
    assert.ok(!smtp.log.some((l) => l.includes('app-password')), 'the password must never appear in clear');
  });

  it('retries the Google Sheet after a transient failure and lands the row', async () => {
    // The fake sheet rejected the first attempt with a 500.
    await waitFor(() => sheet.rows.length >= 1, { timeoutMs: 15_000, label: 'the sheet row after retry' });

    const payload = sheet.rows[0];
    assert.equal(payload.secret, 'sheet-secret', 'the shared secret must be sent');
    assert.equal(payload.row.name, 'Ananya Sharma');
    assert.equal(payload.row.track, 'CRM & Retention');
    assert.equal(payload.row.onsite, 'I live in Gurugram — short commute');
    assert.equal(payload.row.reference, ref);
    assert.match(payload.row.roleAnswers, /Klaviyo/);
  });

  it('records the outcome of every delivery against the application', async () => {
    const { rows } = await admin('/api/admin/applications').then((r) => r.json());
    const app = await admin(`/api/admin/applications/${rows[0].id}`).then((r) => r.json());

    const byName = Object.fromEntries(app.deliveries.map((d) => [d.sink, d]));
    assert.ok(byName.email, 'email delivery should be tracked');
    assert.ok(byName.sheet, 'sheet delivery should be tracked');
    assert.equal(byName.email.status, 'sent');
    assert.equal(byName.sheet.status, 'sent');
    assert.ok(byName.sheet.attempts >= 2, 'the sheet took a retry, which should be visible');
  });

  it('surfaces delivery health for the dashboard', async () => {
    const stats = await admin('/api/admin/stats').then((r) => r.json());
    const sent = stats.notifications.health.filter((h) => h.status === 'sent');
    assert.ok(sent.length >= 2, 'expected sent counts per destination');
  });

  it('a knocked-out candidate is never sent anywhere', async () => {
    const before = smtp.messages.length;
    const res = await apply(
      crmApplication({ email: 'remote@example.com', onsiteCommitment: 'I need remote or hybrid work' }),
    );
    assert.equal(res.status, 422);

    await new Promise((r) => setTimeout(r, 600));
    assert.equal(smtp.messages.length, before, 'no email should be sent for a rejected candidate');
  });

  it('keeps delivering when a later application arrives', async () => {
    const before = smtp.messages.length;
    const res = await apply(designerApplication({ email: 'designer@example.com' }));
    assert.equal(res.status, 201);

    await waitFor(() => smtp.messages.length > before, { label: 'the second email' });
    assert.match(smtp.message, /^Subject: \[GDS\]/m);
  });
});

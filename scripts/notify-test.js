/**
 * Checks your notification setup without touching the portal or creating a
 * fake candidate.
 *
 *   npm run notify:test
 *
 * Sends one real email to MAIL_TO and posts one clearly-marked test row to
 * your Sheet, then reports exactly what worked. Diagnoses the common failures
 * (wrong app password, 2FA not enabled, Apps Script not deployed) rather than
 * dumping a stack trace.
 */

import { composeEmail, config, enabledSinks, sheetRow } from '../src/notify.js';
import { sendMail } from '../src/smtp.js';

const sample = {
  ref: 'RR-TEST-000000',
  category: 'crm',
  brand: 'Hack Daily',
  status: 'new',
  created_at: new Date().toISOString(),
  cv_original_name: 'sample-cv.pdf',
  cv_size: 148_000,
  answers: {
    fullName: 'TEST — please ignore',
    email: 'test-candidate@example.com',
    phone: '+91 90000 00000',
    city: 'Sector 45, Gurugram',
    onsiteCommitment: 'I live in Gurugram — short commute',
    experienceYears: 4,
    currentCompany: 'Example Co',
    currentRole: 'CRM Manager',
    noticePeriod: '30 days',
    expectedCtc: '16 LPA',
    source: 'LinkedIn',
    crmTools: ['Klaviyo'],
    crmChannels: ['WhatsApp'],
    crmMetrics: ['Repeat purchase rate'],
    crmD2c: 'Yes — Shopify',
    crmBaseSize: '10k – 50k',
    crmWin: 'This is a configuration test, not a real application.',
    pitch: 'This is a configuration test, not a real application.',
  },
};

/** Turns a raw SMTP/network failure into something actionable. */
function explain(err) {
  const message = err.message || String(err);

  if (/Username and Password not accepted|BadCredentials|535/i.test(message)) {
    return [
      'The mail server rejected your username or password.',
      '  • Gmail needs an APP PASSWORD, not your account password.',
      '  • App passwords only exist once 2-Step Verification is on.',
      '  • Paste the 16 characters with no spaces.',
    ].join('\n');
  }
  if (/cannot reach/i.test(message)) {
    return 'Could not reach the mail server. Check SMTP_HOST and SMTP_PORT (465 for TLS, 587 for STARTTLS), and that outbound SMTP is not blocked on your network.';
  }
  if (/refusing to send credentials/i.test(message)) {
    return 'That host offers no encryption, so the password was not sent. Use port 465, or 587 if the server supports STARTTLS.';
  }
  if (/timed out/i.test(message)) {
    return 'The mail server stopped responding. Some networks block port 465 — try 587.';
  }
  if (/5\.7\.\d+|not authenticated/i.test(message)) {
    return 'Authentication was required but rejected. Confirm SMTP_USER is the full email address.';
  }
  return message;
}

async function checkEmail() {
  if (!config.email.enabled) {
    console.log('email    SKIPPED  — set SMTP_HOST and MAIL_TO in .env to enable');
    return null;
  }

  console.log(`email    sending to ${config.email.to.join(', ')} via ${config.email.host}:${config.email.port} …`);

  const { subject, text, html } = composeEmail(sample, { dashboardUrl: 'http://127.0.0.1:4173/admin' });

  try {
    await sendMail(
      { host: config.email.host, port: config.email.port, user: config.email.user, pass: config.email.pass },
      {
        from: config.email.from,
        to: config.email.to,
        replyTo: sample.answers.email,
        subject: `[TEST] ${subject}`,
        text: `This is a test of your Rocket Recruiters notification setup.\nNo candidate has applied.\n\n${text}`,
        html,
      },
    );
    console.log('email    OK       — check your inbox (subject starts with [TEST])');
    return true;
  } catch (err) {
    console.log('email    FAILED');
    console.log(
      explain(err)
        .split('\n')
        .map((l) => `         ${l}`)
        .join('\n'),
    );
    return false;
  }
}

async function checkSheet() {
  if (!config.sheet.enabled) {
    console.log('sheet    SKIPPED  — set SHEETS_WEBHOOK_URL in .env to enable');
    return null;
  }

  console.log(`sheet    posting a test row to ${config.sheet.url.slice(0, 60)}… `);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(config.sheet.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: config.sheet.secret, row: sheetRow(sample) }),
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);

    const body = await res.text();

    if (!res.ok) {
      console.log(`sheet    FAILED   — HTTP ${res.status}`);
      console.log('         Check the deployment is a Web app with access set to "Anyone".');
      return false;
    }
    if (/bad secret/i.test(body)) {
      console.log('sheet    FAILED   — the script rejected the shared secret');
      console.log('         SHEETS_SHARED_SECRET must match SHARED_SECRET inside Code.gs exactly.');
      return false;
    }
    if (/<html|Google Drive|Sign in/i.test(body)) {
      console.log('sheet    FAILED   — Google returned a sign-in page, not your script');
      console.log('         Re-deploy with "Who has access: Anyone" and use the /exec URL (not /dev).');
      return false;
    }

    console.log('sheet    OK       — a row named "TEST — please ignore" should be in your Sheet');
    return true;
  } catch (err) {
    console.log(`sheet    FAILED   — ${err.name === 'AbortError' ? 'timed out after 15s' : err.message}`);
    return false;
  }
}

console.log('');
console.log('Checking notification setup');
console.log(`Destinations enabled: ${enabledSinks().join(', ') || 'none'}`);
console.log('');

const results = [await checkEmail(), await checkSheet()];
const failed = results.filter((r) => r === false).length;
const passed = results.filter((r) => r === true).length;

console.log('');
if (!passed && !failed) {
  console.log('Nothing was configured. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
console.log(failed ? `${passed} working, ${failed} failing — see above.` : `All ${passed} destination(s) working.`);
console.log('');
process.exit(failed ? 1 : 0);

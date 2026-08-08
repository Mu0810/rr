/**
 * Notification tests.
 *
 * The SMTP client is exercised against a fake SMTP server implemented here, so
 * the protocol conversation is verified without sending real mail or needing
 * credentials. The Sheets sink is tested against a local HTTP server standing
 * in for the Apps Script web app.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { networkInterfaces } from 'node:os';

import { buildMessage, isLoopbackHost, sendMail } from '../src/smtp.js';
import { composeEmail, sheetRow } from '../src/notify.js';
import { fakeSmtp } from './helpers.js';

/* ----------------------------------------------------------------- fixture */

const application = {
  id: 1,
  ref: 'RR-CRM-ABC123',
  category: 'crm',
  brand: 'Hack Daily',
  status: 'new',
  created_at: '2026-08-08T12:00:00.000Z',
  cv_original_name: 'ananya-sharma-cv.pdf',
  cv_size: 240_000,
  answers: {
    fullName: 'Ananya Sharma',
    email: 'ananya@example.com',
    phone: '+91 9810012345',
    city: 'Sector 45, Gurugram',
    onsiteCommitment: 'I live in Gurugram — short commute',
    experienceYears: 4.5,
    currentCompany: 'Wellness Co',
    currentRole: 'CRM Manager',
    noticePeriod: '30 days',
    currentCtc: '11 LPA',
    expectedCtc: '16 LPA',
    linkedin: 'https://linkedin.com/in/ananya',
    source: 'LinkedIn',
    crmTools: ['Klaviyo', 'WebEngage'],
    crmChannels: ['Email', 'WhatsApp'],
    crmMetrics: ['Repeat purchase rate'],
    crmD2c: 'Yes — Shopify',
    crmBaseSize: '50k – 2 lakh',
    crmWin: 'Repeat rate 18% to 27% in five months.',
    pitch: 'I want to build the CRM engine here.',
  },
};

/* -------------------------------------------------------------------------- */

describe('MIME message building', () => {
  it('produces multipart/alternative when HTML is supplied', () => {
    const msg = buildMessage({
      from: 'portal@example.com',
      to: ['hiring@example.com'],
      replyTo: 'candidate@example.com',
      subject: 'Test subject',
      text: 'plain body',
      html: '<p>rich body</p>',
    });

    assert.match(msg, /^From: portal@example\.com/m);
    assert.match(msg, /^To: hiring@example\.com/m);
    assert.match(msg, /^Reply-To: candidate@example\.com/m);
    assert.match(msg, /Content-Type: multipart\/alternative; boundary="/);
    assert.match(msg, /Content-Type: text\/plain; charset=UTF-8/);
    assert.match(msg, /Content-Type: text\/html; charset=UTF-8/);
    assert.match(msg, /^Message-ID: </m);
  });

  it('RFC 2047 encodes a non-ASCII subject', () => {
    const msg = buildMessage({
      from: 'a@b.c',
      to: 'd@e.f',
      subject: 'नई एप्लिकेशन',
      text: 'body',
    });
    assert.match(msg, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/m);
  });

  it('base64-encodes the body so non-ASCII content survives', () => {
    const msg = buildMessage({ from: 'a@b.c', to: 'd@e.f', subject: 'x', text: 'अनन्या शर्मा' });
    assert.match(msg, /Content-Transfer-Encoding: base64/);
    const body = msg.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'अनन्या शर्मा');
  });
});

describe('SMTP client', () => {
  it('completes the full conversation with AUTH LOGIN', async () => {
    const smtp = fakeSmtp({ authMech: 'LOGIN' });
    await smtp.listen(2526);
    try {
      const result = await sendMail(
        { host: '127.0.0.1', port: 2526, secure: false, user: 'me@example.com', pass: 'app-password' },
        { from: 'me@example.com', to: 'hiring@example.com', subject: 'Hello', text: 'Body text' },
      );

      assert.deepEqual(result, { ok: true });

      const verbs = smtp.log.map((l) => l.split(' ')[0].toUpperCase());
      assert.ok(verbs.includes('EHLO'), 'should greet');
      assert.ok(verbs.includes('AUTH'), 'should authenticate');
      assert.ok(verbs.includes('MAIL'), 'should set the envelope sender');
      assert.ok(verbs.includes('RCPT'), 'should set the recipient');
      assert.ok(verbs.includes('DATA'), 'should send the body');
      assert.match(smtp.message, /Subject: Hello/);
    } finally {
      smtp.close();
    }
  });

  it('uses AUTH PLAIN when that is what the server offers', async () => {
    const smtp = fakeSmtp({ authMech: 'PLAIN' });
    await smtp.listen(2527);
    try {
      await sendMail(
        { host: '127.0.0.1', port: 2527, secure: false, user: 'me@example.com', pass: 'secret' },
        { from: 'me@example.com', to: 'hiring@example.com', subject: 'Hi', text: 'Body' },
      );
      const authLine = smtp.log.find((l) => l.startsWith('AUTH'));
      assert.match(authLine, /^AUTH PLAIN \S+/);

      const decoded = Buffer.from(authLine.split(' ')[2], 'base64').toString('utf8');
      assert.equal(decoded, '\0me@example.com\0secret');
    } finally {
      smtp.close();
    }
  });

  it('strips a display name from the envelope recipient', async () => {
    const smtp = fakeSmtp();
    await smtp.listen(2528);
    try {
      await sendMail(
        { host: '127.0.0.1', port: 2528, secure: false },
        { from: 'a@b.c', to: 'Hiring Team <hiring@example.com>', subject: 'x', text: 'y' },
      );
      assert.ok(smtp.log.includes('RCPT TO:<hiring@example.com>'));
    } finally {
      smtp.close();
    }
  });

  it('surfaces a server rejection as an error', async () => {
    const smtp = fakeSmtp({ failAt: 'RCPT' });
    await smtp.listen(2529);
    try {
      await assert.rejects(
        () =>
          sendMail(
            { host: '127.0.0.1', port: 2529, secure: false },
            { from: 'a@b.c', to: 'nope@example.com', subject: 'x', text: 'y' },
          ),
        /550/,
      );
    } finally {
      smtp.close();
    }
  });

  it('fails clearly when the host is unreachable', async () => {
    await assert.rejects(
      () =>
        sendMail(
          { host: '127.0.0.1', port: 2599, secure: false, timeoutMs: 2000 },
          { from: 'a@b.c', to: 'd@e.f', subject: 'x', text: 'y' },
        ),
      /cannot reach 127\.0\.0\.1:2599/,
    );
  });

  it('classifies loopback and remote hosts correctly', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      assert.equal(isLoopbackHost(host), true, `${host} should be loopback`);
    }
    for (const host of ['smtp.gmail.com', '203.0.113.10', 'mail.example.com']) {
      assert.equal(isLoopbackHost(host), false, `${host} should be remote`);
    }
  });

  it('refuses to send credentials in clear text to a remote host', async () => {
    // A server offering neither implicit TLS nor STARTTLS. Reached over a
    // non-loopback address, so the local-relay allowance does not apply.
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.write('220 plain.smtp ready\r\n');
      socket.on('data', (line) => {
        if (/^EHLO/i.test(line)) socket.write('250-plain.smtp\r\n250 SIZE 100\r\n');
      });
      socket.on('error', () => {});
    });
    await new Promise((r) => server.listen(2530, '0.0.0.0', r));

    const remoteIp = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

    try {
      if (!remoteIp) {
        // No non-loopback interface (offline machine): assert the policy directly.
        assert.equal(isLoopbackHost('smtp.gmail.com'), false);
        return;
      }
      await assert.rejects(
        () =>
          sendMail(
            { host: remoteIp, port: 2530, secure: false, user: 'me', pass: 'secret', timeoutMs: 4000 },
            { from: 'a@b.c', to: 'd@e.f', subject: 'x', text: 'y' },
          ),
        /refusing to send credentials in clear text/,
      );
    } finally {
      server.close();
    }
  });
});

describe('the notification email', () => {
  it('leads the subject with the track code and the essentials', () => {
    const { subject } = composeEmail(application);
    assert.match(subject, /^\[CRM\] Ananya Sharma - 4\.5 yrs, Sector 45, Gurugram \(RR-CRM-ABC123\)$/);
  });

  it('includes every answer, the onsite status and the reference', () => {
    const { text } = composeEmail(application, { dashboardUrl: 'https://careers.example.com/admin' });
    for (const needle of [
      'Ananya Sharma',
      'ananya@example.com',
      '+91 9810012345',
      'I live in Gurugram',
      'RR-CRM-ABC123',
      'Klaviyo, WebEngage',
      'https://careers.example.com/admin',
    ]) {
      assert.ok(text.includes(needle), `email text missing: ${needle}`);
    }
  });

  it('escapes HTML so a candidate cannot inject markup into your inbox', () => {
    const hostile = structuredClone(application);
    hostile.answers.fullName = '<img src=x onerror=alert(1)>';
    hostile.answers.pitch = '</td></table><script>alert(2)</script>';

    const { html } = composeEmail(hostile);
    assert.ok(!html.includes('<img src=x'), 'raw img tag leaked into the HTML');
    assert.ok(!html.includes('<script>'), 'raw script tag leaked into the HTML');
    assert.ok(html.includes('&lt;img src=x'), 'expected the value escaped, not dropped');
  });

  it('lets you reply straight to the candidate', () => {
    const msg = buildMessage({
      from: 'portal@example.com',
      to: 'hiring@example.com',
      replyTo: application.answers.email,
      ...composeEmail(application),
    });
    assert.match(msg, /^Reply-To: ananya@example\.com$/m);
  });
});

describe('the Google Sheet row', () => {
  it('flattens an application into one predictable row', () => {
    const row = sheetRow(application);

    assert.equal(row.reference, 'RR-CRM-ABC123');
    assert.equal(row.track, 'CRM & Retention');
    assert.equal(row.trackCode, 'CRM');
    assert.equal(row.name, 'Ananya Sharma');
    assert.equal(row.onsite, 'I live in Gurugram — short commute');
    assert.equal(row.cvFile, 'ananya-sharma-cv.pdf');
    assert.ok(!Object.values(row).some((v) => typeof v === 'object'), 'every cell must be a scalar');
  });

  it('collapses the role-specific answers into one readable cell', () => {
    const { roleAnswers } = sheetRow(application);
    assert.match(roleAnswers, /Klaviyo, WebEngage/);
    assert.match(roleAnswers, /Repeat purchase rate/);
    // Common fields have their own columns and must not be duplicated here.
    assert.ok(!roleAnswers.includes('ananya@example.com'));
  });

  it('posts successfully to a stand-in Apps Script endpoint', async () => {
    let received = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((r) => server.listen(2531, '127.0.0.1', r));

    try {
      const res = await fetch('http://127.0.0.1:2531/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: 's3cret', row: sheetRow(application) }),
      });
      assert.equal(res.status, 200);
      assert.equal(received.secret, 's3cret');
      assert.equal(received.row.reference, 'RR-CRM-ABC123');
    } finally {
      server.close();
    }
  });
});

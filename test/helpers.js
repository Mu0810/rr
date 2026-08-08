/**
 * Shared test plumbing. Each suite boots its own throwaway server against a
 * temp database and upload dir, so no test touches real candidate data.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVER = resolve(import.meta.dirname, '../src/server.js');

export const TEST_PASSWORD = 'test-password-do-not-ship';

/**
 * Boots a server on `port` with an isolated sandbox.
 * @returns {Promise<{ base: string, sandbox: string, stop: () => void }>}
 */
export async function startServer(port, env = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'rr-test-'));
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      ADMIN_PASSWORD: TEST_PASSWORD,
      DB_PATH: join(sandbox, 'test.db'),
      UPLOAD_DIR: join(sandbox, 'uploads'),
      INSTANCE_PATH: join(sandbox, 'instance.json'),
      NOTIFY_WEBHOOK_URL: '',
      // Suites share one IP, so limits are relaxed by default and exercised
      // explicitly in the rate-limit suite.
      RATE_LIMIT_SUBMISSIONS: '50',
      RATE_LIMIT_ATTEMPTS: '500',
      RATE_LIMIT_LOGINS: '50',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const deadline = Date.now() + 12_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/schema`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`server on ${port} did not start within 12s`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return {
    base,
    sandbox,
    stop() {
      child.kill('SIGTERM');
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

/** A minimal but structurally valid PDF, so the magic-byte sniffer accepts it. */
export function pdfBlob(name = 'cv.pdf') {
  const bytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  return { blob: new Blob([bytes], { type: 'application/pdf' }), name };
}

/** A .pdf in name only — used to prove the content sniffer works. */
export function textBlob(name = 'cv.pdf') {
  return { blob: new Blob([Buffer.from('this is plainly not a pdf')], { type: 'application/pdf' }), name };
}

/**
 * A fake SMTP server that speaks just enough of the protocol to satisfy the
 * client, recording the conversation and the delivered message.
 *
 * @param {{ authMech?: 'PLAIN'|'LOGIN', failAt?: string }} behaviour
 */
export function fakeSmtp(behaviour = {}) {
  const { authMech = 'LOGIN', failAt = null } = behaviour;
  const log = [];
  const messages = [];
  let captured = '';

  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    let authStep = 0; // per-connection: AUTH LOGIN is a two-challenge exchange
    socket.setEncoding('utf8');
    socket.write('220 fake.smtp ESMTP ready\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk;

      for (;;) {
        const idx = buffer.indexOf('\r\n');
        if (idx === -1) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(captured);
            captured = '';
            socket.write('250 2.0.0 queued as FAKE123\r\n');
          } else {
            captured += line + '\n';
          }
          continue;
        }

        log.push(line);
        const verb = line.split(' ')[0].toUpperCase();

        if (failAt && verb === failAt) {
          socket.write('550 5.0.0 rejected by test\r\n');
          continue;
        }

        switch (verb) {
          case 'EHLO':
            socket.write('250-fake.smtp greets you\r\n');
            socket.write(`250-AUTH ${authMech}\r\n`);
            socket.write('250 SIZE 10485760\r\n');
            break;
          case 'AUTH':
            if (/PLAIN\s+\S/.test(line)) socket.write('235 2.7.0 accepted\r\n');
            else {
              authStep = 1;
              socket.write('334 VXNlcm5hbWU6\r\n');
            }
            break;
          case 'MAIL':
          case 'RCPT':
            socket.write('250 2.1.0 ok\r\n');
            break;
          case 'DATA':
            inData = true;
            socket.write('354 end with <CRLF>.<CRLF>\r\n');
            break;
          case 'QUIT':
            socket.write('221 2.0.0 bye\r\n');
            socket.end();
            break;
          default:
            // Base64 lines are AUTH LOGIN challenge responses. Stepping per
            // connection, not per server, so a second delivery authenticates too.
            if (authStep > 0 && /^[A-Za-z0-9+/=]*$/.test(line)) {
              if (authStep === 1) {
                authStep = 2;
                socket.write('334 UGFzc3dvcmQ6\r\n');
              } else {
                authStep = 0;
                socket.write('235 2.7.0 accepted\r\n');
              }
            } else {
              socket.write('500 5.5.1 unknown\r\n');
            }
        }
      }
    });

    socket.on('error', () => {});
  });

  return {
    listen(port) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    },
    close() {
      server.close();
    },
    get log() {
      return log;
    },
    get messages() {
      return messages;
    },
    get message() {
      return messages[messages.length - 1] || '';
    },
  };
}

/**
 * A stand-in for the Google Apps Script web app, recording what it receives.
 *
 * `respondWith` mimics Apps Script's behaviour of answering HTTP 200 even when
 * it rejected the request — set it to simulate a bad secret or a sign-in page.
 */
export function fakeSheet({ failTimes = 0, respondWith = null } = {}) {
  const rows = [];
  let failuresLeft = failTimes;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('temporary failure');
      }
      if (respondWith) {
        // Always 200, like the real Apps Script.
        res.writeHead(200, { 'content-type': respondWith.contentType || 'application/json' });
        return res.end(respondWith.body);
      }
      try {
        rows.push(JSON.parse(body));
      } catch {
        /* ignore malformed */
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  return {
    listen(port) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    },
    close() {
      server.close();
    },
    get rows() {
      return rows;
    },
  };
}

/** Polls until `predicate` is true, or throws after `timeoutMs`. */
export async function waitFor(predicate, { timeoutMs = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** A complete, valid CRM application. Tests override individual fields. */
export function crmApplication(overrides = {}) {
  const base = {
    category: 'crm',
    fullName: 'Ananya Sharma',
    email: 'ananya@example.com',
    phone: '+91 9810012345',
    city: 'Sector 45, Gurugram',
    onsiteCommitment: 'I live in Gurugram — short commute',
    experienceYears: '4.5',
    currentCompany: 'Wellness Co',
    currentRole: 'CRM Manager',
    noticePeriod: '30 days',
    currentCtc: '11 LPA',
    expectedCtc: '16 LPA',
    linkedin: 'https://linkedin.com/in/ananya',
    source: 'LinkedIn',
    crmD2c: 'Yes — Shopify',
    crmBaseSize: '50k – 2 lakh',
    crmWin: 'Took repeat rate from 18% to 27% in five months by rebuilding the day-7 to day-21 WhatsApp flow.',
    pitch: 'I have owned retention for two Shopify wellness brands in India and want to build the CRM engine at Hack Daily from the ground up.',
    consent: 'yes',
    form_elapsed_ms: '95000',
  };

  const form = new FormData();
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value === undefined || key.startsWith('__')) continue;
    form.set(key, String(value));
  }
  for (const [key, values] of Object.entries({
    'crmTools[]': ['Klaviyo', 'WebEngage'],
    'crmChannels[]': ['Email', 'WhatsApp'],
    'crmMetrics[]': ['Repeat purchase rate', 'Customer LTV'],
  })) {
    for (const value of values) form.append(key, value);
  }

  const cv = overrides.__cv === null ? null : overrides.__cv || pdfBlob();
  if (cv) form.set('cv', cv.blob, cv.name);
  return form;
}

/** A complete, valid design application — the track with a required portfolio. */
export function designerApplication(overrides = {}) {
  const base = {
    category: 'graphic-designer',
    fullName: 'Ananya Sharma',
    email: 'ananya@example.com',
    phone: '+91 9810012345',
    city: 'Sector 45, Gurugram',
    onsiteCommitment: 'I live in Gurugram — short commute',
    experienceYears: '4.5',
    noticePeriod: '30 days',
    expectedCtc: '16 LPA',
    source: 'Instagram',
    gdsPortfolio: 'https://behance.net/ananya',
    gdsMotion: 'Basic',
    gdsOutput: '10 – 25 assets',
    gdsPackaging: 'Once or twice',
    pitch: 'I design packaging and performance creative for wellness brands and want to own the Hack Daily visual system.',
    consent: 'yes',
    form_elapsed_ms: '80000',
  };

  const form = new FormData();
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value === undefined || key.startsWith('__')) continue;
    form.set(key, String(value));
  }
  form.append('gdsTools[]', 'Figma');
  form.append('gdsTools[]', 'Adobe Illustrator');
  form.append('gdsSpecialties[]', 'Packaging & label design');

  const cv = overrides.__cv === null ? null : overrides.__cv || pdfBlob();
  if (cv) form.set('cv', cv.blob, cv.name);
  return form;
}

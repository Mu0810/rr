/**
 * Google Sheet failure modes.
 *
 * Apps Script always answers HTTP 200, carrying the real outcome in the body.
 * A naive `res.ok` check therefore records a rejected write as a successful
 * delivery — the application looks delivered while the Sheet stays empty.
 * These tests pin the behaviour that catches it.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TEST_PASSWORD, crmApplication, fakeSheet, startServer, waitFor } from './helpers.js';

/** Boots a portal whose Sheet endpoint answers 200 with the given body. */
async function withSheetResponse(port, sheetPort, respondWith, run) {
  const sheet = fakeSheet({ respondWith });
  await sheet.listen(sheetPort);

  const server = await startServer(port, {
    SHEETS_WEBHOOK_URL: `http://127.0.0.1:${sheetPort}/exec`,
    SHEETS_SHARED_SECRET: 'whatever',
    DELIVERY_BACKOFF_MS: '150',
    DELIVERY_WORKER_MS: '300',
  });

  const login = await fetch(`${server.base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: TEST_PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  try {
    await run({ server, cookie });
  } finally {
    server.stop();
    sheet.close();
  }
}

/** Waits for the delivery record of the first application, then returns it. */
async function sheetDelivery(server, cookie) {
  const admin = (path) => fetch(`${server.base}${path}`, { headers: { cookie } }).then((r) => r.json());
  const { rows } = await admin('/api/admin/applications');
  assert.ok(rows.length, 'the application should be stored regardless of delivery');

  let record;
  await waitFor(
    async () => {
      const app = await admin(`/api/admin/applications/${rows[0].id}`);
      record = app.deliveries.find((d) => d.sink === 'sheet');
      return record && record.attempts > 0;
    },
    { label: 'the sheet delivery to be attempted' },
  );
  return record;
}

describe('a Sheet script that rejects the shared secret', () => {
  it('is recorded as a failure, not a successful delivery', async () => {
    await withSheetResponse(
      4195,
      2581,
      { body: JSON.stringify({ status: 401, error: 'bad secret' }) },
      async ({ server, cookie }) => {
        const res = await fetch(`${server.base}/api/apply`, { method: 'POST', body: crmApplication() });
        assert.equal(res.status, 201, 'the candidate must still be accepted');

        const record = await sheetDelivery(server, cookie);
        assert.notEqual(record.status, 'sent', 'a rejected write must never be marked sent');
        assert.match(record.last_error, /shared secret/i, 'the cause should be plain in the dashboard');
      },
    );
  });
});

describe('a web app that was never deployed for public access', () => {
  it('reports the sign-in page rather than claiming success', async () => {
    await withSheetResponse(
      4194,
      2582,
      { body: '<html><head><title>Sign in - Google Accounts</title></head></html>', contentType: 'text/html' },
      async ({ server, cookie }) => {
        const res = await fetch(`${server.base}/api/apply`, { method: 'POST', body: crmApplication() });
        assert.equal(res.status, 201);

        const record = await sheetDelivery(server, cookie);
        assert.notEqual(record.status, 'sent');
        assert.match(record.last_error, /sign-in page|Anyone/i);
      },
    );
  });
});

describe('a Sheet script returning something unexpected', () => {
  it('does not treat an unparseable reply as a write', async () => {
    await withSheetResponse(4193, 2583, { body: 'Exception: Script function not found: doPost', contentType: 'text/plain' }, async ({ server, cookie }) => {
      const res = await fetch(`${server.base}/api/apply`, { method: 'POST', body: crmApplication() });
      assert.equal(res.status, 201);

      const record = await sheetDelivery(server, cookie);
      assert.notEqual(record.status, 'sent');
      assert.match(record.last_error, /unexpected response/i);
    });
  });
});

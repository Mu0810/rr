/**
 * Rate limiting. Runs against its own server with a deliberately tight
 * submission cap.
 *
 * The behaviour under test is a fix for a real bug: the limiter originally
 * counted every request, so a candidate who tripped validation a few times
 * was locked out of applying for an hour.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { crmApplication, designerApplication, startServer } from './helpers.js';

let server;

const apply = (form) => fetch(`${server.base}/api/apply`, { method: 'POST', body: form });

before(async () => {
  server = await startServer(4198, {
    RATE_LIMIT_SUBMISSIONS: '1', // one stored application per hour
    RATE_LIMIT_ATTEMPTS: '40',
    RATE_LIMIT_LOGINS: '2',
  });
});

after(() => server?.stop());

describe('rate limiting', () => {
  it('lets a candidate retry after validation failures without being locked out', async () => {
    // Five rejected attempts — none should consume the submission budget.
    for (let i = 0; i < 5; i += 1) {
      const res = await apply(crmApplication({ email: `broken${i}@example.com`, expectedCtc: '' }));
      assert.equal(res.status, 400, `attempt ${i + 1} should be a validation error, not a throttle`);
    }

    // The genuine submission still goes through.
    const ok = await apply(crmApplication());
    assert.equal(ok.status, 201, 'a valid application must still be accepted after failed attempts');
  });

  it('throttles once the submission cap is reached', async () => {
    const res = await apply(designerApplication({ email: 'second@example.com' }));
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /give it an hour/i);
  });

  it('throttles repeated wrong-password attempts', async () => {
    const attempt = () =>
      fetch(`${server.base}/api/admin/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });

    assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 429, 'third attempt should be throttled');
  });
});

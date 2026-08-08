/**
 * End-to-end smoke tests: the candidate submission flow, validation, upload
 * safety, admin access control and the recruiter inbox.
 *
 *   npm test
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEST_PASSWORD,
  crmApplication,
  designerApplication,
  pdfBlob,
  startServer,
  textBlob,
} from './helpers.js';

let server;
let cookie = '';

const apply = (form) => fetch(`${server.base}/api/apply`, { method: 'POST', body: form });

const admin = (path, options = {}) =>
  fetch(`${server.base}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), cookie },
    redirect: 'manual',
  });

before(async () => {
  server = await startServer(4199);
});

after(() => server?.stop());

/* -------------------------------------------------------------------------- */

describe('public schema', () => {
  it('exposes all five hiring tracks and their questions', async () => {
    const schema = await fetch(`${server.base}/api/schema`).then((r) => r.json());
    const ids = schema.categories.map((c) => c.id);

    assert.deepEqual(ids, ['crm', 'offline-marketing', 'brand-manager', 'graphic-designer', 'leadership']);
    assert.ok(schema.commonFields.length >= 12, 'expected the common field set');
    assert.equal(schema.cvRules.maxMb, 5);

    for (const cat of schema.categories) {
      assert.ok(cat.fields.length >= 5, `${cat.id} should ask role-specific questions`);
      assert.ok(cat.title && cat.roleLine && cat.blurb, `${cat.id} missing display copy`);
    }
  });

  it('never leaks the password hash or session secret', async () => {
    const body = await fetch(`${server.base}/api/schema`).then((r) => r.text());
    assert.ok(!/passwordHash|sessionSecret|passwordSalt/i.test(body));
  });
});

describe('submitting an application', () => {
  it('rejects a submission that is missing required fields', async () => {
    const form = new FormData();
    form.set('category', 'crm');
    form.set('fullName', 'Incomplete Person');
    form.set('cv', pdfBlob().blob, 'cv.pdf');

    const res = await apply(form);
    const body = await res.json();

    assert.equal(res.status, 400);
    assert.ok(Object.keys(body.errors).length >= 8, 'expected per-field errors');
    assert.ok(body.errors.email, 'email should be flagged');
    assert.ok(body.errors.consent, 'consent should be flagged');
  });

  it('rejects an unknown job category', async () => {
    const res = await apply(crmApplication({ category: 'ceo-of-everything' }));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors.category);
  });

  it('rejects a select value that is not one of the offered options', async () => {
    const res = await apply(crmApplication({ noticePeriod: '400 years' }));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors.noticePeriod);
  });

  it('rejects a multiselect value that was never offered', async () => {
    const form = crmApplication();
    form.append('crmTools[]', 'Definitely Not A Real Tool');
    const res = await apply(form);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors.crmTools);
  });

  it('rejects a file that is only pretending to be a PDF', async () => {
    const res = await apply(crmApplication({ email: 'faker@example.com', __cv: textBlob() }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).errors.cv, /not a valid PDF/i);
  });

  it('rejects a disallowed file type', async () => {
    const res = await apply(
      crmApplication({
        email: 'exe@example.com',
        __cv: { blob: new Blob([Buffer.from('MZ binary')], { type: 'application/octet-stream' }), name: 'cv.exe' },
      }),
    );
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors.cv);
  });

  it('rejects a submission with no CV attached', async () => {
    const res = await apply(crmApplication({ email: 'nocv@example.com', __cv: null }));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors.cv);
  });

  it('rejects a bot that filled the honeypot', async () => {
    const res = await apply(crmApplication({ email: 'bot@example.com', company_website: 'https://spam.example' }));
    assert.equal(res.status, 400);
  });

  it('rejects a form completed impossibly fast', async () => {
    const res = await apply(crmApplication({ email: 'speedy@example.com', form_elapsed_ms: '900' }));
    assert.equal(res.status, 400);
  });

  it('rejects a submission without consent', async () => {
    const res = await apply(crmApplication({ email: 'noconsent@example.com', consent: 'no' }));
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors.consent);
  });

  it('accepts a complete application and returns a reference', async () => {
    const res = await apply(crmApplication());
    const body = await res.json();

    assert.equal(res.status, 201);
    assert.equal(body.ok, true);
    // Timestamp segment is base36, so the tail is [0-9A-Z], not just hex.
    assert.match(body.ref, /^RR-CRM-[0-9A-Z]{8,}$/);
  });

  it('blocks a repeat application to the same track within 24h', async () => {
    const res = await apply(crmApplication());
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /already applied/i);
  });

  it('allows the same person to apply to a different track', async () => {
    const res = await apply(designerApplication());
    assert.equal(res.status, 201);
    assert.match((await res.json()).ref, /^RR-GDS-/);
  });

  it('requires a portfolio link for the design track', async () => {
    const res = await apply(
      designerApplication({ email: 'noport@example.com', gdsPortfolio: undefined }),
    );
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors.gdsPortfolio);
  });

  it('rejects a portfolio link that is not http(s)', async () => {
    const res = await apply(
      designerApplication({ email: 'jsport@example.com', gdsPortfolio: 'javascript:alert(1)' }),
    );
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors.gdsPortfolio);
  });

  it('rejects a CV larger than the 5MB allowance', async () => {
    const res = await apply(
      crmApplication({
        email: 'huge@example.com',
        __cv: {
          blob: new Blob([Buffer.alloc(6 * 1024 * 1024, 0x41)], { type: 'application/pdf' }),
          name: 'huge.pdf',
        },
      }),
    );
    assert.ok([400, 413].includes(res.status), `expected 400 or 413, got ${res.status}`);
  });

  it('accepts a candidate whose name is not ASCII', async () => {
    const res = await apply(
      crmApplication({ fullName: 'अनन्या शर्मा', email: 'devanagari@example.com' }),
    );
    assert.equal(res.status, 201);
  });
});

describe('onsite-only requirement', () => {
  it('turns a remote-only candidate away without storing anything', async () => {
    const res = await apply(
      crmApplication({ email: 'remote-please@example.com', onsiteCommitment: 'I need remote or hybrid work' }),
    );
    const body = await res.json();

    assert.equal(res.status, 422);
    assert.equal(body.knockout, true);
    assert.match(body.error, /onsite at Udyog Vihar Phase 2, Sector 20, Gurugram/i);
    assert.match(body.error, /no remote or hybrid option/i);
    assert.match(body.error, /have not stored your details/i);

    // Proof nothing was written: the duplicate guard blocks a second
    // application to the same track from the same email, so a 201 here means
    // the knocked-out attempt was never stored.
    const retry = await apply(
      crmApplication({ email: 'remote-please@example.com', onsiteCommitment: 'I live in Gurugram — short commute' }),
    );
    assert.equal(retry.status, 201, 'the rejected attempt must not have been stored');
  });

  it('accepts a candidate already based onsite', async () => {
    const res = await apply(
      crmApplication({ email: 'local@example.com', onsiteCommitment: 'I live in Gurugram — short commute' }),
    );
    assert.equal(res.status, 201);
  });

  it('accepts a candidate commuting from elsewhere in the region', async () => {
    const res = await apply(
      crmApplication({
        email: 'commuter@example.com',
        city: 'Noida Sector 62',
        onsiteCommitment: 'I live elsewhere in Delhi NCR and can commute daily',
      }),
    );
    assert.equal(res.status, 201);
  });

  it('accepts a candidate willing to relocate', async () => {
    const res = await apply(
      designerApplication({
        email: 'relocating@example.com',
        onsiteCommitment: 'I am outside Delhi NCR and will relocate for this role',
      }),
    );
    assert.equal(res.status, 201);
  });

  it('rejects an onsite answer that is not one of the offered options', async () => {
    const res = await apply(
      crmApplication({ email: 'madeup@example.com', onsiteCommitment: 'I will teleport in' }),
    );
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors.onsiteCommitment);
  });

  it('advertises the requirement in the schema so the form can gate on it', async () => {
    const schema = await fetch(`${server.base}/api/schema`).then((r) => r.json());
    const field = schema.commonFields.find((f) => f.knockout);

    assert.ok(field, 'a knockout field must be exposed');
    assert.equal(field.name, 'onsiteCommitment');
    assert.equal(schema.brand.workMode, 'Fully onsite');
    assert.ok(schema.brand.office.address, 'the office address must be published');
    assert.ok(schema.brand.office.city, 'the office city must be published');
    assert.match(schema.brand.office.mapsUrl, /^https:\/\/www\.google\.com\/maps/);
  });
});

describe('admin access control', () => {
  it('refuses every admin route to an anonymous caller', async () => {
    for (const path of [
      '/api/admin/applications',
      '/api/admin/applications/1',
      '/api/admin/stats',
      '/api/admin/cv/1',
      '/api/admin/export.csv',
    ]) {
      const res = await fetch(`${server.base}${path}`);
      assert.equal(res.status, 401, `${path} should be 401`);
    }
  });

  it('refuses a wrong password', async () => {
    const res = await fetch(`${server.base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  });

  it('refuses a forged session cookie', async () => {
    const res = await fetch(`${server.base}/api/admin/applications`, {
      headers: { cookie: `rr_admin=${Date.now() + 999_999}.deadbeef` },
    });
    assert.equal(res.status, 401);
  });

  it('refuses an expired session cookie', async () => {
    const res = await fetch(`${server.base}/api/admin/applications`, {
      headers: { cookie: `rr_admin=${Date.now() - 1000}.whatever` },
    });
    assert.equal(res.status, 401);
  });

  it('issues an HttpOnly session cookie for the right password', async () => {
    const res = await fetch(`${server.base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD }),
    });
    const setCookie = res.headers.get('set-cookie');

    assert.equal(res.status, 200);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);

    cookie = setCookie.split(';')[0];
  });
});

describe('the recruiter inbox', () => {
  /** Resolve one application by searching, so tests do not depend on row order. */
  async function findByEmail(email, category) {
    const params = new URLSearchParams({ q: email });
    if (category) params.set('category', category);
    const { rows } = await admin(`/api/admin/applications?${params}`).then((r) => r.json());
    assert.ok(rows.length >= 1, `no application found for ${email} (${category || 'any track'})`);
    return rows[0];
  }

  it('lists the applications received', async () => {
    const { total, rows } = await admin('/api/admin/applications').then((r) => r.json());
    assert.equal(total, 7);
    assert.equal(rows.length, 7);
    assert.ok(rows.every((r) => r.ref && r.full_name && r.cv_stored_name));
  });

  it('filters by track', async () => {
    const crm = await admin('/api/admin/applications?category=crm').then((r) => r.json());
    const design = await admin('/api/admin/applications?category=graphic-designer').then((r) => r.json());
    assert.equal(crm.total, 5);
    assert.equal(design.total, 2);
  });

  it('searches by name, email and reference', async () => {
    for (const q of ['Ananya', 'ananya@example.com', 'RR-']) {
      const { total } = await admin(`/api/admin/applications?q=${encodeURIComponent(q)}`).then((r) => r.json());
      assert.ok(total >= 1, `search "${q}" found nothing`);
    }
  });

  it('returns the full answer set for one application', async () => {
    const row = await findByEmail('ananya@example.com', 'crm');
    const app = await admin(`/api/admin/applications/${row.id}`).then((r) => r.json());

    assert.equal(app.answers.fullName, 'Ananya Sharma');
    assert.deepEqual(app.answers.crmTools, ['Klaviyo', 'WebEngage']);
    assert.match(app.answers.crmWin, /repeat rate/i);
  });

  it('downloads the stored CV as an attachment', async () => {
    const row = await findByEmail('ananya@example.com', 'crm');
    const res = await admin(`/api/admin/cv/${row.id}`);
    const body = Buffer.from(await res.arrayBuffer());

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment/);
    assert.equal(body.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  it('downloads a CV for a candidate whose name is not ASCII', async () => {
    const row = await findByEmail('devanagari@example.com');
    const res = await admin(`/api/admin/cv/${row.id}`);
    const disposition = res.headers.get('content-disposition');

    assert.equal(res.status, 200, 'non-ASCII names must not break the download header');
    assert.match(disposition, /filename\*=UTF-8''/, 'expected an RFC 5987 encoded filename');
    assert.match(disposition, /filename="[\x20-\x7E]+"/, 'expected an ASCII-safe fallback');
  });

  it('moves a candidate along the pipeline and keeps notes', async () => {
    const row = await findByEmail('ananya@example.com', 'crm');

    const patch = await admin(`/api/admin/applications/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'shortlisted', recruiterNotes: 'Strong Klaviyo depth. Screening call Tuesday.' }),
    });
    assert.equal(patch.status, 200);

    const app = await admin(`/api/admin/applications/${row.id}`).then((r) => r.json());
    assert.equal(app.status, 'shortlisted');
    assert.match(app.recruiter_notes, /Screening call Tuesday/);
  });

  it('rejects an invented pipeline status', async () => {
    const row = await findByEmail('ananya@example.com', 'crm');
    const res = await admin(`/api/admin/applications/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'definitely-hired-already' }),
    });
    assert.equal(res.status, 400);
  });

  it('404s on an application that does not exist', async () => {
    const res = await admin('/api/admin/applications/999999');
    assert.equal(res.status, 404);
  });

  it('exports a CSV that Excel can open, with formulas neutralised', async () => {
    const res = await admin('/api/admin/export.csv');
    const bytes = Buffer.from(await res.arrayBuffer());
    const csv = bytes.toString('utf8');

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /\.csv"$/);
    // Asserted on raw bytes: fetch's text() decoder silently strips a BOM.
    assert.deepEqual(
      bytes.subarray(0, 3),
      Buffer.from([0xef, 0xbb, 0xbf]),
      'expected a UTF-8 BOM so Excel reads ₹ correctly',
    );
    assert.match(csv, /"ref","created_at","status"/);
    assert.match(csv, /Ananya Sharma/);
    assert.ok(!/^[=+@]/m.test(csv.replace(/^\uFEFF/, '')), 'no raw formula-leading cell');
  });

  it('reports counts by track and status', async () => {
    const stats = await admin('/api/admin/stats').then((r) => r.json());
    assert.equal(stats.total, 7);
    assert.equal(stats.last24h, 7);
    assert.ok(stats.byCategory.some((c) => c.category === 'crm'));
    assert.ok(stats.statuses.includes('shortlisted'));
  });

  it('signs out and stops honouring the session', async () => {
    const out = await admin('/api/admin/logout', { method: 'POST' });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  });
});

describe('static serving', () => {
  it('serves the candidate portal and the dashboard', async () => {
    for (const [path, needle] of [['/', 'Choose your track'], ['/admin', 'Applications']]) {
      const res = await fetch(`${server.base}${path}`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), new RegExp(needle));
    }
  });

  it('refuses to escape the public directory', async () => {
    for (const path of ['/../data/instance.json', '/..%2fsrc/server.js', '/../package.json']) {
      const res = await fetch(`${server.base}${path}`, { redirect: 'manual' });
      assert.ok(res.status >= 400, `${path} should not be served (got ${res.status})`);
    }
  });

  it('does not serve uploaded CVs from a public path', async () => {
    const res = await fetch(`${server.base}/uploads/RR-CRM-TEST.pdf`);
    assert.equal(res.status, 404);
  });
});

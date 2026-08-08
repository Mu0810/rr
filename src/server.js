/**
 * Rocket Recruiters — candidate application portal.
 *
 * Zero npm dependencies: node:http, node:sqlite and the built-in fetch/FormData
 * primitives do all the work. Run with `npm start`.
 *
 * Routes
 *   GET  /                        candidate portal
 *   GET  /admin                   recruiter dashboard (password protected)
 *   GET  /api/schema              form definition
 *   POST /api/apply               multipart submission + CV
 *   POST /api/admin/login         { password }
 *   POST /api/admin/logout
 *   GET  /api/admin/session
 *   GET  /api/admin/stats
 *   GET  /api/admin/applications  ?category=&status=&q=&limit=&offset=
 *   GET  /api/admin/applications/:id
 *   PATCH/api/admin/applications/:id  { status, recruiterNotes }
 *   GET  /api/admin/cv/:id        streams the stored CV
 *   GET  /api/admin/export.csv    ?category=&status=
 */

import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import crypto from 'node:crypto';

import { APPLICATION_STATUSES, BRAND, CATEGORIES, CV_RULES, publicSchema } from './schema.js';
import { sniffCv, validateCv, validateSubmission } from './validate.js';
import * as notify from './notify.js';
import {
  allForExport,
  deliveriesFor,
  deliveryHealth,
  getApplication,
  insertApplication,
  isDuplicate,
  listApplications,
  stats,
  updateApplication,
} from './db.js';

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const UPLOAD_DIR = process.env.UPLOAD_DIR ? resolve(process.env.UPLOAD_DIR) : join(ROOT, 'uploads');
const CONFIG_PATH = process.env.INSTANCE_PATH
  ? resolve(process.env.INSTANCE_PATH)
  : join(ROOT, 'data', 'instance.json');
const MAX_BODY = CV_RULES.maxBytes + 256 * 1024; // CV allowance + form fields
const SESSION_TTL_MS = 8 * 3600_000;
// Stored applications per IP per hour, and total requests per IP per hour.
const LIMIT_SUBMISSIONS = Number(process.env.RATE_LIMIT_SUBMISSIONS || 5);
const LIMIT_ATTEMPTS = Number(process.env.RATE_LIMIT_ATTEMPTS || 60);
const LIMIT_LOGINS = Number(process.env.RATE_LIMIT_LOGINS || 8);

mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(dirname(CONFIG_PATH), { recursive: true });

/* ------------------------------------------------------------------ config */

/**
 * Secrets live in data/instance.json (chmod 600), generated on first boot.
 * Set ADMIN_PASSWORD in the environment to control the password yourself;
 * otherwise a strong one is generated and printed once.
 */
function loadInstance() {
  let cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  let generatedPassword = null;

  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
  }

  const envPassword = process.env.ADMIN_PASSWORD;
  if (envPassword) {
    cfg.passwordSalt = cfg.passwordSalt || crypto.randomBytes(16).toString('hex');
    cfg.passwordHash = hashPassword(envPassword, cfg.passwordSalt);
    cfg.passwordSource = 'env';
  } else if (!cfg.passwordHash) {
    generatedPassword = crypto.randomBytes(9).toString('base64url');
    cfg.passwordSalt = crypto.randomBytes(16).toString('hex');
    cfg.passwordHash = hashPassword(generatedPassword, cfg.passwordSalt);
    cfg.passwordSource = 'generated';
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return { cfg, generatedPassword };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

const { cfg: INSTANCE, generatedPassword: FIRST_RUN_PASSWORD } = loadInstance();

/* ----------------------------------------------------------------- helpers */

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();
}

function hashIp(ip) {
  return crypto.createHmac('sha256', INSTANCE.sessionSecret).update(ip).digest('hex').slice(0, 32);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function signSession(expiresAt) {
  const mac = crypto
    .createHmac('sha256', INSTANCE.sessionSecret)
    .update(`admin:${expiresAt}`)
    .digest('hex');
  return `${expiresAt}.${mac}`;
}

function isAuthed(req) {
  const token = parseCookies(req).rr_admin;
  if (!token) return false;
  const [expRaw, mac] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now() || !mac) return false;
  const expected = crypto
    .createHmac('sha256', INSTANCE.sessionSecret)
    .update(`admin:${exp}`)
    .digest('hex');
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  json(res, 401, { error: 'Not signed in' });
  return false;
}

/**
 * Buffers a request body up to `limit`.
 *
 * Past the limit we stop accumulating (so memory stays bounded) but keep
 * draining the stream, because a client mid-upload must be able to finish
 * sending before it will read our 413. Only a truly absurd body — past
 * `hardCeiling` — gets the connection torn down.
 */
async function readBody(req, limit = MAX_BODY) {
  const hardCeiling = limit * 4;
  const chunks = [];
  let size = 0;
  let overLimit = false;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > hardCeiling) {
      req.destroy();
      const err = new Error('Payload absurdly large');
      err.statusCode = 413;
      throw err;
    }
    if (size > limit) {
      overLimit = true;
      chunks.length = 0; // release what we already held
      continue;
    }
    chunks.push(chunk);
  }

  if (overLimit) {
    const err = new Error('Payload too large');
    err.statusCode = 413;
    throw err;
  }
  return Buffer.concat(chunks);
}

/**
 * Sliding-window rate limiter, keyed by IP. `rateCheck` only reads, so a
 * caller can decide whether an attempt deserves to be counted — a candidate
 * fixing validation errors must not burn their submission budget.
 */
const buckets = new Map();

function rateCheck(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  buckets.set(key, hits);
  return hits.length < max;
}

function rateRecord(key) {
  const hits = buckets.get(key) || [];
  hits.push(Date.now());
  buckets.set(key, hits);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    const live = hits.filter((t) => now - t < 3600_000);
    if (live.length) buckets.set(key, live);
    else buckets.delete(key);
  }
}, 600_000).unref();

function makeRef(categoryCode) {
  const stamp = Date.now().toString(36).toUpperCase().slice(-5);
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `RR-${categoryCode}-${stamp}${rand}`;
}

/* ------------------------------------------------------------- static files */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath === '/admin' ? 'admin.html' : urlPath.slice(1);
  const target = resolve(PUBLIC_DIR, rel);

  // Path traversal guard: the resolved path must stay inside PUBLIC_DIR.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + '/')) {
    return json(res, 403, { error: 'Forbidden' });
  }
  if (!existsSync(target)) return json(res, 404, { error: 'Not found' });

  res.writeHead(200, {
    'content-type': MIME[extname(target)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  });
  createReadStream(target).pipe(res);
}

/* ------------------------------------------------------------ notification */
/* Delivery to email / Google Sheet / webhook lives in src/notify.js and is
   queued in the database, so a destination being down never loses a candidate. */

/* ------------------------------------------------------------------- routes */

async function handleApply(req, res) {
  const ip = clientIp(req);

  // Two tiers: a loose cap stops abuse and brute force, a strict cap stops
  // spam floods. Only a *stored* application counts against the strict cap,
  // so someone correcting validation errors is never locked out.
  if (!rateCheck(`attempt:${ip}`, LIMIT_ATTEMPTS, 3600_000)) {
    return json(res, 429, { error: 'Too many requests from this connection. Please try again later.' });
  }
  rateRecord(`attempt:${ip}`);

  if (!rateCheck(`submit:${ip}`, LIMIT_SUBMISSIONS, 3600_000)) {
    return json(res, 429, {
      error: 'You have submitted several applications already. Give it an hour before sending another.',
    });
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    return json(res, 415, { error: 'Expected multipart/form-data' });
  }

  let form;
  try {
    const buf = await readBody(req);
    form = await new Response(buf, { headers: { 'content-type': contentType } }).formData();
  } catch (err) {
    if (err.statusCode === 413) {
      return json(res, 413, {
        error: `Your CV is too large — keep it under ${CV_RULES.maxBytes / 1048576}MB`,
      });
    }
    return json(res, 400, { error: 'Could not read the submitted form' });
  }

  const payload = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string') continue;
    if (key.endsWith('[]')) {
      const base = key.slice(0, -2);
      (payload[base] ||= []).push(value);
    } else if (payload[key] !== undefined) {
      payload[key] = [].concat(payload[key], value);
    } else {
      payload[key] = value;
    }
  }

  const result = validateSubmission(payload);

  // Ineligible on a hard requirement: explain, store nothing, notify nobody.
  if (result.knockout) {
    return json(res, 422, { knockout: true, error: result.knockout });
  }

  const cvFile = form.get('cv');
  const cvError = validateCv(cvFile);

  if (!result.ok || cvError) {
    const errors = { ...result.errors };
    if (cvError) errors.cv = cvError;
    return json(res, 400, { error: 'Please fix the highlighted fields', errors });
  }

  const { category, answers } = result.data;

  if (isDuplicate(answers.email, category.id, 24)) {
    return json(res, 409, {
      error: 'You already applied to this track in the last 24 hours. We have your CV — no need to resend.',
    });
  }

  const bytes = Buffer.from(await cvFile.arrayBuffer());
  const sniffError = sniffCv(bytes, cvFile.name);
  if (sniffError) return json(res, 400, { error: 'Please fix the highlighted fields', errors: { cv: sniffError } });

  const ref = makeRef(category.code);
  // Stored name is generated, never derived from user input.
  const storedName = `${ref}${extname(cvFile.name).toLowerCase()}`;
  await writeFile(join(UPLOAD_DIR, storedName), bytes, { mode: 0o600 });

  const applicationId = insertApplication({
    ref,
    category: category.id,
    brand: BRAND.client,
    fullName: answers.fullName,
    email: answers.email,
    phone: answers.phone,
    city: answers.city,
    experienceYears: answers.experienceYears,
    expectedCtc: answers.expectedCtc,
    noticePeriod: answers.noticePeriod,
    answers,
    cvOriginalName: cvFile.name.slice(0, 200),
    cvStoredName: storedName,
    cvSize: bytes.length,
    cvMime: cvFile.type || 'application/octet-stream',
    ipHash: ip ? hashIp(ip) : null,
    userAgent: (req.headers['user-agent'] || '').slice(0, 300),
  });

  rateRecord(`submit:${ip}`);
  notify.dispatch(applicationId); // queued + retried; never blocks the candidate

  console.log(`[apply] ${ref} — ${answers.fullName} → ${category.title}`);
  return json(res, 201, {
    ok: true,
    ref,
    message: `Application received. Your reference is ${ref}.`,
  });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (!rateCheck(`login:${ip}`, LIMIT_LOGINS, 900_000)) {
    return json(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
  }
  rateRecord(`login:${ip}`);
  let body;
  try {
    body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
  } catch {
    return json(res, 400, { error: 'Invalid request' });
  }
  const supplied = hashPassword(String(body.password ?? ''), INSTANCE.passwordSalt);
  const a = Buffer.from(supplied, 'hex');
  const b = Buffer.from(INSTANCE.passwordHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return json(res, 401, { error: 'Incorrect password' });
  }
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return json(res, 200, { ok: true }, {
    'set-cookie': `rr_admin=${signSession(expiresAt)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
  });
}

function csvCell(value) {
  let s = Array.isArray(value) ? value.join(' | ') : value == null ? '' : String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function handleExport(res, query) {
  const rows = allForExport({
    category: query.get('category') || undefined,
    status: query.get('status') || undefined,
  });

  const answerKeys = [...new Set(rows.flatMap((r) => Object.keys(r.answers)))];
  const header = ['ref', 'created_at', 'status', 'category', 'cv_file', 'recruiter_notes', ...answerKeys];
  const lines = [header.map(csvCell).join(',')];

  for (const r of rows) {
    lines.push(
      [
        r.ref,
        r.created_at,
        r.status,
        r.category,
        r.cv_stored_name,
        r.recruiter_notes,
        ...answerKeys.map((k) => r.answers[k]),
      ]
        .map(csvCell)
        .join(','),
    );
  }

  const csv = '\uFEFF' + lines.join('\r\n'); // BOM so Excel reads ₹ correctly
  const stamp = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="rocket-recruiters-applications-${stamp}.csv"`,
    'cache-control': 'no-store',
  });
  res.end(csv);
}

function handleCvDownload(res, id) {
  const app = getApplication(id);
  if (!app || !app.cv_stored_name) return json(res, 404, { error: 'No CV on file' });

  const path = join(UPLOAD_DIR, app.cv_stored_name);
  if (!path.startsWith(UPLOAD_DIR + '/') || !existsSync(path)) {
    return json(res, 404, { error: 'File missing from disk' });
  }

  // HTTP headers cannot carry non-Latin-1 characters, and Node throws on them.
  // Send an ASCII-safe fallback plus an RFC 5987 encoded name, so a candidate
  // called "अनन्या शर्मा" or "José" still downloads correctly.
  const pretty = `${app.full_name} - ${app.ref}${extname(app.cv_stored_name)}`;
  const ascii = pretty.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '') || `cv-${app.ref}`;
  res.writeHead(200, {
    'content-type': app.cv_mime || 'application/octet-stream',
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(pretty)}`,
    'content-length': app.cv_size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(path).pipe(res);
}

/* ------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  try {
    /* public */
    if (method === 'GET' && path === '/api/schema') {
      return json(res, 200, publicSchema(), { 'cache-control': 'public, max-age=300' });
    }
    if (method === 'POST' && path === '/api/apply') {
      return await handleApply(req, res);
    }

    /* admin auth */
    if (method === 'POST' && path === '/api/admin/login') return await handleLogin(req, res);
    if (method === 'POST' && path === '/api/admin/logout') {
      return json(res, 200, { ok: true }, {
        'set-cookie': 'rr_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
      });
    }
    if (method === 'GET' && path === '/api/admin/session') {
      return json(res, 200, { authed: isAuthed(req) });
    }

    /* admin data */
    if (path.startsWith('/api/admin/')) {
      if (!requireAuth(req, res)) return;

      if (method === 'GET' && path === '/api/admin/stats') {
        return json(res, 200, {
          ...stats(),
          categories: CATEGORIES.map(({ id, title, code }) => ({ id, title, code })),
          statuses: APPLICATION_STATUSES,
          notifications: { enabled: notify.enabledSinks(), health: deliveryHealth() },
        });
      }

      if (method === 'POST' && path === '/api/admin/deliveries/retry') {
        const result = await notify.drain(50);
        return json(res, 200, result);
      }

      if (method === 'GET' && path === '/api/admin/applications') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
        const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
        return json(res, 200, listApplications({
          category: url.searchParams.get('category') || undefined,
          status: url.searchParams.get('status') || undefined,
          q: url.searchParams.get('q') || undefined,
          limit,
          offset,
        }));
      }

      if (method === 'GET' && path === '/api/admin/export.csv') {
        return handleExport(res, url.searchParams);
      }

      const cvMatch = path.match(/^\/api\/admin\/cv\/(\d+)$/);
      if (method === 'GET' && cvMatch) return handleCvDownload(res, Number(cvMatch[1]));

      const oneMatch = path.match(/^\/api\/admin\/applications\/(\d+)$/);
      if (oneMatch) {
        const id = Number(oneMatch[1]);
        if (method === 'GET') {
          const app = getApplication(id);
          return app
            ? json(res, 200, { ...app, deliveries: deliveriesFor(id) })
            : json(res, 404, { error: 'Not found' });
        }
        if (method === 'PATCH') {
          let body;
          try {
            body = JSON.parse((await readBody(req, 8192)).toString('utf8'));
          } catch {
            return json(res, 400, { error: 'Invalid request' });
          }
          if (body.status !== undefined && !APPLICATION_STATUSES.includes(body.status)) {
            return json(res, 400, { error: 'Unknown status' });
          }
          const notes = body.recruiterNotes === undefined ? undefined : String(body.recruiterNotes).slice(0, 4000);
          const ok = updateApplication(id, { status: body.status, recruiterNotes: notes });
          return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' });
        }
      }

      return json(res, 404, { error: 'Unknown admin route' });
    }

    /* static */
    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, path);

    return json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong on our side' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const base = process.env.PUBLIC_URL?.replace(/\/$/, '') || `http://${HOST}:${PORT}`;
  notify.configure({ dashboardUrl: `${base}/admin` });
  notify.startWorker();

  console.log('');
  console.log(`  ${BRAND.agency} × ${BRAND.client} — application portal`);
  console.log(`  Candidate portal    ${base}/`);
  console.log(`  Recruiter dashboard ${base}/admin`);
  console.log(`  CVs stored in       ${UPLOAD_DIR}`);
  console.log(`  Office              ${BRAND.office.address} (${BRAND.workMode.toLowerCase()})`);

  const sinks = notify.enabledSinks();
  console.log(`  Notifications       ${sinks.length ? sinks.join(', ') : 'none configured — dashboard only'}`);

  if (FIRST_RUN_PASSWORD) {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log(`   ADMIN PASSWORD (shown once): ${FIRST_RUN_PASSWORD}`);
    console.log('   Save it now. Override anytime with ADMIN_PASSWORD=…');
    console.log('  └──────────────────────────────────────────────┘');
  }
  if (!sinks.includes('email')) {
    console.log('  Tip: set SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_TO to get emailed each application.');
  }
  if (!sinks.includes('sheet')) {
    console.log('  Tip: set SHEETS_WEBHOOK_URL to append every application to a Google Sheet.');
  }
  console.log('');
});

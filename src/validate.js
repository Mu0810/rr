/**
 * Server-side validation, driven by schema.js.
 *
 * The browser does its own checks for UX, but nothing is trusted: every field
 * is re-validated here, unknown fields are dropped, and select/multiselect
 * values must match the declared options exactly.
 */

import { COMMON_FIELDS, CLOSING_FIELDS, CV_RULES, getCategory } from './schema.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE_RE = /^[+]?[\d][\d\s().-]{6,19}$/;

function clean(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
}

function validateUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.toString();
}

function validateField(field, raw, errors) {
  const isMulti = field.type === 'multiselect';
  let value = isMulti ? raw : clean(raw);

  const empty =
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);

  if (empty) {
    if (field.required) errors[field.name] = `${field.label} is required`;
    return isMulti ? [] : '';
  }

  switch (field.type) {
    case 'email':
      if (!EMAIL_RE.test(value) || value.length > 160) {
        errors[field.name] = 'Enter a valid email address';
        return '';
      }
      return value.toLowerCase();

    case 'tel':
      if (!PHONE_RE.test(value)) {
        errors[field.name] = 'Enter a valid phone number with country code';
        return '';
      }
      return value;

    case 'url': {
      const ok = validateUrl(value);
      if (!ok) {
        errors[field.name] = `${field.label} must be a full http(s) link`;
        return '';
      }
      if (ok.length > (field.maxLength ?? 300)) {
        errors[field.name] = `${field.label} is too long`;
        return '';
      }
      return ok;
    }

    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        errors[field.name] = `${field.label} must be a number`;
        return '';
      }
      if (field.min !== undefined && n < field.min) {
        errors[field.name] = `${field.label} cannot be below ${field.min}`;
        return '';
      }
      if (field.max !== undefined && n > field.max) {
        errors[field.name] = `${field.label} cannot be above ${field.max}`;
        return '';
      }
      return n;
    }

    case 'select':
      if (!field.options.includes(value)) {
        errors[field.name] = `Choose a valid option for ${field.label}`;
        return '';
      }
      return value;

    case 'multiselect': {
      const list = (Array.isArray(value) ? value : [value]).map(clean);
      const bad = list.filter((v) => !field.options.includes(v));
      if (bad.length) {
        errors[field.name] = `Invalid option for ${field.label}`;
        return [];
      }
      if (list.length > field.options.length) {
        errors[field.name] = `Too many options for ${field.label}`;
        return [];
      }
      return [...new Set(list)];
    }

    case 'text':
    case 'textarea':
    default: {
      const max = field.maxLength ?? 500;
      if (value.length > max) {
        errors[field.name] = `${field.label} must be under ${max} characters`;
        return '';
      }
      if (field.minLength && value.length < field.minLength) {
        errors[field.name] = `${field.label} needs at least ${field.minLength} characters`;
        return '';
      }
      return value;
    }
  }
}

/**
 * @returns {{ ok: boolean, errors: Record<string,string>, data?: object }}
 */
export function validateSubmission(payload) {
  const errors = {};

  const category = getCategory(clean(payload.category));
  if (!category) {
    return { ok: false, errors: { category: 'Choose a job category' } };
  }

  const answers = { category: category.id, categoryTitle: category.title };
  const fields = [...COMMON_FIELDS, ...category.fields, ...CLOSING_FIELDS];

  for (const field of fields) {
    answers[field.name] = validateField(field, payload[field.name], errors);
  }

  // Spam traps: a filled honeypot, or a form completed impossibly fast.
  if (clean(payload.company_website)) {
    return { ok: false, errors: { _form: 'Submission rejected' }, spam: true };
  }
  const elapsed = Number(payload.form_elapsed_ms);
  if (Number.isFinite(elapsed) && elapsed > 0 && elapsed < 4000) {
    return { ok: false, errors: { _form: 'That was too quick — please review your answers' }, spam: true };
  }

  if (payload.consent !== 'yes') {
    errors.consent = 'Please confirm you agree to us processing your application';
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  // Knockout is checked last, on otherwise-valid input, so we never tell someone
  // they are ineligible while their form still has mistakes in it.
  for (const field of fields) {
    if (field.knockout && answers[field.name] === field.knockout.value) {
      return { ok: false, errors: {}, knockout: field.knockout.message };
    }
  }

  return { ok: true, errors: {}, data: { category, answers } };
}

/** @returns {string|null} an error message, or null when the file is acceptable. */
export function validateCv(file) {
  if (!file || typeof file.name !== 'string' || !file.size) {
    return 'Attach your CV (PDF or Word, up to ' + Math.round(CV_RULES.maxBytes / 1048576) + 'MB)';
  }
  if (file.size > CV_RULES.maxBytes) {
    return `Your CV is ${(file.size / 1048576).toFixed(1)}MB — the limit is ${Math.round(CV_RULES.maxBytes / 1048576)}MB`;
  }
  const lower = file.name.toLowerCase();
  if (!CV_RULES.extensions.some((ext) => lower.endsWith(ext))) {
    return `CV must be one of: ${CV_RULES.extensions.join(', ')}`;
  }
  if (file.type && !CV_RULES.mimeTypes.includes(file.type)) {
    return 'That file type is not accepted — upload a PDF or Word document';
  }
  return null;
}

/**
 * Confirms the bytes actually look like the claimed format. Stops someone
 * renaming an executable or script to .pdf to get it stored on the server.
 */
export function sniffCv(buffer, filename) {
  const lower = filename.toLowerCase();
  const head = buffer.subarray(0, 8);

  if (lower.endsWith('.pdf')) {
    return head.subarray(0, 5).toString('latin1') === '%PDF-' ? null : 'That file is not a valid PDF';
  }
  if (lower.endsWith('.docx')) {
    // docx is a zip container
    return head[0] === 0x50 && head[1] === 0x4b ? null : 'That file is not a valid .docx';
  }
  if (lower.endsWith('.doc')) {
    const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return ole.every((b, i) => head[i] === b) ? null : 'That file is not a valid .doc';
  }
  return 'Unsupported file type';
}

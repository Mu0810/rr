/**
 * Rocket Recruiters → Google Sheets bridge.
 *
 * Appends one row per application to the sheet this script is bound to.
 * No Google Cloud project, no service account, no OAuth keys — the script runs
 * as you, inside your own Sheet.
 *
 * ── Setup (about two minutes) ────────────────────────────────────────────────
 *  1. Create a Google Sheet. Name the first tab "Applications".
 *  2. Extensions → Apps Script. Delete the placeholder and paste this file.
 *  3. Edit SHARED_SECRET below to a long random string of your own.
 *  4. Deploy → New deployment → type "Web app".
 *       Execute as:      Me
 *       Who has access:  Anyone
 *     Google will warn that the script is unverified — it is your own script;
 *     click Advanced → Go to (unsafe) to authorise it.
 *  5. Copy the /exec web app URL, then start the portal with:
 *
 *       SHEETS_WEBHOOK_URL='https://script.google.com/macros/s/…/exec' \
 *       SHEETS_SHARED_SECRET='the same string as below' \
 *       npm start
 *
 *  "Who has access: Anyone" means anyone with the URL can POST, which is why
 *  SHARED_SECRET exists — requests without it are rejected.
 */

var SHARED_SECRET = 'change-me-to-a-long-random-string';
var SHEET_NAME = 'Applications';

/**
 * Leave blank when this script lives inside the Sheet itself (Extensions →
 * Apps Script), which is the normal case. Only set it if you created a
 * standalone script: paste the long id from the Sheet's own URL,
 * .../spreadsheets/d/THIS_PART/edit
 */
var SHEET_ID = '';

/** Column order. Add a key here and it appears as a new column. */
var COLUMNS = [
  ['receivedAt', 'Received'],
  ['reference', 'Reference'],
  ['track', 'Track'],
  ['name', 'Name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['city', 'City'],
  ['onsite', 'Onsite'],
  ['experienceYears', 'Experience (yrs)'],
  ['currentCompany', 'Current company'],
  ['currentRole', 'Current title'],
  ['noticePeriod', 'Notice period'],
  ['currentCtc', 'Current CTC'],
  ['expectedCtc', 'Expected CTC'],
  ['linkedin', 'LinkedIn'],
  ['source', 'Source'],
  ['status', 'Status'],
  ['cvFile', 'CV file'],
  ['roleAnswers', 'Role answers'],
];

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return reply(400, { error: 'empty request' });
    }

    var payload = JSON.parse(e.postData.contents);

    if (SHARED_SECRET && payload.secret !== SHARED_SECRET) {
      return reply(401, { error: 'bad secret' });
    }
    if (!payload.row) {
      return reply(400, { error: 'missing row' });
    }

    // Serialise concurrent writes so two applications never collide on a row.
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      appendRow(payload.row);
    } finally {
      lock.releaseLock();
    }

    return reply(200, { ok: true, reference: payload.row.reference || null });
  } catch (err) {
    return reply(500, { error: String(err) });
  }
}

function appendRow(row) {
  var book = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!book) {
    throw new Error(
      'No spreadsheet found. Either paste this script via the Sheet\'s Extensions > Apps Script menu, or set SHEET_ID.'
    );
  }
  var sheet = book.getSheetByName(SHEET_NAME) || book.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    var headers = COLUMNS.map(function (c) { return c[1]; });
    sheet.appendRow(headers);
    var head = sheet.getRange(1, 1, 1, headers.length);
    head.setFontWeight('bold').setBackground('#0c0d0a').setFontColor('#c8f04c');
    sheet.setFrozenRows(1);
  }

  sheet.appendRow(
    COLUMNS.map(function (c) {
      var value = row[c[0]];
      if (value === null || value === undefined) return '';
      // A leading =, +, - or @ would be read as a formula.
      var text = String(value);
      return /^[=+\-@]/.test(text) ? "'" + text : text;
    })
  );

  sheet.autoResizeColumns(1, Math.min(COLUMNS.length, 10));
}

function reply(status, body) {
  // Apps Script web apps always answer 200; the status is carried in the body.
  return ContentService.createTextOutput(
    JSON.stringify(Object.assign({ status: status }, body))
  ).setMimeType(ContentService.MimeType.JSON);
}

/** Run this from the Apps Script editor to check the sheet wiring. */
function testAppend() {
  appendRow({
    receivedAt: new Date().toISOString(),
    reference: 'RR-TEST-000000',
    track: 'CRM & Retention',
    name: 'Test Candidate',
    email: 'test@example.com',
    phone: '+91 90000 00000',
    city: 'Sector 45, Gurugram',
    onsite: 'I live in Gurugram — short commute',
    experienceYears: 4,
    noticePeriod: '30 days',
    expectedCtc: '16 LPA',
    status: 'new',
    cvFile: 'test.pdf',
    roleAnswers: 'Tools: Klaviyo',
  });
}

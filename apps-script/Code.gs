/**
 * EPWP General Worker applications - Google Sheets backend.
 *
 * This script is bound to the Google Sheet that stores the applications
 * (Extensions > Apps Script). Deploy it as a Web App:
 *   Execute as: Me        Who has access: Anyone
 * and paste the /exec URL into assets/config.js on the website.
 *
 * Supporting documents are saved to a Google Drive folder owned by the
 * account that deploys the script. Run setup() once after pasting this code
 * so that Google asks for permission to use Drive.
 */

var SHEET_NAME = 'Applications';
var FOLDER_NAME = 'EPWP Applications - Supporting Documents';
var REF_PREFIX = 'EPWP-';
var MIN_AGE = 18;
var MAX_AGE = 45;
// Closing date and time (South African time). Later submissions are refused.
var CLOSING = '2026-11-20T23:59:59+02:00';
var QUALIFICATIONS = ['Grade 10', 'N2', 'NC(V) Level 2'];

// Column order follows docs/databasefields.csv.
var FIELDS = [
  'Title', 'Name', 'Surname', 'SouthAfricanID', 'DateOfBirth', 'Gender',
  'DisabilityStatus', 'CurrentAddress', 'CellphoneNumber', 'AlternativeNumber',
  'EmailAddress', 'District', 'LocalMunicipality', 'NearestFacility',
  'MunicipalWardNo', 'HighestSchoolLevel', 'PracticalSkills', 'OtherSkills'
];

// Supporting documents: one uploaded file each, stored as a link in the sheet.
var DOCUMENTS = ['IDCopy', 'QualificationCopy', 'ProofOfResidence'];
var FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
var MAX_FILE_BYTES = 4 * 1024 * 1024;

var HEADERS = ['Timestamp', 'Reference'].concat(FIELDS).concat(['Consent']).concat(DOCUMENTS);

var REQUIRED = [
  'Title', 'Name', 'Surname', 'SouthAfricanID', 'DateOfBirth', 'Gender',
  'DisabilityStatus', 'CurrentAddress', 'CellphoneNumber', 'District',
  'LocalMunicipality', 'NearestFacility', 'MunicipalWardNo',
  'HighestSchoolLevel', 'PracticalSkills'
];

/**
 * Run this once from the Apps Script editor. It creates the sheet and the
 * Drive folder, and makes Google ask for the permissions the script needs.
 */
function setup() {
  var sheet = getSheet_();
  var folder = getFolder_();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Sheet "' + sheet.getName() + '" and Drive folder "' + folder.getName() + '" are ready.');
}

/** Opening the Web App URL in a browser shows that it is alive. */
function doGet() {
  // "uploads" tells the website that this version accepts supporting documents.
  return json_({ ok: true, service: 'EPWP general worker applications', uploads: true });
}

function doPost(e) {
  var data;
  try {
    var raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > 20000000) throw new Error('bad payload');
    data = JSON.parse(raw);
  } catch (err) {
    return json_({ ok: false, error: 'invalid', message: 'The form data could not be read.' });
  }

  // Honeypot: real applicants never fill this hidden field in.
  if (data.website) return json_({ ok: true, ref: REF_PREFIX + '000000' });

  if (new Date().getTime() > new Date(CLOSING).getTime()) {
    return json_({ ok: false, error: 'closed', message: 'Applications are closed.' });
  }

  var record = clean_(data);
  var problem = validate_(record, data) || validateDocuments_(data.Documents);
  if (problem) return json_({ ok: false, error: 'invalid', message: problem });

  var saved = [];
  var lock = null;
  try {
    // Refuse a repeat application before spending time on the uploads.
    var early = findDuplicate_(getSheet_(), record.SouthAfricanID);
    if (early) return json_(early);

    // Saving to Drive is slow, so it is done before taking the lock.
    saved = saveDocuments_(record, data.Documents);

    lock = LockService.getScriptLock();
    try {
      lock.waitLock(25000);
    } catch (err) {
      lock = null;
      trash_(saved);
      return json_({ ok: false, error: 'busy', message: 'The system is busy. Please try again in a minute.' });
    }

    var sheet = getSheet_();
    var duplicate = findDuplicate_(sheet, record.SouthAfricanID);
    if (duplicate) {
      trash_(saved);
      return json_(duplicate);
    }

    var lastRow = sheet.getLastRow();
    var ref = nextReference_(lastRow);
    var row = [new Date(), ref];
    FIELDS.forEach(function (f) { row.push(safeCell_(record[f])); });
    row.push('Yes');
    saved.forEach(function (file) { row.push(file.getUrl()); });

    // Keep ID numbers, cellphone numbers and ward numbers as text so that
    // leading zeros survive and long numbers are not rounded.
    sheet.getRange(lastRow + 1, 2, 1, HEADERS.length - 1).setNumberFormat('@');
    sheet.getRange(lastRow + 1, 1, 1, HEADERS.length).setValues([row]);
    SpreadsheetApp.flush();

    return json_({ ok: true, ref: ref });
  } catch (err) {
    console.error(err);
    trash_(saved);
    return json_({ ok: false, error: 'server', message: 'Your application could not be saved. Please try again.' });
  } finally {
    if (lock) lock.releaseLock();
  }
}

/* ---------- sheet ---------- */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  var width = sheet.getLastColumn();
  var current = width ? sheet.getRange(1, 1, 1, width).getDisplayValues()[0].join('|') : '';
  if (current !== HEADERS.join('|')) {
    // New sheet, or a sheet from an earlier version: (re)write the heading row.
    // New columns are only ever added at the end, so existing rows stay valid.
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS])
      .setFontWeight('bold')
      .setBackground('#0a6b3d')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
  return sheet;
}

/** Returns the "duplicate" reply if this ID number has already applied, else null. */
function findDuplicate_(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var idCol = HEADERS.indexOf('SouthAfricanID') + 1;
  var refCol = HEADERS.indexOf('Reference') + 1;
  var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).replace(/\D/g, '') === id) {
      return {
        ok: false,
        error: 'duplicate',
        ref: sheet.getRange(i + 2, refCol).getDisplayValue(),
        message: 'An application with this ID number has already been received.'
      };
    }
  }
  return null;
}

function nextReference_(lastRow) {
  var props = PropertiesService.getScriptProperties();
  var counter = Math.max(Number(props.getProperty('counter')) || 0, lastRow - 1) + 1;
  props.setProperty('counter', String(counter));
  return REF_PREFIX + ('000000' + counter).slice(-6);
}

/* ---------- supporting documents ---------- */

function getFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('folderId');
  if (id) {
    try {
      var existing = DriveApp.getFolderById(id);
      if (!existing.isTrashed()) return existing;
    } catch (err) { /* folder was removed: make a new one below */ }
  }
  var folder = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('folderId', folder.getId());
  return folder;
}

function validateDocuments_(docs) {
  var missing = 'Please attach all three supporting documents. Refresh the page and try again.';
  if (!docs || typeof docs !== 'object') return missing;
  for (var i = 0; i < DOCUMENTS.length; i++) {
    var doc = docs[DOCUMENTS[i]];
    if (!doc || typeof doc.data !== 'string' || !doc.data) return missing;
    if (!FILE_TYPES[doc.type]) return 'Supporting documents must be photos (JPG or PNG) or PDF files.';
    if (!/^[A-Za-z0-9+\/]+=*$/.test(doc.data)) return 'A supporting document could not be read. Please choose the file again.';
    if (doc.data.length * 0.75 > MAX_FILE_BYTES) return 'A supporting document is too big. Each file must be smaller than 4 MB.';
  }
  return '';
}

/** Saves the three files to Drive and returns them in DOCUMENTS order. */
function saveDocuments_(record, docs) {
  var folder = getFolder_();
  var owner = (record.Surname + '_' + record.Name).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
  var saved = [];
  try {
    DOCUMENTS.forEach(function (key) {
      var doc = docs[key];
      var name = record.SouthAfricanID + '_' + owner + '_' + key + '.' + FILE_TYPES[doc.type];
      var blob = Utilities.newBlob(Utilities.base64Decode(doc.data), doc.type, name);
      saved.push(folder.createFile(blob));
    });
  } catch (err) {
    trash_(saved);
    throw err;
  }
  return saved;
}

function trash_(files) {
  files.forEach(function (file) {
    try { file.setTrashed(true); } catch (err) { console.error(err); }
  });
}

/* ---------- validation ---------- */

/** Keep only the known fields, as trimmed strings of a sensible length. */
function clean_(data) {
  var out = {};
  FIELDS.forEach(function (f) {
    var v = data[f];
    if (Array.isArray(v)) v = v.join(', ');
    v = (v === null || v === undefined) ? '' : String(v);
    out[f] = v.replace(/\s+/g, ' ').trim().slice(0, f === 'CurrentAddress' ? 300 : 200);
  });
  out.SouthAfricanID = out.SouthAfricanID.replace(/\D/g, '');
  ['CellphoneNumber', 'AlternativeNumber'].forEach(function (f) {
    out[f] = out[f].replace(/[^\d+]/g, '').replace(/^\+27/, '0');
  });
  return out;
}

function validate_(r, data) {
  for (var i = 0; i < REQUIRED.length; i++) {
    if (!r[REQUIRED[i]]) return 'Please complete all the required fields (' + REQUIRED[i] + ').';
  }
  if (data.Consent !== true && data.Consent !== 'Yes') return 'Consent is required to apply.';

  var dob = idBirthDate_(r.SouthAfricanID);
  if (!dob) return 'The South African ID number is not valid.';
  if (r.DateOfBirth !== dob) return 'The date of birth does not match the ID number.';
  var age = ageOn_(dob, new Date());
  if (age < MIN_AGE || age > MAX_AGE) return 'These positions are for people aged ' + MIN_AGE + ' to ' + MAX_AGE + '.';
  if (QUALIFICATIONS.indexOf(r.HighestSchoolLevel) === -1) return 'Please choose a qualification from the list.';

  if (!/^0\d{9}$/.test(r.CellphoneNumber)) return 'The cellphone number must have 10 digits and start with 0.';
  if (r.AlternativeNumber && !/^0\d{9}$/.test(r.AlternativeNumber)) return 'The alternative number must have 10 digits and start with 0.';
  if (r.EmailAddress && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.EmailAddress)) return 'The email address is not valid.';
  if (!/^\d{1,3}$/.test(r.MunicipalWardNo) || Number(r.MunicipalWardNo) < 1) return 'The ward number is not valid.';
  if (r.DisabilityStatus !== 'Yes' && r.DisabilityStatus !== 'No') return 'Please answer the disability question.';
  return '';
}

/** Returns the birth date (yyyy-mm-dd) held in a valid SA ID number, else ''. */
function idBirthDate_(id) {
  if (!/^\d{13}$/.test(id)) return '';
  if (id.charAt(10) !== '0' && id.charAt(10) !== '1') return '';

  // Luhn check digit.
  var sum = 0;
  for (var i = 0; i < 13; i++) {
    var d = Number(id.charAt(12 - i));
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  if (sum % 10 !== 0) return '';

  var yy = Number(id.substr(0, 2)), mm = Number(id.substr(2, 2)), dd = Number(id.substr(4, 2));
  var thisYY = new Date().getFullYear() % 100;
  var year = (yy <= thisYY ? 2000 : 1900) + yy;
  var date = new Date(Date.UTC(year, mm - 1, dd));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return '';
  return year + '-' + ('0' + mm).slice(-2) + '-' + ('0' + dd).slice(-2);
}

function ageOn_(isoDate, today) {
  var p = isoDate.split('-').map(Number);
  var age = today.getFullYear() - p[0];
  if (today.getMonth() + 1 < p[1] || (today.getMonth() + 1 === p[1] && today.getDate() < p[2])) age--;
  return age;
}

/** Stop text such as "=IMPORTXML(...)" from being run as a spreadsheet formula. */
function safeCell_(value) {
  value = String(value === undefined ? '' : value);
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

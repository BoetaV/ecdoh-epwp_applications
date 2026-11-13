/**
 * EPWP Candidate Database - Google Sheets backend.
 *
 * This script is bound to the Google Sheet that stores the registrations
 * (Extensions > Apps Script). Deploy it as a Web App:
 *   Execute as: Me        Who has access: Anyone
 * and paste the /exec URL into assets/config.js on the website.
 */

var SHEET_NAME = 'Registrations';
var REF_PREFIX = 'EPWP-';
var MIN_AGE = 18;

// Column order follows docs/databasefields.csv.
var FIELDS = [
  'Title', 'Name', 'Surname', 'SouthAfricanID', 'DateOfBirth', 'Gender',
  'DisabilityStatus', 'CurrentAddress', 'CellphoneNumber', 'EmailAddress',
  'District', 'LocalMunicipality', 'Hospital', 'MunicipalWardNo',
  'HighestSchoolLevel', 'PracticalSkills', 'OtherSkills', 'DriversLicence'
];
var HEADERS = ['Timestamp', 'Reference'].concat(FIELDS).concat(['Consent']);

var REQUIRED = [
  'Title', 'Name', 'Surname', 'SouthAfricanID', 'DateOfBirth', 'Gender',
  'DisabilityStatus', 'CurrentAddress', 'CellphoneNumber', 'District',
  'LocalMunicipality', 'MunicipalWardNo', 'HighestSchoolLevel',
  'PracticalSkills', 'DriversLicence'
];

/** Run this once from the Apps Script editor to create the sheet and headers. */
function setup() {
  var sheet = getSheet_();
  SpreadsheetApp.getActiveSpreadsheet().toast('Sheet "' + sheet.getName() + '" is ready.');
}

/** Opening the Web App URL in a browser shows that it is alive. */
function doGet() {
  return json_({ ok: true, service: 'EPWP candidate registration' });
}

function doPost(e) {
  var data;
  try {
    var raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > 10000) throw new Error('bad payload');
    data = JSON.parse(raw);
  } catch (err) {
    return json_({ ok: false, error: 'invalid', message: 'The form data could not be read.' });
  }

  // Honeypot: real applicants never fill this hidden field in.
  if (data.website) return json_({ ok: true, ref: REF_PREFIX + '000000' });

  var record = clean_(data);
  var problem = validate_(record, data);
  if (problem) return json_({ ok: false, error: 'invalid', message: problem });

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    return json_({ ok: false, error: 'busy', message: 'The system is busy. Please try again in a minute.' });
  }

  try {
    var sheet = getSheet_();
    var lastRow = sheet.getLastRow();
    var idCol = HEADERS.indexOf('SouthAfricanID') + 1;

    if (lastRow > 1) {
      var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getDisplayValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]).replace(/\D/g, '') === record.SouthAfricanID) {
          var refCol = HEADERS.indexOf('Reference') + 1;
          return json_({
            ok: false,
            error: 'duplicate',
            ref: sheet.getRange(i + 2, refCol).getDisplayValue(),
            message: 'This ID number is already registered on the database.'
          });
        }
      }
    }

    var ref = nextReference_(lastRow);
    var row = [new Date(), ref];
    FIELDS.forEach(function (f) { row.push(safeCell_(record[f])); });
    row.push('Yes');

    var target = sheet.getRange(lastRow + 1, 1, 1, HEADERS.length);
    // Keep ID numbers, cellphone numbers and ward numbers as text so that
    // leading zeros survive and long numbers are not rounded.
    sheet.getRange(lastRow + 1, 2, 1, HEADERS.length - 1).setNumberFormat('@');
    target.setValues([row]);
    SpreadsheetApp.flush();

    return json_({ ok: true, ref: ref });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server', message: 'Your registration could not be saved. Please try again.' });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- helpers ---------- */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
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

function nextReference_(lastRow) {
  var props = PropertiesService.getScriptProperties();
  var counter = Math.max(Number(props.getProperty('counter')) || 0, lastRow - 1) + 1;
  props.setProperty('counter', String(counter));
  return REF_PREFIX + ('000000' + counter).slice(-6);
}

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
  out.CellphoneNumber = out.CellphoneNumber.replace(/[^\d+]/g, '').replace(/^\+27/, '0');
  return out;
}

function validate_(r, data) {
  for (var i = 0; i < REQUIRED.length; i++) {
    if (!r[REQUIRED[i]]) return 'Please complete all the required fields (' + REQUIRED[i] + ').';
  }
  if (data.Consent !== true && data.Consent !== 'Yes') return 'Consent is required to register.';

  var dob = idBirthDate_(r.SouthAfricanID);
  if (!dob) return 'The South African ID number is not valid.';
  if (r.DateOfBirth !== dob) return 'The date of birth does not match the ID number.';
  if (ageOn_(dob, new Date()) < MIN_AGE) return 'You must be ' + MIN_AGE + ' or older to register.';

  if (!/^0\d{9}$/.test(r.CellphoneNumber)) return 'The cellphone number must have 10 digits and start with 0.';
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

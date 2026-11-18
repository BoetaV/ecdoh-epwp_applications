/**
 * EPWP General Worker applications - Google Sheets backend.
 *
 * This script is bound to the Google Sheet that stores the applications
 * (Extensions > Apps Script). Deploy it as a Web App:
 *   Execute as: Me        Who has access: Anyone
 * and paste the /exec URL into assets/config.js on the website.
 *
 * Applications arrive in two ways, both saved to the "Applications" tab:
 *   - Online: applicants fill in the public form themselves.
 *   - Captured: District Office staff sign in and capture paper applications.
 *     Staff accounts are kept in the "Users" tab and managed from the EPWP
 *     menu in the spreadsheet (passwords are stored hashed, never as text).
 *
 * Supporting documents are saved to Google Drive, in a folder called
 * "EPWP Applications - Supporting Documents" next to this spreadsheet, with
 * one sub-folder per district. Each row in the sheet links to its files.
 * Run setup() once after pasting this code so that Google asks for permission
 * to use Drive.
 */

var SHEET_NAME = 'Applications';
var USERS_SHEET = 'Users';
var FOLDER_NAME = 'EPWP Applications - Supporting Documents';
var REF_PREFIX = 'EPWP-';
var TIME_ZONE = 'Africa/Johannesburg';
var MIN_AGE = 18;
var MAX_AGE = 45;
// Closing date and time (South African time) for ONLINE applications.
// Capturing of paper applications by staff is not affected.
var CLOSING = '2026-11-20T23:59:59+02:00';
var QUALIFICATIONS = ['Grade 10', 'N2', 'NC(V) Level 2'];

// Staff sign-in.
var SESSION_SECONDS = 6 * 60 * 60;   // a sign-in lasts 6 hours (the most Google allows)
var MAX_FAILED_LOGINS = 5;           // then the account is locked for LOCK_SECONDS
var LOCK_SECONDS = 15 * 60;
var HASH_ROUNDS = 500;

// Column order follows docs/databasefields.csv.
var FIELDS = [
  'Title', 'Name', 'Surname', 'SouthAfricanID', 'DateOfBirth', 'Gender',
  'DisabilityStatus', 'CurrentAddress', 'CellphoneNumber', 'AlternativeNumber',
  'EmailAddress', 'District', 'LocalMunicipality', 'NearestFacility',
  'MunicipalWardNo', 'HighestSchoolLevel', 'PracticalSkills', 'OtherSkills'
];

// Supporting documents: one uploaded file each, stored as a link in the sheet.
var DOCUMENTS = ['IDCopy', 'QualificationCopy'];
var DOCUMENT_HEADERS = ['ID Document (link)', 'Proof of Results (link)'];
var DOCUMENT_FILE_LABELS = { IDCopy: 'ID', QualificationCopy: 'Results' };

// How each application arrived, and who captured it. Added after the first
// version of the sheet, so these columns come last.
var CAPTURE_HEADERS = ['Channel', 'Captured By', 'Captured By District', 'Date Received', 'Received At', 'Paper Documents'];

// Display names for the districts (also used for the Drive folders).
var DISTRICT_NAMES = { 'N Mandela Bay MM': 'Nelson Mandela Bay Metro' };
var FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
var MAX_FILE_BYTES = 4 * 1024 * 1024;

var HEADERS = ['Timestamp', 'Reference'].concat(FIELDS).concat(['Consent'])
  .concat(DOCUMENT_HEADERS).concat(CAPTURE_HEADERS);
var USER_HEADERS = ['Username', 'Full name', 'District', 'Active', 'Password hash', 'Salt', 'Last sign-in'];

var REQUIRED = [
  'Title', 'Name', 'Surname', 'SouthAfricanID', 'DateOfBirth', 'Gender',
  'DisabilityStatus', 'CurrentAddress', 'CellphoneNumber', 'District',
  'LocalMunicipality', 'NearestFacility', 'MunicipalWardNo',
  'HighestSchoolLevel', 'PracticalSkills'
];

/* =====================================================================
 * Spreadsheet menu and set-up
 * ===================================================================== */

/**
 * Run this once from the Apps Script editor. It creates the sheets and the
 * Drive folder, and makes Google ask for the permissions the script needs.
 */
function setup() {
  var sheet = getSheet_();
  getUsersSheet_();
  var folder = getFolder_();
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Sheets "' + sheet.getName() + '" and "' + USERS_SHEET + '", and Drive folder "' + folder.getName() + '" are ready.');
}

/** Adds an EPWP menu to the spreadsheet. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('EPWP')
    .addItem('Open supporting documents folder', 'showDocumentsFolder')
    .addSeparator()
    .addItem('Add a capturing user', 'addUser')
    .addItem("Reset a user's password", 'resetPassword')
    .addToUi();
}

function showDocumentsFolder() {
  var url = getFolder_().getUrl();
  var html = HtmlService.createHtmlOutput(
    '<p style="font-family:Arial,sans-serif">The supporting documents are in Google Drive, one folder per district.</p>' +
    '<p style="font-family:Arial,sans-serif"><a href="' + url + '" target="_blank">Open the documents folder</a></p>')
    .setWidth(380).setHeight(130);
  SpreadsheetApp.getUi().showModalDialog(html, 'Supporting documents');
}

/** Menu: create a staff account and show its first password once. */
function addUser() {
  var ui = SpreadsheetApp.getUi();
  var username = askText_(ui, 'Add a capturing user (1 of 3)',
    'Username for signing in (letters, numbers, dots or dashes, no spaces). For example: nomsa.dlamini');
  if (username === null) return;
  username = username.toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
    ui.alert('That username cannot be used. Use 3 to 40 letters, numbers, dots or dashes, with no spaces.');
    return;
  }
  if (findUser_(username)) {
    ui.alert('The username "' + username + '" already exists. Use "Reset a user\'s password" for an existing user.');
    return;
  }
  var fullName = askText_(ui, 'Add a capturing user (2 of 3)', 'Full name of the person. For example: Nomsa Dlamini');
  if (fullName === null) return;
  var district = askText_(ui, 'Add a capturing user (3 of 3)',
    'District office this person works at. For example: Amathole District, or Head Office');
  if (district === null) return;

  var password = newPassword_();
  var salt = Utilities.getUuid();
  var sheet = getUsersSheet_();
  var row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, USER_HEADERS.length).setNumberFormat('@');
  sheet.getRange(row, 1, 1, USER_HEADERS.length).setValues([[
    username, safeCell_(fullName), safeCell_(district), 'Yes', hashPassword_(password, salt), salt, ''
  ]]);
  showPassword_(ui, 'User added', username, password);
}

/** Menu: give an existing user a new password (also unlocks the account). */
function resetPassword() {
  var ui = SpreadsheetApp.getUi();
  var username = askText_(ui, "Reset a user's password", 'Username of the person:');
  if (username === null) return;
  var user = findUser_(username.toLowerCase());
  if (!user) {
    ui.alert('There is no user called "' + username + '". Check the Users tab.');
    return;
  }
  var password = newPassword_();
  var salt = Utilities.getUuid();
  var sheet = getUsersSheet_();
  sheet.getRange(user.row, 5, 1, 2).setValues([[hashPassword_(password, salt), salt]]);
  CacheService.getScriptCache().remove('fail:' + user.username);
  showPassword_(ui, 'Password reset', user.username, password);
}

function askText_(ui, title, prompt) {
  var answer = ui.prompt(title, prompt, ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return null;
  var text = answer.getResponseText().replace(/\s+/g, ' ').trim();
  if (!text) { ui.alert('Nothing was entered, so nothing was changed.'); return null; }
  return text;
}

function showPassword_(ui, title, username, password) {
  ui.alert(title,
    'Give these sign-in details to the user:\n\n' +
    'Username: ' + username + '\nPassword: ' + password + '\n\n' +
    'Write the password down now. It is stored in coded form and cannot be shown again. ' +
    'If it is lost, use "Reset a user\'s password".\n\n' +
    'To stop someone signing in, change "Active" to No in the Users tab.',
    ui.ButtonSet.OK);
}

/* =====================================================================
 * Web app
 * ===================================================================== */

/** Opening the Web App URL in a browser shows that it is alive. */
function doGet() {
  // "uploads" and "capture" tell the website which features this version has.
  return json_({ ok: true, service: 'EPWP general worker applications', uploads: true, capture: true });
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

  try {
    switch (data.action) {
      case 'login': return json_(login_(data));
      case 'logout': return json_(logout_(data));
      case 'lookup': return json_(lookup_(data));
      case 'capture': return json_(saveApplication_(data, sessionUser_(data.token)));
      default: return json_(saveApplication_(data, null));
    }
  } catch (err) {
    if (err && err.authError) {
      return json_({ ok: false, error: 'auth', message: 'Your sign-in has ended. Please sign in again.' });
    }
    console.error(err);
    return json_({ ok: false, error: 'server', message: 'Something went wrong. Please try again.' });
  }
}

/* ---------- applications ---------- */

/**
 * Saves one application. user is null for an online application, or the
 * signed-in staff member for a captured paper application.
 */
function saveApplication_(data, user) {
  var captured = !!user;

  if (!captured) {
    // Honeypot: real applicants never fill this hidden field in.
    if (data.website) return { ok: true, ref: makeReference_(new Date(), 0) };
    if (new Date().getTime() > new Date(CLOSING).getTime()) {
      return { ok: false, error: 'closed', message: 'Applications are closed.' };
    }
  }

  var record = clean_(data);
  var capture = captured ? cleanCapture_(data) : null;
  var problem = validate_(record, data, captured) ||
    (captured ? validateCapture_(capture) : '') ||
    validateDocuments_(data.Documents, !captured);
  if (problem) return { ok: false, error: 'invalid', message: problem };

  var saved = {};
  var lock = null;
  try {
    // Refuse a repeat application before spending time on the uploads.
    var early = findApplication_(getSheet_(), record.SouthAfricanID);
    if (early) return duplicateReply_(early, record.Surname, captured);

    // Saving to Drive is slow, so it is done before taking the lock.
    saved = saveDocuments_(record, data.Documents);

    lock = LockService.getScriptLock();
    try {
      lock.waitLock(25000);
    } catch (err) {
      lock = null;
      trash_(saved);
      return { ok: false, error: 'busy', message: 'The system is busy. Please try again in a minute.' };
    }

    var sheet = getSheet_();
    var duplicate = findApplication_(sheet, record.SouthAfricanID);
    if (duplicate) {
      trash_(saved);
      return duplicateReply_(duplicate, record.Surname, captured);
    }

    var lastRow = sheet.getLastRow();
    var now = new Date();
    var ref = makeReference_(now, nextNumber_(lastRow));
    nameDocuments_(saved, ref, record);

    var values = { Timestamp: now, Reference: ref };
    FIELDS.forEach(function (f) { values[f] = safeCell_(record[f]); });
    values.Consent = captured ? 'Yes (signed on paper form)' : 'Yes';
    DOCUMENTS.forEach(function (key, i) { values[DOCUMENT_HEADERS[i]] = saved[key] ? saved[key].getUrl() : ''; });
    values['Channel'] = captured ? 'Captured' : 'Online';
    if (captured) {
      values['Captured By'] = safeCell_(user.name + ' (' + user.username + ')');
      values['Captured By District'] = safeCell_(user.district);
      values['Date Received'] = capture.ReceivedDate;
      values['Received At'] = safeCell_(capture.ReceivedAt);
      values['Paper Documents'] = capture.PaperDocuments;
    }
    var row = HEADERS.map(function (h) { return values[h] === undefined ? '' : values[h]; });

    // Keep ID numbers, cellphone numbers and ward numbers as text so that
    // leading zeros survive and long numbers are not rounded.
    sheet.getRange(lastRow + 1, 2, 1, HEADERS.length - 1).setNumberFormat('@');
    sheet.getRange(lastRow + 1, 1, 1, HEADERS.length).setValues([row]);
    SpreadsheetApp.flush();

    return { ok: true, ref: ref, submitted: formatWhen_(now) };
  } catch (err) {
    trash_(saved);
    throw err;
  } finally {
    if (lock) lock.releaseLock();
  }
}

/**
 * Is there already an application for this ID number? Applicants must also
 * give the surname, and only see the reference number when it matches, so
 * that typing in someone else's ID number reveals nothing useful.
 * Signed-in staff see the full details.
 */
function lookup_(data) {
  var id = String(data.SouthAfricanID || '').replace(/\D/g, '');
  if (!idBirthDate_(id)) return { ok: false, error: 'invalid', message: 'The ID number is not valid.' };
  var user = data.token ? sessionUser_(data.token) : null;
  var found = findApplication_(getSheet_(), id);
  if (!found) return { ok: true, found: false };
  var reply = duplicateReply_(found, String(data.Surname || ''), !!user);
  reply.ok = true;
  reply.found = true;
  return reply;
}

function duplicateReply_(found, surname, forStaff) {
  var reply = {
    ok: false,
    error: 'duplicate',
    message: 'An application with this ID number has already been received.'
  };
  if (!forStaff && !sameSurname_(found.surname, surname)) return reply;

  reply.ref = found.ref;
  reply.channel = found.channel;
  reply.submitted = found.when;
  if (found.channel === 'Captured') {
    var district = displayDistrict_(found.capturedDistrict);
    reply.office = found.receivedAt || (district ? 'the ' + district + ' office' : '');
    reply.received = found.dateReceived;
  }
  if (forStaff) {
    reply.applicant = found.name + ' ' + found.surname;
    reply.capturedBy = found.capturedBy;
  }
  return reply;
}

function sameSurname_(a, b) {
  var norm = function (s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); };
  return !!norm(b) && norm(a) === norm(b);
}

/* ---------- staff sign-in ---------- */

function login_(data) {
  var username = String(data.username || '').trim().toLowerCase();
  var password = String(data.password || '');
  var wrong = { ok: false, error: 'login', message: 'The username or password is not correct.' };
  if (!username || !password) return wrong;

  var cache = CacheService.getScriptCache();
  var failKey = 'fail:' + username;
  var fails = Number(cache.get(failKey)) || 0;
  if (fails >= MAX_FAILED_LOGINS) {
    return { ok: false, error: 'locked', message: 'Too many wrong passwords. Wait 15 minutes, or ask the administrator to reset your password.' };
  }

  var user = findUser_(username);
  if (!user || !user.hash || hashPassword_(password, user.salt) !== user.hash) {
    cache.put(failKey, String(fails + 1), LOCK_SECONDS);
    return wrong;
  }
  if (!user.active) {
    return { ok: false, error: 'login', message: 'This account has been switched off. Contact the administrator.' };
  }

  cache.remove(failKey);
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  cache.put('session:' + token, JSON.stringify({ username: user.username }), SESSION_SECONDS);
  getUsersSheet_().getRange(user.row, 7).setValue(new Date());

  return {
    ok: true,
    token: token,
    name: user.name,
    district: user.district,
    username: user.username,
    expires: Date.now() + SESSION_SECONDS * 1000
  };
}

function logout_(data) {
  if (data.token) CacheService.getScriptCache().remove('session:' + data.token);
  return { ok: true };
}

/** The signed-in user for a token. Throws an auth error if there is none. */
function sessionUser_(token) {
  var fail = function () { var err = new Error('auth'); err.authError = true; throw err; };
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) fail();
  var stored = CacheService.getScriptCache().get('session:' + token);
  if (!stored) fail();
  // Look the user up again so that switching an account off takes effect at once.
  var user = findUser_(JSON.parse(stored).username);
  if (!user || !user.active) fail();
  return user;
}

function getUsersSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(USERS_SHEET);
    sheet.getRange(1, 1, 1, USER_HEADERS.length)
      .setValues([USER_HEADERS])
      .setFontWeight('bold')
      .setBackground('#0a6b3d')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 7, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }
  return sheet;
}

function findUser_(username) {
  var sheet = getUsersSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var rows = sheet.getRange(2, 1, last - 1, USER_HEADERS.length).getDisplayValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === username) {
      return {
        row: i + 2,
        username: String(rows[i][0]).trim().toLowerCase(),
        name: rows[i][1],
        district: rows[i][2],
        active: /^(yes|y|true)$/i.test(String(rows[i][3]).trim()),
        hash: rows[i][4],
        salt: rows[i][5]
      };
    }
  }
  return null;
}

function hashPassword_(password, salt) {
  var value = salt + ':' + password;
  for (var i = 0; i < HASH_ROUNDS; i++) {
    value = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value + ':' + salt, Utilities.Charset.UTF_8)
      .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  }
  return value;
}

/** A random password that is easy to read out: for example "Kq7m-Xp4t-Rw9z". */
function newPassword_() {
  var letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  var digits = '23456789';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
  var parts = [];
  for (var p = 0; p < 3; p++) {
    var part = '';
    for (var i = 0; i < 4; i++) {
      var b = bytes[p * 4 + i] & 0xff;
      part += i === 2 ? digits.charAt(b % digits.length) : letters.charAt(b % letters.length);
    }
    parts.push(part);
  }
  return parts.join('-');
}

/* =====================================================================
 * Sheet helpers
 * ===================================================================== */

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

/** Details of the application for this ID number, or null if there is none. */
function findApplication_(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var idCol = HEADERS.indexOf('SouthAfricanID') + 1;
  var ids = sheet.getRange(2, idCol, lastRow - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).replace(/\D/g, '') === id) {
      var row = sheet.getRange(i + 2, 1, 1, HEADERS.length).getValues()[0];
      var get = function (h) { return row[HEADERS.indexOf(h)]; };
      var stamp = get('Timestamp');
      return {
        ref: String(get('Reference')),
        name: String(get('Name')),
        surname: String(get('Surname')),
        // Rows saved before the Channel column existed were all online.
        channel: get('Channel') === 'Captured' ? 'Captured' : 'Online',
        capturedBy: String(get('Captured By') || ''),
        capturedDistrict: String(get('Captured By District') || ''),
        receivedAt: String(get('Received At') || ''),
        dateReceived: formatDay_(get('Date Received')),
        when: stamp instanceof Date ? formatWhen_(stamp) : String(stamp || '')
      };
    }
  }
  return null;
}

function nextNumber_(lastRow) {
  var props = PropertiesService.getScriptProperties();
  var counter = Math.max(Number(props.getProperty('counter')) || 0, lastRow - 1) + 1;
  props.setProperty('counter', String(counter));
  return counter;
}

/** For example EPWP-20261117-1432-000123: date, time (SA time) and running number. */
function makeReference_(date, number) {
  return REF_PREFIX + Utilities.formatDate(date, TIME_ZONE, 'yyyyMMdd-HHmm') + '-' + ('000000' + number).slice(-6);
}

function formatWhen_(date) {
  return Utilities.formatDate(date, TIME_ZONE, "d MMMM yyyy 'at' HH:mm");
}

/** "2026-11-14" (or a date cell) as "14 November 2026". */
function formatDay_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, TIME_ZONE, 'd MMMM yyyy');
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return String(value || '');
  var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                'September', 'October', 'November', 'December'];
  return Number(m[3]) + ' ' + months[Number(m[2]) - 1] + ' ' + m[1];
}

function displayDistrict_(district) {
  return DISTRICT_NAMES[district] || district;
}

/* =====================================================================
 * Supporting documents
 * ===================================================================== */

function getFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('folderId');
  if (id) {
    try {
      var existing = DriveApp.getFolderById(id);
      if (!existing.isTrashed()) return existing;
    } catch (err) { /* folder was removed: make a new one below */ }
  }
  // Put the folder next to this spreadsheet so that it is easy to find.
  var parents = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getParents();
  var parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  var folder = parent.createFolder(FOLDER_NAME);
  props.setProperty('folderId', folder.getId());
  return folder;
}

/** The sub-folder for one district, created the first time it is needed. */
function getDistrictFolder_(district) {
  var name = displayDistrict_(district) || 'Unknown district';
  var root = getFolder_();
  var found = root.getFoldersByName(name);
  return found.hasNext() ? found.next() : root.createFolder(name);
}

/**
 * Online applications must include both documents. Captured paper
 * applications may include scans, but do not have to.
 */
function validateDocuments_(docs, required) {
  var missing = 'Please attach both supporting documents. Refresh the page and try again.';
  if (!docs || typeof docs !== 'object') return required ? missing : '';
  for (var i = 0; i < DOCUMENTS.length; i++) {
    var doc = docs[DOCUMENTS[i]];
    if (!doc) {
      if (required) return missing;
      continue;
    }
    if (typeof doc.data !== 'string' || !doc.data) return missing;
    if (!FILE_TYPES[doc.type]) return 'Supporting documents must be photos (JPG or PNG) or PDF files.';
    if (!/^[A-Za-z0-9+\/]+=*$/.test(doc.data)) return 'A supporting document could not be read. Please choose the file again.';
    if (doc.data.length * 0.75 > MAX_FILE_BYTES) return 'A supporting document is too big. Each file must be smaller than 4 MB.';
  }
  return '';
}

/** Saves the files to the district's Drive folder. Returns { IDCopy: file, ... }. */
function saveDocuments_(record, docs) {
  var saved = {};
  if (!docs) return saved;
  var keys = DOCUMENTS.filter(function (key) { return docs[key]; });
  if (!keys.length) return saved;
  var folder = getDistrictFolder_(record.District);
  try {
    keys.forEach(function (key) {
      var doc = docs[key];
      var name = record.SouthAfricanID + '_' + key + '.' + FILE_TYPES[doc.type];
      var blob = Utilities.newBlob(Utilities.base64Decode(doc.data), doc.type, name);
      saved[key] = folder.createFile(blob);
    });
  } catch (err) {
    trash_(saved);
    throw err;
  }
  return saved;
}

/** Once the reference number is known, put it at the front of the file names. */
function nameDocuments_(saved, ref, record) {
  var owner = (record.Surname + '_' + record.Name).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60);
  Object.keys(saved).forEach(function (key) {
    var file = saved[key];
    var ext = file.getName().split('.').pop();
    try {
      file.setName(ref + '_' + owner + '_' + DOCUMENT_FILE_LABELS[key] + '.' + ext);
      file.setDescription('EPWP application ' + ref + ', ID number ' + record.SouthAfricanID);
    } catch (err) { console.error(err); }
  });
}

function trash_(saved) {
  Object.keys(saved || {}).forEach(function (key) {
    try { saved[key].setTrashed(true); } catch (err) { console.error(err); }
  });
}

/* =====================================================================
 * Validation
 * ===================================================================== */

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

function cleanCapture_(data) {
  var text = function (v, max) { return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); };
  var paper = [];
  if (data.PaperID === true) paper.push('ID copy');
  if (data.PaperResults === true) paper.push('Results copy');
  return {
    ReceivedDate: text(data.ReceivedDate, 10),
    ReceivedAt: text(data.ReceivedAt, 120),
    PaperDocuments: paper.length ? paper.join(', ') : 'None',
    SignedOnPaper: data.SignedOnPaper === true
  };
}

function validate_(r, data, captured) {
  for (var i = 0; i < REQUIRED.length; i++) {
    if (!r[REQUIRED[i]]) return 'Please complete all the required fields (' + REQUIRED[i] + ').';
  }
  if (!captured && data.Consent !== true && data.Consent !== 'Yes') return 'Consent is required to apply.';

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

function validateCapture_(c) {
  if (!c.SignedOnPaper) return 'Confirm that the applicant signed the declaration and consent on the paper form.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.ReceivedDate)) return 'Enter the date the paper application was received.';
  var today = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
  if (c.ReceivedDate > today) return 'The date received cannot be in the future.';
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

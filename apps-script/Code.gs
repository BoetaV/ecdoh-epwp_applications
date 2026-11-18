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
 * Staff accounts: capturers request an account on the website and choose
 * their own password. The request arrives in the Users tab as "Pending" and
 * the spreadsheet owner gets an email. The administrator approves it with
 * EPWP > Approve account requests once the signed paper Capturer
 * Registration Form has been received; the approval is recorded for audit.
 *
 * Staff access: a user with a district (for example "Amathole District") can
 * only capture and view applications whose applicant lives in that district,
 * whether they applied online or on paper. A "Provincial (all districts)"
 * user can capture and view everything.
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

// The districts, as stored in an application (the "District" column), with
// the name people see. Staff accounts use the display name.
var DISTRICTS = [
  ['Alfred Nzo District', 'Alfred Nzo District'],
  ['Amathole District', 'Amathole District'],
  ['Buffalo City Metro', 'Buffalo City Metro'],
  ['Chris Hani District', 'Chris Hani District'],
  ['Joe Gqabi District', 'Joe Gqabi District'],
  ['N Mandela Bay MM', 'Nelson Mandela Bay Metro'],
  ['OR Tambo District', 'OR Tambo District'],
  ['Sarah Baartman District', 'Sarah Baartman District']
];
var PROVINCIAL = 'Provincial (all districts)';
var DISTRICT_NAMES = {};
DISTRICTS.forEach(function (d) { DISTRICT_NAMES[d[0]] = d[1]; });
var PAGE_SIZE = 50;
var FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
var MAX_FILE_BYTES = 4 * 1024 * 1024;

var HEADERS = ['Timestamp', 'Reference'].concat(FIELDS).concat(['Consent'])
  .concat(DOCUMENT_HEADERS).concat(CAPTURE_HEADERS);
// The first seven columns are used for signing in; the rest record the
// account request and its approval.
var USER_HEADERS = ['Username', 'Full name', 'District', 'Active', 'Password hash', 'Salt', 'Last sign-in',
  'Title', 'Persal number', 'Job title', 'Office', 'Work phone', 'Cellphone', 'Email',
  'Requested on', 'Paper form received', 'Approved by', 'Approved on'];
var UCOL = {};
USER_HEADERS.forEach(function (h, i) { UCOL[h] = i + 1; });
var PENDING = 'Pending';
var MAX_PENDING = 100;               // refuse new requests while this many are waiting
var MIN_PASSWORD = 8;
// Who is emailed about new account requests. Empty means the spreadsheet owner.
var ADMIN_EMAIL = '';
var SIGN_IN_PAGE = 'https://boetav.github.io/ecdoh-epwp_applications/capture.html';

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
    .addItem('Approve account requests', 'approveRequests')
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
  var district = askDistrict_(ui);
  if (district === null) return;

  var password = newPassword_();
  var salt = Utilities.getUuid();
  appendUser_({
    'Username': username, 'Full name': safeCell_(fullName), 'District': safeCell_(district), 'Active': 'Yes',
    'Password hash': hashPassword_(password, salt), 'Salt': salt,
    'Approved by': adminName_() + ' (added by administrator)', 'Approved on': new Date()
  });
  showPassword_(ui, 'User added', username, password);
}

/** Menu: go through the account requests that are waiting, one at a time. */
function approveRequests() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getUsersSheet_();
  var last = sheet.getLastRow();
  var rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, USER_HEADERS.length).getDisplayValues();
  var pending = [];
  rows.forEach(function (r, i) { if (String(r[UCOL.Active - 1]).trim() === PENDING) pending.push({ row: i + 2, v: r }); });
  if (!pending.length) {
    ui.alert('Account requests', 'There are no account requests waiting for approval.', ui.ButtonSet.OK);
    return;
  }
  var approved = 0, declined = 0;
  for (var i = 0; i < pending.length; i++) {
    var v = pending[i].v;
    var get = function (h) { return v[UCOL[h] - 1]; };
    var answer = ui.alert('Account request ' + (i + 1) + ' of ' + pending.length,
      get('Title') + ' ' + get('Full name') + '\n' +
      'Username: ' + get('Username') + '\n' +
      'Access requested: ' + get('District') + '\n' +
      'Persal number: ' + get('Persal number') + '\n' +
      'Job title: ' + get('Job title') + '\n' +
      'Office: ' + get('Office') + '\n' +
      'Cellphone: ' + get('Cellphone') + '   Work phone: ' + (get('Work phone') || '-') + '\n' +
      'Email: ' + get('Email') + '\n' +
      'Requested on: ' + get('Requested on') + '\n\n' +
      'Only approve once you have the signed paper Capturer Registration Form, approved by the supervisor.\n\n' +
      'YES = approve (records that the paper form was received)\n' +
      'NO = decline\n' +
      'CANCEL = decide later',
      ui.ButtonSet.YES_NO_CANCEL);
    if (answer === ui.Button.CANCEL || answer === ui.Button.CLOSE) break;
    var r = pending[i].row;
    if (answer === ui.Button.YES) {
      sheet.getRange(r, UCOL.Active).setValue('Yes');
      sheet.getRange(r, UCOL['Paper form received']).setValue('Yes');
      approved++;
    } else {
      sheet.getRange(r, UCOL.Active).setValue('No');
      declined++;
    }
    sheet.getRange(r, UCOL['Approved by']).setValue(adminName_() + (answer === ui.Button.YES ? '' : ' (declined)'));
    sheet.getRange(r, UCOL['Approved on']).setValue(new Date());
  }
  ui.alert('Account requests', approved + ' approved, ' + declined + ' declined. ' +
    'Approved capturers can now sign in at ' + SIGN_IN_PAGE + ' with the username and password they chose. ' +
    'Let them know they have been approved.', ui.ButtonSet.OK);
}

function adminName_() {
  var email = '';
  try { email = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail(); } catch (err) { /* ignore */ }
  return email || 'Administrator';
}

/** Adds a row to the Users tab from an object keyed by column heading. */
function appendUser_(values) {
  var sheet = getUsersSheet_();
  var row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, USER_HEADERS.length).setNumberFormat('@');
  [UCOL['Last sign-in'], UCOL['Requested on'], UCOL['Approved on']].forEach(function (c) {
    sheet.getRange(row, c).setNumberFormat('yyyy-mm-dd hh:mm');
  });
  sheet.getRange(row, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS.map(function (h) {
    return values[h] === undefined ? '' : values[h];
  })]);
  return row;
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
  sheet.getRange(user.row, UCOL['Password hash'], 1, 2).setValues([[hashPassword_(password, salt), salt]]);
  CacheService.getScriptCache().remove('fail:' + user.username);
  showPassword_(ui, 'Password reset', user.username, password);
}

/** Asks for one of the districts, or provincial access, by number. */
function askDistrict_(ui) {
  var choices = DISTRICTS.map(function (d) { return d[1]; }).concat([PROVINCIAL]);
  var list = choices.map(function (name, i) { return (i + 1) + '. ' + name; }).join('\n');
  var answer = askText_(ui, 'Add a capturing user (3 of 3)',
    'Which applications may this person capture and see? Type the number:\n\n' + list +
    '\n\nA district user only sees applicants who live in that district. ' +
    'Provincial users (for example Head Office) see everyone.');
  if (answer === null) return null;
  var n = Number(answer);
  if (!(n >= 1 && n <= choices.length && Math.floor(n) === n)) {
    ui.alert('Please type a number from 1 to ' + choices.length + '. The user was not added.');
    return null;
  }
  return choices[n - 1];
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
    'The user signs in at ' + SIGN_IN_PAGE + '. ' +
    'If it is lost, use "Reset a user\'s password".\n\n' +
    'To stop someone signing in, change "Active" to No in the Users tab. ' +
    'To change what someone can see, pick a different District in the Users tab.',
    ui.ButtonSet.OK);
}

/* =====================================================================
 * Web app
 * ===================================================================== */

/** Opening the Web App URL in a browser shows that it is alive. */
function doGet() {
  // "uploads" and "capture" tell the website which features this version has.
  return json_({ ok: true, service: 'EPWP general worker applications', uploads: true, capture: true, accountRequests: true });
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
      case 'request-account': return json_(requestAccount_(data));
      case 'logout': return json_(logout_(data));
      case 'lookup': return json_(lookup_(data));
      case 'capture': return json_(saveApplication_(data, sessionUser_(data.token)));
      case 'list': return json_(list_(data, sessionUser_(data.token)));
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
  if (captured && record.District && !canSee_(user, record.District)) {
    return { ok: false, error: 'invalid', message: 'You can only capture applications from ' + user.district + '.' };
  }
  var problem = validate_(record, data, captured) ||
    (captured ? validateCapture_(capture) : '') ||
    validateDocuments_(data.Documents, !captured);
  if (problem) return { ok: false, error: 'invalid', message: problem };

  var saved = {};
  var lock = null;
  try {
    // Refuse a repeat application before spending time on the uploads.
    var early = findApplication_(getSheet_(), record.SouthAfricanID);
    if (early) return duplicateReply_(early, record.Surname, user);

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
      return duplicateReply_(duplicate, record.Surname, user);
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
  var reply = duplicateReply_(found, String(data.Surname || ''), user);
  reply.ok = true;
  reply.found = true;
  return reply;
}

/**
 * What to say about an existing application. staff is the signed-in user, or
 * null for the public. Applicants only get details when the surname matches.
 * Staff only get details for applicants in their own district; for another
 * district they are told just that, so that nobody captures it twice.
 */
function duplicateReply_(found, surname, staff) {
  var reply = {
    ok: false,
    error: 'duplicate',
    message: 'An application with this ID number has already been received.'
  };
  if (staff && !canSee_(staff, found.district)) {
    reply.otherDistrict = displayDistrict_(found.district) || 'another district';
    return reply;
  }
  if (!staff && !sameSurname_(found.surname, surname)) return reply;

  reply.ref = found.ref;
  reply.channel = found.channel;
  reply.submitted = found.when;
  if (found.channel === 'Captured') {
    var district = displayDistrict_(found.capturedDistrict);
    reply.office = found.receivedAt || (district ? 'the ' + district + ' office' : '');
    reply.received = found.dateReceived;
  }
  if (staff) {
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
  if (user.status === PENDING) {
    return { ok: false, error: 'pending', message: 'Your account request has not been approved yet. Hand in your signed paper registration form to your EPWP District Coordinator. You can sign in once the administrator has approved it.' };
  }
  if (!user.active) {
    return { ok: false, error: 'login', message: 'This account has been switched off. Contact the administrator.' };
  }
  if (!user.provincial && !user.districtCode) {
    return { ok: false, error: 'login', message: 'Your account does not have a district yet. Ask the administrator to choose one in the Users tab.' };
  }

  cache.remove(failKey);
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  cache.put('session:' + token, JSON.stringify({ username: user.username }), SESSION_SECONDS);
  getUsersSheet_().getRange(user.row, UCOL['Last sign-in']).setValue(new Date());

  return {
    ok: true,
    token: token,
    name: user.name,
    district: user.district,
    districtCode: user.districtCode,
    provincial: user.provincial,
    districts: DISTRICTS.map(function (d) { return { code: d[0], name: d[1] }; }),
    username: user.username,
    expires: Date.now() + SESSION_SECONDS * 1000
  };
}

/** A capturer asks for an account. It stays "Pending" until the administrator approves it. */
function requestAccount_(data) {
  if (data.website) return { ok: true };   // honeypot
  var text = function (v, max) { return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); };
  var phoneNo = function (v) { return text(v, 20).replace(/[^\d+]/g, '').replace(/^\+27/, '0'); };
  var r = {
    title: text(data.Title, 10),
    first: text(data.FirstNames, 80),
    surname: text(data.Surname, 80),
    persal: text(data.Persal, 20).replace(/\s/g, ''),
    job: text(data.JobTitle, 100),
    office: text(data.Office, 200),
    work: phoneNo(data.WorkPhone),
    cell: phoneNo(data.Cellphone),
    email: text(data.Email, 120),
    access: text(data.Access, 40),
    username: text(data.Username, 40).toLowerCase(),
    password: String(data.Password || '')
  };
  var bad = function (message) { return { ok: false, error: 'invalid', message: message }; };
  if (['Mr', 'Ms', 'Mrs', 'Dr'].indexOf(r.title) === -1) return bad('Choose your title.');
  if (!r.first || !r.surname) return bad('Enter your first name(s) and surname.');
  if (!/^[A-Za-z0-9]{5,12}$/.test(r.persal)) return bad('Enter your Persal or employee number (5 to 12 letters or numbers).');
  if (!r.job) return bad('Enter your job title.');
  if (!r.office) return bad('Enter the office or facility where you work.');
  if (!/^0\d{9}$/.test(r.cell)) return bad('The cellphone number must have 10 digits and start with 0.');
  if (r.work && !/^0\d{9}$/.test(r.work)) return bad('The work telephone number must have 10 digits and start with 0.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) return bad('Enter a valid email address.');
  var access = r.access.toLowerCase() === PROVINCIAL.toLowerCase() ? PROVINCIAL : displayDistrict_(districtCode_(r.access));
  if (!access) return bad('Choose the district you capture for.');
  if (!/^[a-z0-9._-]{3,40}$/.test(r.username)) return bad('The username can only use letters, numbers, dots or dashes (3 to 40, no spaces).');
  if (r.password.length < MIN_PASSWORD) return bad('The password must have at least ' + MIN_PASSWORD + ' characters.');
  if (r.password.toLowerCase().indexOf(r.username) !== -1) return bad('The password may not contain your username.');
  if (data.Agree !== true) return bad('Tick the box to confirm the declaration.');

  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (err) {
    return { ok: false, error: 'busy', message: 'The system is busy. Please try again in a minute.' };
  }
  try {
    if (findUser_(r.username)) return bad('That username is already taken. Choose another one, for example by adding your initials.');
    var sheet = getUsersSheet_();
    var last = sheet.getLastRow();
    var statuses = last < 2 ? [] : sheet.getRange(2, UCOL.Active, last - 1, 1).getDisplayValues();
    var waiting = statuses.filter(function (row) { return row[0] === PENDING; }).length;
    if (waiting >= MAX_PENDING) {
      return { ok: false, error: 'busy', message: 'Too many requests are waiting for approval. Please try again later.' };
    }
    var salt = Utilities.getUuid();
    var fullName = r.first + ' ' + r.surname;
    appendUser_({
      'Username': r.username, 'Full name': safeCell_(fullName), 'District': access, 'Active': PENDING,
      'Password hash': hashPassword_(r.password, salt), 'Salt': salt,
      'Title': r.title, 'Persal number': safeCell_(r.persal), 'Job title': safeCell_(r.job),
      'Office': safeCell_(r.office), 'Work phone': r.work, 'Cellphone': r.cell, 'Email': safeCell_(r.email),
      'Requested on': new Date(), 'Paper form received': 'No'
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  notifyAdmin_(r, access);
  return { ok: true, username: r.username };
}

/** Emails the administrator about a new account request. Never stops the request. */
function notifyAdmin_(r, access) {
  try {
    var to = ADMIN_EMAIL || Session.getEffectiveUser().getEmail();
    if (!to) return;
    MailApp.sendEmail(to, 'EPWP: new capturer account request from ' + r.first + ' ' + r.surname,
      'A new capturer account has been requested on the EPWP applications system.\n\n' +
      'Name: ' + r.title + ' ' + r.first + ' ' + r.surname + '\n' +
      'Username: ' + r.username + '\n' +
      'Access requested: ' + access + '\n' +
      'Persal number: ' + r.persal + '\n' +
      'Job title: ' + r.job + '\n' +
      'Office: ' + r.office + '\n' +
      'Cellphone: ' + r.cell + '\n' +
      'Email: ' + r.email + '\n\n' +
      'When the signed paper Capturer Registration Form has been received, open the spreadsheet and choose ' +
      'EPWP > Approve account requests.\n\n' + SpreadsheetApp.getActiveSpreadsheet().getUrl());
  } catch (err) {
    console.error(err);
  }
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
  if (!user || !user.active || (!user.provincial && !user.districtCode)) fail();
  return user;
}

function getUsersSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(USERS_SHEET) || ss.insertSheet(USERS_SHEET);
  var width = sheet.getLastColumn();
  var current = width ? sheet.getRange(1, 1, 1, width).getDisplayValues()[0].join('|') : '';
  if (current !== USER_HEADERS.join('|')) {
    // New sheet, or one from an earlier version: (re)write the headings.
    // New columns are only ever added at the end, so existing rows stay valid.
    sheet.getRange(1, 1, 1, USER_HEADERS.length)
      .setValues([USER_HEADERS])
      .setFontWeight('bold')
      .setBackground('#0a6b3d')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    var rows = sheet.getMaxRows() - 1;
    sheet.getRange(2, UCOL.District, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(DISTRICTS.map(function (d) { return d[1]; }).concat([PROVINCIAL]), true)
      .setAllowInvalid(false).build());
    sheet.getRange(2, UCOL.Active, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList([PENDING, 'Yes', 'No'], true).setAllowInvalid(false).build());
    sheet.getRange(2, UCOL['Paper form received'], rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['Yes', 'No'], true).setAllowInvalid(false).build());
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
      var access = String(rows[i][2]).trim();
      return {
        row: i + 2,
        username: String(rows[i][0]).trim().toLowerCase(),
        name: rows[i][1],
        district: access,
        provincial: access.toLowerCase() === PROVINCIAL.toLowerCase(),
        districtCode: districtCode_(access),
        status: String(rows[i][UCOL.Active - 1]).trim(),
        active: /^(yes|y|true)$/i.test(String(rows[i][UCOL.Active - 1]).trim()),
        hash: rows[i][UCOL['Password hash'] - 1],
        salt: rows[i][UCOL.Salt - 1]
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
        district: String(get('District')),
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

/** The application "District" value for a district name, or '' if it is not one. */
function districtCode_(name) {
  var n = String(name || '').trim().toLowerCase();
  for (var i = 0; i < DISTRICTS.length; i++) {
    if (DISTRICTS[i][0].toLowerCase() === n || DISTRICTS[i][1].toLowerCase() === n) return DISTRICTS[i][0];
  }
  return '';
}

/** May this staff member see (and capture) an applicant from this district? */
function canSee_(user, applicantDistrict) {
  if (user.provincial) return true;
  return !!user.districtCode && districtCode_(applicantDistrict) === user.districtCode;
}

/**
 * Applications this staff member may see, newest first, PAGE_SIZE at a time.
 * Filters: district (provincial users only), channel and a search text.
 */
function list_(data, user) {
  var sheet = getSheet_();
  var last = sheet.getLastRow();
  var values = last < 2 ? [] : sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var col = {};
  HEADERS.forEach(function (h, i) { col[h] = i; });

  var district = user.provincial ? districtCode_(data.district) : user.districtCode;
  var channel = data.channel === 'Online' || data.channel === 'Captured' ? data.channel : '';
  var words = String(data.search || '').toLowerCase().replace(/[^a-z0-9 -]/g, ' ').split(/\s+/).filter(String);

  var inScope = [];
  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i];
    var rowDistrict = String(row[col.District]);
    if (!canSee_(user, rowDistrict)) continue;
    if (district && districtCode_(rowDistrict) !== district) continue;
    inScope.push(row);
  }

  var counts = { all: inScope.length, online: 0, captured: 0 };
  var matches = inScope.filter(function (row) {
    var rowChannel = row[col.Channel] === 'Captured' ? 'Captured' : 'Online';
    if (rowChannel === 'Captured') counts.captured++; else counts.online++;
    if (channel && rowChannel !== channel) return false;
    if (!words.length) return true;
    var text = [row[col.Reference], row[col.Name], row[col.Surname], row[col.SouthAfricanID],
      row[col.CellphoneNumber], row[col.LocalMunicipality], row[col.NearestFacility]].join(' ').toLowerCase();
    return words.every(function (w) { return text.indexOf(w) !== -1; });
  });

  var offset = Math.max(0, Math.floor(Number(data.offset) || 0));
  var page = matches.slice(offset, offset + PAGE_SIZE).map(function (row) {
    var stamp = row[col.Timestamp];
    var link = function (h) { var v = String(row[col[h]] || ''); return /^https:\/\/drive\.google\.com\//.test(v) ? v : ''; };
    return {
      ref: String(row[col.Reference]),
      when: stamp instanceof Date ? Utilities.formatDate(stamp, TIME_ZONE, 'yyyy-MM-dd HH:mm') : String(stamp || ''),
      name: String(row[col.Name]),
      surname: String(row[col.Surname]),
      id: String(row[col.SouthAfricanID]),
      gender: String(row[col.Gender]),
      cell: String(row[col.CellphoneNumber]),
      district: displayDistrict_(String(row[col.District])),
      local: String(row[col.LocalMunicipality]),
      ward: String(row[col.MunicipalWardNo]),
      facility: String(row[col.NearestFacility]),
      qualification: String(row[col.HighestSchoolLevel]),
      channel: row[col.Channel] === 'Captured' ? 'Captured' : 'Online',
      capturedBy: String(row[col['Captured By']] || ''),
      dateReceived: formatDay_(row[col['Date Received']]),
      idDoc: link('ID Document (link)'),
      resultsDoc: link('Proof of Results (link)')
    };
  });

  return {
    ok: true,
    scope: user.provincial ? (district ? displayDistrict_(district) : 'All districts') : user.district,
    counts: counts,
    total: matches.length,
    offset: offset,
    pageSize: PAGE_SIZE,
    rows: page
  };
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

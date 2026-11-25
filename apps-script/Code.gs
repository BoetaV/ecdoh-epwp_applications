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
 * only capture, view and download applications whose applicant lives in that
 * district, whether they applied online or on paper. A "Provincial (all
 * districts)" user can capture, view and download everything. Every download
 * is recorded in the "Downloads" tab. The staff dashboard (counts only)
 * and the Selection screens follow the same rules.
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
var CLOSING = '2026-11-24T23:59:59+02:00';
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
var DOWNLOADS_SHEET = 'Downloads';
var DOWNLOAD_HEADERS = ['Timestamp', 'Username', 'Name', 'Access', 'Downloaded', 'Filters', 'Rows'];

// Columns of the Excel download, in order: [heading in Excel, column in the Applications tab].
var EXPORT_COLUMNS = [
  ['Reference', 'Reference'], ['Received (date and time)', 'Timestamp'], ['How applied', 'Channel'],
  ['Title', 'Title'], ['First name(s)', 'Name'], ['Surname', 'Surname'], ['ID number', 'SouthAfricanID'],
  ['Date of birth', 'DateOfBirth'], ['Gender', 'Gender'], ['Disability', 'DisabilityStatus'],
  ['Home address', 'CurrentAddress'], ['Cellphone', 'CellphoneNumber'], ['Alternative number', 'AlternativeNumber'],
  ['Email', 'EmailAddress'], ['District', 'District'], ['Local municipality', 'LocalMunicipality'],
  ['Ward', 'MunicipalWardNo'], ['Nearest facility', 'NearestFacility'], ['Qualification', 'HighestSchoolLevel'],
  ['Practical skills', 'PracticalSkills'], ['Other skills', 'OtherSkills'], ['Consent', 'Consent'],
  ['Paper form received on', 'Date Received'], ['Handed in at', 'Received At'], ['Paper documents', 'Paper Documents'],
  ['Captured by', 'Captured By'], ['Captured by district', 'Captured By District'],
  ['ID document', 'ID Document (link)'], ['Proof of results', 'Proof of Results (link)']
];
var FILE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
var MAX_FILE_BYTES = 4 * 1024 * 1024;

var HEADERS = ['Timestamp', 'Reference'].concat(FIELDS).concat(['Consent'])
  .concat(DOCUMENT_HEADERS).concat(CAPTURE_HEADERS);
// The first seven columns are used for signing in; the rest record the
// account request and its approval.
var USER_HEADERS = ['Username', 'Full name', 'District', 'Active', 'Password hash', 'Salt', 'Last sign-in',
  'Title', 'Persal number', 'Job title', 'Office', 'Work phone', 'Cellphone', 'Email',
  'Requested on', 'Paper form received', 'Approved by', 'Approved on', 'Selection access'];
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
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Import a list')
      .addItem('1. Open the Import tab', 'openImportTab')
      .addItem('2. Check the list (changes nothing)', 'checkImport')
      .addItem('3. Import the ready rows into Applications', 'runImport')
      .addItem('Clear the Import tab for a new list', 'clearImportTab'))
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
 * Importing a list that was captured somewhere else (for example in Excel)
 *
 * The list is pasted into the "Import" tab with its headings in row 1.
 * Columns are recognised by their heading; other columns are ignored.
 * "Check" fills in the result columns without changing anything; "Import"
 * adds the ready rows to Applications as captured paper applications.
 * Rules:
 *  - Cellphone numbers that lost their leading 0 get it back.
 *  - ID numbers that lost their leading 0 (born 2000 to 2009) get it back,
 *    but only when the age in the list agrees with the date in the ID.
 *  - ID numbers that are not valid are rejected, as are people outside the
 *    age range, and anyone whose ID number is already in Applications or
 *    earlier in the same list.
 *  - Gender F/M becomes Female/Male. A missing gender is taken from the ID
 *    number (digits 7 to 10: 0000-4999 female, 5000-9999 male).
 *  - The local municipality comes from a municipality column, or else from
 *    the institution (facility) in the facility list.
 *  - The qualification is kept as captured (tidied up). It is not checked
 *    against the qualifications offered on the online form.
 * ===================================================================== */

var IMPORT_SHEET = 'Import';
var IMPORT_RESULTS = ['Import status', 'Reference', 'ID number used', 'Cellphone used',
  'District used', 'Local municipality used', 'Facility used', 'Notes'];
var IMPORT_TEMPLATE = ['Title', 'Name', 'Surname', 'Identity No.', 'Age', 'Gender', 'Disability',
  'Contact No.', 'Alternative No.', 'Email', 'Address', 'District', 'Local Municipality', 'Institution',
  'Ward', 'Qualification', 'Qualification Attached (Yes/No)', 'ID Attached (Yes/No)', 'Date Received'];
// Headings recognised in the Import tab, in lower case with only letters and digits.
// When two columns have recognised headings for the same thing, the first one is used.
var IMPORT_ALIASES = {
  Title: ['title'],
  Name: ['name', 'names', 'firstname', 'firstnames', 'fullnames', 'forenames'],
  Surname: ['surname', 'lastname'],
  SouthAfricanID: ['identityno', 'identitynumber', 'idno', 'idnumber', 'id', 'said', 'southafricanid', 'rsaid', 'rsaidnumber'],
  Age: ['age'],
  Gender: ['gender', 'sex'],
  DisabilityStatus: ['disability', 'disabilitystatus', 'disabled'],
  CellphoneNumber: ['contactno', 'contactnumber', 'cellphone', 'cellphonenumber', 'cellno', 'cellnumber', 'cell',
    'phone', 'telephone', 'telno', 'mobile'],
  AlternativeNumber: ['alternativeno', 'alternativenumber', 'altno', 'alternativecontact'],
  EmailAddress: ['email', 'emailaddress'],
  CurrentAddress: ['address', 'homeaddress', 'currentaddress', 'residentialaddress'],
  District: ['district', 'districtmetro'],
  LocalMunicipality: ['localmunicipality', 'municipality', 'lm'],
  NearestFacility: ['institution', 'facility', 'nearestfacility', 'hospital', 'clinic'],
  MunicipalWardNo: ['ward', 'wardno', 'wardnumber', 'municipalwardno'],
  HighestSchoolLevel: ['qualification', 'highestqualification', 'highestschoollevel'],
  PracticalSkills: ['practicalskills', 'skills'],
  OtherSkills: ['otherskills'],
  DateReceived: ['datereceived', 'received', 'datesubmitted'],
  QualificationAttached: ['qualificationattached', 'resultsattached'],
  IDAttached: ['idattached', 'idcopyattached', 'idcopy']
};
var IMPORT_COLOURS = { Ready: '#d9f2e3', Imported: '#a8dcbf', Rejected: '#f8d0cc', Duplicate: '#fde3b3' };

// BEGIN UNITS (generated by tools/build_units.py - do not edit by hand)
var UNITS = {"Alfred Nzo District":{"Matatiele Local Municipality":["Khotsong Hospital","Maluti CHC","Tayler Bequest Matatiele Hosp"],"Ntabankulu Local Municipality":["Tabankulu CHC","Sipetu Hosp","Meje CHC"],"Umzimvubu Local Municipality":["Madzikane Kazulu Hospital","Mt Ayliff Hosp"],"Winnie Madikizela-Mandela Local Municipality":["St Patricks/ORATH","Greenville Hosp"]},"Amathole District":{"Amahlathi Local Municipality":["Stutterheim Hospital","SS Gida Hosp","Tower Hospital"],"Enoch Mgijima Local Municipality":["Cathcart Hosp"],"Great Kei Local Municipality":["Komga Hosp"],"Mbhashe Local Municipality":["Idutywa Village CHC","Willowvale CHC","Xhora CHC","Madwaleni Hosp"],"Mnquma Local Municipality":["Butterworth Hospital","Nqamakwe CHC","Tafalofefe Hosp"],"Ngqushwa Local Municipality":["Nompumelelo Hosp"],"Raymond Mhlaba Local Municipality":["Adelaide Hosp","Bedford Hosp","Middledrift CHC","Victoria Hospital","Fort Beaufort Hosp"]},"Buffalo City Metro":{"Buffalo City Metropolitan Municipality":["Bhisho Hospital","D Village CHC","Dimbaza CHC","Empilweni Gompo CHC","Grey Hospital","Mt Coke CHC","Nkqubela Hospital","Nontyatyambo CHC","Head Office"]},"Chris Hani District":{"Emalahleni Local Municipality":["Indwe Hosp","Dordrecht Hosp"],"Engcobo Local Municipality":["All Saints Hospital","Ngcobo CHC","Z Dalasile CHC"],"Enoch Mgijima Local Municipality":["Frontier Hospital","Martje Venter Hospital","Glen Grey Hospital","Komani Hospitals","Kuyasa CHC","Ngonyama CHC","Nomzamo CHC","Thornhill CHC","Whittlesea CHC","Wilhelm Stahl","Hewu Hospital","Sterkstroom Hosp"],"Intsika Yethu Local Municipality":["Cofimvaba Hosp"],"Inxuba Yethemba Local Municipality":["Cradock Hosp","Molteno Hosp"],"Sakhisizwe Local Municipality":["Cala Hosp","Elliot Hosp"]},"Joe Gqabi District":{"Elundini Local Municipality":["Maclear Hospital","Taylor Bequest Elundini"],"Emalahleni Local Municipality":["Dordrecht Hosp"],"Enoch Mgijima Local Municipality":["Sterkstroom Hosp"],"Inxuba Yethemba Local Municipality":["Molteno Hosp"],"Senqu Local Municipality":["Jamestown Hosp","Lady Grey Hosp"],"Walter Sisulu Local Municipality":["Alwal North Hospital","Cloete Jourbet","Empilisweni Hospital","Burgersdorp Hosp","Steynsbyurg Hosp","Umlamli Hosp"]},"N Mandela Bay MM":{"Nelson Mandela Bay Metropolitan Municipality":["Gqebera CHC","Central CHC","Korsten CHC","Kwazakhele CHC","L Bam CHC","Motherwell CHC","New Brighton CHC","Rosedale CHC","West End CHC","Uitenhage Hosp"]},"OR Tambo District":{"Ingquza Hill Local Municipality":["Holy Cross Hosp","Flagstaff CHC","St Lucy's Hosp"],"King Sabata Dalindyebo Local Municipality":["Baziya CHC","Mqanduli CHC","Viedgesville CHC","Ngangelizwe CHC","Canzibe Hosp","St Elizabeth Hospital"],"Mhlontlo Local Municipality":["Makhotyana CHC","Mbekweni CHC","Qumbu CHC"],"Nyandeni Local Municipality":["Dr Malizo Mphehle","St Barnabas Hospital","Mhlakulo CHC","Ngcwanguba CHC","Zithulele Hospital","Isilimela Hosp","N Knight Hosp"],"Port St Johns Local Municipality":["Bambisana Hosp","Port St Johns CHC","Tombo CHC"]},"Sarah Baartman District":{"Kou Kamma Local Municipality":["BJ Vorster Hospital","Joubertina CHC"],"Blue Crane Route Local Municipality":["Andries Vosloo Hospital"],"Dr Beyers Naudé Local Municipality":["Willowmore Hospital","Midland Hospital","Aberdeen Hospital","SAWAS Hospital (Jansenville)"],"Ndlambe Local Municipality":["Port Alfred Hospital"],"Sundays River Valley Local Municipality":["Sundays Valley Hospital"],"Makana Local Municipality":["Settlers Hospital"]}};
// END UNITS

// BEGIN ALLOCATIONS (generated by tools/build_allocations.py - do not edit by hand)
// [district, institution, posts, facility on the application form, local municipality,
// takes applications from (a nearby facility on the form)]
var ALLOCATIONS = [["Alfred Nzo District","Khotsong Hospital",6,"Khotsong Hospital","Matatiele Local Municipality",""],["Alfred Nzo District","Madzikane Kazulu Hospital",8,"Madzikane Kazulu Hospital","Umzimvubu Local Municipality",""],["Alfred Nzo District","Maluti CHC",3,"Maluti CHC","Matatiele Local Municipality",""],["Alfred Nzo District","St Patricks/ORATH",8,"St Patricks/ORATH","Winnie Madikizela-Mandela Local Municipality",""],["Alfred Nzo District","Tabankulu CHC",3,"Tabankulu CHC","Ntabankulu Local Municipality",""],["Alfred Nzo District","Tayler Bequest Matatiele Hospital",6,"Tayler Bequest Matatiele Hosp","Matatiele Local Municipality",""],["Alfred Nzo District","Greenville Hosp",6,"Greenville Hosp","Winnie Madikizela-Mandela Local Municipality",""],["Alfred Nzo District","Mt Ayliff Hosp",6,"Mt Ayliff Hosp","Umzimvubu Local Municipality",""],["Alfred Nzo District","Sipetu Hosp",6,"Sipetu Hosp","Ntabankulu Local Municipality",""],["Amathole District","Butterworth Hospital",8,"Butterworth Hospital","Mnquma Local Municipality",""],["Amathole District","Adelaide Hosp",6,"Adelaide Hosp","Raymond Mhlaba Local Municipality",""],["Amathole District","Bedford Hosp",6,"Bedford Hosp","Raymond Mhlaba Local Municipality",""],["Amathole District","Idutywa Village CHC",3,"Idutywa Village CHC","Mbhashe Local Municipality",""],["Amathole District","Middledrift CHC",3,"Middledrift CHC","Raymond Mhlaba Local Municipality",""],["Amathole District","Nqamakwe CHC",3,"Nqamakwe CHC","Mnquma Local Municipality",""],["Amathole District","Stutterheim Hospital",6,"Stutterheim Hospital","Amahlathi Local Municipality",""],["Amathole District","Victoria Hospital",6,"Victoria Hospital","Raymond Mhlaba Local Municipality",""],["Amathole District","Willowvale CHC",3,"Willowvale CHC","Mbhashe Local Municipality",""],["Amathole District","Xhora CHC",3,"Xhora CHC","Mbhashe Local Municipality",""],["Amathole District","Tower Hospital",4,"Tower Hospital","Amahlathi Local Municipality",""],["Amathole District","Cathcart Hosp",6,"Cathcart Hosp","Enoch Mgijima Local Municipality",""],["Amathole District","Fort Beaufort Hosp",6,"Fort Beaufort Hosp","Raymond Mhlaba Local Municipality",""],["Amathole District","Komga Hosp",6,"Komga Hosp","Great Kei Local Municipality",""],["Amathole District","Madwaleni Hosp",8,"Madwaleni Hosp","Mbhashe Local Municipality",""],["Amathole District","Nompumelelo Hosp",6,"Nompumelelo Hosp","Ngqushwa Local Municipality",""],["Amathole District","SS Gida Hosp",6,"SS Gida Hosp","Amahlathi Local Municipality",""],["Amathole District","Tafalofefe Hosp",6,"Tafalofefe Hosp","Mnquma Local Municipality",""],["Buffalo City Metro","Bhisho Hospital",8,"Bhisho Hospital","Buffalo City Metropolitan Municipality",""],["Buffalo City Metro","D Village CHC",3,"D Village CHC","Buffalo City Metropolitan Municipality",""],["Buffalo City Metro","Dimbaza CHC",3,"Dimbaza CHC","Buffalo City Metropolitan Municipality",""],["Buffalo City Metro","Empilweni Gompo CHC",3,"Empilweni Gompo CHC","Buffalo City Metropolitan Municipality",""],["Buffalo City Metro","Mt Coke CHC",3,"Mt Coke CHC","Buffalo City Metropolitan Municipality",""],["Buffalo City Metro","Nkqubela Hospital",4,"Nkqubela Hospital","Buffalo City Metropolitan Municipality",""],["Buffalo City Metro","Nontyatyambo CHC",3,"Nontyatyambo CHC","Buffalo City Metropolitan Municipality",""],["Buffalo City Metro","Cecilia Makiwane",8,"","Buffalo City Metropolitan Municipality","Nkqubela Hospital"],["Buffalo City Metro","Frere Hospital",9,"","Buffalo City Metropolitan Municipality","Empilweni Gompo CHC"],["Buffalo City Metro","Grey Hospital",6,"Grey Hospital","Buffalo City Metropolitan Municipality",""],["Chris Hani District","All Saints Hospital",6,"All Saints Hospital","Engcobo Local Municipality",""],["Chris Hani District","Glen Grey Hospital",6,"Glen Grey Hospital","Enoch Mgijima Local Municipality",""],["Chris Hani District","Cala Hosp",6,"Cala Hosp","Sakhisizwe Local Municipality",""],["Chris Hani District","Komani Hospitals",6,"Komani Hospitals","Enoch Mgijima Local Municipality",""],["Chris Hani District","Kuyasa CHC",3,"Kuyasa CHC","Enoch Mgijima Local Municipality",""],["Chris Hani District","Martje Venter Hospital",6,"Martje Venter Hospital","Enoch Mgijima Local Municipality",""],["Chris Hani District","Ngcobo CHC",3,"Ngcobo CHC","Engcobo Local Municipality",""],["Chris Hani District","Ngonyama CHC",3,"Ngonyama CHC","Enoch Mgijima Local Municipality",""],["Chris Hani District","Nomzamo CHC",3,"Nomzamo CHC","Enoch Mgijima Local Municipality",""],["Chris Hani District","Thornhill CHC",3,"Thornhill CHC","Enoch Mgijima Local Municipality",""],["Chris Hani District","Whittlesea CHC",3,"Whittlesea CHC","Enoch Mgijima Local Municipality",""],["Chris Hani District","Wilhelm Stahl",6,"Wilhelm Stahl","Enoch Mgijima Local Municipality",""],["Chris Hani District","Z Dalasile CHC",3,"Z Dalasile CHC","Engcobo Local Municipality",""],["Chris Hani District","Cofimvaba Hosp",6,"Cofimvaba Hosp","Intsika Yethu Local Municipality",""],["Chris Hani District","Cradock Hosp",6,"Cradock Hosp","Inxuba Yethemba Local Municipality",""],["Chris Hani District","Elliot Hosp",6,"Elliot Hosp","Sakhisizwe Local Municipality",""],["Chris Hani District","Hewu Hospital",6,"Hewu Hospital","Enoch Mgijima Local Municipality",""],["Chris Hani District","Indwe Hosp",6,"Indwe Hosp","Emalahleni Local Municipality",""],["Chris Hani District","Mjanyana Hosp",6,"","Engcobo Local Municipality","All Saints Hospital"],["Chris Hani District","Frontier Hospital",8,"Frontier Hospital","Enoch Mgijima Local Municipality",""],["Buffalo City Metro","Head Office",5,"Head Office","Buffalo City Metropolitan Municipality",""],["Joe Gqabi District","Alwal North Hospital",6,"Alwal North Hospital","Walter Sisulu Local Municipality",""],["Joe Gqabi District","Cloete Jourbet",6,"Cloete Jourbet","Walter Sisulu Local Municipality",""],["Joe Gqabi District","Empilisweni Hospital",6,"Empilisweni Hospital","Walter Sisulu Local Municipality",""],["Joe Gqabi District","Burgersdorp Hosp",6,"Burgersdorp Hosp","Walter Sisulu Local Municipality",""],["Joe Gqabi District","Maclear Hospital",6,"Maclear Hospital","Elundini Local Municipality",""],["Joe Gqabi District","Steynsbyurg",6,"Steynsbyurg Hosp","Walter Sisulu Local Municipality",""],["Joe Gqabi District","Taylor Bequest Elundini",6,"Taylor Bequest Elundini","Elundini Local Municipality",""],["Joe Gqabi District","Dordrecht Hosp",6,"Dordrecht Hosp","Emalahleni Local Municipality",""],["Joe Gqabi District","Jamestown Hosp",6,"Jamestown Hosp","Senqu Local Municipality",""],["Joe Gqabi District","L Grey Hosp",6,"Lady Grey Hosp","Senqu Local Municipality",""],["Joe Gqabi District","Molteno Hosp",6,"Molteno Hosp","Inxuba Yethemba Local Municipality",""],["Joe Gqabi District","Sterkstroom Hosp",6,"Sterkstroom Hosp","Enoch Mgijima Local Municipality",""],["Joe Gqabi District","Umlamli Hosp",6,"Umlamli Hosp","Walter Sisulu Local Municipality",""],["N Mandela Bay MM","Central CHC",3,"Central CHC","Nelson Mandela Bay Metropolitan Municipality",""],["N Mandela Bay MM","Gqebera CHC",3,"Gqebera CHC","Nelson Mandela Bay Metropolitan Municipality",""],["N Mandela Bay MM","Korsten CHC",3,"Korsten CHC","Nelson Mandela Bay Metropolitan Municipality",""],["N Mandela Bay MM","Kwazakhele CHC",3,"Kwazakhele CHC","Nelson Mandela Bay Metropolitan Municipality",""],["N Mandela Bay MM","L Bam CHC",3,"L Bam CHC","Nelson Mandela Bay Metropolitan Municipality",""],["N Mandela Bay MM","Motherwell CHC",3,"Motherwell CHC","Nelson Mandela Bay Metropolitan Municipality",""],["N Mandela Bay MM","New Brighton CHC",3,"New Brighton CHC","Nelson Mandela Bay Metropolitan Municipality",""],["N Mandela Bay MM","Dora Nginza Hospital",8,"","Nelson Mandela Bay Metropolitan Municipality","New Brighton CHC"],["N Mandela Bay MM","Rosedale CHC",3,"Rosedale CHC","Nelson Mandela Bay Metropolitan Municipality",""],["N Mandela Bay MM","Elizabeth Donkin Hospital",4,"","Nelson Mandela Bay Metropolitan Municipality","Gqebera CHC"],["N Mandela Bay MM","West End CHC",3,"West End CHC","Nelson Mandela Bay Metropolitan Municipality",""],["N Mandela Bay MM","Livingstone Hospital",8,"","Nelson Mandela Bay Metropolitan Municipality","Korsten CHC"],["N Mandela Bay MM","PE Provincial Hospital",9,"","Nelson Mandela Bay Metropolitan Municipality","Central CHC"],["N Mandela Bay MM","Uitenhage Hosp",8,"Uitenhage Hosp","Nelson Mandela Bay Metropolitan Municipality",""],["OR Tambo District","Baziya CHC",3,"Baziya CHC","King Sabata Dalindyebo Local Municipality",""],["OR Tambo District","Bambisana Hosp",6,"Bambisana Hosp","Port St Johns Local Municipality",""],["OR Tambo District","Dr Malizo Mphehle",6,"Dr Malizo Mphehle","Nyandeni Local Municipality",""],["OR Tambo District","Mthatha Regional Hospital",8,"","King Sabata Dalindyebo Local Municipality","Ngangelizwe CHC"],["OR Tambo District","Makhotyana CHC",3,"Makhotyana CHC","Mhlontlo Local Municipality",""],["OR Tambo District","Mbekweni CHC",3,"Mbekweni CHC","Mhlontlo Local Municipality",""],["OR Tambo District","Mhlakulo CHC",3,"Mhlakulo CHC","Nyandeni Local Municipality",""],["OR Tambo District","Mqanduli CHC",3,"Mqanduli CHC","King Sabata Dalindyebo Local Municipality",""],["OR Tambo District","Ngangelizwe CHC",3,"Ngangelizwe CHC","King Sabata Dalindyebo Local Municipality",""],["OR Tambo District","Ngcwanguba CHC",3,"Ngcwanguba CHC","Nyandeni Local Municipality",""],["OR Tambo District","Nelson Mandela Academic Hospital",10,"","King Sabata Dalindyebo Local Municipality","Ngangelizwe CHC"],["OR Tambo District","Port St Johns CHC",3,"Port St Johns CHC","Port St Johns Local Municipality",""],["OR Tambo District","Qumbu CHC",3,"Qumbu CHC","Mhlontlo Local Municipality",""],["OR Tambo District","Canzibe Hosp",6,"Canzibe Hosp","King Sabata Dalindyebo Local Municipality",""],["OR Tambo District","St Barnabas Hospital",6,"St Barnabas Hospital","Nyandeni Local Municipality",""],["OR Tambo District","St Elizabeth Hospital",8,"St Elizabeth Hospital","King Sabata Dalindyebo Local Municipality",""],["OR Tambo District","Tombo CHC",3,"Tombo CHC","Port St Johns Local Municipality",""],["OR Tambo District","Zithulele Hospital",8,"Zithulele Hospital","Nyandeni Local Municipality",""],["OR Tambo District","Holy Cross Hosp",6,"Holy Cross Hosp","Ingquza Hill Local Municipality",""],["OR Tambo District","Isilimela Hosp",6,"Isilimela Hosp","Nyandeni Local Municipality",""],["OR Tambo District","N Knight Hosp",6,"N Knight Hosp","Nyandeni Local Municipality",""],["OR Tambo District","St Lucy's Hosp",6,"St Lucy's Hosp","Ingquza Hill Local Municipality",""],["Sarah Baartman District","Andries Vosloo Hospital",6,"Andries Vosloo Hospital","Blue Crane Route Local Municipality",""],["Sarah Baartman District","Fort England Hospital",6,"","Makana Local Municipality","Settlers Hospital"],["Sarah Baartman District","BJ Vorster Hospital",6,"BJ Vorster Hospital","Kou Kamma Local Municipality",""],["Sarah Baartman District","Midland Hospital",6,"Midland Hospital","Dr Beyers Naudé Local Municipality",""],["Sarah Baartman District","Port Alfred",6,"Port Alfred Hospital","Ndlambe Local Municipality",""],["Sarah Baartman District","Settlers Hospital",6,"Settlers Hospital","Makana Local Municipality",""],["Sarah Baartman District","Willowmore Hospital",6,"Willowmore Hospital","Dr Beyers Naudé Local Municipality",""],["Sarah Baartman District","Sundays Valley Hospital",3,"Sundays Valley Hospital","Sundays River Valley Local Municipality",""],["Sarah Baartman District","SAWAS Hospital (Jansenville)",3,"SAWAS Hospital (Jansenville)","Dr Beyers Naudé Local Municipality",""],["Sarah Baartman District","Aberdeen Hospital",3,"Aberdeen Hospital","Dr Beyers Naudé Local Municipality",""],["Sarah Baartman District","Joubertina CHC",3,"Joubertina CHC","Kou Kamma Local Municipality",""]];
// Posts not yet given to an institution: [district, posts, duplicate line removed, same hospital as,
// reason, allocated to, allocated on]
var RESERVED_POSTS = [];
var TOTAL_POSTS = 611;
// Changes whenever the lists above change; the Sheet's Allocations tab is then replaced.
var ALLOCATIONS_VERSION = '34bee4c903be';
// END ALLOCATIONS

/** Menu: show (or create) the Import tab and explain how to use it. */
function openImportTab() {
  var sheet = getImportSheet_();
  sheet.activate();
  SpreadsheetApp.getUi().alert('Import a list',
    'Paste the list into the Import tab with its headings in row 1. You can paste over the example headings, ' +
    'or paste the rows under them.\n\n' +
    'Columns are recognised by their heading, for example: Name, Surname, Identity No., Age, Gender, ' +
    'Contact No., Disability, Address, District, Municipality, Institution, Qualification. Other columns are ignored.\n\n' +
    'Then choose EPWP > Import a list > 2. Check the list. Nothing is added until you choose ' +
    '3. Import the ready rows.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}

/** Menu: fill in the result columns without changing Applications. */
function checkImport() {
  var ui = SpreadsheetApp.getUi();
  var out = importList_(false, '');
  if (out.message) { ui.alert('Import a list', out.message, ui.ButtonSet.OK); return; }
  ui.alert('Import a list: check', importSummary_(out) +
    '\n\nSee the "Import status" and "Notes" columns in the Import tab. Fix rows in the list and check again, ' +
    'or choose 3. Import the ready rows.', ui.ButtonSet.OK);
}

/** Menu: add the ready rows to Applications. */
function runImport() {
  var ui = SpreadsheetApp.getUi();
  var check = importList_(false, '');
  if (check.message) { ui.alert('Import a list', check.message, ui.ButtonSet.OK); return; }
  if (!check.counts.Ready) {
    ui.alert('Import a list', importSummary_(check) + '\n\nThere are no rows ready to import.', ui.ButtonSet.OK);
    return;
  }
  var received = '';
  if (!check.hasDateColumn) {
    var answer = ui.prompt('Import a list',
      'On what date were these paper applications received? Type it as yyyy-mm-dd, for example ' +
      Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd') + '. Leave it empty for today.', ui.ButtonSet.OK_CANCEL);
    if (answer.getSelectedButton() !== ui.Button.OK) return;
    received = answer.getResponseText().trim() || Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
    if (!importDate_(received)) { ui.alert('Please type the date as yyyy-mm-dd. Nothing was imported.'); return; }
    received = importDate_(received);
  }
  var sure = ui.alert('Import a list', importSummary_(check) + '\n\nImport the ' + check.counts.Ready +
    ' ready row(s) into Applications now? Rejected and duplicate rows are left out.', ui.ButtonSet.YES_NO);
  if (sure !== ui.Button.YES) return;
  var out = importList_(true, received);
  if (out.message) { ui.alert('Import a list', out.message, ui.ButtonSet.OK); return; }
  ui.alert('Import a list: done', out.imported + ' application(s) were added to Applications, each with a reference number ' +
    '(see the Reference column in the Import tab).\n\n' + importSummary_(out), ui.ButtonSet.OK);
}

/** Menu: empty the Import tab once a list has been imported. */
function clearImportTab() {
  var ui = SpreadsheetApp.getUi();
  var sure = ui.alert('Clear the Import tab',
    'This removes everything in the Import tab, including the import results. ' +
    'Applications that were imported stay in Applications. Download or copy the Import tab first ' +
    'if you want to keep the list of rejected rows. Clear it now?', ui.ButtonSet.YES_NO);
  if (sure !== ui.Button.YES) return;
  var sheet = getImportSheet_();
  sheet.clear();
  sheet.getRange(1, 1, 1, IMPORT_TEMPLATE.length).setValues([IMPORT_TEMPLATE])
    .setFontWeight('bold').setBackground('#fff3c4');
}

function importSummary_(out) {
  var c = out.counts;
  return c.Ready + ' ready, ' + c.Rejected + ' rejected, ' + c.Duplicate + ' duplicate' +
    (c.Imported ? ', ' + c.Imported + ' already imported' : '') + ' (' + out.total + ' rows).';
}

function getImportSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(IMPORT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(IMPORT_SHEET);
    // Text format, so that numbers typed in keep their leading zeros.
    sheet.getRange(1, 1, sheet.getMaxRows(), IMPORT_TEMPLATE.length).setNumberFormat('@');
    sheet.getRange(1, 1, 1, IMPORT_TEMPLATE.length).setValues([IMPORT_TEMPLATE])
      .setFontWeight('bold').setBackground('#fff3c4');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Which column (0-based) holds each field, from the headings in row 1. */
function importColumns_(headings) {
  var cols = {};
  headings.forEach(function (h, i) {
    var key = String(h).toLowerCase().replace(/\(\s*yes\s*\/\s*no\s*\)/g, '').replace(/[^a-z0-9]/g, '');
    Object.keys(IMPORT_ALIASES).forEach(function (field) {
      if (cols[field] === undefined && IMPORT_ALIASES[field].indexOf(key) !== -1) cols[field] = i;
    });
  });
  return cols;
}

/**
 * Checks every row of the Import tab and writes the result columns. With
 * commit, the ready rows are also added to Applications.
 */
function importList_(commit, receivedDate) {
  var sheet = getImportSheet_();
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { message: 'The Import tab is empty. Paste the list into it first, with its headings in row 1.' };
  var all = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var head = all[0].map(String);
  var resultCol = head.indexOf(IMPORT_RESULTS[0]);
  var hasResults = resultCol !== -1;
  if (!hasResults) resultCol = lastCol;
  var cols = importColumns_(head.slice(0, resultCol));
  if (cols.SouthAfricanID === undefined || cols.Surname === undefined) {
    return { message: 'The Import tab needs columns headed for the ID number (for example "Identity No.") and the ' +
      'surname. Check the headings in row 1.' };
  }

  var lock = null;
  if (commit) {
    lock = LockService.getScriptLock();
    try { lock.waitLock(30000); } catch (err) { return { message: 'The system is busy. Please try again in a minute.' }; }
  }
  try {
    var apps = getSheet_();
    var appLast = apps.getLastRow();
    var existing = {};
    if (appLast >= 2) {
      var idCol = HEADERS.indexOf('SouthAfricanID') + 1, refCol = HEADERS.indexOf('Reference') + 1;
      var ids = apps.getRange(2, idCol, appLast - 1, 1).getDisplayValues();
      var refs = apps.getRange(2, refCol, appLast - 1, 1).getDisplayValues();
      ids.forEach(function (r, i) {
        var id = String(r[0]).replace(/\D/g, '');
        if (id && !existing[id]) existing[id] = refs[i][0];
      });
    }

    var now = new Date();
    var counts = { Ready: 0, Rejected: 0, Duplicate: 0, Imported: 0 };
    var seen = {}, results = [], toAdd = [], total = 0;
    var who = 'Imported by ' + adminName_();
    var props = PropertiesService.getScriptProperties();
    var counter = Math.max(Number(props.getProperty('counter')) || 0, appLast - 1);

    for (var i = 1; i < all.length; i++) {
      var row = all[i];
      var previous = hasResults ? row.slice(resultCol, resultCol + IMPORT_RESULTS.length) : [];
      if (String(previous[0] || '') === 'Imported') {
        // Imported earlier: leave it alone, but still catch a repeat of its ID further down.
        seen[String(previous[2]).replace(/\D/g, '')] = i + 1;
        counts.Imported++; total++;
        results.push(previous.map(String));
        continue;
      }
      if (!row.slice(0, resultCol).some(function (v) { return String(v).trim() !== ''; })) {
        results.push(IMPORT_RESULTS.map(function () { return ''; }));
        continue;
      }
      total++;
      var get = (function (r) { return function (f) { return cols[f] === undefined ? '' : r[cols[f]]; }; })(row);
      var r = importRow_(get, now, receivedDate);
      if (r.status === 'Ready') {
        if (existing[r.id]) {
          r.status = 'Duplicate';
          r.notes.unshift('Already in Applications as ' + existing[r.id]);
        } else if (seen[r.id]) {
          r.status = 'Duplicate';
          r.notes.unshift('Same ID number as row ' + seen[r.id] + ' of this list');
        } else {
          seen[r.id] = i + 1;
        }
      }
      var ref = '';
      if (commit && r.status === 'Ready') {
        counter++;
        ref = makeReference_(now, counter);
        var values = { Timestamp: now, Reference: ref };
        FIELDS.forEach(function (f) { values[f] = safeCell_(r.record[f]); });
        values.Consent = 'Paper application (imported list)';
        values['Channel'] = 'Captured';
        values['Captured By'] = safeCell_(who);
        values['Captured By District'] = displayDistrict_(r.record.District);
        values['Date Received'] = r.received;
        values['Received At'] = safeCell_(r.receivedAt);
        values['Paper Documents'] = r.paper;
        toAdd.push(HEADERS.map(function (h) { return values[h] === undefined ? '' : values[h]; }));
        r.status = 'Imported';
      }
      counts[r.status]++;
      results.push([r.status, ref, r.id || '', r.cell || '', r.record ? displayDistrict_(r.record.District) : '',
        r.record ? r.record.LocalMunicipality : '', r.record ? r.record.NearestFacility : '', r.notes.join('; ')]);
    }

    if (toAdd.length) {
      // Keep ID numbers, cellphone numbers and ward numbers as text.
      apps.getRange(appLast + 1, 2, toAdd.length, HEADERS.length - 1).setNumberFormat('@');
      apps.getRange(appLast + 1, 1, toAdd.length, HEADERS.length).setValues(toAdd);
      props.setProperty('counter', String(counter));
    }

    sheet.getRange(1, resultCol + 1, 1, IMPORT_RESULTS.length).setValues([IMPORT_RESULTS])
      .setFontWeight('bold').setBackground('#0a6b3d').setFontColor('#ffffff');
    var body = sheet.getRange(2, resultCol + 1, results.length, IMPORT_RESULTS.length);
    body.setNumberFormat('@').setValues(results);
    body.setBackgrounds(results.map(function (res) {
      var colour = IMPORT_COLOURS[res[0]] || null;
      return res.map(function () { return colour; });
    }));
    SpreadsheetApp.flush();

    return { counts: counts, total: total, imported: toAdd.length, hasDateColumn: cols.DateReceived !== undefined };
  } finally {
    if (lock) lock.releaseLock();
  }
}

/** Cleans and checks one row of the Import tab. */
function importRow_(get, now, receivedDate) {
  var notes = [];
  var out = { status: 'Ready', notes: notes };
  var reject = function (why) { out.status = 'Rejected'; notes.unshift(why); out.record = null; return out; };
  var text = function (v, max) {
    if (v instanceof Date) v = Utilities.formatDate(v, TIME_ZONE, 'yyyy-MM-dd');
    return String(v === undefined || v === null ? '' : v).replace(/[\s ]+/g, ' ').trim().slice(0, max || 200);
  };

  var name = text(get('Name')), surname = text(get('Surname'));
  if (!name && !surname) return reject('No name or surname');

  // ID number. Excel stores it as a number, which drops the leading 0 of
  // people born from 2000 to 2009.
  var rawId = get('SouthAfricanID');
  if (typeof rawId === 'string' && /\d[.,]?\d*E\+\d+/i.test(rawId)) {
    return reject('ID number was cut short by Excel (' + rawId.trim() + '). Type the full ID number in again');
  }
  var digits = (typeof rawId === 'number' ? rawId.toFixed(0) : String(rawId)).replace(/\D/g, '');
  out.id = digits;
  var listedAge = parseInt(String(get('Age')).replace(/[^\d]/g, ''), 10);
  var dob;
  if (!digits) return reject('No ID number');
  if (digits.length === 13) {
    dob = idBirthDate_(digits);
    if (!dob) return reject('ID number ' + digits + ' is not a valid South African ID number');
  } else if (digits.length === 11 || digits.length === 12) {
    var padded = ('00' + digits).slice(-13);
    dob = idBirthDate_(padded);
    if (!dob) return reject('ID number ' + digits + ' has ' + digits.length + ' digits and is not valid even with a 0 in front');
    var paddedAge = ageOn_(dob, now);
    if (!isNaN(listedAge) && Math.abs(paddedAge - listedAge) > 1) {
      return reject('ID number ' + digits + ' has ' + digits.length + ' digits. With a 0 in front the person would be born ' +
        dob + ' (age ' + paddedAge + '), which does not match the age ' + listedAge + ' in the list');
    }
    notes.push('0 added to the front of the ID number (born ' + dob.slice(0, 4) +
      (isNaN(listedAge) ? '; there is no age in the list to confirm it' : ', agrees with age ' + listedAge) + ')');
    digits = padded;
  } else {
    return reject('ID number ' + digits + ' has ' + digits.length + ' digits instead of 13');
  }
  out.id = digits;
  var age = ageOn_(dob, now);
  if (age < MIN_AGE || age > MAX_AGE) return reject('Age ' + age + ' (from the ID number) is outside ' + MIN_AGE + ' to ' + MAX_AGE);
  if (!isNaN(listedAge) && Math.abs(age - listedAge) > 1) notes.push('Age in the list is ' + listedAge + ' but the ID number gives ' + age);

  // Gender: F/M as Female/Male, checked against the ID number.
  var idGender = Number(digits.substr(6, 4)) >= 5000 ? 'Male' : 'Female';
  var g = text(get('Gender')).toLowerCase();
  var gender = /^(f|female|fem)$/.test(g) ? 'Female' : /^(m|male)$/.test(g) ? 'Male' : /prefer/.test(g) ? 'Prefer not to say' : '';
  if (!gender) {
    gender = idGender;
    notes.push((g ? 'Gender "' + g + '" not recognised' : 'No gender in the list') + '; ' + idGender + ' taken from the ID number');
  } else if (gender !== 'Prefer not to say' && gender !== idGender) {
    notes.push('Gender in the list is ' + gender + ' but the ID number is for a ' + idGender.toLowerCase());
  }

  // Cellphone numbers: Excel drops the leading 0 as well.
  var cell = importPhone_(get('CellphoneNumber'));
  if (!cell.number) notes.push('No cellphone number');
  else if (!cell.ok) notes.push('Cellphone number ' + cell.number + ' does not have 10 digits; kept as captured');
  else if (cell.fixed) notes.push('0 added to the front of the cellphone number');
  out.cell = cell.number;
  var alt = importPhone_(get('AlternativeNumber'));
  if (alt.number && !alt.ok) notes.push('Alternative number ' + alt.number + ' does not have 10 digits; kept as captured');

  var place = importPlace_(get('District'), get('LocalMunicipality'), get('NearestFacility'));
  if (!place.district) return reject('District not recognised. Add a District column (for example "Chris Hani")');
  if (!place.local) {
    return reject('Local municipality could not be worked out. Add a Local Municipality column, ' +
      'or an Institution that is on the facility list');
  }
  notes.push.apply(notes, place.notes);

  var disability = text(get('DisabilityStatus')).toLowerCase();
  disability = /^(y|yes|ja)$/.test(disability) ? 'Yes' : /^(n|no|none|nee)$/.test(disability) ? 'No' : text(get('DisabilityStatus'));

  var ward = text(get('MunicipalWardNo')).replace(/^ward\s*/i, '');

  out.record = {
    Title: text(get('Title'), 20),
    Name: name,
    Surname: surname,
    SouthAfricanID: digits,
    DateOfBirth: dob,
    Gender: gender,
    DisabilityStatus: disability,
    CurrentAddress: text(get('CurrentAddress'), 300),
    CellphoneNumber: cell.number,
    AlternativeNumber: alt.number,
    EmailAddress: text(get('EmailAddress')),
    District: place.district,
    LocalMunicipality: place.local,
    NearestFacility: place.facility,
    MunicipalWardNo: ward,
    HighestSchoolLevel: tidyQualification_(text(get('HighestSchoolLevel'))),
    PracticalSkills: text(get('PracticalSkills')),
    OtherSkills: text(get('OtherSkills'))
  };

  var day = get('DateReceived');
  out.received = day instanceof Date ? Utilities.formatDate(day, TIME_ZONE, 'yyyy-MM-dd') : importDate_(text(day));
  if (!out.received) {
    if (text(day)) notes.push('Date received "' + text(day) + '" not understood; used ' + (receivedDate || 'the import date'));
    out.received = receivedDate || Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  }
  out.receivedAt = place.facility || text(get('NearestFacility')) || 'Imported list';
  var yes = function (f) { return /^(y|yes)$/i.test(text(get(f))); };
  var paper = [];
  if (yes('IDAttached')) paper.push('ID copy');
  if (yes('QualificationAttached')) paper.push('Results copy');
  out.paper = paper.length ? paper.join(', ') : 'Not recorded in the list';
  return out;
}

/** A phone number with a lost leading 0 put back. */
function importPhone_(v) {
  var d = (typeof v === 'number' ? v.toFixed(0) : String(v === undefined || v === null ? '' : v)).replace(/\D/g, '');
  var fixed = false;
  if (/^27\d{9}$/.test(d)) d = '0' + d.slice(2);
  else if (/^[1-9]\d{8}$/.test(d)) { d = '0' + d; fixed = true; }
  return { number: d, ok: /^0\d{9}$/.test(d), fixed: fixed };
}

/** "2026-11-14", "14/11/2026" or "14-11-2026" as yyyy-mm-dd, else ''. */
function importDate_(s) {
  s = String(s || '').trim();
  var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(s);
  var y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; } else {
    m = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/.exec(s);
    if (!m) return '';
    y = +m[3]; mo = +m[2]; d = +m[1];
  }
  var date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return '';
  var iso = y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
  return iso > Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd') ? '' : iso;
}

/** "GRADE 12" as "Grade 12", "NCV-LEVEL4 MANAGEMENT" as "NC(V) Level 4 Management", and so on. */
function tidyQualification_(q) {
  q = String(q || '').replace(/[`´"]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[\s:;,.-]+$/, '');
  if (!q) return '';
  var small = { 'in': 1, 'of': 1, 'and': 1, 'for': 1, 'the': 1, 'a': 1 };
  q = q.toLowerCase().split(' ').map(function (w, i) {
    if (i > 0 && small[w]) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
  return q
    .replace(/\bNc\s*\(?v\)?(?=[\s\-:]|level|$)\s*-?\s*/i, 'NC(V) ')
    .replace(/\bAbet\b/g, 'ABET')
    .replace(/\bN(\d)\b/g, 'N$1')
    .replace(/\bLevel\s*(\d+)/gi, 'Level $1')
    .replace(/\bGr\.?\s*(\d+)\b/g, 'Grade $1')
    .replace(/\s*:\s*/g, ': ')
    .replace(/\s+/g, ' ').trim();
}

/** Lower-case letters only, without "district", "municipality" and similar words. */
function placeKey_(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(local|district|metropolitan|metro|municipality|municipal|mm|dm|lm)\b/g, '')
    .replace(/[^a-z]/g, '');
}

function facilityKey_(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ')
    .replace(/\bcommunity health cent(er|re)\b/g, 'chc')
    .replace(/\b(hospitals?|hosp)\b\.?/g, 'hosp')
    .replace(/[^a-z0-9]/g, '');
}

var DISTRICT_EXTRA_NAMES = { nmb: 'N Mandela Bay MM', nelsonmandelabay: 'N Mandela Bay MM', bcm: 'Buffalo City Metro', ortambo: 'OR Tambo District' };

function districtFromText_(s) {
  var key = placeKey_(s);
  if (!key) return '';
  if (DISTRICT_EXTRA_NAMES[key]) return DISTRICT_EXTRA_NAMES[key];
  for (var i = 0; i < DISTRICTS.length; i++) {
    if (placeKey_(DISTRICTS[i][0]) === key || placeKey_(DISTRICTS[i][1]) === key) return DISTRICTS[i][0];
  }
  return '';
}

/**
 * District, local municipality and facility for an imported row. The
 * "municipality" column sometimes holds the district (for example
 * "CHRIS HANI"), so both columns are tried for the district.
 */
function importPlace_(districtText, localText, facilityText) {
  var notes = [];
  var district = districtFromText_(districtText) || districtFromText_(localText);
  var local = '', facility = '';
  var districts = district ? [district] : Object.keys(UNITS);

  var lk = placeKey_(localText);
  if (lk) {
    districts.some(function (d) {
      return Object.keys(UNITS[d] || {}).some(function (l) {
        if (placeKey_(l) === lk) { local = l; district = district || d; return true; }
        return false;
      });
    });
  }

  if (lk && !local && !districtFromText_(localText)) {
    notes.push('Municipality "' + String(localText).trim() + '" not recognised');
  }

  // The institution is where the person applied. It may be in another local
  // municipality of the same district than where the person lives.
  var fk = facilityKey_(facilityText);
  var fromFacility = false;
  if (fk) {
    (district ? [district] : districts).some(function (d) {
      return Object.keys(UNITS[d] || {}).some(function (l) {
        return (UNITS[d][l] || []).some(function (f) {
          if (facilityKey_(f) !== fk) return false;
          facility = f;
          if (!local) { local = l; fromFacility = true; }
          district = district || d;
          return true;
        });
      });
    });
    if (!facility) {
      notes.push('Institution "' + String(facilityText).replace(/\s+/g, ' ').trim() + '" is not on the facility list; kept as captured');
      facility = String(facilityText).replace(/\s+/g, ' ').trim();
    }
  }
  if (fromFacility) notes.push('Local municipality taken from the institution');
  return { district: district, local: local, facility: facility, notes: notes };
}

/* =====================================================================
 * Web app
 * ===================================================================== */

/** Opening the Web App URL in a browser shows that it is alive. */
function doGet() {
  // "uploads" and "capture" tell the website which features this version has.
  return json_({ ok: true, service: 'EPWP general worker applications', uploads: true, capture: true, accountRequests: true,
    download: true, dashboard: true, selection: true, verification: true });
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
      case 'export': return json_(export_(data, sessionUser_(data.token)));
      case 'stats': return json_(stats_(data, sessionUser_(data.token)));
      case 'institutions': return json_(institutions_(data, sessionUser_(data.token)));
      case 'pool': return json_(pool_(data, sessionUser_(data.token)));
      case 'select': return json_(select_(data, sessionUser_(data.token)));
      case 'verify': return json_(verify_(data, sessionUser_(data.token)));
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
    canSelect: !!user.canSelect,
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
    sheet.getRange(2, UCOL['Selection access'], rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
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
        salt: rows[i][UCOL.Salt - 1],
        canSelect: /^(yes|y|true)$/i.test(String(rows[i][UCOL['Selection access'] - 1] || '').trim())
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
  var f = filterApplications_(data, user);
  var col = f.col, matches = f.matches, counts = f.counts, district = f.district;

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
    scope: scopeName_(user, district),
    counts: counts,
    total: matches.length,
    offset: offset,
    pageSize: PAGE_SIZE,
    rows: page
  };
}

function scopeName_(user, district) {
  return user.provincial ? (district ? displayDistrict_(district) : 'All districts') : user.district;
}

/**
 * Every application this staff member may download, with the same filters as
 * the list on screen, as rows of text ready for Excel. Each download is logged.
 */
function export_(data, user) {
  var f = filterApplications_(data, user);
  var col = f.col;
  var text = function (row, h) {
    var v = row[col[h]];
    if (v instanceof Date) return Utilities.formatDate(v, TIME_ZONE, h === 'Timestamp' ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
    if (h === 'Channel') return v === 'Captured' ? 'Captured' : 'Online';
    if (h === 'District') return displayDistrict_(String(v));
    v = String(v === undefined || v === null ? '' : v);
    // Undo the leading apostrophe that stops text being read as a formula.
    return v.charAt(0) === "'" ? v.slice(1) : v;
  };
  var rows = f.matches.map(function (row) {
    return EXPORT_COLUMNS.map(function (c) { return text(row, c[1]); });
  });
  var scope = scopeName_(user, f.district);
  logDownload_(user, scope, data, rows.length);
  return {
    ok: true,
    scope: scope,
    created: Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm'),
    headers: EXPORT_COLUMNS.map(function (c) { return c[0]; }),
    links: EXPORT_COLUMNS.map(function (c) { return /\(link\)$/.test(c[1]); }),
    rows: rows
  };
}

function logDownload_(user, scope, data, count) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(DOWNLOADS_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(DOWNLOADS_SHEET);
      sheet.getRange(1, 1, 1, DOWNLOAD_HEADERS.length).setValues([DOWNLOAD_HEADERS])
        .setFontWeight('bold').setBackground('#0a6b3d').setFontColor('#ffffff');
      sheet.setFrozenRows(1);
    }
    var filters = [];
    if (data.channel === 'Online' || data.channel === 'Captured') filters.push(data.channel + ' only');
    if (String(data.search || '').trim()) filters.push('search "' + String(data.search).trim().slice(0, 60) + '"');
    sheet.appendRow([new Date(), user.username, safeCell_(user.name), safeCell_(user.district), safeCell_(scope),
      safeCell_(filters.join(', ') || 'none'), count]);
  } catch (err) {
    console.error(err);
  }
}

var AGE_BANDS = [[18, 24], [25, 29], [30, 34], [35, 39], [40, 45]];
var TOP_FACILITIES = 15;
var TOP_QUALIFICATIONS = 12;

/**
 * Counts for the dashboard: totals and breakdowns of the applications this
 * staff member may see. Provincial users can narrow it to a district, and
 * anyone can narrow it to a local municipality in their district. Only
 * counts are returned, never personal details.
 */
function stats_(data, user) {
  var f = filterApplications_({ district: data.district }, user);
  var col = f.col, district = f.district;
  var local = String(data.local || '').trim();
  if (!district || !UNITS[district] || !UNITS[district][local]) local = '';
  var rows = local ? f.matches.filter(function (r) { return String(r[col.LocalMunicipality]) === local; }) : f.matches;

  var zero = function (keys) { var o = {}; keys.forEach(function (k) { o[k] = 0; }); return o; };
  var add = function (o, k) { o[k] = (o[k] || 0) + 1; };
  var bandName = function (b) { return b[0] + ' to ' + b[1]; };
  var channel = zero(['Online', 'Captured']);
  var gender = zero(['Female', 'Male']);
  var disability = zero(['Yes', 'No']);
  var ages = zero(AGE_BANDS.map(bandName));
  var districts = district ? null : zero(DISTRICTS.map(function (d) { return d[0]; }));
  var locals = !district || local ? null : zero(Object.keys(UNITS[district] || {}));
  var facilities = {}, qualifications = {}, days = {};
  var now = new Date();
  var day = function (v) {
    if (v instanceof Date) return Utilities.formatDate(v, TIME_ZONE, 'yyyy-MM-dd');
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || ''));
    return m ? m[1] : '';
  };

  rows.forEach(function (r) {
    var how = r[col.Channel] === 'Captured' ? 'Captured' : 'Online';
    add(channel, how);
    add(gender, String(r[col.Gender] || '').trim() || 'Not recorded');
    var dis = String(r[col.DisabilityStatus] || '').trim();
    add(disability, dis === 'Yes' || dis === 'No' ? dis : 'Not recorded');

    var dob = day(r[col.DateOfBirth]) || idBirthDate_(String(r[col.SouthAfricanID]).replace(/\D/g, ''));
    var band = 'Not recorded';
    if (dob) {
      var age = ageOn_(dob, now);
      band = 'Other ages';
      AGE_BANDS.forEach(function (b) { if (age >= b[0] && age <= b[1]) band = bandName(b); });
    }
    add(ages, band);

    if (districts) add(districts, String(r[col.District] || '') || 'Not recorded');
    if (locals) add(locals, String(r[col.LocalMunicipality] || '') || 'Not recorded');
    add(facilities, String(r[col.NearestFacility] || '').trim() || 'Not recorded');
    add(qualifications, String(r[col.HighestSchoolLevel] || '').trim() || 'Not recorded');

    // Paper applications count on the day they were handed in, online ones on the day they arrived.
    var when = (how === 'Captured' && day(r[col['Date Received']])) || day(r[col.Timestamp]);
    if (when) add(days, when);
  });

  var list = function (o, sort, top, label) {
    var items = Object.keys(o).map(function (k) { return [label ? label(k) : k, o[k]]; });
    if (sort) items.sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : 1); });
    if (top && items.length > top) {
      var rest = items.slice(top).reduce(function (s, it) { return s + it[1]; }, 0);
      items = items.slice(0, top).concat([['All others (' + (items.length - top) + ')', rest]]);
    }
    return items;
  };
  var scope = scopeName_(user, district) + (local ? ' - ' + local : '');
  return {
    ok: true,
    scope: scope,
    district: district,
    local: local,
    generated: Utilities.formatDate(now, TIME_ZONE, "d MMMM yyyy 'at' HH:mm"),
    total: rows.length,
    channel: list(channel),
    gender: list(gender),
    disability: list(disability),
    ages: list(ages),
    districts: districts ? list(districts, true, 0, displayDistrict_) : null,
    locals: locals ? list(locals, true) : null,
    facilities: list(facilities, true, TOP_FACILITIES),
    qualifications: list(qualifications, true, TOP_QUALIFICATIONS),
    days: Object.keys(days).sort().map(function (k) { return [k, days[k]]; })
  };
}

/* =====================================================================
 * Selection: posts per institution, and HR's choice of candidates
 *
 * Kept apart from the Applications tab (the master list), which is never
 * changed here:
 *   - "Allocations": the posts per institution. Filled from ALLOCATIONS the
 *     first time it is needed; after that the tab is used, so posts can be
 *     corrected there. When ALLOCATIONS_VERSION changes (a new allocation
 *     list in this code), the tab is replaced; the old one is kept, renamed.
 *     An institution that was not on the application form can take the
 *     applicants of a nearby facility (last column).
 *   - "Selections": one row per applicant HR has given a status to.
 *   - "Selection History": every change, with who made it, when and why.
 *   - "Document Checks": whether HR has verified each applicant's ID document
 *     and proof of results (from the upload for online applicants, from the
 *     paper file at the HR office for paper applicants). Nobody can be
 *     Selected until both are Verified.
 *   - "Reserved Posts": posts not given to an institution yet, kept for
 *     further allocation (filled from RESERVED_POSTS the first time). They
 *     are shown apart from the institutions; with them the total is TOTAL_POSTS.
 * Everyone signed in can see the selection screens for their own district
 * (provincial users: all districts). Only users with "Selection access" = Yes
 * in the Users tab can change a status.
 * ===================================================================== */

var ALLOC_SHEET = 'Allocations';
var RESERVED_SHEET = 'Reserved Posts';
var RESERVED_HEADERS = ['District', 'Posts', 'Duplicate line removed from the allocation list', 'Same hospital as', 'Reason',
  'Allocated to (institution)', 'Allocated on'];
var ALLOC_HEADERS = ['District', 'Institution', 'Posts', 'Applications come from (facility on the form)', 'Local municipality',
  'Also takes applications from (nearby facility)'];
var SEL_SHEET = 'Selections';
var SEL_HEADERS = ['Reference', 'Applicant', 'ID number', 'District', 'Institution', 'Status', 'Reason', 'Updated by', 'Updated on'];
var SEL_LOG_SHEET = 'Selection History';
var SEL_LOG_HEADERS = ['Timestamp', 'Reference', 'Applicant', 'Institution', 'From', 'To', 'Reason', 'By'];
var SEL_STATUSES = ['Shortlisted', 'Selected', 'Reserve', 'Not suitable', 'Withdrawn'];
// An applicant can only hold one of these at a time, at one institution.
var SEL_ACTIVE = { Shortlisted: 1, Selected: 1, Reserve: 1 };
var SEL_NEEDS_REASON = { 'Not suitable': 1, 'Withdrawn': 1 };
var SEL_ORDER = { Selected: 0, Reserve: 1, Shortlisted: 2, '': 3, 'Not suitable': 4, Withdrawn: 5 };
var YOUTH_MAX_AGE = 35;
var DOC_SHEET = 'Document Checks';
var DOC_HEADERS = ['Reference', 'Applicant', 'ID number', 'How applied', 'ID document', 'Proof of results', 'Note',
  'Checked by', 'Checked on'];
var DOC_VALUES = ['Verified', 'Missing'];

function headedSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#0a6b3d').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, headers.length).setNumberFormat('@');
  }
  return sheet;
}

/**
 * Makes sure the Allocations and Reserved Posts tabs hold the lists in this
 * version of the code. A newer list replaces them; the old tabs are kept,
 * renamed "(replaced <date>)". Call this before taking the script lock.
 */
function ensureAllocationTabs_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  var current = function () {
    return props.getProperty('allocationsVersion') === ALLOCATIONS_VERSION && ss.getSheetByName(ALLOC_SHEET);
  };
  if (current()) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    if (current()) return;
    var stamp = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH.mm');
    [ALLOC_SHEET, RESERVED_SHEET].forEach(function (name) {
      var old = ss.getSheetByName(name);
      if (old) old.setName(name + ' (replaced ' + stamp + ')');
    });
    var sheet = headedSheet_(ALLOC_SHEET, ALLOC_HEADERS);
    sheet.getRange(2, 3, sheet.getMaxRows() - 1, 1).setNumberFormat('0');
    var seed = ALLOCATIONS.map(function (a) { return [displayDistrict_(a[0]), a[1], a[2], a[3], a[4], a[5] || '']; });
    sheet.getRange(2, 1, seed.length, ALLOC_HEADERS.length).setValues(seed);
    var res = headedSheet_(RESERVED_SHEET, RESERVED_HEADERS);
    res.getRange(2, 2, res.getMaxRows() - 1, 1).setNumberFormat('0');
    if (RESERVED_POSTS.length) {
      res.getRange(2, 1, RESERVED_POSTS.length, RESERVED_HEADERS.length).setValues(RESERVED_POSTS.map(function (r) {
        return [displayDistrict_(r[0]), r[1], r[2], r[3], r[4], r[5], r[6]];
      }));
    }
    SpreadsheetApp.flush();
    props.setProperty('allocationsVersion', ALLOCATIONS_VERSION);
  } finally {
    lock.releaseLock();
  }
}

/** The institutions with their posts, from the Allocations tab. */
function allocations_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ALLOC_SHEET);
  var last = sheet ? sheet.getLastRow() : 0;
  var rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, ALLOC_HEADERS.length).getValues();
  var list = [], seen = {};
  rows.forEach(function (r) {
    var district = districtCode_(r[0]) || districtFromText_(r[0]);
    var name = String(r[1] || '').replace(/\s+/g, ' ').trim();
    if (!district || !name) return;
    var id = district + '|' + name;
    if (seen[id]) return;
    seen[id] = 1;
    var facility = String(r[3] || '').trim();
    var takesFrom = String(r[5] || '').trim();
    list.push({
      id: id, district: district, name: name, posts: Math.max(0, Math.floor(Number(r[2]) || 0)),
      facility: facility, local: String(r[4] || '').trim(), takesFrom: takesFrom,
      keys: [facilityKey_(name)].concat(facility ? [facilityKey_(facility)] : []),
      fromKey: takesFrom ? facilityKey_(takesFrom) : ''
    });
  });
  return list;
}

/**
 * Which institutions an applicant belongs to, from the facility they chose:
 * the institution of that facility itself (own), and any institution that
 * also takes applications from it (borrowers). all() gives both, own first.
 */
function institutionMatcher_(allocs) {
  var byKey = {}, byFrom = {};
  allocs.forEach(function (a) {
    a.keys.forEach(function (k) { if (k) (byKey[k] = byKey[k] || []).push(a); });
    if (a.fromKey) (byFrom[a.fromKey] = byFrom[a.fromKey] || []).push(a);
  });
  var own = function (facility, applicantDistrict) {
    var hits = byKey[facilityKey_(facility)];
    if (!hits) return null;
    var code = districtCode_(applicantDistrict);
    for (var i = 0; i < hits.length; i++) if (hits[i].district === code) return hits[i];
    return hits[0];
  };
  return {
    own: own,
    all: function (facility, applicantDistrict) {
      var first = own(facility, applicantDistrict);
      var list = first ? [first] : [];
      (byFrom[facilityKey_(facility)] || []).forEach(function (a) { if (list.indexOf(a) === -1) list.push(a); });
      return list;
    }
  };
}

/** The other institutions that share applicants with this one (by name). */
function sharesWith_(inst, allocs) {
  var names = [];
  allocs.forEach(function (a) {
    if (a.id === inst.id) return;
    var same = (inst.fromKey && (a.keys.indexOf(inst.fromKey) !== -1 || a.fromKey === inst.fromKey)) ||
      (a.fromKey && inst.keys.indexOf(a.fromKey) !== -1);
    if (same) names.push(a.name);
  });
  return names;
}

/**
 * Posts kept back for further allocation (for example from duplicate lines
 * removed from the allocation list), from the Reserved Posts tab. A line
 * stops counting as reserved once "Allocated to" is filled in; the posts must
 * then also be added to that institution in the Allocations tab.
 */
function reservedPosts_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RESERVED_SHEET);
  var last = sheet ? sheet.getLastRow() : 0;
  var rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, RESERVED_HEADERS.length).getValues();
  return rows.filter(function (r) { return Number(r[1]) > 0; }).map(function (r) {
    var on = r[6];
    return {
      district: districtCode_(r[0]) || districtFromText_(r[0]),
      posts: Math.floor(Number(r[1])),
      removed: String(r[2] || ''), sameAs: String(r[3] || ''), reason: String(r[4] || ''),
      allocatedTo: String(r[5] || '').trim(),
      allocatedOn: on instanceof Date ? Utilities.formatDate(on, TIME_ZONE, 'yyyy-MM-dd') : String(on || '')
    };
  });
}

/** The document checks HR has recorded, by reference number. */
function documentChecks_() {
  var sheet = headedSheet_(DOC_SHEET, DOC_HEADERS);
  var last = sheet.getLastRow();
  var rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, DOC_HEADERS.length).getValues();
  var map = {};
  rows.forEach(function (r, i) {
    var ref = String(r[0]).trim();
    if (!ref) return;
    var on = r[8];
    map[ref] = {
      row: i + 2, id: String(r[4] || '').trim(), results: String(r[5] || '').trim(), note: String(r[6] || ''),
      by: String(r[7] || ''),
      on: on instanceof Date ? Utilities.formatDate(on, TIME_ZONE, 'yyyy-MM-dd HH:mm') : String(on || '')
    };
  });
  return map;
}

function docsVerified_(d) {
  return !!d && d.id === 'Verified' && d.results === 'Verified';
}

/** The current status of everyone HR has looked at, by reference number. */
function selections_() {
  var sheet = headedSheet_(SEL_SHEET, SEL_HEADERS);
  var last = sheet.getLastRow();
  var rows = last < 2 ? [] : sheet.getRange(2, 1, last - 1, SEL_HEADERS.length).getValues();
  var map = {};
  rows.forEach(function (r, i) {
    var ref = String(r[0]).trim();
    if (!ref) return;
    var on = r[8];
    map[ref] = {
      row: i + 2,
      institution: districtCode_(r[3]) + '|' + String(r[4]),
      institutionName: String(r[4]),
      status: String(r[5] || '').trim(),
      reason: String(r[6] || ''),
      by: String(r[7] || ''),
      on: on instanceof Date ? Utilities.formatDate(on, TIME_ZONE, 'yyyy-MM-dd HH:mm') : String(on || '')
    };
  });
  return map;
}

function applicantAge_(row, col, now) {
  var dob = row[col.DateOfBirth];
  dob = dob instanceof Date ? Utilities.formatDate(dob, TIME_ZONE, 'yyyy-MM-dd') : String(dob || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) dob = idBirthDate_(String(row[col.SouthAfricanID]).replace(/\D/g, ''));
  return dob ? ageOn_(dob, now) : null;
}

function selectionScope_(data, user) {
  return user.provincial ? districtCode_(data.district) : user.districtCode;
}

/**
 * The institutions in the user's scope, with their posts, how many applied
 * for each, and how far selection has got. Also the facilities applicants
 * chose that have no posts.
 */
function institutions_(data, user) {
  ensureAllocationTabs_();
  var district = selectionScope_(data, user);
  var allocs = allocations_();
  var match = institutionMatcher_(allocs);
  var inScope = function (code) { return canSee_(user, code) && (!district || code === district); };
  var stats = {};
  allocs.forEach(function (a) {
    if (!inScope(a.district)) return;
    stats[a.id] = { applications: 0, women: 0, youth: 0, disabled: 0, Shortlisted: 0, Selected: 0, Reserve: 0,
      'Not suitable': 0, Withdrawn: 0, active: 0, verified: 0 };
  });

  var sheet = getSheet_();
  var last = sheet.getLastRow();
  var values = last < 2 ? [] : sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var col = {};
  HEADERS.forEach(function (h, i) { col[h] = i; });
  var now = new Date();
  var other = {};
  var applicationsTotal = 0;
  values.forEach(function (row) {
    var targets = match.all(row[col.NearestFacility], row[col.District]);
    var counted = false;
    targets.forEach(function (a) {
      if (!stats[a.id]) return;
      counted = true;
      var st = stats[a.id];
      st.applications++;
      if (row[col.Gender] === 'Female') st.women++;
      if (row[col.DisabilityStatus] === 'Yes') st.disabled++;
      var age = applicantAge_(row, col, now);
      if (age !== null && age <= YOUTH_MAX_AGE) st.youth++;
    });
    if (counted) applicationsTotal++;
    if (!targets.length) {
      var code = districtCode_(row[col.District]);
      if (!inScope(code)) return;
      var f = String(row[col.NearestFacility] || '').trim() || 'Not recorded';
      var k = code + '|' + f;
      other[k] = other[k] || { district: displayDistrict_(code), facility: f, applications: 0, online: 0, captured: 0 };
      other[k].applications++;
      if (row[col.Channel] === 'Captured') other[k].captured++; else other[k].online++;
      applicationsTotal++;
    }
  });

  var sel = selections_();
  var docs = documentChecks_();
  Object.keys(sel).forEach(function (ref) {
    var s = sel[ref], st = stats[s.institution];
    if (!st || st[s.status] === undefined) return;
    st[s.status]++;
    if (SEL_ACTIVE[s.status]) {
      st.active++;
      if (docsVerified_(docs[ref])) st.verified++;
    }
  });

  var list = allocs.filter(function (a) { return stats[a.id]; }).map(function (a) {
    var st = stats[a.id];
    return {
      id: a.id, district: displayDistrict_(a.district), name: a.name, local: a.local, posts: a.posts,
      onForm: !!a.facility, takesFrom: a.takesFrom, sharesWith: sharesWith_(a, allocs), applications: st.applications, women: st.women, youth: st.youth, disabled: st.disabled,
      shortlisted: st.Shortlisted, selected: st.Selected, reserve: st.Reserve, notSuitable: st['Not suitable'],
      withdrawn: st.Withdrawn, open: Math.max(0, a.posts - st.Selected), active: st.active, verified: st.verified
    };
  });
  list.sort(function (x, y) { return x.district < y.district ? -1 : x.district > y.district ? 1 : x.name < y.name ? -1 : 1; });
  var others = Object.keys(other).map(function (k) { return other[k]; })
    .sort(function (x, y) { return y.applications - x.applications; });
  return {
    ok: true,
    scope: scopeName_(user, district),
    canSelect: !!user.canSelect,
    generated: Utilities.formatDate(now, TIME_ZONE, "d MMMM yyyy 'at' HH:mm"),
    institutions: list,
    others: others,
    applicationsTotal: applicationsTotal,
    reserved: reservedPosts_().filter(function (r) { return inScope(r.district) && !r.allocatedTo; }).map(function (r) {
      return { district: displayDistrict_(r.district), posts: r.posts, removed: r.removed, sameAs: r.sameAs, reason: r.reason,
        allocatedTo: r.allocatedTo, allocatedOn: r.allocatedOn };
    }),
    totalPosts: district ? null : TOTAL_POSTS,
    statuses: SEL_STATUSES
  };
}

/**
 * The applicants for one institution: those who chose it on the form, or
 * (with from = "district") everyone living in its district. With their
 * selection status, best first, PAGE_SIZE at a time (or all, for Excel).
 */
function pool_(data, user) {
  ensureAllocationTabs_();
  var allocs = allocations_();
  var inst = null;
  allocs.forEach(function (a) { if (a.id === String(data.institution || '')) inst = a; });
  if (!inst || !canSee_(user, inst.district)) {
    return { ok: false, error: 'invalid', message: 'That institution was not found. Refresh the page and try again.' };
  }
  var fromDistrict = data.from === 'district';
  var match = institutionMatcher_(allocs);
  var sel = selections_();
  var docs = documentChecks_();
  var statusFilter = String(data.status || '');
  var docsFilter = String(data.docs || '');
  var words = String(data.search || '').toLowerCase().replace(/[^a-z0-9 -]/g, ' ').split(/\s+/).filter(String);

  var sheet = getSheet_();
  var last = sheet.getLastRow();
  var values = last < 2 ? [] : sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var col = {};
  HEADERS.forEach(function (h, i) { col[h] = i; });
  var now = new Date();
  var counts = { all: 0 };
  var rows = [];
  values.forEach(function (row) {
    var here = match.all(row[col.NearestFacility], row[col.District]).indexOf(inst) !== -1;
    if (fromDistrict ? districtCode_(row[col.District]) !== inst.district : !here) return;
    var ref = String(row[col.Reference]);
    var s = sel[ref] || null;
    var status = s ? s.status : '';
    var elsewhere = !!(s && status && s.institution !== inst.id);
    counts.all++;
    var key = elsewhere ? 'elsewhere' : (status || 'none');
    counts[key] = (counts[key] || 0) + 1;
    if (statusFilter && statusFilter !== key) return;
    if (docsFilter) {
      var d = docs[ref];
      var docKey = docsVerified_(d) ? 'verified' : d && (d.id === 'Missing' || d.results === 'Missing') ? 'missing' : 'unverified';
      if (docKey !== docsFilter) return;
    }
    if (words.length) {
      var text = [ref, row[col.Name], row[col.Surname], row[col.SouthAfricanID], row[col.CellphoneNumber],
        row[col.LocalMunicipality], row[col.MunicipalWardNo], row[col.NearestFacility]].join(' ').toLowerCase();
      if (!words.every(function (w) { return text.indexOf(w) !== -1; })) return;
    }
    rows.push({ row: row, ref: ref, s: s, status: status, elsewhere: elsewhere });
  });
  rows.sort(function (a, b) {
    var oa = a.elsewhere ? 6 : SEL_ORDER[a.status], ob = b.elsewhere ? 6 : SEL_ORDER[b.status];
    return oa - ob || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  });

  var link = function (row, h) { var v = String(row[col[h]] || ''); return /^https:\/\/drive\.google\.com\//.test(v) ? v : ''; };
  var shape = function (it) {
    var row = it.row, s = it.s;
    var qual = String(row[col.HighestSchoolLevel] || '');
    return {
      ref: it.ref,
      name: String(row[col.Name]), surname: String(row[col.Surname]),
      id: String(row[col.SouthAfricanID]).replace(/^'/, ''),
      gender: String(row[col.Gender]), age: applicantAge_(row, col, now),
      disability: String(row[col.DisabilityStatus]),
      cell: String(row[col.CellphoneNumber]).replace(/^'/, ''),
      district: displayDistrict_(String(row[col.District])),
      local: String(row[col.LocalMunicipality]), ward: String(row[col.MunicipalWardNo]),
      facility: String(row[col.NearestFacility]),
      qualification: qual, qualificationListed: QUALIFICATIONS.indexOf(qual) !== -1,
      channel: row[col.Channel] === 'Captured' ? 'Captured' : 'Online',
      paperDocs: String(row[col['Paper Documents']] || ''),
      idDoc: link(row, 'ID Document (link)'), resultsDoc: link(row, 'Proof of Results (link)'),
      receivedAt: String(row[col['Received At']] || ''), dateReceived: formatDay_(row[col['Date Received']]),
      status: it.status, reason: s ? s.reason : '', statusBy: s && it.status ? s.by : '', statusOn: s && it.status ? s.on : '',
      elsewhere: it.elsewhere ? s.institutionName : '',
      docs: docs[it.ref] ? { id: docs[it.ref].id, results: docs[it.ref].results, note: docs[it.ref].note,
        by: docs[it.ref].by, on: docs[it.ref].on } : { id: '', results: '', note: '', by: '', on: '' }
    };
  };

  var offset = Math.max(0, Math.floor(Number(data.offset) || 0));
  var page = data.all ? rows : rows.slice(offset, offset + PAGE_SIZE);
  return {
    ok: true,
    institution: { id: inst.id, name: inst.name, district: displayDistrict_(inst.district), local: inst.local,
      posts: inst.posts, onForm: !!inst.facility, takesFrom: inst.takesFrom, sharesWith: sharesWith_(inst, allocs) },
    from: fromDistrict ? 'district' : 'institution',
    canSelect: !!user.canSelect,
    counts: counts,
    total: rows.length,
    offset: data.all ? 0 : offset,
    pageSize: PAGE_SIZE,
    rows: page.map(shape)
  };
}

/** HR gives an applicant a status at an institution (or clears it). Every change is logged. */
function select_(data, user) {
  var bad = function (message) { return { ok: false, error: 'invalid', message: message }; };
  if (!user.canSelect) {
    return { ok: false, error: 'forbidden', message: 'You can look at the selection lists, but not change them. Ask the administrator for selection access.' };
  }
  var status = String(data.status || '');
  if (status && SEL_STATUSES.indexOf(status) === -1) return bad('Choose a status from the list.');
  var reason = String(data.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (SEL_NEEDS_REASON[status] && !reason) return bad('Give a reason for "' + status + '".');
  var ref = String(data.ref || '').trim();

  ensureAllocationTabs_();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (err) {
    return { ok: false, error: 'busy', message: 'The system is busy. Please try again in a minute.' };
  }
  try {
    var allocs = allocations_();
    var inst = null;
    allocs.forEach(function (a) { if (a.id === String(data.institution || '')) inst = a; });
    if (!inst || !canSee_(user, inst.district)) return bad('That institution was not found. Refresh the page and try again.');

    var apps = getSheet_();
    var last = apps.getLastRow();
    var refs = last < 2 ? [] : apps.getRange(2, HEADERS.indexOf('Reference') + 1, last - 1, 1).getDisplayValues();
    var at = -1;
    for (var i = 0; i < refs.length; i++) if (refs[i][0] === ref) { at = i + 2; break; }
    if (at === -1) return bad('Application ' + ref + ' was not found.');
    var row = apps.getRange(at, 1, 1, HEADERS.length).getValues()[0];
    var col = {};
    HEADERS.forEach(function (h, j) { col[h] = j; });
    var applied = institutionMatcher_(allocs).all(row[col.NearestFacility], row[col.District]);
    if (applied.indexOf(inst) === -1 && districtCode_(row[col.District]) !== inst.district) {
      return bad('This applicant did not apply for ' + inst.name + ' and does not live in its district.');
    }

    var sel = selections_();
    var current = sel[ref] || null;
    var was = current ? current.status : '';
    if (status && current && SEL_ACTIVE[was] && current.institution !== inst.id) {
      return bad('This applicant is already ' + { Shortlisted: 'shortlisted', Selected: 'selected', Reserve: 'on reserve' }[was] +
        ' at ' + current.institutionName + '. Clear that status there first.');
    }
    if (status === 'Selected' && !docsVerified_(documentChecks_()[ref])) {
      return bad('Verify both the ID document and the proof of results before selecting this applicant.');
    }
    if (status === 'Selected' && !(current && was === 'Selected' && current.institution === inst.id)) {
      var taken = Object.keys(sel).filter(function (r) {
        return sel[r].status === 'Selected' && sel[r].institution === inst.id;
      }).length;
      if (taken >= inst.posts) {
        return bad('All ' + inst.posts + ' posts at ' + inst.name + ' are filled. Put this applicant on Reserve, ' +
          'or change someone else\'s status first.');
      }
    }
    var applicant = String(row[col.Name]) + ' ' + String(row[col.Surname]);
    if (status === was && (!current || current.institution === inst.id) && reason === (current ? current.reason : '')) {
      return { ok: true, status: status, unchanged: true };
    }

    var now = new Date();
    var by = user.name + ' (' + user.username + ')';
    var values = [ref, safeCell_(applicant), String(row[col.SouthAfricanID]).replace(/^'/, ''), displayDistrict_(inst.district),
      safeCell_(inst.name), status, safeCell_(reason), safeCell_(by), now];
    var sheet = headedSheet_(SEL_SHEET, SEL_HEADERS);
    var target = current ? current.row : sheet.getLastRow() + 1;
    sheet.getRange(target, 1, 1, SEL_HEADERS.length - 1).setNumberFormat('@');
    sheet.getRange(target, SEL_HEADERS.length).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(target, 1, 1, SEL_HEADERS.length).setValues([values]);
    var log = headedSheet_(SEL_LOG_SHEET, SEL_LOG_HEADERS);
    var logRow = log.getLastRow() + 1;
    log.getRange(logRow, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    log.getRange(logRow, 1, 1, SEL_LOG_HEADERS.length).setValues([[now, ref, safeCell_(applicant),
      safeCell_((current && current.institution !== inst.id && was ? current.institutionName + ' > ' : '') + inst.name),
      was || 'Not reviewed', status || 'Not reviewed', safeCell_(reason), safeCell_(by)]]);
    SpreadsheetApp.flush();
    return { ok: true, status: status, reason: reason, statusBy: by,
      statusOn: Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd HH:mm') };
  } finally {
    lock.releaseLock();
  }
}

/**
 * HR records the document check for one applicant: ID document and proof of
 * results each Verified, Missing or not checked (''), with an optional note.
 * Logged in Selection History. A Selected applicant must stay fully verified.
 */
function verify_(data, user) {
  var bad = function (message) { return { ok: false, error: 'invalid', message: message }; };
  if (!user.canSelect) {
    return { ok: false, error: 'forbidden', message: 'You can look at the selection lists, but not change them. Ask the administrator for selection access.' };
  }
  var idDoc = String(data.id || ''), results = String(data.results || '');
  if ((idDoc && DOC_VALUES.indexOf(idDoc) === -1) || (results && DOC_VALUES.indexOf(results) === -1)) {
    return bad('Choose Verified or Missing for each document.');
  }
  var note = String(data.note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  var ref = String(data.ref || '').trim();

  ensureAllocationTabs_();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(25000); } catch (err) {
    return { ok: false, error: 'busy', message: 'The system is busy. Please try again in a minute.' };
  }
  try {
    var allocs = allocations_();
    var inst = null;
    allocs.forEach(function (a) { if (a.id === String(data.institution || '')) inst = a; });
    if (!inst || !canSee_(user, inst.district)) return bad('That institution was not found. Refresh the page and try again.');

    var apps = getSheet_();
    var last = apps.getLastRow();
    var refs = last < 2 ? [] : apps.getRange(2, HEADERS.indexOf('Reference') + 1, last - 1, 1).getDisplayValues();
    var at = -1;
    for (var i = 0; i < refs.length; i++) if (refs[i][0] === ref) { at = i + 2; break; }
    if (at === -1) return bad('Application ' + ref + ' was not found.');
    var row = apps.getRange(at, 1, 1, HEADERS.length).getValues()[0];
    var col = {};
    HEADERS.forEach(function (h, j) { col[h] = j; });
    var applied = institutionMatcher_(allocs).all(row[col.NearestFacility], row[col.District]);
    if (applied.indexOf(inst) === -1 && districtCode_(row[col.District]) !== inst.district) {
      return bad('This applicant did not apply for ' + inst.name + ' and does not live in its district.');
    }

    var sel = selections_()[ref];
    if (sel && sel.status === 'Selected' && !(idDoc === 'Verified' && results === 'Verified')) {
      return bad('This applicant is Selected at ' + sel.institutionName + ', so both documents must stay verified. ' +
        'Change the status first if a document is in doubt.');
    }

    var docs = documentChecks_();
    var current = docs[ref] || null;
    if (current && current.id === idDoc && current.results === results && current.note === note) {
      return { ok: true, unchanged: true };
    }
    var now = new Date();
    var by = user.name + ' (' + user.username + ')';
    var applicant = String(row[col.Name]) + ' ' + String(row[col.Surname]);
    var channel = row[col.Channel] === 'Captured' ? 'Paper' : 'Online';
    var sheet = headedSheet_(DOC_SHEET, DOC_HEADERS);
    var target = current ? current.row : sheet.getLastRow() + 1;
    sheet.getRange(target, 1, 1, DOC_HEADERS.length - 1).setNumberFormat('@');
    sheet.getRange(target, DOC_HEADERS.length).setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange(target, 1, 1, DOC_HEADERS.length).setValues([[ref, safeCell_(applicant),
      String(row[col.SouthAfricanID]).replace(/^'/, ''), channel, idDoc, results, safeCell_(note), safeCell_(by), now]]);
    var describe = function (d) {
      return 'Documents: ID ' + ((d && d.id) || 'not checked') + ', results ' + ((d && d.results) || 'not checked');
    };
    var log = headedSheet_(SEL_LOG_SHEET, SEL_LOG_HEADERS);
    var logRow = log.getLastRow() + 1;
    log.getRange(logRow, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    log.getRange(logRow, 1, 1, SEL_LOG_HEADERS.length).setValues([[now, ref, safeCell_(applicant), safeCell_(inst.name),
      describe(current), describe({ id: idDoc, results: results }), safeCell_(note), safeCell_(by)]]);
    SpreadsheetApp.flush();
    return { ok: true, docs: { id: idDoc, results: results, note: note, by: by,
      on: Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd HH:mm') } };
  } finally {
    lock.releaseLock();
  }
}

/** The applications a staff member may see, newest first, after the filters. */
function filterApplications_(data, user) {
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

  return { col: col, matches: matches, counts: counts, district: district };
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

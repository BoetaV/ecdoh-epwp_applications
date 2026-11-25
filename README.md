# EPWP General Workers - advert and online application

Public advert and online application form for the Eastern Cape Department of
Health EPWP General Worker positions. The page is static (GitHub Pages) and saves each application to a
Google Sheet through a Google Apps Script web app.

```
index.html              Advert + application form
assets/config.js        Apps Script URL, age range and closing date
assets/units.js         District > Municipality > Hospital lists (generated)
assets/logo.png         Department of Health logo
apps-script/Code.gs     Backend - paste into the Google Sheet's Apps Script
tools/build_units.py    Rebuilds assets/units.js from docs/EC_EPWP.csv
tools/build_allocations.py  Posts per institution into Code.gs
docs/                   Source lists (reporting units, database fields)
```

## 1. Set up the Google Sheet backend

1. Create a new Google Sheet, for example "EPWP Applications".
2. Open **Extensions > Apps Script**, delete the sample code and paste in the
   contents of `apps-script/Code.gs`. Save.
3. Choose the function **setup** and press **Run**. Approve the permissions.
   "Applications" and "Users" tabs with column headings appear in the Sheet.
   A Drive folder called "EPWP Applications - Supporting Documents" is created
   next to the Sheet in your Google Drive.
4. Press **Deploy > New deployment**, type **Web app**, and set
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the **Web app URL** (it ends in `/exec`).
6. Paste it into `assets/config.js` in place of
   `PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE`.

If you change `Code.gs` later, run **setup** again (Google may ask for new
permissions, for example Drive), then use **Deploy > Manage deployments > Edit >
Version: New version** so the same URL keeps working.

The closing date and the age range are set in two places that must agree:
`assets/config.js` (what applicants see) and the top of `Code.gs` (what the
backend enforces).

## 2. Publish on GitHub Pages

```
git init
git add .
git commit -m "EPWP application site"
git branch -M main
git remote add origin https://github.com/<account>/<repository>.git
git push -u origin main
```

On GitHub open **Settings > Pages**, choose **Deploy from a branch**, branch
**main**, folder **/ (root)**, and save. The site is live a minute or two later
at `https://<account>.github.io/<repository>/`.

## 3. Test

Open the live site, complete the form and submit. A new row should appear in
the Applications tab and the page should show a reference number
(EPWP-000001). Submitting the same ID number again must be refused.

## District office capturing (paper applications)

Staff at the District Offices capture paper applications on the same website:

**https://boetav.github.io/ecdoh-epwp_applications/capture.html**
(or use the link at the bottom of the public page).

- **Requesting an account:** capturers open the sign-in page and choose
  **Request a capturer account**. They fill in their details, pick their
  access (one district, or Provincial for Head Office) and choose their own
  username and password. The request is added to the **Users** tab as
  `Pending`, and the spreadsheet owner gets an email. A pending account
  cannot sign in.
- **Paper form for audit:** capturers must still print, sign and hand in the
  [Capturer Registration Form](docs/EPWP_Capturer_Registration_Form.pdf),
  approved by their supervisor. The request page links to it.
- **Approving:** once the signed form is in, choose **EPWP > Approve account
  requests**. Each waiting request is shown in turn: Yes approves it (records
  "Paper form received", who approved and when), No declines it, Cancel
  leaves it for later. Then let the capturer know they can sign in.
- **Adding someone directly** is still possible with **EPWP > Add a
  capturing user**; the system then makes a password and shows it once.
- Passwords are stored in coded form, so nobody can read them in the Sheet.
- **What each user can see:** a district user captures and sees only
  applicants who live in their district (online and captured). The District
  box on their capture form is fixed to their district. A provincial user
  captures for any district and sees everyone. To change someone's access,
  pick a different value in the **District** column of the Users tab.
- **View applications:** signed-in staff can open **View applications** to
  list, search and filter the applications they are allowed to see, newest
  first, with links to uploaded documents. The document links open only for
  people the Drive folder has been shared with.
- **Download to Excel:** the View applications screen has a **Download to
  Excel** button. It downloads every application in the list currently
  shown (the user's own district, or for provincial users all districts or
  the district they picked, plus any search or Online/Captured filter) as an
  `.xlsx` file. ID and phone numbers keep their leading zeros, and document
  links are clickable. Every download is recorded in the **Downloads** tab
  of the Sheet (who, when, what and how many rows).
- **Forgotten password or locked out** (5 wrong tries locks an account for
  15 minutes): **EPWP > Reset a user's password** gives a new one.
- **Stopping access:** change **Active** to `No` in the Users tab. It takes
  effect immediately, even for someone already signed in.
- **Sign-in lasts 6 hours**, or until the browser tab is closed. If it runs
  out while capturing, the form keeps what was typed; sign in again and save.
- **Each captured row** in the Applications tab shows Channel = `Captured`,
  **Captured By** (name and username), **Captured By District**, **Date
  Received** (from the paper form), **Received At**, and which **Paper
  Documents** were handed in. Online rows show Channel = `Online`.
- **Capturing is not stopped by the online closing date**, so paper forms
  handed in on time can be captured afterwards.
- The same rules apply as online (age 18 to 45, the listed qualifications,
  one application per ID number). Scans of the documents are optional.

### When someone who was captured applies online

As soon as an applicant types their surname and ID number on the online form,
the system checks for an earlier application. If one exists and the surname
matches, they see "Your application has already been received", their
reference number, and where and when their paper application was received.
If the surname does not match, they are only told that an application with
that ID number exists and to contact their District Office, so nobody can look
up someone else's reference number.

Staff capturing a paper application see a warning as soon as they type an ID
number that is already on the system: with the reference number and who
captured it for their own district, or only "already on the system for an
applicant in <district>" for another district.

### Dashboard

Signed-in staff choose **Dashboard** in the staff bar. It shows how many
applications have been received and breaks them down by gender, disability,
age group, how they applied (online or captured), qualification, nearest
facility, and per day. It also shows them by district (for the whole province)
or by local municipality (for one district).

- District users only see their own district. They can narrow it to one of
  their local municipalities.
- Provincial users choose **All districts** or one district, and then
  optionally a local municipality.
- **Download PDF** saves the dashboard as it is shown, as an A4 report with the
  department logo, the figures date and who produced it. The PDF is made in the
  browser. It holds counts only, no names or ID numbers.

The dashboard needs the latest Apps Script deployed (Deploy > Manage
deployments > New version).

## Selection (HR)

Once applications have closed, HR selects the candidates on the **Selection**
screen (staff bar > **Selection**). There are **611 posts** at 118
institutions, from `docs/allocation per institution.csv`.

**Kept apart from the master list.** Selection never changes the Applications
tab. It uses three tabs of its own in the Sheet:

- **Allocations**: the posts per institution. It is filled in automatically the
  first time the Selection screen is opened. After that the tab is what counts,
  so the number of posts can be corrected there.
- **Selections**: the current status of each applicant HR has dealt with.
- **Selection History**: every change ever made, with who made it, when, and the
  reason. Nothing is ever removed from it.

**Who can do what.** Everyone signed in can see the Selection screen for their
own district (provincial users: all districts). Only users with **Selection
access** = `Yes` in the Users tab (a new column at the end) can change a status.
Set it for the HR officials; capturers keep it empty.

**The overview** lists each institution with its posts, how many applied for it
(people who chose it as their nearest facility), applicants per post, the share
of women and youth (18 to 35), people with a disability, and how many are
shortlisted, selected, on reserve and still open. **Download to Excel** gives the
same list. Facilities applicants chose that have no posts are listed below it.

**An institution** (press **Open**) lists its applicants with their age, gender,
disability, ward, qualification (flagged when it is not one of the advertised
qualifications, as with some imported lists) and documents. For each applicant
HR chooses a status and presses **Save**:

| Status | Meaning |
|---|---|
| Not reviewed | Nothing decided yet (the starting point) |
| Shortlisted | Meets the criteria, being considered |
| Selected | Gets one of the posts |
| Reserve | Next in line if a selected person declines |
| Not suitable | Does not meet the criteria (a reason is required) |
| Withdrawn | No longer available (a reason is required) |

The rules the system enforces:

- No more people can be **Selected** than the institution has posts.
- An applicant can be shortlisted, selected or on reserve at only **one**
  institution at a time. Clear the status there first to move them.
- **Applicants: Everyone living in the district** shows all applicants of the
  institution's district, not only those who chose it. Use it for institutions
  that were not on the application form, or that had too few applicants.
- **Download to Excel** on an institution gives its applicants with their status.

**Institutions that were not on the application form.** Nobody could choose
them, so the allocation list names a nearby facility for each (the last column,
*Application from*). The Selection screen shows "Will take applications from
...", and the institution's applicants are the people who chose that facility:

| Institution | Takes applications from |
|---|---|
| Cecilia Makiwane | Nkqubela Hospital |
| Frere Hospital | Empilweni Gompo CHC |
| Dora Nginza Hospital | New Brighton CHC |
| Elizabeth Donkin Hospital | Gqebera CHC |
| Livingstone Hospital | Korsten CHC |
| PE Provincial Hospital | Central CHC |
| Mthatha Regional Hospital | Ngangelizwe CHC |
| Nelson Mandela Academic Hospital | Ngangelizwe CHC |
| Fort England Hospital | Settlers Hospital |
| Mjanyana Hospital | All Saints Hospital |

**Shared applicants.** These applicants are also the applicants of the nearby
facility itself (and Mthatha Regional and Nelson Mandela Academic share
Ngangelizwe CHC). The overview says "Shares applicants with ...". In the list,
anyone who already has a status at another institution is marked, for example
**Already selected at Ngangelizwe CHC**, and cannot be shortlisted, selected or
put on reserve a second time until that status is cleared. The *Applications*
total counts each person once.

If the allocation list changes, update the CSV and run
`python tools/build_allocations.py`, then paste the new Code.gs into Apps Script
and deploy a new version. The first time the Selection screen is opened after
that, the **Allocations** tab is replaced with the new list; the old tab is kept,
renamed "Allocations (replaced <date>)". Statuses already given stay. The script
stops if the posts do not add up to 611.

### Reserved posts (now allocated)

Two lines of the original allocation list were duplicates (Taylor Bequest
Matatiele Hospital, Alfred Nzo, 6 posts; Emplisweni Hospital, Joe Gqabi,
6 posts). Their 12 posts were reserved and have since been allocated to Sarah
Baartman District: Sundays Valley Hospital, SAWAS Hospital (Jansenville),
Aberdeen Hospital and Joubertina CHC, 3 posts each. The record is kept in
`docs/reserved posts.csv`; nothing is reserved any more, so the Selection screen
no longer shows the reserved section.

## Importing a list captured elsewhere (Import tab)

When an office has captured applications in its own Excel list, the
administrator can bring them into Applications from the Sheet, so they get
reference numbers and are checked like any other application.

1. **Get the list into the Sheet without Excel spoiling the numbers.** In the
   Sheet choose **File > Import > Upload**, pick the office's **.xlsx** file
   (not a .csv: a CSV saved by Excel has ID numbers cut short, for example
   `9,41019E+12`, and they cannot be recovered), and choose **Insert new
   sheet(s)**. Then copy the rows, headings included, into the **Import**
   tab (**EPWP > Import a list > 1. Open the Import tab** creates it).
2. **EPWP > Import a list > 2. Check the list.** This changes nothing in
   Applications. It fills in the result columns at the right of the Import tab:
   *Import status* (Ready, Rejected or Duplicate), the ID number and cellphone
   number as they will be saved, the district, local municipality and facility,
   and *Notes* explaining every change or problem.
3. Fix rows in the list if needed and check again.
4. **EPWP > Import a list > 3. Import the ready rows into Applications.** You are
   asked for the date the paper applications were received (unless the list has
   a *Date Received* column). Each ready row gets a reference number, shown in
   the Import tab, and becomes *Imported*. Running it again never adds a row
   twice.
5. When done, **EPWP > Import a list > Clear the Import tab for a new list**.

Columns are recognised by their heading (Name, Surname, Identity No., Age,
Gender, Contact No., Disability, Address, District, Municipality or Local
Municipality, Institution, Ward, Qualification, Qualification Attached, ...);
other columns are ignored. The rules:

- **Cellphone numbers** with 9 digits get their leading 0 back.
- **ID numbers** with 11 or 12 digits (people born 2000 to 2009, whose leading
  0 Excel dropped) get the 0 back, but only if the result is a valid ID and the
  age in the list agrees with the date of birth in the ID.
- **Invalid ID numbers** (wrong length, wrong check digit or date) are
  rejected, as is anyone outside the age range 18 to 45.
- **Duplicates** are left out: an ID number already in Applications (online or
  captured), or repeated in the same list.
- **Gender** F/M becomes Female/Male. When the gender is blank, not
  recognised, or the list has no Gender column, it is taken from the ID number
  (digits 7 to 10: 0000-4999 is female, 5000-9999 is male) and this is noted.
  A gender that does not match the ID number is noted.
- **District and local municipality:** the district comes from a District or
  Municipality column (for example "CHRIS HANI"). The local municipality comes
  from a municipality column when it holds one (for example "EMALAHLENI"),
  otherwise from the institution's place on the facility list.
- **Qualification** is kept as captured, tidied up (for example "GRADE 12"
  becomes "Grade 12"). It is not checked against the qualifications on the
  online form, and the online form is not changed.

Imported rows are saved as *Captured* applications ("Imported by
<administrator>"), so district users see them, and an imported person who
then tries to apply online is told they are already captured, with their
reference number.

## Finding the supporting documents

Applicants upload two documents: a copy of their ID and their proof of results
(school results or qualification certificate).

- **From the Sheet:** the last two columns of each row, "ID Document (link)"
  and "Proof of Results (link)", open that applicant's files.
- **From the menu:** in the Sheet choose **EPWP > Open supporting documents
  folder**.
- **In Google Drive:** the folder "EPWP Applications - Supporting Documents"
  sits next to the Sheet and has one sub-folder per district. Files are named
  `<reference>_<surname>_<name>_ID.jpg` and `..._Results.pdf`, so searching
  Drive for a reference number or surname finds them.

Reference numbers look like `EPWP-20261117-1432-000123`: the date and time
(South African time) the application was received, then a running number.

## Updating the district / municipality / hospital lists

Edit `docs/EC_EPWP.csv`, then run `python tools/build_units.py` and push. The
script also updates the list inside `apps-script/Code.gs` used by the Import
tab, so paste the new Code.gs into Apps Script as well.

## Looking after the data

The Sheet and the Drive folder hold ID numbers, copies of ID documents and
other personal information. Keep them shared only
with the officials who need it; the website never needs the Sheet to be shared,
because the script runs as the Sheet owner.

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

- **Accounts** are kept in the **Users** tab of the Sheet. Add one with
  **EPWP > Add a capturing user**: enter a username, the person's full name
  and their district. The system makes a password and shows it once; give it
  to the person. Passwords are stored in coded form, so nobody can read them
  in the Sheet.
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

Staff capturing a paper application see a warning (with the reference number
and who captured it) as soon as they type an ID number that is already on the
system.

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

Edit `docs/EC_EPWP.csv`, then run `python tools/build_units.py` and push.

## Looking after the data

The Sheet and the Drive folder hold ID numbers, copies of ID documents and
other personal information. Keep them shared only
with the officials who need it; the website never needs the Sheet to be shared,
because the script runs as the Sheet owner.

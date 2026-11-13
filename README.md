# EPWP Candidate Database - registration site

Public registration page for the Eastern Cape Department of Health EPWP candidate
database. The page is static (GitHub Pages) and saves each registration to a
Google Sheet through a Google Apps Script web app.

```
index.html              Landing page + registration form
assets/config.js        The Apps Script URL goes here
assets/units.js         District > Municipality > Hospital lists (generated)
assets/logo.png         Department of Health logo
apps-script/Code.gs     Backend - paste into the Google Sheet's Apps Script
tools/build_units.py    Rebuilds assets/units.js from docs/EC_EPWP.csv
docs/                   Source lists (reporting units, database fields)
```

## 1. Set up the Google Sheet backend

1. Create a new Google Sheet, for example "EPWP Candidate Database".
2. Open **Extensions > Apps Script**, delete the sample code and paste in the
   contents of `apps-script/Code.gs`. Save.
3. Choose the function **setup** and press **Run**. Approve the permissions.
   A "Registrations" tab with the column headings appears in the Sheet.
4. Press **Deploy > New deployment**, type **Web app**, and set
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the **Web app URL** (it ends in `/exec`).
6. Paste it into `assets/config.js` in place of
   `PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE`.

If you change `Code.gs` later, use **Deploy > Manage deployments > Edit >
Version: New version** so the same URL keeps working.

## 2. Publish on GitHub Pages

```
git init
git add .
git commit -m "EPWP candidate registration site"
git branch -M main
git remote add origin https://github.com/<account>/<repository>.git
git push -u origin main
```

On GitHub open **Settings > Pages**, choose **Deploy from a branch**, branch
**main**, folder **/ (root)**, and save. The site is live a minute or two later
at `https://<account>.github.io/<repository>/`.

## 3. Test

Open the live site, complete the form and submit. A new row should appear in
the Registrations tab and the page should show a reference number
(EPWP-000001). Submitting the same ID number again must be refused.

## Updating the district / municipality / hospital lists

Edit `docs/EC_EPWP.csv`, then run `python tools/build_units.py` and push.

## Looking after the data

The Sheet holds ID numbers and other personal information. Keep it shared only
with the officials who need it; the website never needs the Sheet to be shared,
because the script runs as the Sheet owner.

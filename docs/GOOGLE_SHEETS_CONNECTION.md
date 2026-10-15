# Google Sheets connection

Connecting a lead sheet takes a manager about a minute. After that, new rows arrive in the CRM every 2 minutes and go straight to the sales agent on shift. Nobody has to open the CRM for this to happen.

Status (Phase 3): **built and tested with a simulated Google**. Connecting to the real Google needs the one-time setup in the last section. Nothing in that setup has been done yet; it needs your approval.

## What the manager does

1. **Settings → Google Sheets Connections → Connect Google Sheet.**
2. The first time only, sign in with the Academy Google account that owns the lead sheets and click **Allow**.
3. Google's own file picker opens on its own. Pick the spreadsheet.
4. Choose the tab, and confirm the program. The program is guessed from the sheet name: "SAT Leads" gives SAT.
5. Check the column matching. The CRM matches English and Arabic headers automatically:
   - *Timestamp / طابع زمني*
   - *Full name / الاسم بالكامل*
   - *Phone / رقم الموبايل / WhatsApp*
   - *Grade / الصف الدراسي*, *School*, *Target score*, *Exam date*
   - Facebook export headers such as *full_name* and *phone_number*

   Each column shows **Matched** or **Please check**. Any column can be changed or ignored, and answers with no CRM field (such as "Any questions?") can be kept on the timeline as a note. A **preview of the first 10 rows** shows each one as *New lead*, *Existing customer*, *Submitted again*, or *Needs review* with the reason.
6. Choose **Only rows added from now on** (the default) or **Import existing rows too**, then **Start syncing**.

The CRM can open only the files picked in step 3, read-only. It never edits the sheet.

## What happens every 2 minutes

The scheduler (see [SCHEDULER.md](SCHEDULER.md)) calls the CRM. For each connected sheet, the CRM:

- **Reads the tab.** Dates and times are read as values in the sheet's own time zone, so "05/06" is never misread.
- **Checks the columns are still there.**
  - If a column moved, the CRM follows it.
  - If an essential column was renamed or deleted (name, phone, program, or the column used to recognise rows), that sheet pauses and shows a plain message. When the column comes back, or a manager matches it again, syncing resumes by itself. Nothing is imported with wrong columns.
  - If an optional column such as "School" disappears, syncing continues and a warning is shown.
- **Recognises rows by identity, never by row number.** Inserting, deleting or re-sorting rows causes no duplicates and no skipped leads. The identity is:
  - the submission time + phone number, for Google Forms,
  - or a lead ID column, if there is one,
  - or phone + program, for sheets without a time column.

  Every row ever seen is recorded in a ledger in the database. Even two overlapping runs cannot import the same row twice.
- **Handles each new row:**
  - **Valid** → a new inquiry. Phone numbers are normalised, including Arabic digits and Sheets dropping the leading zero. The program comes from a program column or the sheet's program. Answers go into CRM fields; a value that doesn't fit a field (for example "next month" in a date field) is left empty and noted on the timeline.
  - **Phone already belongs to a customer:**
    - With an open inquiry for the same program, the row is logged on that inquiry ("Submitted the form again"). The owner is notified and no duplicate is created.
    - Otherwise, a new inquiry is added on the same customer.
  - **Missing or invalid phone, missing name, unknown program** → **Needs Review**, with the reason. The row is never retried on its own. A manager either **fixes and imports** it or **dismisses** it with a reason.
- **Assigns new leads** to the next eligible agent on shift (round-robin per program). If nobody is eligible, leads wait in the manager's queue and are assigned on a later run.

A long history (thousands of rows) is imported in batches of 400 per run, and the card shows how many remain.

## When something goes wrong

| Situation | What the manager sees |
| --- | --- |
| Google access revoked, password changed, or account removed | Red **Google Sheets stopped syncing** banner and a **Reconnect Google** button. Managers get one notification. Reconnecting takes one click; the column matching is kept. |
| An essential column renamed or removed | That sheet shows **Needs attention** with the column name. It heals by itself when the column is back. |
| Sheet deleted or access lost | **Sheet unavailable**. Leads imported earlier are untouched. |
| Google slow or down | A note on the card. The next run retries; "last successful sync" shows when it last worked. |
| Nobody on shift for a program | Leads wait in the queue. Managers are told at most once an hour. **Run assignment now** is on the Overview. |

## Privacy and security

- Google permissions requested: `openid`, `email` (to show which account is connected), and `drive.file`. Google classifies `drive.file` as **non-sensitive**: the CRM can open only the files you pick in the picker, nothing else in your Drive. [Google: choose Sheets API scopes](https://developers.google.com/workspace/sheets/api/scopes)
- The Google sign-in (refresh token) is encrypted with AES-256-GCM before it is stored. Staff accounts, managers included, cannot read that column; this is checked by an automated test. Only the server uses it.
- Only managers can connect, change or remove sheets, and see Needs Review. This is enforced in the database and on the server, not only by hiding buttons.
- Disconnecting removes the stored sign-in from the CRM and asks Google to revoke it.

## One-time Google setup (needs your approval; free)

Done once, in a Google Cloud project owned by the Academy. I'll walk through it with you; please don't paste any keys into chat or documents.

1. Go to **console.cloud.google.com** and create a project named "Ammar Academy CRM". Note its **project number** (Dashboard → Project info).
2. **APIs & Services → Library:** enable **Google Sheets API**, **Google Drive API** and **Google Picker API**.
3. **Google Auth Platform** (OAuth consent screen):
   - App name "Ammar Academy CRM", support email, logo (optional).
   - Audience: External, or Internal if every user is in the Academy's Google Workspace.
   - Data access: add only `openid`, `.../auth/userinfo.email` and `.../auth/drive.file`.
4. **Publish the app** (Audience → *Publish app*, status **In production**). This matters: while an app is in *Testing*, Google expires its refresh tokens after **7 days**, which would stop syncing every week. [Google: OAuth setup and publishing](https://developers.google.com/health/setup)
   - Because only a non-sensitive permission is used, Google requires only its basic app (brand) verification, not the full security review for sensitive data. Until verification is done, Google may show an "unverified app" notice on the sign-in screen; the manager can continue past it.
   - If the Academy uses Google Workspace, its admin can mark the CRM as trusted instead.
5. **Credentials → Create credentials → OAuth client ID → Web application:**
   - Authorized JavaScript origin: `https://<crm-address>`
   - Authorized redirect URI: `https://<crm-address>/api/google/callback`
6. **Credentials → Create credentials → API key.** Restrict it to the Google Picker API. Under website restrictions, add `https://<crm-address>/*` and `https://docs.google.com/*`. The picker runs inside docs.google.com and fails without that entry. [Google: integrate the Picker](https://developers.google.com/workspace/drive/picker/guides/web-picker)
7. Put the values in the server's secret settings:

   ```
   GOOGLE_MODE=real
   GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…
   GOOGLE_PICKER_API_KEY=…
   GOOGLE_PROJECT_NUMBER=123456789012
   TOKEN_ENCRYPTION_KEY=<32 random bytes, base64: openssl rand -base64 32>
   APP_URL=https://<crm-address>
   ```

   The app refuses to start in `real` mode if any of these are missing.

## What is tested, and what isn't yet

Tested:
- **Unit tests:**
  - English, Arabic and Facebook header matching.
  - Row parsing: serial dates in Cairo summer and winter time, Arabic digits, phones that lost their leading zero, program names in Arabic, review reasons, stable row identity.
  - The real Google client against a mocked network: requested permissions, offline access, token exchange, refused Drive permission, revoked token, error mapping, value request format.
- **Database tests:**
  - The same row imported once, even by three runs at the same time.
  - Repeat submissions and existing customers.
  - A bad field value does not block the lead.
  - "New rows only" baseline.
  - Needs Review: fix, dismiss, and permissions.
  - The token column is unreadable by staff.
  - Reconnect and attention notifications sent only once.
  - Removing a connection keeps its leads.
- **Browser test (simulated Google):** the whole flow above — sign-in, picker, matching, preview, import, scheduled sync, review, revoked access with reconnect, renamed column with self-heal.

Not tested yet: the real Google sign-in screen, the real Google Picker and the real Sheets API. They need the setup above, followed by a live check against a test sheet you own, filled with fictional rows.

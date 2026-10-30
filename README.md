# Stock Requests

A phone-first page for workshop staff to ask for oils and consumables when stock is running low. Replaces sending photos on WhatsApp.

- **Scan the QR label** on the shelf with the phone camera, tap the link, tap **Running low** (or **Urgent: run out**). Done. Two taps.
- After sending, the screen offers **How many left?** buttons (None, 1, 2, 3, 4, 5+, ¼, ½). Optional; ignore them and nothing is lost.
- **No label?** Tap **No label? Take a photo**, snap it, add a short note if needed, tap **Send**.
- If the item has already been asked for, the buttons are replaced by its progress (**Requested → Ordered → Arrived**, with who and when), so nobody asks twice. They can still tap **Make it urgent**.
- **Open** tab: everything waiting to be ordered, on order, or arrived this week.
- **History** tab: how often each item is ordered (times, average gap, urgent count) over 3 months, 12 months or all time, and a CSV download for Excel.
- **Items** tab (managers only): add, edit and remove items, and print QR labels.
- The parts manager gets an **email** and a **phone notification** for every new request, and again if one is bumped to urgent.

Same Supabase project and logins as the courtesy-cars app. No build step: plain HTML, CSS and JavaScript.

## Who can do what

| | Workshop staff | Managers (you + parts manager) |
|---|---|---|
| See items, requests, history | Yes | Yes |
| Raise a request (scan or photo) | Yes | Yes |
| Change quantity left / cancel | Their own, until it's ordered | Any |
| Bump a request to urgent | Any open one | Any |
| Mark ordered / arrived | No | Yes |
| Add, edit, remove items, print labels | No | Yes |
| Phone alerts | No | Yes |

These rules are enforced by the database, not just hidden buttons. Logged-out visitors get nothing at all.

---

## 1. Set up the database (10 minutes)

Use the **same** Supabase project as courtesy cars.

1. In Supabase, open **SQL Editor**, paste in everything from `supabase/schema.sql` and click **Run**. It only adds new tables starting with `stock_`, so courtesy cars isn't touched.
2. Add the managers. Still in SQL Editor, run this with the real sign-in emails:
   ```sql
   insert into public.stock_managers (email, name, notify_email) values
     ('parts.manager@japex.co.uk', 'Parts manager', true),
     ('stuart.hateley@japex.co.uk', 'Stuart', false);
   ```
   `notify_email = true` means that person gets an email for every request. Emails must be lower case.
   To remove someone later: `delete from public.stock_managers where email = '...';`
3. Staff logins: nothing to do. Anyone with a courtesy-cars login can sign in here with the same email and password. New starters are added the same way as before (**Authentication > Users > Add user**). Check **Authentication > Sign In / Providers** still has "Allow new users to sign up" turned **off**.

`config.js` already has the courtesy-cars project address and public key filled in.

## 2. Put it online

Same as courtesy cars: drag this folder onto <https://app.netlify.com/drop>.

**Before you print any labels**, decide on the final web address and don't change it. The QR codes contain the address, so if it changes, every label needs reprinting. Best option: give the Netlify site a proper name (Site settings > Change site name, e.g. `japex-stock.netlify.app`) or point a subdomain like `stock.japex.co.uk` at it. Then put that address in `config.js` as `appUrl` and upload again.

The app needs HTTPS for the camera and phone alerts. Netlify does that for you.

## 3. Add items and print labels

1. Sign in as a manager, open **Items**, tap **+ Add item** for each one: name, size or grade, supplier, usual order quantity.
2. Tick the items you want labels for (or **Select all**) and tap **Print labels**.
3. In the print box: paper A4, margins **None**, scale **100%**, headers and footers off.

Layout is 21 labels per A4 sheet, 63.5 × 38.1 mm (the common "L7160" size, sold by Avery and most own-brands). **Print one on plain paper first** and hold it against a label sheet to check it lines up, as printers vary slightly.

In a workshop, paper labels won't last long. Use waterproof polyester/vinyl labels in the same size, or put clear tape over paper ones. Keep them where a phone camera can see them without moving drums.

A label for a removed item shows "This item has been removed". Put it back from **Items > Show removed items** if it was a mistake.

## 4. Notifications

Both the email and the phone alert are sent by a small Supabase function (`supabase/functions/notify-request/index.ts`), triggered by the database whenever a request is added. Allow about 30 to 45 minutes for all of this.

### 4a. Make the phone alert keys

1. Open `tools/make-keys.html` in a browser on your PC (double-click it) and click **Make keys**.
2. Copy the **public key** into `config.js` as `vapidPublicKey`, and upload the folder to Netlify again.
3. Keep both keys for step 4c. The private key must **never** go in `config.js` or anywhere public.

### 4b. Create the function

1. In Supabase open **Edge Functions** and choose **Deploy a new function > Via editor**.
2. Name it exactly `notify-request`.
3. Delete the sample code, paste in everything from `supabase/functions/notify-request/index.ts`, and click **Deploy**.
4. Open the function's **Details/Settings** and turn **off** "Verify JWT" (sometimes called "Enforce JWT verification"). The function checks its own secret instead.

(If you or someone else uses the Supabase command line, `supabase functions deploy notify-request --no-verify-jwt` does the same.)

### 4c. Add the secrets

**Edge Functions > Secrets** (or Project Settings > Edge Functions). Add:

| Name | Value |
|---|---|
| `WEBHOOK_SECRET` | A long random string, e.g. mash the keyboard for 40 characters. You'll need it again in 4e. |
| `APP_URL` | The app's web address, e.g. `https://japex-stock.netlify.app/` |
| `VAPID_PUBLIC_KEY` | Public key from 4a |
| `VAPID_PRIVATE_KEY` | Private key from 4a |
| `MAIL_FROM` | `accounts@japex.co.uk` |

Then the email ones from 4d.

### 4d. Email: pick the one that matches how accounts@japex.co.uk is hosted

Supabase blocks normal email sending on ports 25 and 587 ([Supabase limits](https://supabase.com/docs/guides/functions/limits)), so the usual Outlook SMTP settings won't work. Use one of these.

If you're not sure which you use: if you read your email in Outlook with a Microsoft 365 login, it's **Option 1**. If you use Gmail with your japex address, it's **Option 2**.

**Option 1: Microsoft 365** (sends from the real mailbox; copies appear in its Sent Items)

You need to be a Microsoft 365 admin. This is the safe way, which only lets the app send as accounts@ and nothing else.

1. Go to <https://entra.microsoft.com> > **App registrations** > **New registration**. Name it `Japex stock alerts`, leave the rest, **Register**.
2. Copy the **Application (client) ID** and **Directory (tenant) ID**.
3. **Certificates & secrets > New client secret**, pick the longest expiry (24 months), copy the **Value** straight away (it's only shown once). Put a reminder in your diary to renew it before it expires, or emails will stop.
4. Do **not** add any API permissions here. (Adding Graph "Mail.Send" in Entra would let the app send as anyone in the company.)
5. Go to **Enterprise applications**, find `Japex stock alerts`, copy its **Object ID** (this is different from the one in step 2).
6. On a Windows PC, open PowerShell and run (one at a time, filling in the IDs):
   ```powershell
   Install-Module ExchangeOnlineManagement
   ```
   ```powershell
   Connect-ExchangeOnline
   ```
   ```powershell
   New-ServicePrincipal -AppId <client ID> -ObjectId <enterprise app Object ID> -DisplayName "Japex stock alerts"
   ```
   ```powershell
   New-ManagementScope -Name "Stock alerts mailbox" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'accounts@japex.co.uk'"
   ```
   ```powershell
   New-ManagementRoleAssignment -App <client ID> -Role "Application Mail.Send" -CustomResourceScope "Stock alerts mailbox"
   ```
   **Check this against Microsoft's current guide before running it**, as they change these commands from time to time: [Role Based Access Control for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac). It can take up to an hour or two to start working.
7. Add Supabase secrets: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`.

**Option 2: Google Workspace (or any email host that offers SSL on port 465)**

1. In the Google account for accounts@, turn on 2-Step Verification, then create an **App password** (Google Account > Security > App passwords).
2. Add Supabase secrets: `SMTP_HOST` = `smtp.gmail.com`, `SMTP_USER` = `accounts@japex.co.uk`, `SMTP_PASS` = the app password.

**Option 3: Resend** (a sending service; free for this volume)

1. Sign up at <https://resend.com>, add the domain `japex.co.uk`, and add the DNS records it shows you (whoever manages your domain can do this). Wait for it to say Verified.
2. Create an API key and add the Supabase secret `RESEND_API_KEY`.

If more than one is set up, the function uses Microsoft first, then SMTP, then Resend.

### 4e. Connect the database to the function

1. In Supabase find **Database Webhooks** (under **Database > Webhooks**, or **Integrations** in newer dashboards). Enable it if asked, then **Create a new hook**.
2. Name: `stock request alert`. Table: `stock_requests`. Events: tick **Insert** and **Update**.
3. Type: **Supabase Edge Functions**, function `notify-request`, method POST.
4. Under HTTP Headers add: name `x-webhook-secret`, value = your `WEBHOOK_SECRET` from 4c.
5. Create.

Update events are needed for the "now urgent" alert. All other updates (ordered, arrived) are ignored by the function, so the parts manager isn't pestered.

### 4f. Turn on alerts on the parts manager's iPhone

Apple only allows web app notifications when the app is added to the Home Screen. This is Apple's rule, not something the app can get round.

1. iPhone must be on **iOS 16.4 or newer** (Settings > General > About > iOS Version).
2. Open the app's address in **Safari** (not Chrome) and sign in.
3. Tap the **Share** button (square with an arrow up), scroll down, tap **Add to Home Screen**, then **Add**.
4. Open **Stock** from the Home Screen (not from Safari). **Sign in again**: the Home Screen app keeps its own login, separate from Safari.
5. Tap **Alerts** (top right), then **Turn on alerts**, then **Allow**.
6. Tap **Send a test**. A notification and a test email should arrive within a few seconds.

If it doesn't work:
- If "Allow" was declined by mistake: Settings > Notifications > **Stock** > Allow Notifications on. If Stock isn't listed, delete the Home Screen icon and start again from step 3.
- A **Focus** mode (Do Not Disturb, Work, Sleep) can silence it. Add Stock to the allowed apps in that Focus.
- Removing the Home Screen icon turns alerts off. Re-add and repeat.
- Each phone needs doing separately. You can do it on your phone too if you want alerts (you're a manager), and you'll get them even if `notify_email` is false for you.

Android: open in Chrome, tap Alerts, Turn on alerts. Adding to the Home Screen is optional on Android.

On a PC in the parts office, Chrome or Edge can also get alerts: open the app, tap Alerts, allow. They only show while the browser is running.

---

## How staff use it

- **Scanning a label**: open the normal Camera app, point it at the label, tap the yellow link that pops up. It opens in Safari on the item. Tap **Running low**.
- First time on each phone they'll need to sign in (same as courtesy cars). It stays signed in after that. If a phone doesn't open the app for a week or so, Safari may clear the login and ask again (that's Safari's privacy rule, from memory; not something I've been able to test).
- Labels open in Safari, not the Home Screen app, even if it's installed. That's normal on iPhone and fine for staff. The Home Screen app is only needed for the parts manager's alerts.
- **No label**: open the app, tap **No label? Take a photo**.

## Security

- Row Level Security is on for every table, and logged-out visitors are refused outright (I tested this against a local copy of the database: every table returns "permission denied" without a login. Worth a quick check on the real one, see below).
- Photos are in a private storage bucket. Only signed-in staff can see them; links expire after a few hours (7 days in the email).
- Who asked, when, and who ordered is filled in by the database, so it can't be faked from a phone.
- Requests are never deleted (cancelled ones are kept and marked), so the history stays complete.
- `config.js` contains only the public key, which is designed to be public. The private keys and email passwords only live in Supabase secrets.
- **This GitHub repository is public.** Nothing secret is in it, but the courtesy-cars repo is private, and you may want this one private too (GitHub > Settings > Change visibility). Netlify Drop doesn't need it public.

## Files

- `index.html`, `app.css`, `app.js` the app
- `config.js` Supabase address, label web address, alerts public key
- `sw.js`, `manifest.webmanifest` needed for phone alerts and Add to Home Screen
- `lib/qrcode.js` QR code maker (MIT licence, by Kazuhiko Arase), kept here so labels work offline
- `tools/make-keys.html` makes the phone alert keys
- `supabase/schema.sql` tables, duplicate blocking, security rules
- `supabase/functions/notify-request/index.ts` sends the email and phone alerts

## Quick check after setup

In a private/incognito browser window (not signed in), open:
`https://qxkyxbtywkczjpqifxwo.supabase.co/rest/v1/stock_requests?apikey=<the publishable key from config.js>`
You should see a "permission denied" error, not a list. If you see data, stop and check `schema.sql` ran fully.

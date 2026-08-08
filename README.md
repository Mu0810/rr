# Rocket Recruiters — Candidate Application Portal

Candidates pick a hiring track, answer questions tailored to that role, attach a
CV, and submit. Everything lands in a password-protected dashboard you own.

Built for the **Hack Daily** mandate, but the tracks and questions live in one
file, so it retargets to another client by editing that file.

**Zero npm dependencies.** Node's built-in `node:sqlite`, `fetch` and `FormData`
do all the work — nothing to install, nothing to keep patched.

## Run it

```bash
npm start          # http://127.0.0.1:4173
npm run dev        # same, restarts on file changes
npm test           # 42 tests, no network or fixtures needed
```

On first boot an admin password is generated and printed **once**. Save it, or
set your own:

```bash
ADMIN_PASSWORD='something-long-and-random' npm start
```

- Candidate portal → `/`
- Recruiter dashboard → `/admin`

## The five tracks

| Code | Track | What it additionally asks |
|------|-------|---------------------------|
| CRM | CRM & Retention | Tools run (Klaviyo, WebEngage…), channels owned, retention metrics, customer-base size, a number they moved |
| OFM | Offline Marketing | Channels (BTL, general/modern trade, gyms, q-commerce), regions, field-team size, monthly budget |
| BRM | Brand Management | Categories managed, launches led, brand budget, remit, FSSAI claims experience |
| GDS | Graphic & Motion Design | Portfolio link (**required**), tools, specialities, motion depth, weekly output, print/pre-press |
| CXO | Leadership / CXO | Mandate fit, P&L owned, headcount led, company stage, comp structure, confidentiality flag |

Every candidate also answers a common set — contact, city, onsite commitment,
experience, notice period, expected CTC, LinkedIn, source — plus a short pitch.

## Onsite only

All roles on this mandate are **onsite at Udyog Vihar Phase 2, Sector 20,
Gurugram**, five days a week. The form's second question is a knockout:

> This role is onsite at our Gurugram office, five days a week. Which is true for you?
> - I live in Gurugram — short commute
> - I live elsewhere in Delhi NCR and can commute daily
> - I am outside Delhi NCR and will relocate for this role
> - I need remote or hybrid work

Choosing the last option ends the application on step one — before the role
questions and before the CV upload. Nothing is stored and nothing is emailed, so
you never review an application you cannot place, and the candidate is not left
waiting on a reply that was never coming. It is enforced server-side as well as
in the form, so it cannot be bypassed by editing the page.

The three passing answers are deliberately distinct rather than a single yes: a
daily cross-NCR commute to Udyog Vihar is a real attrition risk, so it is worth
knowing at screening time whether someone is local, commuting in from Noida or
Delhi, or relocating. The answer lands in the email, the Sheet and the CSV.

The exact address is shown in the hero with a Google Maps link and repeated in
the footer, so a candidate can judge the commute before applying rather than
discovering it at offer stage.

### Changing the office

Three values, because they do different jobs — the address is what a candidate
needs, the city is what reads correctly inside a question ("I live in Gurugram"),
and the region is what makes a daily commute plausible from outside the city:

```bash
OFFICE_ADDRESS='Udyog Vihar Phase 2, Sector 20, Gurugram' \
OFFICE_CITY='Gurugram' \
OFFICE_REGION='Delhi NCR' \
npm start
```

The hero, footer, map link, form question, knockout message and boot log all
follow these — there is no hardcoded address anywhere else.

## Where the data goes

| What | Where |
|------|-------|
| Application answers | `data/applications.db` (SQLite) |
| CV files | `uploads/`, named by reference, mode `600` |
| Secrets | `data/instance.json`, mode `600` |

Nothing leaves the machine unless you configure a webhook. `.gitignore` already
excludes all three.

In the dashboard you can filter by track and status, search name/email/phone/ref,
download any CV, move candidates through the pipeline (new → reviewing →
shortlisted → interviewing → hired/rejected), keep private notes, and export
filtered results to CSV.

### Instant alerts

Three destinations, each switched on by configuration alone. Every one is
optional — with none set, applications still land in the dashboard.

Deliveries are **queued in the database and retried** (1min, 5min, 15min, 1h,
6h). A destination being down never blocks or fails a candidate's submission,
and the dashboard shows a warning strip with a "Retry now" button if anything is
stuck. Each application's detail panel lists exactly where it was delivered.

#### Email

Works with a Gmail app password — no third-party service, no API key.

```bash
SMTP_HOST=smtp.gmail.com \
SMTP_PORT=465 \
SMTP_USER='you@yourdomain.com' \
SMTP_PASS='your-16-char-app-password' \
MAIL_FROM='Rocket Recruiters <you@yourdomain.com>' \
MAIL_TO='you@yourdomain.com,partner@yourdomain.com' \
npm start
```

For Gmail you need an **app password**, not your account password: Google
Account → Security → 2-Step Verification → App passwords. Zoho, Brevo, Mailgun
and Amazon SES SMTP all work the same way.

`MAIL_TO` takes a comma-separated list. Each email's **Reply-To is set to the
candidate**, so replying in your inbox writes straight to them. The subject line
is `[CRM] Ananya Sharma - 4.5 yrs, Delhi NCR (RR-CRM-8F3K2A)` so the inbox sorts
and searches usefully.

Credentials are never sent unencrypted to a remote host: the client uses
implicit TLS on 465, upgrades via STARTTLS when offered, and refuses to
authenticate in clear text to anything that is not a local relay.

#### Google Sheet

One row per application, appended live. No Google Cloud project, no service
account, no OAuth.

1. Create a Sheet, name the first tab `Applications`.
2. Extensions → Apps Script, paste `google-apps-script/Code.gs`.
3. Change `SHARED_SECRET` in that script to a long random string.
4. Deploy → New deployment → **Web app**, execute as **Me**, access **Anyone**.
5. Copy the `/exec` URL and start the portal with:

```bash
SHEETS_WEBHOOK_URL='https://script.google.com/macros/s/…/exec' \
SHEETS_SHARED_SECRET='the same string you set in the script' \
npm start
```

Access must be "Anyone" for the portal to POST to it, which is why the shared
secret exists — requests without it are rejected. The header row is created
automatically; add a key to `COLUMNS` in the script to add a column.

#### Generic webhook

```bash
NOTIFY_WEBHOOK_URL='https://hooks.slack.com/services/...' npm start
```

Any JSON endpoint — Slack, Zapier, n8n. Receives a ready-to-read `text` summary
plus the full application object.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4173` | Listen port |
| `HOST` | `127.0.0.1` | Bind address. **Only widen this behind a reverse proxy with TLS.** |
| `PUBLIC_URL` | — | Public base URL, used for the dashboard link inside emails |
| `OFFICE_ADDRESS` | `Udyog Vihar Phase 2, Sector 20, Gurugram` | Shown to candidates, used in the knockout message |
| `OFFICE_CITY` | `Gurugram` | Used inside the onsite question wording |
| `OFFICE_REGION` | `Delhi NCR` | The commutable region around the office |
| `ADMIN_PASSWORD` | generated | Dashboard password |
| `COOKIE_SECURE` | `false` | Set `true` once served over HTTPS |
| `DB_PATH` | `data/applications.db` | Database location |
| `UPLOAD_DIR` | `uploads/` | CV storage |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` | — | Mail server |
| `MAIL_FROM` `MAIL_TO` | — | Sender, and comma-separated recipients |
| `SHEETS_WEBHOOK_URL` `SHEETS_SHARED_SECRET` | — | Google Sheet bridge |
| `NOTIFY_WEBHOOK_URL` | — | Generic JSON webhook |
| `RATE_LIMIT_SUBMISSIONS` | `5` | Stored applications per IP per hour |
| `RATE_LIMIT_ATTEMPTS` | `60` | Total requests per IP per hour |

## Adding or changing questions

Edit `src/schema.js` — it is the single source of truth. The browser renders the
form from `GET /api/schema` and the server validates against the same
definition, so a new question appears in the form, gets validated, gets stored,
shows in the dashboard and lands in the CSV with no other change. No migration
is needed: answers are stored as JSON.

## Security notes

Implemented:

- CVs are stored outside the web root and served only through an authenticated
  route — they cannot be guessed at a public URL.
- Uploads are checked by magic bytes, not just extension, so a renamed script or
  executable is rejected.
- Stored filenames are generated, never derived from user input; path traversal
  is blocked on both static serving and CV download.
- Every field is re-validated server-side against the schema; `select` and
  `multiselect` values must match the declared options exactly.
- Password hashed with scrypt, compared in constant time. Session cookie is
  HttpOnly + SameSite=Strict.
- Rate limits on submissions and logins. Failed validation does not consume a
  candidate's submission budget.
- Honeypot field and a minimum completion time to catch bots.
- CSV cells beginning `=`, `+`, `-`, `@` are prefixed so a malicious value
  cannot execute as a formula in Excel.
- Duplicate guard: same email + same track within 24h is refused.

Known limitations, worth deciding on before this goes public:

1. **One shared admin password.** Fine for a couple of recruiters. If the whole
   team needs access, add per-user accounts so you can revoke one person.
2. **No HTTPS on its own.** Put it behind a reverse proxy (Caddy, nginx, or a
   platform that terminates TLS) and set `COOKIE_SECURE=true`.
3. **No backups.** `data/` and `uploads/` are the only copies of candidate data.
   Schedule an off-machine backup before you take real applications.
4. **Single process.** The rate limiter is in-memory, so it resets on restart
   and would not be shared across multiple instances.

## Data protection

You are collecting personal data and CVs. The form states what the data is used
for and asks for explicit consent, and the footer explains removal. Keep to
that: use applications only for this hiring process, delete on request, and do
not forward CVs beyond Hack Daily's hiring team.

## Deploying

`hackdailylife.com` is a Shopify store, so it cannot run this server. Two
options:

1. **Standalone (recommended)** — host this on your own domain, e.g.
   `careers.rocketrecruiters.com`, and link to it from the Shopify site. It is
   yours, reusable for every future client, and touches nothing in the client's
   store.
2. **Embedded** — host it as above and iframe the form into a Shopify page. Same
   server, just framed. Needs a relaxed frame policy and loses some styling
   control.

Either way it needs a small always-on host (a €4–5/month VPS is plenty) or a
platform with a persistent disk — SQLite and the CV files need storage that
survives restarts, so a purely ephemeral serverless host will not work without
moving to hosted Postgres and object storage.

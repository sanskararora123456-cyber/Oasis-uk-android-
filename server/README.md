# Oasis server

The backend the Oasis UK Steel Doors app signs in to. It holds the company
database — customers, suppliers, doors, documents, payments, expenses, stock and
staff — and hands the app its state on every sign-in and after every save.

The app runs in secure mode: it keeps **no** company database on the phone. Close
the app and the device holds nothing but the server address. So this server is
where the business data actually lives, and it is the thing that needs backing up.

No third-party packages. Node 22.5 or newer is the only requirement.

---

## Quick start

```bash
cd server

# 1. Create the workspace and its first branch
node bin/oasis-admin.js create-workspace \
  --code OASIS --name "Oasis UK Steel Doors" \
  --branch "Ghaziabad" --branch-code GZB

# 2. Create yourself an admin sign-in (prints a PIN — write it down)
node bin/oasis-admin.js add-user --workspace OASIS --name "Sanskar" --role admin

# 3. Run it
npm start
```

That prints something like:

```
  Workspace code : OASIS
  User name      : Sanskar
  PIN            : 48210773
```

Those three values are exactly what the app's sign-in screen asks for, along with
the server address.

---

## The app will not accept a plain `http://` address

The Android app is built with `usesCleartextTraffic="false"`, so it refuses
unencrypted connections. That is deliberate — a PIN and a full customer database
should not cross a network in the clear — and it means **you need an `https://`
address before the app can sign in.**

Two ways to get one.

### Fastest: a Cloudflare tunnel

Good for trying it today, or for running the server on a machine in the shop with
no fixed IP address. No ports to open on your router.

```bash
npm start                                  # terminal 1, serves on :8080
cloudflared tunnel --url http://localhost:8080   # terminal 2
```

`cloudflared` prints a `https://something.trycloudflare.com` address. Type that
into the app. A free quick tunnel gets a new address each restart; a named tunnel
on your own domain keeps it stable.

### Proper: your own domain on a small server

Point a domain at a VPS, then put [Caddy](https://caddyserver.com) in front —
it gets and renews the certificate on its own. See `deploy/Caddyfile.example`
and `deploy/oasis-server.service`:

```bash
sudo cp deploy/oasis-server.service /etc/systemd/system/
sudo systemctl enable --now oasis-server
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile   # edit the domain first
sudo systemctl reload caddy
```

Then the app's server address is `https://oasis.yourdomain.com`.

---

## Configuration

Everything is an environment variable; nothing secret is in the repository.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` behind a proxy |
| `OASIS_DB` | `./data/oasis.db` | The database file |
| `OASIS_JWT_SECRET` | generated | Signing key for access tokens |
| `OASIS_ACCESS_TTL` | `1800` | Access-token life, seconds |
| `OASIS_REFRESH_TTL` | `2592000` | Refresh-token life, seconds (30 days) |
| `OASIS_LOGIN_MAX_ATTEMPTS` | `8` | Failed sign-ins before lockout |
| `OASIS_LOGIN_LOCKOUT` | `900` | Lockout length, seconds |
| `OASIS_TRUST_PROXY` | off | Set `1` **only** behind your own proxy |
| `OASIS_BACKUP_EVERY_HOURS` | `0` (off) | Back up automatically on this interval |
| `OASIS_BACKUP_DIR` | `./backups` | Where backups are written |
| `OASIS_BACKUP_KEEP` | `14` | How many to keep before deleting the oldest |
| `OASIS_REPLICA_PATH` | off | Keep a live standby copy here (another disk or machine) |
| `OASIS_REPLICA_EVERY_SECONDS` | `60` | How often to refresh the standby |

Set `OASIS_JWT_SECRET` in production:

```bash
OASIS_JWT_SECRET=$(openssl rand -base64 48)
```

Without it the server generates a key and keeps it in the database, which works
but ties your sessions to that one file.

`OASIS_TRUST_PROXY=1` makes the server believe the `X-Forwarded-For` header. Turn
it on only when a proxy you control sets that header, otherwise anyone can spoof
an address and walk around the sign-in lockout.

---

## Admin commands

```bash
node bin/oasis-admin.js list-workspaces
node bin/oasis-admin.js create-workspace --code OASIS --name "..." [--branch "..."] [--branch-code HO]
node bin/oasis-admin.js add-user    --workspace OASIS --name "..." [--role admin] [--pin 12345678]
node bin/oasis-admin.js list-users  --workspace OASIS
node bin/oasis-admin.js reset-pin   --workspace OASIS --name "..." [--pin 12345678]
node bin/oasis-admin.js add-branch  --workspace OASIS --name "..." [--code GZB]
node bin/oasis-admin.js set-branches --workspace OASIS --name "..." --branches GZB,LONI
node bin/oasis-admin.js set-branches --workspace OASIS --name "..." --all
node bin/oasis-admin.js backup [--out DIR] [--keep 14] [--list]
node bin/oasis-admin.js stock-check --workspace OASIS
node bin/oasis-admin.js report      --workspace OASIS [--parties] [--from ...] [--to ...]
node bin/oasis-admin.js enable-2fa  --workspace OASIS --name "..."
node bin/oasis-admin.js disable-2fa --workspace OASIS --name "..."

# when something is wrong — see the section below
node bin/oasis-admin.js verify       --workspace OASIS
node bin/oasis-admin.js history      --workspace OASIS --id <record id> [--full]
node bin/oasis-admin.js what-changed --workspace OASIS --from 2026-09-14
node bin/oasis-admin.js revert       --workspace OASIS --id <id> --to 4 [--confirm]
node bin/oasis-admin.js revert       --workspace OASIS --id <id> --undelete [--confirm]
node bin/oasis-admin.js clone        --out /tmp/scratch.db
```

`stock-check` adds up the stock ledger and compares it with what each product
says it holds. They should agree; a difference means a quantity changed without a
movement being recorded, which is worth looking into. Products that already
existed before this server started counting will show their opening quantity as a
difference once.

`set-branches` restricts someone to certain branches: they are then sent only
those branches' documents, payments, expenses and accounts, and cannot write into
any other. `--all` lifts the restriction. They need to sign in again for it to
take effect on their device.

Roles are `admin`, `admin2`, `salesman`, `accountant`, `storeman`. Once an admin
exists, everyone else is easier to add from the app's **People → Staff and access**
screen, which also sets per-person permissions.

PINs are 8–12 digits, stored as a scrypt hash. They cannot be read back — if one
is forgotten, `reset-pin` issues a new one and signs that person's devices out.

---

## When something is wrong, months later

This is the part that matters most, and it is worth reading before you need it.

The guiding rule is the one the books already follow: **you do not rub out a
wrong entry, you post a correction.** Every version of every record is kept, so
a fault can be seen, understood and put right on its own — without restoring a
backup and throwing away everything that happened since.

### 1. Find out what is actually wrong

```bash
node bin/oasis-admin.js verify --workspace OASIS
```

Reads every record and checks it against every rule the server enforces on
writes: do the figures on each document match its lines, does every journal
balance, does each product agree with its stock movements, is any amount
negative or not a number, does anything point at a customer, branch or account
that no longer exists, are two documents sharing a number, would the next
document reuse one. **It only reads.** It changes nothing, so it is safe to run
on a Friday afternoon.

It separates what should not be true from what is only worth a look, and prints
the id of anything it finds.

### 2. Find out how it got that way

```bash
node bin/oasis-admin.js history --workspace OASIS --id <the id>
```

Every version of that record, oldest first, with the date, who made the change,
and which fields changed at each step:

```
  v1   2026-04-02T09:14:02Z   Sanskar
  v2   2026-04-11T16:02:55Z   Ravi
        phone: "9810000001"  ->  "9810000002"
  v5   2026-09-14T11:31:07Z   Ravi
        gstin: "09AAAAA0000A1Z5"  ->  ""
```

If you do not know which record, start from the time instead:

```bash
node bin/oasis-admin.js what-changed --workspace OASIS --from 2026-09-14
```

### 3. Put it right

```bash
# Shows exactly what would change. Changes nothing.
node bin/oasis-admin.js revert --workspace OASIS --id <id> --to 4

# Do it.
node bin/oasis-admin.js revert --workspace OASIS --id <id> --to 4 --confirm \
  --reason "GST number wiped by a bug in the September build"
```

The dry run is the default; nothing is written until `--confirm`. The old
content goes back **as a new version on top**, so:

- the wrong value is still in the history, with the date it was made and the
  date it was undone
- everything done since is untouched — invoices raised after the fault stay
  exactly as they are
- the repair itself is in the activity log, with the reason
- and the repair can itself be reverted, if it turns out to have been wrong

Something deleted by mistake comes back whole, figures and all:

```bash
node bin/oasis-admin.js revert --workspace OASIS --id <id> --undelete --confirm
```

Everyone needs to reopen the app to see the change.

### 4. Fixing the code, not the data

If the fault is in the software rather than one record, work on a copy:

```bash
node bin/oasis-admin.js clone --out /tmp/scratch.db
OASIS_DB=/tmp/scratch.db npm start        # reproduce it here
OASIS_DB=/tmp/scratch.db node bin/oasis-admin.js verify --workspace OASIS
```

Reproduce it against real data without touching the real thing, fix it, run
`npm test`, and only then deploy. If a fix needs a schema change, add a
migration (below) — the server takes its own copy of the database before running
one, into `pre-migration/`, so there is always a way back.

Rolling back the code is putting the previous version back and restarting. Roll
back the *data* only if you have to, and know that it costs you everything since
that backup — which is what the history above exists to avoid.

### What the history does not cover

- Changes made **before** the history existed. It starts from this version.
- Rows changed by editing the SQLite file directly, behind the server's back —
  `verify` will notice the damage, but there is no history of who did it.
- Staff records, settings and the numbering counters live outside `records` and
  are not versioned. Staff changes are in the activity log.
- It grows. Every version of every record is kept, so on a busy database the
  file gets larger over time; that is the trade for being able to undo a
  six-month-old mistake.

## Two-factor sign-in

Worth turning on for anyone who can change staff access or see cost prices.

```bash
node bin/oasis-admin.js enable-2fa --workspace OASIS --name "Sanskar"
```

That prints a set-up key and an `otpauth://` link. Add either to Google
Authenticator, Authy or 1Password — paste the key, or turn the link into a QR
code and scan it. The command also prints the code the app should be showing
right then, so you can check it matches before relying on it.

From then on that person types their PIN and then the six-digit code into the
**Authenticator code** box on the sign-in screen. Everyone else leaves that box
empty.

The key is not stored anywhere readable. If someone loses their phone, run the
command again to issue a new one; `disable-2fa` turns it off entirely. Either
way their other devices are signed out immediately.

## The books, worked out here

The server derives the figures itself, from records it has already checked, so
there is a set of numbers that does not depend on any phone:

```bash
node bin/oasis-admin.js report --workspace OASIS --parties
node bin/oasis-admin.js report --workspace OASIS --from 2026-04-01 --to 2027-03-31
```

Sales, purchases, expenses, gross and net profit, GST on sales, cash and bank
balances, what customers owe and what you owe suppliers, receivables bucketed by
how overdue they are, and a trial balance across every journal entry.

The same thing is available to the app's own staff over HTTP at
`GET /v1/reports/summary` (`?branch=`, `?from=`, `?to=`), which needs
`see_reports`; cost prices and profit are left out for anyone without
`see_costs`.

The definitions are the app's own — an invoice raises what a customer owes, a
credit note lowers it, money in settles receivables — so the two are directly
comparable. **Where they disagree, that is worth looking into rather than
assuming either is right.** The point of computing them twice is that a
disagreement is visible at all.

## Backups

Everything is in the one SQLite file, so a backup is a consistent copy of it.
**Never** copy `oasis.db` with `cp` while the server is running: you get a torn
file that may only reveal itself months later, when you need it.

Take one now:

```bash
npm run backup                       # writes into ./backups and verifies it
node bin/oasis-admin.js backup --list
node bin/oasis-admin.js backup --out /mnt/usb --keep 30
```

Each backup is written with SQLite's own `VACUUM INTO`, which produces a complete
database while the server keeps serving. It is then reopened, put through an
integrity check and counted, so a backup is never merely assumed to have worked.

### Automatic

Set an interval and the server backs itself up while it runs:

```bash
OASIS_BACKUP_EVERY_HOURS=6 OASIS_BACKUP_KEEP=28 npm start
```

That is already in `deploy/oasis-server.service`. It runs one on startup and then
on the interval, keeping the newest `OASIS_BACKUP_KEEP` and deleting the rest.

### Get them off the machine

A backup on the same disk as the database protects you from a mistake, not from
the drive failing. Copy them somewhere else — nightly is fine:

```bash
0 2 * * *  rsync -a /var/lib/oasis/backups/ user@elsewhere:/backups/oasis/
```

## A standby copy

Backups every few hours cover a mistake. They are thin comfort at four on a
Friday when the disk dies and the last one is from lunchtime. Point
`OASIS_REPLICA_PATH` at another disk, or at a mount from another machine, and a
complete copy is written there every minute:

```bash
OASIS_REPLICA_PATH=/mnt/standby/oasis.db OASIS_REPLICA_EVERY_SECONDS=60 npm start
```

The copy is written under a temporary name and renamed into place, so whoever
picks it up gets a whole database and never one caught mid-write. It is opened
and integrity-checked before it replaces the last good one, and `/health` reports
how fresh it is — returning 503 if it falls more than three intervals behind, so
whatever watches the service notices before you need it.

**Switching over** is manual, and takes about two minutes:

```bash
sudo systemctl stop oasis-server          # if the old machine still answers
sudo cp /mnt/standby/oasis.db /var/lib/oasis/oasis.db
sudo chown oasis:oasis /var/lib/oasis/oasis.db
sudo systemctl start oasis-server         # on the standby machine
```

Then point the domain at the new machine. Everyone signs in again, and you lose
at most the last minute of work.

Be clear about what this is not: nothing here notices the main machine has died,
and nothing moves traffic on its own. Automatic failover needs a load balancer or
DNS failover deciding which machine is live. That is a hosting choice; this gives
you the current data to fail over *to*, which is the part that has to exist first.

`test/hardening.test.js` promotes a standby copy into a second server and signs
in to it, so this path is exercised rather than hoped for.

### Restoring

Stop the server, put the file in place, start it:

```bash
sudo systemctl stop oasis-server
sudo cp /backups/oasis-2026-09-04T02-00-00-000.db /var/lib/oasis/oasis.db
sudo chown oasis:oasis /var/lib/oasis/oasis.db
sudo systemctl start oasis-server
```

Everyone signs in again afterwards, and any work done after that backup was taken
is gone. `test/integrity.test.js` restores a backup into a second server and signs
in to it, so this path is exercised rather than hoped for.

The app's own **Back up to a file** button is switched off in secure mode on
purpose: it would put the whole company database on the phone, which is the thing
secure mode exists to prevent.

---

## The API

Five routes. All JSON. Everything except `/health` and the two auth routes needs
`Authorization: Bearer <accessToken>`.

| Route | Purpose |
| --- | --- |
| `GET /health` | Reachability. The app's Sync screen calls this |
| `POST /v1/auth/login` | `{workspaceCode, name, pin, deviceLabel, platform}` → tokens |
| `POST /v1/auth/refresh` | `{refreshToken}` → a new pair |
| `GET /v1/client/bootstrap` | The whole workspace state |
| `POST /v1/client/operations` | `{operations:[...]}` — a batch of changes |

Access tokens last 30 minutes; the app refreshes them on its own. Refresh tokens
are single-use — redeeming one issues a replacement and retires the old one, so a
stolen refresh token stops working as soon as the real device uses its copy.

Send an `Idempotency-Key` header with an operations batch and a retry after a
dropped connection will not apply it twice. A batch is one transaction: if any
operation is rejected, none of them are applied.

### How saving works

The app builds a record completely on the phone — document number, totals, line
specs, notes — then sends it and immediately replaces its own state with whatever
`bootstrap` returns next. So a record has to come back **exactly** as it went in.
Anything the server quietly drops or reshapes shows up as the user's typing
vanishing, and it also makes the app resend that record on every save forever.

That is why records are stored verbatim, and why the server owns only what it
genuinely should:

- **Document numbering.** The per-branch, per-type counter lives here. On the
  phone, two devices would hand out the same invoice number.
- **The activity log**, including sign-ins.
- **Stock movement history**, in `stock_ledger`.
- **Every authorisation decision.** Only an admin can change staff access, and no
  workspace can read another, whatever the app asks for.

---

## Security model

What is actually enforced, and what is not. Read this before trusting it with
real money.

### Enforced here, on the server

- **Permissions on every operation.** The app hides screens a person may not use,
  but that is a courtesy, not a control — the app is on someone else's phone and
  anyone holding a token can send requests directly. `src/permissions.js` mirrors
  the app's own role table and re-checks every operation. A salesman cannot delete
  an invoice, read or rewrite a cost price, touch a cash account, record a payment,
  write a journal entry or create a branch, no matter what they send.
  `test/permissions.test.js` tries all of those as a salesman and requires a 403.
- **Nobody can promote themselves.** A person may change their own PIN and display
  name. Role, permissions, branch and whether the account is switched on are grants
  from an admin, and a self-edit cannot touch them.
- **Workspace isolation.** Every query is scoped by workspace. One firm's token
  returns nothing belonging to another.
- **PINs never come back.** They are stored as scrypt hashes and are never included
  in any response, so the phone never holds one.
- **Brute force.** Sign-in locks out by address *and* by account name after 8
  failures. Failure messages never reveal which of the three fields was wrong.
- **Refresh tokens are single-use.** Redeeming one retires it, so a stolen copy
  stops working the moment the real device uses its own.
- **A batch is all or nothing.** Permissions are checked across the whole batch
  before anything is applied, and the write runs in one transaction. A refused
  operation cannot leave half a save behind.
- **The figures on a document have to add up.** Every document is re-totalled from
  its own lines — line discounts, bill discount, transport, taxable and
  non-taxable charges, per-line or flat GST, the CGST/SGST/IGST split — and
  refused if what it claims disagrees by more than a paisa. Negative quantities,
  negative payments and values that are not real numbers are refused too.
  The record is stored exactly as it arrived or not at all; checking never
  rewrites it.
- **Branch scoping.** Someone restricted to a branch is sent only that branch's
  documents, payments, expenses, stock movements, transfers and accounts, is not
  told the other branches exist, and cannot write into them. They cannot widen
  their own branch list.
- **Journal entries must balance.** Debits have to equal credits to within half a
  rupee and actually move something, no line can be a debit and a credit at once,
  amounts cannot be negative, and an entry needs a narration. An entry that does
  not balance quietly falsifies every report built on it.
- **Stock has to follow from something.** A quantity cannot change unless the same
  save contains a reason for it — a purchase bill, credit note, purchase return,
  delivery note, an incoming batch arriving, or a deliberate hand adjustment by
  someone holding `adjust_stock`. Where a document accounts for the change, the
  new quantity has to be exactly what that document implies. Stock can never go
  negative.
- **The stock ledger is the authority.** Every movement is recorded with its
  reason, and before a quantity is changed the stored figure is checked against
  the sum of that product's movements. If they have drifted apart — something
  altered stock without going through this server — the save is refused rather
  than built on a number nobody can account for.
- **No save silently overwrites another.** Every record carries the version it was
  read at. If the stored copy has moved on because someone else edited it from
  another device, the save is refused with a `409` and a message saying so,
  instead of quietly replacing their work. The whole batch is checked first, so a
  conflict on one record cannot half-save the rest.
- **A second factor, where you want one.** Any account can be given a six-digit
  authenticator code on top of its PIN (see below). The code is checked after the
  PIN, so a wrong PIN never reveals whether an account has one.

### Not enforced — the honest list

- **A PIN is still the default.** Two-factor is available and worth turning on for
  admins, but it is off until you enable it, and the app's sign-in offers nothing
  richer than a PIN and a code. Anyone who learns both *is* that person.
- **An access token cannot be withdrawn early.** Signing someone out, changing a
  PIN or enabling two-factor kills the refresh token immediately, but an access
  token already issued stays valid until it expires — up to 30 minutes. Lower
  `OASIS_ACCESS_TTL` if that window matters to you.
- **Failover is not automatic.** There is a live standby copy (below) and
  promoting it takes a couple of minutes, but nothing notices the main machine has
  died or moves traffic on its own. That needs something in front deciding which
  machine is live, which is a hosting decision rather than a change to this code.
- **The app draws its own screens.** The server now works the books out
  independently and will tell you what it makes of them, but the figures on the
  phone are still the phone's arithmetic. Where the two disagree, compare them —
  that is what the report is for.
- **No file or photo storage.** Document images stay on the device.

### Keeping the arithmetic in step

`src/totals.js` is a deliberate copy of the app's `calcTotals`, operation for
operation. If either changes without the other, correct invoices start getting
refused. `test/totals-parity.test.js` guards this: it lifts `calcTotals` straight
out of `app/src/main/assets/index.html`, runs both over 5,000 randomly shaped
documents and requires all 65,000 figures to match exactly. Run the tests after
touching either file.

## Changing the schema later

`src/db.js` keeps a `MIGRATIONS` list and SQLite records how many have run in
`user_version`, so a database holding a year of invoices is upgraded in place
rather than rebuilt. Before any migration runs, the server writes a copy of the
database as it was into `pre-migration/` — going back is putting that file in
place. A migration that cannot be copied first is refused rather than risked.

To change the schema, append an entry — never edit or reorder an existing one,
because databases in the field have already run it.

```js
const MIGRATIONS = [
  SCHEMA,
  `ALTER TABLE records ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`,  // 2
];
```

Back up the database file first and the change is reversible.

---

## Tests

```bash
npm test
```

121 checks against a real server on a throwaway database.

`test/totals-parity.test.js` (3) lifts `calcTotals` out of the app's own HTML and
runs it against the server's copy over 5,000 randomly shaped documents — 65,000
figures, all required to match exactly — then checks that documents the app
produces are accepted and tampered ones are not.

`test/api.test.js` (21) covers sign-in and its failure modes, PIN and token
handling, workspace isolation, brute-force lockout, the byte-for-byte record
round trip, idempotency, transaction rollback, stale-write conflicts and the
CORS headers the WebView needs.

`test/permissions.test.js` (12) signs in as a salesman and tries to do things
the app never offers them — deleting an invoice, rewriting a cost price, moving
money, forging a journal entry, creating a branch, promoting themselves — and
requires each to be refused, while checking that they can still quote and that
an admin is not obstructed.

`test/integrity.test.js` (24) inflates totals, understates tax, edits lines after
totalling, breaks the GST split, sends negative and non-finite amounts; reads and
writes across branch boundaries as a restricted user; and takes a backup, checks
its contents, restores it into a second server and signs in to it.

`test/accounting.test.js` (21) posts unbalanced journal entries, entries that move
nothing, negative debits and lines that are both sides at once; and tries to
invent stock — claiming 500 doors from a bill for 5, a purchase return that adds
stock, negative quantities, an adjustment without the permission for it — while
checking the legitimate paths still work, including the difference between a
delivery note that moves doors and one that does not.

`test/recovery.test.js` (15) plays out the case this is all for: months of
trading, a field quietly wiped, and more invoices raised afterwards. It checks
the fault can be found, traced to when and who, reverted after a dry run that
changes nothing, that the later invoices survive, that the wrong value is still
in the history rather than erased, that the repair is logged and can itself be
undone, that a deleted invoice comes back whole, that `verify` catches a record
corrupted behind the server's back, and that a migration copies the database
first.

`test/hardening.test.js` (25) has a second device save over a record someone else
already changed and requires a 409 with the first person's work intact; turns a
second factor on and tries a missing code, a wrong one, a stale one and one from
the window either side; checks the server's own receivables, credit notes,
ageing buckets and trial balance, and that a salesman cannot read any of it;
tampers with a stored quantity behind the server's back and requires the drift to
be caught; and writes a standby copy, promotes it into a second server and signs
in to it.

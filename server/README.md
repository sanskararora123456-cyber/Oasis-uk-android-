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
```

Roles are `admin`, `admin2`, `salesman`, `accountant`, `storeman`. Once an admin
exists, everyone else is easier to add from the app's **People → Staff and access**
screen, which also sets per-person permissions.

PINs are 8–12 digits, stored as a scrypt hash. They cannot be read back — if one
is forgotten, `reset-pin` issues a new one and signs that person's devices out.

---

## Backups

Everything is in the one SQLite file. Copy it while the server runs:

```bash
sqlite3 data/oasis.db ".backup '/backups/oasis-$(date +%F).db'"
```

A nightly cron job doing that, kept off the machine, is a real backup. Copying
`oasis.db` with `cp` while the server is writing is not.

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

### Not enforced — the honest list

- **A PIN is the only credential.** Eight to twelve digits, no second factor. That
  is the app's design, not a server choice: the sign-in screen accepts nothing
  else. Lockout and hashing make guessing impractical, but anyone who learns a
  PIN *is* that person. Treat PINs like keys to the shop.
- **The server does not check your arithmetic.** The app computes document totals,
  journals and stock, and this server stores what it is given. It enforces *who*
  may write a record, not whether the numbers inside it add up. A modified client
  could file an invoice whose total does not match its lines. Reworking this means
  the server recomputing totals itself — a real piece of work, and it has to
  produce byte-identical records or the app's change detection resends them
  forever.
- **Last write wins** on most records. Payment, expense and transfer corrections
  carry a version and get a `409` if someone else got there first; everything else
  does not. Two people editing one customer at the same moment: the later save
  wins silently.
- **Branch scoping is not enforced.** A user assigned to one branch can still read
  every branch through the API. The app filters the view; the server does not.
- **An access token cannot be withdrawn early.** Signing someone out or changing
  their PIN kills their refresh token immediately, but an access token already
  issued stays valid until it expires — up to 30 minutes. Lower `OASIS_ACCESS_TTL`
  if that window matters to you.
- **One machine, one file.** No replication and no failover. If the disk dies and
  you have no backup, the data is gone. The backup section above is not optional.
- **No file or photo storage.** Document images stay on the device.

### If you want it stronger

In rough order of value for the effort: enforce branch scoping; add versions to
every record so no save is ever silently overwritten; have the server recompute
document totals and reject ones that do not match; add a second factor for admin
accounts. Each is a contained change — the permission layer and the tests around
it are the pattern to follow.

## Changing the schema later

`src/db.js` keeps a `MIGRATIONS` list and SQLite records how many have run in
`user_version`, so a database holding a year of invoices is upgraded in place
rather than rebuilt. To change the schema, append an entry — never edit or reorder
an existing one, because databases in the field have already run it.

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

33 checks against a real server on a throwaway database.

`test/api.test.js` (21) covers sign-in and its failure modes, PIN and token
handling, workspace isolation, brute-force lockout, the byte-for-byte record
round trip, idempotency, transaction rollback, stale-write conflicts and the
CORS headers the WebView needs.

`test/permissions.test.js` (12) signs in as a salesman and tries to do things
the app never offers them — deleting an invoice, rewriting a cost price, moving
money, forging a journal entry, creating a branch, promoting themselves — and
requires each to be refused, while checking that they can still quote and that
an admin is not obstructed.

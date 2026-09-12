# Pharmacy Billing App (₹ INR) — React + Python Flask + SQLite

## Database: SQLAlchemy ORM + versioned migrations
- `backend/models.py` — ORM models (medicines, bills, bill items, users, GST slabs, medicine types)
- `backend/migrations.py` — ordered, idempotent migrations tracked in a
  `schema_migrations` table. New change? Append a version — fresh installs and
  every old `pharmacy.db` upgrade automatically on startup.
- Default DB is the SQLite file `backend/pharmacy.db`. Override with:
  ```bash
  DATABASE_URL=postgresql+psycopg2://user:pass@localhost/pharmacy python app.py
  ```
  (install a matching driver, e.g. `psycopg2-binary`, first)

## Structure
- `backend/app.py` — Flask REST API + SQLite (`pharmacy.db` auto-created with sample stock)
- `frontend/` — React + Vite UI (billing in Indian Rupees, inventory add/edit/remove, bills history)

## Run backend
```bash
cd backend
pip install -r requirements.txt
python app.py
# API → http://127.0.0.1:5000/api/health
```

## Run frontend (needs Node 18+)
```bash
export PATH="$HOME/.local/node/bin:$PATH"  # Node 22 is already installed here
cd frontend
npm install
npm run dev
# UI → http://127.0.0.1:5173 (proxies /api to Flask)
```

Production: `npm run build` creates `frontend/dist`, which Flask serves at `http://127.0.0.1:5000/`.
If port 5000 is busy, run `PORT=5001 python app.py` instead.

## Login
The app opens with a login screen. Default credentials:
- username: `admin`
- password: `admin`

Change them with environment variables when starting the backend:
```bash
ADMIN_USER=owner ADMIN_PASS='s3cret!' python app.py
```
Sessions are token-based (12 h, configurable via `SESSION_HOURS`) and all
`/api/medicines` + `/api/bills` endpoints require login.

## Billing (counter-friendly)
- Quantity **steppers** (−/+) capped at stock, per-line rates, live totals
- Search by name, **salt/composition** or batch; Enter adds first match
- Bill-level **discount %** with 0/5/10 quick presets
- **Payment mode**: Cash, UPI, Card, Credit, Other (stored per bill)
- **Cash tendered → change/short** calculator for counter sales
- Printable **TAX INVOICE**: bill no, date, GST breakup, discount, amount in
  words (Indian lakh/crore format), payment mode

## GST rates as master data (admin)
- Standard Indian slabs seeded: 0%, 5%, 12%, 18%, 28%
- Separate **🏷️ Masters ▾ menu** (top-right, admin only) → **GST Rates**:
  add slabs, rename (cascades to all medicines on that slab),
  activate/deactivate, delete (blocked while in use)
- Medicines must use an active slab — enforced by the API and offered as a
  dropdown in the medicine form
- GST API: `GET /api/gst-rates`, `POST /api/gst-rates`,
  `PUT /api/gst-rates/:id`, `DELETE /api/gst-rates/:id`

## Medicine types as master data (admin)- Seeded types: tablet, capsule, sachet, strip, bottle, syrup, injection, tube
- Same **🏷️ Masters ▾ menu** → **Medicine Types**: add types (e.g. `drops`), rename (cascades to all
  medicines of that type), activate/deactivate, delete (blocked while in use)
- Medicines must use an active type — enforced by the API and offered as a
  dropdown in the medicine form
- Types API: `GET /api/unit-types`, `POST /api/unit-types`,
  `PUT /api/unit-types/:id`, `DELETE /api/unit-types/:id`

## Payment modes as master data (admin)
- Seeded modes: Cash, UPI, Card, Credit, Other
- Same **🏷️ Masters ▾ menu** → **Payment Modes**: add, rename (cascades to
  bills), activate/deactivate, delete (blocked while in use)
- Billing offers only active modes; the API rejects anything off-list
- Modes API: `GET /api/payment-modes`, `POST /api/payment-modes`,
  `PUT /api/payment-modes/:id`, `DELETE /api/payment-modes/:id`

## Store profile (admin, under Masters ▾ → Store Profile)
- Editable pharmacy **name, tagline, address, phone, GSTIN** (format-validated)
  plus **logo upload** (png/jpg/gif/webp/svg ≤ 2 MB)
- Also holds the **low-stock alert threshold** (tablets) — no longer hardcoded;
  badges and the header counter follow it
- Branding flows into the header, login screen and printed TAX INVOICEs
- `GET /api/settings` is public; writes are admin-only
- Settings API: `PUT /api/settings`, `POST /api/settings/logo`,
  `DELETE /api/settings/logo`

## Medicine composition (salt)
- Each medicine stores its **composition** (e.g. `Ibuprofen + Paracetamol`),
  editable in the medicine form and shown in inventory, billing and cart
- Search covers composition — typing a salt finds all its brands
- Migration v7 backfills compositions for the sample stock

## Medicine description and usage
- Every medicine now has a **description** and **usage/how to take** field
- Shown in the medicine form (admin), inventory list, billing cart, and printed invoice
- All 106 medicines have descriptions/usage (catalog + legacy backfilled) pain/fever,
  antacids, allergy/cold, chronic care (diabetes/BP/thyroid), vitamins,
  first-aid and topicals — with per-tablet prices, compositions and GST slabs
- Wave two adds cardiac, neuro/psych, skin, eye/ear, pediatric syrups,
  injections, steroids, gout and malaria drugs (106 total)
- Backfills **only missing names**: your stock levels are never overwritten

## Roles: admin vs staff
- **Admin**: everything — inventory add/edit/remove, user management, billing.
- **Staff**: billing, inventory viewing, bills history, own password change.
  Inventory write endpoints (`POST/PUT/DELETE /api/medicines`) return 403 for
  staff, and the UI hides Add/Edit/Remove buttons from them.

## Users (admin manages logins)
- The **👥 Users** tab (visible as admin) lists all logins, lets admin **add new
  users** (staff or admin) and remove them (not self, not the last admin).
- The **👤 Account** tab lets every user change their own password.
- Passwords are stored hashed (Werkzeug PBKDF2); admin endpoints return 403 for staff.
- User API: `GET /api/users`, `POST /api/users`, `DELETE /api/users/:id`,
  `POST /api/change-password`.

## API
- `GET /api/medicines?search=` — list
- `POST /api/medicines` — add `{name, unit, batch_no, expiry_date, quantity, price, gst_percent}`
- `PUT /api/medicines/:id` — edit
- `DELETE /api/medicines/:id` — remove
- `POST /api/bills` — create bill `{customer_name, customer_phone, items:[{medicine_id, qty}]}` (stock decremented, GST applied, totals in ₹)
- `GET /api/bills`, `GET /api/bills/:id` — history

## Billing model: number of tablets
- `quantity` = number of tablets (or units, e.g. sachets) in stock
- `price` = price **per tablet** in ₹ (e.g. 10 Paracetamol tablets × ₹2.33 + 5% GST = ₹24.47)
- `unit` = billing unit: `tablet` (default), `capsule`, `sachet`, `strip`, `bottle`, `syrup`, `injection`, `tube`

All money is formatted with `Intl.NumberFormat('en-IN', {currency:'INR'})` → ₹.

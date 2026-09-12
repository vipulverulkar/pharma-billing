"""Pharmacy backend — Flask + SQLAlchemy ORM + SQLite REST API.

Run:
    pip install -r requirements.txt
    python app.py

API listens on http://127.0.0.1:5000 (or $PORT).
Database: SQLite file pharmacy.db by default; override with $DATABASE_URL,
e.g. DATABASE_URL=postgresql+psycopg2://user:pass@localhost/pharmacy
Schema is managed by migrations.migrate() (versioned, idempotent).
"""

import os
import re
import secrets
import time
import uuid
from datetime import datetime
from functools import wraps

from flask import Flask, g, jsonify, request, send_from_directory
from flask_cors import CORS
from sqlalchemy import create_engine, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

from migrations import migrate
from models import (
    Bill,
    BillItem,
    GstRate,
    Medicine,
    PaymentMode,
    StoreSetting,
    UnitType,
    User,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "pharmacy.db")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
ALLOWED_LOGOS = {"png", "jpg", "jpeg", "gif", "webp", "svg"}

DATABASE_URL = os.environ.get("DATABASE_URL") or f"sqlite:///{DB_PATH}"

# If a Vite production build exists at ../frontend/dist, serve it.
DIST_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "frontend", "dist"))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024  # logo uploads ≤ 2 MB
CORS(app)

_engine_kwargs = {}
if DATABASE_URL.startswith("sqlite"):
    _engine_kwargs["connect_args"] = {"check_same_thread": False}
engine = create_engine(DATABASE_URL, **_engine_kwargs)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)

# ---- Users & login (default admin account: admin / admin) ----
# Override the seeded admin with env vars on first run:
#   ADMIN_USER=owner ADMIN_PASS='s3cret!' python app.py
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("ADMIN_PASS", "admin")
SESSION_HOURS = float(os.environ.get("SESSION_HOURS", "12"))
TOKENS = {}  # token -> {"uid":…, "username":…, "is_admin":…, "exp":…}


def _now():
    """Local timezone-aware timestamp (keeps wall-clock readable in the UI)."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _session(token):
    sess = TOKENS.get(token)
    if not sess:
        return None
    if sess["exp"] < time.time():
        TOKENS.pop(token, None)
        return None
    return sess


def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        auth = request.headers.get("Authorization") or ""
        token = auth[7:] if auth.startswith("Bearer ") else ""
        sess = _session(token) if token else None
        if not sess:
            return jsonify({"error": "Login required"}), 401
        g.user = sess
        return fn(*args, **kwargs)

    return wrapper


def require_admin(fn):
    @wraps(fn)
    @require_auth
    def wrapper(*args, **kwargs):
        if not g.user.get("is_admin"):
            return jsonify({"error": "Admin access required"}), 403
        return fn(*args, **kwargs)

    return wrapper


def db():
    if "db" not in g:
        g.db = SessionLocal()
    return g.db


@app.teardown_appcontext
def close_db(_exc=None):
    sess = g.pop("db", None)
    if sess is not None:
        sess.close()


def active_gst_slabs(s):
    """Master GST rates (active slabs) all medicines must use."""
    return sorted(
        r[0] for r in s.query(GstRate.rate).filter(GstRate.is_active.is_(True)).all()
    )


def check_gst_slab(s, gst):
    slabs = active_gst_slabs(s)
    if gst not in slabs:
        return f"GST must be one of the master slabs: {', '.join(str(x) + '%' for x in slabs)}"
    return None


def active_unit_types(s):
    """Master medicine types (active units) all medicines must use."""
    return sorted(
        r[0] for r in s.query(UnitType.name).filter(UnitType.is_active.is_(True)).all()
    )


def active_payment_modes(s):
    """Master payment modes (active) bills must use."""
    return [
        r[0]
        for r in s.query(PaymentMode.name)
        .filter(PaymentMode.is_active.is_(True))
        .order_by(PaymentMode.name)
        .all()
    ]


def check_unit_type(s, unit):
    types = active_unit_types(s)
    if unit not in types:
        return f"Medicine type must be one of: {', '.join(types)}"
    return None


def med_to_dict(m):
    return {
        "id": m.id,
        "name": m.name,
        "composition": m.composition or "",
        "unit": m.unit or "tablet",
        "batch_no": m.batch_no or "",
        "expiry_date": m.expiry_date or "",
        "quantity": m.quantity,
        "price": m.price,
        "gst_percent": m.gst_percent,
        "description": m.description or "",
        "usage": m.usage or "",
    }


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "currency": "INR"})


@app.post("/api/login")
def login():
    data = request.get_json(force=True, silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    s = db()
    user = s.query(User).filter(User.username == username).first()
    if user is None or not check_password_hash(user.password_hash, password):
        return jsonify({"error": "Invalid username or password"}), 401
    token = secrets.token_hex(32)
    TOKENS[token] = {
        "uid": user.id,
        "username": user.username,
        "is_admin": bool(user.is_admin),
        "exp": time.time() + SESSION_HOURS * 3600,
    }
    return jsonify(
        {"token": token, "username": user.username, "is_admin": bool(user.is_admin)}
    )


@app.post("/api/logout")
def logout():
    auth = request.headers.get("Authorization") or ""
    if auth.startswith("Bearer "):
        TOKENS.pop(auth[7:], None)
    return jsonify({"ok": True})


@app.get("/api/me")
@require_auth
def me():
    return jsonify({"username": g.user["username"], "is_admin": g.user["is_admin"]})


def _user_dict(u):
    return {
        "id": u.id,
        "username": u.username,
        "is_admin": bool(u.is_admin),
        "created_at": u.created_at,
    }


@app.get("/api/users")
@require_admin
def list_users():
    users = db().query(User).order_by(User.id).all()
    return jsonify([_user_dict(u) for u in users])


@app.post("/api/users")
@require_admin
def create_user():
    """Admin creates a new login: {username, password, is_admin?}."""
    data = request.get_json(force=True, silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    is_admin = bool(data.get("is_admin"))
    if len(username) < 3:
        return jsonify({"error": "Username must be at least 3 characters"}), 400
    if len(password) < 4:
        return jsonify({"error": "Password must be at least 4 characters"}), 400
    s = db()
    user = User(
        username=username,
        password_hash=generate_password_hash(password),
        is_admin=is_admin,
        created_at=_now(),
    )
    s.add(user)
    try:
        s.commit()
    except IntegrityError:
        s.rollback()
        return jsonify({"error": f"Username '{username}' already exists"}), 400
    return jsonify(_user_dict(user)), 201


@app.delete("/api/users/<int:user_id>")
@require_admin
def delete_user(user_id):
    if user_id == g.user["uid"]:
        return jsonify({"error": "You cannot delete your own account"}), 400
    s = db()
    user = s.query(User).filter(User.id == user_id).first()
    if user is None:
        return jsonify({"error": "User not found"}), 404
    if user.is_admin and s.query(User).filter(User.is_admin.is_(True)).count() <= 1:
        return jsonify({"error": "Cannot delete the last admin account"}), 400
    s.delete(user)
    s.commit()
    # Drop any active sessions of the deleted user.
    for tok, sess in [t for t in TOKENS.items()]:
        if sess["uid"] == user_id:
            TOKENS.pop(tok, None)
    return jsonify({"deleted": user_id})


@app.post("/api/change-password")
@require_auth
def change_password():
    """Logged-in user changes their own password."""
    data = request.get_json(force=True, silent=True) or {}
    current = data.get("current_password") or ""
    new = data.get("new_password") or ""
    if len(new) < 4:
        return jsonify({"error": "New password must be at least 4 characters"}), 400
    s = db()
    user = s.query(User).filter(User.id == g.user["uid"]).first()
    if user is None or not check_password_hash(user.password_hash, current):
        return jsonify({"error": "Current password is incorrect"}), 400
    user.password_hash = generate_password_hash(new)
    s.commit()
    return jsonify({"ok": True})


@app.get("/api/gst-rates")
@require_auth
def list_gst_rates():
    """Master GST slabs with usage counts (all logged-in users can read)."""
    s = db()
    out = []
    for r in s.query(GstRate).order_by(GstRate.rate).all():
        used = s.query(Medicine).filter(Medicine.gst_percent == r.rate).count()
        out.append(
            {
                "id": r.id,
                "rate": r.rate,
                "is_active": bool(r.is_active),
                "medicines_using": used,
            }
        )
    return jsonify(out)


@app.post("/api/gst-rates")
@require_admin
def create_gst_rate():
    """Admin adds a new GST slab: {rate}."""
    data = request.get_json(force=True, silent=True) or {}
    try:
        rate = float(data.get("rate"))
    except (TypeError, ValueError):
        return jsonify({"error": "rate must be a number"}), 400
    if not (0 <= rate <= 100):
        return jsonify({"error": "rate must be between 0 and 100"}), 400
    s = db()
    row = GstRate(rate=rate, is_active=True, created_at=_now())
    s.add(row)
    try:
        s.commit()
    except IntegrityError:
        s.rollback()
        return jsonify({"error": f"GST slab {rate}% already exists"}), 400
    return jsonify(
        {"id": row.id, "rate": row.rate, "is_active": True, "medicines_using": 0}
    ), 201


@app.put("/api/gst-rates/<int:rate_id>")
@require_admin
def update_gst_rate(rate_id):
    """Admin edits a slab: {rate?, is_active?}.

    Changing the rate cascades to all medicines using the old slab.
    """
    data = request.get_json(force=True, silent=True) or {}
    s = db()
    row = s.query(GstRate).filter(GstRate.id == rate_id).first()
    if row is None:
        return jsonify({"error": "GST slab not found"}), 404
    old_rate = row.rate
    new_rate = old_rate
    if "rate" in data:
        try:
            new_rate = float(data["rate"])
        except (TypeError, ValueError):
            return jsonify({"error": "rate must be a number"}), 400
        if not (0 <= new_rate <= 100):
            return jsonify({"error": "rate must be between 0 and 100"}), 400
    if "is_active" in data:
        row.is_active = bool(data["is_active"])
    row.rate = new_rate
    try:
        s.commit()
    except IntegrityError:
        s.rollback()
        return jsonify({"error": f"GST slab {new_rate}% already exists"}), 400
    moved = 0
    if new_rate != old_rate:
        moved = (
            s.query(Medicine)
            .filter(Medicine.gst_percent == old_rate)
            .update({"gst_percent": new_rate}, synchronize_session=False)
        )
        s.commit()
    return jsonify(
        {
            "id": rate_id,
            "rate": new_rate,
            "is_active": bool(row.is_active),
            "medicines_updated": moved,
        }
    )


@app.delete("/api/gst-rates/<int:rate_id>")
@require_admin
def delete_gst_rate(rate_id):
    s = db()
    row = s.query(GstRate).filter(GstRate.id == rate_id).first()
    if row is None:
        return jsonify({"error": "GST slab not found"}), 404
    used = s.query(Medicine).filter(Medicine.gst_percent == row.rate).count()
    if used:
        return jsonify(
            {
                "error": f"Cannot delete {row.rate}% — {used} medicine(s) use it. Deactivate it instead."
            }
        ), 400
    s.delete(row)
    s.commit()
    return jsonify({"deleted": rate_id})


@app.get("/api/unit-types")
@require_auth
def list_unit_types():
    """Master medicine types with usage counts (all logged-in users can read)."""
    s = db()
    out = []
    for r in s.query(UnitType).order_by(UnitType.name).all():
        used = s.query(Medicine).filter(Medicine.unit == r.name).count()
        out.append(
            {
                "id": r.id,
                "name": r.name,
                "is_active": bool(r.is_active),
                "medicines_using": used,
            }
        )
    return jsonify(out)


@app.post("/api/unit-types")
@require_admin
def create_unit_type():
    """Admin adds a new medicine type: {name}."""
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip().lower()
    if not name:
        return jsonify({"error": "Type name is required"}), 400
    if len(name) > 30:
        return jsonify({"error": "Type name must be 30 characters or less"}), 400
    s = db()
    row = UnitType(name=name, is_active=True, created_at=_now())
    s.add(row)
    try:
        s.commit()
    except IntegrityError:
        s.rollback()
        return jsonify({"error": f"Medicine type '{name}' already exists"}), 400
    return jsonify(
        {"id": row.id, "name": row.name, "is_active": True, "medicines_using": 0}
    ), 201


@app.put("/api/unit-types/<int:type_id>")
@require_admin
def update_unit_type(type_id):
    """Admin edits a type: {name?, is_active?}.

    Renaming cascades to all medicines using the old type.
    """
    data = request.get_json(force=True, silent=True) or {}
    s = db()
    row = s.query(UnitType).filter(UnitType.id == type_id).first()
    if row is None:
        return jsonify({"error": "Medicine type not found"}), 404
    old_name = row.name
    new_name = old_name
    if "name" in data:
        new_name = (data.get("name") or "").strip().lower()
        if not new_name:
            return jsonify({"error": "Type name is required"}), 400
        if len(new_name) > 30:
            return jsonify({"error": "Type name must be 30 characters or less"}), 400
    if "is_active" in data:
        row.is_active = bool(data["is_active"])
    row.name = new_name
    try:
        s.commit()
    except IntegrityError:
        s.rollback()
        return jsonify({"error": f"Medicine type '{new_name}' already exists"}), 400
    moved = 0
    if new_name != old_name:
        moved = (
            s.query(Medicine)
            .filter(Medicine.unit == old_name)
            .update({"unit": new_name}, synchronize_session=False)
        )
        s.commit()
    return jsonify(
        {
            "id": type_id,
            "name": new_name,
            "is_active": bool(row.is_active),
            "medicines_updated": moved,
        }
    )


@app.delete("/api/unit-types/<int:type_id>")
@require_admin
def delete_unit_type(type_id):
    s = db()
    row = s.query(UnitType).filter(UnitType.id == type_id).first()
    if row is None:
        return jsonify({"error": "Medicine type not found"}), 404
    used = s.query(Medicine).filter(Medicine.unit == row.name).count()
    if used:
        return jsonify(
            {
                "error": f"Cannot delete '{row.name}' — {used} medicine(s) use it. Deactivate it instead."
            }
        ), 400
    s.delete(row)
    s.commit()
    return jsonify({"deleted": type_id})


GSTIN_RE = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$")


def _settings_dict(st):
    return {
        "name": st.name or "MediCare Pharmacy",
        "tagline": st.tagline or "",
        "address": st.address or "",
        "phone": st.phone or "",
        "gstin": st.gstin or "",
        "logo_url": f"/uploads/{st.logo_path}" if st.logo_path else "",
        "low_stock_limit": st.low_stock_limit if st.low_stock_limit is not None else 10,
    }


def _get_settings(s):
    st = s.query(StoreSetting).filter(StoreSetting.id == 1).first()
    if st is None:  # extremely old DB: seed lazily
        st = StoreSetting(
            id=1,
            name="MediCare Pharmacy",
            tagline="Your trusted neighbourhood pharmacy",
        )
        s.add(st)
        s.commit()
    return st


@app.get("/api/settings")
def get_settings():
    """Public: store profile for login screen, header and invoices."""
    return jsonify(_settings_dict(_get_settings(db())))


@app.put("/api/settings")
@require_admin
def update_settings():
    """Admin edits pharmacy name, tagline, address, phone, GSTIN."""
    data = request.get_json(force=True, silent=True) or {}
    s = db()
    st = _get_settings(s)
    if "name" in data:
        name = (data.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Pharmacy name is required"}), 400
        st.name = name[:80]
    if "tagline" in data:
        st.tagline = (data.get("tagline") or "").strip()[:120]
    if "address" in data:
        st.address = (data.get("address") or "").strip()[:300]
    if "phone" in data:
        st.phone = (data.get("phone") or "").strip()[:30]
    if "gstin" in data:
        gstin = (data.get("gstin") or "").strip().upper()
        if gstin and not GSTIN_RE.match(gstin):
            return jsonify(
                {"error": "Invalid GSTIN format (e.g. 27ABCDE1234F1Z5)"}
            ), 400
        st.gstin = gstin
    if "low_stock_limit" in data:
        try:
            limit = int(data.get("low_stock_limit"))
        except (TypeError, ValueError):
            return jsonify({"error": "low_stock_limit must be a number"}), 400
        if limit < 0:
            return jsonify({"error": "low_stock_limit cannot be negative"}), 400
        st.low_stock_limit = limit
    s.commit()
    return jsonify(_settings_dict(st))


def _remove_logo_file(path):
    if path:
        try:
            os.remove(os.path.join(UPLOAD_DIR, os.path.basename(path)))
        except OSError:
            pass


@app.post("/api/settings/logo")
@require_admin
def upload_logo():
    """Admin uploads a logo image (png/jpg/gif/webp/svg, ≤ 2 MB)."""
    if "logo" not in request.files:
        return jsonify({"error": "No file uploaded (field name: logo)"}), 400
    f = request.files["logo"]
    ext = (
        (f.filename or "").rsplit(".", 1)[-1].lower()
        if "." in (f.filename or "")
        else ""
    )
    if ext not in ALLOWED_LOGOS:
        return jsonify(
            {"error": f"Logo must be one of: {', '.join(sorted(ALLOWED_LOGOS))}"}
        ), 400
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filename = f"{uuid.uuid4().hex[:12]}_{secure_filename(f.filename)}"
    f.save(os.path.join(UPLOAD_DIR, filename))
    s = db()
    st = _get_settings(s)
    _remove_logo_file(st.logo_path)
    st.logo_path = filename
    s.commit()
    return jsonify(_settings_dict(st))


@app.delete("/api/settings/logo")
@require_admin
def delete_logo():
    s = db()
    st = _get_settings(s)
    _remove_logo_file(st.logo_path)
    st.logo_path = ""
    s.commit()
    return jsonify(_settings_dict(st))


@app.get("/api/payment-modes")
@require_auth
def list_payment_modes():
    """Master payment modes with usage counts (all logged-in users can read)."""
    s = db()
    out = []
    for r in s.query(PaymentMode).order_by(PaymentMode.name).all():
        used = s.query(Bill).filter(Bill.payment_mode == r.name).count()
        out.append(
            {
                "id": r.id,
                "name": r.name,
                "is_active": bool(r.is_active),
                "bills_using": used,
            }
        )
    return jsonify(out)


@app.post("/api/payment-modes")
@require_admin
def create_payment_mode():
    """Admin adds a new payment mode: {name}."""
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Mode name is required"}), 400
    if len(name) > 30:
        return jsonify({"error": "Mode name must be 30 characters or less"}), 400
    s = db()
    row = PaymentMode(name=name, is_active=True, created_at=_now())
    s.add(row)
    try:
        s.commit()
    except IntegrityError:
        s.rollback()
        # Case-insensitive duplicate check for a friendlier message.
        existing = (
            s.query(PaymentMode)
            .filter(func.lower(PaymentMode.name) == name.lower())
            .first()
        )
        if existing:
            return jsonify(
                {"error": f"Payment mode '{existing.name}' already exists"}
            ), 400
        return jsonify({"error": f"Payment mode '{name}' already exists"}), 400
    return jsonify(
        {"id": row.id, "name": row.name, "is_active": True, "bills_using": 0}
    ), 201


@app.put("/api/payment-modes/<int:mode_id>")
@require_admin
def update_payment_mode(mode_id):
    """Admin edits a mode: {name?, is_active?}.

    Renaming cascades to all bills using the old mode.
    """
    data = request.get_json(force=True, silent=True) or {}
    s = db()
    row = s.query(PaymentMode).filter(PaymentMode.id == mode_id).first()
    if row is None:
        return jsonify({"error": "Payment mode not found"}), 404
    old_name = row.name
    new_name = old_name
    if "name" in data:
        new_name = (data.get("name") or "").strip()
        if not new_name:
            return jsonify({"error": "Mode name is required"}), 400
        if len(new_name) > 30:
            return jsonify({"error": "Mode name must be 30 characters or less"}), 400
    if "is_active" in data:
        row.is_active = bool(data["is_active"])
    row.name = new_name
    try:
        s.commit()
    except IntegrityError:
        s.rollback()
        return jsonify({"error": f"Payment mode '{new_name}' already exists"}), 400
    moved = 0
    if new_name != old_name:
        moved = (
            s.query(Bill)
            .filter(Bill.payment_mode == old_name)
            .update({"payment_mode": new_name}, synchronize_session=False)
        )
        s.commit()
    return jsonify(
        {
            "id": mode_id,
            "name": new_name,
            "is_active": bool(row.is_active),
            "bills_updated": moved,
        }
    )


@app.delete("/api/payment-modes/<int:mode_id>")
@require_admin
def delete_payment_mode(mode_id):
    s = db()
    row = s.query(PaymentMode).filter(PaymentMode.id == mode_id).first()
    if row is None:
        return jsonify({"error": "Payment mode not found"}), 404
    used = s.query(Bill).filter(Bill.payment_mode == row.name).count()
    if used:
        return jsonify(
            {
                "error": f"Cannot delete '{row.name}' — {used} bill(s) use it. Deactivate it instead."
            }
        ), 400
    s.delete(row)
    s.commit()
    return jsonify({"deleted": mode_id})


@app.get("/api/medicines")
@require_auth
def list_medicines():
    search = (request.args.get("search") or "").strip().lower()
    s = db()
    q = s.query(Medicine)
    if search:
        like = f"%{search}%"
        q = q.filter(
            (func.lower(Medicine.name).like(like))
            | (func.lower(Medicine.composition).like(like))
            | (func.lower(Medicine.batch_no).like(like))
            | (func.lower(Medicine.description).like(like))
            | (func.lower(Medicine.usage).like(like))
        )
    return jsonify([med_to_dict(m) for m in q.order_by(Medicine.name).all()])


@app.post("/api/medicines")
@require_admin
def add_medicine():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Medicine name is required"}), 400
    try:
        quantity = int(data.get("quantity", 0))
        price = float(data.get("price", 0))
        gst = float(data.get("gst_percent", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "quantity/price/gst_percent must be numbers"}), 400
    if quantity < 0 or price < 0 or gst < 0:
        return jsonify({"error": "quantity/price/gst_percent cannot be negative"}), 400
    s = db()
    slab_err = check_gst_slab(s, gst)
    if slab_err:
        return jsonify({"error": slab_err}), 400
    unit = (data.get("unit") or "tablet").strip().lower()
    type_err = check_unit_type(s, unit)
    if type_err:
        return jsonify({"error": type_err}), 400
    med = Medicine(
        name=name,
        composition=(data.get("composition") or "").strip()[:200],
        unit=unit,
        batch_no=(data.get("batch_no") or "").strip(),
        expiry_date=(data.get("expiry_date") or "").strip(),
        quantity=quantity,
        price=round(price, 2),
        gst_percent=gst,
        description=(data.get("description") or "").strip()[:500],
        usage=(data.get("usage") or "").strip()[:500],
    )
    s.add(med)
    s.commit()
    return jsonify(med_to_dict(med)), 201


@app.put("/api/medicines/<int:med_id>")
@require_admin
def update_medicine(med_id):
    data = request.get_json(force=True)
    s = db()
    med = s.query(Medicine).filter(Medicine.id == med_id).first()
    if med is None:
        return jsonify({"error": "Medicine not found"}), 404
    name = (data.get("name", med.name) or "").strip() or med.name
    unit = (data.get("unit", med.unit) or "tablet").strip().lower()
    try:
        quantity = int(data["quantity"]) if "quantity" in data else med.quantity
        price = float(data["price"]) if "price" in data else med.price
        gst = float(data["gst_percent"]) if "gst_percent" in data else med.gst_percent
    except (TypeError, ValueError):
        return jsonify({"error": "quantity/price/gst_percent must be numbers"}), 400
    if quantity < 0 or price < 0 or gst < 0:
        return jsonify({"error": "quantity/price/gst_percent cannot be negative"}), 400
    slab_err = check_gst_slab(s, gst)
    if slab_err:
        return jsonify({"error": slab_err}), 400
    type_err = check_unit_type(s, unit)
    if type_err:
        return jsonify({"error": type_err}), 400
    med.name = name
    med.composition = (data.get("composition", med.composition) or "").strip()[:200]
    med.unit = unit
    med.batch_no = (data.get("batch_no", med.batch_no) or "").strip()
    med.expiry_date = (data.get("expiry_date", med.expiry_date) or "").strip()
    med.quantity = quantity
    med.price = round(price, 2)
    med.gst_percent = gst
    med.description = (data.get("description", med.description) or "").strip()[:500]
    med.usage = (data.get("usage", med.usage) or "").strip()[:500]
    s.commit()
    return jsonify(med_to_dict(med))


@app.delete("/api/medicines/<int:med_id>")
@require_admin
def delete_medicine(med_id):
    s = db()
    med = s.query(Medicine).filter(Medicine.id == med_id).first()
    if med is None:
        return jsonify({"error": "Medicine not found"}), 404
    s.delete(med)
    s.commit()
    return jsonify({"deleted": med_id})


@app.post("/api/bills")
@require_auth
def create_bill():
    """Create a bill in Indian Rupees. Billing is by NUMBER OF TABLETS
    (or units, e.g. sachets). Decrements tablet stock.

    Body: {
      "customer_name": "…", "customer_phone": "…",
      "items": [{"medicine_id": 1, "qty": 10}, …],  # qty = no. of tablets
      "discount_percent": 5,        # optional bill discount 0–100
      "payment_mode": "Cash"        # must be an active master payment mode
    }
    """
    data = request.get_json(force=True)
    items = data.get("items") or []
    if not items:
        return jsonify({"error": "Bill must contain at least one item"}), 400
    try:
        discount_pct = float(data.get("discount_percent", 0) or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "discount_percent must be a number"}), 400
    discount_pct = max(0.0, min(100.0, discount_pct))
    s = db()
    modes = active_payment_modes(s)
    raw_mode = (data.get("payment_mode") or "").strip()
    if not raw_mode:
        pay_mode = "Cash" if "Cash" in modes else (modes[0] if modes else "Cash")
    else:
        match = [m for m in modes if m.lower() == raw_mode.lower()]
        if not match:
            return jsonify(
                {"error": f"Payment mode must be one of: {', '.join(modes)}"}
            ), 400
        pay_mode = match[0]
    lines = []
    subtotal = 0.0
    gst_total = 0.0
    try:
        for entry in items:
            try:
                med_id = int(entry.get("medicine_id"))
                qty = int(entry.get("qty", 0))
            except (TypeError, ValueError):
                raise ValueError("Each item needs a numeric medicine_id and qty")
            if qty <= 0:
                raise ValueError("Number of tablets must be at least 1")
            med = s.query(Medicine).filter(Medicine.id == med_id).first()
            if med is None:
                raise ValueError(f"Medicine id {med_id} not found")
            if med.quantity < qty:
                raise ValueError(
                    f"Insufficient stock for {med.name} (tablets available: {med.quantity})"
                )
            unit_price = float(med.price)
            gst_pct = float(med.gst_percent)
            line_base = round(unit_price * qty, 2)
            line_gst = round(line_base * gst_pct / 100.0, 2)
            subtotal += line_base
            gst_total += line_gst
            lines.append(
                {
                    "medicine_id": med.id,
                    "medicine_name": med.name,
                    "medicine_description": med.description or "",
                    "medicine_usage": med.usage or "",
                    "qty": qty,
                    "unit_price": unit_price,
                    "gst_percent": gst_pct,
                    "line_total": round(line_base + line_gst, 2),
                }
            )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    subtotal = round(subtotal, 2)
    gst_total = round(gst_total, 2)
    discount_amount = round((subtotal + gst_total) * discount_pct / 100.0, 2)
    grand_total = round(subtotal + gst_total - discount_amount, 2)

    bill = Bill(
        customer_name=(data.get("customer_name") or "").strip(),
        customer_phone=(data.get("customer_phone") or "").strip(),
        subtotal=subtotal,
        gst_total=gst_total,
        discount_percent=discount_pct,
        discount_amount=discount_amount,
        grand_total=grand_total,
        payment_mode=pay_mode,
        created_at=_now(),
    )
    s.add(bill)
    s.flush()  # assign bill.id
    for ln in lines:
        s.add(
            BillItem(
                bill_id=bill.id,
                medicine_id=ln["medicine_id"],
                medicine_name=ln["medicine_name"],
                medicine_description=ln["medicine_description"],
                medicine_usage=ln["medicine_usage"],
                qty=ln["qty"],
                unit_price=ln["unit_price"],
                gst_percent=ln["gst_percent"],
                line_total=ln["line_total"],
            )
        )
        med = s.query(Medicine).filter(Medicine.id == ln["medicine_id"]).first()
        med.quantity = med.quantity - ln["qty"]
    s.commit()
    return jsonify(get_bill_dict(bill.id)), 201


def get_bill_dict(bill_id):
    s = db()
    bill = s.query(Bill).filter(Bill.id == bill_id).first()
    if bill is None:
        return None
    return {
        "id": bill.id,
        "customer_name": bill.customer_name,
        "customer_phone": bill.customer_phone,
        "subtotal": bill.subtotal,
        "gst_total": bill.gst_total,
        "discount_percent": bill.discount_percent or 0,
        "discount_amount": bill.discount_amount or 0,
        "grand_total": bill.grand_total,
        "payment_mode": bill.payment_mode or "Cash",
        "created_at": bill.created_at,
        "currency": "INR",
        "items": [
            {
                "medicine_id": it.medicine_id,
                "medicine_name": it.medicine_name,
                "medicine_description": getattr(it, "medicine_description", ""),
                "medicine_usage": getattr(it, "medicine_usage", ""),
                "qty": it.qty,
                "unit_price": it.unit_price,
                "gst_percent": it.gst_percent,
                "line_total": it.line_total,
            }
            for it in bill.items
        ],
    }


@app.get("/api/bills")
@require_auth
def list_bills():
    rows = db().query(Bill).order_by(Bill.id.desc()).limit(100).all()
    return jsonify(
        [
            {
                "id": b.id,
                "customer_name": b.customer_name,
                "customer_phone": b.customer_phone,
                "subtotal": b.subtotal,
                "gst_total": b.gst_total,
                "discount_percent": b.discount_percent or 0,
                "discount_amount": b.discount_amount or 0,
                "grand_total": b.grand_total,
                "payment_mode": b.payment_mode or "Cash",
                "created_at": b.created_at,
                "currency": "INR",
            }
            for b in rows
        ]
    )


@app.get("/api/bills/<int:bill_id>")
@require_auth
def bill_detail(bill_id):
    bill = get_bill_dict(bill_id)
    if bill is None:
        return jsonify({"error": "Bill not found"}), 404
    return jsonify(bill)


# Serve Vite production build when present (after `npm run build`).
@app.get("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, os.path.basename(filename))


@app.get("/")
def serve_root():
    if os.path.isdir(DIST_DIR):
        return send_from_directory(DIST_DIR, "index.html")
    return jsonify(
        {
            "message": "Pharmacy API running. Build the frontend (frontend/dist) or use Vite dev server.",
            "api": "/api/health",
        }
    )


@app.get("/<path:path>")
def serve_dist(path):
    full = os.path.join(DIST_DIR, path)
    if os.path.isdir(DIST_DIR) and os.path.isfile(full):
        return send_from_directory(DIST_DIR, path)
    if path.startswith("api/"):
        return jsonify({"error": "Not found"}), 404
    if os.path.isdir(DIST_DIR):
        return send_from_directory(DIST_DIR, "index.html")
    return jsonify({"error": "Not found"}), 404


if __name__ == "__main__":
    applied = migrate(engine, ADMIN_USER, ADMIN_PASS)
    if applied:
        print(f"Applied migrations: {applied}")
    print(f"Database: {DATABASE_URL}")
    port = int(os.environ.get("PORT", "5000"))
    print(f"API: http://127.0.0.1:{port}/api/health")
    app.run(host="127.0.0.1", port=port, debug=True)

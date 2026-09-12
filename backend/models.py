"""SQLAlchemy ORM models for the pharmacy app.

Tables map 1:1 onto the historical raw-SQLite schema so existing
pharmacy.db files keep working (see migrations.py).
"""

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Medicine(Base):
    __tablename__ = "medicines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False, default="")
    composition: Mapped[str] = mapped_column(String, nullable=False, default="")
    unit: Mapped[str] = mapped_column(String, nullable=False, default="tablet")
    batch_no: Mapped[str] = mapped_column(String, nullable=False, default="")
    expiry_date: Mapped[str] = mapped_column(String, nullable=False, default="")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    price: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    gst_percent: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    description: Mapped[str] = mapped_column(String, nullable=False, default="")
    usage: Mapped[str] = mapped_column(String, nullable=False, default="")


class Bill(Base):
    __tablename__ = "bills"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    customer_phone: Mapped[str] = mapped_column(String, nullable=False, default="")
    subtotal: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    gst_total: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    discount_percent: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    discount_amount: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    grand_total: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    payment_mode: Mapped[str] = mapped_column(String, nullable=False, default="Cash")
    created_at: Mapped[str] = mapped_column(String, nullable=False, default="")

    items: Mapped[list["BillItem"]] = relationship(
        "BillItem", back_populates="bill", cascade="all, delete-orphan"
    )


class BillItem(Base):
    __tablename__ = "bill_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    bill_id: Mapped[int] = mapped_column(ForeignKey("bills.id"), nullable=False)
    medicine_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    medicine_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    medicine_description: Mapped[str] = mapped_column(
        String, nullable=False, default=""
    )
    medicine_usage: Mapped[str] = mapped_column(String, nullable=False, default="")
    qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    unit_price: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    gst_percent: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    line_total: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    bill: Mapped["Bill"] = relationship("Bill", back_populates="items")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[str] = mapped_column(String, nullable=False, default="")


class GstRate(Base):
    __tablename__ = "gst_rates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    rate: Mapped[float] = mapped_column(Float, nullable=False, unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[str] = mapped_column(String, nullable=False, default="")


class UnitType(Base):
    __tablename__ = "unit_types"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[str] = mapped_column(String, nullable=False, default="")


class StoreSetting(Base):
    """Singleton row (id=1): editable pharmacy profile for headers/invoices."""

    __tablename__ = "store_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(
        String, nullable=False, default="MediCare Pharmacy"
    )
    tagline: Mapped[str] = mapped_column(String, nullable=False, default="")
    address: Mapped[str] = mapped_column(String, nullable=False, default="")
    phone: Mapped[str] = mapped_column(String, nullable=False, default="")
    gstin: Mapped[str] = mapped_column(String, nullable=False, default="")
    logo_path: Mapped[str] = mapped_column(String, nullable=False, default="")
    low_stock_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=10)


class PaymentMode(Base):
    """Master payment modes (Cash, UPI, …) — admin managed."""

    __tablename__ = "payment_modes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[str] = mapped_column(String, nullable=False, default="")

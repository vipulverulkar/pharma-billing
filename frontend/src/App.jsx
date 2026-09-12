import { useEffect, useMemo, useRef, useState } from 'react';
import { api, inr, getToken, setToken } from './api.js';

const EMPTY_MED = { name: '', composition: '', unit: 'tablet', batch_no: '', expiry_date: '', quantity: 0, price: 0, gst_percent: 5, description: '', usage: '' };

/* Amount in words, Indian numbering (lakh/crore) — for printed invoices. */
function amountInWords(n) {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x) => (x < 20 ? a[x] : b[Math.floor(x / 10)] + (x % 10 ? ' ' + a[x % 10] : ''));
  const three = (x) =>
    (Math.floor(x / 100) ? a[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') +
    (x % 100 ? two(x % 100) : '');
  const integer = (x) => {
    if (!x) return 'Zero';
    let s = '';
    const cr = Math.floor(x / 1e7); x %= 1e7;
    const lk = Math.floor(x / 1e5); x %= 1e5;
    const th = Math.floor(x / 1e3); x %= 1e3;
    if (cr) s += three(cr) + ' Crore ';
    if (lk) s += two(lk) + ' Lakh ';
    if (th) s += two(th) + ' Thousand ';
    if (x) s += three(x);
    return s.trim();
  };
  const rupees = Math.floor(Number(n) || 0);
  const paise = Math.round(((Number(n) || 0) - rupees) * 100);
  return 'Rupees ' + integer(rupees) + (paise ? ' and Paise ' + two(paise) : '') + ' Only';
}

function Invoice({ bill, settings, onNew }) {
  const discPct = Number(bill.discount_percent) || 0;
  const discAmt = Number(bill.discount_amount) || 0;
  const st = settings || {};
  return (
    <div className="invoice">
      <div className="inv-head">
        {st.logo_url ? <img src={st.logo_url} className="logo-img big" alt="logo" /> : <div className="brand-mark">⚕️</div>}
        <div>
          <h2>{st.name || 'MediCare Pharmacy'}</h2>
          <p>{[st.address, st.phone && ('Ph: ' + st.phone), st.gstin && ('GSTIN: ' + st.gstin)].filter(Boolean).join(' · ') || st.tagline || 'Your trusted neighbourhood pharmacy'}</p>
        </div>
      </div>
      <div className="inv-title">TAX INVOICE</div>
      <div className="inv-meta">
        <div><span>Bill No</span><b>#{bill.id}</b></div>
        <div><span>Date</span><b>{(bill.created_at || '').replace('T', ' ')}</b></div>
        <div><span>Customer</span><b>{bill.customer_name || '—'}</b></div>
        <div><span>Phone</span><b>{bill.customer_phone || '—'}</b></div>
        <div><span>Payment</span><b>{bill.payment_mode || 'Cash'}</b></div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Item</th><th>Tablets</th><th>Rate (₹)</th><th>GST%</th><th>Amount (₹)</th></tr></thead>
        <tbody>
          {bill.items.map((it, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td><b>{it.medicine_name}</b><span className="no-print">{it.medicine_description ? <small> ({it.medicine_description})</small> : null}{it.medicine_usage ? <small> → {it.medicine_usage}</small> : null}<br /><small>{inr(it.unit_price)}/{it.qty} + {it.gst_percent}% GST</small></span></td>
              <td>{it.qty}</td>
              <td>{inr(it.unit_price)}</td>
              <td>{it.gst_percent}%</td>
              <td className="price">{inr(it.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="totals">
        <div><span>Subtotal</span><span>{inr(bill.subtotal)}</span></div>
        <div><span>GST</span><span>{inr(bill.gst_total)}</span></div>
        {discAmt > 0 && <div><span>Discount ({discPct}%)</span><span>− {inr(discAmt)}</span></div>}
        <div className="grand"><span>Total</span><span>{inr(bill.grand_total)}</span></div>
      </div>
      <p className="inv-words">{amountInWords(bill.grand_total)}</p>
      <div className="row no-print inv-actions">
        <button className="primary" onClick={() => window.print()}>🖨 Print Invoice</button>
        {onNew && <button className="ghost" onClick={onNew}>+ New Bill</button>}
      </div>
      <p className="inv-foot">Thank you, get well soon! · E. &amp; O.E.</p>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('billing');
  const [medicines, setMedicines] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // inventory form
  const [editing, setEditing] = useState(null); // null | {…med} | 'new'
  const [form, setForm] = useState(EMPTY_MED);

  // billing cart
  const [cart, setCart] = useState([]); // [{medicine_id, qty}]
  const [customer, setCustomer] = useState({ customer_name: '', customer_phone: '' });
  const [discount, setDiscount] = useState(0); // bill discount %
  const [payMode, setPayMode] = useState('Cash');
  const [tendered, setTendered] = useState('');
  const [unitFilter, setUnitFilter] = useState('all');
  const medsReq = useRef(0); // guards billing/inventory search against stale responses
  const [lastBill, setLastBill] = useState(null);

  // bills history
  const [bills, setBills] = useState([]);
  const [billDetail, setBillDetail] = useState(null);

  // auth
  const [authed, setAuthed] = useState(!!getToken());
  const [username, setUsername] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');

  // user management (admin) + own password
  const [users, setUsers] = useState([]);
  const [userForm, setUserForm] = useState({ username: '', password: '', is_admin: false });
  const [pwdForm, setPwdForm] = useState({ current: '', next: '', confirm: '' });

  // GST master data (admin manages, everyone reads)
  const [gstRates, setGstRates] = useState([]);
  const [gstForm, setGstForm] = useState({ rate: '', is_active: true });
  const [editingRate, setEditingRate] = useState(null);

  // Medicine-type master data (admin manages, everyone reads)
  const [unitTypes, setUnitTypes] = useState([]);
  const [typeForm, setTypeForm] = useState({ name: '', is_active: true });
  const [editingType, setEditingType] = useState(null);
  const [mastersMenuOpen, setMastersMenuOpen] = useState(false);

  // Payment-mode master data (admin manages, everyone reads)
  const [paymentModes, setPaymentModes] = useState([]);
  const [modeForm, setModeForm] = useState({ name: '', is_active: true });
  const [editingMode, setEditingMode] = useState(null);

  // Store profile (public read, admin writes)
  const [settings, setSettings] = useState({ name: 'MediCare Pharmacy', tagline: '', address: '', phone: '', gstin: '', logo_url: '', low_stock_limit: 10 });
  const [storeForm, setStoreForm] = useState({ name: '', tagline: '', address: '', phone: '', gstin: '', low_stock_limit: 10 });

  const authGuard = (e) => {
    if (e && e.code === 401) {
      setToken('');
      setAuthed(false);
      return true;
    }
    return false;
  };

  const doLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    try {
      const r = await api.login(loginForm.username.trim(), loginForm.password);
      setToken(r.token);
      setUsername(r.username);
      setIsAdmin(!!r.is_admin);
      setLoginForm({ username: '', password: '' });
      setAuthed(true);
    } catch (err) {
      setLoginError(err.message);
    }
  };

  const doLogout = async () => {
    try { await api.logout(); } catch { /* ignore */ }
    setToken('');
    setAuthed(false);
    setIsAdmin(false);
    setUsername('');
    setUsers([]);
    setGstRates([]);
    setEditingRate(null);
    setUnitTypes([]);
    setEditingType(null);
    setPaymentModes([]);
    setEditingMode(null);
    setCart([]);
    setBillDetail(null);
  };

  const loadUsers = async () => {
    try {
      setUsers(await api.listUsers());
    } catch (e) {
      if (authGuard(e)) return;
      setError(e.message);
    }
  };

  const loadGst = async () => {
    try {
      setGstRates(await api.listGstRates());
    } catch (e) {
      if (authGuard(e)) return;
      setError(e.message);
    }
  };

  const loadTypes = async () => {
    try {
      setUnitTypes(await api.listUnitTypes());
    } catch (e) {
      if (authGuard(e)) return;
      setError(e.message);
    }
  };

  const loadPayModes = async () => {
    try {
      setPaymentModes(await api.listPaymentModes());
    } catch (e) {
      if (authGuard(e)) return;
      setError(e.message);
    }
  };

  const addMode = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      const m = await api.createPaymentMode(modeForm.name);
      setNotice(`Payment mode '${m.name}' added.`);
      setModeForm({ name: '', is_active: true });
      loadPayModes();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const saveMode = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      const m = await api.updatePaymentMode(editingMode, { name: modeForm.name, is_active: modeForm.is_active });
      setNotice(`Mode updated to '${m.name}'${m.bills_updated ? ` — ${m.bills_updated} bill(s) updated.` : '.'}`);
      setEditingMode(null);
      setModeForm({ name: '', is_active: true });
      loadPayModes(); loadBills();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const toggleMode = async (m) => {
    setError(''); setNotice('');
    try {
      await api.updatePaymentMode(m.id, { is_active: !m.is_active });
      setNotice(`Mode '${m.name}' ${m.is_active ? 'deactivated' : 'activated'}.`);
      loadPayModes();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const removeMode = async (m) => {
    if (!window.confirm(`Delete payment mode '${m.name}'?`)) return;
    setError(''); setNotice('');
    try {
      await api.deletePaymentMode(m.id);
      setNotice(`Mode '${m.name}' deleted.`);
      loadPayModes();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const addType = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      const t = await api.createUnitType(typeForm.name);
      setNotice(`Medicine type '${t.name}' added.`);
      setTypeForm({ name: '', is_active: true });
      loadTypes();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const saveType = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      const t = await api.updateUnitType(editingType, { name: typeForm.name, is_active: typeForm.is_active });
      setNotice(`Type updated to '${t.name}'${t.medicines_updated ? ` — ${t.medicines_updated} medicine(s) updated.` : '.'}`);
      setEditingType(null);
      setTypeForm({ name: '', is_active: true });
      loadTypes(); loadMeds(search);
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const toggleType = async (t) => {
    setError(''); setNotice('');
    try {
      await api.updateUnitType(t.id, { is_active: !t.is_active });
      setNotice(`Type '${t.name}' ${t.is_active ? 'deactivated' : 'activated'}.`);
      loadTypes();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const removeType = async (t) => {
    if (!window.confirm(`Delete medicine type '${t.name}'?`)) return;
    setError(''); setNotice('');
    try {
      await api.deleteUnitType(t.id);
      setNotice(`Type '${t.name}' deleted.`);
      loadTypes();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const openStoreTab = () => {
    setStoreForm({ name: settings.name || '', tagline: settings.tagline || '', address: settings.address || '', phone: settings.phone || '', gstin: settings.gstin || '', low_stock_limit: settings.low_stock_limit ?? 10 });
    setTab('masters-store');
    setMastersMenuOpen(false);
  };

  const saveStore = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      const st = await api.updateSettings(storeForm);
      setSettings(st);
      setNotice('Store profile updated.');
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const uploadLogoFile = async (e) => {
    const file = (e.target.files || [])[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setNotice('');
    try {
      const st = await api.uploadLogo(file);
      setSettings(st);
      setNotice('Logo updated.');
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const removeLogo = async () => {
    setError(''); setNotice('');
    try {
      const st = await api.deleteLogo();
      setSettings(st);
      setNotice('Logo removed.');
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const addSlab = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      const r = await api.createGstRate(Number(gstForm.rate));
      setNotice(`GST slab ${r.rate}% added.`);
      setGstForm({ rate: '', is_active: true });
      loadGst();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const saveSlab = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      const r = await api.updateGstRate(editingRate, { rate: Number(gstForm.rate), is_active: gstForm.is_active });
      setNotice(`Slab updated to ${r.rate}%${r.medicines_updated ? ` — ${r.medicines_updated} medicine(s) updated.` : '.'}`);
      setEditingRate(null);
      setGstForm({ rate: '', is_active: true });
      loadGst(); loadMeds(search);
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const toggleSlab = async (s) => {
    setError(''); setNotice('');
    try {
      await api.updateGstRate(s.id, { is_active: !s.is_active });
      setNotice(`Slab ${s.rate}% ${s.is_active ? 'deactivated' : 'activated'}.`);
      loadGst();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const removeSlab = async (s) => {
    if (!window.confirm(`Delete GST slab ${s.rate}%?`)) return;
    setError(''); setNotice('');
    try {
      await api.deleteGstRate(s.id);
      setNotice(`Slab ${s.rate}% deleted.`);
      loadGst();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const addUser = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      const u = await api.createUser(userForm);
      setNotice(`User '${u.username}' created${u.is_admin ? ' (admin)' : ''}.`);
      setUserForm({ username: '', password: '', is_admin: false });
      loadUsers();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const removeUser = async (id, name) => {
    if (!window.confirm(`Remove login for '${name}'?`)) return;
    setError(''); setNotice('');
    try {
      await api.deleteUser(id);
      setNotice(`User '${name}' removed.`);
      loadUsers();
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const changePwd = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    if (pwdForm.next !== pwdForm.confirm) { setError('New passwords do not match.'); return; }
    try {
      await api.changePassword(pwdForm.current, pwdForm.next);
      setNotice('Password changed successfully.');
      setPwdForm({ current: '', next: '', confirm: '' });
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const loadMeds = async (q = '') => {
    const reqId = ++medsReq.current;
    setLoading(true);
    setError('');
    try {
      const data = await api.listMedicines(q);
      if (reqId !== medsReq.current) return; // a newer search is in flight — drop this stale result
      setMedicines(data);
    } catch (e) {
      if (authGuard(e)) return;
      setError(e.message);
    } finally {
      if (reqId === medsReq.current) setLoading(false);
    }
  };

  const loadBills = async () => {
    try {
      setBills(await api.listBills());
    } catch (e) {
      if (authGuard(e)) return;
      setError(e.message);
    }
  };

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => {});
  }, []);

  useEffect(() => {
    if (!authed) return;
    api.me()
      .then((r) => { setUsername(r.username); setIsAdmin(!!r.is_admin); })
      .catch(() => {
        setToken('');
        setAuthed(false);
        return;
      });
    loadMeds();
    loadBills();
    loadGst();
    loadTypes();
    loadPayModes();
  }, [authed]);

  useEffect(() => {
    if (authed && isAdmin && tab === 'users') loadUsers();
  }, [authed, isAdmin, tab]);

  useEffect(() => {
    const t = setTimeout(() => loadMeds(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const medById = useMemo(() => Object.fromEntries(medicines.map((m) => [m.id, m])), [medicines]);
  const cartQty = useMemo(() => Object.fromEntries(cart.map((c) => [c.medicine_id, c.qty])), [cart]);
  const visibleMeds = useMemo(
    () => medicines.filter((m) => unitFilter === 'all' || (m.unit || 'tablet') === unitFilter),
    [medicines, unitFilter]
  );

  const quickAddFirst = () => {
    const target = visibleMeds.find((m) => m.quantity > 0);
    if (target) addToCart(target.id);
  };

  const cartLines = cart.map((c) => {
    const m = medById[c.medicine_id];
    if (!m) return null;
    const base = m.price * c.qty;
    const gst = (base * m.gst_percent) / 100;
    return { ...c, med: m, base, gst, total: base + gst };
  }).filter(Boolean);

  const subtotal = cartLines.reduce((s, l) => s + l.base, 0);
  const gstTotal = cartLines.reduce((s, l) => s + l.gst, 0);
  const discPct = Math.max(0, Math.min(100, Number(discount) || 0));
  const discAmount = Math.round((subtotal + gstTotal) * discPct) / 100;
  const grandTotal = Math.round((subtotal + gstTotal - discAmount) * 100) / 100;
  const tenderedNum = tendered === '' ? null : Number(tendered);
  const change = tenderedNum === null || isNaN(tenderedNum) ? null : Math.round((tenderedNum - grandTotal) * 100) / 100;

  const _l = Number(settings.low_stock_limit);
  const lowLimit = Number.isFinite(_l) && _l >= 0 ? _l : 10;
  const lowStock = medicines.filter((m) => m.quantity <= lowLimit).length;
  const todaySales = bills
    .filter((b) => (b.created_at || '').slice(0, 10) === new Date().toISOString().slice(0, 10))
    .reduce((s, b) => s + (Number(b.grand_total) || 0), 0);

  const openNew = () => { setEditing('new'); setForm(EMPTY_MED); };
  const openEdit = (m) => { setEditing(m.id); setForm({ ...m }); };

  const saveMed = async (e) => {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      if (editing === 'new') {
        await api.addMedicine({ ...form, quantity: Number(form.quantity), price: Number(form.price), gst_percent: Number(form.gst_percent), description: form.description || '', usage: form.usage || '' });
        setNotice('Medicine added.');
      } else {
        await api.updateMedicine(editing, { ...form, quantity: Number(form.quantity), price: Number(form.price), gst_percent: Number(form.gst_percent), description: form.description || '', usage: form.usage || '' });
        setNotice('Medicine updated.');
      }
      setEditing(null);
      loadMeds(search);
    } catch (err) { if (authGuard(err)) return; setError(err.message); }
  };

  const removeMed = async (id) => {
    if (!window.confirm('Remove this medicine from inventory?')) return;
    try { await api.deleteMedicine(id); setNotice('Medicine removed.'); loadMeds(search); }
    catch (e) { if (authGuard(e)) return; setError(e.message); }
  };

  const addToCart = (id) => {
    setCart((prev) => {
      const found = prev.find((c) => c.medicine_id === id);
      if (found) return prev.map((c) => (c.medicine_id === id ? { ...c, qty: c.qty + 1 } : c));
      return [...prev, { medicine_id: id, qty: 1 }];
    });
  };

  const setQty = (id, qty) => {
    const n = Math.round(Number(qty) || 0);
    if (n < 1) {
      setCart((prev) => prev.filter((c) => c.medicine_id !== id));
      return;
    }
    const m = medById[id];
    const max = m ? m.quantity : 99;
    const clamped = Math.min(max, n);
    setCart((prev) => prev.map((c) => (c.medicine_id === id ? { ...c, qty: clamped } : c)));
  };

  const checkout = async () => {
    setError(''); setNotice('');
    if (cartLines.length === 0) { setError('Cart is empty — add medicines first.'); return; }
    try {
      const bill = await api.createBill({
        ...customer,
        items: cart.map((c) => ({ medicine_id: c.medicine_id, qty: c.qty })),
        discount_percent: discPct,
        payment_mode: payMode,
      });
      setLastBill(bill);
      setNotice(`Bill #${bill.id} created — ${inr(bill.grand_total)} (${bill.payment_mode})`);
      setCart([]); setCustomer({ customer_name: '', customer_phone: '' });
      setDiscount(0); setPayMode('Cash'); setTendered('');
      loadMeds(search); loadBills();
    } catch (e) { if (authGuard(e)) return; setError(e.message); }
  };

  const viewBill = async (id) => {
    try { setBillDetail(await api.billDetail(id)); } catch (e) { if (authGuard(e)) return; setError(e.message); }
  };

  if (!authed) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={doLogin}>
          {settings.logo_url ? <img src={settings.logo_url} className="logo-preview" alt="logo" /> : <div className="brand-mark big">⚕️</div>}
          <h2>{settings.name}</h2>
          <p className="login-sub">{settings.tagline || 'Sign in to continue'}</p>
          {loginError && <div className="error">⚠ {loginError}</div>}
          <label>Username
            <input value={loginForm.username} onChange={(e) => setLoginForm({ ...loginForm, username: e.target.value })} autoComplete="username" required />
          </label>
          <label>Password
            <input type="password" value={loginForm.password} onChange={(e) => setLoginForm({ ...loginForm, password: e.target.value })} autoComplete="current-password" required />
          </label>
          <button className="primary" type="submit" style={{ width: '100%', marginTop: 6 }}>Login</button>
          <p className="login-hint">Default login — username: <b>admin</b>, password: <b>admin</b></p>
        </form>
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="brand">
          {settings.logo_url ? <img src={settings.logo_url} className="logo-img" alt="logo" /> : <div className="brand-mark">⚕️</div>}
          <div>
            <h1>{settings.name}</h1>
            <small>{(settings.tagline || 'BILLING IN ₹ INR · GST-READY').toUpperCase()}</small>
          </div>
        </div>
        <div className="stats no-print">
          <span className="chip">💊 {medicines.length} medicines</span>
          <span className={`chip${lowStock ? ' warn' : ''}`}>⚠️ {lowStock} low stock</span>
          <span className="chip">📈 Today: {inr(todaySales)}</span>
          <span className="chip">👤 {username || '…'}{isAdmin ? ' (admin)' : ''}</span>
          <button className="logout-btn" onClick={doLogout} title="Log out">⏻ Logout</button>
        </div>
      </header>
      <nav className="tabs">
        {[
          { id: 'billing', label: `🧾 Billing${cart.length ? ` (${cart.length})` : ''}` },
          { id: 'inventory', label: '📦 Inventory' },
          { id: 'bills', label: '📜 Bills' },
          { id: 'users', label: isAdmin ? '👥 Users' : '👤 Account' },
        ].map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => { setTab(t.id); setMastersMenuOpen(false); }}>
            {t.label}
          </button>
        ))}
        {isAdmin && (
          <div className="menu-wrap">
            <button className={tab.startsWith('masters-') ? 'menu-btn active' : 'menu-btn'} onClick={() => setMastersMenuOpen((o) => !o)}>
              🏷️ Masters ▾
            </button>
            {mastersMenuOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setMastersMenuOpen(false)} />
                <div className="dropdown">
                  <button className={tab === 'masters-gst' ? 'on' : ''} onClick={() => { setTab('masters-gst'); setMastersMenuOpen(false); }}>📊 GST Rates</button>
                  <button className={tab === 'masters-types' ? 'on' : ''} onClick={() => { setTab('masters-types'); setMastersMenuOpen(false); }}>💊 Medicine Types</button>
                  <button className={tab === 'masters-pay' ? 'on' : ''} onClick={() => { setTab('masters-pay'); setMastersMenuOpen(false); }}>💳 Payment Modes</button>
                  <button className={tab === 'masters-store' ? 'on' : ''} onClick={openStoreTab}>🏪 Store Profile</button>
                </div>
              </>
            )}
          </div>
        )}
      </nav>
      <main>
        {error && <div className="error">⚠ {error}</div>}
        {notice && <div className="success">✅ {notice}</div>}

        {tab === 'billing' && (
          <>
          <div className="cards billing">
            <div className="no-print">
              <div className="row no-print">
                <input className="search-big" autoFocus placeholder="🔍 Name, salt, use or batch… (Enter = add first match)" value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') quickAddFirst(); }} style={{ flex: 1 }} />
                <button className="ghost" onClick={() => loadMeds(search)}>Refresh</button>
              </div>
              <div className="chip-row no-print">
                <button type="button" className={unitFilter === 'all' ? 'fchip on' : 'fchip'} onClick={() => setUnitFilter('all')}>All</button>
                {unitTypes.filter((t) => t.is_active).map((t) => (
                  <button key={t.id} type="button" className={unitFilter === t.name ? 'fchip on' : 'fchip'} onClick={() => setUnitFilter(t.name)}>{t.name}</button>
                ))}
              </div>
              {loading ? <p>Loading…</p> : visibleMeds.length === 0 ? (
                <div className="empty"><span className="big">💊</span>No medicines found. Try another search or type.</div>
              ) : (
                <table className="med-table">
                  <thead><tr><th>Medicine</th><th>Stock</th><th>Price/tab</th><th></th></tr></thead>
                  <tbody>
                    {visibleMeds.map((m) => {
                      const inCart = cartQty[m.id] || 0;
                      return (
                      <tr key={m.id} className={inCart ? 'in-cart' : ''}>
                        <td><b>{m.name}</b> <span className="pill tag">{m.unit || 'tablet'}</span><br /><small>{m.composition ? `Salt: ${m.composition} · ` : ''}{m.batch_no} · exp {m.expiry_date || '—'} · +{m.gst_percent}% GST</small>{m.description ? <><br /><small>💊 {m.description}</small></> : null}{m.usage ? <><br /><small>📋 {m.usage}</small></> : null}</td>
                        <td><span className={m.quantity <= lowLimit ? 'pill low' : 'pill ok'}>{m.quantity}</span></td>
                        <td className="price">{inr(m.price)}</td>
                        <td>
                          {inCart ? (
                            <div className="stepper">
                              <button type="button" onClick={() => setQty(m.id, inCart - 1)}>−</button>
                              <span>{inCart}</span>
                              <button type="button" onClick={() => setQty(m.id, inCart + 1)}>+</button>
                            </div>
                          ) : (
                            <button className="add-btn" onClick={() => addToCart(m.id)} disabled={m.quantity === 0}>Add +</button>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className={cartLines.length > 0 ? 'cart has-items' : 'cart'} id="bill-cart">
              {cartLines.length > 0 ? (
                <div className="editor">
                  <h3>🧾 Current Bill <span className="pill tag">{cartLines.length} item{cartLines.length > 1 ? 's' : ''}</span></h3>
                  <input placeholder="Customer name" value={customer.customer_name} onChange={(e) => setCustomer({ ...customer, customer_name: e.target.value })} style={{ width: '100%', marginBottom: 8 }} />
                  <input placeholder="Phone" value={customer.customer_phone} onChange={(e) => setCustomer({ ...customer, customer_phone: e.target.value })} style={{ width: '100%', marginBottom: 8 }} />
                  <div className="pay-row">
                    <span>Pay via</span>
                    {(paymentModes.filter((p) => p.is_active).map((p) => p.name).length ? paymentModes.filter((p) => p.is_active).map((p) => p.name) : ['Cash']).map((p) => (
                      <button key={p} type="button" className={payMode === p ? 'preset on' : 'preset'} onClick={() => setPayMode(p)}>{p}</button>
                    ))}
                  </div>
                  <div className="cart-scroll">
                  <table>
                    <thead><tr><th>Item</th><th>Tablets</th><th>Total</th><th></th></tr></thead>
                    <tbody>
                      {cartLines.map((l) => (
                        <tr key={l.medicine_id}>
                          <td><small><b>{l.med.name}</b></small><span className="no-print"><small><br />{inr(l.med.price)}/{l.med.unit || 'tablet'} + {l.med.gst_percent}% GST</small></span></td>
                          <td>
                            <div className="stepper">
                              <button type="button" onClick={() => setQty(l.medicine_id, l.qty - 1)}>−</button>
                              <span>{l.qty}</span>
                              <button type="button" onClick={() => setQty(l.medicine_id, l.qty + 1)}>+</button>
                            </div>
                            <small>max {l.med.quantity}</small>
                          </td>
                          <td><small className="price">{inr(l.total)}</small></td>
                          <td><button className="ghost" onClick={() => setCart((prev) => prev.filter((c) => c.medicine_id !== l.medicine_id))}>✕</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                  <div className="disc-row">
                    <span>Discount</span>
                    {[0, 5, 10].map((d) => (
                      <button key={d} type="button" className={discPct === d ? 'preset on' : 'preset'} onClick={() => setDiscount(d)}>{d}%</button>
                    ))}
                    <input type="number" min="0" max="100" value={discount} onChange={(e) => setDiscount(e.target.value)} style={{ width: 70 }} /> %
                  </div>
                  <div className="totals">
                    <div><span>Subtotal</span><span>{inr(subtotal)}</span></div>
                    <div><span>GST</span><span>{inr(gstTotal)}</span></div>
                    {discAmount > 0 && <div><span>Discount ({discPct}%)</span><span>− {inr(discAmount)}</span></div>}
                    <div className="grand"><span>Total</span><span>{inr(grandTotal)}</span></div>
                  </div>
                  <div className="tender-row">
                    <span>Cash received</span>
                    <input type="number" min="0" placeholder="₹ tendered" value={tendered} onChange={(e) => setTendered(e.target.value)} style={{ width: 120 }} />
                    {change !== null && (
                      change >= 0
                        ? <span className="pill ok">Change: {inr(change)}</span>
                        : <span className="pill low">Short: {inr(-change)}</span>
                    )}
                  </div>
                  <div className="row no-print bill-actions" style={{ marginTop: 12 }}>
                    <button className="primary bill-btn" onClick={checkout}>✓ Bill {inr(grandTotal)}</button>
                    <button className="ghost" onClick={() => { setCart([]); setDiscount(0); setTendered(''); }}>Clear</button>
                  </div>
                </div>
              ) : lastBill ? (
                <Invoice bill={lastBill} settings={settings} onNew={() => setLastBill(null)} />
              ) : (
                <>
                  <h3>🧾 Current Bill</h3>
                  <div className="empty"><span className="big">🧺</span>Cart is empty.<br />Tap <b>Add +</b> on any medicine to start billing.</div>
                </>
              )}
            </div>
          </div>
          {cartLines.length > 0 && (
            <button className="float-bill no-print" onClick={() => document.getElementById('bill-cart')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              🧾 {cartLines.length} item{cartLines.length > 1 ? 's' : ''} · {inr(grandTotal)} →
            </button>
          )}
          </>
        )}

        {tab === 'inventory' && (
          <div>
            <div className="row no-print">
              <input placeholder="🔍 Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1 }} />
              {isAdmin ? (
                <button className="primary" onClick={openNew}>+ Add Medicine</button>
              ) : (
                <span className="pill tag">👁️ View only — only admin can edit inventory</span>
              )}
            </div>
            <table>
              <thead><tr><th>ID</th><th>Name</th><th>Composition (salt)</th><th>Batch</th><th>Expiry</th><th>Tablets in stock</th><th>Price/tablet (₹)</th><th>GST %</th>{isAdmin && <th>Actions</th>}</tr></thead>
              <tbody>
                {medicines.map((m) => (
                  <tr key={m.id}>
                    <td>{m.id}</td><td><b>{m.name}</b> <span className="pill tag">{m.unit || 'tablet'}</span>{m.description ? <><br /><small>💊 {m.description}</small></> : null}{m.usage ? <><br /><small>📋 {m.usage}</small></> : null}</td><td><small>{m.composition || '—'}</small></td><td>{m.batch_no}</td><td>{m.expiry_date}</td>
                    <td><span className={m.quantity <= lowLimit ? 'pill low' : 'pill ok'}>{m.quantity}</span></td>
                    <td className="price">{inr(m.price)}</td><td>{m.gst_percent}%</td>
                    {isAdmin && (
                      <td className="no-print">
                        <button className="ghost" onClick={() => openEdit(m)}>Edit</button>{' '}
                        <button className="danger" onClick={() => removeMed(m.id)}>Remove</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {editing && isAdmin && (
              <div className="modal">
                <div>
                  <h3>{editing === 'new' ? 'Add Medicine' : `Edit #${editing}`}</h3>
                  <form onSubmit={saveMed}>
                    <div className="form-grid">
                      <label className="full">Medicine name *
                        <input placeholder="e.g. Paracetamol 650mg Tablet" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                      </label>
                      <label className="full">Composition / salt
                        <input placeholder="e.g. Paracetamol" value={form.composition || ''} onChange={(e) => setForm({ ...form, composition: e.target.value })} />
                      </label>
                      <label className="full">Description (short)
                        <input placeholder="What this medicine treats" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                      </label>
                      <label className="full">Usage / how to take
                        <input placeholder="Dose instructions shown while billing" value={form.usage || ''} onChange={(e) => setForm({ ...form, usage: e.target.value })} />
                      </label>
                      <label>Medicine type
                        <select value={form.unit || 'tablet'} onChange={(e) => setForm({ ...form, unit: e.target.value })} title="Medicine type (master data)">
                          {!unitTypes.some((t) => t.is_active && t.name === (form.unit || 'tablet')) && (
                            <option value={form.unit}>{form.unit} (legacy — pick a type)</option>
                          )}
                          {unitTypes.filter((t) => t.is_active).map((t) => (
                            <option key={t.id} value={t.name}>{t.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>Batch no
                        <input placeholder="e.g. B101" value={form.batch_no} onChange={(e) => setForm({ ...form, batch_no: e.target.value })} />
                      </label>
                      <label>Expiry date
                        <input type="date" value={form.expiry_date} onChange={(e) => setForm({ ...form, expiry_date: e.target.value })} />
                      </label>
                      <label>Stock quantity
                        <input type="number" min="0" placeholder="e.g. 500" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
                      </label>
                      <label>Price per unit (₹)
                        <input type="number" min="0" step="0.01" placeholder="e.g. 5.00" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
                      </label>
                      <label>GST slab
                        <select value={form.gst_percent} onChange={(e) => setForm({ ...form, gst_percent: Number(e.target.value) })} title="GST slab (master data)">
                          {!gstRates.some((s) => s.is_active && Number(s.rate) === Number(form.gst_percent)) && (
                            <option value={form.gst_percent}>{form.gst_percent}% (legacy — pick a slab)</option>
                          )}
                          {gstRates.filter((s) => s.is_active).map((s) => (
                            <option key={s.id} value={s.rate}>{s.rate}% GST</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="row" style={{ marginTop: 12 }}>
                      <button className="primary" type="submit">Save</button>
                      <button className="ghost" type="button" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'bills' && (
          <div className="cards">
            <div className="no-print">
              <h3 style={{ margin: '0 0 4px', color: 'var(--teal-900)' }}>Recent bills (₹ INR)</h3>
              {bills.length === 0 ? (
                <div className="empty"><span className="big">🧾</span>No bills yet. Create one from the Billing tab.</div>
              ) : (
              <table>
                <thead><tr><th>#</th><th>Customer</th><th>Total</th><th>Date</th><th></th></tr></thead>
                <tbody>
                  {bills.map((b) => (
                    <tr key={b.id}>
                      <td><b>#{b.id}</b></td><td>{b.customer_name || '—'}<br /><small>{b.customer_phone}</small></td>
                      <td className="price">{inr(b.grand_total)}</td><td><small>{b.created_at}</small></td>
                      <td><button className="ghost" onClick={() => viewBill(b.id)}>View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              )}
            </div>
            <div className="cart">
              {!billDetail ? (
                <>
                  <h3>Bill detail</h3>
                  <div className="empty"><span className="big">🧾</span>Select a bill to view its invoice.</div>
                </>
              ) : (
                <Invoice bill={billDetail} settings={settings} />
              )}
            </div>
          </div>
        )}
        {tab === 'masters-gst' && isAdmin && (
          <div className="cards">
            <div>
              <h3 style={{ margin: '0 0 4px', color: 'var(--teal-900)' }}>Master GST slabs</h3>
              <p style={{ margin: '0 0 6px' }}><small>Medicines must use one of these slabs. Renaming a slab updates all medicines on it. Slabs in use can't be deleted — deactivate them instead.</small></p>
              <table>
                <thead><tr><th>Slab</th><th>Status</th><th>Medicines using</th><th></th></tr></thead>
                <tbody>
                  {gstRates.map((s) => (
                    <tr key={s.id}>
                      <td className="price">{s.rate}%</td>
                      <td>{s.is_active ? <span className="pill ok">active</span> : <span className="pill low">inactive</span>}</td>
                      <td>{s.medicines_using}</td>
                      <td className="no-print">
                        <button className="ghost" onClick={() => { setEditingRate(s.id); setGstForm({ rate: s.rate, is_active: !!s.is_active }); }}>Edit</button>{' '}
                        <button className="ghost" onClick={() => toggleSlab(s)}>{s.is_active ? 'Deactivate' : 'Activate'}</button>{' '}
                        <button className="danger" onClick={() => removeSlab(s)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cart">
              <h3>{editingRate ? '✏️ Edit slab' : '➕ Add slab'}</h3>
              <form onSubmit={editingRate ? saveSlab : addSlab}>
                <input type="number" min="0" max="100" step="0.01" placeholder="GST rate % (e.g. 5)" value={gstForm.rate} onChange={(e) => setGstForm({ ...gstForm, rate: e.target.value })} style={{ width: '100%', marginBottom: 8 }} required />
                {editingRate && (
                  <label className="row" style={{ fontSize: 14, marginBottom: 10 }}>
                    <input type="checkbox" checked={gstForm.is_active} onChange={(e) => setGstForm({ ...gstForm, is_active: e.target.checked })} />
                    Active (available for medicines)
                  </label>
                )}
                <div className="row">
                  <button className="primary" type="submit">{editingRate ? 'Save' : 'Add slab'}</button>
                  {editingRate && <button className="ghost" type="button" onClick={() => { setEditingRate(null); setGstForm({ rate: '', is_active: true }); }}>Cancel</button>}
                </div>
              </form>
            </div>
          </div>
        )}
        {tab === 'masters-types' && isAdmin && (
          <div className="cards">
            <div>
              <h3 style={{ margin: '0 0 4px', color: 'var(--teal-900)' }}>Medicine types</h3>
              <p style={{ margin: '0 0 6px' }}><small>Every medicine uses one of these types (billing unit). Renaming a type updates all medicines on it. Types in use can't be deleted — deactivate them instead.</small></p>
              <table>
                <thead><tr><th>Type</th><th>Status</th><th>Medicines using</th><th></th></tr></thead>
                <tbody>
                  {unitTypes.map((t) => (
                    <tr key={t.id}>
                      <td><span className="pill tag">{t.name}</span></td>
                      <td>{t.is_active ? <span className="pill ok">active</span> : <span className="pill low">inactive</span>}</td>
                      <td>{t.medicines_using}</td>
                      <td className="no-print">
                        <button className="ghost" onClick={() => { setEditingType(t.id); setTypeForm({ name: t.name, is_active: !!t.is_active }); }}>Edit</button>{' '}
                        <button className="ghost" onClick={() => toggleType(t)}>{t.is_active ? 'Deactivate' : 'Activate'}</button>{' '}
                        <button className="danger" onClick={() => removeType(t)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cart">
              <h3>{editingType ? '✏️ Edit type' : '➕ Add type'}</h3>
              <form onSubmit={editingType ? saveType : addType}>
                <input placeholder="Type name (e.g. drops)" value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} style={{ width: '100%', marginBottom: 8 }} required />
                {editingType && (
                  <label className="row" style={{ fontSize: 14, marginBottom: 10 }}>
                    <input type="checkbox" checked={typeForm.is_active} onChange={(e) => setTypeForm({ ...typeForm, is_active: e.target.checked })} />
                    Active (available for medicines)
                  </label>
                )}
                <div className="row">
                  <button className="primary" type="submit">{editingType ? 'Save' : 'Add type'}</button>
                  {editingType && <button className="ghost" type="button" onClick={() => { setEditingType(null); setTypeForm({ name: '', is_active: true }); }}>Cancel</button>}
                </div>
              </form>
            </div>
          </div>
        )}
        {tab === 'masters-pay' && isAdmin && (
          <div className="cards">
            <div>
              <h3 style={{ margin: '0 0 4px', color: 'var(--teal-900)' }}>Payment modes</h3>
              <p style={{ margin: '0 0 6px' }}><small>Bills must use one of these modes. Renaming a mode updates all bills on it. Modes in use can't be deleted — deactivate them instead.</small></p>
              <table>
                <thead><tr><th>Mode</th><th>Status</th><th>Bills using</th><th></th></tr></thead>
                <tbody>
                  {paymentModes.map((m) => (
                    <tr key={m.id}>
                      <td><span className="pill tag">{m.name}</span></td>
                      <td>{m.is_active ? <span className="pill ok">active</span> : <span className="pill low">inactive</span>}</td>
                      <td>{m.bills_using}</td>
                      <td className="no-print">
                        <button className="ghost" onClick={() => { setEditingMode(m.id); setModeForm({ name: m.name, is_active: !!m.is_active }); }}>Edit</button>{' '}
                        <button className="ghost" onClick={() => toggleMode(m)}>{m.is_active ? 'Deactivate' : 'Activate'}</button>{' '}
                        <button className="danger" onClick={() => removeMode(m)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cart">
              <h3>{editingMode ? '✏️ Edit mode' : '➕ Add mode'}</h3>
              <form onSubmit={editingMode ? saveMode : addMode}>
                <input placeholder="Mode name (e.g. NetBanking)" value={modeForm.name} onChange={(e) => setModeForm({ ...modeForm, name: e.target.value })} style={{ width: '100%', marginBottom: 8 }} required />
                {editingMode && (
                  <label className="row" style={{ fontSize: 14, marginBottom: 10 }}>
                    <input type="checkbox" checked={modeForm.is_active} onChange={(e) => setModeForm({ ...modeForm, is_active: e.target.checked })} />
                    Active (offered at billing)
                  </label>
                )}
                <div className="row">
                  <button className="primary" type="submit">{editingMode ? 'Save' : 'Add mode'}</button>
                  {editingMode && <button className="ghost" type="button" onClick={() => { setEditingMode(null); setModeForm({ name: '', is_active: true }); }}>Cancel</button>}
                </div>
              </form>
            </div>
          </div>
        )}
        {tab === 'masters-store' && isAdmin && (
          <div className="cards">
            <div className="cart">
              <h3>🏪 Pharmacy details</h3>
              <p style={{ margin: '0 0 10px' }}><small>Shown on the header, login screen and printed invoices.</small></p>
              <form onSubmit={saveStore}>
                <input placeholder="Pharmacy name *" value={storeForm.name} onChange={(e) => setStoreForm({ ...storeForm, name: e.target.value })} style={{ width: '100%', marginBottom: 8 }} required />
                <input placeholder="Tagline (e.g. Your trusted neighbourhood pharmacy)" value={storeForm.tagline} onChange={(e) => setStoreForm({ ...storeForm, tagline: e.target.value })} style={{ width: '100%', marginBottom: 8 }} />
                <textarea placeholder="Address" value={storeForm.address} onChange={(e) => setStoreForm({ ...storeForm, address: e.target.value })} rows={3} style={{ width: '100%', marginBottom: 8 }} />
                <div className="row">
                  <input placeholder="Phone" value={storeForm.phone} onChange={(e) => setStoreForm({ ...storeForm, phone: e.target.value })} style={{ flex: 1, minWidth: 120 }} />
                  <input placeholder="GSTIN" value={storeForm.gstin} onChange={(e) => setStoreForm({ ...storeForm, gstin: e.target.value.toUpperCase() })} style={{ flex: 1, minWidth: 140 }} />
                </div>
                <div className="row" style={{ marginTop: 8, fontSize: 14 }}>
                  <label htmlFor="lowstock">Low-stock alert below (tablets):</label>
                  <input id="lowstock" type="number" min="0" value={storeForm.low_stock_limit} onChange={(e) => setStoreForm({ ...storeForm, low_stock_limit: e.target.value })} style={{ width: 90 }} />
                </div>
                <button className="primary" type="submit" style={{ width: '100%', marginTop: 10 }}>Save profile</button>
              </form>
            </div>
            <div className="cart">
              <h3>🖼️ Logo</h3>
              <p style={{ margin: '0 0 10px' }}><small>PNG, JPG, GIF, WebP or SVG · up to 2 MB.</small></p>
              {settings.logo_url ? (
                <img src={settings.logo_url} className="logo-preview" alt="store logo" />
              ) : (
                <div className="empty"><span className="big">🖼️</span>No logo yet — the ⚕️ mark is used.</div>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                <label className="ghost" style={{ cursor: 'pointer' }}>
                  ⬆️ Upload logo
                  <input type="file" accept="image/*,.svg" onChange={uploadLogoFile} style={{ display: 'none' }} />
                </label>
                {settings.logo_url && <button className="danger" onClick={removeLogo}>Remove</button>}
              </div>
            </div>
          </div>
        )}
        {tab === 'users' && (
          <div className={isAdmin ? 'cards' : ''}>
            {isAdmin && (
              <div>
                <h3 style={{ margin: '0 0 4px', color: 'var(--teal-900)' }}>User logins</h3>
                <table>
                  <thead><tr><th>#</th><th>Username</th><th>Role</th><th>Created</th><th></th></tr></thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td>{u.id}</td>
                        <td><b>{u.username}</b>{u.username === username && ' (you)'}</td>
                        <td>{u.is_admin ? <span className="pill tag">admin</span> : <span className="pill ok">staff</span>}</td>
                        <td><small>{u.created_at}</small></td>
                        <td className="no-print">
                          {u.username !== username && (
                            <button className="danger" onClick={() => removeUser(u.id, u.username)}>Remove</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div>
              {isAdmin && (
                <div className="cart" style={{ marginBottom: 16 }}>
                  <h3>➕ Add new user</h3>
                  <form onSubmit={addUser}>
                    <input placeholder="Username (min 3 chars)" value={userForm.username} onChange={(e) => setUserForm({ ...userForm, username: e.target.value })} style={{ width: '100%', marginBottom: 8 }} required />
                    <input type="password" placeholder="Password (min 4 chars)" value={userForm.password} onChange={(e) => setUserForm({ ...userForm, password: e.target.value })} style={{ width: '100%', marginBottom: 8 }} required />
                    <label className="row" style={{ fontSize: 14, marginBottom: 10 }}>
                      <input type="checkbox" checked={userForm.is_admin} onChange={(e) => setUserForm({ ...userForm, is_admin: e.target.checked })} />
                      Make admin (can manage users)
                    </label>
                    <button className="primary" type="submit" style={{ width: '100%' }}>Create user</button>
                  </form>
                </div>
              )}
              <div className="cart">
                <h3>🔑 My account — {username} {isAdmin ? <span className="pill tag">admin</span> : <span className="pill ok">staff</span>}</h3>
                <form onSubmit={changePwd}>
                  <input type="password" placeholder="Current password" value={pwdForm.current} onChange={(e) => setPwdForm({ ...pwdForm, current: e.target.value })} style={{ width: '100%', marginBottom: 8 }} required />
                  <input type="password" placeholder="New password" value={pwdForm.next} onChange={(e) => setPwdForm({ ...pwdForm, next: e.target.value })} style={{ width: '100%', marginBottom: 8 }} required />
                  <input type="password" placeholder="Confirm new password" value={pwdForm.confirm} onChange={(e) => setPwdForm({ ...pwdForm, confirm: e.target.value })} style={{ width: '100%', marginBottom: 8 }} required />
                  <button className="ghost" type="submit" style={{ width: '100%' }}>Change password</button>
                </form>
              </div>
            </div>
          </div>
        )}
      </main>
      <footer className="foot">MediCare Pharmacy · React + Python Flask + SQLite · All prices in ₹ INR</footer>
    </>
  );
}

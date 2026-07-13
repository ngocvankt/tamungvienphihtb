function formatDisplayDate(dateISO) {
  if (!dateISO) return '';
  const [y, m, d] = String(dateISO).split('-');
  if (y && m && d) return `${d}/${m}/${y}`;
  return String(dateISO);
}

const APP = {
  users: 'tuvp_users_v1',
  reports: 'tuvp_reports_v1',
  advances: 'tuvp_advances_v1',
  invoices: 'tuvp_invoices_v1',
  lostCases: 'tuvp_lost_cases_v1',
  refunds: 'tuvp_refunds_v1',
  settings: 'tuvp_settings_v1',
  session: 'tuvp_session_v1'
};

// Dữ liệu Firebase được lưu theo 1 nhánh riêng để dễ quản lý/nâng cấp.
const FIREBASE_ROOT = 'tamUngVienPhiApp/v1';
const FIREBASE_SYNC_KEYS = [
  APP.users,
  APP.reports,
  APP.advances,
  APP.invoices,
  APP.lostCases,
  APP.refunds,
  APP.settings
];

let firebaseSyncReady = false;
let firebaseSyncDisabled = false;

let currentUser = null;
let pendingChangeUser = null;
let activeTab = null;
let currentReport = emptyReport();
let selectedReceipt = null;
let currentLostCaseId = null;
let lostImagesBase64 = [];
let cashbookRows = [];
let recoveredReceiptRows = [];
let problemReceiptRows = [];
let receiptHistorySelected = new Set();
let lostReceiptHistorySelected = new Set();
let pendingPrintReport = null;
let pendingPreviewReport = null;
let periodModalMode = 'print';
let reportInputEnabled = false;

const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function emptyReport() {
  return {
    id: null,
    status: 'draft',
    advanceRows: [],
    invoiceRows: [],
    dateFrom: '',
    dateTo: '',
    reportDateISO: '',
    reportDate: '',
    refundAmount: 0,
    lostReceiptAmount: 0,
    cashFloat: 0,
    note: '',
    selectedRefundRowIds: [],
    selectedLostCaseIds: []
  };
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function firebaseAvailable() {
  return !firebaseSyncDisabled && typeof window !== 'undefined' && !!window.firebaseDb;
}

function sanitizeForFirebase(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function firebaseRef(path = '') {
  return window.firebaseDb.ref(path ? `${FIREBASE_ROOT}/${path}` : FIREBASE_ROOT);
}

async function pullAllFromFirebase() {
  if (!firebaseAvailable()) return false;
  try {
    const snap = await firebaseRef().once('value');
    const data = snap.val();
    if (!data || typeof data !== 'object') {
      firebaseSyncReady = true;
      return false;
    }

    FIREBASE_SYNC_KEYS.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        localStorage.setItem(key, JSON.stringify(data[key]));
      }
    });

    firebaseSyncReady = true;
    return true;
  } catch (err) {
    firebaseSyncDisabled = true;
    console.warn('Không đọc được dữ liệu Firebase, tạm dùng dữ liệu máy này:', err);
    return false;
  }
}

async function pushAllToFirebase() {
  if (!firebaseAvailable()) return false;
  const payload = {};
  FIREBASE_SYNC_KEYS.forEach(key => {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      try { payload[key] = JSON.parse(raw); }
      catch { /* bỏ qua dữ liệu lỗi */ }
    }
  });
  try {
    await firebaseRef().update(sanitizeForFirebase(payload));
    firebaseSyncReady = true;
    return true;
  } catch (err) {
    console.warn('Không đẩy được dữ liệu lên Firebase:', err);
    return false;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));

  // Session chỉ lưu trong trình duyệt, không đồng bộ lên Firebase.
  if (!FIREBASE_SYNC_KEYS.includes(key) || !firebaseAvailable()) return;

  firebaseRef(key)
    .set(sanitizeForFirebase(value))
    .catch(err => console.warn(`Không đồng bộ được ${key} lên Firebase:`, err));
}

window.firebasePullAllData = pullAllFromFirebase;
window.firebasePushAllLocalData = pushAllToFirebase;

function uid(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function nowISO() { return new Date().toISOString(); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function formatMoney(value) {
  const n = Number(value || 0);
  return n.toLocaleString('vi-VN');
}

function parseMoney(value) {
  if (typeof value === 'number') return Math.round(value);
  let s = String(value ?? '').trim();
  if (!s) return 0;
  s = s.replace(/[^\d,.-]/g, '');
  if (!s) return 0;

  // HIS/người dùng thường nhập tiền kiểu Việt Nam: 10.000.000.
  // Number('10.000.000') sẽ NaN, nên phải bỏ dấu chấm phân tách hàng nghìn trước.
  const dotCount = (s.match(/\./g) || []).length;
  const commaCount = (s.match(/,/g) || []).length;

  if (dotCount && commaCount) {
    // 1.234.567,89 -> 1234567.89
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (dotCount > 1) {
    // 10.000.000 -> 10000000
    s = s.replace(/\./g, '');
  } else if (commaCount > 1) {
    // 10,000,000 -> 10000000
    s = s.replace(/,/g, '');
  } else if (commaCount === 1 && /^\d{1,3},\d{3}$/.test(s)) {
    s = s.replace(',', '');
  } else if (dotCount === 1 && /^\d{1,3}\.\d{3}$/.test(s)) {
    s = s.replace('.', '');
  } else if (commaCount === 1) {
    s = s.replace(',', '.');
  }

  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function hashPassword(password) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const str = String(password ?? '');
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `h_${(h2 >>> 0).toString(16)}${(h1 >>> 0).toString(16)}`;
}

function showToast(message, type = '') {
  const toast = $('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`.trim();
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 3600);
}

function roleLabel(role) {
  return ({ admin: 'Admin', ketoan: 'Kế toán viên', thuquy: 'Thủ quỹ', truongphong: 'Trưởng phòng' })[role] || role;
}

function statusLabel(status) {
  return ({
    draft: 'Nháp',
    finalized: 'Đã chốt báo cáo',
    submitted: 'Đã gửi thủ quỹ',
    confirmed: 'Thủ quỹ đã xác nhận',
    rejected: 'Thủ quỹ trả lại',
    locked: 'Đã khóa',
    completed: 'Hoàn tất'
  })[status] || status;
}

function statusBadge(status) {
  return `<span class="status ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
}

function ensureDefaultData() {
  const users = loadJson(APP.users, []);
  if (!users.length) {
    users.push({
      id: uid('user'),
      username: 'admin',
      passwordHash: hashPassword('admin123'),
      fullName: 'Quản trị hệ thống',
      role: 'admin',
      hisCollectorName: '',
      isActive: true,
      mustChangePassword: true,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      lastLoginAt: null
    });
    saveJson(APP.users, users);
  }

  const settings = loadJson(APP.settings, null);
  if (!settings) {
    saveJson(APP.settings, { unitName: 'Trung tâm Y tế khu vực Hàm Thuận Bắc' });
  }
}

function setSession(user) {
  sessionStorage.setItem(APP.session, user.id);
}

function clearSession() {
  sessionStorage.removeItem(APP.session);
}

function getUsers() { return loadJson(APP.users, []); }
function setUsers(users) { saveJson(APP.users, users); }
function getReports() { return loadJson(APP.reports, []); }
function setReports(items) { saveJson(APP.reports, items); }
function getAdvances() { return loadJson(APP.advances, []); }
function setAdvances(items) { saveJson(APP.advances, items); }
function getInvoices() { return loadJson(APP.invoices, []); }
function setInvoices(items) { saveJson(APP.invoices, items); }
function getLostCases() { return loadJson(APP.lostCases, []); }
function setLostCases(items) { saveJson(APP.lostCases, items); }
function getRefunds() { return loadJson(APP.refunds, []); }
function setRefunds(items) { saveJson(APP.refunds, items); }

function readSession() {
  const id = sessionStorage.getItem(APP.session);
  if (!id) return null;
  return getUsers().find(u => u.id === id && u.isActive) || null;
}

function showLogin() {
  currentUser = null;
  $('loginView').classList.remove('hidden');
  $('appView').classList.add('hidden');
  $('loginForm').classList.remove('hidden');
  $('firstPasswordBox').classList.add('hidden');
}

function showForcePassword(user) {
  pendingChangeUser = user;
  $('loginForm').classList.add('hidden');
  $('firstPasswordBox').classList.remove('hidden');
  $('cpCurrent').value = '';
  $('cpNew').value = '';
  $('cpConfirm').value = '';
  $('cpCurrent').focus();
}

function showApp() {
  currentUser = readSession();
  if (!currentUser) return showLogin();

  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('currentUserText').textContent = currentUser.fullName || currentUser.username;
  $('currentRoleText').textContent = roleLabel(currentUser.role);

  const settings = loadJson(APP.settings, {});
  $('unitNameText').textContent = settings.unitName || 'Trung tâm Y tế khu vực Hàm Thuận Bắc';
  buildTabs();
  refreshAll();
}

function login() {
  const username = normalizeText($('loginUsername').value);
  const password = $('loginPassword').value;
  const users = getUsers();
  const user = users.find(u => normalizeText(u.username) === username);

  if (!user || user.passwordHash !== hashPassword(password)) {
    return showToast('Tên đăng nhập hoặc mật khẩu không đúng.', 'error');
  }
  if (!user.isActive) return showToast('Tài khoản đã bị khóa.', 'error');

  user.lastLoginAt = nowISO();
  setUsers(users);

  if (user.mustChangePassword) return showForcePassword(user);
  setSession(user);
  showApp();
}

function validatePasswordChange(user, currentPw, newPw, confirmPw) {
  if (!user) return 'Không tìm thấy tài khoản.';
  if (user.passwordHash !== hashPassword(currentPw)) return 'Mật khẩu hiện tại không đúng.';
  if (!newPw || newPw.length < 6) return 'Mật khẩu mới phải có tối thiểu 6 ký tự.';
  if (newPw !== confirmPw) return 'Hai lần nhập mật khẩu mới không khớp.';
  if (hashPassword(newPw) === user.passwordHash) return 'Mật khẩu mới không được trùng mật khẩu cũ.';
  return '';
}

function changePasswordForUser(userId, currentPw, newPw, confirmPw, loginAfter = false) {
  const users = getUsers();
  const user = users.find(u => u.id === userId);
  const err = validatePasswordChange(user, currentPw, newPw, confirmPw);
  if (err) return showToast(err, 'error');

  user.passwordHash = hashPassword(newPw);
  user.mustChangePassword = false;
  user.updatedAt = nowISO();
  setUsers(users);

  if (loginAfter) {
    setSession(user);
    pendingChangeUser = null;
    showToast('Đổi mật khẩu thành công.');
    showApp();
  } else {
    showToast('Đổi mật khẩu thành công. Vui lòng đăng nhập lại.');
    closePasswordModal();
    clearSession();
    showLogin();
  }
}

function buildTabs() {
  const defs = [
    { id: 'tabReport', label: '1. Báo cáo nộp tiền', roles: ['admin', 'ketoan', 'thuquy', 'truongphong'] },
    { id: 'tabLost', label: '2. Xử lý mất phiếu', roles: ['admin', 'ketoan', 'thuquy', 'truongphong'] },
    { id: 'tabTreasurer', label: '3. Thủ quỹ', roles: ['admin', 'thuquy', 'truongphong'] },
    { id: 'tabUsers', label: 'Quản lý tài khoản', roles: ['admin'] }
  ];
  const allowed = defs.filter(t => t.roles.includes(currentUser.role));
  $('tabs').innerHTML = allowed.map(t => `<button class="tab-btn" data-tab="${t.id}">${t.label}</button>`).join('');
  $$('.tab-panel').forEach(panel => panel.classList.add('hidden'));
  if (!allowed.some(t => t.id === activeTab)) activeTab = allowed[0]?.id;
  setActiveTab(activeTab);
}

function setActiveTab(tabId) {
  activeTab = tabId;
  $$('.tab-panel').forEach(panel => panel.classList.toggle('hidden', panel.id !== tabId));
  $$('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
}

function refreshAll() {
  renderReportTables();
  renderMyReports();
  renderLostCases();
  renderTreasurerReports();
  renderTreasurerLostCases();
  renderUsers();
  renderSettings();
  renderProblemReceipts();
  setDefaultDates();
  applyRoleControls();
}

function setDefaultDates() {
  const today = todayISO();
  ['refundDate', 'cashbookFrom', 'cashbookTo', 'lostProcessDate'].forEach(id => {
    const el = $(id);
    if (el && !el.value) el.value = today;
  });
}

function applyRoleControls() {
  const isKetoanLike = ['admin', 'ketoan'].includes(currentUser.role);
  ['btnBuildReport', 'btnFinalizeReport', 'btnPreviewReport', 'btnSubmitReport'].forEach(id => {
    const el = $(id); if (el) el.disabled = !isKetoanLike;
  });
  ['advanceFile', 'invoiceFile', 'btnReadAdvance', 'btnReadInvoice', 'btnClearAdvanceFile', 'btnClearInvoiceFile'].forEach(id => {
    const el = $(id); if (el) el.disabled = !isKetoanLike || !reportInputEnabled;
  });
  ['btnSaveLostCase'].forEach(id => {
    const el = $(id); if (el) el.disabled = !isKetoanLike;
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function getCell(ws, r, c) {
  const direct = ws[XLSX.utils.encode_cell({ r, c })];
  if (direct && direct.v !== undefined && direct.v !== null && String(direct.v).trim() !== '') return direct.v;
  const merges = ws['!merges'] || [];
  const m = merges.find(x => r >= x.s.r && r <= x.e.r && c >= x.s.c && c <= x.e.c);
  if (m) {
    const top = ws[XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c })];
    if (top && top.v !== undefined && top.v !== null) return top.v;
  }
  return '';
}

function cellText(ws, r, c) {
  const v = getCell(ws, r, c);
  if (v instanceof Date) return formatDate(v);
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function concatCells(ws, r, cols) {
  const parts = [];
  cols.forEach(c => {
    const text = cellText(ws, r, c);
    if (text && !parts.some(p => normalizeText(p) === normalizeText(text))) parts.push(text);
  });
  return parts.join(' ').trim();
}

function cellMoney(ws, r, cols) {
  for (const c of cols) {
    const n = parseMoney(getCell(ws, r, c));
    if (n) return n;
  }
  return 0;
}


function rawCellText(ws, r, c) {
  const v = getCell(ws, r, c);
  if (v instanceof Date) return formatDate(v);
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function rowText(ws, r, cols) {
  return cols.map(c => rawCellText(ws, r, c)).filter(Boolean).join(' ');
}

function rowAllText(ws, r, range) {
  const maxCol = Math.max(range?.e?.c ?? 0, 25);
  const cols = Array.from({ length: maxCol + 1 }, (_, i) => i);
  return rowText(ws, r, cols);
}

function isHisMetaOrTotalRow(text) {
  const n = normalizeText(text);
  if (!n) return false;
  return (
    n.includes('tu ngay') ||
    n.includes('den ngay') ||
    n.includes('ngay bao cao') ||
    n.includes('tong cong') ||
    n.includes('tong tien') ||
    n.includes('tong so') ||
    n === 'tong' ||
    n === 'cong' ||
    n.includes('nguoi lap bang') ||
    n.includes('nguoi lap bieu') ||
    n.includes('ke toan') ||
    n.includes('thu quy')
  );
}

function isTotalLikeText(value) {
  const n = normalizeText(value);
  if (!n) return false;
  return n.includes('tong cong') || n.includes('tong tien') || n.includes('tong so') || n === 'tong' || n === 'cong';
}

function isValidHisNumber(value) {
  const s = String(value ?? '').trim();
  if (!s) return false;
  if (isHisMetaOrTotalRow(s)) return false;
  // Số hóa đơn/số biên lai HIS thường là chuỗi số. Có thể kèm ký tự phân tách khi HIS thay mẫu.
  return /\d{2,}/.test(s) && /^[0-9A-Za-z\-\/.]+$/.test(s.replace(/\s+/g, ''));
}

function isValidReportDateISO(iso) {
  if (!iso) return false;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]);
  return y >= 2000 && y <= 2100;
}

function cellMoneyStrict(ws, r, cols) {
  for (const c of cols) {
    const text = rawCellText(ws, r, c);
    if (!text) continue;
    if (isHisMetaOrTotalRow(text)) continue;
    if (!isMoneyLikeCellValue(getCell(ws, r, c), text)) continue;
    const n = parseMoney(getCell(ws, r, c));
    if (n) return n;
  }
  return 0;
}

function isMoneyLikeCellValue(value, text = '') {
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 1000;
  const s = String(text || value || '').trim();
  if (!s) return false;
  if (isHisMetaOrTotalRow(s)) return false;
  // Chỉ nhận ô tiền thuần số. Không nhận chuỗi có mã TN/BN/BHYT vì parseMoney sẽ kéo nhầm số trong chuỗi đó.
  if (/[A-Za-zÀ-ỹ]/.test(s)) return false;
  if (!/[0-9]/.test(s)) return false;
  if (!/^[\s\d.,()\-]+$/.test(s)) return false;
  return parseMoney(s) >= 1000;
}

function findMoneyCellInRow(ws, r, cols) {
  for (const c of cols) {
    const text = rawCellText(ws, r, c);
    const value = getCell(ws, r, c);
    if (!isMoneyLikeCellValue(value, text)) continue;
    const n = parseMoney(value);
    if (n) return { amount: n, col: c };
  }
  return { amount: 0, col: -1 };
}

function concatCleanCells(ws, r, cols, options = {}) {
  const parts = [];
  cols.forEach(c => {
    const text = rawCellText(ws, r, c);
    if (!text) return;
    if (options.skipMoney && isMoneyLikeCellValue(getCell(ws, r, c), text)) return;
    if (options.skipMeta && isHisMetaOrTotalRow(text)) return;
    if (options.skipPerson && looksLikeHumanName(text)) return;
    if (!parts.some(p => normalizeText(p) === normalizeText(text))) parts.push(text);
  });
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function looksLikeHumanName(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const n = normalizeText(text);
  if (!n) return false;
  if (/\d/.test(text)) return false;
  if (text.length < 5 || text.length > 60) return false;
  const blocked = [
    'khoa', 'phong', 'benh vien', 'trung tam', 'tam ung', 'vien phi', 'bhyt', 'noi dung',
    'gioi tinh', 'tuoi', 'nam', 'nu', 'tong', 'cong', 'so tien', 'phieu thu', 'hoa don',
    'nguoi thu', 'nguoi phat hanh', 'ngay thu', 'ngay thanh toan', 'cap cuu'
  ];
  if (blocked.some(x => n.includes(x))) return false;
  const words = text.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 6) return false;
  return /^[A-Za-zÀ-ỹ\s'.-]+$/.test(text);
}

function findAssignedUserNameInText(text) {
  const n = normalizeText(text);
  if (!n) return '';
  const candidates = getUsers()
    .flatMap(u => [u.hisCollectorName, u.fullName])
    .filter(Boolean)
    .map(x => String(x).trim())
    .filter(x => normalizeText(x) && normalizeText(x) !== 'quan tri he thong');
  const hit = candidates.find(name => n === normalizeText(name) || n.includes(normalizeText(name)));
  return hit || '';
}

function findCollectorInAdvanceRow(ws, r, range, amountCol) {
  const maxCol = Math.max(range?.e?.c ?? 0, 25);
  const preferredStart = amountCol >= 0 ? amountCol + 1 : 12;
  const candidates = [];

  // Ưu tiên dò từ sau cột số tiền trở đi vì các file HIS có thể chèn thêm cột nội dung trước cột người thu.
  for (let c = preferredStart; c <= maxCol; c++) {
    const text = rawCellText(ws, r, c);
    if (!text) continue;
    if (isMoneyLikeCellValue(getCell(ws, r, c), text) || isHisMetaOrTotalRow(text)) continue;
    const assigned = findAssignedUserNameInText(text);
    if (assigned) return assigned;
    if (looksLikeHumanName(text)) candidates.push(text);
  }

  // Nếu chưa thấy, dò lại toàn bộ dòng để bắt trường hợp HIS đổi vị trí cột người thu.
  for (let c = 0; c <= maxCol; c++) {
    const text = rawCellText(ws, r, c);
    if (!text) continue;
    const assigned = findAssignedUserNameInText(text);
    if (assigned) return assigned;
  }

  const clean = candidates.find(x => {
    const n = normalizeText(x);
    return !n.includes('benh nhan') && !n.includes('nguoi nop') && !n.includes('huyet ap');
  });
  return clean || '';
}

function findAdvanceHeaderRow(ws, range) {
  for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 80); r++) {
    const text = normalizeText(rowAllText(ws, r, range));
    if (text.includes('ngay thu') && text.includes('phieu thu') && text.includes('ho va ten')) return r;
  }
  return -1;
}

function findHeaderCol(ws, headerRow, keywords, fallbackCol) {
  if (headerRow < 0) return fallbackCol;
  const maxCol = 35;
  const keys = keywords.map(k => normalizeText(k));
  for (let c = 0; c <= maxCol; c++) {
    const text = normalizeText(rawCellText(ws, headerRow, c));
    if (!text) continue;
    if (keys.every(k => text.includes(k))) return c;
  }
  return fallbackCol;
}

function buildAdvanceColumnMap(ws, range) {
  const headerRow = findAdvanceHeaderRow(ws, range);
  const dateCol = findHeaderCol(ws, headerRow, ['ngay thu'], 1);       // B
  const receiptCol = findHeaderCol(ws, headerRow, ['phieu thu'], 2);   // C
  const patientCol = findHeaderCol(ws, headerRow, ['ho va ten'], 4);   // E
  const ageCol = findHeaderCol(ws, headerRow, ['tuoi'], 5);            // F
  const genderCol = findHeaderCol(ws, headerRow, ['gioi tinh'], 8);    // I
  const departmentCol = findHeaderCol(ws, headerRow, ['khoa'], 10);    // K
  const amountCol = findHeaderCol(ws, headerRow, ['so tien'], 12);     // M, fallback mẫu cũ
  const collectorCol = findHeaderCol(ws, headerRow, ['nguoi thu'], 14);// O, fallback mẫu cũ
  return { headerRow, dateCol, receiptCol, patientCol, ageCol, genderCol, departmentCol, amountCol, collectorCol };
}

function readMergedPairText(ws, r, startCol, width = 2, options = {}) {
  const cols = Array.from({ length: width }, (_, i) => startCol + i);
  return concatCleanCells(ws, r, cols, options);
}

function readAdvanceAmount(ws, r, cols) {
  const primary = cellMoneyStrict(ws, r, [cols.amountCol, cols.amountCol + 1]);
  if (primary) return primary;
  // Fallback cho các file HIS cũ/lạ: chỉ dò trong khu vực lân cận, không kéo số trong cột lý do.
  const fallbackCols = [12, 13, 11, 10, 14];
  return cellMoneyStrict(ws, r, fallbackCols);
}

function readAdvanceCollector(ws, r, range, cols) {
  const direct = readMergedPairText(ws, r, cols.collectorCol, 2, { skipMeta: true });
  if (direct && !isMoneyLikeCellValue(direct, direct) && !isTotalLikeText(direct)) return direct;
  return findCollectorInAdvanceRow(ws, r, range, cols.amountCol);
}

function formatDate(value) {
  if (!value) return '';
  if (value instanceof Date && !isNaN(value)) {
    return `${String(value.getDate()).padStart(2, '0')}/${String(value.getMonth() + 1).padStart(2, '0')}/${value.getFullYear()}`;
  }
  if (typeof value === 'number' && window.XLSX) {
    try { return XLSX.SSF.format('dd/mm/yyyy', value); } catch { return String(value); }
  }
  const text = String(value).trim();
  const iso = parseDateToISO(text);
  if (iso) {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }
  return text;
}

function parseDateToISO(value) {
  if (!value) return '';
  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && window.XLSX) {
    const d = XLSX.SSF.parse_date_code(value);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return '';
}

function nameMatchesHis(name) {
  if (currentUser.role === 'admin' && !currentUser.hisCollectorName) return true;
  const assigned = normalizeText(currentUser.hisCollectorName || currentUser.fullName || currentUser.username);
  const actual = normalizeText(name);
  return actual && assigned && actual === assigned;
}

async function readWorkbookFromInput(inputId) {
  const file = $(inputId).files[0];
  if (!file) throw new Error('Chưa chọn file Excel.');
  if (!window.XLSX) throw new Error('Chưa tải được thư viện đọc Excel. Kiểm tra internet/CDN hoặc tải SheetJS về chạy offline.');
  const buffer = await readFileAsArrayBuffer(file);
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) throw new Error('Không đọc được sheet đầu tiên trong file.');
  return { wb, ws };
}

async function importAdvanceFile() {
  try {
    const { ws } = await readWorkbookFromInput('advanceFile');
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows = [];
    let skipped = 0;
    let duplicateCount = 0;
    const duplicateNos = [];
    const existingAdvanceKeys = buildExistingAdvanceKeysForUpload();
    const fileAdvanceKeys = new Set();
    const cols = buildAdvanceColumnMap(ws, range);

    for (let r = range.s.r; r <= range.e.r; r++) {
      if (cols.headerRow >= 0 && r <= cols.headerRow) continue;

      const allRowText = rowAllText(ws, r, range);
      const normalizedAllRow = normalizeText(allRowText);

      // Chỉ lấy dòng chi tiết có SỐ PHIẾU THU hợp lệ. Các dòng không có số phiếu thu bỏ qua.
      if (normalizedAllRow.includes('tong cong') || normalizedAllRow.includes('tong tien') || normalizedAllRow.includes('tong so')) {
        if (rows.length) break;
        continue;
      }
      if (isHisMetaOrTotalRow(allRowText)) continue;

      const receiptNo = cellText(ws, r, cols.receiptCol); // cột Phiếu thu theo tiêu đề HIS
      if (!receiptNo) continue;
      if (!isValidHisNumber(receiptNo)) { skipped++; continue; }

      const dateRaw = getCell(ws, r, cols.dateCol);
      const date = formatDate(dateRaw);
      const dateISO = parseDateToISO(dateRaw || date);
      const patientName = cellText(ws, r, cols.patientCol);
      const age = readMergedPairText(ws, r, cols.ageCol, 3, { skipMeta: true });
      const gender = readMergedPairText(ws, r, cols.genderCol, 2, { skipMeta: true });
      const department = readMergedPairText(ws, r, cols.departmentCol, 2, { skipMoney: true, skipMeta: true });
      const amount = readAdvanceAmount(ws, r, cols);
      const collector = readAdvanceCollector(ws, r, range, cols);

      const fullRowText = rowText(ws, r, Array.from({ length: Math.max(range.e.c + 1, 26) }, (_, i) => i));
      const normalizedRow = normalizeText(fullRowText);
      const looksHeader =
        normalizedRow.includes('ngay thu') ||
        normalizedRow.includes('phieu thu') ||
        normalizedRow.includes('ho va ten') ||
        normalizedRow.includes('nguoi thu') ||
        normalizedRow.includes('khoa phong') ||
        isTotalLikeText(normalizedRow);
      if (looksHeader) continue;

      if (isTotalLikeText(patientName) || isTotalLikeText(collector) || isTotalLikeText(allRowText)) {
        if (rows.length) break;
        skipped++;
        continue;
      }

      // Lọc theo người thu được gán với tài khoản để báo cáo không lẫn người khác.
      if (collector && !nameMatchesHis(collector)) { skipped++; continue; }
      if (!collector && currentUser.role !== 'admin') { skipped++; continue; }

      const advanceRow = {
        id: uid('adv'),
        date,
        dateISO,
        receiptNo,
        patientName,
        age,
        gender,
        department,
        amount,
        collector,
        sourceRow: r + 1
      };

      const rowKey = receiptNoKey(advanceRow.receiptNo);
      // Chỉ bỏ trùng ngay trong chính file đang upload. Nếu biên lai đã có trong hệ thống
      // thì vẫn cho đưa vào báo cáo hiện tại để kế toán viên lập/in báo cáo được,
      // đồng thời cảnh báo để người dùng biết. Khi lưu, kho dữ liệu sẽ cập nhật theo key,
      // không nhân đôi biên lai trong danh mục chung.
      if (fileAdvanceKeys.has(rowKey)) {
        duplicateCount++;
        if (duplicateNos.length < 10) duplicateNos.push(receiptNo);
        continue;
      }
      if (existingAdvanceKeys.has(rowKey)) {
        duplicateCount++;
        if (duplicateNos.length < 10) duplicateNos.push(receiptNo);
      }
      fileAdvanceKeys.add(rowKey);
      rows.push(advanceRow);
    }

    currentReport.advanceRows = rows;
    $('advanceImportSummary').textContent = duplicateCount
      ? `Thành công. Có ${duplicateCount} biên lai trùng/đã có trên hệ thống${duplicateNos.length ? ': ' + duplicateNos.join(', ') : ''}.`
      : 'Thành công';
    renderReportTables();
    updateReportTotals();
    showToast(duplicateCount ? `Thành công. Có ${duplicateCount} biên lai trùng/đã có trên hệ thống.` : 'Thành công', duplicateCount ? 'warn' : '');
  } catch (err) {
    showToast(err.message || 'Không đọc được file thu tạm ứng.', 'error');
  }
}

async function importInvoiceFile() {
  try {
    const { ws } = await readWorkbookFromInput('invoiceFile');
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows = [];
    let skipped = 0;

    for (let r = range.s.r; r <= range.e.r; r++) {
      const allRowText = rowAllText(ws, r, range);
      const normalizedAllRow = normalizeText(allRowText);

      // File HĐĐT của HIS thường có dòng điều kiện lọc, tiêu đề, chữ ký và dòng Tổng cộng.
      // Quan trọng: gặp dòng Tổng cộng ở cuối bảng thì dừng đọc, không lấy số tiền tổng vào dữ liệu chi tiết.
      if (normalizedAllRow.includes('tong cong') || normalizedAllRow === 'cong') {
        if (rows.length) break;
        continue;
      }
      if (isHisMetaOrTotalRow(allRowText)) continue;

      const invoiceNo = cellText(ws, r, 12);       // Cột M
      const patientName = cellText(ws, r, 3);      // Cột D
      const amount = cellMoneyStrict(ws, r, [5]);  // Cột F
      const dateRaw = getCell(ws, r, 7);           // Cột H
      const paymentDate = formatDate(dateRaw);
      const paymentDateISO = parseDateToISO(dateRaw || paymentDate);
      const issuer = cellText(ws, r, 11);          // Cột L
      const fullRowText = rowText(ws, r, [3, 5, 7, 11, 12]);
      const normalizedRow = normalizeText(fullRowText);

      const looksHeader =
        normalizedRow.includes('so hddt') ||
        normalizedRow.includes('so hoa don') ||
        normalizedRow.includes('ten benh nhan') ||
        normalizedRow.includes('nguoi phat hanh') ||
        normalizedRow.includes('ngay thanh toan') ||
        isTotalLikeText(normalizedRow);
      if (looksHeader) continue;

      if (!invoiceNo && !patientName && !amount) continue;

      // Chỉ nhận dòng chi tiết thật sự: có số hóa đơn/số biên lai hợp lệ.
      // Bỏ các dòng tổng tiền/tổng cộng dù HIS có đẩy số tổng sang cột Số HĐĐT hoặc Người phát hành.
      if (!isValidHisNumber(invoiceNo)) { skipped++; continue; }
      if (isTotalLikeText(patientName) || isTotalLikeText(issuer) || isTotalLikeText(allRowText)) {
        if (rows.length) break;
        skipped++;
        continue;
      }

      // Dòng hợp lệ phải có đủ: số HĐĐT, tên bệnh nhân, ngày thanh toán hợp lệ, số tiền và người phát hành đúng tài khoản.
      if (!patientName || !isValidReportDateISO(paymentDateISO) || !amount || !issuer) { skipped++; continue; }
      if (!nameMatchesHis(issuer)) { skipped++; continue; }

      rows.push({
        id: uid('inv'),
        invoiceNo,
        patientName,
        amount,
        paymentDate,
        paymentDateISO,
        issuer,
        sourceRow: r + 1
      });
    }

    currentReport.invoiceRows = rows;
    $('invoiceImportSummary').textContent = 'Thành công';
    renderReportTables();
    updateReportTotals();
    showToast('Thành công');
  } catch (err) {
    showToast(err.message || 'Lỗi đọc file HĐĐT.', 'error');
  }
}

function getFilteredRows(rows, searchId) {
  const q = normalizeText($(searchId)?.value || '');
  if (!q) return rows;
  return rows.filter(row => normalizeText(Object.values(row).join(' ')).includes(q));
}

function renderTable(tableId, headers, rows, rowHtml, emptyText = 'Chưa có dữ liệu.') {
  const table = $(tableId);
  if (!rows.length) {
    table.innerHTML = `<thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${headers.length}" class="muted">${escapeHtml(emptyText)}</td></tr></tbody>`;
    return;
  }
  table.innerHTML = `<thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row, index) => rowHtml(row, index)).join('')}</tbody>`;
}


function setTableFooter(tableId, html) {
  const table = $(tableId);
  if (!table) return;
  const old = table.querySelector('tfoot');
  if (old) old.remove();
  table.insertAdjacentHTML('beforeend', `<tfoot>${html}</tfoot>`);
}

function statusRank(status) {
  return ({ finalized: 1, submitted: 2, confirmed: 3, locked: 4, completed: 5 })[status] || 0;
}

function getReceiptHistoryRows() {
  // Lấy TẤT CẢ biên lai tạm ứng đã có trong hệ thống:
  // 1) Dữ liệu đang hiển thị trên màn hình hiện tại.
  // 2) Kho biên lai đã lưu khi upload/lưu báo cáo.
  // 3) Các báo cáo đã lập trước đó, không phụ thuộc trạng thái.
  // Dùng key theo số phiếu + bệnh nhân + ngày để tìm kiếm ổn định và tránh trùng dòng.
  const map = new Map();

  function pushReceipt(item, sourceRank, sourceTime = '') {
    if (!item || !item.receiptNo) return;
    const key = advanceKey(item);
    if (!key) return;
    const existing = map.get(key);
    const row = {
      id: key,
      date: item.date || '',
      dateISO: item.dateISO || parseDateToISO(item.date),
      receiptNo: item.receiptNo || '',
      patientName: item.patientName || '',
      age: item.age || '',
      gender: item.gender || '',
      department: item.department || '',
      amount: Number(item.amount || 0),
      collector: item.collector || '',
      sortKey: `${sourceRank}|${sourceTime}|${item.dateISO || item.date || ''}|${item.receiptNo || ''}`
    };
    if (!existing || String(row.sortKey).localeCompare(String(existing.sortKey)) > 0) {
      map.set(key, row);
    }
  }

  (currentReport.advanceRows || []).forEach(item => pushReceipt(item, 9, 'current'));

  getAdvances().forEach(item => {
    pushReceipt(item, 8, item.updatedAt || item.createdAt || item.sourceReportId || 'saved');
  });

  getReports().forEach(report => {
    (report.advanceRows || []).forEach(item => {
      const rank = report.status === 'confirmed' ? 7 : report.status === 'submitted' ? 6 : 5;
      pushReceipt(item, rank, report.submittedAt || report.createdAt || report.updatedAt || 'report');
    });
  });

  return Array.from(map.values()).sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));
}

function receiptHistoryMatches(row, q) {
  if (!q) return true;
  return normalizeText([
    row.date,
    row.receiptNo,
    row.patientName,
    row.age,
    row.gender,
    row.department,
    row.amount,
    row.collector
  ].join(' ')).includes(q);
}

function getVisibleReceiptHistoryRows() {
  const q = normalizeText($('receiptHistorySearch')?.value || '');
  return getReceiptHistoryRows().filter(r => receiptHistoryMatches(r, q));
}

function updateReceiptHistorySelectedTotal() {
  const allRows = getReceiptHistoryRows();
  const total = allRows
    .filter(r => receiptHistorySelected.has(r.id))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  if ($('receiptHistoryTotal')) $('receiptHistoryTotal').textContent = formatMoney(total);

  const visibleRows = getVisibleReceiptHistoryRows();
  const selectAll = $('receiptSelectAll');
  if (selectAll) {
    const visibleIds = visibleRows.map(r => r.id);
    const selectedVisible = visibleIds.filter(id => receiptHistorySelected.has(id)).length;
    selectAll.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  }
}

function renderReceiptHistory() {
  const rows = getVisibleReceiptHistoryRows();
  const table = $('receiptHistoryTable');
  if (!table) return;

  const headers = [
    '<input type="checkbox" id="receiptSelectAll" title="Chọn tất cả dòng đang hiển thị">',
    'Ngày thu', 'Phiếu thu', 'Họ tên', 'Tuổi', 'Giới tính', 'Khoa/phòng', 'Số tiền', 'Người thu'
  ];

  if (!rows.length) {
    table.innerHTML = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${headers.length}" class="muted">Chưa có biên lai tạm ứng trong hệ thống.</td></tr></tbody>`;
    updateReceiptHistorySelectedTotal();
    return;
  }

  table.innerHTML = `
    <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows.map(r => `
        <tr>
          <td class="center narrow"><input type="checkbox" class="receipt-pick" data-id="${escapeHtml(r.id)}" ${receiptHistorySelected.has(r.id) ? 'checked' : ''}></td>
          <td>${escapeHtml(r.date)}</td>
          <td>${escapeHtml(r.receiptNo)}</td>
          <td>${escapeHtml(r.patientName)}</td>
          <td>${escapeHtml(r.age)}</td>
          <td>${escapeHtml(r.gender)}</td>
          <td>${escapeHtml(r.department)}</td>
          <td class="money">${formatMoney(r.amount)}</td>
          <td>${escapeHtml(r.collector)}</td>
        </tr>`).join('')}
    </tbody>
    <tfoot><tr><th colspan="7" style="text-align:right">Tổng tiền đã chọn</th><th class="money" id="receiptHistoryFooterTotal">0</th><th></th></tr></tfoot>`;

  table.querySelectorAll('.receipt-pick').forEach(chk => {
    chk.addEventListener('change', e => {
      const id = e.target.dataset.id;
      if (e.target.checked) receiptHistorySelected.add(id);
      else receiptHistorySelected.delete(id);
      updateReceiptHistorySelectedTotal();
      const footer = $('receiptHistoryFooterTotal');
      if (footer) footer.textContent = $('receiptHistoryTotal')?.textContent || '0';
    });
  });

  const selectAll = $('receiptSelectAll');
  if (selectAll) {
    selectAll.addEventListener('change', e => {
      rows.forEach(r => {
        if (e.target.checked) receiptHistorySelected.add(r.id);
        else receiptHistorySelected.delete(r.id);
      });
      renderReceiptHistory();
    });
  }

  updateReceiptHistorySelectedTotal();
  const footer = $('receiptHistoryFooterTotal');
  if (footer) footer.textContent = $('receiptHistoryTotal')?.textContent || '0';
}

function openReceiptHistoryModal() {
  const modal = $('receiptModal');
  if (!modal) return;
  receiptHistorySelected = new Set(currentReport.selectedRefundRowIds || []);
  modal.classList.remove('hidden');
  if ($('receiptHistorySearch')) $('receiptHistorySearch').value = '';
  renderReceiptHistory();
}

function closeReceiptHistoryModal() {
  const modal = $('receiptModal');
  if (modal) modal.classList.add('hidden');
}

function useReceiptHistoryTotal() {
  const total = getReceiptHistoryRows()
    .filter(r => receiptHistorySelected.has(r.id))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  if (!total) return showToast('Chưa tích chọn biên lai thu hồi tạm ứng.', 'error');
  currentReport.selectedRefundRowIds = Array.from(receiptHistorySelected);
  currentReport.reportDateISO = currentReport.reportDateISO || todayISO();
  currentReport.reportDate = currentReport.reportDate || formatPrintDate(currentReport.reportDateISO);
  const lostAmount = parseMoney($('lostReceiptAmount').value);
  $('refundAmount').value = formatMoney(total + lostAmount);
  updateReportTotals();
  closeReceiptHistoryModal();
  showToast('Đã lấy tổng tiền biên lai được chọn vào ô tạm ứng thu hồi.');
}


function getLostReceiptHistoryRows() {
  const validStatuses = new Set(['confirmed', 'completed']);
  return getLostCases()
    .filter(item => validStatuses.has(item.status))
    .map(item => ({
      id: item.id,
      processDate: item.processDate || (item.updatedAt || item.createdAt || '').slice(0, 10),
      receiptNo: item.receiptNo || '',
      patientName: item.patientName || '',
      age: item.age || '',
      department: item.department || '',
      amount: Number(item.amount || 0),
      requester: item.requester || '',
      sortKey: `${item.processDate || ''}|${item.updatedAt || item.createdAt || ''}|${item.receiptNo || ''}`
    }))
    .sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));
}

function getVisibleLostReceiptHistoryRows() {
  const q = normalizeText($('lostReceiptHistorySearch')?.value || '');
  const rows = getLostReceiptHistoryRows();
  if (!q) return rows;
  return rows.filter(r => normalizeText([r.processDate, r.receiptNo, r.patientName, r.age, r.department, r.amount, r.requester].join(' ')).includes(q));
}

function updateLostReceiptHistorySelectedTotal() {
  const allRows = getLostReceiptHistoryRows();
  const total = allRows
    .filter(r => lostReceiptHistorySelected.has(r.id))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  if ($('lostReceiptHistoryTotal')) $('lostReceiptHistoryTotal').textContent = formatMoney(total);

  const visibleRows = getVisibleLostReceiptHistoryRows();
  const selectAll = $('lostReceiptSelectAll');
  if (selectAll) {
    const visibleIds = visibleRows.map(r => r.id);
    const selectedVisible = visibleIds.filter(id => lostReceiptHistorySelected.has(id)).length;
    selectAll.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  }
}

function renderLostReceiptHistory() {
  const rows = getVisibleLostReceiptHistoryRows();
  const table = $('lostReceiptHistoryTable');
  if (!table) return;

  const headers = [
    '<input type="checkbox" id="lostReceiptSelectAll" title="Chọn tất cả dòng đang hiển thị">',
    'Ngày xử lý', 'Phiếu thu', 'Họ tên', 'Tuổi', 'Khoa/phòng', 'Số tiền'
  ];

  if (!rows.length) {
    table.innerHTML = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${headers.length}" class="muted">Chưa có hồ sơ mất phiếu phù hợp.</td></tr></tbody>`;
    updateLostReceiptHistorySelectedTotal();
    return;
  }

  table.innerHTML = `
    <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows.map(r => `
        <tr>
          <td class="center narrow"><input type="checkbox" class="lost-receipt-pick" data-id="${escapeHtml(r.id)}" ${lostReceiptHistorySelected.has(r.id) ? 'checked' : ''}></td>
          <td>${escapeHtml(r.processDate ? new Date(r.processDate).toLocaleDateString('vi-VN') : '')}</td>
          <td>${escapeHtml(r.receiptNo)}</td>
          <td>${escapeHtml(r.patientName)}</td>
          <td>${escapeHtml(r.age)}</td>
          <td>${escapeHtml(r.department)}</td>
          <td class="money">${formatMoney(r.amount)}</td>
        </tr>`).join('')}
    </tbody>
    <tfoot><tr><th colspan="6" style="text-align:right">Tổng tiền đã chọn</th><th class="money" id="lostReceiptHistoryFooterTotal">0</th></tr></tfoot>`;

  table.querySelectorAll('.lost-receipt-pick').forEach(chk => {
    chk.addEventListener('change', e => {
      const id = e.target.dataset.id;
      if (e.target.checked) lostReceiptHistorySelected.add(id);
      else lostReceiptHistorySelected.delete(id);
      updateLostReceiptHistorySelectedTotal();
      const footer = $('lostReceiptHistoryFooterTotal');
      if (footer) footer.textContent = $('lostReceiptHistoryTotal')?.textContent || '0';
    });
  });

  const selectAll = $('lostReceiptSelectAll');
  if (selectAll) {
    selectAll.addEventListener('change', e => {
      rows.forEach(r => {
        if (e.target.checked) lostReceiptHistorySelected.add(r.id);
        else lostReceiptHistorySelected.delete(r.id);
      });
      renderLostReceiptHistory();
    });
  }

  updateLostReceiptHistorySelectedTotal();
  const footer = $('lostReceiptHistoryFooterTotal');
  if (footer) footer.textContent = $('lostReceiptHistoryTotal')?.textContent || '0';
}

function openLostReceiptHistoryModal() {
  const modal = $('lostReceiptModal');
  if (!modal) return;
  lostReceiptHistorySelected = new Set(currentReport.selectedLostCaseIds || []);
  modal.classList.remove('hidden');
  if ($('lostReceiptHistorySearch')) $('lostReceiptHistorySearch').value = '';
  renderLostReceiptHistory();
}

function closeLostReceiptHistoryModal() {
  const modal = $('lostReceiptModal');
  if (modal) modal.classList.add('hidden');
}

function useLostReceiptHistoryTotal() {
  const total = getLostReceiptHistoryRows()
    .filter(r => lostReceiptHistorySelected.has(r.id))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
  if (!total) return showToast('Chưa tích chọn hồ sơ mất phiếu.', 'error');
  currentReport.selectedLostCaseIds = Array.from(lostReceiptHistorySelected);
  const oldLost = parseMoney($('lostReceiptAmount').value);
  const currentRefund = parseMoney($('refundAmount').value);
  $('lostReceiptAmount').value = formatMoney(total);
  $('refundAmount').value = formatMoney(Math.max(0, currentRefund - oldLost) + total);
  updateReportTotals();
  closeLostReceiptHistoryModal();
  showToast('Đã lấy tổng tiền hồ sơ mất phiếu được chọn vào ô tương ứng.');
}

function renderReportTables() {
  const adv = getFilteredRows(currentReport.advanceRows, 'advanceSearch');
  renderTable('advanceTable', ['Ngày thu', 'Phiếu thu', 'Họ tên', 'Tuổi', 'Giới tính', 'Khoa/phòng', 'Số tiền', 'Người thu'], adv, r => `
    <tr>
      <td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.receiptNo)}</td><td>${escapeHtml(r.patientName)}</td>
      <td>${escapeHtml(r.age)}</td><td>${escapeHtml(r.gender)}</td><td>${escapeHtml(r.department)}</td>
      <td class="money">${formatMoney(r.amount)}</td><td>${escapeHtml(r.collector)}</td>
    </tr>`);
  setTableFooter('advanceTable', `<tr><th colspan="6" style="text-align:right">Tổng cộng</th><th class="money">${formatMoney(adv.reduce((s, r) => s + Number(r.amount || 0), 0))}</th><th></th></tr>`);

  const inv = getFilteredRows(currentReport.invoiceRows, 'invoiceSearch');
  renderTable('invoiceTable', ['Ngày thanh toán', 'Số HĐĐT', 'Tên bệnh nhân', 'Số tiền', 'Người phát hành'], inv, r => `
    <tr>
      <td>${escapeHtml(r.paymentDate)}</td><td>${escapeHtml(r.invoiceNo)}</td><td>${escapeHtml(r.patientName)}</td>
      <td class="money">${formatMoney(r.amount)}</td><td>${escapeHtml(r.issuer)}</td>
    </tr>`);
  setTableFooter('invoiceTable', `<tr><th colspan="3" style="text-align:right">Tổng cộng</th><th class="money">${formatMoney(inv.reduce((s, r) => s + Number(r.amount || 0), 0))}</th><th></th></tr>`);

  updateReportTotals();
}

function updateReportFromInputs() {
  currentReport.refundAmount = parseMoney($('refundAmount').value);
  currentReport.lostReceiptAmount = parseMoney($('lostReceiptAmount').value);
  currentReport.cashFloat = parseMoney($('cashFloat').value);
  currentReport.note = $('reportNote').value.trim();
}

function updateReportTotals() {
  updateReportFromInputs();
  const sumAdvance = currentReport.advanceRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const sumInvoice = currentReport.invoiceRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  // Còn lại phải nộp = Tổng thu tạm ứng + Tổng HĐĐT + Tiền mặt ứng quỹ - Tổng tiền tạm ứng thu hồi.
  // Tiền xử lý mất phiếu đã được tự động cộng vào ô Tổng tiền tạm ứng thu hồi.
  const remain = sumAdvance + sumInvoice + currentReport.cashFloat - currentReport.refundAmount;
  $('sumAdvance').textContent = formatMoney(sumAdvance);
  $('sumInvoice').textContent = formatMoney(sumInvoice);
  if ($('sumPayable')) $('sumPayable').textContent = formatMoney(remain);
  $('sumRemainPay').textContent = formatMoney(remain);
}

function buildReportObject(status = 'draft') {
  updateReportFromInputs();
  const sumAdvance = currentReport.advanceRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const sumInvoice = currentReport.invoiceRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalCollection = sumAdvance + sumInvoice + currentReport.cashFloat;
  if (currentReport.lostReceiptAmount && currentReport.refundAmount < currentReport.lostReceiptAmount) currentReport.refundAmount = currentReport.lostReceiptAmount;
  const remainPay = totalCollection - currentReport.refundAmount;
  return {
    ...currentReport,
    id: currentReport.id || uid('report'),
    code: currentReport.code || `BC-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`,
    status,
    createdBy: currentReport.createdBy || currentUser.id,
    createdByName: currentReport.createdByName || currentUser.fullName,
    createdAt: currentReport.createdAt || nowISO(),
    updatedAt: nowISO(),
    reportDateISO: currentReport.reportDateISO || todayISO(),
    reportDate: currentReport.reportDate || formatPrintDate(currentReport.reportDateISO || todayISO()),
    submittedAt: status === 'submitted' ? nowISO() : currentReport.submittedAt || null,
    sumAdvance,
    sumInvoice,
    totalCollection,
    totalPayable: remainPay,
    remainPay,
    treasurerId: currentReport.treasurerId || null,
    treasurerName: currentReport.treasurerName || '',
    treasurerNote: currentReport.treasurerNote || '',
    refundIncludesLost: true
  };
}

function saveCurrentReport(status = 'draft') {
  if (!['admin', 'ketoan'].includes(currentUser.role)) { showToast('Tài khoản này không có quyền lập báo cáo.', 'error'); return false; }
  const report = buildReportObject(status);
  if (!report.advanceRows.length && !report.invoiceRows.length && !report.refundAmount && !report.lostReceiptAmount) {
    showToast('Báo cáo chưa có dữ liệu.', 'warn'); return false;
  }
  const reports = getReports();
  const idx = reports.findIndex(r => r.id === report.id);
  if (idx >= 0) {
    if (!canEditReport(reports[idx])) { showToast('Tài khoản này không có quyền sửa báo cáo này hoặc báo cáo đã khóa.', 'error'); return false; }
    if (currentUser.role === 'ketoan' && reports[idx].createdBy !== currentUser.id) { showToast('Kế toán viên chỉ được sửa báo cáo do chính tài khoản mình lập.', 'error'); return false; }
  }
  if (idx >= 0) reports[idx] = report; else reports.push(report);
  setReports(reports);
  currentReport = report;
  syncReportSourceData(report);
  renderMyReports();
  renderTreasurerReports();
  showToast(status === 'submitted' ? 'Đã gửi báo cáo cho thủ quỹ.' : (status === 'finalized' ? 'Đã chốt báo cáo và lưu phiếu thu tạm ứng vào hệ thống.' : 'Đã lưu báo cáo.'));
  return true;
}

function finalizeCurrentReport() {
  if (!reportHasWorkingData(currentReport)) {
    return showToast('Chưa có dữ liệu để chốt báo cáo.', 'warn');
  }
  if (saveCurrentReport('finalized')) {
    reportInputEnabled = false;
    applyRoleControls();
  }
}

function reportHasWorkingData(report = currentReport) {
  if (!report) return false;
  return !!((report.advanceRows || []).length || (report.invoiceRows || []).length || Number(report.refundAmount || 0) || Number(report.lostReceiptAmount || 0) || Number(report.cashFloat || 0));
}

function reportNeedsLogoutReminder() {
  if (!['admin', 'ketoan'].includes(currentUser?.role)) return false;
  if (!reportHasWorkingData()) return false;
  return !['finalized', 'submitted', 'confirmed', 'locked', 'completed'].includes(currentReport.status);
}

function guardedLogout() {
  if (reportNeedsLogoutReminder()) {
    const ok = confirm('Báo cáo hiện tại chưa chốt/gửi thủ quỹ. Nên chốt báo cáo để lưu phiếu thu tạm ứng vào hệ thống và gửi thủ quỹ trước khi đăng xuất. Vẫn đăng xuất?');
    if (!ok) return;
  }
  clearSession();
  showLogin();
}


function startNewReport() {
  if (reportNeedsLogoutReminder()) {
    const ok = confirm('Báo cáo hiện tại chưa chốt/gửi thủ quỹ. Tạo báo cáo mới sẽ xóa dữ liệu đang hiển thị trên màn hình. Vẫn tiếp tục?');
    if (!ok) return;
  }
  openBuildReportPeriodModal();
}

function syncReportSourceData(report) {
  let advances = getAdvances();
  report.advanceRows.forEach(row => {
    const key = advanceKey(row);
    const item = { ...row, key, sourceReportId: report.id, ownerId: report.createdBy, ownerName: report.createdByName };
    const idx = advances.findIndex(x => x.key === key);
    if (idx >= 0) advances[idx] = { ...advances[idx], ...item }; else advances.push(item);
  });
  setAdvances(advances);

  let invoices = getInvoices();
  report.invoiceRows.forEach(row => {
    const key = `${normalizeText(row.invoiceNo)}|${normalizeText(row.patientName)}|${row.paymentDateISO || row.paymentDate}`;
    const item = { ...row, key, sourceReportId: report.id, ownerId: report.createdBy, ownerName: report.createdByName };
    const idx = invoices.findIndex(x => x.key === key);
    if (idx >= 0) invoices[idx] = { ...invoices[idx], ...item }; else invoices.push(item);
  });
  setInvoices(invoices);
}

function advanceKey(row) {
  return `${normalizeText(row.receiptNo)}|${normalizeText(row.patientName)}|${row.dateISO || row.date}`;
}

function receiptNoKey(value) {
  return normalizeText(value);
}

function buildExistingAdvanceKeysForUpload() {
  const keys = new Set();
  getAdvances().forEach(item => {
    if (currentReport.id && item.sourceReportId === currentReport.id) return;
    const key = receiptNoKey(item.receiptNo);
    if (key) keys.add(key);
  });
  getReports().forEach(report => {
    if (currentReport.id && report.id === currentReport.id) return;
    (report.advanceRows || []).forEach(item => {
      const key = receiptNoKey(item.receiptNo);
      if (key) keys.add(key);
    });
  });
  return keys;
}


function clearAdvanceFile() {
  const input = $('advanceFile');
  if (input) input.value = '';
  currentReport.advanceRows = [];
  $('advanceImportSummary').textContent = '';
  if ($('advanceSearch')) $('advanceSearch').value = '';
  renderReportTables();
  updateReportTotals();
  showToast('Đã xóa file thu tạm ứng.');
}

function clearInvoiceFile() {
  const input = $('invoiceFile');
  if (input) input.value = '';
  currentReport.invoiceRows = [];
  $('invoiceImportSummary').textContent = '';
  if ($('invoiceSearch')) $('invoiceSearch').value = '';
  renderReportTables();
  updateReportTotals();
  showToast('Đã xóa file HĐĐT.');
}

function resetReport(silent = false) {
  currentReport = emptyReport();
  ['advanceFile', 'invoiceFile'].forEach(id => $(id).value = '');
  ['advanceImportSummary', 'invoiceImportSummary'].forEach(id => $(id).textContent = '');
  ['refundAmount', 'lostReceiptAmount', 'cashFloat', 'reportNote'].forEach(id => $(id).value = '');
  renderReportTables();
  if (!silent) showToast('Đã tạo báo cáo mới.');
}

function canViewReport(report) {
  // Admin/thủ quỹ/trưởng phòng xem được toàn bộ để kiểm tra và xác nhận.
  if (['admin', 'thuquy', 'truongphong'].includes(currentUser.role)) return true;

  // Tài khoản kế toán viên chỉ nhìn thấy báo cáo do chính tài khoản đó lập.
  // Không mở rộng theo tên HIS để tránh tài khoản con sửa/xóa nhầm báo cáo của admin hoặc người khác.
  if (currentUser.role === 'ketoan') return report.createdBy === currentUser.id;

  return false;
}

function canEditReport(report) {
  if (!report) return false;
  if (['confirmed', 'locked'].includes(report.status)) return false;
  if (currentUser.role === 'admin') return true;
  if (currentUser.role === 'ketoan') return report.createdBy === currentUser.id;
  return false;
}

function canDeleteReport(report) {
  if (!report) return false;
  if (['submitted', 'confirmed', 'locked'].includes(report.status)) return false;
  if (currentUser.role === 'admin') return true;
  if (currentUser.role === 'ketoan') return report.createdBy === currentUser.id;
  return false;
}

function currentHisNameKey() {
  return normalizeText(currentUser?.hisCollectorName || currentUser?.fullName || currentUser?.username || '');
}

function shouldScopeReportToCurrentUser(report) {
  return currentUser?.role === 'ketoan' && currentHisNameKey();
}

function scopeReportForCurrentUser(report) {
  if (!report || !shouldScopeReportToCurrentUser(report)) return report;
  const assigned = currentHisNameKey();
  const advanceRows = (report.advanceRows || []).filter(row => normalizeText(row.collector) === assigned);
  const invoiceRows = (report.invoiceRows || []).filter(row => normalizeText(row.issuer) === assigned);
  const allowedReceiptKeys = new Set(advanceRows.map(row => {
    const rid = row.id ? String(row.id) : '';
    const key = advanceKey(row);
    return `${normalizeText(row.receiptNo)}|${normalizeText(row.patientName)}|${row.dateISO || row.date}|${rid}|${key}`;
  }));
  // Biên lai thu hồi tạm ứng do người dùng đã tích chọn phải được giữ nguyên,
  // không lọc theo người thu/tài khoản vì người xử lý có thể thu hồi phiếu của người khác.
  const selectedRefundRowIds = report.selectedRefundRowIds || [];
  const sumAdvance = advanceRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const sumInvoice = invoiceRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const refundAmount = amountFromSelectedRefundRows(selectedRefundRowIds, '', '', report.reportDateISO || (report.createdAt || '').slice(0, 10));
  const scopedRefundAmount = refundAmount === null ? Number(report.refundAmount || 0) : refundAmount;
  const selectedLostCaseIds = (report.selectedLostCaseIds || []).filter(id => {
    const item = getLostCases().find(c => c.id === id);
    return !item || item.createdBy === currentUser.id || normalizeText(item.createdByName) === normalizeText(currentUser.fullName);
  });
  const selectedLostAmount = amountFromSelectedLostCases(selectedLostCaseIds, '', '');
  const scopedLostAmount = selectedLostAmount === null ? Number(report.lostReceiptAmount || 0) : selectedLostAmount;
  const refundIncludesLost = report.refundIncludesLost === true;
  const scopedRefundWithLost = refundAmount === null
    ? (refundIncludesLost ? Math.max(scopedRefundAmount, scopedLostAmount) : scopedRefundAmount + scopedLostAmount)
    : refundAmount + scopedLostAmount;
  const remainPay = sumAdvance + sumInvoice + Number(report.cashFloat || 0) - scopedRefundWithLost;

  return {
    ...report,
    advanceRows,
    invoiceRows,
    selectedRefundRowIds,
    selectedLostCaseIds,
    refundAmount: scopedRefundWithLost,
    lostReceiptAmount: scopedLostAmount,
    sumAdvance,
    sumInvoice,
    totalCollection: sumAdvance + sumInvoice + Number(report.cashFloat || 0),
    totalPayable: remainPay,
    remainPay
  };
}

function renderMyReports() {
  const reports = getReports().filter(canViewReport).sort((a, b) => String(b.reportDateISO || b.createdAt).localeCompare(String(a.reportDateISO || a.createdAt)));
  renderTable('myReportsTable', ['Mã báo cáo', 'Người lập', 'Ngày báo cáo', 'Còn lại phải nộp', 'Trạng thái', 'Thao tác'], reports, r => {
    const viewReport = scopeReportForCurrentUser(r);
    const canEdit = canEditReport(r);
    const canDelete = canDeleteReport(r);
    const reportDateISO = r.reportDateISO || (r.createdAt || r.updatedAt || todayISO()).slice(0, 10);
    const dateCell = canEdit
      ? `<input type="date" class="inline-date-input" value="${escapeHtml(reportDateISO)}" onchange="updateReportDate('${r.id}', this.value)" title="Sửa ngày báo cáo">`
      : escapeHtml(r.reportDate || formatPrintDate(reportDateISO));
    return `
    <tr>
      <td>${escapeHtml(r.code)}</td><td>${escapeHtml(r.createdByName)}</td>
      <td>${dateCell}</td>
      <td class="money">${formatMoney(calcReportRemain(viewReport))}</td>
      <td>${statusBadge(r.status)}</td>
      <td><div class="row-actions">
        <button class="btn small" onclick="loadReport('${r.id}')">${canEdit ? 'Sửa' : 'Xem'}</button>
        ${canDelete ? `<button class="btn small danger" onclick="deleteReport('${r.id}')">Xóa</button>` : ''}
        <button class="btn small" onclick="printReportById('${r.id}')">In</button>
      </div></td>
    </tr>`;
  });
}

function updateReportDate(id, value) {
  if (!value) return;
  const reports = getReports();
  const item = reports.find(r => r.id === id);
  if (!item) return showToast('Không tìm thấy báo cáo.', 'error');
  if (!canEditReport(item)) return showToast('Không có quyền sửa ngày báo cáo này.', 'error');

  item.reportDateISO = value;
  item.reportDate = formatPrintDate(value);
  item.updatedAt = nowISO();
  if (currentReport.id === id) {
    currentReport.reportDateISO = value;
    currentReport.reportDate = formatPrintDate(value);
  }
  setReports(reports);
  renderMyReports();
  updateReportTotals();
  showToast('Đã cập nhật ngày báo cáo.');
}

window.updateReportDate = updateReportDate;

function loadReport(id) {
  const report = getReports().find(r => r.id === id);
  if (!report || !canViewReport(report)) return showToast('Không tìm thấy báo cáo.', 'error');
  const scopedReport = scopeReportForCurrentUser(report);
  currentReport = JSON.parse(JSON.stringify(scopedReport));
  $('refundAmount').value = scopedReport.refundAmount ? formatMoney(scopedReport.refundAmount) : '';
  $('lostReceiptAmount').value = scopedReport.lostReceiptAmount ? formatMoney(scopedReport.lostReceiptAmount) : '';
  $('cashFloat').value = scopedReport.cashFloat ? formatMoney(scopedReport.cashFloat) : '';
  $('reportNote').value = scopedReport.note || '';
  ['advanceFile', 'invoiceFile'].forEach(inputId => { const el = $(inputId); if (el) el.value = ''; });
  ['advanceImportSummary', 'invoiceImportSummary'].forEach(infoId => { const el = $(infoId); if (el) el.textContent = ''; });
  reportInputEnabled = canEditReport(report);
  renderReportTables();
  applyRoleControls();
  setActiveTab('tabReport');
  showToast(reportInputEnabled ? 'Đã mở báo cáo để sửa. Có thể upload lại file nếu cần.' : 'Đã mở báo cáo để xem.');
}

window.loadReport = loadReport;

function deleteReport(id) {
  const reports = getReports();
  const idx = reports.findIndex(r => r.id === id);
  if (idx < 0) return showToast('Không tìm thấy báo cáo.', 'error');
  const report = reports[idx];
  if (!canViewReport(report)) return showToast('Không có quyền xem báo cáo này.', 'error');
  if (!canDeleteReport(report)) return showToast('Tài khoản này không có quyền xóa báo cáo này hoặc báo cáo đã gửi/xác nhận.', 'error');
  if (!confirm(`Xóa báo cáo ${report.code}?`)) return;
  reports.splice(idx, 1);
  setReports(reports);
  if (currentReport.id === id) resetReport(true);
  renderMyReports();
  renderTreasurerReports();
  showToast('Đã xóa báo cáo.');
}

window.deleteReport = deleteReport;

function renderTreasurerReports() {
  const reports = getReports()
    .filter(r => ['submitted', 'confirmed', 'rejected'].includes(r.status))
    .sort((a, b) => String(b.submittedAt || b.createdAt).localeCompare(String(a.submittedAt || a.createdAt)));
  renderTable('treasurerReportsTable', ['Mã báo cáo', 'Người lập', 'Còn lại phải nộp', 'Trạng thái', 'Thao tác'], reports, r => {
    const canConfirm = ['admin', 'thuquy'].includes(currentUser.role) && r.status === 'submitted';
    return `<tr>
      <td>${escapeHtml(r.code)}</td><td>${escapeHtml(r.createdByName)}</td>
      <td class="money">${formatMoney(calcReportRemain(r))}</td>
      <td>${statusBadge(r.status)}</td>
      <td><div class="row-actions">
        <button class="btn small" onclick="printReportById('${r.id}')">In</button>
        ${canConfirm ? `<button class="btn small primary" onclick="confirmReport('${r.id}')">Xác nhận</button><button class="btn small danger" onclick="rejectReport('${r.id}')">Trả lại</button>` : ''}
      </div></td>
    </tr>`;
  });
}

function confirmReport(id) {
  const reports = getReports();
  const r = reports.find(x => x.id === id);
  if (!r) return;
  r.status = 'confirmed';
  r.treasurerId = currentUser.id;
  r.treasurerName = currentUser.fullName;
  r.confirmedAt = nowISO();
  r.updatedAt = nowISO();
  setReports(reports);
  refreshAll();
  showToast('Đã xác nhận báo cáo.');
}

function rejectReport(id) {
  const note = prompt('Nhập lý do trả lại báo cáo:') || '';
  const reports = getReports();
  const r = reports.find(x => x.id === id);
  if (!r) return;
  r.status = 'rejected';
  r.treasurerId = currentUser.id;
  r.treasurerName = currentUser.fullName;
  r.treasurerNote = note;
  r.updatedAt = nowISO();
  setReports(reports);
  refreshAll();
  showToast('Đã trả lại báo cáo.');
}

window.confirmReport = confirmReport;
window.rejectReport = rejectReport;

function readLostImages() {
  const files = Array.from($('lostImages').files || []);
  if (!files.length) return Promise.resolve([]);
  return Promise.all(files.map(file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve({ name: file.name, type: file.type, dataUrl: e.target.result });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  })));
}

function renderLostImagePreview() {
  $('lostImagePreview').innerHTML = lostImagesBase64.map(img => `<img src="${img.dataUrl}" title="${escapeHtml(img.name)}" />`).join('');
}

function searchReceipts() {
  const q = normalizeText($('lostSearchInput').value);
  const advances = getAdvances().filter(r => !q || normalizeText(Object.values(r).join(' ')).includes(q));
  renderTable('lostSearchTable', ['Ngày thu', 'Phiếu thu', 'Họ tên', 'Số tiền', 'Khoa/phòng', 'Chọn'], advances.slice(0, 100), r => `
    <tr>
      <td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.receiptNo)}</td><td>${escapeHtml(r.patientName)}</td>
      <td class="money">${formatMoney(r.amount)}</td><td>${escapeHtml(r.department)}</td>
      <td><button class="btn small primary" onclick="selectReceiptForLost('${r.key}')">Chọn</button></td>
    </tr>`, 'Chưa có dữ liệu. Cần upload/lưu báo cáo thu tạm ứng trước.');
}

function selectReceiptForLost(key) {
  selectedReceipt = getAdvances().find(r => r.key === key) || null;
  currentLostCaseId = null;
  lostImagesBase64 = [];
  $('lostImages').value = '';
  $('lostRequester').value = selectedReceipt?.patientName || '';
  $('lostIdNo').value = '';
  $('lostProcessDate').value = todayISO();
  $('lostReason').value = '';
  $('lostNote').value = '';
  renderSelectedReceipt();
  renderLostImagePreview();
}

function renderSelectedReceipt() {
  const box = $('selectedReceiptBox');
  if (!selectedReceipt) {
    box.textContent = 'Chưa chọn phiếu.';
    return;
  }
  box.innerHTML = `
    <b>${escapeHtml(selectedReceipt.patientName)}</b><br>
    Phiếu thu: <b>${escapeHtml(selectedReceipt.receiptNo)}</b> | Ngày thu: ${escapeHtml(selectedReceipt.date)}<br>
    Khoa/phòng: ${escapeHtml(selectedReceipt.department)} | Số tiền: <b>${formatMoney(selectedReceipt.amount)}</b>`;
}

window.selectReceiptForLost = selectReceiptForLost;

async function saveLostCase(status = 'completed') {
  if (!selectedReceipt) return showToast('Chưa chọn phiếu tạm ứng.', 'error');
  if (!['admin', 'ketoan'].includes(currentUser.role)) return showToast('Tài khoản này không có quyền lập hồ sơ mất phiếu.', 'error');
  const newImages = await readLostImages();
  if (newImages.length) lostImagesBase64 = lostImagesBase64.concat(newImages);
  if (!lostImagesBase64.length) {
    showToast('Cần upload hình ảnh hồ sơ trước khi hoàn thành xử lý mất phiếu.', 'error');
    return;
  }

  const item = {
    id: currentLostCaseId || uid('lost'),
    code: currentLostCaseId ? undefined : `MP-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`,
    receiptKey: selectedReceipt.key,
    receiptNo: selectedReceipt.receiptNo,
    receiptDate: selectedReceipt.date,
    receiptDateISO: selectedReceipt.dateISO,
    patientName: selectedReceipt.patientName,
    age: selectedReceipt.age,
    amount: selectedReceipt.amount,
    department: selectedReceipt.department,
    requester: $('lostRequester').value.trim(),
    idNo: $('lostIdNo').value.trim(),
    processDate: $('lostProcessDate').value || todayISO(),
    reason: $('lostReason').value.trim(),
    note: $('lostNote').value.trim(),
    images: lostImagesBase64,
    status,
    createdBy: currentUser.id,
    createdByName: currentUser.fullName,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    submittedAt: status === 'submitted' ? nowISO() : null,
    completedAt: status === 'completed' ? nowISO() : null,
    treasurerId: null,
    treasurerName: '',
    treasurerNote: ''
  };

  const cases = getLostCases();
  const idx = cases.findIndex(x => x.id === item.id);
  if (idx >= 0) {
    item.code = cases[idx].code;
    item.createdAt = cases[idx].createdAt;
    item.createdBy = cases[idx].createdBy;
    item.createdByName = cases[idx].createdByName;
    item.treasurerId = cases[idx].treasurerId;
    item.treasurerName = cases[idx].treasurerName;
    item.treasurerNote = cases[idx].treasurerNote;
    item.submittedAt = status === 'submitted' ? nowISO() : cases[idx].submittedAt;
    item.completedAt = status === 'completed' ? nowISO() : cases[idx].completedAt || null;
    if (['confirmed'].includes(cases[idx].status)) return showToast('Hồ sơ đã xác nhận, không thể sửa.', 'error');
    cases[idx] = item;
  } else {
    cases.push(item);
  }

  setLostCases(cases);
  currentLostCaseId = item.id;
  if (status === 'completed') mergeCompletedLostCaseToCurrentReport(item);
  renderLostCases();
  renderTreasurerLostCases();
  showToast(status === 'completed' ? 'Đã hoàn thành xử lý mất phiếu. Khoản này sẽ được tính vào tạm ứng thu hồi và báo cáo thu chi.' : 'Đã lưu hồ sơ mất phiếu.');
}

function mergeCompletedLostCaseToCurrentReport(item) {
  if (!item || !reportHasWorkingData(currentReport)) return;
  if (!lostCaseMatchesCurrentUser(item)) return;
  const d = item.processDate || (item.completedAt || item.updatedAt || item.createdAt || '').slice(0, 10);
  const from = currentReport.printDateFromISO || parseDateToISO(currentReport.dateFrom);
  const to = currentReport.printDateToISO || parseDateToISO(currentReport.dateTo);
  if ((from || to) && !rowInPrintPeriod(d, from, to)) return;
  currentReport.selectedLostCaseIds = currentReport.selectedLostCaseIds || [];
  if (currentReport.selectedLostCaseIds.includes(item.id)) return;
  const amount = Number(item.amount || 0);
  currentReport.selectedLostCaseIds.push(item.id);
  currentReport.lostReceiptAmount = Number(currentReport.lostReceiptAmount || 0) + amount;
  currentReport.refundAmount = Number(currentReport.refundAmount || 0) + amount;
  currentReport.refundIncludesLost = true;
  $('lostReceiptAmount').value = formatMoney(currentReport.lostReceiptAmount);
  $('refundAmount').value = formatMoney(currentReport.refundAmount);
  updateReportTotals();
}

function canViewLostCase(item) {
  if (['admin', 'thuquy', 'truongphong'].includes(currentUser.role)) return true;
  return item.createdBy === currentUser.id;
}

function renderLostCases() {
  const cases = getLostCases().filter(canViewLostCase).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  renderTable('lostCasesTable', ['Mã hồ sơ', 'Ngày xử lý', 'Phiếu thu', 'Họ tên', 'Số tiền', 'Người lập', 'Trạng thái', 'Thao tác'], cases, c => `
    <tr>
      <td>${escapeHtml(c.code)}</td><td>${c.processDate ? new Date(c.processDate).toLocaleDateString('vi-VN') : ''}</td><td>${escapeHtml(c.receiptNo)}</td><td>${escapeHtml(c.patientName)}</td>
      <td class="money">${formatMoney(c.amount)}</td><td>${escapeHtml(c.createdByName)}</td><td>${statusBadge(c.status)}</td>
      <td><div class="row-actions">
        <button class="btn small" onclick="loadLostCase('${c.id}')">Sửa</button>
        <button class="btn small danger" onclick="deleteLostCase('${c.id}')">Xóa</button>
        <button class="btn small" onclick="printLostCaseById('${c.id}')">In</button>
      </div></td>
    </tr>`);
}

function loadLostCase(id) {
  const item = getLostCases().find(x => x.id === id);
  if (!item || !canViewLostCase(item)) return showToast('Không tìm thấy hồ sơ.', 'error');
  selectedReceipt = getAdvances().find(a => a.key === item.receiptKey) || {
    key: item.receiptKey,
    receiptNo: item.receiptNo,
    date: item.receiptDate,
    dateISO: item.receiptDateISO,
    patientName: item.patientName,
    age: item.age,
    amount: item.amount,
    department: item.department
  };
  currentLostCaseId = item.id;
  lostImagesBase64 = item.images || [];
  $('lostRequester').value = item.requester || '';
  $('lostIdNo').value = item.idNo || '';
  $('lostProcessDate').value = item.processDate || todayISO();
  $('lostReason').value = item.reason || '';
  $('lostNote').value = item.note || '';
  $('lostImages').value = '';
  renderSelectedReceipt();
  renderLostImagePreview();
  setActiveTab('tabLost');
}

window.loadLostCase = loadLostCase;

function deleteLostCase(id) {
  const cases = getLostCases();
  const idx = cases.findIndex(c => c.id === id);
  if (idx < 0) return showToast('Không tìm thấy hồ sơ.', 'error');
  const item = cases[idx];
  if (!canViewLostCase(item)) return showToast('Không có quyền xem hồ sơ này.', 'error');
  if (currentUser.role === 'ketoan' && item.createdBy !== currentUser.id) return showToast('Kế toán viên chỉ được xóa hồ sơ do chính tài khoản mình lập.', 'error');
  if (!['admin', 'ketoan'].includes(currentUser.role)) return showToast('Tài khoản này không có quyền xóa hồ sơ.', 'error');
  if (['confirmed', 'completed'].includes(item.status)) return showToast('Hồ sơ đã xác nhận, không thể xóa.', 'error');
  if (!confirm(`Xóa hồ sơ ${item.code}?`)) return;
  cases.splice(idx, 1);
  setLostCases(cases);
  if (currentLostCaseId === id) {
    currentLostCaseId = null;
    selectedReceipt = null;
    lostImagesBase64 = [];
    $('lostRequester').value = '';
    $('lostIdNo').value = '';
    $('lostProcessDate').value = todayISO();
    $('lostReason').value = '';
    $('lostNote').value = '';
    $('lostImages').value = '';
    renderSelectedReceipt();
    renderLostImagePreview();
  }
  renderLostCases();
  renderTreasurerLostCases();
  showToast('Đã xóa hồ sơ mất phiếu.');
}

window.deleteLostCase = deleteLostCase;

function renderTreasurerLostCases() {
  const cases = getLostCases()
    .filter(c => ['submitted', 'confirmed', 'rejected', 'completed'].includes(c.status))
    .sort((a, b) => String(b.submittedAt || b.createdAt).localeCompare(String(a.submittedAt || a.createdAt)));
  renderTable('treasurerLostTable', ['Mã hồ sơ', 'Ngày xử lý', 'Phiếu thu', 'Họ tên', 'Số tiền', 'Trạng thái', 'Thao tác'], cases, c => {
    const canConfirm = ['admin', 'thuquy'].includes(currentUser.role) && c.status === 'submitted';
    return `<tr>
      <td>${escapeHtml(c.code)}</td><td>${c.processDate ? new Date(c.processDate).toLocaleDateString('vi-VN') : ''}</td><td>${escapeHtml(c.receiptNo)}</td><td>${escapeHtml(c.patientName)}</td>
      <td class="money">${formatMoney(c.amount)}</td><td>${statusBadge(c.status)}</td>
      <td><div class="row-actions">
        <button class="btn small" onclick="printLostCaseById('${c.id}')">In</button>
        ${canConfirm ? `<button class="btn small primary" onclick="confirmLostCase('${c.id}')">Xác nhận</button><button class="btn small danger" onclick="rejectLostCase('${c.id}')">Trả lại</button>` : ''}
      </div></td>
    </tr>`;
  });
}

function confirmLostCase(id) {
  const cases = getLostCases();
  const item = cases.find(x => x.id === id);
  if (!item) return;
  item.status = 'confirmed';
  item.treasurerId = currentUser.id;
  item.treasurerName = currentUser.fullName;
  item.confirmedAt = nowISO();
  item.updatedAt = nowISO();
  setLostCases(cases);
  refreshAll();
  showToast('Đã xác nhận hồ sơ mất phiếu.');
}

function rejectLostCase(id) {
  const note = prompt('Nhập lý do trả lại hồ sơ mất phiếu:') || '';
  const cases = getLostCases();
  const item = cases.find(x => x.id === id);
  if (!item) return;
  item.status = 'rejected';
  item.treasurerId = currentUser.id;
  item.treasurerName = currentUser.fullName;
  item.treasurerNote = note;
  item.updatedAt = nowISO();
  setLostCases(cases);
  refreshAll();
  showToast('Đã trả lại hồ sơ mất phiếu.');
}

window.confirmLostCase = confirmLostCase;
window.rejectLostCase = rejectLostCase;

function addRefund() {
  if (!['admin', 'thuquy'].includes(currentUser.role)) return showToast('Chỉ thủ quỹ/admin được nhập dòng trả tạm ứng.', 'error');
  const item = {
    id: uid('refund'),
    refundDate: $('refundDate').value,
    receiptNo: $('refundReceiptNo').value.trim(),
    patientName: $('refundPatientName').value.trim(),
    amount: parseMoney($('refundMoney').value),
    note: $('refundNote').value.trim(),
    createdBy: currentUser.id,
    createdByName: currentUser.fullName,
    createdAt: nowISO()
  };
  if (!item.refundDate || !item.receiptNo || !item.patientName || !item.amount) return showToast('Nhập chưa đủ thông tin trả tạm ứng.', 'error');
  const refunds = getRefunds();
  refunds.push(item);
  setRefunds(refunds);
  ['refundReceiptNo', 'refundPatientName', 'refundMoney', 'refundNote'].forEach(id => $(id).value = '');
  showToast('Đã lưu dòng trả tạm ứng.');
  buildCashbook();
}

function inRange(dateISO, from, to) {
  if (!dateISO) return false;
  if (from && dateISO < from) return false;
  if (to && dateISO > to) return false;
  return true;
}

function buildCashbook() {
  const from = $('cashbookFrom').value;
  const to = $('cashbookTo').value;
  if (!to) return showToast('Chọn ngày kết thúc báo cáo.', 'error');

  const advances = getAdvances();
  const refunds = getRefunds();
  const lostCases = getLostCases().filter(c => ['confirmed', 'completed'].includes(c.status));
  const validReportStatuses = new Set(['finalized', 'submitted', 'confirmed', 'locked', 'completed']);

  // Các biên lai đã được tích ở ô "Tiền tạm ứng thu hồi" trong báo cáo nộp tiền
  // được xem là đã trả tạm ứng và phải thể hiện ở báo cáo thu chi của thủ quỹ.
  const selectedRefundMap = new Map();
  getReports()
    .filter(r => validReportStatuses.has(r.status))
    .forEach(report => {
      const reportDate = report.reportDateISO || (report.submittedAt || report.confirmedAt || report.updatedAt || report.createdAt || '').slice(0, 10);
      if (to && reportDate && reportDate > to) return;

      (report.selectedRefundRowIds || []).forEach(key => {
        if (!selectedRefundMap.has(key)) {
          selectedRefundMap.set(key, {
            amount: 0,
            dates: new Set(),
            payers: new Set(),
            reportCodes: new Set()
          });
        }
        const entry = selectedRefundMap.get(key);
        if (reportDate) entry.dates.add(reportDate);
        if (report.createdByName) entry.payers.add(report.createdByName);
        if (report.code) entry.reportCodes.add(report.code);
      });
    });

  cashbookRows = advances
    .filter(a => (a.dateISO || '') <= to)
    .map(a => {
      const keyText = normalizeText(`${a.receiptNo}|${a.patientName}`);
      const baseAmount = Number(a.amount || 0);

      const manualRefundRows = refunds
        .filter(r => normalizeText(`${r.receiptNo}|${r.patientName}`) === keyText && r.refundDate <= to);
      const paidRefundManual = manualRefundRows.reduce((s, r) => s + Number(r.amount || 0), 0);

      const selectedEntry = selectedRefundMap.get(a.key);
      const paidRefundSelected = selectedEntry ? baseAmount : 0;

      const lostCaseRows = lostCases
        .filter(c => c.receiptKey === a.key && (c.processDate || (c.confirmedAt || c.updatedAt || c.createdAt).slice(0, 10)) <= to);
      const paidLost = lostCaseRows.reduce((s, c) => s + Number(c.amount || 0), 0);

      const rawPaidAtEnd = paidRefundManual + paidRefundSelected + paidLost;
      const paidAtEnd = Math.min(baseAmount, rawPaidAtEnd);
      const remaining = Math.max(0, baseAmount - paidAtEnd);

      const hasRefundManualInRange = refunds.some(r => normalizeText(`${r.receiptNo}|${r.patientName}`) === keyText && inRange(r.refundDate, from, to));
      const hasRefundSelectedInRange = !!selectedEntry && Array.from(selectedEntry.dates).some(d => inRange(d, from, to));
      const hasLostInRange = lostCases.some(c => c.receiptKey === a.key && inRange(c.processDate || (c.confirmedAt || c.updatedAt || c.createdAt).slice(0, 10), from, to));
      const include = inRange(a.dateISO, from, to) || hasRefundManualInRange || hasRefundSelectedInRange || hasLostInRange || remaining !== 0;

      const payDateSet = new Set();
      const payerSet = new Set();
      manualRefundRows.forEach(r => { if (r.refundDate) payDateSet.add(r.refundDate); if (r.createdByName) payerSet.add(r.createdByName); });
      if (selectedEntry) {
        Array.from(selectedEntry.dates || []).forEach(d => payDateSet.add(d));
        Array.from(selectedEntry.payers || []).forEach(n => payerSet.add(n));
      }
      lostCaseRows.forEach(c => {
        const d = c.processDate || (c.confirmedAt || c.updatedAt || c.createdAt || '').slice(0, 10);
        if (d) payDateSet.add(d);
        if (c.treasurerName || c.createdByName) payerSet.add(c.treasurerName || c.createdByName);
      });
      const payDates = Array.from(payDateSet).sort();
      const payerNames = Array.from(payerSet);

      const notes = [];
      if (paidRefundSelected) notes.push('Đã thu hồi theo báo cáo nộp tiền');
      if (paidLost) notes.push('Có xử lý mất phiếu');
      if (rawPaidAtEnd > baseAmount) notes.push('Đã chặn vượt số tiền tạm ứng');

      return {
        ...a,
        paidAtEnd,
        remaining,
        payDateText: payDates.map(d => formatDisplayDate(d)).join('; '),
        payerText: payerNames.join('; '),
        note: notes.join('; '),
        include
      };
    })
    .filter(r => r.include)
    .sort((a, b) => String(a.dateISO).localeCompare(String(b.dateISO)) || String(a.patientName).localeCompare(String(b.patientName)));

  renderCashbook();
}

function renderCashbook() {
  renderTable('cashbookTable', ['Số phiếu thu', 'Ngày thu', 'Họ tên bệnh nhân', 'Tuổi', 'Số tiền đã tạm ứng', 'Đã trả tạm ứng', 'Ngày trả', 'Còn lại', 'Ghi chú'], cashbookRows, r => `
    <tr>
      <td>${escapeHtml(r.receiptNo)}</td><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.patientName)}</td><td>${escapeHtml(r.age)}</td>
      <td class="money">${formatMoney(r.amount)}</td><td class="money">${formatMoney(r.paidAtEnd)}</td>
      <td>${escapeHtml(r.payDateText || '')}</td><td class="money">${formatMoney(r.remaining)}</td><td>${escapeHtml(r.note || '')}</td>
    </tr>`);
  const totalAdvance = cashbookRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalPaid = cashbookRows.reduce((s, r) => s + Number(r.paidAtEnd || 0), 0);
  const totalRemain = cashbookRows.reduce((s, r) => s + Number(r.remaining || 0), 0);
  setTableFooter('cashbookTable', `<tr class="total-row"><th colspan="4" style="text-align:right">Tổng cộng</th><th class="money">${formatMoney(totalAdvance)}</th><th class="money">${formatMoney(totalPaid)}</th><th></th><th class="money">${formatMoney(totalRemain)}</th><th></th></tr>`);
}


function buildRecoveredReceiptsReport() {
  const from = $('cashbookFrom').value;
  const to = $('cashbookTo').value;
  if (!from || !to) return showToast('Chọn từ ngày và đến ngày trước khi lập danh sách biên lai đã thu hồi.', 'error');
  if (from > to) return showToast('Từ ngày không được lớn hơn đến ngày.', 'error');

  const receiptRows = getReceiptHistoryRows();
  const receiptById = new Map(receiptRows.map(r => [r.id, r]));
  const receiptByText = new Map(receiptRows.map(r => [normalizeText(`${r.receiptNo}|${r.patientName}`), r]));
  const rows = [];

  function pushRecovered({ key, receipt, receiptNo, patientName, age, amountAdvance, amountRecovered, payDateISO, payer, note, sourceRank }) {
    if (!payDateISO || !rowInPrintPeriod(payDateISO, from, to)) return;
    const finalReceipt = receipt || receiptByText.get(normalizeText(`${receiptNo || ''}|${patientName || ''}`)) || {};
    rows.push({
      key: key || `${sourceRank || 0}|${receiptNo || finalReceipt.receiptNo || ''}|${patientName || finalReceipt.patientName || ''}|${payDateISO}|${amountRecovered}`,
      receiptNo: receiptNo || finalReceipt.receiptNo || '',
      receiptDate: finalReceipt.date || '',
      patientName: patientName || finalReceipt.patientName || '',
      age: age || finalReceipt.age || '',
      amountAdvance: Number(amountAdvance || finalReceipt.amount || amountRecovered || 0),
      amountRecovered: Number(amountRecovered || 0),
      payDateISO,
      payDate: formatDisplayDate(payDateISO),
      payer: payer || '',
      note: note || '',
      sortKey: `${payDateISO}|${receiptNo || finalReceipt.receiptNo || ''}|${patientName || finalReceipt.patientName || ''}|${sourceRank || 0}`
    });
  }

  const validReportStatuses = new Set(['finalized', 'submitted', 'confirmed', 'locked', 'completed']);
  getReports()
    .filter(r => validReportStatuses.has(r.status))
    .forEach(report => {
      const reportDate = report.reportDateISO || (report.submittedAt || report.confirmedAt || report.updatedAt || report.createdAt || '').slice(0, 10);
      (report.selectedRefundRowIds || []).forEach(id => {
        const receipt = receiptById.get(id);
        if (!receipt) return;
        pushRecovered({
          key: `report|${report.id}|${id}`,
          receipt,
          amountRecovered: Number(receipt.amount || 0),
          payDateISO: reportDate,
          payer: report.createdByName || '',
          note: `Thu hồi theo báo cáo ${report.code || ''}`.trim(),
          sourceRank: 1
        });
      });
    });

  getRefunds().forEach(refund => {
    const receipt = receiptByText.get(normalizeText(`${refund.receiptNo}|${refund.patientName}`));
    pushRecovered({
      key: `manual|${refund.id}`,
      receipt,
      receiptNo: refund.receiptNo,
      patientName: refund.patientName,
      amountRecovered: Number(refund.amount || 0),
      payDateISO: refund.refundDate,
      payer: refund.createdByName || '',
      note: refund.note || 'Nhập dòng trả tạm ứng',
      sourceRank: 2
    });
  });

  getLostCases()
    .filter(item => ['completed', 'confirmed'].includes(item.status))
    .forEach(item => {
      const payDateISO = item.processDate || (item.completedAt || item.confirmedAt || item.updatedAt || item.createdAt || '').slice(0, 10);
      const receipt = receiptById.get(item.receiptKey) || receiptByText.get(normalizeText(`${item.receiptNo}|${item.patientName}`));
      pushRecovered({
        key: `lost|${item.id}`,
        receipt,
        receiptNo: item.receiptNo,
        patientName: item.patientName,
        age: item.age,
        amountAdvance: item.amount,
        amountRecovered: Number(item.amount || 0),
        payDateISO,
        payer: item.createdByName || item.treasurerName || '',
        note: `Xử lý mất phiếu ${item.code || ''}`.trim(),
        sourceRank: 3
      });
    });

  const unique = new Map();
  rows.forEach(r => {
    const k = `${r.key}|${r.payDateISO}|${r.amountRecovered}`;
    if (!unique.has(k)) unique.set(k, r);
  });

  recoveredReceiptRows = Array.from(unique.values())
    .sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)) || String(a.patientName).localeCompare(String(b.patientName)));

  renderRecoveredReceiptsReport();
  showToast(recoveredReceiptRows.length ? 'Đã lập danh sách biên lai đã thu hồi tạm ứng.' : 'Không có biên lai thu hồi tạm ứng trong thời gian đã chọn.');
}

function renderRecoveredReceiptsReport() {
  renderTable('recoveredReceiptTable', ['Số phiếu thu', 'Ngày thu', 'Họ tên bệnh nhân', 'Tuổi', 'Số tiền đã tạm ứng', 'Số tiền đã thu hồi', 'Ngày thu hồi', 'Người thu hồi', 'Ghi chú'], recoveredReceiptRows, r => `
    <tr>
      <td>${escapeHtml(r.receiptNo)}</td><td>${escapeHtml(r.receiptDate)}</td><td>${escapeHtml(r.patientName)}</td><td>${escapeHtml(r.age)}</td>
      <td class="money">${formatMoney(r.amountAdvance)}</td><td class="money">${formatMoney(r.amountRecovered)}</td>
      <td>${escapeHtml(r.payDate)}</td><td>${escapeHtml(r.payer)}</td><td>${escapeHtml(r.note || '')}</td>
    </tr>`);
  const totalAdvance = recoveredReceiptRows.reduce((s, r) => s + Number(r.amountAdvance || 0), 0);
  const totalRecovered = recoveredReceiptRows.reduce((s, r) => s + Number(r.amountRecovered || 0), 0);
  setTableFooter('recoveredReceiptTable', `<tr class="total-row"><th colspan="4" style="text-align:right">Tổng cộng</th><th class="money">${formatMoney(totalAdvance)}</th><th class="money">${formatMoney(totalRecovered)}</th><th colspan="3"></th></tr>`);
  if ($('recoveredReceiptSummary')) $('recoveredReceiptSummary').textContent = `Tổng số biên lai: ${recoveredReceiptRows.length}; tổng tiền đã thu hồi: ${formatMoney(totalRecovered)}`;
}


function numericReceiptNo(value) {
  const raw = String(value ?? '').replace(/\D/g, '');
  if (!raw) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function listProblemReceipts() {
  if (!['admin', 'thuquy', 'truongphong'].includes(currentUser.role)) {
    return showToast('Tài khoản này không có quyền rà soát phiếu thu.', 'error');
  }
  const from = $('cashbookFrom').value;
  const to = $('cashbookTo').value;
  if (!from || !to) return showToast('Chọn từ ngày và đến ngày trước khi rà soát.', 'error');
  if (from > to) return showToast('Từ ngày không được lớn hơn đến ngày.', 'error');

  const rowsInRange = collectSystemAdvanceRows()
    .filter(r => rowInPrintPeriod(r.dateISO || parseDateToISO(r.date), from, to));

  const receiptMap = new Map();
  rowsInRange.forEach(row => {
    const n = numericReceiptNo(row.receiptNo);
    if (n === null) return;
    if (!receiptMap.has(n)) receiptMap.set(n, []);
    receiptMap.get(n).push(row);
  });

  const problems = [];

  // 1) Phiếu đã nhập vào báo cáo nhưng báo cáo còn nháp/chưa chốt/chưa gửi.
  const addUnfinalized = (row, source) => {
    const iso = row.dateISO || parseDateToISO(row.date);
    if (!rowInPrintPeriod(iso, from, to)) return;
    problems.push({
      receiptNo: row.receiptNo || '',
      predictedDate: row.date || formatDisplayDate(iso),
      amount: Number(row.amount || 0),
      issue: 'Chưa chốt/gửi báo cáo',
      note: source || row.collector || ''
    });
  };

  if (reportHasWorkingData(currentReport) && !['finalized', 'submitted', 'confirmed', 'locked', 'completed'].includes(currentReport.status)) {
    (currentReport.advanceRows || []).forEach(row => addUnfinalized(row, 'Báo cáo đang mở trên màn hình'));
  }

  getReports()
    .filter(report => !['finalized', 'submitted', 'confirmed', 'locked', 'completed'].includes(report.status))
    .forEach(report => (report.advanceRows || []).forEach(row => addUnfinalized(row, `Báo cáo ${report.code || ''} - ${report.createdByName || ''}`)));

  // 2) Phiếu trùng số trong cùng khoảng thời gian.
  Array.from(receiptMap.entries()).forEach(([receiptNo, items]) => {
    if (items.length <= 1) return;
    items.slice(1).forEach(item => {
      problems.push({
        receiptNo: String(receiptNo),
        predictedDate: item.date || formatDisplayDate(item.dateISO),
        amount: Number(item.amount || 0),
        issue: 'Trùng số phiếu thu',
        note: `${item.patientName || ''} - ${item.collector || ''}`
      });
    });
  });

  // 3) Phiếu bị thiếu trong chuỗi số phiếu đã ghi nhận.
  const nums = Array.from(receiptMap.keys()).sort((a, b) => a - b);
  if (nums.length >= 2) {
    const min = nums[0];
    const max = nums[nums.length - 1];
    const maxScan = 3000;
    if (max - min <= maxScan) {
      const numSet = new Set(nums);
      for (let n = min; n <= max; n++) {
        if (numSet.has(n)) continue;
        const prev = nums.filter(x => x < n).pop();
        const next = nums.find(x => x > n);
        const prevRow = prev !== undefined ? receiptMap.get(prev)?.[0] : null;
        const nextRow = next !== undefined ? receiptMap.get(next)?.[0] : null;
        const predictedDate = prevRow?.date || nextRow?.date || '';
        problems.push({
          receiptNo: String(n),
          predictedDate,
          amount: 0,
          issue: 'Thiếu số phiếu trong chuỗi',
          note: 'Chưa có dữ liệu số tiền, cần kiểm tra sổ/biên lai gốc'
        });
      }
    } else {
      problems.push({
        receiptNo: `${min} - ${max}`,
        predictedDate: `${formatDisplayDate(from)} - ${formatDisplayDate(to)}`,
        amount: 0,
        issue: 'Khoảng số phiếu quá rộng',
        note: 'Không tự quét thiếu số để tránh tạo danh sách nhiễu'
      });
    }
  }

  const unique = new Map();
  problems.forEach(item => {
    const key = `${item.receiptNo}|${item.issue}|${item.note}`;
    if (!unique.has(key)) unique.set(key, item);
  });
  problemReceiptRows = Array.from(unique.values()).sort((a, b) => Number(numericReceiptNo(a.receiptNo) ?? 0) - Number(numericReceiptNo(b.receiptNo) ?? 0));

  const total = problemReceiptRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  if ($('problemReceiptSummary')) {
    $('problemReceiptSummary').textContent = `Tổng số dòng vấn đề: ${problemReceiptRows.length}; tổng tiền xác định được: ${formatMoney(total)}`;
  }
  renderProblemReceipts();
  showToast(problemReceiptRows.length ? 'Đã liệt kê phiếu thu có vấn đề.' : 'Không phát hiện phiếu thu có vấn đề.');
}

function renderProblemReceipts() {
  renderTable('problemReceiptTable', ['Số phiếu thu', 'Ngày phiếu thu dự đoán', 'Số tiền', 'Vấn đề', 'Ghi chú'], problemReceiptRows, r => `
    <tr>
      <td>${escapeHtml(r.receiptNo)}</td>
      <td>${escapeHtml(r.predictedDate)}</td>
      <td class="money">${formatMoney(r.amount)}</td>
      <td>${escapeHtml(r.issue)}</td>
      <td>${escapeHtml(r.note || '')}</td>
    </tr>`, 'Chưa rà soát hoặc không có phiếu thu có vấn đề.');
}

function renderUsers() {
  if (!$('usersTable')) return;
  const users = getUsers().sort((a, b) => String(a.username).localeCompare(String(b.username)));
  renderTable('usersTable', ['Tên đăng nhập', 'Họ tên', 'Tên HIS', 'Vai trò', 'Trạng thái', 'Bắt đổi MK', 'Thao tác'], users, u => `
    <tr>
      <td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.fullName)}</td><td>${escapeHtml(u.hisCollectorName)}</td>
      <td>${escapeHtml(roleLabel(u.role))}</td><td>${u.isActive ? 'Hoạt động' : '<b style="color:#c62828">Khóa</b>'}</td>
      <td>${u.mustChangePassword ? 'Có' : 'Không'}</td>
      <td><div class="row-actions">
        <button class="btn small" onclick="editUser('${u.id}')">Sửa</button>
        <button class="btn small" onclick="resetUserPassword('${u.id}')">Reset MK</button>
      </div></td>
    </tr>`);
}

function clearUserForm() {
  ['userId', 'userUsername', 'userPassword', 'userFullName', 'userHisName'].forEach(id => $(id).value = '');
  $('userRole').value = 'ketoan';
  $('userActive').value = 'true';
  $('userMustChange').value = 'true';
  $('userUsername').disabled = false;
}

function editUser(id) {
  const u = getUsers().find(x => x.id === id);
  if (!u) return;
  $('userId').value = u.id;
  $('userUsername').value = u.username;
  $('userUsername').disabled = true;
  $('userPassword').value = '';
  $('userFullName').value = u.fullName || '';
  $('userHisName').value = u.hisCollectorName || '';
  $('userRole').value = u.role;
  $('userActive').value = String(!!u.isActive);
  $('userMustChange').value = String(!!u.mustChangePassword);
}

function saveUser() {
  if (currentUser.role !== 'admin') return showToast('Chỉ admin được quản lý tài khoản.', 'error');
  const users = getUsers();
  const id = $('userId').value;
  const username = $('userUsername').value.trim();
  const password = $('userPassword').value;
  const fullName = $('userFullName').value.trim();
  const role = $('userRole').value;

  if (!username || !fullName || !role) return showToast('Nhập thiếu thông tin tài khoản.', 'error');
  if (!id && users.some(u => normalizeText(u.username) === normalizeText(username))) return showToast('Tên đăng nhập đã tồn tại.', 'error');

  if (id) {
    const u = users.find(x => x.id === id);
    if (!u) return;
    u.fullName = fullName;
    u.role = role;
    u.hisCollectorName = $('userHisName').value.trim();
    u.isActive = $('userActive').value === 'true';
    u.mustChangePassword = $('userMustChange').value === 'true';
    if (password) {
      if (password.length < 6) return showToast('Mật khẩu tạm tối thiểu 6 ký tự.', 'error');
      u.passwordHash = hashPassword(password);
      u.mustChangePassword = true;
    }
    u.updatedAt = nowISO();
  } else {
    if (!password || password.length < 6) return showToast('Mật khẩu tạm tối thiểu 6 ký tự.', 'error');
    users.push({
      id: uid('user'),
      username,
      passwordHash: hashPassword(password),
      fullName,
      role,
      hisCollectorName: $('userHisName').value.trim(),
      isActive: $('userActive').value === 'true',
      mustChangePassword: $('userMustChange').value === 'true',
      createdAt: nowISO(),
      updatedAt: nowISO(),
      lastLoginAt: null
    });
  }

  setUsers(users);
  renderUsers();
  clearUserForm();
  showToast('Đã lưu tài khoản.');
}

function resetUserPassword(id) {
  const newPw = prompt('Nhập mật khẩu tạm mới, tối thiểu 6 ký tự:');
  if (!newPw) return;
  if (newPw.length < 6) return showToast('Mật khẩu tạm tối thiểu 6 ký tự.', 'error');
  const users = getUsers();
  const u = users.find(x => x.id === id);
  if (!u) return;
  u.passwordHash = hashPassword(newPw);
  u.mustChangePassword = true;
  u.updatedAt = nowISO();
  setUsers(users);
  renderUsers();
  showToast('Đã reset mật khẩu. Người dùng sẽ bị bắt đổi mật khẩu khi đăng nhập.');
}

window.editUser = editUser;
window.resetUserPassword = resetUserPassword;

function renderSettings() {
  const settings = loadJson(APP.settings, {});
  $('settingUnitName').value = settings.unitName || 'Trung tâm Y tế khu vực Hàm Thuận Bắc';
}

function saveSettings() {
  saveJson(APP.settings, { unitName: $('settingUnitName').value.trim() || 'Trung tâm Y tế khu vực Hàm Thuận Bắc' });
  $('unitNameText').textContent = $('settingUnitName').value.trim() || 'Trung tâm Y tế khu vực Hàm Thuận Bắc';
  showToast('Đã lưu cấu hình.');
}

function clearTestData() {
  if (!confirm('Xóa toàn bộ dữ liệu báo cáo/hồ sơ test? Tài khoản vẫn giữ lại.')) return;
  [APP.reports, APP.advances, APP.invoices, APP.lostCases, APP.refunds].forEach(k => localStorage.removeItem(k));
  resetReport();
  selectedReceipt = null;
  currentLostCaseId = null;
  lostImagesBase64 = [];
  renderSelectedReceipt();
  refreshAll();
  showToast('Đã xóa dữ liệu test.');
}


function calcReportRemain(report) {
  return Number(report.sumAdvance || 0)
    + Number(report.sumInvoice || 0)
    + Number(report.cashFloat || 0)
    - Number(report.refundAmount || 0);
}

function calcReportCollection(report) {
  return Number(report.sumAdvance || 0)
    + Number(report.sumInvoice || 0)
    + Number(report.cashFloat || 0);
}

function reportSummaryRows(report) {
  return [
    ['Tổng tiền thu tạm ứng viện phí', report.sumAdvance],
    ['Tổng tiền phát hành hóa đơn điện tử', report.sumInvoice],
    ['Tiền mặt ứng quỹ', report.cashFloat],
    ['Tổng tiền tạm ứng thu hồi', Number(report.refundAmount || 0)],
    ['Số tiền còn lại phải nộp thủ quỹ', calcReportRemain(report)]
  ];
}

function makeLostReceiptNote(report) {
  const amount = Number(report.lostReceiptAmount || 0);
  if (!amount) return '';
  const count = (report.selectedLostCaseIds || []).length;
  return `Tiền tạm ứng đã xử lý mất phiếu: ${formatMoney(amount)}${count ? ` (${count} hồ sơ)` : ''}`;
}

function makePrintHeader(title, subtitle = '') {
  const settings = loadJson(APP.settings, {});
  return `
    <div class="print-doc">
      <div class="print-header">
        <img src="logo.png" />
        <div>
          <b>${escapeHtml(settings.unitName || 'Trung tâm Y tế khu vực Hàm Thuận Bắc')}</b><br>
          <span>Phần mềm quản lý tạm ứng viện phí</span>
        </div>
      </div>
      <div class="print-title"><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div>`;
}

function rowInPrintPeriod(rowDateISO, fromISO, toISO) {
  if (!fromISO && !toISO) return true;
  if (!rowDateISO) return false;
  if (fromISO && rowDateISO < fromISO) return false;
  if (toISO && rowDateISO > toISO) return false;
  return true;
}

function amountFromSelectedRefundRows(selectedIds, fromISO, toISO, reportDateISO = '') {
  if (!selectedIds || !selectedIds.length) return null;
  // Thu hồi tạm ứng đi theo NGÀY BÁO CÁO, không đi theo ngày thu ban đầu của biên lai.
  // Vì vậy khi in/lọc theo thời gian, nếu ngày báo cáo nằm trong khoảng thì lấy toàn bộ biên lai đã tích chọn.
  if (reportDateISO && !rowInPrintPeriod(reportDateISO, fromISO, toISO)) return 0;
  const selected = new Set(selectedIds);
  return getReceiptHistoryRows()
    .filter(r => selected.has(r.id))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
}

function amountFromSelectedLostCases(selectedIds, fromISO, toISO) {
  if (!selectedIds || !selectedIds.length) return null;
  const selected = new Set(selectedIds);
  return getLostReceiptHistoryRows()
    .filter(r => selected.has(r.id) && rowInPrintPeriod(r.processDate, fromISO, toISO))
    .reduce((s, r) => s + Number(r.amount || 0), 0);
}

function applyReportPrintPeriod(report) {
  const fromISO = report.printDateFromISO || '';
  const toISO = report.printDateToISO || '';
  const advRows = (report.advanceRows || []).filter(r => rowInPrintPeriod(r.dateISO || parseDateToISO(r.date), fromISO, toISO));
  const invRows = (report.invoiceRows || []).filter(r => rowInPrintPeriod(r.paymentDateISO || parseDateToISO(r.paymentDate), fromISO, toISO));
  const sumAdvance = advRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const sumInvoice = invRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const selectedRefundAmount = amountFromSelectedRefundRows(report.selectedRefundRowIds, fromISO, toISO, report.reportDateISO || (report.createdAt || '').slice(0, 10));
  const selectedLostAmount = amountFromSelectedLostCases(report.selectedLostCaseIds, fromISO, toISO);
  const lostReceiptAmount = selectedLostAmount === null ? Number(report.lostReceiptAmount || 0) : selectedLostAmount;
  const baseRefundAmount = selectedRefundAmount === null ? Number(report.refundAmount || 0) : selectedRefundAmount;
  const refundAmount = selectedRefundAmount === null
    ? (report.refundIncludesLost === true ? Math.max(baseRefundAmount, lostReceiptAmount) : baseRefundAmount + lostReceiptAmount)
    : selectedRefundAmount + lostReceiptAmount;
  const remainPay = sumAdvance + sumInvoice + Number(report.cashFloat || 0) - refundAmount;
  return {
    ...report,
    advanceRows: advRows,
    invoiceRows: invRows,
    sumAdvance,
    sumInvoice,
    refundAmount,
    lostReceiptAmount,
    totalCollection: sumAdvance + sumInvoice + Number(report.cashFloat || 0),
    totalPayable: remainPay,
    remainPay
  };
}

function makeReportHtml(report) {
  report = applyReportPrintPeriod(report);
  const advRows = report.advanceRows || [];
  const invRows = report.invoiceRows || [];
  const sumAdv = advRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const sumInv = invRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const advBody = advRows.map((r, i) => `<tr><td class="center">${i + 1}</td><td class="nowrap">${escapeHtml(r.date)}</td><td class="nowrap">${escapeHtml(r.receiptNo)}</td><td>${escapeHtml(r.patientName)}</td><td class="nowrap">${escapeHtml(r.age)}</td><td class="nowrap">${escapeHtml(r.gender)}</td><td>${escapeHtml(r.department)}</td><td class="money nowrap">${formatMoney(r.amount)}</td><td>${escapeHtml(r.collector)}</td></tr>`).join('') || '<tr><td colspan="9">Không có dữ liệu.</td></tr>';
  const invBody = invRows.map((r, i) => `<tr><td class="center">${i + 1}</td><td class="nowrap">${escapeHtml(r.paymentDate)}</td><td class="nowrap">${escapeHtml(r.invoiceNo)}</td><td>${escapeHtml(r.patientName)}</td><td class="money nowrap">${formatMoney(r.amount)}</td><td>${escapeHtml(r.issuer)}</td></tr>`).join('') || '<tr><td colspan="6">Không có dữ liệu.</td></tr>';

  return `${makePrintHeader('Báo cáo nộp tạm ứng viện phí và phát hành hóa đơn điện tử', `Từ ngày ${escapeHtml(report.dateFrom || '')} đến ngày ${escapeHtml(report.dateTo || '')}`)}
    <p><b>Người lập:</b> ${escapeHtml(report.createdByName)} &nbsp; <b>Mã báo cáo:</b> ${escapeHtml(report.code)} &nbsp; <b>Ngày báo cáo:</b> ${escapeHtml(report.reportDate || formatPrintDate(report.reportDateISO || ''))} &nbsp; <b>Trạng thái:</b> ${escapeHtml(statusLabel(report.status))}</p>
    <h3>I. Thu tạm ứng viện phí</h3>
    <table class="print-table print-advance-table"><colgroup><col style="width:4%"><col style="width:9%"><col style="width:8%"><col style="width:18%"><col style="width:7%"><col style="width:6%"><col style="width:20%"><col style="width:10%"><col style="width:18%"></colgroup><thead><tr><th>STT</th><th>Ngày thu</th><th>Phiếu thu</th><th>Họ tên</th><th>Tuổi</th><th>Giới tính</th><th>Khoa/phòng</th><th>Số tiền</th><th>Người thu</th></tr></thead>
      <tbody>${advBody}</tbody>
      <tfoot><tr><th colspan="7" style="text-align:right">Tổng cộng</th><th style="text-align:right">${formatMoney(sumAdv)}</th><th></th></tr></tfoot></table>
    <h3>II. Phát hành hóa đơn điện tử</h3>
    <table class="print-table print-invoice-table"><colgroup><col style="width:6%"><col style="width:14%"><col style="width:14%"><col style="width:30%"><col style="width:15%"><col style="width:21%"></colgroup><thead><tr><th>STT</th><th>Ngày thanh toán</th><th>Số HĐĐT</th><th>Tên bệnh nhân</th><th>Số tiền</th><th>Người phát hành</th></tr></thead>
      <tbody>${invBody}</tbody>
      <tfoot><tr><th colspan="4" style="text-align:right">Tổng cộng</th><th style="text-align:right">${formatMoney(sumInv)}</th><th></th></tr></tfoot></table>
    <h3>III. Tổng hợp</h3>
    <table class="print-summary"><tbody>${reportSummaryRows(report).map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td style="text-align:right"><b>${formatMoney(value)}</b></td></tr>`).join('')}</tbody></table>
    <p><b>Ghi chú:</b> ${escapeHtml([report.note || '', makeLostReceiptNote(report)].filter(Boolean).join(' | '))}</p>
    ${report.treasurerName ? `<p><b>Thủ quỹ xác nhận:</b> ${escapeHtml(report.treasurerName)} ${report.confirmedAt ? `- ${new Date(report.confirmedAt).toLocaleString('vi-VN')}` : ''}</p>` : ''}
    <div class="print-sign"><div><b>Kế toán viên</b><br><br><br><br>${escapeHtml(report.createdByName || '')}</div><div><b>Thủ quỹ</b><br><br><br><br>${escapeHtml(report.treasurerName || '')}</div></div>
    </div>`;
}

function printHtml(html) {
  $('printArea').innerHTML = html;
  setTimeout(() => window.print(), 80);
}

function previewHtml(html) {
  const win = window.open('', '_blank');
  if (!win) {
    $('printArea').innerHTML = html;
    showToast('Trình duyệt chặn cửa sổ xem trước. Đã đưa nội dung vào vùng in.', 'warn');
    return;
  }
  win.document.open();
  win.document.write(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Xem trước báo cáo</title><link rel="stylesheet" href="style.css"><style>body{background:#fff;padding:18px}.preview-actions{position:sticky;top:0;background:#fff;padding:8px;text-align:right;border-bottom:1px solid #d8e6dc;margin-bottom:10px}.print-area{display:block}.print-doc{display:block;max-width:1000px;margin:0 auto}@media print{.preview-actions{display:none}}</style></head><body><div class="preview-actions"><button onclick="window.print()" style="padding:8px 14px;border-radius:10px;border:1px solid #0b8f43;background:#0b8f43;color:#fff;font-weight:700;cursor:pointer">In báo cáo</button></div>${html}</body></html>`);
  win.document.close();
}

function formatPrintDate(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const vn = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (vn) return `${vn[1].padStart(2, '0')}/${vn[2].padStart(2, '0')}/${vn[3]}`;
  return s;
}

function toDateInputValue(value) {
  const s = String(value || '').trim();
  if (!s) return todayISO();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  const vn = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (vn) return `${vn[3]}-${vn[2].padStart(2, '0')}-${vn[1].padStart(2, '0')}`;
  return todayISO();
}


function reportRowMatchesCurrentUser(row, fieldName) {
  if (currentUser.role === 'admin' && !currentUser.hisCollectorName) return true;
  if (!currentHisNameKey()) return true;
  return normalizeText(row?.[fieldName]) === currentHisNameKey();
}


function lostCaseMatchesCurrentUser(item) {
  if (currentUser.role === 'admin' && !currentUser.hisCollectorName) return true;
  return item.createdBy === currentUser.id || normalizeText(item.createdByName) === normalizeText(currentUser.fullName);
}

function collectCompletedLostCasesForCurrentUser(fromISO, toISO) {
  return getLostCases()
    .filter(item => ['completed', 'confirmed'].includes(item.status))
    .filter(lostCaseMatchesCurrentUser)
    .filter(item => rowInPrintPeriod(item.processDate || (item.completedAt || item.updatedAt || item.createdAt || '').slice(0, 10), fromISO, toISO))
    .sort((a, b) => String(a.processDate || '').localeCompare(String(b.processDate || '')) || String(a.receiptNo || '').localeCompare(String(b.receiptNo || '')));
}

function addUniqueByKey(map, row, key) {
  if (!key) return;
  if (!map.has(key)) map.set(key, row);
}

function collectSystemAdvanceRows() {
  const map = new Map();
  (currentReport.advanceRows || []).forEach(row => addUniqueByKey(map, row, advanceKey(row)));
  getAdvances().forEach(row => addUniqueByKey(map, row, advanceKey(row)));
  getReports().forEach(report => {
    (report.advanceRows || []).forEach(row => addUniqueByKey(map, row, advanceKey(row)));
  });
  return Array.from(map.values());
}

function invoiceKey(row) {
  return `${normalizeText(row.invoiceNo)}|${normalizeText(row.patientName)}|${row.paymentDateISO || row.paymentDate}`;
}

function collectSystemInvoiceRows() {
  const map = new Map();
  (currentReport.invoiceRows || []).forEach(row => addUniqueByKey(map, row, invoiceKey(row)));
  getInvoices().forEach(row => addUniqueByKey(map, row, invoiceKey(row)));
  getReports().forEach(report => {
    (report.invoiceRows || []).forEach(row => addUniqueByKey(map, row, invoiceKey(row)));
  });
  return Array.from(map.values());
}

function makeWorkingReportForPeriod(fromISO, toISO, reportDateISO = todayISO()) {
  // Giữ hàm này cho chức năng xem trước/in theo khoảng thời gian.
  // Riêng Tạo báo cáo mới sẽ dùng makeWorkingReportForDate() để lấy TẤT CẢ dữ liệu đã lưu.
  const advanceRows = collectSystemAdvanceRows()
    .filter(row => reportRowMatchesCurrentUser(row, 'collector'))
    .filter(row => rowInPrintPeriod(row.dateISO || parseDateToISO(row.date), fromISO, toISO))
    .sort((a, b) => String(a.dateISO || parseDateToISO(a.date)).localeCompare(String(b.dateISO || parseDateToISO(b.date))) || String(a.receiptNo || '').localeCompare(String(b.receiptNo || '')));

  const invoiceRows = collectSystemInvoiceRows()
    .filter(row => reportRowMatchesCurrentUser(row, 'issuer'))
    .filter(row => rowInPrintPeriod(row.paymentDateISO || parseDateToISO(row.paymentDate), fromISO, toISO))
    .sort((a, b) => String(a.paymentDateISO || parseDateToISO(a.paymentDate)).localeCompare(String(b.paymentDateISO || parseDateToISO(b.paymentDate))) || String(a.invoiceNo || '').localeCompare(String(b.invoiceNo || '')));

  const lostRows = collectCompletedLostCasesForCurrentUser(reportDateISO, reportDateISO);
  const lostReceiptAmount = lostRows.reduce((s, r) => s + Number(r.amount || 0), 0);

  return {
    ...emptyReport(),
    advanceRows,
    invoiceRows,
    refundAmount: lostReceiptAmount,
    lostReceiptAmount,
    selectedLostCaseIds: lostRows.map(r => r.id),
    refundIncludesLost: true,
    createdBy: currentUser.id,
    createdByName: currentUser.fullName,
    dateFrom: formatPrintDate(fromISO),
    dateTo: formatPrintDate(toISO),
    reportDateISO,
    reportDate: formatPrintDate(reportDateISO),
    printDateFromISO: fromISO,
    printDateToISO: toISO
  };
}

function makeWorkingReportForDate(reportDateISO = todayISO()) {
  // Tạo báo cáo mới: chỉ chọn ngày báo cáo, còn dữ liệu lấy TẤT CẢ thông tin đã lưu trên hệ thống.
  const advanceRows = collectSystemAdvanceRows()
    .filter(row => reportRowMatchesCurrentUser(row, 'collector'))
    .sort((a, b) => String(a.dateISO || parseDateToISO(a.date)).localeCompare(String(b.dateISO || parseDateToISO(b.date))) || String(a.receiptNo || '').localeCompare(String(b.receiptNo || '')));

  const invoiceRows = collectSystemInvoiceRows()
    .filter(row => reportRowMatchesCurrentUser(row, 'issuer'))
    .sort((a, b) => String(a.paymentDateISO || parseDateToISO(a.paymentDate)).localeCompare(String(b.paymentDateISO || parseDateToISO(b.paymentDate))) || String(a.invoiceNo || '').localeCompare(String(b.invoiceNo || '')));

  const lostRows = collectCompletedLostCasesForCurrentUser(reportDateISO, reportDateISO);
  const lostReceiptAmount = lostRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);

  return {
    ...emptyReport(),
    advanceRows,
    invoiceRows,
    refundAmount: lostReceiptAmount,
    lostReceiptAmount,
    selectedLostCaseIds: lostRows.map(row => row.id),
    refundIncludesLost: true,
    createdBy: currentUser.id,
    createdByName: currentUser.fullName,
    dateFrom: '',
    dateTo: '',
    reportDateISO,
    reportDate: formatPrintDate(reportDateISO),
    printDateFromISO: '',
    printDateToISO: ''
  };
}

function buildWorkingReportForDate(reportDateISO = todayISO()) {
  currentReport = makeWorkingReportForDate(reportDateISO);
  $('refundAmount').value = currentReport.refundAmount ? formatMoney(currentReport.refundAmount) : '';
  $('lostReceiptAmount').value = currentReport.lostReceiptAmount ? formatMoney(currentReport.lostReceiptAmount) : '';
  $('cashFloat').value = '';
  $('reportNote').value = '';
  renderReportTables();
  updateReportTotals();
  setActiveTab('tabReport');

  const msg = `Đã tạo báo cáo mới ngày ${formatPrintDate(reportDateISO)}: ${currentReport.advanceRows.length} dòng tạm ứng, ${currentReport.invoiceRows.length} dòng HĐĐT, ${(currentReport.selectedLostCaseIds || []).length} hồ sơ mất phiếu.`;
  showToast(msg, currentReport.advanceRows.length || currentReport.invoiceRows.length || currentReport.lostReceiptAmount ? '' : 'warn');
}

function buildWorkingReportForPeriod(fromISO, toISO, reportDateISO = todayISO()) {
  // Hàm cũ giữ lại để tương thích, nhưng thao tác tạo mới hiện dùng buildWorkingReportForDate().
  return buildWorkingReportForDate(reportDateISO);
}

function openBuildReportPeriodModal() {
  pendingPrintReport = null;
  periodModalMode = 'build';
  const fromEl = $('printDateFrom');
  const toEl = $('printDateTo');
  const reportDateEl = $('periodReportDate');
  const reportDateBox = $('periodReportDateBox');
  if (fromEl) {
    fromEl.value = '';
    fromEl.parentElement?.classList.add('hidden');
  }
  if (toEl) {
    toEl.value = '';
    toEl.parentElement?.classList.add('hidden');
  }
  if (reportDateEl) reportDateEl.value = currentReport.reportDateISO || todayISO();
  if (reportDateBox) reportDateBox.classList.remove('hidden');
  const title = $('periodModalTitle');
  const desc = $('periodModalDesc');
  const confirmBtn = $('btnConfirmPrintPeriod');
  if (title) title.textContent = 'Chọn ngày tạo báo cáo mới';
  if (desc) desc.textContent = 'Chỉ chọn ngày báo cáo. Dữ liệu lập báo cáo sẽ lấy toàn bộ thông tin đã lưu trên hệ thống theo tài khoản đang làm việc.';
  if (confirmBtn) confirmBtn.textContent = 'Tạo báo cáo mới';
  $('printPeriodModal').classList.remove('hidden');
  setTimeout(() => reportDateEl?.focus(), 50);
}

function openPrintPeriodModal(report) {
  periodModalMode = 'print';
  pendingPrintReport = { ...report };
  pendingPreviewReport = null;
  const fromEl = $('printDateFrom');
  const toEl = $('printDateTo');
  const reportDateBox = $('periodReportDateBox');
  if (reportDateBox) reportDateBox.classList.add('hidden');
  if (fromEl) { fromEl.parentElement?.classList.remove('hidden'); fromEl.value = toDateInputValue(report.dateFrom); }
  if (toEl) { toEl.parentElement?.classList.remove('hidden'); toEl.value = toDateInputValue(report.dateTo); }
  const title = $('periodModalTitle');
  const desc = $('periodModalDesc');
  const confirmBtn = $('btnConfirmPrintPeriod');
  if (title) title.textContent = 'Chọn thời gian in báo cáo';
  if (desc) desc.textContent = 'Nhập khoảng thời gian sẽ hiển thị và lọc dữ liệu trên báo cáo in.';
  if (confirmBtn) confirmBtn.textContent = 'In báo cáo';
  $('printPeriodModal').classList.remove('hidden');
  setTimeout(() => fromEl?.focus(), 50);
}

function openPreviewPeriodModal(report) {
  periodModalMode = 'preview';
  pendingPreviewReport = { ...report };
  pendingPrintReport = null;
  const fromEl = $('printDateFrom');
  const toEl = $('printDateTo');
  const reportDateBox = $('periodReportDateBox');
  if (reportDateBox) reportDateBox.classList.add('hidden');
  if (fromEl) { fromEl.parentElement?.classList.remove('hidden'); fromEl.value = toDateInputValue(report.dateFrom); }
  if (toEl) { toEl.parentElement?.classList.remove('hidden'); toEl.value = toDateInputValue(report.dateTo); }
  const title = $('periodModalTitle');
  const desc = $('periodModalDesc');
  const confirmBtn = $('btnConfirmPrintPeriod');
  if (title) title.textContent = 'Chọn thời gian xem trước báo cáo';
  if (desc) desc.textContent = 'Báo cáo xem trước sẽ lọc dữ liệu theo khoảng thời gian và tài khoản đang làm việc.';
  if (confirmBtn) confirmBtn.textContent = 'Xem trước';
  $('printPeriodModal').classList.remove('hidden');
  setTimeout(() => fromEl?.focus(), 50);
}

function closePrintPeriodModal() {
  pendingPrintReport = null;
  pendingPreviewReport = null;
  periodModalMode = 'print';
  $('periodReportDateBox')?.classList.add('hidden');
  $('printDateFrom')?.parentElement?.classList.remove('hidden');
  $('printDateTo')?.parentElement?.classList.remove('hidden');
  $('printPeriodModal')?.classList.add('hidden');
}

function confirmPrintPeriodAndPrint() {
  const from = $('printDateFrom')?.value || '';
  const to = $('printDateTo')?.value || '';

  if (periodModalMode === 'build') {
    const reportDate = $('periodReportDate')?.value || todayISO();
    closePrintPeriodModal();
    reportInputEnabled = true;
    resetReport(true);
    buildWorkingReportForDate(reportDate);
    applyRoleControls();
    return;
  }

  if (!from || !to) return showToast('Nhập đủ từ ngày và đến ngày.', 'error');
  if (from > to) return showToast('Từ ngày không được lớn hơn đến ngày.', 'error');

  if (periodModalMode === 'preview') {
    const base = reportHasWorkingData(currentReport) ? scopeReportForCurrentUser(buildReportObject(currentReport.status || 'draft')) : makeWorkingReportForPeriod(from, to, currentReport.reportDateISO || todayISO());
    const report = {
      ...base,
      printDateFromISO: from,
      printDateToISO: to,
      dateFrom: formatPrintDate(from),
      dateTo: formatPrintDate(to)
    };
    closePrintPeriodModal();
    previewHtml(makeReportHtml(report));
    return;
  }

  if (!pendingPrintReport) return closePrintPeriodModal();
  const report = {
    ...pendingPrintReport,
    printDateFromISO: from,
    printDateToISO: to,
    dateFrom: formatPrintDate(from),
    dateTo: formatPrintDate(to)
  };
  closePrintPeriodModal();
  printHtml(makeReportHtml(report));
}

function printCurrentReport() {
  openPrintPeriodModal(scopeReportForCurrentUser(buildReportObject(currentReport.status || 'draft')));
}

function previewCurrentReport() {
  openPreviewPeriodModal(scopeReportForCurrentUser(buildReportObject(currentReport.status || 'draft')));
}

function printReportById(id) {
  const savedReport = getReports().find(r => r.id === id);
  if (!savedReport) return showToast('Không tìm thấy báo cáo.', 'error');
  openPrintPeriodModal(scopeReportForCurrentUser(savedReport));
}

window.printReportById = printReportById;

function makeLostCaseHtml(item) {
  return `${makePrintHeader('Chứng từ xử lý mất giấy tạm ứng viện phí', `Mã hồ sơ: ${escapeHtml(item.code)}`)}
    <table><tbody>
      <tr><td>Số phiếu thu</td><td><b>${escapeHtml(item.receiptNo)}</b></td><td>Ngày thu</td><td>${escapeHtml(item.receiptDate)}</td></tr>
      <tr><td>Họ tên bệnh nhân/người nộp</td><td>${escapeHtml(item.patientName)}</td><td>Tuổi</td><td>${escapeHtml(item.age)}</td></tr>
      <tr><td>Khoa/phòng</td><td>${escapeHtml(item.department)}</td><td>Số tiền</td><td style="text-align:right"><b>${formatMoney(item.amount)}</b></td></tr>
      <tr><td>Người yêu cầu xử lý</td><td>${escapeHtml(item.requester)}</td><td>Số CCCD/giấy tờ</td><td>${escapeHtml(item.idNo)}</td></tr>
      <tr><td>Ngày xử lý mất phiếu</td><td>${escapeHtml(item.processDate ? new Date(item.processDate).toLocaleDateString('vi-VN') : '')}</td><td>Trạng thái</td><td>${escapeHtml(statusLabel(item.status))}</td></tr>
      <tr><td>Lý do mất phiếu</td><td colspan="3">${escapeHtml(item.reason)}</td></tr>
      <tr><td>Ghi chú</td><td colspan="3">${escapeHtml(item.note || '')}</td></tr>
    </tbody></table>
    <p><b>Ảnh hồ sơ đã lưu:</b> ${(item.images || []).length} ảnh.</p>
    ${item.treasurerName ? `<p><b>Thủ quỹ xác nhận:</b> ${escapeHtml(item.treasurerName)}</p>` : ''}
    <div class="print-sign"><div><b>Người lập hồ sơ</b><br><br><br><br>${escapeHtml(item.createdByName || '')}</div><div><b>Thủ quỹ</b><br><br><br><br>${escapeHtml(item.treasurerName || '')}</div></div>
    </div>`;
}

function printCurrentLostCase() {
  if (!selectedReceipt) return showToast('Chưa chọn hồ sơ mất phiếu.', 'error');
  if (!lostImagesBase64.length) return showToast('Cần upload hình ảnh hồ sơ trước khi in chứng từ xử lý mất phiếu.', 'error');
  const temp = {
    code: currentLostCaseId ? (getLostCases().find(x => x.id === currentLostCaseId)?.code || '') : 'Chưa lưu',
    receiptNo: selectedReceipt.receiptNo,
    receiptDate: selectedReceipt.date,
    patientName: selectedReceipt.patientName,
    age: selectedReceipt.age,
    amount: selectedReceipt.amount,
    department: selectedReceipt.department,
    requester: $('lostRequester').value,
    idNo: $('lostIdNo').value,
    processDate: $('lostProcessDate').value || todayISO(),
    reason: $('lostReason').value,
    note: $('lostNote').value,
    status: currentLostCaseId ? (getLostCases().find(x => x.id === currentLostCaseId)?.status || 'draft') : 'draft',
    images: lostImagesBase64,
    createdByName: currentUser.fullName
  };
  printHtml(makeLostCaseHtml(temp));
}

function printLostCaseById(id) {
  const item = getLostCases().find(x => x.id === id);
  if (!item) return showToast('Không tìm thấy hồ sơ.', 'error');
  printHtml(makeLostCaseHtml(item));
}

window.printLostCaseById = printLostCaseById;


function makeRecoveredReceiptsHtml() {
  const from = $('cashbookFrom').value;
  const to = $('cashbookTo').value;
  const totalAdvance = recoveredReceiptRows.reduce((s, r) => s + Number(r.amountAdvance || 0), 0);
  const totalRecovered = recoveredReceiptRows.reduce((s, r) => s + Number(r.amountRecovered || 0), 0);
  const body = recoveredReceiptRows.map(r => `<tr><td>${escapeHtml(r.receiptNo)}</td><td>${escapeHtml(r.receiptDate)}</td><td>${escapeHtml(r.patientName)}</td><td>${escapeHtml(r.age)}</td><td style="text-align:right">${formatMoney(r.amountAdvance)}</td><td style="text-align:right">${formatMoney(r.amountRecovered)}</td><td>${escapeHtml(r.payDate)}</td><td>${escapeHtml(r.payer)}</td><td>${escapeHtml(r.note || '')}</td></tr>`).join('') || '<tr><td colspan="9">Không có dữ liệu.</td></tr>';
  const totalRow = `<tr class="print-total-row"><th colspan="4" style="text-align:right">Tổng cộng</th><th style="text-align:right">${formatMoney(totalAdvance)}</th><th style="text-align:right">${formatMoney(totalRecovered)}</th><th colspan="3"></th></tr>`;
  return `${makePrintHeader('Danh sách biên lai đã thu hồi tạm ứng', `Từ ngày ${escapeHtml(from)} đến ngày ${escapeHtml(to)}`)}
    <table class="cashbook-print-table"><thead><tr><th>Số phiếu thu</th><th>Ngày thu</th><th>Họ tên bệnh nhân</th><th>Tuổi</th><th>Số tiền đã tạm ứng</th><th>Số tiền đã thu hồi</th><th>Ngày thu hồi</th><th>Người thu hồi</th><th>Ghi chú</th></tr></thead>
      <tbody>${body}${recoveredReceiptRows.length ? totalRow : ''}</tbody>
    </table>
    <div class="print-sign"><div><b>Người lập</b><br><br><br><br></div><div><b>Thủ quỹ</b><br><br><br><br>${escapeHtml(currentUser.fullName || '')}</div></div>
    </div>`;
}

function makeCashbookHtml() {
  const from = $('cashbookFrom').value;
  const to = $('cashbookTo').value;
  const totalAdvance = cashbookRows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const totalPaid = cashbookRows.reduce((s, r) => s + Number(r.paidAtEnd || 0), 0);
  const totalRemain = cashbookRows.reduce((s, r) => s + Number(r.remaining || 0), 0);
  const detailRows = cashbookRows.map(r => `<tr><td>${escapeHtml(r.receiptNo)}</td><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.patientName)}</td><td>${escapeHtml(r.age)}</td><td style="text-align:right">${formatMoney(r.amount)}</td><td style="text-align:right">${formatMoney(r.paidAtEnd)}</td><td>${escapeHtml(r.payDateText || '')}</td><td style="text-align:right">${formatMoney(r.remaining)}</td><td>${escapeHtml(r.note || '')}</td></tr>`).join('') || '<tr><td colspan="9">Không có dữ liệu.</td></tr>';
  const totalRow = `<tr class="print-total-row"><th colspan="4" style="text-align:right">Tổng cộng</th><th style="text-align:right">${formatMoney(totalAdvance)}</th><th style="text-align:right">${formatMoney(totalPaid)}</th><th></th><th style="text-align:right">${formatMoney(totalRemain)}</th><th></th></tr>`;
  return `${makePrintHeader('Báo cáo thu chi tạm ứng viện phí', `Từ ngày ${escapeHtml(from)} đến ngày ${escapeHtml(to)}`)}
    <table class="cashbook-print-table"><thead><tr><th>Số phiếu thu</th><th>Ngày thu</th><th>Họ tên bệnh nhân</th><th>Tuổi</th><th>Số tiền đã tạm ứng</th><th>Đã trả tạm ứng</th><th>Ngày trả</th><th>Còn lại</th><th>Ghi chú</th></tr></thead>
      <tbody>${detailRows}${cashbookRows.length ? totalRow : ''}</tbody>
    </table>
    <div class="print-sign"><div><b>Người lập</b><br><br><br><br></div><div><b>Thủ quỹ</b><br><br><br><br>${escapeHtml(currentUser.fullName || '')}</div></div>
    </div>`;
}

function exportCsv(filename, rows) {
  const csv = rows.map(row => row.map(cell => {
    const value = String(cell ?? '').replaceAll('"', '""');
    return `"${value}"`;
  }).join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCurrentReportCsv() {
  const report = scopeReportForCurrentUser(buildReportObject(currentReport.status || 'draft'));
  const rows = [];
  rows.push(['BÁO CÁO NỘP TẠM ỨNG VIỆN PHÍ VÀ PHÁT HÀNH HĐĐT']);
  rows.push(['Người lập', report.createdByName, 'Từ ngày', report.dateFrom, 'Đến ngày', report.dateTo]);
  rows.push([]);
  rows.push(['I. Thu tạm ứng']);
  rows.push(['Ngày thu', 'Phiếu thu', 'Họ tên', 'Tuổi', 'Giới tính', 'Khoa/phòng', 'Số tiền', 'Người thu']);
  report.advanceRows.forEach(r => rows.push([r.date, r.receiptNo, r.patientName, r.age, r.gender, r.department, r.amount, r.collector]));
  rows.push(['', '', '', '', '', 'Tổng cộng', report.sumAdvance, '']);
  rows.push([]);
  rows.push(['II. HĐĐT']);
  rows.push(['Ngày thanh toán', 'Số HĐĐT', 'Tên bệnh nhân', 'Số tiền', 'Người phát hành']);
  report.invoiceRows.forEach(r => rows.push([r.paymentDate, r.invoiceNo, r.patientName, r.amount, r.issuer]));
  rows.push(['', '', 'Tổng cộng', report.sumInvoice, '']);
  rows.push([]);
  rows.push(['III. Tổng hợp']);
  reportSummaryRows(report).forEach(r => rows.push(r));
  const lostNote = makeLostReceiptNote(report);
  if (lostNote) rows.push(['Ghi chú xử lý mất phiếu', lostNote]);
  exportCsv(`bao-cao-tam-ung-hddt-${todayISO()}.csv`, rows);
}

function exportCashbookCsv() {
  const rows = [['Số phiếu thu', 'Ngày thu', 'Họ tên bệnh nhân', 'Tuổi', 'Số tiền đã tạm ứng', 'Đã trả tạm ứng', 'Ngày trả', 'Còn lại', 'Ghi chú']];
  cashbookRows.forEach(r => rows.push([r.receiptNo, r.date, r.patientName, r.age, r.amount, r.paidAtEnd, r.payDateText || '', r.remaining, r.note || '']));
  exportCsv(`bao-cao-thu-chi-tam-ung-${todayISO()}.csv`, rows);
}

function openPasswordModal() {
  $('passwordModal').classList.remove('hidden');
  $('modalCurrentPassword').value = '';
  $('modalNewPassword').value = '';
  $('modalConfirmPassword').value = '';
}

function closePasswordModal() {
  $('passwordModal').classList.add('hidden');
}

function bindEvents() {
  $('btnLogin').addEventListener('click', login);
  $('loginPassword').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('btnBackLogin').addEventListener('click', showLogin);
  $('btnForceChangePassword').addEventListener('click', () => {
    if (!pendingChangeUser) return;
    changePasswordForUser(pendingChangeUser.id, $('cpCurrent').value, $('cpNew').value, $('cpConfirm').value, true);
  });

  $('tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (btn) setActiveTab(btn.dataset.tab);
  });

  $('btnLogout').addEventListener('click', guardedLogout);
  $('btnOpenChangePassword').addEventListener('click', openPasswordModal);
  $('btnClosePasswordModal').addEventListener('click', closePasswordModal);
  $('btnChangePassword').addEventListener('click', () => changePasswordForUser(currentUser.id, $('modalCurrentPassword').value, $('modalNewPassword').value, $('modalConfirmPassword').value, false));
  if ($('btnClosePrintPeriodModal')) $('btnClosePrintPeriodModal').addEventListener('click', closePrintPeriodModal);
  if ($('btnCancelPrintPeriod')) $('btnCancelPrintPeriod').addEventListener('click', closePrintPeriodModal);
  if ($('btnConfirmPrintPeriod')) $('btnConfirmPrintPeriod').addEventListener('click', confirmPrintPeriodAndPrint);
  if ($('printPeriodModal')) $('printPeriodModal').addEventListener('click', e => { if (e.target.id === 'printPeriodModal') closePrintPeriodModal(); });

  $('btnReadAdvance').addEventListener('click', importAdvanceFile);
  $('btnReadInvoice').addEventListener('click', importInvoiceFile);
  $('btnClearAdvanceFile').addEventListener('click', clearAdvanceFile);
  $('btnClearInvoiceFile').addEventListener('click', clearInvoiceFile);
  $('btnBuildReport').addEventListener('click', startNewReport);
  $('btnFinalizeReport').addEventListener('click', finalizeCurrentReport);
  $('btnPreviewReport').addEventListener('click', previewCurrentReport);
  $('btnSubmitReport').addEventListener('click', () => { if (saveCurrentReport('submitted')) { reportInputEnabled = false; applyRoleControls(); } });

  $('btnReloadReports').addEventListener('click', renderMyReports);
  $('advanceSearch').addEventListener('input', renderReportTables);
  $('invoiceSearch').addEventListener('input', renderReportTables);
  ['refundAmount', 'lostReceiptAmount', 'cashFloat'].forEach(id => $(id).addEventListener('input', updateReportTotals));
  $('refundAmount').addEventListener('click', openReceiptHistoryModal);
  $('refundAmount').addEventListener('focus', openReceiptHistoryModal);
  $('lostReceiptAmount').addEventListener('click', openLostReceiptHistoryModal);
  $('lostReceiptAmount').addEventListener('focus', openLostReceiptHistoryModal);
  if ($('btnCloseReceiptModal')) $('btnCloseReceiptModal').addEventListener('click', closeReceiptHistoryModal);
  if ($('receiptHistorySearch')) $('receiptHistorySearch').addEventListener('input', renderReceiptHistory);
  if ($('btnUseReceiptHistoryTotal')) $('btnUseReceiptHistoryTotal').addEventListener('click', useReceiptHistoryTotal);
  // Không đóng popup thu hồi tạm ứng khi click/drag ra ngoài, tránh mất thao tác khi người dùng bôi đen ô tìm kiếm.
  if ($('receiptModal')) $('receiptModal').addEventListener('click', e => { /* đóng bằng nút X */ });
  if ($('btnCloseLostReceiptModal')) $('btnCloseLostReceiptModal').addEventListener('click', closeLostReceiptHistoryModal);
  if ($('lostReceiptHistorySearch')) $('lostReceiptHistorySearch').addEventListener('input', renderLostReceiptHistory);
  if ($('btnUseLostReceiptTotal')) $('btnUseLostReceiptTotal').addEventListener('click', useLostReceiptHistoryTotal);
  if ($('lostReceiptModal')) $('lostReceiptModal').addEventListener('click', e => { /* đóng bằng nút X */ });

  $('btnSearchReceipt').addEventListener('click', searchReceipts);
  $('lostSearchInput').addEventListener('keydown', e => { if (e.key === 'Enter') searchReceipts(); });
  $('lostImages').addEventListener('change', async () => {
    const imgs = await readLostImages();
    if (imgs.length) lostImagesBase64 = lostImagesBase64.concat(imgs);
    $('lostImages').value = '';
    renderLostImagePreview();
  });
  $('btnSaveLostCase').addEventListener('click', () => saveLostCase('completed'));
  $('btnPrintLostCase').addEventListener('click', printCurrentLostCase);
  $('btnReloadLostCases').addEventListener('click', renderLostCases);

  $('btnReloadTreasurerReports').addEventListener('click', renderTreasurerReports);
  $('btnReloadTreasurerLost').addEventListener('click', renderTreasurerLostCases);
  $('btnAddRefund').addEventListener('click', addRefund);
  $('btnBuildCashbook').addEventListener('click', buildCashbook);
  if ($('btnBuildRecoveredReceipts')) $('btnBuildRecoveredReceipts').addEventListener('click', buildRecoveredReceiptsReport);
  if ($('btnPrintRecoveredReceipts')) $('btnPrintRecoveredReceipts').addEventListener('click', () => { if (!recoveredReceiptRows.length) buildRecoveredReceiptsReport(); if (recoveredReceiptRows.length) printHtml(makeRecoveredReceiptsHtml()); });
  $('btnPrintCashbook').addEventListener('click', () => { if (!cashbookRows.length) buildCashbook(); printHtml(makeCashbookHtml()); });
  $('btnExportCashbook').addEventListener('click', () => { if (!cashbookRows.length) buildCashbook(); exportCashbookCsv(); });
  if ($('btnListProblemReceipts')) $('btnListProblemReceipts').addEventListener('click', listProblemReceipts);

  $('btnUserNew').addEventListener('click', clearUserForm);
  $('btnUserSave').addEventListener('click', saveUser);
  $('btnReloadUsers').addEventListener('click', renderUsers);
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnClearTestData').addEventListener('click', clearTestData);

  $$('.money-input').forEach(input => {
    input.addEventListener('blur', () => {
      const n = parseMoney(input.value);
      input.value = n ? formatMoney(n) : '';
      updateReportTotals();
    });
  });
}

async function boot() {
  bindEvents();

  // Nếu có Firebase thì kéo dữ liệu cloud xuống trước, rồi mới dựng dữ liệu mặc định.
  // Nếu không có mạng/rules chưa đúng, phần mềm vẫn chạy localStorage như trước.
  await pullAllFromFirebase();
  ensureDefaultData();

  // Nếu Firebase đang trống, đẩy dữ liệu mặc định/local hiện có lên để khởi tạo kho dữ liệu.
  if (firebaseAvailable()) pushAllToFirebase();

  currentUser = readSession();
  if (currentUser) showApp(); else showLogin();
}

document.addEventListener('DOMContentLoaded', boot);

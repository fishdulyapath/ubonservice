const express = require('express');
const router = express.Router();
const { pool, query } = require('../db');

function envFlag(...names) {
  return names.some((name) => ['true', '1', 'yes', 'on'].includes(String(process.env[name] || '').trim().toLowerCase()));
}

function tigerMockEnabled() {
  return envFlag('TIGER_MOCK', 'TIGER_PENDING_MOCK', 'VITE_TIGER_MOCK', 'VITE_TIGER_PENDING_MOCK');
}

// อ่าน config Tiger จาก erp_option แทน env
// ถ้าไม่มีข้อมูล → ระบบ Tiger ปิด → endpoint ทุกตัวจะคืน 503
async function loadTigerConfig() {
  const envEndPoint = (process.env.TIGER_API_URL || process.env.TIGER_END_POINT || '').trim();
  const envAppId = (process.env.TIGER_APP_ID || '').trim();
  const envApiKey = (process.env.TIGER_API_KEY || process.env.TIGER_X_API_KEY || '').trim();
  if (envEndPoint && envAppId && envApiKey) {
    return { appId: envAppId, endPoint: envEndPoint, apiKey: envApiKey };
  }

  const result = await query(
    'SELECT tiger_app_id, tiger_end_point, tiger_x_api_key FROM erp_option LIMIT 1',
  );
  const row = result.rows[0];
  if (!row) return null;
  const appId = (row.tiger_app_id || '').trim();
  const endPoint = (row.tiger_end_point || '').trim();
  const apiKey = (row.tiger_x_api_key || '').trim();
  if (!appId || !endPoint || !apiKey) return null;
  return { appId, endPoint, apiKey };
}

async function callTiger(path, { method = 'GET', body } = {}) {
  const cfg = await loadTigerConfig();
  if (!cfg) {
    const err = new Error('Tiger not configured');
    err.status = 503;
    throw err;
  }
  const url = `${cfg.endPoint.replace(/\/$/, '')}${path}`;
  console.log(`[tiger] ${method} ${url}`);
  const res = await fetch(url, {
    method,
    headers: {
      'app-id': cfg.appId,
      'x-api-key': cfg.apiKey,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.message) || `Tiger API ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function loadTigerVoucherConfig() {
  const baseUrl = String(process.env.TIGER_VOUCHER_BASE_URL || 'https://api.tigercashbox.com/api').trim().replace(/\/$/, '');
  if (!baseUrl) return null;
  return { baseUrl };
}

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

function bangkokParts(date = new Date()) {
  const shifted = new Date(date.getTime() + BANGKOK_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addBangkokMonths(date, months) {
  const p = bangkokParts(date);
  const zeroBasedMonth = p.month - 1 + months;
  const targetYear = p.year + Math.floor(zeroBasedMonth / 12);
  const targetMonthIndex = ((zeroBasedMonth % 12) + 12) % 12;
  const targetDay = Math.min(p.day, daysInMonth(targetYear, targetMonthIndex + 1));
  return new Date(Date.UTC(targetYear, targetMonthIndex, targetDay, p.hour, p.minute, p.second) - BANGKOK_OFFSET_MS);
}

function formatBangkokVoucherDate(date) {
  const p = bangkokParts(date);
  return `${String(p.day).padStart(2, '0')}-${String(p.month).padStart(2, '0')}-${p.year}`;
}

function formatBangkokVoucherTime(date) {
  const p = bangkokParts(date);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

function defaultVoucherWindow() {
  const start = new Date();
  const expire = addBangkokMonths(start, 1);
  return {
    start_date: formatBangkokVoucherDate(start),
    start_time: formatBangkokVoucherTime(start),
    expire_date: formatBangkokVoucherDate(expire),
    expire_time: formatBangkokVoucherTime(expire),
  };
}

async function tigerVoucherRequest(url, { method = 'POST', token = '', form } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: form });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data?.error || data?.message || data?.msg || `Tiger voucher API ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function findValueDeep(value, names) {
  if (!value || typeof value !== 'object') return '';
  const queue = [value];
  const keys = new Set(names.map((name) => name.toLowerCase()));
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    for (const [key, nested] of Object.entries(current)) {
      if (keys.has(key.toLowerCase()) && nested !== undefined && nested !== null && String(nested).trim() !== '') {
        return String(nested).trim();
      }
      if (nested && typeof nested === 'object') queue.push(nested);
    }
  }
  return '';
}

function normalizeTigerVoucherResponse(data) {
  const resultVoucher = Array.isArray(data?.result)
    ? String(data.result[0] ?? '').trim()
    : '';
  const voucherNum = resultVoucher || findValueDeep(data, ['voucher_num', 'voucher_number', 'voucherNo', 'voucher_no', 'number']);
  const voucherCode = findValueDeep(data, ['voucher_code', 'voucherCode', 'code', 'pin', 'password']);
  return {
    raw: data,
    voucher_num: voucherNum,
    voucher_code: voucherCode,
  };
}

function tigerVoucherPayload(payload = {}) {
  const amount = Number(payload.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('amount must be greater than zero');
    err.status = 400;
    throw err;
  }
  const window = defaultVoucherWindow();
  const approveRequired = payload.approve_required ?? payload.approved_required ?? 0;
  return {
    amount: String(Math.round(amount * 100) / 100),
    number_of_voucher: String(payload.number_of_voucher || 1),
    start_date: window.start_date,
    expire_date: window.expire_date,
    note: String(payload.note || ''),
    ref_num: String(payload.ref_num || ''),
    category: String(payload.category || 'other-expense'),
    authen_required: String(payload.authen_required ?? 1),
    start_time: window.start_time,
    expire_time: window.expire_time,
    approve_required: String(approveRequired),
    approved_required: String(approveRequired),
  };
}

async function createTigerVoucher(payload = {}) {
  const cfg = loadTigerVoucherConfig();
  if (!cfg) {
    const err = new Error('Tiger voucher not configured');
    err.status = 503;
    throw err;
  }

  const auth = payload.auth && typeof payload.auth === 'object' ? payload.auth : {};
  const username = String(auth.username || '').trim();
  const password = String(auth.password || '');
  const mobile = String(auth.mobile || '').trim();
  if (!username || !password) {
    const err = new Error('กรุณาเข้าสู่ระบบ Tiger');
    err.status = 400;
    throw err;
  }

  const loginForm = new FormData();
  loginForm.append('username', username);
  loginForm.append('password', password);
  if (mobile) loginForm.append('mobile', mobile);
  const loginData = await tigerVoucherRequest(`${cfg.baseUrl}/tigerQR/login`, { form: loginForm });
  const token = loginData?.success?.token
    || loginData?.token
    || loginData?.data?.token
    || loginData?.access_token
    || loginData?.data?.access_token;
  if (!token) {
    const err = new Error('เข้าสู่ระบบ Tiger ไม่สำเร็จ');
    err.status = 502;
    err.data = loginData;
    throw err;
  }

  const voucherPayload = tigerVoucherPayload(payload.voucher && typeof payload.voucher === 'object' ? payload.voucher : payload);
  const form = new FormData();
  Object.entries(voucherPayload).forEach(([key, value]) => form.append(key, value));

  const data = await tigerVoucherRequest(`${cfg.baseUrl}/voucher/create`, { token, form });
  const normalized = normalizeTigerVoucherResponse(data);
  if (!normalized.voucher_num) {
    const err = new Error('Tiger voucher response did not include voucher number');
    err.status = 502;
    err.data = data;
    throw err;
  }
  return normalized;
}

function tigerStatusFromResponse(data) {
  const payload = data?.data || data || {};
  return String(payload.status || data?.status || '').toLowerCase();
}

function tigerPayloadFromResponse(data) {
  return data?.data || data || {};
}

function parseTigerMeta(text) {
  try {
    const obj = JSON.parse(text || '{}');
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function tigerMetaText(meta) {
  const text = JSON.stringify(meta);
  if (text.length <= 255) return text;
  return JSON.stringify({
    status: meta.status || '',
    amount: meta.amount || 0,
    last_checked: meta.last_checked || '',
    mock: meta.mock === true,
  });
}

function pendingRow(row) {
  const meta = parseTigerMeta(row.tiger_status_note);
  return {
    doc_no: row.doc_no,
    doc_date: row.doc_date,
    doc_time: row.doc_time,
    cust_code: row.cust_code,
    cust_name: row.cust_name || '',
    total_net_amount: row.total_net_amount,
    tiger_order_id: row.tiger_order_id,
    tiger_amount: Number(meta.amount || row.tiger_pending_amount || 0),
    tiger_status: meta.status || 'pending',
    last_checked: meta.last_checked || '',
  };
}

function canQueryTigerOrderId(value) {
  return /^[1-9]\d*$/.test(String(value || '').trim());
}

function isMockTigerOrderId(value) {
  return /^MOCK-/i.test(String(value || '').trim());
}

async function markTigerPendingStatus(client, row, { status, amount, error } = {}) {
  const meta = parseTigerMeta(row.tiger_status_note);
  const nextMeta = {
    ...meta,
    status,
    amount: Number(amount ?? meta.amount ?? row.tiger_pending_amount ?? 0),
    last_checked: new Date().toISOString(),
  };
  if (error) nextMeta.error = String(error).slice(0, 120);
  await client.query(
    `UPDATE ic_trans
     SET remark_5 = $1
     WHERE doc_no = $2 AND trans_flag = 44`,
    [tigerMetaText(nextMeta), row.doc_no],
  );
  return {
    ...pendingRow({ ...row, tiger_status_note: tigerMetaText(nextMeta) }),
    tiger_status: status,
    tiger_amount: nextMeta.amount,
  };
}

async function markTigerPendingPaid(client, row, { amount: amountInput, source = 'tiger' } = {}) {
  const meta = parseTigerMeta(row.tiger_status_note);
  const amount = Number(amountInput ?? meta.amount ?? row.tiger_pending_amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('invalid tiger amount');
    err.status = 400;
    throw err;
  }

  const now = new Date().toISOString();
  const nextMeta = {
    ...meta,
    status: 'success',
    amount,
    last_checked: now,
    paid_at: now,
    mock: source === 'mock',
  };

  await client.query('BEGIN');
  const cbUpdated = await client.query(
    `UPDATE cb_trans
     SET cash_amount = COALESCE(cash_amount,0) + $1,
         pay_cash_amount = COALESCE(pay_cash_amount,0) + $1
     WHERE doc_no = $2 AND trans_flag = 44`,
    [amount, row.doc_no],
  );
  if (cbUpdated.rowCount === 0) {
    const err = new Error('cb_trans not found for tiger pending payment');
    err.status = 404;
    throw err;
  }
  const updated = await client.query(
    `UPDATE ic_trans
     SET send_sms = 0,
         remark_5 = $1
     WHERE doc_no = $2
       AND trans_flag = 44
       AND COALESCE(send_sms,0) = 1`,
    [tigerMetaText(nextMeta), row.doc_no],
  );
  if (updated.rowCount === 0) {
    const err = new Error('tiger pending payment already completed');
    err.status = 409;
    throw err;
  }
  await client.query('COMMIT');
  return {
    ...pendingRow({ ...row, tiger_status_note: tigerMetaText(nextMeta) }),
    tiger_status: 'success',
    tiger_amount: amount,
  };
}

// GET /service/v1/tiger/config — บอก frontend ว่าระบบ Tiger เปิดใช้งานหรือไม่
router.get('/tiger/config', async (req, res) => {
  try {
    const cfg = await loadTigerConfig();
    const voucherCfg = loadTigerVoucherConfig();
    return res.json({
      status: 'success',
      data: {
        enabled: !!cfg,
        voucher_enabled: !!voucherCfg,
        mock_enabled: tigerMockEnabled(),
      },
    });
  } catch (ex) {
    console.error('tiger config error:', ex.message);
    return res.status(500).json({ status: 'error', message: ex.message });
  }
});

// POST /service/v1/tiger/orders
router.post('/tiger/orders', async (req, res) => {
  try {
    const data = await callTiger('/orders', { method: 'POST', body: req.body });
    return res.json(data);
  } catch (ex) {
    console.error('tiger create error:', ex.message);
    return res.status(ex.status || 500).json({ status: 'error', message: ex.message });
  }
});

// GET /service/v1/tiger/orders/:id
router.get('/tiger/orders/:id', async (req, res) => {
  try {
    const data = await callTiger(`/orders/${encodeURIComponent(req.params.id)}`);
    return res.json(data);
  } catch (ex) {
    console.error('tiger inquire error:', ex.message);
    return res.status(ex.status || 500).json({ status: 'error', message: ex.message });
  }
});

// PUT /service/v1/tiger/orders/:id
router.put('/tiger/orders/:id', async (req, res) => {
  try {
    const data = await callTiger(`/orders/${encodeURIComponent(req.params.id)}`, {
      method: 'PUT',
      body: req.body,
    });
    return res.json(data);
  } catch (ex) {
    console.error('tiger cancel error:', ex.message);
    return res.status(ex.status || 500).json({ status: 'error', message: ex.message });
  }
});

// POST /service/v1/tiger/vouchers
router.post('/tiger/vouchers', async (req, res) => {
  try {
    const data = await createTigerVoucher(req.body || {});
    return res.json({ success: true, data });
  } catch (ex) {
    console.error('tiger voucher create error:', ex.message);
    return res.status(ex.status || 500).json({ success: false, msg: ex.message, data: ex.data });
  }
});

router.get('/tiger/pending', async (req, res) => {
  try {
    const result = await query(
      `SELECT t.doc_no, t.doc_date, t.doc_time, t.cust_code,
          COALESCE(ar.name_1,'') AS cust_name,
          COALESCE(cb.total_net_amount, t.total_amount) AS total_net_amount,
          COALESCE(t.remark_3,'') AS tiger_order_id,
          COALESCE(t.remark_5,'') AS tiger_status_note,
          GREATEST(
            COALESCE(cb.total_net_amount, t.total_amount)
            - COALESCE(cb.cash_amount, 0)
            - COALESCE(cb.tranfer_amount, 0)
            - COALESCE(cb.card_amount, 0)
            - COALESCE(cb.wallet_amount, 0),
            0
          ) AS tiger_pending_amount
       FROM ic_trans t
       LEFT JOIN ar_customer ar ON ar.code = t.cust_code
       LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = 44
       WHERE t.trans_flag = 44
         AND COALESCE(t.last_status,0) = 0
         AND COALESCE(t.send_sms,0) = 1
         AND COALESCE(t.remark_3,'') <> ''
       ORDER BY t.create_datetime ASC
       LIMIT 50`,
      [],
    );
    return res.json({ success: true, data: result.rows.map(pendingRow) });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.post('/tiger/pending/check-next', async (req, res) => {
  const client = await pool.connect();
  let locked = false;
  try {
    const lockRes = await client.query(
      "SELECT pg_try_advisory_lock(hashtext('smlstaff_tiger_pending_check')) AS locked",
    );
    locked = lockRes.rows[0]?.locked === true;
    if (!locked) {
      return res.json({ success: true, checked: false, busy: true, data: null });
    }

    const pendingRes = await client.query(
      `SELECT t.doc_no, t.doc_date, t.doc_time, t.cust_code,
          COALESCE(ar.name_1,'') AS cust_name,
          COALESCE(cb.total_net_amount, t.total_amount) AS total_net_amount,
          COALESCE(t.remark_3,'') AS tiger_order_id,
          COALESCE(t.remark_5,'') AS tiger_status_note,
          GREATEST(
            COALESCE(cb.total_net_amount, t.total_amount)
            - COALESCE(cb.cash_amount, 0)
            - COALESCE(cb.tranfer_amount, 0)
            - COALESCE(cb.card_amount, 0)
            - COALESCE(cb.wallet_amount, 0),
            0
          ) AS tiger_pending_amount
       FROM ic_trans t
       LEFT JOIN ar_customer ar ON ar.code = t.cust_code
       LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = 44
       WHERE t.trans_flag = 44
         AND COALESCE(t.last_status,0) = 0
         AND COALESCE(t.send_sms,0) = 1
         AND COALESCE(t.remark_3,'') <> ''
       ORDER BY t.create_datetime ASC
       LIMIT 50`,
    );

    if (pendingRes.rows.length === 0) {
      return res.json({ success: true, checked: false, data: null });
    }

    const row = pendingRes.rows
      .slice()
      .sort((a, b) => {
        const aChecked = parseTigerMeta(a.tiger_status_note).last_checked || '';
        const bChecked = parseTigerMeta(b.tiger_status_note).last_checked || '';
        return aChecked.localeCompare(bChecked);
      })[0];
    const meta = parseTigerMeta(row.tiger_status_note);
    if (isMockTigerOrderId(row.tiger_order_id) && tigerMockEnabled()) {
      const paidData = await markTigerPendingPaid(client, row, { source: 'mock' });
      return res.json({
        success: true,
        checked: true,
        paid: true,
        mock: true,
        data: paidData,
      });
    }

    if (!canQueryTigerOrderId(row.tiger_order_id)) {
      const data = await markTigerPendingStatus(client, row, {
        status: 'invalid_tiger_id',
        error: `Invalid Tiger order id: ${row.tiger_order_id}`,
      });
      return res.json({ success: true, checked: true, paid: false, data });
    }

    let tigerData;
    try {
      tigerData = await callTiger(`/orders/${encodeURIComponent(row.tiger_order_id)}`);
    } catch (ex) {
      const msg = ex.message || '';
      if (msg.includes('Argument `id` is missing') || msg.includes('findUnique')) {
        const data = await markTigerPendingStatus(client, row, {
          status: 'invalid_tiger_id',
          error: msg,
        });
        return res.json({ success: true, checked: true, paid: false, data });
      }
      throw ex;
    }
    const status = tigerStatusFromResponse(tigerData);
    const payload = tigerPayloadFromResponse(tigerData);
    const amount = Number(meta.amount || row.tiger_pending_amount || payload.amount || payload.total || 0);

    if (status === 'success') {
      const paidData = await markTigerPendingPaid(client, row, { amount, source: 'tiger' });
      return res.json({
        success: true,
        checked: true,
        paid: true,
        data: paidData,
      });
    }

    const statusData = await markTigerPendingStatus(client, row, {
      status: status || 'unknown',
      amount,
    });
    return res.json({
      success: true,
      checked: true,
      paid: false,
      data: statusData,
    });
  } catch (ex) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return res.status(ex.status || 500).json({ success: false, msg: ex.message });
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext('smlstaff_tiger_pending_check'))"); } catch (_) {}
    }
    client.release();
  }
});

router.post('/tiger/pending/mock-paid', async (req, res) => {
  if (!tigerMockEnabled()) {
    return res.status(403).json({ success: false, msg: 'Tiger mock is disabled' });
  }

  const { doc_no = '', tiger_order_id = '' } = req.body || {};
  const docNo = String(doc_no || '').trim();
  const tigerOrderId = String(tiger_order_id || '').trim();
  if (!docNo && !tigerOrderId) {
    return res.status(400).json({ success: false, msg: 'doc_no or tiger_order_id is required' });
  }

  const client = await pool.connect();
  let locked = false;
  try {
    const lockRes = await client.query(
      "SELECT pg_try_advisory_lock(hashtext('smlstaff_tiger_pending_check')) AS locked",
    );
    locked = lockRes.rows[0]?.locked === true;
    if (!locked) {
      return res.json({ success: true, paid: false, busy: true, data: null });
    }

    const pendingRes = await client.query(
      `SELECT t.doc_no, t.doc_date, t.doc_time, t.cust_code,
          COALESCE(ar.name_1,'') AS cust_name,
          COALESCE(cb.total_net_amount, t.total_amount) AS total_net_amount,
          COALESCE(t.remark_3,'') AS tiger_order_id,
          COALESCE(t.remark_5,'') AS tiger_status_note,
          GREATEST(
            COALESCE(cb.total_net_amount, t.total_amount)
            - COALESCE(cb.cash_amount, 0)
            - COALESCE(cb.tranfer_amount, 0)
            - COALESCE(cb.card_amount, 0)
            - COALESCE(cb.wallet_amount, 0),
            0
          ) AS tiger_pending_amount
       FROM ic_trans t
       LEFT JOIN ar_customer ar ON ar.code = t.cust_code
       LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = 44
       WHERE t.trans_flag = 44
         AND COALESCE(t.last_status,0) = 0
         AND COALESCE(t.send_sms,0) = 1
         AND COALESCE(t.remark_3,'') <> ''
         AND (($1 <> '' AND t.doc_no = $1) OR ($2 <> '' AND t.remark_3 = $2))
       ORDER BY t.create_datetime ASC
       LIMIT 1`,
      [docNo, tigerOrderId],
    );

    if (pendingRes.rows.length === 0) {
      return res.status(404).json({ success: false, msg: 'ไม่พบรายการรอรับชำระ Tiger' });
    }

    const paidData = await markTigerPendingPaid(client, pendingRes.rows[0], { source: 'mock' });
    return res.json({ success: true, paid: true, mock: true, data: paidData });
  } catch (ex) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return res.status(ex.status || 500).json({ success: false, msg: ex.message });
  } finally {
    if (locked) {
      try { await client.query("SELECT pg_advisory_unlock(hashtext('smlstaff_tiger_pending_check'))"); } catch (_) {}
    }
    client.release();
  }
});

module.exports = router;

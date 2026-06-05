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
    return res.json({ status: 'success', data: { enabled: !!cfg, mock_enabled: tigerMockEnabled() } });
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

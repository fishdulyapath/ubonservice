const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { getEmployeePermissions } = require('../utils/permissions');

const TRANS_FLAG = 260;
const OTHER_EXPENSE_VIEW_PERMISSION = 'cash.other_expense.view';

function safeText(value) {
  return String(value ?? '').trim();
}

function toInt(value, fallback = 0) {
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function normalizeDate(value, fallback = todayISO()) {
  const text = safeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function isPermissionError(ex) {
  const msg = String(ex?.message || '');
  return msg.startsWith('permission denied') || msg.includes('permission check');
}

async function assertPermission(queryFn, userCode, permissionKey) {
  const code = safeText(userCode);
  if (!code) throw new Error('creator_code or emp_code is required for permission check');
  const permissions = await getEmployeePermissions(queryFn, code);
  if (!permissions.includes(permissionKey)) {
    throw new Error(`permission denied: ${permissionKey}`);
  }
}

router.get('/other-expense/list', async (req, res) => {
  const { search = '', fromdate = '', todate = '', limit = '100' } = req.query;
  const params = [normalizeDate(fromdate, '1900-01-01'), normalizeDate(todate, todayISO())];
  const lim = Math.min(Math.max(toInt(limit, 100), 1), 300);
  let where = `t.trans_flag = ${TRANS_FLAG} AND t.doc_date BETWEEN $1::date AND $2::date`;

  if (safeText(search)) {
    params.push(`%${safeText(search)}%`);
    where += ` AND (
      t.doc_no ILIKE $${params.length}
      OR t.cust_code ILIKE $${params.length}
      OR COALESCE(ap.name_1,'') ILIKE $${params.length}
      OR EXISTS (
        SELECT 1
        FROM ic_trans_detail dx
        WHERE dx.doc_no = t.doc_no
          AND dx.trans_flag = t.trans_flag
          AND (dx.item_code ILIKE $${params.length} OR COALESCE(dx.item_name,'') ILIKE $${params.length})
      )
    )`;
  }

  params.push(lim);

  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, OTHER_EXPENSE_VIEW_PERMISSION);
    const result = await query(
      `SELECT t.doc_no, t.doc_date, t.doc_time, t.doc_format_code, t.cust_code,
              COALESCE(ap.name_1,'') AS cust_name, COALESCE(t.tax_doc_no,'') AS tax_doc_no,
              t.tax_doc_date, COALESCE(t.vat_type,0) AS vat_type, COALESCE(t.vat_rate,0) AS vat_rate,
              COALESCE(t.total_value,0) AS total_value, COALESCE(t.total_before_vat,0) AS total_before_vat,
              COALESCE(t.total_vat_value,0) AS total_vat_value, COALESCE(t.total_amount,0) AS total_amount,
              COALESCE(t.last_status,0) AS last_status, COALESCE(t.used_status,0) AS used_status,
              COALESCE(t.remark,'') AS remark, COALESCE(d.detail_count,0) AS detail_count,
              COALESCE(d.expense_names,'') AS expense_names
       FROM ic_trans t
       LEFT JOIN ap_supplier ap ON ap.code = t.cust_code
       LEFT JOIN (
         SELECT doc_no, COUNT(*)::int AS detail_count,
                string_agg(COALESCE(NULLIF(item_name,''), item_code), ', ' ORDER BY line_number, roworder) AS expense_names
         FROM ic_trans_detail
         WHERE trans_flag = ${TRANS_FLAG}
         GROUP BY doc_no
       ) d ON d.doc_no = t.doc_no
       WHERE ${where}
       ORDER BY t.doc_date DESC, t.doc_no DESC
       LIMIT $${params.length}`,
      params,
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/other-expense/detail', async (req, res) => {
  const docNo = safeText(req.query.doc_no);
  if (!docNo) return res.status(400).json({ success: false, msg: 'doc_no is required' });
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, OTHER_EXPENSE_VIEW_PERMISSION);
    const [header, details, payment, paymentDetails, vatBuy, whtList] = await Promise.all([
      query(
        `SELECT t.*, COALESCE(ap.name_1,'') AS cust_name, COALESCE(ap.address,'') AS cust_address,
                COALESCE(ap.telephone,'') AS cust_telephone
         FROM ic_trans t
         LEFT JOIN ap_supplier ap ON ap.code = t.cust_code
         WHERE t.doc_no = $1 AND t.trans_flag = $2
         LIMIT 1`,
        [docNo, TRANS_FLAG],
      ),
      query(
        `SELECT line_number, item_code AS expense_code, item_name AS expense_name,
                COALESCE(remark,'') AS remark, COALESCE(sum_amount,0) AS amount,
                COALESCE(sum_amount,0) AS sum_amount, COALESCE(sum_amount_exclude_vat,0) AS sum_amount_exclude_vat,
                COALESCE(branch_code,'') AS branch_code
         FROM ic_trans_detail
         WHERE doc_no = $1 AND trans_flag = $2
         ORDER BY line_number, roworder`,
        [docNo, TRANS_FLAG],
      ),
      query(
        `SELECT *
         FROM cb_trans
         WHERE doc_no = $1 AND trans_flag = $2
         LIMIT 1`,
        [docNo, TRANS_FLAG],
      ),
      query(
        `SELECT *
         FROM cb_trans_detail
         WHERE doc_no = $1 AND trans_flag = $2
         ORDER BY roworder`,
        [docNo, TRANS_FLAG],
      ),
      query(
        `SELECT *
         FROM gl_journal_vat_buy
         WHERE doc_no = $1 AND trans_flag = $2
         ORDER BY roworder`,
        [docNo, TRANS_FLAG],
      ),
      query(
        `SELECT *
         FROM gl_wht_list
         WHERE doc_no = $1 AND trans_flag = $2
         ORDER BY roworder`,
        [docNo, TRANS_FLAG],
      ),
    ]);
    if (!header.rows[0]) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({
      success: true,
      data: {
        header: header.rows[0],
        details: details.rows,
        payment: payment.rows[0] || null,
        payment_detail: paymentDetails.rows,
        vat_buy: vatBuy.rows,
        wht_list: whtList.rows,
      },
    });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

module.exports = router;

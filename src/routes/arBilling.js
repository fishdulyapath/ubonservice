const express = require('express');
const router = express.Router();
const { withTransaction, query } = require('../db');
const { resolveDocumentNo } = require('../utils/docFormat');
const { getEmployeePermissions } = require('../utils/permissions');

const TRANS_TYPE = 2;
const TRANS_FLAG = 235;
const CANCEL_TRANS_FLAG = 236;
const SCREEN_CODE = 'ED';
const DOC_TABLE = 'ap_ar_trans';
const BILLABLE_FLAGS = [44, 46, 48, 93, 95, 97];
const AR_BILLING_VIEW_PERMISSION = 'sales.ar_billing.view';
const AR_BILLING_CREATE_PERMISSION = 'sales.ar_billing.create';

function safeText(value) {
  return String(value ?? '').trim();
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toInt(value, fallback = 0) {
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function currentTimeText() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function normalizeDate(value, fallback = todayISO()) {
  const text = safeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function normalizeNullableDate(value) {
  const text = safeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function dateToISO(value, fallback = todayISO()) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return normalizeDate(value, fallback);
}

function nullableDateToISO(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return normalizeNullableDate(value);
}

function addDays(dateText, days) {
  const date = new Date(`${normalizeDate(dateText)}T00:00:00`);
  date.setDate(date.getDate() + toInt(days));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizePayload(body) {
  let payload = body || {};
  if (typeof payload === 'string') payload = JSON.parse(payload);
  if (payload && typeof payload.payload === 'object') payload = payload.payload;
  return payload || {};
}

function normalizeDetails(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((row, index) => ({
      line_number: index,
      billing_no: safeText(row?.billing_no || row?.doc_no),
      bill_type: toInt(row?.bill_type || row?.trans_flag),
      sum_pay_money: roundMoney(row?.sum_pay_money ?? row?.pay_amount ?? row?.balance_ref),
      remark: safeText(row?.remark),
    }))
    .filter((row) => row.billing_no && row.bill_type && row.sum_pay_money > 0);
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

async function assertCreatePermission(client, userCode) {
  await assertPermission(client.query.bind(client), userCode, AR_BILLING_CREATE_PERMISSION);
}

async function updateBillingStatuses(client, docNos = [], billingKeys = []) {
  const targets = [...new Set(docNos.map(safeText).filter(Boolean))];
  if (targets.length) {
    await client.query(
      `WITH bill_totals AS (
         SELECT doc_no, COALESCE(SUM(sum_pay_money),0) AS bill_total
         FROM ap_ar_trans_detail
         WHERE trans_flag = $1 AND COALESCE(last_status,0) = 0 AND doc_no = ANY($3::text[])
         GROUP BY doc_no
       ),
       paid_totals AS (
         SELECT b.doc_no, COALESCE(SUM(p.sum_pay_money),0) AS paid_total
         FROM ap_ar_trans_detail b
         JOIN ap_ar_trans_detail p
           ON p.billing_no = b.billing_no
          AND p.bill_type = b.bill_type
          AND p.trans_flag = 239
          AND COALESCE(p.last_status,0) = 0
         WHERE b.trans_flag = $1
           AND COALESCE(b.last_status,0) = 0
           AND b.doc_no = ANY($3::text[])
         GROUP BY b.doc_no
       )
       UPDATE ap_ar_trans t
       SET last_status = CASE
             WHEN COALESCE(t.is_cancel,0) = 1
               OR EXISTS (
               SELECT 1 FROM ap_ar_trans x1
               WHERE x1.trans_flag = $2
                 AND COALESCE(x1.last_status,0) = 0
                 AND x1.doc_ref = t.doc_no
             ) THEN 1 ELSE 0 END,
           used_status = CASE
             WHEN EXISTS (
               SELECT 1 FROM ap_ar_trans_detail d
               WHERE COALESCE(d.last_status,0) = 0
                 AND d.trans_flag = 239
                 AND d.doc_ref = t.doc_no
             ) THEN 1 ELSE 0 END,
           doc_success = CASE
             WHEN COALESCE(bt.bill_total,0) > 0
              AND ROUND(COALESCE(bt.bill_total,0) - COALESCE(pt.paid_total,0), 2) <= 0
             THEN 1 ELSE 0 END
       FROM bill_totals bt
       LEFT JOIN paid_totals pt ON pt.doc_no = bt.doc_no
       WHERE t.trans_flag = $1
         AND t.doc_no = bt.doc_no
         AND t.doc_no = ANY($3::text[])`,
      [TRANS_FLAG, CANCEL_TRANS_FLAG, targets],
    );
  }

  const keys = billingKeys
    .map((row) => ({ billing_no: safeText(row.billing_no), bill_type: toInt(row.bill_type) }))
    .filter((row) => row.billing_no && row.bill_type);
  if (!keys.length) return;
  const billingNos = [...new Set(keys.map((row) => row.billing_no))];
  const billTypes = [...new Set(keys.map((row) => row.bill_type).filter((flag) => BILLABLE_FLAGS.includes(flag)))];
  if (!billTypes.length) return;
  await client.query(
    `UPDATE ic_trans
     SET used_status_2 = CASE
       WHEN EXISTS (
         SELECT 1 FROM ap_ar_trans_detail d
         WHERE d.billing_no = ic_trans.doc_no
           AND d.bill_type = ic_trans.trans_flag
           AND d.trans_flag IN (235,239)
           AND COALESCE(d.last_status,0) = 0
       ) THEN 1 ELSE 0 END
     WHERE doc_no = ANY($1::text[])
       AND trans_flag = ANY($2::int[])`,
    [billingNos, billTypes],
  );
}

router.get('/ar-billing/doc-formats', async (req, res) => {
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, AR_BILLING_VIEW_PERMISSION);
    const result = await query(
      `SELECT code, name_1, format, COALESCE(form_code,'') AS form_code
       FROM erp_doc_format
       WHERE screen_code = $1
       ORDER BY code`,
      [SCREEN_CODE],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/ar-billing/next-doc-no', async (req, res) => {
  const { doc_format_code = '', doc_date = '' } = req.query;
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, AR_BILLING_VIEW_PERMISSION);
    const result = await withTransaction((client) =>
      resolveDocumentNo(client, {
        screenCode: SCREEN_CODE,
        docFormatCode: doc_format_code,
        transFlag: TRANS_FLAG,
        docDate: normalizeDate(doc_date),
        tableName: DOC_TABLE,
      })
    );
    return res.json({ success: true, ...result });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/ar-billing/list', async (req, res) => {
  const { search = '', fromdate = '', todate = '', limit = '100' } = req.query;
  const params = [normalizeDate(fromdate, '1900-01-01'), normalizeDate(todate, todayISO())];
  const lim = Math.min(Math.max(toInt(limit, 100), 1), 300);
  let where = `t.trans_flag = ${TRANS_FLAG} AND t.doc_date BETWEEN $1::date AND $2::date`;
  if (safeText(search)) {
    params.push(`%${safeText(search)}%`);
    where += ` AND (t.doc_no ILIKE $${params.length} OR t.cust_code ILIKE $${params.length} OR COALESCE(c.name_1,'') ILIKE $${params.length})`;
  }
  params.push(lim);
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, AR_BILLING_VIEW_PERMISSION);
    const result = await query(
      `SELECT t.doc_no, t.doc_date, t.doc_time, t.doc_format_code, t.cust_code,
              COALESCE(c.name_1,'') AS cust_name, COALESCE(t.total_net_value,0) AS total_net_value,
              COALESCE(t.credit_day,0) AS credit_day, t.due_date,
              COALESCE(t.last_status,0) AS last_status, COALESCE(t.used_status,0) AS used_status,
              COALESCE(t.doc_success,0) AS doc_success, COALESCE(t.remark,'') AS remark
       FROM ap_ar_trans t
       LEFT JOIN ar_customer c ON c.code = t.cust_code
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

router.get('/ar-billing/open-docs', async (req, res) => {
  const custCode = safeText(req.query.cust_code);
  const search = safeText(req.query.search);
  const docDate = normalizeDate(req.query.doc_date);
  if (!custCode) return res.json({ success: true, data: [] });
  const params = [custCode, BILLABLE_FLAGS, docDate];
  let extra = '';
  if (search) {
    params.push(`%${search}%`);
    extra = `AND (t.doc_no ILIKE $${params.length} OR COALESCE(t.doc_ref,'') ILIKE $${params.length})`;
  }
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, AR_BILLING_VIEW_PERMISSION);
    const result = await query(
      `WITH base AS (
         SELECT t.doc_no, t.doc_date, t.trans_flag AS bill_type, COALESCE(t.doc_ref,'') AS ref_doc_no,
                t.doc_ref_date AS ref_doc_date, COALESCE(t.total_amount,0) AS sum_debt_amount,
                COALESCE(t.due_date, t.doc_date) AS due_date, COALESCE(t.vat_rate,0) AS vat_rate,
                COALESCE(t.sale_code,'') AS sale_code, COALESCE(t.cust_code,'') AS cust_code
         FROM ic_trans t
         WHERE t.cust_code = $1
           AND t.trans_flag = ANY($2::int[])
           AND COALESCE(t.last_status,0) = 0
           AND COALESCE(t.is_cancel,0) = 0
           AND COALESCE(t.is_doc_copy,0) <> 1
           AND t.doc_date <= $3::date
           ${extra}
       )
       SELECT b.*,
              GREATEST(ROUND(
                b.sum_debt_amount
                - COALESCE((
                  SELECT SUM(d.sum_pay_money)
                  FROM ap_ar_trans_detail d
                  WHERE d.billing_no = b.doc_no
                    AND d.bill_type = b.bill_type
                    AND d.trans_flag IN (235,239)
                    AND COALESCE(d.last_status,0) = 0
                ),0), 2), 0) AS balance_ref
       FROM base b
       WHERE GREATEST(ROUND(
                b.sum_debt_amount
                - COALESCE((
                  SELECT SUM(d.sum_pay_money)
                  FROM ap_ar_trans_detail d
                  WHERE d.billing_no = b.doc_no
                    AND d.bill_type = b.bill_type
                    AND d.trans_flag IN (235,239)
                    AND COALESCE(d.last_status,0) = 0
                ),0), 2), 0) > 0
       ORDER BY b.doc_date, b.doc_no
       LIMIT 200`,
      params,
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/ar-billing/detail', async (req, res) => {
  const docNo = safeText(req.query.doc_no);
  if (!docNo) return res.status(400).json({ success: false, msg: 'doc_no is required' });
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, AR_BILLING_VIEW_PERMISSION);
    const [header, details] = await Promise.all([
      query(
        `SELECT t.*, COALESCE(c.name_1,'') AS cust_name, COALESCE(c.address,'') AS cust_address,
                COALESCE(c.telephone,'') AS cust_telephone
         FROM ap_ar_trans t
         LEFT JOIN ar_customer c ON c.code = t.cust_code
         WHERE t.doc_no = $1 AND t.trans_flag = $2
         LIMIT 1`,
        [docNo, TRANS_FLAG],
      ),
      query(
        `SELECT d.*, CASE d.bill_type
                  WHEN 44 THEN 'ขายเชื่อ'
                  WHEN 46 THEN 'เพิ่มหนี้'
                  WHEN 48 THEN 'ลดหนี้'
                  WHEN 93 THEN 'ตั้งหนี้ยกมา'
                  WHEN 95 THEN 'เพิ่มหนี้ยกมา'
                  WHEN 97 THEN 'ลดหนี้ยกมา'
                  ELSE d.bill_type::text
                END AS bill_type_name
         FROM ap_ar_trans_detail d
         WHERE d.doc_no = $1 AND d.trans_flag = $2
         ORDER BY d.line_number, d.roworder`,
        [docNo, TRANS_FLAG],
      ),
    ]);
    if (!header.rows[0]) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({ success: true, data: { header: header.rows[0], details: details.rows } });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.post('/ar-billing/save', async (req, res) => {
  try {
    const payload = normalizePayload(req.body);
    const docDate = normalizeDate(payload.doc_date);
    const docTime = safeText(payload.doc_time) || currentTimeText();
    const custCode = safeText(payload.cust_code);
    const details = normalizeDetails(payload.details);
    const creditDay = Math.max(0, toInt(payload.credit_day, 0));
    const dueDate = normalizeDate(payload.due_date, addDays(docDate, creditDay));
    const docRef = safeText(payload.doc_ref);
    const docRefDate = normalizeNullableDate(payload.doc_ref_date);
    const saleCode = safeText(payload.sale_code);
    const branchCode = safeText(payload.branch_code);
    const requestUserCode = safeText(payload.emp_code) || safeText(payload.creator_code);
    const creatorCode = requestUserCode || 'smlstaff';
    const remark = safeText(payload.remark);

    if (!custCode) return res.status(400).json({ success: false, msg: 'cust_code is required' });
    if (!details.length) return res.status(400).json({ success: false, msg: 'details is empty' });

    let savedDocNo = '';
    let savedDocFormatCode = '';
    let savedFormCode = '';
    let savedTotal = 0;

    await withTransaction(async (client) => {
      const customer = await client.query('SELECT code FROM ar_customer WHERE code = $1 LIMIT 1', [custCode]);
      if (!customer.rows[0]) throw new Error('customer not found');
      await assertCreatePermission(client, requestUserCode);

      const doc = await resolveDocumentNo(client, {
        screenCode: SCREEN_CODE,
        docFormatCode: safeText(payload.doc_format_code),
        transFlag: TRANS_FLAG,
        docDate,
        tableName: DOC_TABLE,
      });
      savedDocNo = doc.doc_no;
      savedDocFormatCode = doc.doc_format_code;
      savedFormCode = doc.form_code || '';

      const invoiceNos = [...new Set(details.map((row) => row.billing_no))];
      const invoiceResult = await client.query(
        `WITH base AS (
           SELECT t.doc_no, t.doc_date, t.trans_flag AS bill_type, COALESCE(t.doc_ref,'') AS ref_doc_no,
                  t.doc_ref_date AS ref_doc_date, COALESCE(t.total_amount,0) AS sum_debt_amount,
                  COALESCE(t.due_date, t.doc_date) AS due_date, COALESCE(t.vat_rate,0) AS vat_rate
           FROM ic_trans t
           WHERE t.cust_code = $1
             AND t.doc_no = ANY($2::text[])
             AND t.trans_flag = ANY($3::int[])
             AND COALESCE(t.last_status,0) = 0
             AND COALESCE(t.is_cancel,0) = 0
             AND COALESCE(t.is_doc_copy,0) <> 1
         )
         SELECT b.*,
                GREATEST(ROUND(
                  b.sum_debt_amount
                  - COALESCE((
                    SELECT SUM(d.sum_pay_money)
                    FROM ap_ar_trans_detail d
                    WHERE d.billing_no = b.doc_no
                      AND d.bill_type = b.bill_type
                      AND d.trans_flag IN (235,239)
                      AND COALESCE(d.last_status,0) = 0
                  ),0), 2), 0) AS balance_ref
         FROM base b`,
        [custCode, invoiceNos, BILLABLE_FLAGS],
      );

      const invoiceMap = new Map(invoiceResult.rows.map((row) => [`${row.doc_no}|${row.bill_type}`, row]));
      for (const row of details) {
        const invoice = invoiceMap.get(`${row.billing_no}|${row.bill_type}`);
        if (!invoice) throw new Error(`billing document not found: ${row.billing_no}`);
        const balance = roundMoney(invoice.balance_ref);
        if (row.sum_pay_money > balance + 0.01) {
          throw new Error(`sum_pay_money exceeds balance: ${row.billing_no}`);
        }
      }

      savedTotal = roundMoney(details.reduce((sum, row) => sum + row.sum_pay_money, 0));

      await client.query(
        `INSERT INTO ap_ar_trans (
          trans_type, trans_flag, doc_date, doc_no, doc_ref, doc_ref_date,
          cust_code, sale_code, credit_day, due_date, remark,
          total_net_value, total_after_discount, total_pay_money, total_debt_value,
          sum_pay_money_diff, doc_time, doc_format_code, last_status, used_status,
          doc_success, creator_code, create_datetime, branch_code, is_cancel
        ) VALUES (
          $1,$2,$3::date,$4,$5,$6::date,$7,$8,$9,$10::date,$11,
          $12,$12,0,0,0,$13,$14,0,0,0,$15,NOW(),$16,0
        )`,
        [
          TRANS_TYPE, TRANS_FLAG, docDate, savedDocNo, docRef, docRefDate,
          custCode, saleCode, creditDay, dueDate, remark, savedTotal,
          docTime, savedDocFormatCode, creatorCode, branchCode,
        ],
      );

      for (let i = 0; i < details.length; i++) {
        const row = details[i];
        const invoice = invoiceMap.get(`${row.billing_no}|${row.bill_type}`);
        const debtAmount = roundMoney(invoice.sum_debt_amount);
        const balanceRef = roundMoney(invoice.balance_ref);
        const billingDate = dateToISO(invoice.doc_date, docDate);
        const invoiceDueDate = dateToISO(invoice.due_date, billingDate);
        const refDocDate = nullableDateToISO(invoice.ref_doc_date);
        await client.query(
          `INSERT INTO ap_ar_trans_detail (
            trans_type, trans_flag, doc_date, doc_no, doc_ref, billing_no,
            billing_date, due_date, sum_debt_amount, sum_debt_balance, remark,
            line_number, bill_type, sum_pay_money, balance_ref, vat_rate,
            final_amount, last_status, calc_flag, ref_doc_no, ref_doc_date,
            cust_code, creator_code, create_datetime
          ) VALUES (
            $1,$2,$3::date,$4,'',$5,$6::date,$7::date,$8,0,$9,
            $10,$11,$12,$13,$14,0,0,0,$15,$16::date,'',$17,NOW()
          )`,
          [
            TRANS_TYPE, TRANS_FLAG, docDate, savedDocNo, row.billing_no,
            billingDate, invoiceDueDate, debtAmount, row.remark, i, row.bill_type,
            row.sum_pay_money, balanceRef, roundMoney(invoice.vat_rate),
            safeText(invoice.ref_doc_no), refDocDate, creatorCode,
          ],
        );
      }

      await updateBillingStatuses(client, [savedDocNo], details);
    });

    return res.json({
      success: true,
      doc_no: savedDocNo,
      doc_format_code: savedDocFormatCode,
      form_code: savedFormCode,
      total_net_value: savedTotal,
      msg: 'success',
    });
  } catch (ex) {
    if (ex.message && ex.message.includes('not found')) {
      return res.status(404).json({ success: false, msg: ex.message });
    }
    if (isPermissionError(ex)) {
      return res.status(403).json({ success: false, msg: ex.message });
    }
    if (ex.message && ex.message.includes('exceeds balance')) {
      return res.status(400).json({ success: false, msg: ex.message });
    }
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const { calcDiscount, calcVat } = require('../utils/vatHelper');
const { validateSaleItemsStock } = require('../utils/cartStockValidator');
const { getEmployeePermissions } = require('../utils/permissions');

const uuidv4 = () => crypto.randomUUID();
const SOLD_OUT_PURCHASE_INFO_PERMISSION = 'sold_out.purchase_info.view';

function activeProductCondition(alias = 'd') {
  return `COALESCE(${alias}.is_hold_sale,0) <> 1 AND COALESCE(${alias}.is_hold_purchase,0) <> 1`;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function normalizeSaleDepositPayments(payments) {
  return (Array.isArray(payments) ? payments : [])
    .map((row) => {
      const docType = parseInt(row?.doc_type || row?.pay_type || 0, 10);
      return {
        doc_type: docType,
        trans_number: String(row?.trans_number || row?.doc_no || '').trim(),
        amount: roundMoney(row?.pay_amount ?? row?.amount),
        remark: String(row?.remark || '').trim(),
      };
    })
    .filter((row) => (row.doc_type === 5 || row.doc_type === 6) && row.amount > 0);
}

async function querySaleAdvanceDepositBalances(queryFn, custCode, docNos = []) {
  const params = [custCode];
  let docFilter = '';
  if (docNos.length > 0) {
    params.push(docNos);
    docFilter = `AND h.doc_no = ANY($${params.length}::text[])`;
  }

  const result = await queryFn(
    `SELECT x.doc_no, x.doc_date, x.doc_time, x.cust_code, x.trans_flag,
            CASE WHEN x.trans_flag IN (110,9110) THEN 6 ELSE 5 END AS doc_type,
            CASE WHEN x.trans_flag IN (110,9110) THEN 'deposit' ELSE 'advance' END AS payment_kind,
            CASE WHEN x.trans_flag IN (110,9110) THEN 'เงินมัดจำ' ELSE 'เงินล่วงหน้า' END AS type_label,
            COALESCE(x.remark,'') AS remark,
            COALESCE(x.total_amount,0) AS total_amount,
            COALESCE(x.used_amount,0) AS used_amount,
            GREATEST(ROUND(COALESCE(x.total_amount,0) - COALESCE(x.used_amount,0), 2), 0) AS balance_amount
     FROM (
       SELECT h.doc_no, h.doc_date, h.doc_time, h.cust_code, h.trans_flag, h.remark,
              COALESCE(h.total_amount,0) AS total_amount,
              COALESCE((
                SELECT SUM(COALESCE(r.total_amount,0))
                FROM ic_trans r
                WHERE COALESCE(r.last_status,0) = 0
                  AND r.doc_ref = h.doc_no
                  AND (
                    (h.trans_flag IN (40,9040) AND r.trans_flag = 42)
                    OR (h.trans_flag IN (110,9110) AND r.trans_flag = 112)
                  )
              ),0)
              + COALESCE((
                SELECT SUM(COALESCE(d.amount,0))
                FROM cb_trans_detail d
                WHERE COALESCE(d.last_status,0) = 0
                  AND d.trans_number = h.doc_no
                  AND d.doc_type = CASE WHEN h.trans_flag IN (110,9110) THEN 6 ELSE 5 END
              ),0) AS used_amount
       FROM ic_trans h
       WHERE h.trans_flag IN (40,9040,110,9110)
         AND h.cust_code = $1
         AND COALESCE(h.last_status,0) = 0
         AND COALESCE(h.is_doc_copy,0) <> 1
         ${docFilter}
     ) x
     WHERE GREATEST(ROUND(COALESCE(x.total_amount,0) - COALESCE(x.used_amount,0), 2), 0) > 0
     ORDER BY x.doc_date DESC, x.doc_no DESC`,
    params
  );
  return result.rows;
}

// ── helper: buildDocPattern ────────────────────────────────────────────────
// แปลง doc_format จาก pos_id table เป็น pattern จริง
// เช่น "@-yyyy-####" + posId="MPOS01" → "MPOS01-2026-####"
function buildDocPattern(docFormat, posId) {
  if (!docFormat || docFormat.trim() === '') return posId + '-####';
  const now = new Date();
  const year4 = String(now.getFullYear());
  const year2 = year4.substring(2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return docFormat
    .replace(/@/g, posId)
    .replace(/ปปปป/g, year4)
    .replace(/ปป/g, year2)
    .replace(/ดด/g, month)
    .replace(/วว/g, day)
    .replace(/yyyy/g, year4)
    .replace(/YYYY/g, year4)
    .replace(/yy/g, year2)
    .replace(/YY/g, year2)
    .replace(/MM/g, month)
    .replace(/dd/g, day)
    .replace(/DD/g, day);
}

async function resolveDocNoFromPattern(client, pattern, transFlag) {
  const firstHash = pattern.indexOf('#');
  if (firstHash < 0) return pattern;

  let runLen = 0;
  while (firstHash + runLen < pattern.length && pattern[firstHash + runLen] === '#') runLen++;

  const likePattern = pattern.replace(/#/g, '_');
  const patternLen = pattern.length;

  const rows = await client.query(
    'SELECT doc_no FROM ic_trans WHERE trans_flag=$1 AND char_length(doc_no)=$2 AND doc_no LIKE $3',
    [transFlag, patternLen, likePattern]
  );

  let maxRunning = 0;
  for (const row of rows.rows) {
    const docNo = row.doc_no;
    if (!docNo || docNo.length !== patternLen) continue;
    const runText = docNo.substring(firstHash, firstHash + runLen);
    if (!/^\d+$/.test(runText)) continue;
    const run = parseInt(runText, 10);
    if (run > maxRunning) maxRunning = run;
  }

  const nextRunning = maxRunning + 1;
  if (nextRunning > Math.pow(10, runLen) - 1) throw new Error('running overflow');

  const prefix = pattern.substring(0, firstHash);
  const suffix = pattern.substring(firstHash + runLen);
  return prefix + String(nextRunning).padStart(runLen, '0') + suffix;
}

// ── helper: resolveDocNo ────────────────────────────────────────────────────
// Query ic_trans → หา max running number → คืน doc_no ถัดไป
// ต้องเรียกภายใน transaction (client) เพื่อ consistency
async function resolveDocNo(client, posId, transFlag) {
  const posRes = await client.query(
    'SELECT doc_format FROM pos_id WHERE pos_id = $1 LIMIT 1',
    [posId]
  );
  if (posRes.rows.length === 0) throw new Error(`pos_id not found: ${posId}`);

  const docFormat = posRes.rows[0].doc_format || '';
  const pattern = buildDocPattern(docFormat, posId);
  return resolveDocNoFromPattern(client, pattern, transFlag);
}

async function resolveSaleDocFormat(client, docFormatCode) {
  const code = String(docFormatCode || '').trim();
  const result = code
    ? await client.query(
      `SELECT code, name_1, format, COALESCE(form_code,'') AS form_code
       FROM erp_doc_format
       WHERE screen_code = 'SI' AND code = $1
       LIMIT 1`,
      [code]
    )
    : await client.query(
      `SELECT code, name_1, format, COALESCE(form_code,'') AS form_code
       FROM erp_doc_format
       WHERE screen_code = 'SI'
       ORDER BY code
       LIMIT 1`
    );

  const docFormat = result.rows[0];
  if (!docFormat) throw new Error(code ? `sale doc_format_code not found: ${code}` : 'sale doc_format_code is required');
  return docFormat;
}

async function resolveSaleDocNo(client, docFormatCode, transFlag) {
  const docFormat = await resolveSaleDocFormat(client, docFormatCode);
  const pattern = buildDocPattern(docFormat.format || '@-YYMM####', docFormat.code);
  const docNo = await resolveDocNoFromPattern(client, pattern, transFlag);
  return {
    doc_no: docNo,
    doc_format_code: docFormat.code,
    form_code: docFormat.form_code || '',
  };
}

// ── GET /service/v1/getBranchList ──────────────────────────────────────────
async function resolveCustomerCredit(client, custCode, docDate, inquiryType) {
  if (![0, 2].includes(Number(inquiryType))) {
    return { credit_day: null, credit_date: null };
  }

  const result = await client.query(
    `WITH opt AS (
       SELECT COALESCE(use_credit_pay_bill_calc,0)::int AS use_credit_pay_bill_calc
       FROM erp_option
       LIMIT 1
     ),
     base AS (
       SELECT
         COALESCE(d.credit_day, 0)::int AS credit_day,
         COALESCE(d.pay_bill_date, 0)::int AS pay_bill_date
       FROM ar_customer c
       LEFT JOIN ar_customer_detail d ON d.ar_code = c.code
       WHERE c.code = $1
       LIMIT 1
     ),
     calc AS (
       SELECT base.*, opt.use_credit_pay_bill_calc, cp.day_to_due, cp.month_to_due
       FROM base
       CROSS JOIN opt
       LEFT JOIN ar_credit_pay_bill cp ON cp.credit_day = base.credit_day
     )
     SELECT
       credit_day,
       CASE
         WHEN use_credit_pay_bill_calc = 1 AND day_to_due IS NOT NULL THEN
           (date_trunc('month', $2::date)::date
             + (COALESCE(month_to_due,0)::int * interval '1 month')
             + ((GREATEST(COALESCE(day_to_due,1)::int,1) - 1) * interval '1 day'))::date
         WHEN pay_bill_date > 0 THEN
           make_date(
             extract(year from (CASE WHEN extract(day from $2::date)::int >= pay_bill_date THEN ($2::date + interval '1 month')::date ELSE $2::date END))::int,
             extract(month from (CASE WHEN extract(day from $2::date)::int >= pay_bill_date THEN ($2::date + interval '1 month')::date ELSE $2::date END))::int,
             LEAST(pay_bill_date, extract(day from (date_trunc('month', (CASE WHEN extract(day from $2::date)::int >= pay_bill_date THEN ($2::date + interval '1 month')::date ELSE $2::date END)) + interval '1 month - 1 day'))::int)
           )
         ELSE ($2::date + credit_day)
       END AS credit_date
     FROM calc`,
    [custCode, docDate]
  );

  if (!result.rows.length) {
    return { credit_day: 0, credit_date: docDate };
  }

  return {
    credit_day: result.rows[0].credit_day,
    credit_date: result.rows[0].credit_date,
  };
}

router.get('/getBranchList', async (req, res) => {
  try {
    const result = await query('SELECT code, name_1 FROM erp_branch_list ORDER BY code');
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getWarehouseList ───────────────────────────────────────
router.get('/getWarehouseList', async (req, res) => {
  try {
    const result = await query('SELECT code, name_1 FROM ic_warehouse ORDER BY code');
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getShelfList ───────────────────────────────────────────
router.get('/getShelfList', async (req, res) => {
  const { wh_code = '' } = req.query;
  try {
    let result;
    if (wh_code) {
      result = await query(
        "SELECT whcode, code, COALESCE(name_1,'') AS name_1 FROM ic_shelf WHERE whcode=$1 ORDER BY whcode, code",
        [wh_code]
      );
    } else {
      result = await query(
        "SELECT whcode, code, COALESCE(name_1,'') AS name_1 FROM ic_shelf ORDER BY whcode, code"
      );
    }
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getPOSList ─────────────────────────────────────────────
router.get('/getPOSList', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        p.pos_id, p.doc_format_code, p.doc_format,
        p.pos_ic_wht, p.pos_ic_shelf, p.branch_code,
        COALESCE(b.name_1, '') AS branch_name,
        COALESCE(w.name_1, '') AS wh_name,
        COALESCE(s.name_1, '') AS shelf_name
      FROM pos_id p
      LEFT JOIN erp_branch_list b ON b.code = p.branch_code
      LEFT JOIN ic_warehouse    w ON w.code = p.pos_ic_wht
      LEFT JOIN ic_shelf        s ON s.code = p.pos_ic_shelf AND s.whcode = p.pos_ic_wht
      ORDER BY p.pos_id
    `);
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getErpOption ───────────────────────────────────────────
router.get('/getErpOption', async (req, res) => {
  try {
    const result = await query('SELECT vat_type, vat_rate, discout_type FROM erp_option LIMIT 1');
    return res.json({ success: true, data: result.rows[0] || {} });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getDashboardTopProducts ────────────────────────────────
// สินค้าขายดีประจำวัน 10 รายการ (จาก ic_trans_detail JOIN ic_trans, trans_flag=44)
router.get('/getDashboardTopProducts', async (req, res) => {
  const { date = '' } = req.query;
  const targetDate = date || new Date().toISOString().slice(0, 10);
  try {
    const result = await query(
      `SELECT d.item_code, d.item_name, d.unit_code,
              SUM(d.qty)::numeric AS total_qty,
              SUM(d.qty * d.price)::numeric AS total_amount
       FROM ic_trans_detail d
       JOIN ic_trans t ON t.doc_no = d.doc_no AND t.trans_flag = 44
       WHERE d.trans_flag = 44
         AND t.doc_date = $1::date
         AND t.last_status = 0
       GROUP BY d.item_code, d.item_name, d.unit_code
       ORDER BY total_qty DESC
       LIMIT 10`,
      [targetDate]
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getDashboardSoldOut ───────────────────────────────────
// สินค้าขายหมด: รายการที่ขายในวันที่เลือก ยอดคงเหลือ (net) - ตะกร้า <= 0
router.get('/getDashboardSoldOut', async (req, res) => {
  const { date = '', from_date = '', to_date = '', user_code = '' } = req.query;
  const today = new Date().toISOString().slice(0, 10);
  const targetFromDate = from_date || date || today;
  const targetToDate = to_date || date || targetFromDate;
  try {
    const userCode = String(user_code || '').trim();
    let canViewPurchaseInfo = false;
    if (userCode) {
      const permissions = await getEmployeePermissions(query, userCode);
      canViewPurchaseInfo = permissions.includes(SOLD_OUT_PURCHASE_INFO_PERMISSION);
    }

    const purchaseInfoSelect = canViewPurchaseInfo
      ? `,
         COALESCE(last_pu.price, 0)::numeric                               AS last_purchase_price,
         COALESCE(last_pu.doc_no, '')                                       AS last_purchase_doc_no,
         COALESCE(last_pu.doc_date::text, '')                               AS last_purchase_doc_date,
         COALESCE(last_pu.supplier_code, '')                                AS last_purchase_supplier_code,
         COALESCE(last_pu.supplier_name, '')                                AS last_purchase_supplier_name`
      : '';

    const purchaseInfoJoin = canViewPurchaseInfo
      ? `LEFT JOIN LATERAL (
           SELECT
             d.price,
             d.doc_no,
             d.doc_date,
             t.cust_code AS supplier_code,
             ap.name_1 AS supplier_name
           FROM ic_trans_detail d
           JOIN ic_trans t
             ON t.doc_no = d.doc_no
            AND t.trans_flag = d.trans_flag
           LEFT JOIN ap_supplier ap
             ON ap.code = t.cust_code
           WHERE d.trans_flag = 12
             AND COALESCE(t.last_status, 0) = 0
             AND d.item_code = st.item_code
           ORDER BY
             d.doc_date DESC,
             d.doc_no DESC,
             COALESCE(t.doc_time, '') DESC,
             d.line_number DESC
           LIMIT 1
         ) last_pu ON true`
      : '';

    const result = await query(
      `WITH sold_today AS (
         SELECT DISTINCT d.item_code
         FROM ic_trans_detail d
         JOIN ic_trans t ON t.doc_no = d.doc_no AND t.trans_flag = 44
         LEFT JOIN ic_inventory inv_sold ON inv_sold.code = d.item_code
         LEFT JOIN ic_inventory_detail inv_sold_detail ON inv_sold_detail.ic_code = d.item_code
         WHERE d.trans_flag = 44
           AND t.doc_date BETWEEN LEAST($1::date, $2::date) AND GREATEST($1::date, $2::date)
           AND t.last_status = 0
           AND COALESCE(inv_sold.item_type, 0) NOT IN (1, 3)
           AND ${activeProductCondition('inv_sold_detail')}
       ),
       item_code_list AS (
         SELECT string_agg(item_code, ',') AS codes
         FROM sold_today
         WHERE item_code IS NOT NULL
       ),
       stock AS (
         SELECT s.ic_code, SUM(s.balance_qty) AS sum_balance_qty
         FROM item_code_list icl
         CROSS JOIN LATERAL sml_ic_function_stock_balance_warehouse_location(
           current_date, icl.codes, '', ''
         ) s
         GROUP BY s.ic_code
       ),
       cart AS (
         SELECT
           c.item_code,
           SUM(
             c.qty
             * COALESCE(u.stand_value, 1)::numeric
             / NULLIF(COALESCE(u.divide_value, 1), 0)::numeric
           ) AS cart_qty_std
         FROM staff_cart_order c
         LEFT JOIN ic_unit_use u
                ON u.ic_code = c.item_code
               AND u.code    = c.unit_code
         WHERE c.item_code IN (SELECT item_code FROM sold_today)
         GROUP BY c.item_code
       )
       SELECT
         st.item_code,
         COALESCE(inv.name_1, st.item_code)                                    AS item_name,
         COALESCE(stk.sum_balance_qty, 0)::numeric                             AS stock_qty,
         COALESCE(crt.cart_qty_std, 0)::numeric                                AS cart_qty,
         (COALESCE(stk.sum_balance_qty, 0) - COALESCE(crt.cart_qty_std, 0))::numeric AS remaining_qty,
         COALESCE(inv.unit_standard, '')                                        AS unit_code,
         COALESCE(un.name_1, inv.unit_standard, '')                            AS unit_name
         ${purchaseInfoSelect}
       FROM sold_today st
       LEFT JOIN ic_inventory inv ON inv.code = st.item_code
       LEFT JOIN stock stk        ON stk.ic_code = st.item_code
       LEFT JOIN cart crt         ON crt.item_code = st.item_code
       LEFT JOIN ic_unit un       ON un.code = inv.unit_standard
       ${purchaseInfoJoin}
       WHERE (COALESCE(stk.sum_balance_qty, 0) - COALESCE(crt.cart_qty_std, 0)) <= 0
       ORDER BY remaining_qty ASC`,
      [targetFromDate, targetToDate]
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getDashboardTopCustomers ───────────────────────────────
// ลูกค้าดีเด่นประจำเดือน 5 คน (ยอดสั่งซื้อสูงสุด, trans_flag=44)
router.get('/getDashboardTopCustomers', async (req, res) => {
  try {
    const result = await query(
      `SELECT t.cust_code,
              COALESCE(ar.name_1, t.cust_code) AS cust_name,
              SUM(COALESCE(cb.total_net_amount, t.total_amount))::numeric AS total_amount,
              COUNT(t.doc_no)::int AS total_docs
       FROM ic_trans t
       LEFT JOIN ar_customer ar ON ar.code = t.cust_code
       LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = 44
       WHERE t.trans_flag = 44
         AND t.last_status = 0
         AND t.doc_date >= date_trunc('month', current_date)
         AND t.doc_date <= current_date
         AND t.cust_code IS NOT NULL AND t.cust_code <> ''
       GROUP BY t.cust_code, ar.name_1
       ORDER BY total_amount DESC
       LIMIT 5`
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getDashboardTopSalesmen ────────────────────────────────
// พนักงานขายดีเด่นประจำเดือน 5 คน (ยอดขายสูงสุด, trans_flag=44)
router.get('/getDashboardTopSalesmen', async (req, res) => {
  try {
    const result = await query(
      `SELECT t.sale_code,
              COALESCE(
                (SELECT name_1 FROM erp_user WHERE UPPER(code) = UPPER(t.sale_code) LIMIT 1),
                t.sale_code
              ) AS emp_name,
              SUM(COALESCE(cb.total_net_amount, t.total_amount))::numeric AS total_amount,
              COUNT(t.doc_no)::int AS total_docs
       FROM ic_trans t
       LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = 44
       WHERE t.trans_flag = 44
         AND t.last_status = 0
         AND t.doc_date >= date_trunc('month', current_date)
         AND t.doc_date <= current_date
         AND t.sale_code IS NOT NULL AND t.sale_code <> ''
       GROUP BY t.sale_code
       ORDER BY total_amount DESC
       LIMIT 5`
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getLastDocNo ───────────────────────────────────────────
router.get('/getLastDocNo', async (req, res) => {
  const { pos_id, doc_format_code, trans_flag } = req.query;
  if (!pos_id && !doc_format_code) {
    return res.status(400).json({ success: false, msg: 'pos_id or doc_format_code is required' });
  }

  const tf = parseInt(trans_flag) || 44;
  try {
    let pattern;
    let resolvedDocFormatCode = '';
    if (doc_format_code) {
      const docFormat = await resolveSaleDocFormat({ query }, doc_format_code);
      resolvedDocFormatCode = docFormat.code;
      pattern = buildDocPattern(docFormat.format || '@-YYMM####', docFormat.code);
    } else {
      const posRes = await query('SELECT doc_format FROM pos_id WHERE pos_id=$1 LIMIT 1', [pos_id]);
      if (posRes.rows.length === 0) {
        return res.status(400).json({ success: false, msg: `pos_id not found: ${pos_id}` });
      }
      const docFormat = posRes.rows[0].doc_format || '';
      pattern = buildDocPattern(docFormat, pos_id);
    }

    const firstHash = pattern.indexOf('#');
    let latestRunning = 0;
    let latestDocNo = '';

    if (firstHash >= 0) {
      let runLen = 0;
      while (firstHash + runLen < pattern.length && pattern[firstHash + runLen] === '#') runLen++;

      const likePattern = pattern.replace(/#/g, '_');
      const rows = await query(
        'SELECT doc_no FROM ic_trans WHERE trans_flag=$1 AND char_length(doc_no)=$2 AND doc_no LIKE $3',
        [tf, pattern.length, likePattern]
      );

      for (const row of rows.rows) {
        const docNo = row.doc_no;
        if (!docNo || docNo.length !== pattern.length) continue;
        const runText = docNo.substring(firstHash, firstHash + runLen);
        if (!/^\d+$/.test(runText)) continue;
        const run = parseInt(runText, 10);
        if (run > latestRunning) { latestRunning = run; latestDocNo = docNo; }
      }
    }

    return res.json({
      success: true,
      data: {
        pos_id,
        doc_format_code: resolvedDocFormatCode || doc_format_code || '',
        trans_flag: tf,
        last_doc_no: latestDocNo,
        last_running: latestRunning,
        doc_pattern: pattern,
      },
    });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getPassBookList ───────────────────────────────────────
router.get('/getPassBookList', async (req, res) => {
  try {
    const result = await query(`
      SELECT code, bank_code,
        (SELECT name_1 FROM erp_bank WHERE code = bank_code) AS bank_name,
        bank_branch,
        (SELECT name_1 FROM erp_bank_branch WHERE code = bank_branch) AS branch_name,
        name_1 AS book_name
      FROM erp_pass_book ORDER BY code
    `);
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getCreditTypeList ─────────────────────────────────────
router.get('/getCreditTypeList', async (req, res) => {
  try {
    const result = await query('SELECT code, name_1, charge_rate FROM erp_credit_type ORDER BY code');
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/getSaleAdvanceDepositBalance', async (req, res) => {
  const custCode = String(req.query.cust_code || '').trim();
  if (!custCode) return res.json({ success: true, data: { balance_amount: 0, rows: [] } });
  try {
    const rows = await querySaleAdvanceDepositBalances(query, custCode);
    const total = rows.reduce((sum, row) => sum + toNumber(row.balance_amount), 0);
    return res.json({
      success: true,
      data: {
        balance_amount: roundMoney(total),
        rows,
      },
    });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

function getPromotionRows(obj) {
  const rows = obj.promotion_detail
    ?? obj.promotion_details
    ?? obj.promotion_product_rows
    ?? obj.promotions
    ?? [];
  return Array.isArray(rows) ? rows : [];
}

function getPromotionValue(row, ...keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

async function getSetSubItemsForSale(client, setCode) {
  const result = await client.query(
    `SELECT d.ic_code AS item_code,
            COALESCE(i.name_1, d.ic_code) AS item_name,
            d.unit_code,
            COALESCE(d.qty, 0) AS qty,
            COALESCE(d.price, 0) AS price,
            COALESCE(d.sum_amount, 0) AS sum_amount,
            COALESCE(d.barcode, '') AS barcode,
            COALESCE(d.price_ratio, 0) AS price_ratio,
            COALESCE(u.stand_value, 1) AS stand_value,
            COALESCE(u.divide_value, 1) AS divide_value,
            d.line_number,
            d.roworder
     FROM ic_inventory_set_detail d
     LEFT JOIN ic_inventory i ON i.code = d.ic_code
     LEFT JOIN ic_unit_use u ON u.ic_code = d.ic_code AND u.code = d.unit_code
     WHERE d.ic_set_code = $1
     ORDER BY COALESCE(d.line_number, d.roworder, 0), COALESCE(d.roworder, 0), d.ic_code`,
    [setCode],
  );
  return result.rows;
}

async function handleSaveTrans(req, res, options = {}) {
  const savePromotionDetails = options.savePromotionDetails === true;
  try {
    let obj = req.body;
    if (typeof obj === 'string') obj = JSON.parse(obj);

    const doc_date = obj.doc_date || '';
    const doc_time = obj.doc_time || '';
    let doc_format_code = String(obj.doc_format_code || '').trim();
    let form_code = String(obj.form_code || '').trim();
    const cust_code = obj.cust_code || 'AR0269';
    const branch_code = obj.branch_code || '';
    const emp_code = obj.emp_code || '';
    const creator_code = String(obj.creator_code || '').trim();
    const pos_id = obj.pos_id || '';
    const shelf_code = obj.shelf_code || '';
    const remark = obj.remark || '';
    const basket_id = obj.basket_id || '';

    const inquiry_type = obj.inquiry_type != null ? parseInt(obj.inquiry_type) : 1;
    const vat_type = obj.vat_type != null ? parseInt(obj.vat_type) : 1;
    const vat_rate = obj.vat_rate != null ? parseFloat(obj.vat_rate) : 7.0;
    const discount_type = obj.discount_type != null ? parseInt(obj.discount_type) : 0;
    const discount_word = obj.discount_word || '';

    const total_value_dbl = parseFloat(obj.total_value || 0);
    const total_net_amount_dbl = parseFloat(obj.total_net_amount || 0);
    const total_credit_charge_dbl = parseFloat(obj.total_credit_charge || 0);
    const tranfer_amount_dbl = parseFloat(obj.tranfer_amount || 0);
    const card_amount_dbl = parseFloat(obj.card_amount || 0);
    const wallet_amount_dbl = parseFloat(obj.wallet_amount || 0);
    const cash_amount_raw = parseFloat(obj.cash_amount || 0);
    const rounded_amount_dbl = parseFloat(obj.rounded_amount || 0);
    const total_income_amount_dbl = parseFloat(obj.total_income_amount || 0);
    const total_except_vat_dbl = parseFloat(obj.total_except_vat || 0);

    const items = Array.isArray(obj.items) ? obj.items : [];
    const payments = Array.isArray(obj.payment_detail) ? obj.payment_detail : [];
    const depositPayments = normalizeSaleDepositPayments(payments);
    const deposit_amount_dbl = roundMoney(depositPayments.reduce((sum, row) => sum + row.amount, 0));
    const promotionRows = savePromotionDetails ? getPromotionRows(obj) : [];
    const tiger_pending = obj.tiger_pending === true || obj.tiger_pending === '1' || obj.tiger_pending === 1;
    const tiger_order_id = String(obj.tiger_order_id || '').trim();
    const tiger_amount_dbl = parseFloat(obj.tiger_amount || 0);
    const tiger_ref1 = String(obj.tiger_ref1 || '').trim();
    const tiger_ref2 = String(obj.tiger_ref2 || '').trim();
    const tigerSendSms = tiger_pending ? 1 : 0;
    const tigerRemark5 = tiger_pending
      ? JSON.stringify({
        tiger: 'pending',
        amount: tiger_amount_dbl,
        ref1: tiger_ref1,
        ref2: tiger_ref2,
        status: 'pending',
      }).slice(0, 255)
      : '';

    if (!pos_id) return res.status(400).json({ success: false, msg: 'pos_id is required' });
    if (items.length === 0) return res.status(400).json({ success: false, msg: 'items is empty' });
    if (tiger_pending && !tiger_order_id) return res.status(400).json({ success: false, msg: 'tiger_order_id is required' });
    if (roundMoney(obj.deposit_amount) > 0 && depositPayments.length === 0) {
      return res.status(400).json({ success: false, msg: 'advance/deposit payment_detail is required' });
    }

    // ── ค่า VAT/discount: ใช้ค่าที่ frontend คำนวณมาแล้ว (มี breakdown vat/no-vat ถูกต้อง)
    //    ถ้าไม่ได้ส่งมา (backwards compat) → fallback คำนวณเองด้วย calcVat
    const hasClientCalc =
      obj.total_before_vat != null && obj.total_vat_value != null && obj.total_amount != null;
    let total_disc, before_vat, vat_value, after_vat, total_amount;
    if (hasClientCalc) {
      total_disc = parseFloat(obj.total_discount || 0);
      before_vat = parseFloat(obj.total_before_vat);
      vat_value = parseFloat(obj.total_vat_value);
      after_vat = parseFloat(obj.total_after_vat || (before_vat + vat_value));
      total_amount = parseFloat(obj.total_amount);
    } else {
      total_disc = calcDiscount(discount_word, total_value_dbl);
      [before_vat, vat_value, after_vat, total_amount] = calcVat(
        vat_type, vat_rate, discount_type, total_value_dbl, total_disc,
      );
    }

    // ── คำนวณ payment amounts ────────────────────────────────────────────────
    // หลักการใหม่: ปัดเศษเป็น "ชนิดการจ่ายเงิน" — จ่ายจริง + ปัดเศษ = ยอดสุทธิ
    //   total_net_amount  = ยอดสุทธิ (ไม่บวกปัดเศษ)
    //   cash_amount_raw   = เงินสดที่ลูกค้าจ่ายจริง
    //   rounded_amount    = ปัดเศษ (frontend ส่งมา; เก็บลง total_income_amount เช่นกัน)
    //   total_amount_pay  = cash + transfer + card + wallet + deposit + rounding/income
    //   money_change      = total_amount_pay − ยอดสุทธิ (ถ้ามี)
    const card_with_charge = card_amount_dbl + total_credit_charge_dbl;
    const total_income_amount = total_income_amount_dbl || rounded_amount_dbl;
    const cash_amount_in_db = cash_amount_raw;
    const total_amount_pay = roundMoney(
      cash_amount_in_db
      + tranfer_amount_dbl
      + card_with_charge
      + wallet_amount_dbl
      + total_income_amount
      + deposit_amount_dbl
    );
    const money_change = Math.max(0, roundMoney(total_amount_pay - total_net_amount_dbl));

    let doc_no;
    let promotion_count = 0;
    await withTransaction(async (client) => {
      const cartKeyForStock = basket_id ? `BASKET-${basket_id}` : '';
      const stockValidation = await validateSaleItemsStock(client, items, {
        excludeCartKey: cartKeyForStock,
      });
      if (!stockValidation.is_valid) {
        const error = new Error('SALE_STOCK_NOT_ENOUGH');
        error.code = 'SALE_STOCK_NOT_ENOUGH';
        error.stock_issues = stockValidation.stock_issues;
        throw error;
      }

      if (basket_id && (!doc_format_code || !form_code)) {
        const basketDocRes = await client.query(
          `SELECT COALESCE(doc_format_code,'') AS doc_format_code,
                  COALESCE(form_code,'') AS form_code
           FROM pos_basket
           WHERE basket_id = $1
           LIMIT 1`,
          [basket_id],
        );
        doc_format_code = doc_format_code || basketDocRes.rows[0]?.doc_format_code || '';
        form_code = form_code || basketDocRes.rows[0]?.form_code || '';
      }

      // 1. Generate doc_no
      const saleDoc = await resolveSaleDocNo(client, doc_format_code, 44);
      doc_no = saleDoc.doc_no;
      doc_format_code = saleDoc.doc_format_code;
      form_code = form_code || saleDoc.form_code;
      const customerCredit = await resolveCustomerCredit(client, cust_code, doc_date, inquiry_type);

      if (depositPayments.length > 0) {
        const depositTotals = new Map();
        for (const row of depositPayments) {
          if (!row.trans_number) throw new Error('advance/deposit document number is required');
          const key = `${row.doc_type}:${row.trans_number}`;
          depositTotals.set(key, {
            doc_type: row.doc_type,
            trans_number: row.trans_number,
            amount: roundMoney((depositTotals.get(key)?.amount || 0) + row.amount),
          });
        }

        const depositNos = [...new Set([...depositTotals.values()].map((row) => row.trans_number))];
        const balanceRows = await querySaleAdvanceDepositBalances(client.query.bind(client), cust_code, depositNos);
        const balanceMap = new Map(balanceRows.map((row) => [`${Number(row.doc_type)}:${row.doc_no}`, roundMoney(row.balance_amount)]));
        for (const row of depositTotals.values()) {
          const balance = balanceMap.get(`${row.doc_type}:${row.trans_number}`);
          if (balance === undefined) throw new Error(`advance/deposit not found: ${row.trans_number}`);
          if (row.amount > balance + 0.01) throw new Error(`advance/deposit exceeds balance: ${row.trans_number}`);
        }
      }

      // 2. INSERT ic_trans
      await client.query(
        `INSERT INTO ic_trans (
          inquiry_type,vat_type,trans_type,trans_flag,doc_date,doc_no,tax_doc_no,tax_doc_date,
          cust_code,branch_code,send_date,vat_rate,total_value,total_vat_value,total_after_vat,
          total_amount,total_before_vat,total_except_vat,doc_time,doc_format_code,creator_code,sale_code,
          total_discount,discount_word,remark,send_type,send_sms,remark_3,remark_4,remark_5,pos_id,
          credit_day,credit_date
        ) VALUES ($1,$2,2,44,$3::date,$4,$4,$3::date,$5,$6,$3::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,0,$21,$22,$23,$24,$25,$26,$27::date)`,
        [
          inquiry_type, vat_type,
          doc_date, doc_no,
          cust_code, branch_code,
          vat_rate,
          total_value_dbl, vat_value, after_vat, total_amount, before_vat, total_except_vat_dbl,
          doc_time, doc_format_code,
          creator_code, emp_code,
          total_disc, discount_word, remark,
          tigerSendSms, tiger_order_id, shelf_code, tigerRemark5, pos_id,
          customerCredit.credit_day, customerCredit.credit_date,
        ]
      );

      // 3. INSERT cb_trans
      await client.query(
        `INSERT INTO cb_trans (
          trans_type,trans_flag,doc_no,doc_date,doc_time,ap_ar_code,pay_type,doc_format_code,
          total_amount,total_net_amount,cash_amount,tranfer_amount,card_amount,
          total_amount_pay,total_credit_charge,wallet_amount,total_income_amount,
          deposit_amount,pay_cash_amount,money_change
        ) VALUES (2,44,$1,$2::date,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          doc_no, doc_date, doc_time, cust_code, doc_format_code,
          total_amount, total_net_amount_dbl,
          cash_amount_in_db, tranfer_amount_dbl, card_with_charge,
          total_amount_pay, total_credit_charge_dbl, wallet_amount_dbl,
          total_income_amount, deposit_amount_dbl, cash_amount_raw, money_change,
        ]
      );

      // 3.5 INSERT gl_journal_vat_sale (1 row ต่อเอกสาร — สำหรับรายงานภาษีขาย)
      const arNameRow = await client.query(
        'SELECT COALESCE(name_1, $2) AS name_1 FROM ar_customer WHERE code = $1 LIMIT 1',
        [cust_code, '']
      );
      const ar_name = arNameRow.rows[0]?.name_1 || '';
      const docDateObj = new Date(doc_date);
      const vat_effective_period = docDateObj.getMonth() + 1;
      const vat_effective_year = docDateObj.getFullYear() + 543;
      await client.query(
        `INSERT INTO gl_journal_vat_sale (
          ignore_sync,is_lock_record,doc_date,doc_no,book_code,line_number,vat_number,
          tax_group,description,base_caltax_amount,tax_rate,amount,except_tax_amount,
          period_number,is_add,vat_date,trans_type,trans_flag,vat_effective_period,
          ar_code,ar_name,vat_calc,vat_effective_year,branch_type,branch_code,tax_no,
          manual_add,is_doc_copy,create_date_time_now,vat_type,
          ref_vat_no,ref_vat_date,ref_doc_no,ref_doc_date
        ) VALUES (0,0,$1::date,$2,'',0,$2,'','',$3,$4,$5,$6,0,0,$1::date,2,44,$7,
          $8,$9,1,$10,0,$11,'',0,0,NOW(),0,'',NULL,'',NULL)`,
        [
          doc_date, doc_no,
          before_vat, vat_rate, vat_value, total_except_vat_dbl,
          vat_effective_period,
          cust_code, ar_name,
          vat_effective_year, branch_code,
        ]
      );

      // 4. DELETE + INSERT ic_trans_detail
      await client.query('DELETE FROM ic_trans_detail WHERE doc_no=$1', [doc_no]);
      const r2 = (v) => Math.round(v * 100) / 100;
      const calcLineVat = (sumAmount, price, taxType) => {
        if (taxType === 1) {
          return { sumExcludeVat: sumAmount, vatValue: 0, priceExcludeVat: price };
        }
        if (vat_type === 1) {
          const sumExcludeVat = r2((sumAmount * 100) / (100 + vat_rate));
          return {
            sumExcludeVat,
            vatValue: r2(sumAmount - sumExcludeVat),
            priceExcludeVat: r2((price * 100) / (100 + vat_rate)),
          };
        }
        if (vat_type === 0) {
          return {
            sumExcludeVat: sumAmount,
            vatValue: r2(sumAmount * (vat_rate / 100)),
            priceExcludeVat: price,
          };
        }
        return { sumExcludeVat: sumAmount, vatValue: 0, priceExcludeVat: price };
      };

      const insertDetailLine = async ({
        item,
        qty,
        price,
        sumAmount,
        lineNumber,
        itemType = 0,
        setRefLine = '',
        setRefPrice = price,
        setRefQty = 0,
        itemCodeMain = '',
        refGuid = '',
        priceSetRatio = 0,
        taxType = Number(item.tax_type ?? 0),
        discount = item.discount || '',
        discountAmount = parseFloat(item.discount_amount || 0),
      }) => {
        const tax = calcLineVat(sumAmount, price, taxType);
        await client.query(
          `INSERT INTO ic_trans_detail (
            set_ref_line,set_ref_price,set_ref_qty,item_type,item_code_main,ref_guid,price_set_ratio,
            inquiry_type,vat_type,trans_type,trans_flag,doc_date,doc_no,cust_code,
            item_code,item_name,unit_code,qty,price,sum_amount,line_number,remark,
            wh_code,shelf_code,stand_value,divide_value,ratio,doc_time,doc_date_calc,
            discount,discount_amount,barcode,calc_flag,
            tax_type,sum_amount_exclude_vat,total_vat_value,price_exclude_vat
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,2,44,$10::date,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$10::date,$27,$28,$29,$30,$31,$32,$33,$34)`,
          [
            setRefLine,
            parseFloat(setRefPrice || 0),
            parseFloat(setRefQty || 0),
            parseInt(itemType || 0, 10),
            itemCodeMain,
            refGuid,
            parseFloat(priceSetRatio || 0),
            1,
            vat_type,
            doc_date,
            doc_no,
            cust_code,
            item.item_code || '',
            item.item_name || '',
            item.unit_code || '',
            parseFloat(qty || 0),
            parseFloat(price || 0),
            parseFloat(sumAmount || 0),
            lineNumber,
            item.remark || '',
            item.wh_code || '',
            item.shelf_code || '',
            parseFloat(item.stand_value || 0),
            parseFloat(item.divide_value || 0),
            0,
            doc_time,
            discount,
            discountAmount,
            item.barcode || '',
            -1,
            taxType,
            tax.sumExcludeVat,
            tax.vatValue,
            tax.priceExcludeVat,
          ],
        );
      };

      let detailLineNumber = 0;
      for (const it of items) {
        const itQty = parseFloat(it.qty || 0);
        const itPrice = parseFloat(it.price || 0);
        const itSum = parseFloat(it.sum_amount || 0);
        const itTaxType = Number(it.tax_type ?? 0);
        const itemType = String(it.item_type ?? '0');

        if (itemType !== '3') {
          await insertDetailLine({
            item: it,
            qty: itQty,
            price: itPrice,
            sumAmount: itSum,
            lineNumber: detailLineNumber++,
            itemType: parseInt(itemType || '0', 10) || 0,
            setRefPrice: itPrice,
            taxType: itTaxType,
          });
          continue;
        }

        const parentGuid = uuidv4();
        await insertDetailLine({
          item: it,
          qty: itQty,
          price: itPrice,
          sumAmount: itSum,
          lineNumber: detailLineNumber++,
          itemType: 3,
          setRefPrice: 0,
          refGuid: parentGuid,
          taxType: itTaxType,
        });

        const subItems = Array.isArray(it.sub_item) && it.sub_item.length > 0
          ? it.sub_item
          : await getSetSubItemsForSale(client, it.item_code);

        for (const sub of subItems) {
          const subQtyPerSet = parseFloat(sub.qty || 0);
          const subPrice = parseFloat(sub.price || 0);
          await insertDetailLine({
            item: {
              ...sub,
              wh_code: it.wh_code || '',
              shelf_code: it.shelf_code || '',
              stand_value: 1,
              divide_value: 1,
              ratio: 0,
              tax_type: itTaxType,
            },
            qty: itQty * subQtyPerSet,
            price: subPrice,
            sumAmount: subPrice * itQty * subQtyPerSet,
            lineNumber: detailLineNumber++,
            itemType: 0,
            setRefLine: parentGuid,
            setRefPrice: subPrice,
            setRefQty: subQtyPerSet,
            itemCodeMain: it.item_code || '',
            priceSetRatio: parseFloat(sub.price_ratio || 0),
            taxType: itTaxType,
            discount: '',
            discountAmount: 0,
          });
        }
      }

      for (let i = 0; false && i < items.length; i++) {
        const it = items[i];
        const it_qty = parseFloat(it.qty || 0);
        const it_price = parseFloat(it.price || 0);
        const it_sum = parseFloat(it.sum_amount || 0);
        const it_tax_type = Number(it.tax_type ?? 0);

        // คำนวณ base/vat รายบรรทัด ตาม tax_type ของสินค้าและ vat_type ของเอกสาร
        // tax_type=1 (ยกเว้น): ไม่มี VAT — ใช้ราคา/ยอดเดิม
        // tax_type=0 + vat_type=1 (รวมใน): แยก VAT ออกจากยอด
        // tax_type=0 + vat_type=0 (แยกนอก): VAT คิดเพิ่มจากยอด, base=ยอดเดิม
        // อื่น ๆ (ไม่กระทบ/ศูนย์): ไม่มี VAT
        let sum_amount_exclude_vat, line_vat_value, price_exclude_vat;
        if (it_tax_type === 1) {
          sum_amount_exclude_vat = it_sum;
          line_vat_value = 0;
          price_exclude_vat = it_price;
        } else if (vat_type === 1) {
          sum_amount_exclude_vat = r2((it_sum * 100) / (100 + vat_rate));
          line_vat_value = r2(it_sum - sum_amount_exclude_vat);
          price_exclude_vat = r2((it_price * 100) / (100 + vat_rate));
        } else if (vat_type === 0) {
          sum_amount_exclude_vat = it_sum;
          line_vat_value = r2(it_sum * (vat_rate / 100));
          price_exclude_vat = it_price;
        } else {
          sum_amount_exclude_vat = it_sum;
          line_vat_value = 0;
          price_exclude_vat = it_price;
        }

        await client.query(
          `INSERT INTO ic_trans_detail (
            inquiry_type,vat_type,trans_type,trans_flag,doc_date,doc_no,cust_code,
            item_code,item_name,unit_code,qty,price,sum_amount,line_number,remark,
            wh_code,shelf_code,stand_value,divide_value,ratio,doc_time,doc_date_calc,
            discount,discount_amount,barcode,calc_flag,
            tax_type,sum_amount_exclude_vat,total_vat_value,price_exclude_vat
          ) VALUES ($1,$2,2,44,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,'',$13,$14,$15,$16,$17,$18,$3::date,$19,$20,$21,$22,$23,$24,$25,$26)`,
          [
            1, vat_type,
            doc_date, doc_no, cust_code,
            it.item_code, it.item_name, it.unit_code,
            it_qty, it_price,
            it_sum, i,
            it.wh_code || '', it.shelf_code || '',
            parseFloat(it.stand_value || 0), parseFloat(it.divide_value || 0), 0,
            doc_time,
            it.discount || '', parseFloat(it.discount_amount || 0), it.barcode || '', -1,
            it_tax_type, sum_amount_exclude_vat, line_vat_value, price_exclude_vat,
          ]
        );
      }

      if (savePromotionDetails) {
        await client.query('DELETE FROM ic_trans_detail_promotion WHERE doc_no=$1 AND trans_flag=44', [doc_no]);
        for (let i = 0; i < promotionRows.length; i++) {
          const row = promotionRows[i] || {};
          const promotion_code = String(getPromotionValue(row, 'promotion_code', '_promotionCode', 'code') || '').trim();
          const promotion_name = String(getPromotionValue(row, 'promotion_name', 'item_name', '_promotionName', 'name_1') || '').trim();
          const qty = parseFloat(getPromotionValue(row, 'qty', '_qty', 'count', '_count') || 0);
          const amount = parseFloat(getPromotionValue(row, 'sum_amount', 'amount', '_amount') || 0);
          const rawPrice = getPromotionValue(row, 'price', '_price');
          const price = rawPrice == null || rawPrice === ''
            ? (qty === 0 ? 0 : amount / qty)
            : parseFloat(rawPrice || 0);
          const lineNumberRaw = getPromotionValue(row, 'line_number', 'lineNumber');
          const lineNumber = lineNumberRaw == null || lineNumberRaw === ''
            ? detailLineNumber + i
            : parseInt(lineNumberRaw, 10);

          if (!promotion_code && !promotion_name && qty === 0 && amount === 0) continue;

          await client.query(
            `INSERT INTO ic_trans_detail_promotion (
              doc_no,doc_date,trans_flag,promotion_code,promotion_name,qty,price,sum_amount,line_number
            ) VALUES ($1,$2::date,44,$3,$4,$5,$6,$7,$8)`,
            [doc_no, doc_date, promotion_code, promotion_name, qty, price, amount, Number.isFinite(lineNumber) ? lineNumber : detailLineNumber + i]
          );
          promotion_count++;
        }
      }

      // 5. DELETE + INSERT cb_trans_detail
      await client.query('DELETE FROM cb_trans_detail WHERE doc_no=$1', [doc_no]);
      for (const p of payments) {
        const pay_type = String(p.pay_type || '0');
        const pay_amount = parseFloat(p.pay_amount || 0);
        const trans_number = p.trans_number || '';
        const charge = parseFloat(p.charge || 0);
        const detail_doc_type = parseInt(p.doc_type || p.pay_type || 0, 10);

        if ((detail_doc_type === 5 || detail_doc_type === 6) && pay_amount > 0) {
          await client.query(
            `INSERT INTO cb_trans_detail (
              trans_type,trans_flag,doc_no,doc_date,doc_time,trans_number,
              amount,sum_amount,doc_type,ap_ar_code,ap_ar_type,remark
            ) VALUES (2,$1,$2,$3::date,$4,$5,$6,$6,$7,$8,1,$9)`,
            [
              44, doc_no, doc_date, doc_time, trans_number,
              pay_amount, detail_doc_type, cust_code,
              p.remark || '',
            ]
          );
        } else if (pay_type === '0') {
          // โอน
          const pb_bank_code = p.bank_code || 'KBANK';
          const pb_bank_branch = p.bank_branch || 'KBANK2';
          const transfer_date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.transfer_date || p.chq_due_date || ''))
            ? String(p.transfer_date || p.chq_due_date)
            : doc_date;
          await client.query(
            `INSERT INTO cb_trans_detail (
              trans_type,trans_flag,doc_no,doc_date,doc_time,trans_number,
              bank_code,bank_branch,amount,sum_amount,doc_type,ap_ar_code,
              chq_due_date,trans_number_type,ap_ar_type
            ) VALUES (2,$1,$2,$3::date,$4,$5,$6,$7,$8,$8,'1',$9,$10::date,0,0)`,
            [44, doc_no, doc_date, doc_time, trans_number, pb_bank_code, pb_bank_branch, pay_amount, cust_code, transfer_date]
          );
        } else if (pay_type === '21') {
          // บัตรเครดิต
          const cc_type = p.credit_card_type || 'NONE';
          const sum_amt = pay_amount + charge;
          await client.query(
            `INSERT INTO cb_trans_detail (
              trans_type,trans_flag,doc_no,doc_date,doc_time,trans_number,
              credit_card_type,amount,sum_amount,doc_type,ap_ar_code,
              trans_number_type,ap_ar_type,charge,ref1,no_approved
            ) VALUES (2,$1,$2,$3::date,$4,$5,$6,$7,$8,'21',$9,1,1,$10,$2,$11)`,
            [44, doc_no, doc_date, doc_time, trans_number, cc_type, pay_amount, sum_amt, cust_code, charge, p.no_approved || '']
          );
        } else {
          // wallet 
          const sum_amt = pay_amount + charge;
          await client.query(
            `INSERT INTO cb_trans_detail (
              trans_type,trans_flag,doc_no,doc_date,doc_time,trans_number,
              credit_card_type,amount,sum_amount,doc_type,ap_ar_code,
              trans_number_type,ap_ar_type,charge
            ) VALUES (2,$1,$2,$3::date,$4,$5,'WC',$6,$7,'3',$8,1,1,$9)`,
            [44, doc_no, doc_date, doc_time, trans_number, pay_amount, sum_amt, cust_code, charge]
          );
        }
      }

      // 6. Clear cart
      const cart_key = basket_id ? `BASKET-${basket_id}` : cust_code;
      const staffCartTable = await client.query("SELECT to_regclass('public.staff_cart_order') AS table_name");
      if (staffCartTable.rows[0]?.table_name) {
        await client.query('DELETE FROM staff_cart_order WHERE cust_code=$1', [cart_key]);
      }

      // Reset basket to empty after sale
      if (basket_id) {
        await client.query(
          `UPDATE pos_basket
           SET cust_code='', cust_name='', sale_code='', sale_name='',
               doc_format_code='', form_code='',
               status='empty', updated_at=NOW()
           WHERE basket_id=$1`,
          [basket_id]
        );
      }

      // 7. Queue IC process for sold items
      await client.query(
        `INSERT INTO process (process_name, wherein)
         SELECT 'IC', item_code FROM ic_trans_detail WHERE doc_no = $1 AND trans_flag = 44`,
        [doc_no]
      );
    });

    return res.json({
      success: true,
      doc_no,
      doc_format_code,
      form_code,
      promotion_count,
      msg: 'success',
    });
  } catch (ex) {
    const msg = ex.message || '';
    if (ex.code === 'SALE_STOCK_NOT_ENOUGH') {
      return res.status(409).json({
        success: false,
        msg: 'สินค้าในตะกร้าสต๊อกไม่พอ',
        stock_issues: ex.stock_issues || [],
      });
    }
    if (msg.includes('running overflow')) {
      return res.status(409).json({ success: false, msg: 'ERR_DOC_RUNNING_OVERFLOW: ' + msg });
    }
    if (msg.includes('advance/deposit')) {
      return res.status(400).json({ success: false, msg });
    }
    return res.status(500).json({ success: false, msg });
  }
}

// ── POST /service/v1/saveTrans ─────────────────────────────────────────────
router.post('/saveTrans', async (req, res) => {
  return handleSaveTrans(req, res);
});

// ── POST /service/v1/saveTransAndPro ───────────────────────────────────────
router.post('/saveTransAndPro', async (req, res) => {
  return handleSaveTrans(req, res, { savePromotionDetails: true });
});

router.post('/savetransandpro', async (req, res) => {
  return handleSaveTrans(req, res, { savePromotionDetails: true });
});

// ── GET /service/v1/getDocSaleHistory ──────────────────────────────────────
// ลอกจาก Java: ถ้ามี search → ยกเลิก date filter และค้นด้วย doc_no/cust_code/name_1 แทน
router.get('/getDocSaleHistory', async (req, res) => {
  const { search = '', from_date = '', to_date = '', sale_kind = '' } = req.query;
  try {
    const params = [];
    let whereExtra = '';
    let saleKindWhere = '';

    if (sale_kind === 'cash') {
      saleKindWhere = ' AND ict.inquiry_type IN (1,3)';
    } else if (sale_kind === 'credit') {
      saleKindWhere = ' AND ict.inquiry_type IN (0,2)';
    }

    if (search.trim()) {
      // แบ่งคำค้นหาเป็น token แต่ละคำ (whitespace) — ทุกคำต้องตรงในบางฟิลด์ (AND)
      // ทำให้ค้น "อู่ ช่าง เขม" เจอลูกค้าที่ชื่อมีทั้งสามคำ แม้ไม่ได้อยู่ติดกัน
      const tokens = search.trim().split(/\s+/).filter(Boolean).slice(0, 20);
      const clauses = tokens.map((tok) => {
        params.push(`%${tok}%`);
        const idx = params.length;
        return `(ict.doc_no ILIKE $${idx} OR ict.cust_code ILIKE $${idx} OR ar.name_1 ILIKE $${idx})`;
      });
      whereExtra = clauses.length ? ` AND (${clauses.join(' AND ')})` : '';
    } else if (from_date.trim() && to_date.trim()) {
      params.push(from_date.trim(), to_date.trim());
      whereExtra = ` AND ict.doc_date BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
    }

    const sql = `
      SELECT ict.doc_no, ict.doc_date, ict.doc_time, ict.inquiry_type, ict.total_amount,
        COALESCE(ict.doc_format_code,'') AS doc_format_code,
        COALESCE(df.name_1,'') AS doc_format_name,
        COALESCE(df.form_code,'') AS form_code,
        ict.cust_code, COALESCE(ar.name_1,'') AS cust_name,
        COALESCE(ict.send_sms,0) AS send_sms,
        COALESCE(ict.remark_3,'') AS tiger_order_id,
        COALESCE(ict.remark_5,'') AS tiger_status_note,
        cb.cash_amount, cb.tranfer_amount, cb.card_amount, cb.wallet_amount, cb.deposit_amount,
        cb.total_credit_charge,
        COALESCE(NULLIF(cb.total_net_amount,0), ict.total_amount, 0) AS total_net_amount,
        cb.total_net_amount AS payment_net_amount,
        cb.total_amount_pay
      FROM ic_trans ict
      LEFT JOIN ar_customer ar ON ar.code = ict.cust_code
      LEFT JOIN cb_trans cb ON cb.doc_no = ict.doc_no AND cb.trans_flag = 44
      LEFT JOIN erp_doc_format df ON df.screen_code = 'SI' AND df.code = ict.doc_format_code
      WHERE ict.trans_flag = 44
        AND ict.last_status = 0
        ${saleKindWhere}
        ${whereExtra}
      ORDER BY ict.create_datetime DESC
    `;

    const result = await query(sql, params);
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getProductSaleHistory ───────────────────────────────────
// ประวัติขายระดับเอกสาร: ค้นด้วยสินค้า / ลูกค้า / เลขที่เอกสาร และรวมขายสด+ขายเชื่อ
router.get('/getProductSaleHistory', async (req, res) => {
  const { search = '', from_date = '', to_date = '', item_code = '' } = req.query;
  try {
    const params = [];
    let whereExtra = '';
    let itemCodeWhere = '';
    const itemCode = String(item_code || '').trim();
    if (itemCode) {
      params.push(itemCode);
      itemCodeWhere = `AND d.item_code = $${params.length}`;
    }

    if (search.trim()) {
      const tokens = search.trim().split(/\s+/).filter(Boolean).slice(0, 20);
      const clauses = tokens.map((tok) => {
        params.push(`%${tok}%`);
        const idx = params.length;
        return `(
          t.doc_no ILIKE $${idx}
          OR t.cust_code ILIKE $${idx}
          OR ar.name_1 ILIKE $${idx}
          OR EXISTS (
            SELECT 1
            FROM ic_trans_detail d
            LEFT JOIN ic_inventory_detail item_detail ON item_detail.ic_code = d.item_code
            WHERE d.doc_no = t.doc_no
              AND d.trans_flag = t.trans_flag
              AND (COALESCE(d.set_ref_line,'') = '' OR COALESCE(d.item_type,0) = 3)
              AND ${activeProductCondition('item_detail')}
              AND (d.item_code ILIKE $${idx} OR d.item_name ILIKE $${idx})
          )
        )`;
      });
      whereExtra = clauses.length ? ` AND (${clauses.join(' AND ')})` : '';
    } else if (from_date.trim() && to_date.trim()) {
      params.push(from_date.trim(), to_date.trim());
      whereExtra = ` AND t.doc_date BETWEEN $${params.length - 1}::date AND $${params.length}::date`;
    }

    const sql = `
      SELECT
        t.doc_no,
        t.doc_date,
        t.doc_time,
        t.inquiry_type,
        COALESCE(t.total_amount,0) AS total_amount,
        t.cust_code,
        COALESCE(t.doc_format_code,'') AS doc_format_code,
        COALESCE(df.name_1,'') AS doc_format_name,
        COALESCE(df.form_code,'') AS form_code,
        COALESCE(ar.name_1, '') AS cust_name,
        COALESCE(t.send_sms,0) AS send_sms,
        COALESCE(t.remark_3,'') AS tiger_order_id,
        COALESCE(t.remark_5,'') AS tiger_status_note,
        cb.cash_amount,
        cb.tranfer_amount,
        cb.card_amount,
        cb.wallet_amount,
        cb.deposit_amount,
        cb.total_credit_charge,
        COALESCE(NULLIF(cb.total_net_amount,0), t.total_amount, 0) AS total_net_amount,
        cb.total_net_amount AS payment_net_amount,
        cb.total_amount_pay
      FROM ic_trans t
      LEFT JOIN ar_customer ar ON ar.code = t.cust_code
      LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = 44
      LEFT JOIN erp_doc_format df ON df.screen_code = 'SI' AND df.code = t.doc_format_code
      WHERE t.trans_flag = 44
        AND COALESCE(t.last_status,0) = 0
        AND EXISTS (
          SELECT 1
          FROM ic_trans_detail d
          LEFT JOIN ic_inventory_detail item_detail ON item_detail.ic_code = d.item_code
          WHERE d.doc_no = t.doc_no
            AND d.trans_flag = t.trans_flag
            AND (COALESCE(d.set_ref_line,'') = '' OR COALESCE(d.item_type,0) = 3)
            AND ${activeProductCondition('item_detail')}
            ${itemCodeWhere}
        )
        ${whereExtra}
      ORDER BY t.create_datetime DESC
    `;

    const result = await query(sql, params);
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ── GET /service/v1/getDocSaleHistoryDetail ────────────────────────────────
router.get('/getDocSaleHistoryDetail', async (req, res) => {
  const { doc_no = '' } = req.query;
  if (!doc_no) return res.status(400).json({ success: false, msg: 'doc_no is required' });
  try {
    const [headerRes, itemsRes, promotionTableRes] = await Promise.all([
      query(
        `SELECT t.inquiry_type, t.vat_type, t.vat_rate,
            COALESCE(t.doc_format_code,'') AS doc_format_code,
            COALESCE(df.name_1,'') AS doc_format_name,
            COALESCE(df.form_code,'') AS form_code,
            t.total_amount, t.total_before_vat, t.total_vat_value,
            t.total_after_vat, t.total_discount, t.remark,
            COALESCE(t.send_sms,0) AS send_sms,
            COALESCE(t.remark_3,'') AS tiger_order_id,
            COALESCE(t.remark_5,'') AS tiger_status_note,
            COALESCE(NULLIF(cb.total_net_amount,0), t.total_amount, 0) AS total_net_amount,
            cb.total_net_amount AS payment_net_amount,
            COALESCE(cb.cash_amount, 0) AS cash_amount,
            COALESCE(cb.tranfer_amount, 0) AS tranfer_amount,
            COALESCE(cb.card_amount, 0) AS card_amount,
            COALESCE(cb.deposit_amount, 0) AS deposit_amount,
            COALESCE(cb.total_credit_charge, 0) AS total_credit_charge,
            COALESCE(cb.money_change, 0) AS money_change
         FROM ic_trans t
         LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = 44
         LEFT JOIN erp_doc_format df ON df.screen_code = 'SI' AND df.code = t.doc_format_code
         WHERE t.trans_flag = 44 AND t.doc_no = $1 LIMIT 1`,
        [doc_no]
      ),
      query(
        `SELECT item_code, item_name, unit_code, qty, price, sum_amount,
          COALESCE(price_exclude_vat, price, 0) AS price_exclude_vat,
          COALESCE(sum_amount_exclude_vat, sum_amount, 0) AS sum_amount_exclude_vat,
          COALESCE(total_vat_value,0) AS total_vat_value,
          COALESCE(item_type,0) AS item_type,
          COALESCE(set_ref_line,'') AS set_ref_line,
          COALESCE(discount,'') AS discount, COALESCE(discount_amount,0) AS discount_amount
         FROM ic_trans_detail
         WHERE trans_flag = 44 AND doc_no = $1
           AND (COALESCE(set_ref_line,'') = '' OR COALESCE(item_type,0) = 3)
         ORDER BY line_number`,
        [doc_no]
      ),
      query(
        `SELECT to_regclass('public.ic_trans_detail_promotion') IS NOT NULL AS table_exists`,
        []
      ),
    ]);
    let promotions = [];
    if (promotionTableRes.rows[0]?.table_exists) {
      const promotionRes = await query(
        `SELECT promotion_code, promotion_name, qty, price, sum_amount, line_number
         FROM ic_trans_detail_promotion
         WHERE trans_flag = 44 AND doc_no = $1
         ORDER BY line_number`,
        [doc_no]
      );
      promotions = promotionRes.rows;
    }
    const h = headerRes.rows[0] || {};
    return res.json({
      success: true,
      data: {
        header: h,
        items: itemsRes.rows,
        promotions,
        promotion_detail: promotions,
      },
    });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

module.exports = router;

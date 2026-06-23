const express = require('express');
const router = express.Router();
const { withTransaction, query } = require('../db');
const { resolveDocumentNo } = require('../utils/docFormat');
const { getEmployeePermissions } = require('../utils/permissions');
const { renderSalePrintHtml } = require('../utils/salePrintRenderer');

const TRANS_TYPE = 2;
const TRANS_FLAG = 40;
const SCREEN_CODE = 'SD';
const ADVANCE_PAYMENT_VIEW_PERMISSION = 'sales.advance_payment.view';
const ADVANCE_PAYMENT_HISTORY_PERMISSION = 'sales.advance_payment.history.view';
const ADVANCE_PAYMENT_READ_PERMISSIONS = [ADVANCE_PAYMENT_VIEW_PERMISSION, ADVANCE_PAYMENT_HISTORY_PERMISSION];
const ADVANCE_PAYMENT_CREATE_PERMISSION = 'sales.advance_payment.create';

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
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function currentTimeText() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function normalizeDate(value, fallback = todayISO()) {
  const text = safeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function addDays(dateText, days) {
  const date = new Date(`${normalizeDate(dateText)}T00:00:00`);
  date.setDate(date.getDate() + toInt(days));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function splitFormCodes(value) {
  return String(value || '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
}

function uniqueCodes(codes) {
  const seen = new Set();
  return codes.filter((code) => {
    const key = code.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lowerCodes(codes) {
  return codes.map((code) => code.toLowerCase());
}

function asAmountText(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || Math.abs(num) < 0.005) return '';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
      remark: safeText(row?.remark) || 'รับเงินล่วงหน้า',
      amount: roundMoney(row?.amount ?? row?.sum_debt_amount),
    }))
    .filter((row) => row.amount > 0);
}

function normalizePayments(value) {
  const source = value && typeof value === 'object' ? value : {};
  const transfer = Array.isArray(source.transfer) ? source.transfer : [];
  const card = Array.isArray(source.card) ? source.card : [];
  const cheque = Array.isArray(source.cheque) ? source.cheque : [];
  const tiger = Array.isArray(source.tiger) ? source.tiger : [];
  const tigerRows = tiger
    .map((row) => ({
      tiger_order_id: safeText(row?.tiger_order_id),
      amount: roundMoney(row?.amount ?? row?.pay_amount),
      ref1: safeText(row?.ref1),
      ref2: safeText(row?.ref2),
    }))
    .filter((row) => row.amount > 0);
  const tigerAmount = source.tiger_amount === undefined
    ? roundMoney(tigerRows.reduce((sum, row) => sum + row.amount, 0))
    : roundMoney(source.tiger_amount);
  return {
    cash_amount: roundMoney(source.cash_amount),
    tiger_amount: tigerAmount,
    tiger: tigerRows,
    petty_cash_amount: roundMoney(source.petty_cash_amount),
    discount_amount: roundMoney(source.discount_amount),
    total_income_amount: roundMoney(source.total_income_amount),
    transfer: transfer
      .map((row) => ({
        pass_book_code: safeText(row?.pass_book_code || row?.trans_number),
        bank_code: safeText(row?.bank_code),
        bank_branch: safeText(row?.bank_branch),
        chq_due_date: normalizeDate(row?.transfer_date || row?.chq_due_date || row?.due_date, ''),
        amount: roundMoney(row?.amount ?? row?.pay_amount),
      }))
      .filter((row) => row.amount > 0),
    card: card
      .map((row) => ({
        credit_card_type: safeText(row?.credit_card_type || row?.credit_type) || 'WR',
        trans_number: safeText(row?.trans_number || row?.card_number) || '1',
        no_approved: safeText(row?.no_approved || row?.approval_no),
        amount: roundMoney(row?.amount ?? row?.pay_amount),
        charge: roundMoney(row?.charge),
      }))
      .filter((row) => row.amount > 0),
    cheque: cheque
      .map((row) => ({
        trans_number: safeText(row?.trans_number || row?.chq_number),
        amount: roundMoney(row?.amount ?? row?.pay_amount),
        chq_due_date: normalizeDate(row?.chq_due_date || row?.due_date, ''),
      }))
      .filter((row) => row.amount > 0),
  };
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

async function assertAnyPermission(queryFn, userCode, permissionKeys) {
  const code = safeText(userCode);
  if (!code) throw new Error('creator_code or emp_code is required for permission check');
  const permissions = await getEmployeePermissions(queryFn, code);
  if (!permissionKeys.some((key) => permissions.includes(key))) {
    throw new Error(`permission denied: ${permissionKeys.join(' or ')}`);
  }
}

async function assertCreatePermission(client, userCode) {
  await assertPermission(client.query.bind(client), userCode, ADVANCE_PAYMENT_CREATE_PERMISSION);
}

function calcVatTotals(totalValue, vatType, vatRate) {
  const total = roundMoney(totalValue);
  const type = toInt(vatType);
  const rate = toNumber(vatRate);
  if (rate <= 0 || type === 2 || type === 3) {
    return {
      total_value: total,
      total_before_vat: 0,
      total_vat_value: 0,
      total_except_vat: 0,
      total_amount: total,
    };
  }
  if (type === 1) {
    const beforeVat = roundMoney((total * 100) / (100 + rate));
    return {
      total_value: total,
      total_before_vat: beforeVat,
      total_vat_value: roundMoney(total - beforeVat),
      total_except_vat: 0,
      total_amount: total,
    };
  }
  const vatValue = roundMoney(total * (rate / 100));
  return {
    total_value: total,
    total_before_vat: total,
    total_vat_value: vatValue,
    total_except_vat: 0,
    total_amount: roundMoney(total + vatValue),
  };
}

async function getPassBook(client, code) {
  if (!code) return null;
  const result = await client.query(
    `SELECT code, bank_code, bank_branch
     FROM erp_pass_book
     WHERE code = $1
     LIMIT 1`,
    [code],
  );
  return result.rows[0] || null;
}

async function loadPaymentRowsForPrint(docNo) {
  const tableRes = await query(
    `SELECT
        to_regclass('public.cb_trans') AS cb_table,
        to_regclass('public.cb_trans_detail') AS cb_detail_table`
  );
  if (!tableRes.rows[0]?.cb_table) return [];

  const cbRes = await query(
    `SELECT
        COALESCE(cash_amount,0) AS cash_amount,
        COALESCE(tranfer_amount,0) AS tranfer_amount,
        COALESCE(card_amount,0) AS card_amount
     FROM cb_trans
     WHERE doc_no = $1 AND trans_flag = $2
     LIMIT 1`,
    [docNo, TRANS_FLAG],
  );

  const labels = [];
  const amounts = [];
  const cashAmount = asAmountText(cbRes.rows[0]?.cash_amount);
  if (cashAmount) {
    labels.push('เงินสด');
    amounts.push(cashAmount);
  }

  if (tableRes.rows[0]?.cb_detail_table) {
    const detailRes = await query(
      `SELECT doc_type, COALESCE(trans_number,'') AS trans_number, COALESCE(amount,0) AS amount
       FROM cb_trans_detail
       WHERE doc_no = $1 AND trans_flag = $2
       ORDER BY roworder`,
      [docNo, TRANS_FLAG],
    );

    for (const row of detailRes.rows) {
      const amount = asAmountText(row.amount);
      if (!amount) continue;
      const docType = Number(row.doc_type || 0);
      let label = String(row.trans_number || '').trim();
      if (docType === 1) label = label ? `เงินโอน ~ ${label}` : 'เงินโอน';
      else if (docType === 3) label = label ? `บัตรเครดิต ~ ${label}` : 'บัตรเครดิต';
      else if (docType === 2) label = label ? `เช็ค ~ ${label}` : 'เช็ค';
      labels.push(label || 'ชำระเงิน');
      amounts.push(amount);
    }
  }

  return labels.length
    ? [{ trans_number: labels.join('\n'), amount: amounts.join('\n') }]
    : [];
}

async function loadAdvancePaymentPrintDocument(docNo) {
  const [headerRes, companyRes, detailsRes, payments] = await Promise.all([
    query(
      `SELECT t.*,
          COALESCE(NULLIF(cb.total_net_amount,0), t.total_amount, 0) AS total_net_amount,
          COALESCE(cb.total_amount_pay,0) AS total_amount_pay,
          COALESCE(cb.cash_amount,0) AS cash_amount,
          COALESCE(cb.tranfer_amount,0) AS tranfer_amount,
          COALESCE(cb.tranfer_amount,0) AS transfer_amount,
          COALESCE(cb.chq_amount,0) AS chq_amount,
          COALESCE(cb.card_amount,0) AS card_amount,
          COALESCE(cb.total_credit_charge,0) AS total_credit_charge,
          COALESCE(cb.total_income_amount,0) AS total_income_amount,
          COALESCE(cb.petty_cash_amount,0) AS petty_cash_amount,
          COALESCE(cb.discount_amount,0) AS discount_amount,
          COALESCE(df.name_1,'') AS doc_format_name,
          COALESCE(df.form_code,'') AS form_code,
          COALESCE(ar.name_1,'') AS name_1,
          COALESCE(ar.address,'') AS address,
          COALESCE(ar.telephone,'') AS telephone,
          COALESCE(ar.fax,'') AS fax,
          COALESCE(cd.tax_id,'') AS tax_id,
          COALESCE(u.name_1, t.creator_code, '') AS sale_name
       FROM ic_trans t
       LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = t.trans_flag
       LEFT JOIN erp_doc_format df ON df.screen_code = $2 AND df.code = t.doc_format_code
       LEFT JOIN ar_customer ar ON ar.code = t.cust_code
       LEFT JOIN ar_customer_detail cd ON cd.ar_code = t.cust_code
       LEFT JOIN erp_user u ON UPPER(u.code) = UPPER(t.creator_code)
       WHERE t.trans_flag = $3 AND t.doc_no = $1
       LIMIT 1`,
      [docNo, SCREEN_CODE, TRANS_FLAG],
    ),
    query('SELECT * FROM erp_company_profile ORDER BY roworder LIMIT 1'),
    query(
      `SELECT
          line_number,
          remark,
          remark AS item_name,
          remark AS item_code,
          '' AS unit_code,
          '' AS unit_name,
          1 AS qty,
          sum_debt_amount AS price,
          sum_debt_amount AS sum_amount,
          sum_debt_amount AS amount,
          sum_debt_amount
       FROM ap_ar_trans_detail
       WHERE trans_flag = $2 AND doc_no = $1
       ORDER BY line_number, roworder`,
      [docNo, TRANS_FLAG],
    ),
    loadPaymentRowsForPrint(docNo),
  ]);

  const header = headerRes.rows[0];
  if (!header) return null;
  const company = companyRes.rows[0] || {};
  company.tax_text = company.tax_number ? `หมายเลขประจำตัวผู้เสียภาษี ${company.tax_number}` : '';
  company.telephone_text = company.telephone_number ? `โทร. ${company.telephone_number}` : '';

  return {
    header,
    company,
    details: detailsRes.rows || [],
    payments,
  };
}

async function loadPrintFormOptions(docNo) {
  const docRes = await query(
    `SELECT t.doc_no, COALESCE(t.doc_format_code,'') AS doc_format_code,
        COALESCE(df.name_1,'') AS doc_format_name,
        COALESCE(df.form_code,'') AS form_code
     FROM ic_trans t
     LEFT JOIN erp_doc_format df ON df.screen_code = $2 AND df.code = t.doc_format_code
     WHERE t.trans_flag = $3 AND t.doc_no = $1
     LIMIT 1`,
    [docNo, SCREEN_CODE, TRANS_FLAG],
  );

  const doc = docRes.rows[0];
  if (!doc) return null;

  const codes = uniqueCodes(splitFormCodes(doc.form_code));
  let formRows = [];
  if (codes.length) {
    const result = await query(
      `SELECT formcode, formname
       FROM formdesign
       WHERE lower(formcode) = ANY($1::text[])`,
      [lowerCodes(codes)],
    );
    formRows = result.rows;
  }

  const byCode = new Map(formRows.map((row) => [String(row.formcode || '').toLowerCase(), row]));
  const forms = codes.map((code, index) => {
    const row = byCode.get(code.toLowerCase());
    return {
      formcode: row?.formcode || code,
      formname: row?.formname || code,
      available: !!row,
      is_default: index === 0,
    };
  });

  return {
    doc_no: doc.doc_no,
    doc_format_code: doc.doc_format_code,
    doc_format_name: doc.doc_format_name,
    form_code: doc.form_code,
    forms,
  };
}

async function loadFormDesignRows(formCodes) {
  if (!formCodes.length) return [];
  const result = await query(
    `SELECT formcode, formname, formdesigntext, formbackground
     FROM formdesign
     WHERE lower(formcode) = ANY($1::text[])`,
    [lowerCodes(formCodes)],
  );
  const byCode = new Map(result.rows.map((row) => [String(row.formcode || '').toLowerCase(), row]));
  return formCodes.map((code) => byCode.get(code.toLowerCase())).filter(Boolean);
}

function shouldLogPrint(logPrint, autoPrint) {
  if (logPrint !== undefined) {
    const value = String(logPrint).trim().toLowerCase();
    return value !== '0' && value !== 'false' && value !== 'no';
  }
  return String(autoPrint) !== '0';
}

async function getPrintCount(docNo) {
  const result = await query(
    `SELECT COUNT(*)::int AS print_count
     FROM erp_print_logs
     WHERE trans_flag = $2 AND doc_no = $1`,
    [docNo, TRANS_FLAG],
  );
  return Number(result.rows[0]?.print_count || 0);
}

async function createPrintLog(docNo, userCode) {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO erp_print_logs (doc_no, trans_flag, user_code, print_datetime)
       VALUES ($1, $2, $3, NOW())`,
      [docNo, TRANS_FLAG, String(userCode || 'WEB').trim() || 'WEB'],
    );
    const result = await client.query(
      `SELECT COUNT(*)::int AS print_count
       FROM erp_print_logs
       WHERE trans_flag = $2 AND doc_no = $1`,
      [docNo, TRANS_FLAG],
    );
    return Number(result.rows[0]?.print_count || 0);
  });
}

async function updateAdvanceStatuses(client, docNos = []) {
  const targets = [...new Set(docNos.map(safeText).filter(Boolean))];
  if (!targets.length) return;
  await client.query(
    `UPDATE ic_trans
     SET last_status = CASE
           WHEN EXISTS (
             SELECT 1 FROM ic_trans x1
             WHERE x1.trans_flag = 41 AND x1.doc_no = ic_trans.doc_no
           ) THEN 1 ELSE 0 END,
         used_status = CASE
           WHEN EXISTS (
             SELECT 1 FROM ic_trans temp1
             WHERE temp1.trans_flag IN (42)
               AND COALESCE(temp1.last_status, 0) = 0
               AND temp1.doc_ref = ic_trans.doc_no
           )
           OR EXISTS (
             SELECT 1 FROM cb_trans_detail
             WHERE cb_trans_detail.trans_number = ic_trans.doc_no
           ) THEN 1 ELSE 0 END
     WHERE trans_flag = $1 AND doc_no = ANY($2::text[])`,
    [TRANS_FLAG, targets],
  );
}

router.get('/advance-payment/doc-formats', async (req, res) => {
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, ADVANCE_PAYMENT_VIEW_PERMISSION);
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

router.get('/advance-payment/next-doc-no', async (req, res) => {
  const { doc_format_code = '', doc_date = '' } = req.query;
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, ADVANCE_PAYMENT_VIEW_PERMISSION);
    const result = await withTransaction((client) =>
      resolveDocumentNo(client, {
        screenCode: SCREEN_CODE,
        docFormatCode: doc_format_code,
        transFlag: TRANS_FLAG,
        docDate: normalizeDate(doc_date),
      })
    );
    return res.json({ success: true, ...result });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/advance-payment/list', async (req, res) => {
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
    await assertAnyPermission(query, req.query.user_code || req.query.emp_code, ADVANCE_PAYMENT_READ_PERMISSIONS);
    const result = await query(
      `SELECT t.doc_no, t.doc_date, t.doc_time, t.doc_format_code, t.cust_code,
              COALESCE(c.name_1,'') AS cust_name, COALESCE(t.total_amount,0) AS total_amount,
              COALESCE(t.last_status,0) AS last_status, COALESCE(t.used_status,0) AS used_status,
              COALESCE(t.is_cancel,0) AS is_cancel, COALESCE(t.remark,'') AS remark
       FROM ic_trans t
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

router.get('/advance-payment/detail', async (req, res) => {
  const docNo = safeText(req.query.doc_no);
  if (!docNo) return res.status(400).json({ success: false, msg: 'doc_no is required' });
  try {
    await assertAnyPermission(query, req.query.user_code || req.query.emp_code, ADVANCE_PAYMENT_READ_PERMISSIONS);
    const [header, details, payment, paymentDetails] = await Promise.all([
      query(
        `SELECT t.*, COALESCE(c.name_1,'') AS cust_name, COALESCE(c.address,'') AS cust_address,
                COALESCE(c.telephone,'') AS cust_telephone
         FROM ic_trans t
         LEFT JOIN ar_customer c ON c.code = t.cust_code
         WHERE t.doc_no = $1 AND t.trans_flag = $2
         LIMIT 1`,
        [docNo, TRANS_FLAG],
      ),
      query(
        `SELECT line_number, remark, sum_debt_amount AS amount
         FROM ap_ar_trans_detail
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
    ]);
    if (!header.rows[0]) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({
      success: true,
      data: {
        header: header.rows[0],
        details: details.rows,
        payment: payment.rows[0] || null,
        payment_detail: paymentDetails.rows,
      },
    });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/advance-payment/print-forms', async (req, res) => {
  const docNo = safeText(req.query.doc_no);
  if (!docNo) return res.status(400).json({ success: false, msg: 'doc_no is required' });
  try {
    await assertAnyPermission(query, req.query.user_code || req.query.emp_code, ADVANCE_PAYMENT_READ_PERMISSIONS);
    const options = await loadPrintFormOptions(docNo);
    if (!options) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({ success: true, data: options });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/advance-payment/print/render', async (req, res) => {
  const { doc_no = '', formcodes = '', auto_print = '1', log_print, user_code = '' } = req.query;
  const docNo = safeText(doc_no);
  if (!docNo) return res.status(400).type('text/plain').send('doc_no is required');

  try {
    await assertAnyPermission(query, user_code || req.query.emp_code, ADVANCE_PAYMENT_READ_PERMISSIONS);
    const [options, printData] = await Promise.all([
      loadPrintFormOptions(docNo),
      loadAdvancePaymentPrintDocument(docNo),
    ]);

    if (!options || !printData) return res.status(404).type('text/plain').send('document not found');

    const availableCodes = options.forms.filter((form) => form.available).map((form) => form.formcode);
    const requestedCodes = uniqueCodes(splitFormCodes(formcodes));
    const selectedCodes = requestedCodes.length
      ? requestedCodes.filter((code) => availableCodes.some((available) => available.toLowerCase() === code.toLowerCase()))
      : availableCodes.slice(0, 1);

    if (!selectedCodes.length) return res.status(404).type('text/plain').send('print form not found');

    const formRows = await loadFormDesignRows(selectedCodes);
    if (!formRows.length) return res.status(404).type('text/plain').send('print form not found');

    const logThisPrint = req.method !== 'HEAD' && shouldLogPrint(log_print, auto_print);
    const printCount = logThisPrint
      ? await createPrintLog(docNo, user_code || printData.header.creator_code)
      : await getPrintCount(docNo);
    printData.header.print_count = printCount;

    const html = renderSalePrintHtml({
      formRows,
      data: printData,
      autoPrint: String(auto_print) !== '0',
      coordinateScale: 0.72,
      csharpTextAlignment: true,
      advancePaymentMethodChecks: true,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('html').send(html);
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).type('text/plain').send(ex.message);
    return res.status(500).type('text/plain').send(ex.message);
  }
});

router.post('/advance-payment/save', async (req, res) => {
  try {
    const payload = normalizePayload(req.body);
    const docDate = normalizeDate(payload.doc_date);
    const docTime = safeText(payload.doc_time) || currentTimeText();
    const custCode = safeText(payload.cust_code);
    const details = normalizeDetails(payload.details);
    const payments = normalizePayments(payload.payments);
    const vatType = toInt(payload.vat_type, 0);
    const vatRate = toNumber(payload.vat_rate, 0);
    const hasDepositDay = payload.deposit_day !== undefined
      && payload.deposit_day !== null
      && safeText(payload.deposit_day) !== ''
      && toInt(payload.deposit_day, 0) > 0;
    const depositDay = hasDepositDay ? toInt(payload.deposit_day, 0) : 0;
    const depositDate = hasDepositDay ? normalizeDate(payload.deposit_date, addDays(docDate, depositDay)) : null;
    const requestUserCode = safeText(payload.emp_code) || safeText(payload.creator_code);
    const creatorCode = requestUserCode || 'smlstaff';
    const branchCode = safeText(payload.branch_code);
    const remark = safeText(payload.remark);

    if (!custCode) return res.status(400).json({ success: false, msg: 'cust_code is required' });
    if (!details.length) return res.status(400).json({ success: false, msg: 'details is empty' });

    const totalDetail = roundMoney(details.reduce((sum, row) => sum + row.amount, 0));
    const totals = calcVatTotals(totalDetail, vatType, vatRate);
    const transferAmount = roundMoney(payments.transfer.reduce((sum, row) => sum + row.amount, 0));
    const cardAmount = roundMoney(payments.card.reduce((sum, row) => sum + row.amount + row.charge, 0));
    const cardCharge = roundMoney(payments.card.reduce((sum, row) => sum + row.charge, 0));
    const chequeAmount = roundMoney(payments.cheque.reduce((sum, row) => sum + row.amount, 0));
    const cashAmount = roundMoney(payments.cash_amount + payments.tiger_amount);
    const totalNetAmount = roundMoney(totals.total_amount + cardCharge);
    const totalPaid = roundMoney(
      cashAmount
      + payments.petty_cash_amount
      + transferAmount
      + cardAmount
      + chequeAmount
      + payments.total_income_amount
      + payments.discount_amount,
    );
    const diff = roundMoney(totalPaid - totalNetAmount);
    if (diff < -0.01) {
      return res.status(400).json({ success: false, msg: 'payment total is less than document total' });
    }
    if (diff > 0.01) {
      return res.status(400).json({ success: false, msg: 'payment total is greater than document total' });
    }

    let savedDocNo = '';
    let savedDocFormatCode = '';
    let savedFormCode = '';
    await withTransaction(async (client) => {
      await assertCreatePermission(client, requestUserCode);

      const doc = await resolveDocumentNo(client, {
        screenCode: SCREEN_CODE,
        docFormatCode: safeText(payload.doc_format_code),
        transFlag: TRANS_FLAG,
        docDate,
      });
      savedDocNo = doc.doc_no;
      savedDocFormatCode = doc.doc_format_code;
      savedFormCode = doc.form_code || '';

      await client.query('SELECT code FROM ar_customer WHERE code = $1 LIMIT 1', [custCode]).then((result) => {
        if (!result.rows[0]) throw new Error('customer not found');
      });

      await client.query(
        `INSERT INTO ic_trans (
          trans_type, trans_flag, doc_date, doc_no, doc_ref, doc_ref_date,
          vat_type, cust_code, branch_code, vat_rate, total_value, total_vat_value,
          total_except_vat, total_amount, remark, total_before_vat, doc_time,
          last_status, used_status, deposit_day, deposit_date, doc_format_code,
          creator_code, create_datetime, is_cancel
        ) VALUES (
          $1,$2,$3::date,$4,'',NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
          0,0,$16,$17::date,$18,$19,NOW(),0
        )`,
        [
          TRANS_TYPE, TRANS_FLAG, docDate, savedDocNo,
          vatType, custCode, branchCode, vatRate,
          totals.total_value, totals.total_vat_value, totals.total_except_vat,
          totals.total_amount, remark, totals.total_before_vat, docTime,
          depositDay, depositDate, savedDocFormatCode, creatorCode,
        ],
      );

      for (let i = 0; i < details.length; i++) {
        const row = details[i];
        await client.query(
          `INSERT INTO ap_ar_trans_detail (
            trans_type, trans_flag, doc_date, doc_no, sum_debt_amount, remark,
            line_number, last_status, sale_shift_id
          ) VALUES ($1,$2,$3::date,$4,$5,$6,$7,0,'')`,
          [TRANS_TYPE, TRANS_FLAG, docDate, savedDocNo, row.amount, row.remark, i],
        );
      }

      await client.query(
        `INSERT INTO cb_trans (
          trans_type, trans_flag, doc_no, doc_date, doc_time, ap_ar_code,
          pay_type, doc_format_code, total_amount, total_net_amount, cash_amount,
          chq_amount, tranfer_amount, card_amount, total_amount_pay,
          total_income_amount, petty_cash_amount, discount_amount,
          total_credit_charge, remark
        ) VALUES (
          $1,$2,$3,$4::date,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
        )`,
        [
          TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime, custCode,
          savedDocFormatCode, totals.total_amount, totalNetAmount,
          cashAmount, chequeAmount, transferAmount, cardAmount,
          totalNetAmount, payments.total_income_amount, payments.petty_cash_amount,
          payments.discount_amount, cardCharge, remark,
        ],
      );

      for (const row of payments.transfer) {
        const passBook = await getPassBook(client, row.pass_book_code);
        if (!passBook) throw new Error(`pass book not found: ${row.pass_book_code}`);
        await client.query(
          `INSERT INTO cb_trans_detail (
            trans_type, trans_flag, doc_no, doc_date, doc_time, trans_number,
            bank_code, bank_branch, amount, sum_amount, doc_type, ap_ar_code,
            chq_due_date, trans_number_type, ap_ar_type, last_status
          ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$9,1,'',$10::date,0,0,0)`,
          [
            TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime,
            passBook.code, passBook.bank_code || row.bank_code, passBook.bank_branch || row.bank_branch,
            row.amount, row.chq_due_date || docDate,
          ],
        );
      }

      for (const row of payments.card) {
        await client.query(
          `INSERT INTO cb_trans_detail (
            trans_type, trans_flag, doc_no, doc_date, doc_time, trans_number,
            credit_card_type, amount, sum_amount, doc_type, ap_ar_code,
            trans_number_type, ap_ar_type, charge, ref1, no_approved, last_status
          ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,3,$10,1,1,$11,$3,$12,0)`,
          [
            TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime,
            row.trans_number, row.credit_card_type, row.amount,
            roundMoney(row.amount + row.charge), custCode, row.charge, row.no_approved,
          ],
        );
      }

      for (const row of payments.cheque) {
        await client.query(
          `INSERT INTO cb_trans_detail (
            trans_type, trans_flag, doc_no, doc_date, doc_time, trans_number,
            amount, sum_amount, chq_due_date, doc_type, ap_ar_code,
            trans_number_type, ap_ar_type, last_status
          ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$7,$8::date,2,$9,1,1,0)`,
          [
            TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime,
            row.trans_number, row.amount, row.chq_due_date || docDate, custCode,
          ],
        );
      }

      await updateAdvanceStatuses(client, [savedDocNo]);
    });

    return res.json({
      success: true,
      doc_no: savedDocNo,
      doc_format_code: savedDocFormatCode,
      form_code: savedFormCode,
      msg: 'success',
    });
  } catch (ex) {
    if (ex.message && ex.message.includes('not found')) {
      return res.status(404).json({ success: false, msg: ex.message });
    }
    if (isPermissionError(ex)) {
      return res.status(403).json({ success: false, msg: ex.message });
    }
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/advance-payment/customer-balance', async (req, res) => {
  const custCode = safeText(req.query.cust_code);
  if (!custCode) return res.json({ success: true, data: { balance_amount: 0, rows: [] } });
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, ADVANCE_PAYMENT_VIEW_PERMISSION);
    const result = await query(
      `SELECT doc_no, doc_date, total_amount,
              CASE WHEN COALESCE(last_status,0)=1 THEN 0 ELSE
                COALESCE(total_amount,0)
                - COALESCE((SELECT SUM(total_amount) FROM ic_trans x1
                            WHERE COALESCE(x1.last_status,0)=0
                              AND x1.doc_ref = ic_trans.doc_no
                              AND x1.trans_flag IN (112,42)),0)
                - COALESCE((SELECT SUM(amount) FROM cb_trans_detail x2
                            WHERE COALESCE(x2.last_status,0)=0
                              AND x2.trans_number = ic_trans.doc_no
                              AND x2.trans_flag NOT IN (40,110)),0)
              END AS balance_amount
       FROM ic_trans
       WHERE trans_flag IN (40,9040)
         AND COALESCE(is_doc_copy,0) <> 1
         AND cust_code = $1
       ORDER BY doc_date DESC, doc_no DESC
       LIMIT 20`,
      [custCode],
    );
    const total = result.rows.reduce((sum, row) => sum + toNumber(row.balance_amount), 0);
    return res.json({ success: true, data: { balance_amount: roundMoney(total), rows: result.rows } });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

module.exports = router;

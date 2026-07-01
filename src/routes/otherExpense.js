const express = require('express');
const router = express.Router();
const { withTransaction, query } = require('../db');
const { buildDocPattern, resolveDocumentNo } = require('../utils/docFormat');
const { getEmployeePermissions } = require('../utils/permissions');
const { renderSalePrintHtml } = require('../utils/salePrintRenderer');

const TRANS_TYPE = 2;
const TRANS_FLAG = 260;
const SCREEN_CODE = 'EPO';
const WHT_SCREEN_CODE = 'RWHT';
const OTHER_EXPENSE_VIEW_PERMISSION = 'cash.other_expense.view';
const OTHER_EXPENSE_CREATE_PERMISSION = 'cash.other_expense.create';
const CASH_INQUIRY_TYPES = new Set([1, 2]);

const INQUIRY_TYPE_LABELS = {
  0: 'ค่าใช้จ่ายเงินเชื่อ',
  1: 'ค่าใช้จ่ายเงินสด',
  2: 'ค่าใช้จ่ายเงินสด (สินค้าบริการ)',
  3: 'ค่าใช้จ่ายเงินเชื่อ (สินค้าบริการ)',
};

const VAT_TYPE_LABELS = {
  0: 'ภาษีแยกนอก',
  1: 'ภาษีรวมใน',
  2: 'ภาษีอัตราศูนย์',
  3: 'ไม่กระทบภาษี',
};

function safeText(value) {
  return String(value ?? '').trim();
}

function toInt(value, fallback = 0) {
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
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

function isCashInquiryType(value) {
  return CASH_INQUIRY_TYPES.has(toInt(value, 0));
}

function inquiryTypeLabel(value) {
  return INQUIRY_TYPE_LABELS[toInt(value, 0)] || INQUIRY_TYPE_LABELS[0];
}

function vatTypeLabel(value) {
  return VAT_TYPE_LABELS[toInt(value, 0)] || VAT_TYPE_LABELS[0];
}

async function resolveWhtDocFormat(client, docFormatCode = '') {
  const code = safeText(docFormatCode);
  const sql = `
    SELECT code, COALESCE(name_1,'') AS name_1,
           COALESCE(NULLIF(format,''), NULLIF(tax_format,''), '@YYMM####') AS format,
           COALESCE(doc_running,'') AS doc_running
    FROM erp_doc_format
    WHERE UPPER(screen_code) = $1
      ${code ? 'AND code = $2' : ''}
    ORDER BY code
    LIMIT 1`;
  const result = await client.query(sql, code ? [WHT_SCREEN_CODE, code] : [WHT_SCREEN_CODE]);
  const row = result.rows[0];
  if (!row) throw new Error(code ? `wht doc format not found: ${code}` : 'wht doc format not found');
  return row;
}

function nextRunningFromPattern(pattern, lastDocNo = '', startRunningDoc = '') {
  const firstHash = pattern.indexOf('#');
  if (firstHash < 0) return pattern;
  let runLen = 0;
  while (firstHash + runLen < pattern.length && pattern[firstHash + runLen] === '#') runLen += 1;
  const patternWithoutNumber = pattern.slice(0, firstHash) + pattern.slice(firstHash + runLen);
  const readRunning = (docNo) => {
    const text = safeText(docNo);
    if (text.length < firstHash + runLen) return 0;
    const withoutNumber = text.slice(0, firstHash) + text.slice(firstHash + runLen);
    if (withoutNumber !== patternWithoutNumber) return 0;
    const runText = text.slice(firstHash, firstHash + runLen);
    return /^\d+$/.test(runText) ? parseInt(runText, 10) : 0;
  };
  const current = Math.max(readRunning(lastDocNo), readRunning(startRunningDoc));
  const next = current + 1;
  const max = Math.pow(10, runLen) - 1;
  if (next > max) throw new Error('wht tax doc running overflow');
  return pattern.slice(0, firstHash) + String(next).padStart(runLen, '0') + pattern.slice(firstHash + runLen);
}

async function resolveWhtTaxDocNo(client, { docFormatCode = '', docDate = '' } = {}) {
  const docFormat = await resolveWhtDocFormat(client, docFormatCode);
  const pattern = buildDocPattern(docFormat.format, docFormat.code, normalizeDate(docDate));
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gl_wht_list|tax_doc_no|${docFormat.code}|${pattern}`]);
  const likePattern = pattern.replace(/#/g, '_');
  const result = await client.query(
    `SELECT tax_doc_no
     FROM gl_wht_list
     WHERE COALESCE(tax_doc_no,'') LIKE $1
     ORDER BY tax_doc_no DESC
     LIMIT 1`,
    [likePattern],
  );
  const taxDocNo = nextRunningFromPattern(pattern, result.rows[0]?.tax_doc_no, docFormat.doc_running);
  return {
    tax_doc_no: taxDocNo,
    doc_format_code: docFormat.code,
    doc_format_name: docFormat.name_1 || '',
    doc_format: docFormat.format || '',
  };
}

async function whtTaxDocNoExists(client, taxDocNo) {
  const text = safeText(taxDocNo);
  if (!text) return false;
  const result = await client.query('SELECT 1 FROM gl_wht_list WHERE tax_doc_no = $1 LIMIT 1', [text]);
  return result.rowCount > 0;
}

function normalizePayload(body) {
  let payload = body || {};
  if (typeof payload === 'string') payload = JSON.parse(payload);
  if (payload && typeof payload.payload === 'object') payload = payload.payload;
  return payload || {};
}

function calcVatTotals(baseAmount, vatType = 0, vatRate = 0) {
  const amount = roundMoney(baseAmount);
  const rate = roundMoney(vatRate);
  const type = toInt(vatType, 0);
  if (rate <= 0 || type === 2 || type === 3) {
    return {
      total_value: amount,
      total_before_vat: amount,
      total_vat_value: 0,
      total_except_vat: type === 3 ? amount : 0,
      total_amount: amount,
    };
  }
  if (type === 0) {
    const vat = roundMoney(amount * rate / 100);
    return {
      total_value: amount,
      total_before_vat: amount,
      total_vat_value: vat,
      total_except_vat: 0,
      total_amount: roundMoney(amount + vat),
    };
  }
  const vat = roundMoney(amount * rate / (100 + rate));
  const beforeVat = roundMoney(amount - vat);
  return {
    total_value: beforeVat,
    total_before_vat: beforeVat,
    total_vat_value: vat,
    total_except_vat: 0,
    total_amount: amount,
  };
}

function normalizeDetails(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((row, index) => ({
      line_number: index,
      expense_code: safeText(row?.expense_code || row?.item_code || row?.code),
      expense_name: safeText(row?.expense_name || row?.item_name || row?.name_1),
      amount: roundMoney(row?.amount ?? row?.sum_amount),
      branch_code: safeText(row?.branch_code),
      remark: safeText(row?.remark),
    }))
    .filter((row) => row.expense_code && row.amount > 0);
}

function normalizePayments(value) {
  const source = value && typeof value === 'object' ? value : {};
  const transfer = Array.isArray(source.transfer) ? source.transfer : [];
  const card = Array.isArray(source.card) ? source.card : [];
  const cheque = Array.isArray(source.cheque) ? source.cheque : [];
  const tiger = Array.isArray(source.tiger) ? source.tiger : [];
  const tigerRows = tiger
    .map((row) => ({
      voucher_num: safeText(row?.voucher_num || row?.voucher_number),
      voucher_code: safeText(row?.voucher_code || row?.code),
      ref_num: safeText(row?.ref_num),
      amount: roundMoney(row?.amount ?? row?.pay_amount),
    }))
    .filter((row) => row.amount > 0);
  const tigerAmount = source.tiger_amount === undefined
    ? roundMoney(tigerRows.reduce((sum, row) => sum + row.amount, 0))
    : roundMoney(source.tiger_amount);
  const firstTiger = tigerRows[0] || {};
  return {
    cash_amount: roundMoney(source.cash_amount),
    tiger_amount: tigerAmount,
    tiger: tigerRows,
    tiger_voucher_num: safeText(source.tiger_voucher_num || firstTiger.voucher_num),
    tiger_voucher_code: safeText(source.tiger_voucher_code || firstTiger.voucher_code),
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
        bank_code: safeText(row?.bank_code),
        bank_branch: safeText(row?.bank_branch),
        trans_number: safeText(row?.trans_number || row?.chq_number),
        amount: roundMoney(row?.amount ?? row?.pay_amount),
        chq_due_date: normalizeDate(row?.chq_due_date || row?.due_date, ''),
      }))
      .filter((row) => row.amount > 0),
  };
}

function appendTigerVoucherToRemark(remark, tigerRows = []) {
  const voucherLines = [];
  const seen = new Set();
  for (const row of Array.isArray(tigerRows) ? tigerRows : []) {
    const num = safeText(row?.voucher_num || row?.voucher_number);
    if (!num || seen.has(num)) continue;
    seen.add(num);
    const amount = roundMoney(row?.amount ?? row?.pay_amount);
    const amountText = amount > 0 ? ` มูลค่า ${asAmountText(amount)} บาท` : '';
    voucherLines.push({ num, line: `Tiger Voucher: ${num}${amountText}` });
  }
  if (!voucherLines.length) return safeText(remark);
  const base = safeText(remark);
  const missing = voucherLines.filter((row) => !base.includes(row.num));
  if (!missing.length) return base;
  const line = missing.map((row) => row.line).join(' | ');
  return base ? `${base} | ${line}` : line;
}

function normalizeWhtList(value, docDate) {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((row, index) => {
      const amount = roundMoney(row?.amount ?? row?.base_amount);
      const taxRate = roundMoney(row?.tax_rate);
      const calculatedTaxValue = roundMoney(amount * taxRate / 100);
      const submittedTaxValue = row?.tax_value === undefined || row?.tax_value === null || row?.tax_value === ''
        ? calculatedTaxValue
        : roundMoney(row.tax_value);
      return {
        line_number: index,
        income_type: safeText(row?.income_type) || 'หัก 3 %',
        tax_rate: taxRate,
        amount,
        tax_value: calculatedTaxValue,
        submitted_tax_value: submittedTaxValue,
        due_date: normalizeDate(row?.due_date, docDate),
        tax_doc_no: safeText(row?.tax_doc_no),
      };
    })
    .filter((row) => row.amount > 0 && row.tax_rate > 0 && row.tax_value > 0);
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
  const required = Array.isArray(permissionKeys) ? permissionKeys : [permissionKeys];
  if (!required.some((key) => permissions.includes(key))) {
    throw new Error(`permission denied: ${required.join(' or ')}`);
  }
}

async function assertLookupPermission(queryFn, userCode) {
  await assertAnyPermission(queryFn, userCode, [OTHER_EXPENSE_VIEW_PERMISSION, OTHER_EXPENSE_CREATE_PERMISSION]);
}

async function assertCreatePermission(client, userCode) {
  await assertPermission(client.query.bind(client), userCode, OTHER_EXPENSE_CREATE_PERMISSION);
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
        COALESCE(card_amount,0) AS card_amount,
        COALESCE(chq_amount,0) AS chq_amount
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
      `SELECT doc_type, COALESCE(trans_number,'') AS trans_number,
              COALESCE(amount,0) AS amount, COALESCE(sum_amount, amount, 0) AS sum_amount
       FROM cb_trans_detail
       WHERE doc_no = $1 AND trans_flag = $2
       ORDER BY roworder`,
      [docNo, TRANS_FLAG],
    );

    for (const row of detailRes.rows) {
      const docType = Number(row.doc_type || 0);
      const amount = asAmountText(docType === 3 ? row.sum_amount : row.amount);
      if (!amount) continue;
      let label = String(row.trans_number || '').trim();
      if (docType === 1) label = label ? `เงินโอน ~ ${label}` : 'เงินโอน';
      else if (docType === 3) label = label ? `บัตรเครดิต ~ ${label}` : 'บัตรเครดิต';
      else if (docType === 2) label = label ? `เช็ค ~ ${label}` : 'เช็ค';
      labels.push(label || 'จ่ายเงิน');
      amounts.push(amount);
    }
  }

  return labels.length
    ? [{ trans_number: labels.join('\n'), amount: amounts.join('\n') }]
    : [];
}

async function loadOtherExpensePrintDocument(docNo) {
  const [headerRes, companyRes, detailsRes, payments] = await Promise.all([
    query(
      `SELECT t.*,
          COALESCE(df.name_1,'') AS doc_format_name,
          COALESCE(df.form_code,'') AS form_code,
          COALESCE(ap.name_1,'') AS name_1,
          COALESCE(ap.address,'') AS address,
          COALESCE(ap.telephone,'') AS telephone,
          COALESCE(ap.fax,'') AS fax,
          COALESCE(ad.tax_id,'') AS tax_id,
          COALESCE(u.name_1, t.creator_code, '') AS sale_name
       FROM ic_trans t
       LEFT JOIN erp_doc_format df ON df.screen_code = $2 AND df.code = t.doc_format_code
       LEFT JOIN ap_supplier ap ON ap.code = t.cust_code
       LEFT JOIN ap_supplier_detail ad ON ad.ap_code = t.cust_code
       LEFT JOIN erp_user u ON UPPER(u.code) = UPPER(t.creator_code)
       WHERE t.trans_flag = $3 AND t.doc_no = $1
       LIMIT 1`,
      [docNo, SCREEN_CODE, TRANS_FLAG],
    ),
    query('SELECT * FROM erp_company_profile ORDER BY roworder LIMIT 1'),
    query(
      `SELECT
          line_number,
          item_code,
          item_name,
          item_code AS expense_code,
          item_name AS expense_name,
          '' AS unit_code,
          '' AS unit_name,
          1 AS qty,
          price,
          sum_amount,
          sum_amount AS amount,
          sum_amount_exclude_vat,
          total_vat_value,
          remark
       FROM ic_trans_detail
       WHERE trans_flag = $2 AND doc_no = $1
       ORDER BY line_number, roworder`,
      [docNo, TRANS_FLAG],
    ),
    loadPaymentRowsForPrint(docNo),
  ]);

  const header = headerRes.rows[0];
  if (!header) return null;
  header.inquiry_type_name = inquiryTypeLabel(header.inquiry_type);
  header.vat_type_name = vatTypeLabel(header.vat_type);
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

router.get('/other-expense/doc-formats', async (req, res) => {
  try {
    await assertLookupPermission(query, req.query.user_code || req.query.emp_code);
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

router.get('/other-expense/wht-doc-formats', async (req, res) => {
  try {
    await assertLookupPermission(query, req.query.user_code || req.query.emp_code);
    const result = await query(
      `SELECT code, COALESCE(name_1,'') AS name_1,
              COALESCE(NULLIF(format,''), NULLIF(tax_format,''), '@YYMM####') AS format,
              COALESCE(doc_running,'') AS doc_running
       FROM erp_doc_format
       WHERE UPPER(screen_code) = $1
       ORDER BY code`,
      [WHT_SCREEN_CODE],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/other-expense/next-doc-no', async (req, res) => {
  const { doc_format_code = '', doc_date = '' } = req.query;
  try {
    await assertLookupPermission(query, req.query.user_code || req.query.emp_code);
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

router.get('/other-expense/next-wht-doc-no', async (req, res) => {
  const { doc_format_code = '', doc_date = '' } = req.query;
  try {
    await assertLookupPermission(query, req.query.user_code || req.query.emp_code);
    const result = await withTransaction((client) =>
      resolveWhtTaxDocNo(client, {
        docFormatCode: doc_format_code,
        docDate: normalizeDate(doc_date),
      })
    );
    return res.json({ success: true, ...result });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/other-expense/suppliers', async (req, res) => {
  const search = safeText(req.query.search);
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = `WHERE s.code ILIKE $1 OR COALESCE(s.name_1,'') ILIKE $1`;
  }
  try {
    await assertLookupPermission(query, req.query.user_code || req.query.emp_code);
    const result = await query(
      `SELECT s.code, COALESCE(s.name_1,'') AS name_1, COALESCE(s.address,'') AS address,
              COALESCE(s.telephone,'') AS telephone,
              COALESCE((SELECT d.tax_id FROM ap_supplier_detail d WHERE d.ap_code = s.code LIMIT 1),'') AS tax_id
       FROM ap_supplier s
       ${where}
       ORDER BY s.code
       LIMIT 80`,
      params,
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/other-expense/expense-list', async (req, res) => {
  const search = safeText(req.query.search);
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = `WHERE code ILIKE $1 OR COALESCE(name_1,'') ILIKE $1`;
  }
  try {
    await assertLookupPermission(query, req.query.user_code || req.query.emp_code);
    const result = await query(
      `SELECT code, COALESCE(name_1,'') AS name_1
       FROM erp_expenses_list
       ${where}
       ORDER BY code
       LIMIT 100`,
      params,
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

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
              t.tax_doc_date, COALESCE(t.inquiry_type,0) AS inquiry_type,
              CASE COALESCE(t.inquiry_type,0)
                WHEN 1 THEN 'ค่าใช้จ่ายเงินสด'
                WHEN 2 THEN 'ค่าใช้จ่ายเงินสด (สินค้าบริการ)'
                WHEN 3 THEN 'ค่าใช้จ่ายเงินเชื่อ (สินค้าบริการ)'
                ELSE 'ค่าใช้จ่ายเงินเชื่อ'
              END AS inquiry_type_name,
              COALESCE(t.vat_type,0) AS vat_type,
              CASE COALESCE(t.vat_type,0)
                WHEN 1 THEN 'ภาษีรวมใน'
                WHEN 2 THEN 'ภาษีอัตราศูนย์'
                WHEN 3 THEN 'ไม่กระทบภาษี'
                ELSE 'ภาษีแยกนอก'
              END AS vat_type_name,
              COALESCE(t.vat_rate,0) AS vat_rate,
              COALESCE(t.total_value,0) AS total_value, COALESCE(t.total_before_vat,0) AS total_before_vat,
              COALESCE(t.total_vat_value,0) AS total_vat_value, COALESCE(t.total_amount,0) AS total_amount,
              COALESCE(w.wht_tax_value, COALESCE(cb.total_tax_at_pay,0), 0) AS total_wht_value,
              CASE
                WHEN cb.doc_no IS NOT NULL THEN COALESCE(cb.total_net_amount,0) - COALESCE(cb.total_tax_at_pay, COALESCE(w.wht_tax_value,0), 0)
                ELSE COALESCE(t.total_amount,0) - COALESCE(w.wht_tax_value,0)
              END AS total_net_payable,
              COALESCE(t.last_status,0) AS last_status, COALESCE(t.used_status,0) AS used_status,
              COALESCE(t.remark,'') AS remark, COALESCE(d.detail_count,0) AS detail_count,
              COALESCE(d.expense_names,'') AS expense_names, COALESCE(w.wht_count,0) AS wht_count
       FROM ic_trans t
       LEFT JOIN ap_supplier ap ON ap.code = t.cust_code
       LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = t.trans_flag
       LEFT JOIN (
         SELECT doc_no, COUNT(*)::int AS detail_count,
                string_agg(COALESCE(NULLIF(item_name,''), item_code), ', ' ORDER BY line_number, roworder) AS expense_names
         FROM ic_trans_detail
         WHERE trans_flag = ${TRANS_FLAG}
         GROUP BY doc_no
       ) d ON d.doc_no = t.doc_no
       LEFT JOIN (
         SELECT doc_no, COUNT(*)::int AS wht_count,
                SUM(COALESCE(amount,0)) AS wht_base_amount,
                SUM(COALESCE(tax_value,0)) AS wht_tax_value
         FROM gl_wht_list_detail
         WHERE trans_flag = ${TRANS_FLAG}
         GROUP BY doc_no
       ) w ON w.doc_no = t.doc_no
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
    const [header, details, payment, paymentDetails, vatBuy, whtList, whtDetail] = await Promise.all([
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
      query(
        `SELECT *
         FROM gl_wht_list_detail
         WHERE doc_no = $1 AND trans_flag = $2
         ORDER BY line_number, roworder`,
        [docNo, TRANS_FLAG],
      ),
    ]);
    if (!header.rows[0]) return res.status(404).json({ success: false, msg: 'document not found' });
    header.rows[0].inquiry_type_name = inquiryTypeLabel(header.rows[0].inquiry_type);
    header.rows[0].vat_type_name = vatTypeLabel(header.rows[0].vat_type);
    return res.json({
      success: true,
      data: {
        header: header.rows[0],
        details: details.rows,
        payment: payment.rows[0] || null,
        payment_detail: paymentDetails.rows,
        vat_buy: vatBuy.rows,
        wht_list: whtList.rows,
        wht_detail: whtDetail.rows,
      },
    });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/other-expense/print-forms', async (req, res) => {
  const docNo = safeText(req.query.doc_no);
  if (!docNo) return res.status(400).json({ success: false, msg: 'doc_no is required' });
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, OTHER_EXPENSE_VIEW_PERMISSION);
    const options = await loadPrintFormOptions(docNo);
    if (!options) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({ success: true, data: options });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/other-expense/print/render', async (req, res) => {
  const { doc_no = '', formcodes = '', auto_print = '1', log_print, user_code = '' } = req.query;
  const docNo = safeText(doc_no);
  if (!docNo) return res.status(400).type('text/plain').send('doc_no is required');

  try {
    await assertPermission(query, user_code || req.query.emp_code, OTHER_EXPENSE_VIEW_PERMISSION);
    const [options, printData] = await Promise.all([
      loadPrintFormOptions(docNo),
      loadOtherExpensePrintDocument(docNo),
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
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('html').send(html);
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).type('text/plain').send(ex.message);
    return res.status(500).type('text/plain').send(ex.message);
  }
});

router.post('/other-expense/save', async (req, res) => {
  try {
    const payload = normalizePayload(req.body);
    const docDate = normalizeDate(payload.doc_date);
    const docTime = safeText(payload.doc_time) || currentTimeText();
    const supplierCode = safeText(payload.cust_code || payload.supplier_code);
    const whtSupplierCode = safeText(payload.wht_supplier_code || payload.wht_cust_code || payload.withholding_supplier_code || supplierCode);
    const requestUserCode = safeText(payload.emp_code) || safeText(payload.creator_code);
    const creatorCode = requestUserCode || 'smlstaff';
    const details = normalizeDetails(payload.details);
    const payments = normalizePayments(payload.payments);
    const whtList = normalizeWhtList(payload.wht_list || payload.withholding_tax, docDate);
    const inquiryType = toInt(payload.inquiry_type, 0);
    const isCashExpense = isCashInquiryType(inquiryType);
    const vatType = toInt(payload.vat_type, 0);
    const vatRate = [2, 3].includes(vatType) ? 0 : roundMoney(payload.vat_rate);
    const branchCode = safeText(payload.branch_code);
    const remark = appendTigerVoucherToRemark(payload.remark, payments.tiger);
    const taxDocNo = safeText(payload.tax_doc_no);
    const taxDocDate = normalizeNullableDate(payload.tax_doc_date);

    if (!supplierCode) return res.status(400).json({ success: false, msg: 'supplier_code is required' });
    if (!details.length) return res.status(400).json({ success: false, msg: 'details is empty' });
    if (![0, 1, 2, 3].includes(inquiryType)) return res.status(400).json({ success: false, msg: 'inquiry_type must be 0, 1, 2, or 3' });
    if (![0, 1, 2, 3].includes(vatType)) return res.status(400).json({ success: false, msg: 'vat_type must be 0, 1, 2, or 3' });
    const invalidWht = whtList.find((row) => Math.abs(row.tax_value - row.submitted_tax_value) > 0.01);
    if (invalidWht) return res.status(400).json({ success: false, msg: 'withholding tax value does not match amount and tax rate' });

    const detailAmount = roundMoney(details.reduce((sum, row) => sum + row.amount, 0));
    const totals = calcVatTotals(detailAmount, vatType, vatRate);
    const transferAmount = roundMoney(payments.transfer.reduce((sum, row) => sum + row.amount, 0));
    const cardAmount = roundMoney(payments.card.reduce((sum, row) => sum + row.amount + row.charge, 0));
    const cardCharge = roundMoney(payments.card.reduce((sum, row) => sum + row.charge, 0));
    const chequeAmount = roundMoney(payments.cheque.reduce((sum, row) => sum + row.amount, 0));
    const cashAmount = roundMoney(payments.cash_amount + payments.tiger_amount);
    const whtAmount = roundMoney(whtList.reduce((sum, row) => sum + row.tax_value, 0));
    const whtBaseAmount = roundMoney(whtList.reduce((sum, row) => sum + row.amount, 0));
    if (whtBaseAmount > totals.total_before_vat + 0.01) return res.status(400).json({ success: false, msg: 'withholding tax base is greater than document base' });
    if (whtAmount > totals.total_amount + 0.01) return res.status(400).json({ success: false, msg: 'withholding tax is greater than document total' });
    if (payments.tiger_amount > 0 && !payments.tiger_voucher_num) {
      return res.status(400).json({ success: false, msg: 'tiger voucher number is required' });
    }
    const totalNetAmount = roundMoney(totals.total_amount + cardCharge);
    const totalPaid = roundMoney(cashAmount + transferAmount + cardAmount + chequeAmount);
    const totalAmountPay = roundMoney(totalPaid + whtAmount);
    const diff = roundMoney(totalAmountPay - totalNetAmount);
    if (isCashExpense) {
      if (diff < -0.01) return res.status(400).json({ success: false, msg: 'payment total is less than document total' });
      if (diff > 0.01) return res.status(400).json({ success: false, msg: 'payment total is greater than document total' });
    } else if (Math.abs(totalPaid) > 0.01) {
      return res.status(400).json({ success: false, msg: 'credit expense must not include payment rows' });
    }

    let savedDocNo = '';
    let savedDocFormatCode = '';
    let savedFormCode = '';
    let savedWhtTaxDocNo = '';

    await withTransaction(async (client) => {
      await assertCreatePermission(client, requestUserCode);

      const supplier = await client.query(
        `SELECT s.code, COALESCE(s.name_1,'') AS name_1, COALESCE(s.address,'') AS address,
                COALESCE(s.ap_status,0) AS ap_status,
                COALESCE((SELECT d.tax_id FROM ap_supplier_detail d WHERE d.ap_code = s.code LIMIT 1),'') AS tax_id,
                COALESCE((SELECT d.card_id FROM ap_supplier_detail d WHERE d.ap_code = s.code LIMIT 1),'') AS card_id
         FROM ap_supplier s
         WHERE s.code = $1
         LIMIT 1`,
        [supplierCode],
      );
      if (!supplier.rows[0]) throw new Error('supplier not found');

      let whtSupplierRow = supplier.rows[0];
      if (whtList.length > 0 && whtSupplierCode !== supplierCode) {
        const whtSupplier = await client.query(
          `SELECT s.code, COALESCE(s.name_1,'') AS name_1, COALESCE(s.address,'') AS address,
                  COALESCE(s.ap_status,0) AS ap_status,
                  COALESCE((SELECT d.tax_id FROM ap_supplier_detail d WHERE d.ap_code = s.code LIMIT 1),'') AS tax_id,
                  COALESCE((SELECT d.card_id FROM ap_supplier_detail d WHERE d.ap_code = s.code LIMIT 1),'') AS card_id
           FROM ap_supplier s
           WHERE s.code = $1
           LIMIT 1`,
          [whtSupplierCode],
        );
        if (!whtSupplier.rows[0]) throw new Error('wht supplier not found');
        whtSupplierRow = whtSupplier.rows[0];
      }

      const expenseCodes = [...new Set(details.map((row) => row.expense_code))];
      const expenseResult = await client.query(
        `SELECT code, COALESCE(name_1,'') AS name_1
         FROM erp_expenses_list
         WHERE code = ANY($1::text[])`,
        [expenseCodes],
      );
      const expenseMap = new Map(expenseResult.rows.map((row) => [row.code, row]));
      for (const row of details) {
        if (!expenseMap.has(row.expense_code)) throw new Error(`expense not found: ${row.expense_code}`);
      }

      const doc = await resolveDocumentNo(client, {
        screenCode: SCREEN_CODE,
        docFormatCode: safeText(payload.doc_format_code),
        transFlag: TRANS_FLAG,
        docDate,
      });
      savedDocNo = doc.doc_no;
      savedDocFormatCode = doc.doc_format_code;
      savedFormCode = doc.form_code || '';

      await client.query(
        `INSERT INTO ic_trans (
          trans_type, trans_flag, doc_date, doc_time, doc_no, doc_ref, doc_ref_date,
          inquiry_type, vat_type, cust_code, branch_code, vat_rate, tax_doc_no,
          tax_doc_date, total_value, total_before_vat, total_vat_value,
          total_except_vat, total_after_vat, total_amount, remark, doc_format_code,
          credit_date, last_status, used_status, creator_code, create_datetime, is_cancel
        ) VALUES (
          $1,$2,$3::date,$4,$5,'',NULL,$6,$7,$8,$9,$10,$11,$12::date,
          $13,$14,$15,$16,$17,$18,$19,$20,$21::date,0,0,$22,NOW(),0
        )`,
        [
          TRANS_TYPE, TRANS_FLAG, docDate, docTime, savedDocNo,
          inquiryType, vatType, supplierCode, branchCode, vatRate, taxDocNo || savedDocNo,
          taxDocDate || docDate, totals.total_value, totals.total_before_vat,
          totals.total_vat_value, totals.total_except_vat, totals.total_amount,
          totals.total_amount, remark, savedDocFormatCode, docDate, creatorCode,
        ],
      );

      for (let i = 0; i < details.length; i += 1) {
        const row = details[i];
        const expense = expenseMap.get(row.expense_code);
        const itemName = row.expense_name || expense.name_1 || row.expense_code;
        const rowVat = calcVatTotals(row.amount, vatType, vatRate);
        await client.query(
          `INSERT INTO ic_trans_detail (
            trans_type, trans_flag, doc_date, doc_time, doc_no, cust_code,
            inquiry_type, item_code, item_name, qty, price, sum_amount,
            sum_amount_exclude_vat, branch_code, remark, line_number, calc_flag,
            ref_row, is_get_price, doc_date_calc, doc_time_calc,
            last_status, creator_code, create_datetime
          ) VALUES (
            $1,$2,$3::date,$4,$5,$6,$7,$8,$9,0,0,$10,$11,$12,$13,$14,1,-1,1,$3::date,$4,0,$15,NOW()
          )`,
          [
            TRANS_TYPE, TRANS_FLAG, docDate, docTime, savedDocNo, supplierCode,
            inquiryType, row.expense_code, itemName, row.amount,
            rowVat.total_value, row.branch_code || branchCode, row.remark, i, creatorCode,
          ],
        );
      }

      if (vatType !== 3 && (totals.total_vat_value > 0 || vatType === 2)) {
        const supplierRow = supplier.rows[0];
        const vatDate = taxDocDate || docDate;
        await client.query(
          `INSERT INTO gl_journal_vat_buy (
            trans_type, trans_flag, doc_date, doc_no, vat_date, vat_doc_no,
            vat_base_amount, vat_rate, vat_total_amount, vat_type, vat_amount,
            branch_code, tax_no, ap_code, ap_name, vat_effective_period,
            vat_effective_year, vat_calc
          ) VALUES (
            $1,$2,$3::date,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,1
          )`,
          [
            TRANS_TYPE, TRANS_FLAG, docDate, savedDocNo, vatDate, taxDocNo || savedDocNo,
            totals.total_before_vat, vatRate, totals.total_amount, vatType,
            totals.total_vat_value, branchCode, supplierRow.tax_id || '',
            supplierCode, supplierRow.name_1 || '', toInt(vatDate.slice(5, 7), 0),
            toInt(vatDate.slice(0, 4), 0) + 543,
          ],
        );
      }

      if (whtList.length > 0) {
        const whtDocFormatCode = safeText(payload.wht_doc_format_code || payload.wht_tax_doc_format_code || payload.wht_format_code);
        let whtTaxDocNo = safeText(payload.wht_tax_doc_no);
        if (whtDocFormatCode || !whtTaxDocNo || await whtTaxDocNoExists(client, whtTaxDocNo)) {
          const resolvedWhtDoc = await resolveWhtTaxDocNo(client, {
            docFormatCode: whtDocFormatCode,
            docDate: whtList[0].due_date || docDate,
          });
          whtTaxDocNo = resolvedWhtDoc.tax_doc_no;
        }
        savedWhtTaxDocNo = whtTaxDocNo;
        await client.query(
          `INSERT INTO gl_wht_list (
            doc_date, doc_no, amount, tax_value, status, trans_flag, due_date,
            line_number, cust_code, card_number, tax_number, cust_tax_type,
            cust_name, tax_doc_no, cust_address
          ) VALUES (
            $1::date,$2,$3,$4,0,$5,$6::date,0,$7,$8,$9,$10,$11,$12,$13
          )`,
          [
            docDate, savedDocNo, whtBaseAmount, whtAmount, TRANS_FLAG,
            whtList[0].due_date || docDate, whtSupplierRow.code, whtSupplierRow.card_id || '',
            whtSupplierRow.tax_id || '', toInt(whtSupplierRow.ap_status, 0),
            whtSupplierRow.name_1 || '', whtTaxDocNo, whtSupplierRow.address || '',
          ],
        );

        for (let i = 0; i < whtList.length; i += 1) {
          const row = whtList[i];
          const rowTaxDocNo = row.tax_doc_no || whtTaxDocNo;
          await client.query(
            `INSERT INTO gl_wht_list_detail (
              doc_date, doc_no, income_type, tax_rate, amount, tax_value,
              status, trans_flag, due_date, line_number, cust_code, sum_amount,
              tax_doc_no
            ) VALUES (
              NULL,$1,$2,$3,$4,$5,0,$6,$7::date,$8,$9,0,$10
            )`,
            [
              savedDocNo, row.income_type, row.tax_rate, row.amount,
              row.tax_value, TRANS_FLAG, row.due_date || docDate, i + 1,
              whtSupplierRow.code, rowTaxDocNo,
            ],
          );
        }
      }

      if (isCashExpense) {
        const cbRemark = payments.tiger_amount > 0 ? payments.tiger_voucher_num : remark;
        const cbDescription = payments.tiger_amount > 0 ? payments.tiger_voucher_code : '';
        await client.query(
          `INSERT INTO cb_trans (
            trans_type, trans_flag, doc_no, doc_date, doc_time, ap_ar_code,
            pay_type, doc_format_code, total_amount, total_net_amount, cash_amount,
            chq_amount, tranfer_amount, card_amount, total_amount_pay,
            total_credit_charge, total_tax_at_pay, pay_cash_amount, money_change,
            remark, description
          ) VALUES (
            $1,$2,$3,$4::date,$5,$6,2,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0,0,$17,$18
          )`,
          [
            TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime, supplierCode,
            savedDocFormatCode, totals.total_amount, totalNetAmount,
            cashAmount, chequeAmount, transferAmount, cardAmount,
            totalAmountPay, cardCharge, whtAmount, cbRemark, cbDescription,
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
            ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$9,1,$10,$11::date,0,0,0)`,
            [
              TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime,
              passBook.code, passBook.bank_code || row.bank_code,
              passBook.bank_branch || row.bank_branch, row.amount, supplierCode,
              row.chq_due_date || docDate,
            ],
          );
        }

        for (const row of payments.card) {
          await client.query(
            `INSERT INTO cb_trans_detail (
              trans_type, trans_flag, doc_no, doc_date, doc_time, trans_number,
              credit_card_type, amount, sum_amount, doc_type, ap_ar_code,
              trans_number_type, ap_ar_type, charge, ref1, no_approved, last_status
            ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,3,$10,1,1,$11,$6,$12,0)`,
            [
              TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime,
              row.trans_number, row.credit_card_type, row.amount,
              roundMoney(row.amount + row.charge), supplierCode, row.charge,
              row.no_approved,
            ],
          );
        }

        for (const row of payments.cheque) {
          if (!row.trans_number) throw new Error('cheque number is required');
          await client.query(
            `INSERT INTO cb_trans_detail (
              trans_type, trans_flag, doc_no, doc_date, doc_time, bank_code,
              bank_branch, trans_number, amount, sum_amount, chq_due_date, doc_type,
              ap_ar_code, trans_number_type, ap_ar_type, last_status
            ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$9,$10::date,2,$11,1,1,0)`,
            [
              TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime,
              row.bank_code, row.bank_branch, row.trans_number, row.amount,
              row.chq_due_date || docDate, supplierCode,
            ],
          );
        }
      }
    });

    return res.json({
      success: true,
      doc_no: savedDocNo,
      doc_format_code: savedDocFormatCode,
      form_code: savedFormCode,
      inquiry_type: inquiryType,
      inquiry_type_name: inquiryTypeLabel(inquiryType),
      wht_amount: whtAmount,
      wht_tax_doc_no: savedWhtTaxDocNo,
      msg: 'success',
    });
  } catch (ex) {
    if (ex.message && ex.message.includes('not found')) return res.status(404).json({ success: false, msg: ex.message });
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

module.exports = router;

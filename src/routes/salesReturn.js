const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool, query, withTransaction } = require('../db');
const { resolveDocumentNo } = require('../utils/docFormat');
const { getEmployeePermissions } = require('../utils/permissions');
const { renderSalePrintHtml } = require('../utils/salePrintRenderer');

const SALE_TRANS_FLAG = 44;
const SALES_RETURN_TRANS_FLAG = 48;
const SALES_RETURN_SCREEN_CODE = 'ST';
const SALES_RETURN_CREATE_PERMISSION = 'sales.return.create';

const REQUIRED_SCHEMA = {
  ic_trans: [
    'trans_type', 'trans_flag', 'doc_date', 'doc_time', 'doc_no', 'doc_format_code',
    'cust_code', 'inquiry_type', 'vat_type', 'vat_rate', 'doc_ref', 'doc_ref_date',
    'tax_doc_no', 'tax_doc_date', 'total_value', 'total_before_vat', 'total_vat_value',
    'total_after_vat', 'total_amount', 'balance_amount', 'total_discount',
    'discount_word', 'creator_code', 'sale_code', 'branch_code', 'remark',
    'last_status',
  ],
  ic_trans_detail: [
    'trans_type', 'trans_flag', 'doc_date', 'doc_time', 'doc_no', 'cust_code',
    'inquiry_type', 'vat_type', 'item_code', 'item_name', 'unit_code', 'qty',
    'price', 'sum_amount', 'line_number', 'wh_code', 'shelf_code', 'stand_value',
    'divide_value', 'ratio', 'discount', 'discount_amount', 'tax_type',
    'sum_amount_exclude_vat', 'total_vat_value', 'price_exclude_vat', 'barcode',
    'ref_doc_no', 'ref_row', 'doc_ref_type', 'calc_flag', 'last_status',
    'item_type', 'set_ref_line', 'ref_guid', 'item_code_main',
  ],
  ap_ar_trans_detail: [
    'trans_type', 'trans_flag', 'doc_date', 'doc_no', 'billing_no', 'billing_date',
    'sum_debt_value', 'sum_debt_balance', 'sum_debt_amount', 'final_amount',
    'sum_before_vat', 'calc_flag', 'bill_type',
  ],
  gl_journal_vat_sale: [
    'doc_date', 'doc_no', 'vat_number', 'base_caltax_amount', 'tax_rate', 'amount',
    'except_tax_amount', 'vat_date', 'trans_type', 'trans_flag',
    'vat_effective_period', 'vat_effective_year', 'ar_code', 'ar_name', 'tax_no',
    'branch_code', 'ref_vat_no', 'ref_vat_date', 'ref_doc_no', 'ref_doc_date',
    'vat_calc',
  ],
  cb_trans: [
    'trans_type', 'trans_flag', 'doc_no', 'doc_date', 'doc_time', 'ap_ar_code',
    'pay_type', 'doc_format_code', 'total_amount', 'total_net_amount',
    'cash_amount', 'tranfer_amount', 'coupon_amount', 'total_amount_pay',
    'pay_cash_amount', 'money_change',
  ],
  cb_trans_detail: [
    'trans_type', 'trans_flag', 'doc_no', 'doc_date', 'doc_time', 'trans_number',
    'bank_code', 'bank_branch', 'amount', 'sum_amount', 'balance_amount',
    'doc_type', 'ap_ar_code', 'trans_number_type', 'ap_ar_type', 'ref1',
    'remark', 'line_number', 'status', 'last_status',
  ],
  coupon_list: [
    'number', 'amount', 'balance_amount', 'coupon_type',
  ],
};

function safeText(value) {
  return String(value ?? '').trim();
}

function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const text = safeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function toPositiveInt(value, fallback = 80, max = 300) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(num, max);
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

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePaymentDetail(row) {
  const payType = safeText(row.pay_type || row.type);
  const docType = safeText(row.doc_type);
  return {
    payType,
    docType,
    amount: roundMoney(row.pay_amount ?? row.amount),
    transNumber: safeText(row.trans_number || row.pass_book_code || row.coupon_no),
    passBookCode: safeText(row.pass_book_code || row.trans_number),
    bankCode: safeText(row.bank_code),
    bankBranch: safeText(row.bank_branch),
    transferDate: normalizeDate(row.transfer_date),
    ref1: safeText(row.ref1),
  };
}

function uniqueTexts(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = safeText(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function logXml(fields) {
  return `<root>${Object.entries(fields).map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`).join('')}</root>`;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function endOfMonth(dateText) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!match) return dateText;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`;
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
    const key = String(code || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lowerCodes(codes) {
  return codes.map((code) => String(code || '').toLowerCase());
}

function asAmountText(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || Math.abs(num) < 0.005) return '';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function shouldLogPrint(logPrint, autoPrint) {
  if (logPrint !== undefined) {
    const value = String(logPrint).trim().toLowerCase();
    return value !== '0' && value !== 'false' && value !== 'no';
  }
  return String(autoPrint) !== '0';
}

function normalizeSalesReturnPayload(body) {
  let payload = body || {};
  if (typeof payload === 'string') payload = JSON.parse(payload);
  if (payload && typeof payload.payload === 'object') payload = payload.payload;
  return payload || {};
}

function calcLineVat(sumAmount, price, vatType, vatRate, taxType) {
  const amount = roundMoney(sumAmount);
  const unitPrice = toNumber(price);
  if (taxType === 1 || vatType === 2 || vatType === 3) {
    return {
      sumAmount: amount,
      beforeVat: amount,
      vatValue: 0,
      afterVat: amount,
      exceptVat: amount,
      priceExcludeVat: unitPrice,
    };
  }
  if (vatType === 1) {
    const beforeVat = roundMoney((amount * 100) / (100 + vatRate));
    const vatValue = roundMoney(amount - beforeVat);
    return {
      sumAmount: amount,
      beforeVat,
      vatValue,
      afterVat: amount,
      exceptVat: 0,
      priceExcludeVat: roundMoney((unitPrice * 100) / (100 + vatRate)),
    };
  }
  const vatValue = roundMoney(amount * (vatRate / 100));
  return {
    sumAmount: amount,
    beforeVat: amount,
    vatValue,
    afterVat: roundMoney(amount + vatValue),
    exceptVat: 0,
    priceExcludeVat: unitPrice,
  };
}

function buildSaleLineFilters(params) {
  const values = [];
  const where = [
    't.trans_flag = $1',
    'd.trans_flag = $1',
    'COALESCE(t.last_status, 0) = 0',
    'COALESCE(d.last_status, 0) = 0',
    "COALESCE(d.item_code, '') <> ''",
    "(COALESCE(d.set_ref_line, '') = '' OR COALESCE(d.item_type, 0) = 3)",
  ];
  let barcodeParamIndex = null;

  values.push(SALE_TRANS_FLAG);

  const custCode = safeText(params.cust_code);
  if (custCode) {
    values.push(custCode);
    where.push(`t.cust_code = $${values.length}`);
  }

  const itemCode = safeText(params.item_code);
  const barcode = safeText(params.barcode);
  if (itemCode) {
    values.push(itemCode);
    where.push(`d.item_code = $${values.length}`);
  }
  if (barcode) {
    values.push(barcode);
    const n = values.length;
    barcodeParamIndex = n;
    where.push(`(
      d.barcode = $${n}
      OR EXISTS (
        SELECT 1
        FROM ic_inventory_barcode b
        WHERE b.barcode = $${n}
          AND b.ic_code = d.item_code
          AND (COALESCE(b.unit_code, '') = '' OR b.unit_code = d.unit_code)
      )
    )`);
  }

  const search = safeText(params.search);
  if (search) {
    values.push(`%${search}%`);
    const n = values.length;
    where.push(`(
      t.doc_no ILIKE $${n}
      OR d.item_code ILIKE $${n}
      OR d.item_name ILIKE $${n}
      OR COALESCE(d.barcode, '') ILIKE $${n}
    )`);
  }

  const fromDate = normalizeDate(params.fromdate || params.from_date);
  const toDate = normalizeDate(params.todate || params.to_date);
  if (fromDate && toDate) {
    values.push(fromDate, toDate);
    where.push(`t.doc_date BETWEEN $${values.length - 1}::date AND $${values.length}::date`);
  } else if (fromDate) {
    values.push(fromDate);
    where.push(`t.doc_date >= $${values.length}::date`);
  } else if (toDate) {
    values.push(toDate);
    where.push(`t.doc_date <= $${values.length}::date`);
  }

  return { values, where, barcodeParamIndex };
}

async function getRequiredSchemaStatus() {
  const tableNames = Object.keys(REQUIRED_SCHEMA);
  const result = await query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [tableNames],
  );

  const columnMap = new Map();
  for (const row of result.rows) {
    const tableName = row.table_name;
    if (!columnMap.has(tableName)) columnMap.set(tableName, new Set());
    columnMap.get(tableName).add(row.column_name);
  }

  return tableNames.map((tableName) => {
    const existing = columnMap.get(tableName) || new Set();
    const required = REQUIRED_SCHEMA[tableName];
    const missing_columns = required.filter((column) => !existing.has(column));
    return {
      table_name: tableName,
      exists: existing.size > 0,
      required_columns: required,
      missing_columns,
      ready: existing.size > 0 && missing_columns.length === 0,
    };
  });
}

router.get('/getSalesReturnReadiness', async (req, res) => {
  try {
    const [schema, docFormats, couponTable, saleFormatCount] = await Promise.all([
      getRequiredSchemaStatus(),
      query(
        `SELECT code, COALESCE(name_1, '') AS name_1, COALESCE(format, '') AS format,
                COALESCE(form_code, '') AS form_code
         FROM erp_doc_format
         WHERE screen_code = $1
         ORDER BY code`,
        [SALES_RETURN_SCREEN_CODE],
      ),
      query("SELECT to_regclass('public.coupon_list') IS NOT NULL AS exists"),
      query('SELECT COUNT(*)::int AS count FROM erp_doc_format WHERE screen_code = $1', ['SI']),
    ]);

    return res.json({
      success: true,
      data: {
        trans_flag: SALES_RETURN_TRANS_FLAG,
        screen_code: SALES_RETURN_SCREEN_CODE,
        sale_trans_flag: SALE_TRANS_FLAG,
        schema,
        doc_formats: docFormats.rows,
        has_st_doc_format: docFormats.rows.length > 0,
        has_si_doc_format: (saleFormatCount.rows[0]?.count || 0) > 0,
        coupon_table_exists: couponTable.rows[0]?.exists === true,
        read_api_ready: docFormats.rows.length > 0,
      },
    });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/getSalesReturnDocFormatList', async (req, res) => {
  try {
    const result = await query(
      `SELECT code, COALESCE(name_1, '') AS name_1, COALESCE(format, '') AS format,
              COALESCE(form_code, '') AS form_code
       FROM erp_doc_format
       WHERE screen_code = $1
       ORDER BY code`,
      [SALES_RETURN_SCREEN_CODE],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/getNextSalesReturnDocNo', async (req, res) => {
  const docDate = normalizeDate(req.query.doc_date) || new Date().toISOString().slice(0, 10);
  const docFormatCode = safeText(req.query.doc_format_code);
  try {
    const clientLike = { query };
    const resolved = await resolveDocumentNo(clientLike, {
      screenCode: SALES_RETURN_SCREEN_CODE,
      docFormatCode,
      docDate,
      transFlag: SALES_RETURN_TRANS_FLAG,
    });
    return res.json({ success: true, ...resolved, trans_flag: SALES_RETURN_TRANS_FLAG });
  } catch (ex) {
    return res.status(400).json({ success: false, msg: ex.message });
  }
});

router.get('/getReturnableSaleItems', async (req, res) => {
  const custCode = safeText(req.query.cust_code);
  const barcode = safeText(req.query.barcode);
  const itemCode = safeText(req.query.item_code);
  const search = safeText(req.query.search);
  const limit = toPositiveInt(req.query.limit);

  if (!custCode) return res.status(400).json({ success: false, msg: 'cust_code is required' });
  if (!barcode && !itemCode && !search) {
    return res.status(400).json({ success: false, msg: 'barcode, item_code, or search is required' });
  }

  try {
    const filters = buildSaleLineFilters(req.query);
    const barcodeOrderSql = filters.barcodeParamIndex
      ? `CASE WHEN b.barcode = $${filters.barcodeParamIndex} THEN 0 ELSE 1 END,`
      : '';
    filters.values.push(SALES_RETURN_TRANS_FLAG);
    const returnFlagParam = filters.values.length;
    filters.values.push(limit);
    const limitParam = filters.values.length;

    const sql = `
      WITH sale_lines AS (
        SELECT
          t.doc_no AS sale_doc_no,
          t.doc_date AS sale_doc_date,
          t.doc_time AS sale_doc_time,
          COALESCE(t.doc_format_code, '') AS sale_doc_format_code,
          t.cust_code,
          COALESCE(ar.name_1, '') AS cust_name,
          COALESCE(t.inquiry_type, 1) AS sale_inquiry_type,
          COALESCE(t.vat_type, 1) AS sale_vat_type,
          COALESCE(t.vat_rate, 7) AS vat_rate,
          COALESCE(t.total_amount, 0) AS sale_total_amount,
          d.line_number AS sale_line_number,
          COALESCE(d.item_code, '') AS item_code,
          COALESCE(d.item_name, '') AS item_name,
          COALESCE(d.unit_code, '') AS unit_code,
          COALESCE(NULLIF(d.barcode, ''), (
            SELECT b.barcode
            FROM ic_inventory_barcode b
            WHERE b.ic_code = d.item_code
              AND (COALESCE(b.unit_code, '') = '' OR b.unit_code = d.unit_code)
            ORDER BY ${barcodeOrderSql} b.barcode
            LIMIT 1
          ), '') AS barcode,
          COALESCE(d.qty, 0) AS sale_qty,
          COALESCE(d.price, 0) AS price,
          COALESCE(d.sum_amount, 0) AS sale_sum_amount,
          COALESCE(d.discount, '') AS discount,
          COALESCE(d.discount_amount, 0) AS discount_amount,
          COALESCE(d.wh_code, '') AS wh_code,
          COALESCE(d.shelf_code, '') AS shelf_code,
          COALESCE(d.stand_value, 1) AS stand_value,
          COALESCE(NULLIF(d.divide_value, 0), 1) AS divide_value,
          COALESCE(d.ratio, 0) AS ratio,
          COALESCE(d.tax_type, 0) AS tax_type,
          COALESCE(d.sum_amount_exclude_vat, d.sum_amount, 0) AS sum_amount_exclude_vat,
          COALESCE(d.total_vat_value, 0) AS line_vat_value,
          COALESCE(d.price_exclude_vat, d.price, 0) AS price_exclude_vat,
          COALESCE(d.item_type, 0) AS item_type,
          COALESCE(d.set_ref_line, '') AS set_ref_line,
          COALESCE(d.ref_guid, '') AS ref_guid,
          COALESCE(d.item_code_main, '') AS item_code_main
        FROM ic_trans t
        JOIN ic_trans_detail d
          ON d.doc_no = t.doc_no
         AND d.trans_flag = t.trans_flag
        LEFT JOIN ar_customer ar ON ar.code = t.cust_code
        WHERE ${filters.where.join('\n          AND ')}
      ),
      returned AS (
        SELECT
          s.sale_doc_no,
          s.sale_line_number,
          s.item_code,
          COALESCE(SUM(
            CASE
              WHEN rt.doc_no IS NOT NULL
               AND COALESCE(rd.inquiry_type, rt.inquiry_type, 0) NOT IN (2, 3)
              THEN COALESCE(rd.qty, 0) * (COALESCE(rd.stand_value, 1) / COALESCE(NULLIF(rd.divide_value, 0), 1))
              ELSE 0
            END
          ), 0) AS returned_qty_base,
          COALESCE(SUM(CASE WHEN rt.doc_no IS NOT NULL THEN COALESCE(rd.sum_amount, 0) ELSE 0 END), 0) AS returned_amount
        FROM sale_lines s
        LEFT JOIN ic_trans_detail rd
          ON rd.trans_flag = $${returnFlagParam}
         AND COALESCE(rd.last_status, 0) = 0
         AND rd.ref_doc_no = s.sale_doc_no
         AND rd.item_code = s.item_code
         AND COALESCE(rd.ref_row, -1) = s.sale_line_number
        LEFT JOIN ic_trans rt
          ON rt.doc_no = rd.doc_no
         AND rt.trans_flag = rd.trans_flag
         AND COALESCE(rt.last_status, 0) = 0
        GROUP BY s.sale_doc_no, s.sale_line_number, s.item_code
      ),
      balanced AS (
        SELECT
          s.*,
          (s.stand_value / s.divide_value) AS unit_ratio,
          (s.sale_qty * (s.stand_value / s.divide_value)) AS sale_qty_base,
          COALESCE(r.returned_qty_base, 0) AS returned_qty_base,
          COALESCE(r.returned_amount, 0) AS returned_amount,
          ((s.sale_qty * (s.stand_value / s.divide_value)) - COALESCE(r.returned_qty_base, 0)) AS returnable_qty_base,
          (s.sale_sum_amount - COALESCE(r.returned_amount, 0)) AS returnable_amount
        FROM sale_lines s
        LEFT JOIN returned r
          ON r.sale_doc_no = s.sale_doc_no
         AND r.sale_line_number = s.sale_line_number
         AND r.item_code = s.item_code
      )
      SELECT
        *,
        CASE WHEN unit_ratio = 0 THEN 0 ELSE returnable_qty_base / unit_ratio END AS returnable_qty,
        CASE
          WHEN returnable_qty_base <= 0 THEN 0
          ELSE returnable_amount / (CASE WHEN unit_ratio = 0 THEN returnable_qty_base ELSE returnable_qty_base / unit_ratio END)
        END AS return_unit_price,
        CASE
          WHEN sale_inquiry_type IN (0, 2) THEN 'credit'
          WHEN sale_inquiry_type IN (1, 3) THEN 'cash'
          ELSE 'unknown'
        END AS sale_kind
      FROM balanced
      WHERE returnable_qty_base > 0
      ORDER BY sale_doc_date DESC, sale_doc_no DESC, sale_line_number
      LIMIT $${limitParam}`;

    const result = await query(sql, filters.values);
    return res.json({
      success: true,
      data: result.rows,
      meta: {
        trans_flag: SALES_RETURN_TRANS_FLAG,
        sale_trans_flag: SALE_TRANS_FLAG,
        count: result.rows.length,
      },
    });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

async function loadSalesReturnPaymentRows(docNo) {
  const tableRes = await query(
    `SELECT
        to_regclass('public.cb_trans') AS cb_table,
        to_regclass('public.cb_trans_detail') AS cb_detail_table`,
  );
  if (!tableRes.rows[0]?.cb_table) return [];

  const labels = [];
  const amounts = [];
  const cbRes = await query(
    `SELECT
        COALESCE(cash_amount,0) AS cash_amount,
        COALESCE(tranfer_amount,0) AS tranfer_amount,
        COALESCE(coupon_amount,0) AS coupon_amount
     FROM cb_trans
     WHERE doc_no = $1 AND trans_flag = $2
     LIMIT 1`,
    [docNo, SALES_RETURN_TRANS_FLAG],
  );

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
       ORDER BY doc_type, trans_number`,
      [docNo, SALES_RETURN_TRANS_FLAG],
    );

    for (const row of detailRes.rows) {
      const amount = asAmountText(row.amount);
      if (!amount) continue;
      const docType = Number(row.doc_type || 0);
      let label = String(row.trans_number || '').trim();
      if (docType === 1) label = label ? `เงินโอน ~ ${label}` : 'เงินโอน';
      else if (docType === 9) label = label ? `คูปอง ~ ${label}` : 'คูปอง';
      else label = label || 'คืนเงิน';
      labels.push(label);
      amounts.push(amount);
    }
  }

  return labels.length
    ? [{ trans_number: labels.join('\n'), amount: amounts.join('\n') }]
    : [];
}

async function loadSalesReturnDocument(docNo) {
  const [headerRes, companyRes, detailsRes, refsRes, payments] = await Promise.all([
    query(
      `SELECT t.*,
          COALESCE(df.name_1,'') AS doc_format_name,
          COALESCE(df.form_code,'') AS form_code,
          COALESCE(ar.name_1,'') AS name_1,
          COALESCE(ar.address,'') AS address,
          COALESCE(ar.telephone,'') AS telephone,
          COALESCE(ar.fax,'') AS fax,
          COALESCE(cd.tax_id,'') AS tax_id,
          COALESCE(t.contactor,'') AS contactor,
          COALESCE(u.name_1, t.sale_code, '') AS sale_name,
          COALESCE(cb.cash_amount,0) AS cash_amount,
          COALESCE(cb.tranfer_amount,0) AS tranfer_amount,
          COALESCE(cb.coupon_amount,0) AS coupon_amount,
          COALESCE(cb.total_amount_pay,0) AS total_amount_pay
       FROM ic_trans t
       LEFT JOIN erp_doc_format df ON df.screen_code = $2 AND df.code = t.doc_format_code
       LEFT JOIN ar_customer ar ON ar.code = t.cust_code
       LEFT JOIN ar_customer_detail cd ON cd.ar_code = t.cust_code
       LEFT JOIN erp_user u ON UPPER(u.code) = UPPER(t.sale_code)
       LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = t.trans_flag
       WHERE t.trans_flag = $3 AND t.doc_no = $1
       LIMIT 1`,
      [docNo, SALES_RETURN_SCREEN_CODE, SALES_RETURN_TRANS_FLAG],
    ),
    query('SELECT * FROM erp_company_profile ORDER BY roworder LIMIT 1'),
    query(
      `SELECT d.*,
          COALESCE(u.name_1, d.unit_code, '') AS unit_name,
          COALESCE(d.ref_doc_no,'') AS sale_doc_no,
          COALESCE(d.sum_amount,0) AS amount,
          COALESCE(d.discount,'') AS discount_word
       FROM ic_trans_detail d
       LEFT JOIN ic_unit u ON u.code = d.unit_code
       WHERE d.trans_flag = $2
         AND d.doc_no = $1
         AND (COALESCE(d.set_ref_line,'') = '' OR COALESCE(d.item_type,0) = 3)
       ORDER BY d.line_number`,
      [docNo, SALES_RETURN_TRANS_FLAG],
    ),
    query(
      `SELECT billing_no, billing_date, COALESCE(sum_debt_amount,0) AS sum_debt_amount
       FROM ap_ar_trans_detail
       WHERE doc_no = $1 AND trans_flag = $2
       ORDER BY billing_date, billing_no`,
      [docNo, SALES_RETURN_TRANS_FLAG],
    ),
    loadSalesReturnPaymentRows(docNo),
  ]);

  const header = headerRes.rows[0];
  if (!header) return null;

  const company = companyRes.rows[0] || {};
  company.tax_text = company.tax_number ? `หมายเลขประจำตัวผู้เสียภาษี ${company.tax_number}` : '';
  company.telephone_text = company.telephone_number ? `โทร. ${company.telephone_number}` : '';

  header.doc_title = Number(header.inquiry_type) === 1 ? 'ใบรับคืนสินค้า/คืนเงิน' : 'ใบรับคืนสินค้า/ลดหนี้';
  header.total_net_amount = header.total_amount;
  header.sale_doc_list = refsRes.rows.map((row) => row.billing_no).filter(Boolean).join(',');

  return {
    header,
    company,
    details: detailsRes.rows || [],
    refs: refsRes.rows || [],
    payments,
  };
}

async function loadSalesReturnPrintFormOptions(docNo) {
  const docRes = await query(
    `SELECT t.doc_no, COALESCE(t.doc_format_code,'') AS doc_format_code,
        COALESCE(df.name_1,'') AS doc_format_name,
        COALESCE(df.form_code,'') AS form_code
     FROM ic_trans t
     LEFT JOIN erp_doc_format df ON df.screen_code = $2 AND df.code = t.doc_format_code
     WHERE t.trans_flag = $3 AND t.doc_no = $1
     LIMIT 1`,
    [docNo, SALES_RETURN_SCREEN_CODE, SALES_RETURN_TRANS_FLAG],
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

async function loadSalesReturnFormDesignRows(formCodes) {
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

async function getSalesReturnPrintCount(docNo) {
  const result = await query(
    `SELECT COUNT(*)::int AS print_count
     FROM erp_print_logs
     WHERE trans_flag = $2 AND doc_no = $1`,
    [docNo, SALES_RETURN_TRANS_FLAG],
  );
  return Number(result.rows[0]?.print_count || 0);
}

async function createSalesReturnPrintLog(docNo, userCode) {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO erp_print_logs (doc_no, trans_flag, user_code, print_datetime)
       VALUES ($1, $2, $3, NOW())`,
      [docNo, SALES_RETURN_TRANS_FLAG, String(userCode || 'WEB').trim() || 'WEB'],
    );
    const result = await client.query(
      `SELECT COUNT(*)::int AS print_count
       FROM erp_print_logs
       WHERE trans_flag = $2 AND doc_no = $1`,
      [docNo, SALES_RETURN_TRANS_FLAG],
    );
    return Number(result.rows[0]?.print_count || 0);
  });
}

router.get('/getSalesReturnDetail', async (req, res) => {
  const docNo = safeText(req.query.doc_no);
  if (!docNo) return res.status(400).json({ success: false, msg: 'doc_no is required' });

  try {
    const document = await loadSalesReturnDocument(docNo);
    if (!document) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({
      success: true,
      data: {
        ...document.header,
        items: document.details,
        refs: document.refs,
        payments: document.payments,
        company: document.company,
      },
    });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/getSalesReturnStorageCheck', async (req, res) => {
  const docNo = safeText(req.query.doc_no);
  if (!docNo) return res.status(400).json({ success: false, msg: 'doc_no is required' });

  try {
    const [header, details, refs, cbTrans, cbDetail, vat, coupon] = await Promise.all([
      query(
        `SELECT doc_no, doc_date, doc_time, trans_flag, doc_format_code, cust_code,
                inquiry_type, vat_type, vat_rate, total_amount, total_before_vat,
                total_vat_value, total_after_vat, total_except_vat, doc_ref,
                doc_ref_date, tax_doc_no, tax_doc_date, last_status
         FROM ic_trans
         WHERE doc_no = $1 AND trans_flag = $2
         LIMIT 1`,
        [docNo, SALES_RETURN_TRANS_FLAG],
      ),
      query(
        `SELECT line_number, item_code, unit_code, qty, price, sum_amount,
                sum_amount_exclude_vat, total_vat_value, ref_doc_no, ref_row,
                doc_ref_type, calc_flag, last_status
         FROM ic_trans_detail
         WHERE doc_no = $1 AND trans_flag = $2
         ORDER BY line_number`,
        [docNo, SALES_RETURN_TRANS_FLAG],
      ),
      query(
        `SELECT billing_no, billing_date, sum_debt_value, sum_debt_balance,
                sum_debt_amount, final_amount, sum_before_vat, calc_flag, bill_type
         FROM ap_ar_trans_detail
         WHERE doc_no = $1 AND trans_flag = $2`,
        [docNo, SALES_RETURN_TRANS_FLAG],
      ),
      query(
        `SELECT pay_type, total_amount, total_net_amount, cash_amount, tranfer_amount,
                coupon_amount, total_amount_pay, pay_cash_amount, money_change
         FROM cb_trans
         WHERE doc_no = $1 AND trans_flag = $2`,
        [docNo, SALES_RETURN_TRANS_FLAG],
      ),
      query(
        `SELECT doc_type, trans_number, bank_code, bank_branch, amount, sum_amount,
                balance_amount, ap_ar_code, ref1, remark, line_number, status, last_status
         FROM cb_trans_detail
         WHERE doc_no = $1 AND trans_flag = $2
         ORDER BY doc_type, trans_number`,
        [docNo, SALES_RETURN_TRANS_FLAG],
      ),
      query(
        `SELECT doc_no, vat_number, base_caltax_amount, tax_rate, amount,
                except_tax_amount, trans_flag, vat_calc, ref_vat_no, ref_vat_date,
                ref_doc_no, ref_doc_date
         FROM gl_journal_vat_sale
         WHERE doc_no = $1 AND trans_flag = $2`,
        [docNo, SALES_RETURN_TRANS_FLAG],
      ),
      query(
        `SELECT number, amount, balance_amount, remark, single_use, coupon_type,
                date, date_expire
         FROM coupon_list
         WHERE number = $1`,
        [docNo],
      ),
    ]);

    if (!header.rows.length) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({
      success: true,
      data: {
        header: header.rows,
        details: details.rows,
        refs: refs.rows,
        cb_trans: cbTrans.rows,
        cb_detail: cbDetail.rows,
        vat: vat.rows,
        coupon: coupon.rows,
      },
    });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/getSalesReturnPrintForms', async (req, res) => {
  const docNo = safeText(req.query.doc_no);
  if (!docNo) return res.status(400).json({ success: false, msg: 'doc_no is required' });

  try {
    const options = await loadSalesReturnPrintFormOptions(docNo);
    if (!options) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({ success: true, data: options });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/sales-return-print/render', async (req, res) => {
  const { doc_no = '', formcodes = '', auto_print = '1', log_print, user_code = '' } = req.query;
  const docNo = safeText(doc_no);
  if (!docNo) return res.status(400).type('text/plain').send('doc_no is required');

  try {
    const [options, salesReturnData] = await Promise.all([
      loadSalesReturnPrintFormOptions(docNo),
      loadSalesReturnDocument(docNo),
    ]);

    if (!options || !salesReturnData) return res.status(404).type('text/plain').send('document not found');

    const availableCodes = options.forms.filter((form) => form.available).map((form) => form.formcode);
    const requestedCodes = uniqueCodes(splitFormCodes(formcodes));
    const selectedCodes = requestedCodes.length
      ? requestedCodes.filter((code) => availableCodes.some((available) => available.toLowerCase() === code.toLowerCase()))
      : availableCodes.slice(0, 1);

    if (!selectedCodes.length) return res.status(404).type('text/plain').send('print form not found');

    const formRows = await loadSalesReturnFormDesignRows(selectedCodes);
    if (!formRows.length) return res.status(404).type('text/plain').send('print form not found');

    const logThisPrint = req.method !== 'HEAD' && shouldLogPrint(log_print, auto_print);
    const printCount = logThisPrint
      ? await createSalesReturnPrintLog(docNo, user_code || salesReturnData.header.creator_code)
      : await getSalesReturnPrintCount(docNo);
    salesReturnData.header.print_count = printCount;

    const html = renderSalePrintHtml({
      formRows,
      data: salesReturnData,
      autoPrint: String(auto_print) !== '0',
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('html').send(html);
  } catch (ex) {
    return res.status(500).type('text/plain').send(ex.message);
  }
});

async function customerTaxInfo(client, custCode, fallbackBranchCode = '') {
  const result = await client.query(
    `SELECT c.code,
            COALESCE(c.name_1, '') AS name_1,
            COALESCE(d.branch_code, $2) AS branch_code,
            COALESCE(d.tax_id, d.card_id, '') AS tax_id,
            COALESCE(d.branch_type, 0) AS branch_type
     FROM ar_customer c
     LEFT JOIN ar_customer_detail d ON d.ar_code = c.code
     WHERE c.code = $1
     LIMIT 1`,
    [custCode, fallbackBranchCode],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`customer not found: ${custCode}`);
  return row;
}

async function lockAndBuildReturnLines(client, fields) {
  const lines = [];
  const errors = [];
  for (const [index, item] of fields.items.entries()) {
    const itemCode = safeText(item.item_code);
    const refDocNo = safeText(item.ref_doc_no);
    const refRow = toInt(item.ref_row, -1);
    const returnQty = toNumber(item.qty ?? item.return_qty);
    if (!itemCode || !refDocNo || refRow < 0 || returnQty <= 0) {
      errors.push(`invalid return item row: ${index + 1}`);
      continue;
    }

    const result = await client.query(
      `WITH sale_line AS (
         SELECT
           t.doc_no AS sale_doc_no,
           t.doc_date AS sale_doc_date,
           t.doc_time AS sale_doc_time,
           COALESCE(t.doc_format_code, '') AS sale_doc_format_code,
           t.cust_code,
           COALESCE(t.inquiry_type, 1) AS sale_inquiry_type,
           COALESCE(t.vat_type, 1) AS sale_vat_type,
           COALESCE(t.vat_rate, 7) AS vat_rate,
           COALESCE(t.total_amount, 0) AS sale_total_amount,
           d.line_number AS sale_line_number,
           COALESCE(d.item_code, '') AS item_code,
           COALESCE(d.item_name, '') AS item_name,
           COALESCE(d.unit_code, '') AS unit_code,
           COALESCE(d.barcode, '') AS barcode,
           COALESCE(d.qty, 0) AS sale_qty,
           COALESCE(d.price, 0) AS sale_price,
           COALESCE(d.sum_amount, 0) AS sale_sum_amount,
           COALESCE(d.discount, '') AS discount,
           COALESCE(d.discount_amount, 0) AS discount_amount,
           COALESCE(d.wh_code, '') AS wh_code,
           COALESCE(d.shelf_code, '') AS shelf_code,
           COALESCE(d.stand_value, 1) AS stand_value,
           COALESCE(NULLIF(d.divide_value, 0), 1) AS divide_value,
           COALESCE(d.tax_type, 0) AS tax_type,
           COALESCE(d.item_type, 0) AS item_type,
           COALESCE(d.set_ref_line, '') AS set_ref_line,
           COALESCE(d.ref_guid, '') AS sale_ref_guid,
           COALESCE(d.item_code_main, '') AS item_code_main
         FROM ic_trans t
         JOIN ic_trans_detail d
           ON d.doc_no = t.doc_no
          AND d.trans_flag = t.trans_flag
         WHERE t.trans_flag = $1
           AND d.trans_flag = $1
           AND t.doc_no = $2
           AND d.line_number = $3
           AND d.item_code = $4
           AND t.cust_code = $5
           AND COALESCE(t.last_status, 0) = 0
           AND COALESCE(d.last_status, 0) = 0
         FOR UPDATE OF t, d
       ),
       returned AS (
         SELECT
           COALESCE(SUM(
             CASE
               WHEN rt.doc_no IS NOT NULL
                AND COALESCE(rd.inquiry_type, rt.inquiry_type, 0) NOT IN (2, 3)
               THEN COALESCE(rd.qty, 0) * (COALESCE(rd.stand_value, 1) / COALESCE(NULLIF(rd.divide_value, 0), 1))
               ELSE 0
             END
           ), 0) AS returned_qty_base,
           COALESCE(SUM(CASE WHEN rt.doc_no IS NOT NULL THEN COALESCE(rd.sum_amount, 0) ELSE 0 END), 0) AS returned_amount
         FROM sale_line s
         LEFT JOIN ic_trans_detail rd
           ON rd.trans_flag = $6
          AND COALESCE(rd.last_status, 0) = 0
          AND rd.ref_doc_no = s.sale_doc_no
          AND rd.item_code = s.item_code
          AND COALESCE(rd.ref_row, -1) = s.sale_line_number
         LEFT JOIN ic_trans rt
           ON rt.doc_no = rd.doc_no
          AND rt.trans_flag = rd.trans_flag
          AND COALESCE(rt.last_status, 0) = 0
       )
       SELECT
         s.*,
         r.returned_qty_base,
         r.returned_amount,
         (s.stand_value / s.divide_value) AS unit_ratio,
         (s.sale_qty * (s.stand_value / s.divide_value)) AS sale_qty_base,
         ((s.sale_qty * (s.stand_value / s.divide_value)) - r.returned_qty_base) AS returnable_qty_base,
         CASE
           WHEN (s.stand_value / s.divide_value) = 0 THEN 0
           ELSE ((s.sale_qty * (s.stand_value / s.divide_value)) - r.returned_qty_base) / (s.stand_value / s.divide_value)
         END AS returnable_qty,
         (s.sale_sum_amount - r.returned_amount) AS returnable_amount
       FROM sale_line s
       CROSS JOIN returned r`,
      [SALE_TRANS_FLAG, refDocNo, refRow, itemCode, fields.custCode, SALES_RETURN_TRANS_FLAG],
    );

    const sale = result.rows[0];
    if (!sale) {
      errors.push(`sale reference not found: row ${index + 1}`);
      continue;
    }
    if (toNumber(sale.sale_inquiry_type) !== fields.inquiryType) {
      errors.push(`sale type mismatch: ${refDocNo}`);
      continue;
    }

    const returnableQty = toNumber(sale.returnable_qty);
    if (returnQty - returnableQty > 0.0001) {
      errors.push(`return qty exceeds sale balance: ${refDocNo} line ${refRow}`);
      continue;
    }

    const returnUnitPrice = returnableQty > 0
      ? toNumber(sale.returnable_amount) / returnableQty
      : toNumber(sale.sale_price);
    const price = toNumber(item.price, returnUnitPrice) || returnUnitPrice;
    const sumAmount = roundMoney(returnQty * price);
    if (sumAmount - toNumber(sale.returnable_amount) > 0.01) {
      errors.push(`return amount exceeds sale balance: ${refDocNo} line ${refRow}`);
      continue;
    }

    const tax = calcLineVat(sumAmount, price, fields.vatType, fields.vatRate, toInt(sale.tax_type));
    lines.push({
      ...sale,
      returnQty,
      price,
      sumAmount: tax.sumAmount,
      beforeVat: tax.beforeVat,
      vatValue: tax.vatValue,
      afterVat: tax.afterVat,
      exceptVat: tax.exceptVat,
      priceExcludeVat: tax.priceExcludeVat,
      lineNumber: lines.length,
      barcode: safeText(item.barcode) || sale.barcode || '',
      discount: safeText(item.discount) || sale.discount || '',
      discountAmount: toNumber(item.discount_amount, 0),
    });
  }
  if (errors.length) throw new Error(errors.join('; '));
  if (!lines.length) throw new Error('items is empty');
  const sourceDocNos = uniqueTexts(lines.map((line) => line.sale_doc_no));
  if (sourceDocNos.length > 1) {
    throw new Error('sales return must reference one sale document per return document');
  }
  return lines;
}

function normalizedSalesReturnFields(payload) {
  const docDate = normalizeDate(payload.doc_date);
  const now = new Date();
  const docTime = safeText(payload.doc_time) || `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const inquiryType = toInt(payload.inquiry_type, 0);
  const vatType = toInt(payload.vat_type, 1);
  const vatRate = toNumber(payload.vat_rate, 7);
  const items = normalizeArray(payload.items);
  const paymentDetails = normalizeArray(payload.payment_detail).map(normalizePaymentDetail);
  return {
    docDate,
    docTime,
    docFormatCode: safeText(payload.doc_format_code),
    custCode: safeText(payload.cust_code),
    branchCode: safeText(payload.branch_code),
    creatorCode: safeText(payload.emp_code || payload.creator_code),
    programCreatorCode: safeText(payload.creator_code),
    saleCode: safeText(payload.sale_code || payload.emp_code),
    remark: String(payload.remark ?? ''),
    inquiryType,
    vatType,
    vatRate,
    taxDocNo: safeText(payload.tax_doc_no),
    taxDocDate: normalizeDate(payload.tax_doc_date) || docDate,
    totalDiscount: toNumber(payload.total_discount),
    discountWord: String(payload.discount_word ?? ''),
    cashAmount: roundMoney(payload.cash_amount),
    transferAmount: roundMoney(payload.tranfer_amount ?? payload.transfer_amount),
    couponAmount: roundMoney(payload.coupon_amount),
    paymentDetails,
    items,
  };
}

function validateSalesReturnFields(fields) {
  const errors = [];
  if (!fields.docDate) errors.push('doc_date is required as YYYY-MM-DD');
  if (!fields.docFormatCode) errors.push('doc_format_code is required');
  if (!fields.custCode) errors.push('cust_code is required');
  if (!fields.creatorCode) errors.push('creator_code or emp_code is required');
  if (![0, 1].includes(fields.inquiryType)) errors.push('inquiry_type must be 0 credit return or 1 cash return');
  if (fields.cashAmount < 0 || fields.transferAmount < 0 || fields.couponAmount < 0) {
    errors.push('payment amounts must not be negative');
  }
  if (!fields.items.length) errors.push('items is empty');
  return errors;
}

async function requireSalesReturnCreatePermission(client, userCode) {
  const code = safeText(userCode);
  if (!code) throw new Error('creator_code or emp_code is required for permission check');
  const permissions = await getEmployeePermissions(client.query.bind(client), code);
  if (!permissions.includes(SALES_RETURN_CREATE_PERMISSION)) {
    throw new Error(`permission denied: ${SALES_RETURN_CREATE_PERMISSION}`);
  }
}

async function insertSalesReturnHeader(client, docNo, fields, totals, docRef) {
  await client.query(
    `INSERT INTO ic_trans
      (trans_type, trans_flag, doc_date, doc_time, doc_no, inquiry_type, vat_type,
       cust_code, vat_rate, user_request, doc_format_code, creator_code, remark,
       branch_code, sale_code, total_value, total_before_vat, total_vat_value,
       total_after_vat, total_except_vat, total_amount, balance_amount,
       tax_doc_no, tax_doc_date, total_discount, discount_word, doc_ref, doc_ref_date)
     VALUES
      (2, $1, $2::date, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17,
       $18, $19, $20, $20,
       $21, $22::date, $23, $24, $25, $26::date)`,
    [
      SALES_RETURN_TRANS_FLAG,
      fields.docDate,
      fields.docTime,
      docNo,
      fields.inquiryType,
      fields.vatType,
      fields.custCode,
      fields.vatRate,
      fields.creatorCode,
      fields.docFormatCode,
      fields.programCreatorCode || fields.creatorCode,
      fields.remark,
      fields.branchCode,
      fields.saleCode,
      totals.totalValue,
      totals.totalBeforeVat,
      totals.totalVatValue,
      totals.totalAfterVat,
      totals.totalExceptVat,
      totals.totalAmount,
      fields.taxDocNo || docNo,
      fields.taxDocDate,
      fields.totalDiscount,
      fields.discountWord,
      docRef.docNo,
      docRef.docDate,
    ],
  );
}

async function insertSalesReturnDetails(client, docNo, fields, lines) {
  for (const line of lines) {
    await client.query(
      `INSERT INTO ic_trans_detail
        (trans_type, trans_flag, doc_date, doc_time, doc_no, cust_code, inquiry_type,
         vat_type, item_code, item_name, unit_code, qty, price, sum_amount,
         line_number, remark, wh_code, shelf_code, stand_value, divide_value,
         ratio, doc_time_calc, doc_date_calc, discount, discount_amount, barcode,
         calc_flag, tax_type, sum_amount_exclude_vat, total_vat_value,
         price_exclude_vat, ref_doc_no, ref_row, doc_ref_type,
         item_type, item_code_main, set_ref_line)
       VALUES
        (2, $1, $2::date, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19,
         0, $3, $2::date, $20, $21, $22,
         1, $23, $24, $25,
         $26, $27, $28, 1,
         $29, $30, $31)`,
      [
        SALES_RETURN_TRANS_FLAG,
        fields.docDate,
        fields.docTime,
        docNo,
        fields.custCode,
        fields.inquiryType,
        fields.vatType,
        line.item_code,
        line.item_name,
        line.unit_code,
        line.returnQty,
        line.price,
        line.sumAmount,
        line.lineNumber,
        '',
        line.wh_code,
        line.shelf_code,
        line.stand_value,
        line.divide_value,
        line.discount,
        line.discountAmount,
        line.barcode,
        toInt(line.tax_type),
        line.beforeVat,
        line.vatValue,
        line.priceExcludeVat,
        line.sale_doc_no,
        line.sale_line_number,
        toInt(line.item_type),
        line.item_code_main || '',
        line.set_ref_line || '',
      ],
    );
  }
}

async function insertSalesReturnRefs(client, docNo, fields, lines) {
  const grouped = new Map();
  for (const line of lines) {
    const key = line.sale_doc_no;
    const current = grouped.get(key) || {
      docNo: line.sale_doc_no,
      docDate: normalizeDate(line.sale_doc_date),
      saleTotal: toNumber(line.sale_total_amount),
      amount: 0,
      beforeVat: 0,
    };
    current.amount = roundMoney(current.amount + line.sumAmount);
    current.beforeVat = roundMoney(current.beforeVat + line.beforeVat);
    grouped.set(key, current);
  }

  for (const ref of grouped.values()) {
    await client.query(
      `INSERT INTO ap_ar_trans_detail
        (trans_type, trans_flag, doc_date, doc_no, billing_no, billing_date,
         sum_debt_value, sum_debt_balance, sum_debt_amount, final_amount,
         sum_before_vat, calc_flag, bill_type)
       VALUES (2, $1, $2::date, $3, $4, $5::date, $6, $7, $8, $9, $10, -1, 1)`,
      [
        SALES_RETURN_TRANS_FLAG,
        fields.docDate,
        docNo,
        ref.docNo,
        ref.docDate,
        ref.saleTotal,
        ref.amount,
        ref.amount,
        0,
        ref.beforeVat,
      ],
    );
  }
}

async function insertSalesReturnVat(client, docNo, fields, totals, customer, docRef) {
  const date = new Date(fields.docDate);
  const vatEffectivePeriod = date.getMonth() + 1;
  const vatEffectiveYear = date.getFullYear() + 543;
  await client.query(
    `INSERT INTO gl_journal_vat_sale
      (ignore_sync, is_lock_record, doc_date, doc_no, book_code, line_number,
       vat_number, tax_group, description, base_caltax_amount, tax_rate, amount,
       except_tax_amount, period_number, is_add, vat_date, trans_type, trans_flag,
       vat_effective_period, ar_code, ar_name, vat_calc, vat_effective_year,
       branch_type, branch_code, tax_no, manual_add, is_doc_copy, create_date_time_now,
       vat_type, ref_vat_no, ref_vat_date, ref_doc_no, ref_doc_date)
     VALUES
      (0, 0, $1::date, $2, '', 0,
       $3, '', '', $4, $5, $6,
       $7, 0, 0, $8::date, 2, $9,
       $10, $11, $12, -1, $13,
       $14, $15, $16, 0, 0, NOW(),
       0, $17, $18::date, $19, $20::date)`,
    [
      fields.docDate,
      docNo,
      fields.taxDocNo || docNo,
      totals.totalBeforeVat,
      fields.vatRate,
      totals.totalVatValue,
      totals.totalExceptVat,
      fields.taxDocDate,
      SALES_RETURN_TRANS_FLAG,
      vatEffectivePeriod,
      fields.custCode,
      customer.name_1 || '',
      vatEffectiveYear,
      toInt(customer.branch_type),
      customer.branch_code || fields.branchCode,
      customer.tax_id || '',
      null,
      null,
      null,
      null,
    ],
  );
}

function salesReturnPaymentSummary(fields, totals) {
  const transferRows = fields.paymentDetails.filter((row) => (
    row.payType === '0' || row.payType === 'transfer' || row.docType === '1'
  ));
  const couponRows = fields.paymentDetails.filter((row) => (
    row.payType === '9' || row.payType === 'coupon' || row.docType === '9'
  ));

  const transferDetailAmount = roundMoney(transferRows.reduce((sum, row) => sum + row.amount, 0));
  const couponDetailAmount = roundMoney(couponRows.reduce((sum, row) => sum + row.amount, 0));
  const transferAmount = roundMoney(transferRows.length ? transferDetailAmount : fields.transferAmount);
  const couponAmount = roundMoney(couponRows.length ? couponDetailAmount : fields.couponAmount);
  const cashAmount = roundMoney(fields.cashAmount);
  const paymentTotal = roundMoney(cashAmount + transferAmount + couponAmount);
  const errors = [];

  if (fields.inquiryType === 0) {
    if (paymentTotal > 0) errors.push('credit return must not include cashbook payment');
    return {
      cashAmount: 0,
      transferAmount: 0,
      couponAmount: 0,
      paymentTotal: 0,
      transferRows: [],
      couponRows: [],
      errors,
    };
  }

  if (paymentTotal <= 0) errors.push('cash return payment is required');
  if (Math.abs(paymentTotal - totals.totalAmount) > 0.01) {
    errors.push(`cash return payment total must equal total_amount ${totals.totalAmount}`);
  }
  if (transferRows.length && fields.transferAmount > 0 && Math.abs(transferDetailAmount - fields.transferAmount) > 0.01) {
    errors.push('transfer payment detail total does not match tranfer_amount');
  }
  if (couponRows.length && fields.couponAmount > 0 && Math.abs(couponDetailAmount - fields.couponAmount) > 0.01) {
    errors.push('coupon payment detail total does not match coupon_amount');
  }
  for (const [index, row] of transferRows.entries()) {
    if (row.amount <= 0) errors.push(`invalid transfer payment amount: row ${index + 1}`);
    if (!row.transNumber && !row.passBookCode) errors.push(`transfer pass book is required: row ${index + 1}`);
  }
  for (const [index, row] of couponRows.entries()) {
    if (row.amount <= 0) errors.push(`invalid coupon payment amount: row ${index + 1}`);
  }

  return {
    cashAmount,
    transferAmount,
    couponAmount,
    paymentTotal,
    transferRows,
    couponRows,
    errors,
  };
}

async function tableColumnSet(client, tableName) {
  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1`,
    [tableName],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

async function insertGeneratedSalesReturnCoupon(client, docNo, fields, amount) {
  if (amount <= 0) return null;
  const columns = await tableColumnSet(client, 'coupon_list');
  for (const required of ['number', 'amount', 'balance_amount']) {
    if (!columns.has(required)) throw new Error(`coupon_list.${required} is required`);
  }

  await client.query('DELETE FROM coupon_list WHERE number = $1', [docNo]);

  const valuesByColumn = {
    is_lock_record: 1,
    number: docNo,
    amount,
    date: fields.docDate,
    date_expire: endOfMonth(fields.docDate),
    balance_amount: amount,
    remark: 'Coupon from CN',
    single_use: 1,
    coupon_type: 0,
  };
  const insertColumns = Object.keys(valuesByColumn).filter((column) => columns.has(column));
  const values = insertColumns.map((column) => valuesByColumn[column]);
  const placeholders = insertColumns.map((_, index) => `$${index + 1}`);
  await client.query(
    `INSERT INTO coupon_list (${insertColumns.map(quoteIdent).join(', ')})
     VALUES (${placeholders.join(', ')})`,
    values,
  );
  return docNo;
}

async function insertSalesReturnCashbook(client, docNo, fields, totals, payment) {
  if (fields.inquiryType !== 1) return;

  await insertGeneratedSalesReturnCoupon(client, docNo, fields, payment.couponAmount);

  await client.query(
    `INSERT INTO cb_trans
      (trans_type, trans_flag, doc_no, doc_date, doc_time, ap_ar_code, pay_type,
       doc_format_code, total_amount, total_net_amount, cash_amount, tranfer_amount,
       coupon_amount, total_amount_pay, pay_cash_amount, money_change)
     VALUES
      (2, $1, $2, $3::date, $4, $5, 2,
       $6, $7, $7, $8, $9,
       $10, $11, 0, 0)`,
    [
      SALES_RETURN_TRANS_FLAG,
      docNo,
      fields.docDate,
      fields.docTime,
      fields.custCode,
      fields.docFormatCode,
      totals.totalAmount,
      payment.cashAmount,
      payment.transferAmount,
      payment.couponAmount,
      payment.paymentTotal,
    ],
  );

  let lineNumber = 0;
  for (const row of payment.transferRows) {
    const transNumber = row.transNumber || row.passBookCode;
    await client.query(
      `INSERT INTO cb_trans_detail
        (trans_type, trans_flag, doc_no, doc_date, doc_time, trans_number,
         bank_code, bank_branch, amount, sum_amount, balance_amount, doc_type, ap_ar_code,
         trans_number_type, ap_ar_type, ref1, line_number, status, last_status)
       VALUES
        (2, $1, $2, $3::date, $4, $5,
         $6, $7, $8, 0, 0, '1', '',
         0, 0, '', $9, 0, 0)`,
      [
        SALES_RETURN_TRANS_FLAG,
        docNo,
        fields.docDate,
        fields.docTime,
        transNumber,
        row.bankCode,
        row.bankBranch,
        row.amount,
        lineNumber,
      ],
    );
    lineNumber += 1;
  }

  if (payment.couponAmount > 0) {
    await client.query(
      `INSERT INTO cb_trans_detail
        (trans_type, trans_flag, doc_no, doc_date, doc_time, trans_number,
         bank_code, bank_branch, amount, sum_amount, balance_amount, doc_type, ap_ar_code,
         trans_number_type, ap_ar_type, ref1, remark, line_number, status, last_status)
       VALUES
        (2, $1, $2, $3::date, $4, $2,
         '', '', $5, 0, $5, '9', '',
         0, 0, '', 'Coupon from CN', $6, 0, 0)`,
      [
        SALES_RETURN_TRANS_FLAG,
        docNo,
        fields.docDate,
        fields.docTime,
        payment.couponAmount,
        lineNumber,
      ],
    );
  }
}

async function refreshInventoryBalanceQty(client, itemCodes = []) {
  for (const itemCode of uniqueTexts(itemCodes)) {
    const result = await client.query(
      `SELECT COALESCE(SUM(balance_qty), 0) AS new_balance
       FROM sml_ic_function_stock_balance_warehouse_location('NOW()', $1, '', '')`,
      [itemCode],
    );
    await client.query(
      'UPDATE ic_inventory SET balance_qty = $1 WHERE code = $2',
      [toNumber(result.rows[0]?.new_balance), itemCode],
    );
  }
}

async function insertSalesReturnProcessAndLog(client, docNo, fields, totals, lines, docRef) {
  const itemCodes = uniqueTexts(lines.map((line) => line.item_code));
  if (itemCodes.length) {
    await client.query(
      `DELETE FROM process
       WHERE process_name = 'IC'
         AND wherein = ANY($1::text[])`,
      [itemCodes],
    );
    await client.query(
      `INSERT INTO process (process_name, wherein)
       SELECT DISTINCT 'IC', code
       FROM unnest($1::text[]) AS codes(code)`,
      [itemCodes],
    );
    await refreshInventoryBalanceQty(client, itemCodes);
  }

  const data1 = logXml({
    doc_date: fields.docDate,
    doc_time: fields.docTime,
    doc_no: docNo,
    doc_format_code: fields.docFormatCode,
    cust_code: fields.custCode,
    doc_ref: docRef.docNo,
    doc_ref_date: docRef.docDate,
    inquiry_type: fields.inquiryType,
    vat_type: fields.vatType,
    tax_doc_date: fields.taxDocDate,
    tax_doc_no: fields.taxDocNo || docNo,
  });
  await client.query(
    `INSERT INTO logs
       (function_code, data1, user_code, date_time, screen_code, guid,
        doc_date, doc_no, doc_amount, function_type, menu_name, doc_qty)
     VALUES (1, $1, $2, NOW(), $3, $4, $5::date, $6, $7, 2, $8, $9)`,
    [
      data1,
      fields.creatorCode,
      SALES_RETURN_TRANS_FLAG,
      crypto.randomUUID().replace(/-/g, ''),
      fields.docDate,
      docNo,
      totals.totalAmount,
      'รับคืนสินค้า/ลดหนี้',
      lines.length,
    ],
  );
}

function summarizeSalesReturn(lines) {
  const totals = {
    totalValue: 0,
    totalBeforeVat: 0,
    totalVatValue: 0,
    totalAfterVat: 0,
    totalExceptVat: 0,
    totalAmount: 0,
  };
  for (const line of lines) {
    totals.totalValue += line.sumAmount;
    totals.totalBeforeVat += line.beforeVat;
    totals.totalVatValue += line.vatValue;
    totals.totalAfterVat += line.afterVat;
    totals.totalExceptVat += line.exceptVat;
    totals.totalAmount += line.afterVat;
  }
  for (const key of Object.keys(totals)) totals[key] = roundMoney(totals[key]);
  return totals;
}

router.post('/createSalesReturnDoc', async (req, res) => {
  const payload = normalizeSalesReturnPayload(req.body);
  const fields = normalizedSalesReturnFields(payload);
  const validationErrors = validateSalesReturnFields(fields);
  if (validationErrors.length) {
    return res.status(400).json({ success: false, msg: validationErrors.join('; ') });
  }

  const client = await pool.connect();
  try {
    await requireSalesReturnCreatePermission(client, fields.creatorCode);
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ST:${fields.docFormatCode}:${fields.docDate}`]);
      const resolved = await resolveDocumentNo(client, {
        screenCode: SALES_RETURN_SCREEN_CODE,
        docFormatCode: fields.docFormatCode,
        docDate: fields.docDate,
        transFlag: SALES_RETURN_TRANS_FLAG,
      });
      const docNo = resolved.doc_no;
      fields.docFormatCode = resolved.doc_format_code;

      const customer = await customerTaxInfo(client, fields.custCode, fields.branchCode);
      const lines = await lockAndBuildReturnLines(client, fields);
      const firstLine = lines[0];
      const docRef = {
        docNo: firstLine.sale_doc_no,
        docDate: normalizeDate(firstLine.sale_doc_date),
        vatNo: firstLine.sale_doc_no,
      };
      const totals = summarizeSalesReturn(lines);
      const payment = salesReturnPaymentSummary(fields, totals);
      if (payment.errors.length) throw new Error(payment.errors.join('; '));

      await insertSalesReturnHeader(client, docNo, fields, totals, docRef);
      await insertSalesReturnDetails(client, docNo, fields, lines);
      await insertSalesReturnRefs(client, docNo, fields, lines);
      await insertSalesReturnVat(client, docNo, fields, totals, customer, docRef);
      await insertSalesReturnCashbook(client, docNo, fields, totals, payment);
      await insertSalesReturnProcessAndLog(client, docNo, fields, totals, lines, docRef);

      await client.query('COMMIT');
      return res.json({
        success: true,
        msg: 'success',
        doc_no: docNo,
        doc_format_code: fields.docFormatCode,
        item_count: lines.length,
        total_amount: totals.totalAmount,
        payment_pending: false,
        payment: {
          cash_amount: payment.cashAmount,
          tranfer_amount: payment.transferAmount,
          coupon_amount: payment.couponAmount,
          total_amount_pay: payment.paymentTotal,
        },
      });
    } catch (ex) {
      await client.query('ROLLBACK');
      throw ex;
    }
  } catch (ex) {
    return res.status(400).json({ success: false, msg: ex.message });
  } finally {
    client.release();
  }
});

module.exports = router;

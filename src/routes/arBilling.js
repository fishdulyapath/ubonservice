const express = require('express');
const router = express.Router();
const { withTransaction, query } = require('../db');
const { resolveDocumentNo } = require('../utils/docFormat');
const { getEmployeePermissions } = require('../utils/permissions');
const { renderSalePrintHtml } = require('../utils/salePrintRenderer');

const TRANS_TYPE = 2;
const TRANS_FLAG = 235;
const CANCEL_TRANS_FLAG = 236;
const SCREEN_CODE = 'ED';
const DOC_TABLE = 'ap_ar_trans';
const BILLABLE_FLAGS = [44, 46, 48, 93, 95, 97, 99, 101, 103];
const SALE_FLAGS = [44];
const DEBIT_NOTE_FLAGS = [46, 93, 95, 99, 101];
const CREDIT_NOTE_FLAGS = [48, 97, 103];
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

function isNonZeroAmount(value) {
  return Math.abs(roundMoney(value)) > 0.0001;
}

function isSameDirectionAmount(amount, balance) {
  const amountValue = roundMoney(amount);
  const balanceValue = roundMoney(balance);
  if (!isNonZeroAmount(amountValue) || !isNonZeroAmount(balanceValue)) return false;
  return (amountValue > 0 && balanceValue > 0) || (amountValue < 0 && balanceValue < 0);
}

function amountExceedsBalance(amount, balance) {
  if (!isSameDirectionAmount(amount, balance)) return true;
  return Math.abs(roundMoney(amount)) > Math.abs(roundMoney(balance)) + 0.01;
}

function boolFlag(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

async function loadArBillingProfile(queryFn, userCode = '') {
  const profile = {
    branchStatus: 0,
    arBillInform: false,
    filterPayBill: false,
    showBranchDocOnly: false,
    useCreditPayBillCalc: false,
    userCanChangeBranch: false,
    userBranchCode: '',
  };

  try {
    const companyRes = await queryFn(
      `SELECT COALESCE(branch_status,0) AS branch_status
       FROM erp_company_profile
       ORDER BY roworder
       LIMIT 1`,
    );
    profile.branchStatus = toInt(companyRes.rows[0]?.branch_status);
  } catch {
    profile.branchStatus = 0;
  }

  try {
    const optionRes = await queryFn(
      `SELECT COALESCE(ar_bill_inform,0) AS ar_bill_inform,
              COALESCE(filter_pay_bill,0) AS filter_pay_bill,
              COALESCE(show_branch_doc_only,0) AS show_branch_doc_only,
              COALESCE(use_credit_pay_bill_calc,0) AS use_credit_pay_bill_calc
       FROM erp_option
       LIMIT 1`,
    );
    const row = optionRes.rows[0] || {};
    profile.arBillInform = boolFlag(row.ar_bill_inform);
    profile.filterPayBill = boolFlag(row.filter_pay_bill);
    profile.showBranchDocOnly = boolFlag(row.show_branch_doc_only);
    profile.useCreditPayBillCalc = boolFlag(row.use_credit_pay_bill_calc);
  } catch {
    // Keep C#-compatible defaults when the option table/columns are absent.
  }

  const code = safeText(userCode);
  if (code) {
    try {
      const userRes = await queryFn(
        `SELECT COALESCE(change_branch_code,0) AS change_branch_code,
                COALESCE(branch_code,'') AS branch_code
         FROM erp_user
         WHERE UPPER(code) = UPPER($1)
         LIMIT 1`,
        [code],
      );
      const row = userRes.rows[0] || {};
      profile.userCanChangeBranch = boolFlag(row.change_branch_code);
      profile.userBranchCode = safeText(row.branch_code);
    } catch {
      profile.userCanChangeBranch = false;
    }
  }

  return profile;
}

function billTypeNameSql(alias = 'doc_type') {
  return `CASE ${alias}
    WHEN 44 THEN 'ขายเชื่อ'
    WHEN 46 THEN 'เพิ่มหนี้'
    WHEN 48 THEN 'ลดหนี้'
    WHEN 93 THEN 'ตั้งหนี้ยกมา'
    WHEN 95 THEN 'เพิ่มหนี้ยกมา'
    WHEN 97 THEN 'ลดหนี้ยกมา'
    WHEN 99 THEN 'ตั้งหนี้อื่น'
    WHEN 101 THEN 'เพิ่มหนี้อื่น'
    WHEN 103 THEN 'ลดหนี้อื่น'
    ELSE ${alias}::text
  END`;
}

function arBalanceDocCte({ filterPayBill = false, includeSearch = false, includeBranch = false, includeDocNos = false, useCreditPayBillCalc = false }) {
  const searchSql = includeSearch
    ? `AND (
         temp3.doc_no ILIKE $search
         OR COALESCE(temp3.ref_doc_no,'') ILIKE $search
         OR COALESCE(temp3.tax_doc_no,'') ILIKE $search
         OR COALESCE(temp3.ship_code,'') ILIKE $search
       )`
    : '';
  const branchSql = includeBranch ? `AND COALESCE(temp3.branch_code,'') = $branch` : '';
  const docNosSql = includeDocNos ? `AND temp3.doc_no = ANY($docNos::text[])` : '';
  const filterPayBillSql = filterPayBill
    ? `AND NOT EXISTS (
         SELECT 1
         FROM ap_ar_trans_detail d
         WHERE d.billing_no = temp3.doc_no
           AND d.bill_type = temp3.bill_type
           AND COALESCE(d.last_status,0) = 0
           AND d.trans_flag = ${TRANS_FLAG}
       )`
    : '';
  const dueDateSql = useCreditPayBillCalc ? `AND temp3.due_date = $dueDate::date` : '';

  return `
    WITH temp3 AS (
      SELECT temp2.*,
             GREATEST(($docDate::date - temp2.due_date)::int, 0) AS due_day,
             (${billTypeNameSql('temp2.bill_type')}) AS bill_type_name,
             (
               SELECT ship_code
               FROM ic_trans_shipment s
               WHERE s.doc_no = temp2.doc_no
                 AND s.trans_flag = temp2.bill_type
               LIMIT 1
             ) AS ship_code
      FROM (
        SELECT t.cust_code,
               t.doc_no,
               t.doc_date,
               CASE WHEN t.trans_flag IN (93,95,97) THEN COALESCE(t.due_date, t.doc_date)
                    ELSE COALESCE(t.credit_date, t.due_date, t.doc_date)
               END AS due_date,
               t.trans_flag AS bill_type,
               COALESCE(t.used_status,0) AS used_status,
               COALESCE(t.doc_ref,'') AS ref_doc_no,
               t.doc_ref_date AS ref_doc_date,
               COALESCE(t.tax_doc_no,'') AS tax_doc_no,
               t.tax_doc_date AS tax_doc_date,
               COALESCE(t.credit_day,0) AS credit_day,
               COALESCE(t.total_amount,0) AS sum_debt_amount,
               COALESCE(t.total_amount,0) - COALESCE((
                 SELECT SUM(COALESCE(d.sum_pay_money,0) + COALESCE(d.lost_profit_exchange_amount,0))
                 FROM ap_ar_trans_detail d
                 WHERE COALESCE(d.last_status,0) = 0
                   AND d.trans_flag IN (239)
                   AND d.billing_no = t.doc_no
                   AND d.bill_type = t.trans_flag
               ),0) AS balance_ref,
               CASE WHEN COALESCE(t.currency_code,'') = '' THEN COALESCE(t.total_amount,0) ELSE COALESCE(t.total_amount_2,t.total_amount,0) END AS sum_debt_amount_2,
               COALESCE(t.currency_code,'') AS currency_code,
               CASE WHEN COALESCE(t.currency_code,'') = '' THEN 1 ELSE COALESCE(t.exchange_rate,1) END AS exchange_rate,
               CASE WHEN COALESCE(t.currency_code,'') = '' THEN
                 COALESCE(t.total_amount,0) - COALESCE((
                   SELECT SUM(COALESCE(d.sum_pay_money_2,0))
                   FROM ap_ar_trans_detail d
                   WHERE COALESCE(d.last_status,0) = 0
                     AND d.trans_flag IN (239,19)
                     AND d.billing_no = t.doc_no
                     AND d.bill_type = t.trans_flag
                 ),0)
               ELSE
                 COALESCE(t.total_amount_2,t.total_amount,0) - COALESCE((
                   SELECT SUM(COALESCE(d.sum_pay_money_2,0))
                   FROM ap_ar_trans_detail d
                   WHERE COALESCE(d.last_status,0) = 0
                     AND d.trans_flag IN (239,19)
                     AND d.billing_no = t.doc_no
                     AND d.bill_type = t.trans_flag
                 ),0)
               END AS balance_ref_2,
               COALESCE(t.branch_code,'') AS branch_code,
               COALESCE(t.remark,'') AS source_remark,
               COALESCE(t.vat_rate,0) AS vat_rate
        FROM ic_trans t
        WHERE COALESCE(t.last_status,0) = 0
          AND t.trans_flag = ANY($saleFlags::int[])
          AND COALESCE(t.inquiry_type,0) IN (0,2)
          AND t.cust_code = $custCode
          AND t.doc_date <= $docDate::date
          AND COALESCE(t.is_cancel,0) = 0
          AND COALESCE(t.is_doc_copy,0) <> 1

        UNION ALL

        SELECT t.cust_code,
               t.doc_no,
               t.doc_date,
               CASE WHEN t.trans_flag IN (93,95,97) THEN COALESCE(t.due_date, t.doc_date)
                    ELSE COALESCE(t.credit_date, t.due_date, t.doc_date)
               END AS due_date,
               t.trans_flag AS bill_type,
               COALESCE(t.used_status,0) AS used_status,
               CASE WHEN t.trans_flag IN (14,81,83,85,93,95,97,315,260) THEN COALESCE(t.doc_ref,'') ELSE '' END AS ref_doc_no,
               CASE WHEN t.trans_flag IN (14,81,83,85,93,95,97,315,260) THEN t.doc_ref_date ELSE NULL END AS ref_doc_date,
               COALESCE(t.tax_doc_no,'') AS tax_doc_no,
               t.tax_doc_date AS tax_doc_date,
               COALESCE(t.credit_day,0) AS credit_day,
               COALESCE(t.total_amount,0) AS sum_debt_amount,
               COALESCE(t.total_amount,0) - COALESCE((
                 SELECT SUM(COALESCE(d.sum_pay_money,0))
                 FROM ap_ar_trans_detail d
                 WHERE COALESCE(d.last_status,0) = 0
                   AND d.trans_flag IN (239)
                   AND d.billing_no = t.doc_no
                   AND d.bill_type = t.trans_flag
               ),0) AS balance_ref,
               CASE WHEN COALESCE(t.currency_code,'') = '' THEN COALESCE(t.total_amount,0) ELSE COALESCE(t.total_amount_2,t.total_amount,0) END AS sum_debt_amount_2,
               COALESCE(t.currency_code,'') AS currency_code,
               CASE WHEN COALESCE(t.currency_code,'') = '' THEN 1 ELSE COALESCE(t.exchange_rate,1) END AS exchange_rate,
               CASE WHEN COALESCE(t.currency_code,'') = '' THEN
                 COALESCE(t.total_amount,0) - COALESCE((
                   SELECT SUM(COALESCE(d.sum_pay_money_2,0))
                   FROM ap_ar_trans_detail d
                   WHERE COALESCE(d.last_status,0) = 0
                     AND d.trans_flag IN (239,19)
                     AND d.billing_no = t.doc_no
                     AND d.bill_type = t.trans_flag
                 ),0)
               ELSE
                 COALESCE(t.total_amount_2,t.total_amount,0) - COALESCE((
                   SELECT SUM(COALESCE(d.sum_pay_money_2,0))
                   FROM ap_ar_trans_detail d
                   WHERE COALESCE(d.last_status,0) = 0
                     AND d.trans_flag IN (239,19)
                     AND d.billing_no = t.doc_no
                     AND d.bill_type = t.trans_flag
                 ),0)
               END AS balance_ref_2,
               COALESCE(t.branch_code,'') AS branch_code,
               COALESCE(t.remark,'') AS source_remark,
               COALESCE(t.vat_rate,0) AS vat_rate
        FROM ic_trans t
        WHERE COALESCE(t.last_status,0) = 0
          AND t.trans_flag = ANY($debitFlags::int[])
          AND t.cust_code = $custCode
          AND t.doc_date <= $docDate::date
          AND COALESCE(t.is_cancel,0) = 0
          AND COALESCE(t.is_doc_copy,0) <> 1

        UNION ALL

        SELECT t.cust_code,
               t.doc_no,
               t.doc_date,
               CASE WHEN t.trans_flag IN (93,95,97) THEN COALESCE(t.due_date, t.doc_date)
                    ELSE COALESCE(t.credit_date, t.due_date, t.doc_date)
               END AS due_date,
               t.trans_flag AS bill_type,
               COALESCE(t.used_status,0) AS used_status,
               CASE WHEN t.trans_flag IN (16,81,83,85,93,95,97,315,260) THEN COALESCE(t.doc_ref,'') ELSE '' END AS ref_doc_no,
               CASE WHEN t.trans_flag IN (16,81,83,85,93,95,97,315,260) THEN t.doc_ref_date ELSE NULL END AS ref_doc_date,
               COALESCE(t.tax_doc_no,'') AS tax_doc_no,
               t.tax_doc_date AS tax_doc_date,
               COALESCE(t.credit_day,0) AS credit_day,
               -1 * COALESCE(t.total_amount,0) AS sum_debt_amount,
               -1 * (COALESCE(t.total_amount,0) + COALESCE((
                 SELECT SUM(COALESCE(d.sum_pay_money,0))
                 FROM ap_ar_trans_detail d
                 WHERE COALESCE(d.last_status,0) = 0
                   AND d.trans_flag IN (239)
                   AND d.billing_no = t.doc_no
                   AND d.bill_type = t.trans_flag
               ),0)) AS balance_ref,
               -1 * (CASE WHEN COALESCE(t.currency_code,'') = '' THEN COALESCE(t.total_amount,0) ELSE COALESCE(t.total_amount_2,t.total_amount,0) END) AS sum_debt_amount_2,
               COALESCE(t.currency_code,'') AS currency_code,
               CASE WHEN COALESCE(t.currency_code,'') = '' THEN 1 ELSE COALESCE(t.exchange_rate,1) END AS exchange_rate,
               CASE WHEN COALESCE(t.currency_code,'') = '' THEN
                 -1 * (COALESCE(t.total_amount,0) + COALESCE((
                   SELECT SUM(COALESCE(d.sum_pay_money_2,0))
                   FROM ap_ar_trans_detail d
                   WHERE COALESCE(d.last_status,0) = 0
                     AND d.trans_flag IN (239)
                     AND d.billing_no = t.doc_no
                     AND d.bill_type = t.trans_flag
                 ),0))
               ELSE
                 -1 * (COALESCE(t.total_amount_2,t.total_amount,0) + COALESCE((
                   SELECT SUM(COALESCE(d.sum_pay_money_2,0))
                   FROM ap_ar_trans_detail d
                   WHERE COALESCE(d.last_status,0) = 0
                     AND d.trans_flag IN (239)
                     AND d.billing_no = t.doc_no
                     AND d.bill_type = t.trans_flag
                 ),0))
               END AS balance_ref_2,
               COALESCE(t.branch_code,'') AS branch_code,
               COALESCE(t.remark,'') AS source_remark,
               COALESCE(t.vat_rate,0) AS vat_rate
        FROM ic_trans t
        WHERE COALESCE(t.last_status,0) = 0
          AND (
            (t.trans_flag = 48 AND COALESCE(t.inquiry_type,0) IN (0,2,4))
            OR (t.trans_flag <> 48 AND t.trans_flag = ANY($creditFlags::int[]))
          )
          AND t.cust_code = $custCode
          AND t.doc_date <= $docDate::date
          AND COALESCE(t.is_cancel,0) = 0
          AND COALESCE(t.is_doc_copy,0) <> 1
      ) temp2
    ),
    ar_balance_docs AS (
      SELECT temp3.*,
             EXISTS (
               SELECT 1
               FROM ap_ar_trans_detail d
               WHERE d.billing_no = temp3.doc_no
                 AND COALESCE(d.last_status,0) = 0
                 AND d.trans_flag = ${TRANS_FLAG}
             ) AS already_billed
      FROM temp3
      WHERE ABS(ROUND(COALESCE(temp3.balance_ref,0), 2)) > 0.0001
        ${docNosSql}
        ${searchSql}
        ${branchSql}
        ${filterPayBillSql}
        ${dueDateSql}
    )`;
}

function withArBalanceParams(sql, params) {
  return sql
    .replace(/\$custCode/g, `$${params.custCode}`)
    .replace(/\$docDate/g, `$${params.docDate}`)
    .replace(/\$saleFlags/g, `$${params.saleFlags}`)
    .replace(/\$debitFlags/g, `$${params.debitFlags}`)
    .replace(/\$creditFlags/g, `$${params.creditFlags}`)
    .replace(/\$search/g, `$${params.search}`)
    .replace(/\$branch/g, `$${params.branch}`)
    .replace(/\$docNos/g, `$${params.docNos}`)
    .replace(/\$dueDate/g, `$${params.dueDate}`);
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
    .filter((row) => row.billing_no && row.bill_type && isNonZeroAmount(row.sum_pay_money));
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

async function loadArBillingPrintDocument(docNo) {
  const [headerRes, companyRes, detailsRes] = await Promise.all([
    query(
      `SELECT t.*,
          COALESCE(NULLIF(t.total_net_value,0), ds.bill_total, 0) AS total_value,
          COALESCE(NULLIF(t.total_net_value,0), ds.bill_total, 0) AS total_amount,
          COALESCE(NULLIF(t.total_net_value,0), ds.bill_total, 0) AS total_net_value,
          COALESCE(NULLIF(t.total_net_value,0), ds.bill_total, 0) AS total_net_amount,
          COALESCE(NULLIF(t.total_net_value,0), ds.bill_total, 0) AS total_after_discount,
          COALESCE(NULLIF(t.total_pay_money,0), ds.bill_total, 0) AS total_pay_money,
          COALESCE(NULLIF(t.total_debt_value,0), ds.debt_total, 0) AS total_debt_value,
          COALESCE(NULLIF(t.total_debt_value,0), ds.debt_total, 0) AS total_debt_amount,
          COALESCE(ds.bill_total,0) AS sum_pay_money,
          COALESCE(ds.bill_total,0) AS bill_total,
          COALESCE(ds.debt_total,0) AS debt_total,
          COALESCE(ds.balance_total,0) AS balance_total,
          COALESCE(ds.bill_count,0) AS bill_count,
          COALESCE(ds.bill_count,0) AS total_bill_count,
          COALESCE(ds.bill_count,0) AS detail_count,
          COALESCE(ds.bill_count,0) AS doc_count,
          COALESCE(ds.bill_count,0) AS count_bill,
          COALESCE(df.name_1,'') AS doc_format_name,
          COALESCE(df.form_code,'') AS form_code,
          COALESCE(ar.name_1,'') AS name_1,
          COALESCE(ar.name_1,'') AS cust_name,
          COALESCE(ar.name_1,'') AS ar_name,
          COALESCE(ar.name_1,'') AS customer_name,
          COALESCE(ar.address,'') AS address,
          COALESCE(ar.address,'') AS cust_address,
          COALESCE(ar.address,'') AS ar_address,
          COALESCE(ar.address,'') AS customer_address,
          COALESCE(ar.telephone,'') AS telephone,
          COALESCE(ar.telephone,'') AS phone,
          COALESCE(ar.telephone,'') AS cust_telephone,
          COALESCE(ar.fax,'') AS fax,
          COALESCE(ar.fax,'') AS cust_fax,
          COALESCE(cd.tax_id,'') AS tax_id,
          COALESCE(u.name_1, t.sale_code, t.creator_code, '') AS sale_name
       FROM ap_ar_trans t
       LEFT JOIN (
         SELECT doc_no,
                COUNT(*)::int AS bill_count,
                COALESCE(SUM(sum_pay_money),0) AS bill_total,
                COALESCE(SUM(sum_debt_amount),0) AS debt_total,
                COALESCE(SUM(balance_ref),0) AS balance_total
         FROM ap_ar_trans_detail
         WHERE trans_flag = $3
         GROUP BY doc_no
       ) ds ON ds.doc_no = t.doc_no
       LEFT JOIN erp_doc_format df ON df.screen_code = $2 AND df.code = t.doc_format_code
       LEFT JOIN ar_customer ar ON ar.code = t.cust_code
       LEFT JOIN ar_customer_detail cd ON cd.ar_code = t.cust_code
       LEFT JOIN erp_user u ON UPPER(u.code) = UPPER(COALESCE(NULLIF(t.sale_code,''), t.creator_code))
       WHERE t.trans_flag = $3 AND t.doc_no = $1
       LIMIT 1`,
      [docNo, SCREEN_CODE, TRANS_FLAG],
    ),
    query('SELECT * FROM erp_company_profile ORDER BY roworder LIMIT 1'),
    query(
      `SELECT
          line_number,
          billing_no,
          billing_no AS doc_no,
          billing_no AS item_code,
          billing_no AS item_name,
          billing_date AS doc_date,
          bill_type,
          bill_type_name,
          bill_type_name AS doc_type_name,
          bill_type_name AS trans_flag_name,
          ref_doc_no,
          ref_doc_no AS doc_ref,
          ref_doc_date,
          ref_doc_date AS doc_ref_date,
          '' AS unit_code,
          '' AS unit_name,
          1 AS qty,
          sum_debt_amount AS price,
          sum_debt_amount AS sum_amount,
          sum_debt_amount AS amount,
          sum_debt_amount,
          sum_debt_amount AS debt_amount,
          sum_debt_amount AS total_amount,
          sum_debt_amount AS total_value,
          balance_ref,
          balance_ref AS balance_amount,
          balance_ref AS ar_balance,
          sum_pay_money,
          sum_pay_money AS pay_amount,
          sum_pay_money AS final_amount,
          sum_pay_money AS net_amount,
          billing_date,
          due_date,
          remark
       FROM (
         SELECT d.*, CASE d.bill_type
                    WHEN 44 THEN 'ขายเชื่อ'
                    WHEN 46 THEN 'เพิ่มหนี้'
                    WHEN 48 THEN 'ลดหนี้'
                    WHEN 93 THEN 'ตั้งหนี้ยกมา'
                    WHEN 95 THEN 'เพิ่มหนี้ยกมา'
                    WHEN 97 THEN 'ลดหนี้ยกมา'
                    WHEN 99 THEN 'ตั้งหนี้อื่น'
                    WHEN 101 THEN 'เพิ่มหนี้อื่น'
                    WHEN 103 THEN 'ลดหนี้อื่น'
                    ELSE d.bill_type::text
                  END AS bill_type_name
         FROM ap_ar_trans_detail d
         WHERE d.trans_flag = $2 AND d.doc_no = $1
       ) x
       ORDER BY line_number, roworder`,
      [docNo, TRANS_FLAG],
    ),
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
    payments: [],
  };
}

async function loadPrintFormOptions(docNo) {
  const docRes = await query(
    `SELECT t.doc_no, COALESCE(t.doc_format_code,'') AS doc_format_code,
        COALESCE(df.name_1,'') AS doc_format_name,
        COALESCE(df.form_code,'') AS form_code
     FROM ap_ar_trans t
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

router.get('/ar-billing/sales-users', async (req, res) => {
  const search = safeText(req.query.search);
  const params = [];
  let where = '1=1';
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (code ILIKE $${params.length} OR COALESCE(name_1,'') ILIKE $${params.length})`;
  }
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, AR_BILLING_VIEW_PERMISSION);
    const result = await query(
      `SELECT code, COALESCE(name_1,'') AS name_1
       FROM erp_user
       WHERE ${where}
       ORDER BY code
       LIMIT 50`,
      params,
    );
    return res.json({ success: true, data: result.rows });
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
  const dueDate = normalizeDate(req.query.due_date, docDate);
  const branchCodeFromRequest = safeText(req.query.branch_code);
  const userCode = req.query.user_code || req.query.emp_code;
  if (!custCode) return res.json({ success: true, data: [] });
  try {
    await assertPermission(query, userCode, AR_BILLING_VIEW_PERMISSION);
    const profile = await loadArBillingProfile(query, userCode);
    const branchCode = branchCodeFromRequest || profile.userBranchCode;
    const includeBranch = profile.branchStatus === 1 && profile.showBranchDocOnly && !profile.userCanChangeBranch && !!branchCode;
    const params = [];
    const idx = {
      custCode: params.push(custCode),
      docDate: params.push(docDate),
      saleFlags: params.push(SALE_FLAGS),
      debitFlags: params.push(DEBIT_NOTE_FLAGS),
      creditFlags: params.push(CREDIT_NOTE_FLAGS),
    };
    if (search) idx.search = params.push(`%${search}%`);
    if (includeBranch) idx.branch = params.push(branchCode);
    if (profile.useCreditPayBillCalc) idx.dueDate = params.push(dueDate);
    const cte = withArBalanceParams(
      arBalanceDocCte({
        filterPayBill: profile.filterPayBill,
        includeSearch: !!search,
        includeBranch,
        useCreditPayBillCalc: profile.useCreditPayBillCalc,
      }),
      idx,
    );
    const result = await query(
      `${cte}
       SELECT doc_no, doc_date, bill_type, bill_type_name, ref_doc_no, ref_doc_date,
              tax_doc_no, tax_doc_date, due_date, due_day, credit_day,
              sum_debt_amount, ROUND(balance_ref,2) AS balance_ref,
              sum_debt_amount_2, ROUND(balance_ref_2,2) AS balance_ref_2,
              currency_code, exchange_rate, vat_rate, branch_code, ship_code,
              source_remark, already_billed
       FROM ar_balance_docs
       ORDER BY due_date, doc_date, doc_no
       LIMIT 200`,
      params,
    );
    return res.json({
      success: true,
      data: result.rows.map((row) => ({
        ...row,
        ar_bill_blocked: profile.arBillInform && boolFlag(row.already_billed),
      })),
    });
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
                  WHEN 99 THEN 'ตั้งหนี้อื่น'
                  WHEN 101 THEN 'เพิ่มหนี้อื่น'
                  WHEN 103 THEN 'ลดหนี้อื่น'
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

router.get('/ar-billing/print-forms', async (req, res) => {
  const docNo = safeText(req.query.doc_no);
  if (!docNo) return res.status(400).json({ success: false, msg: 'doc_no is required' });
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, AR_BILLING_VIEW_PERMISSION);
    const options = await loadPrintFormOptions(docNo);
    if (!options) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({ success: true, data: options });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/ar-billing/print/render', async (req, res) => {
  const { doc_no = '', formcodes = '', auto_print = '1', log_print, user_code = '' } = req.query;
  const docNo = safeText(doc_no);
  if (!docNo) return res.status(400).type('text/plain').send('doc_no is required');

  try {
    await assertPermission(query, user_code || req.query.emp_code, AR_BILLING_VIEW_PERMISSION);
    const [options, printData] = await Promise.all([
      loadPrintFormOptions(docNo),
      loadArBillingPrintDocument(docNo),
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
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('html').send(html);
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).type('text/plain').send(ex.message);
    return res.status(500).type('text/plain').send(ex.message);
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
      const profile = await loadArBillingProfile(client.query.bind(client), requestUserCode);

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
      const detailTotals = new Map();
      for (const row of details) {
        const key = `${row.billing_no}|${row.bill_type}`;
        detailTotals.set(key, roundMoney((detailTotals.get(key) || 0) + row.sum_pay_money));
      }
      if (profile.arBillInform) {
        const duplicated = await client.query(
          `SELECT DISTINCT billing_no
           FROM ap_ar_trans_detail
           WHERE billing_no = ANY($1::text[])
             AND trans_flag = $2
             AND COALESCE(last_status,0) = 0
           LIMIT 10`,
          [invoiceNos, TRANS_FLAG],
        );
        if (duplicated.rows.length) {
          throw new Error(`billing document already used: ${duplicated.rows.map((row) => row.billing_no).join(', ')}`);
        }
      }

      const invoiceParams = [];
      const invoiceIdx = {
        custCode: invoiceParams.push(custCode),
        docDate: invoiceParams.push(docDate),
        saleFlags: invoiceParams.push(SALE_FLAGS),
        debitFlags: invoiceParams.push(DEBIT_NOTE_FLAGS),
        creditFlags: invoiceParams.push(CREDIT_NOTE_FLAGS),
        docNos: invoiceParams.push(invoiceNos),
      };
      const invoiceCte = withArBalanceParams(
        arBalanceDocCte({
          includeDocNos: true,
        }),
        invoiceIdx,
      );
      const invoiceResult = await client.query(
        `${invoiceCte}
         SELECT doc_no, doc_date, bill_type, bill_type_name, ref_doc_no, ref_doc_date,
                tax_doc_no, tax_doc_date, due_date, credit_day,
                sum_debt_amount, ROUND(balance_ref,2) AS balance_ref,
                sum_debt_amount_2, ROUND(balance_ref_2,2) AS balance_ref_2,
                currency_code, exchange_rate, vat_rate, branch_code, ship_code, source_remark
         FROM ar_balance_docs`,
        invoiceParams,
      );

      const invoiceMap = new Map(invoiceResult.rows.map((row) => [`${row.doc_no}|${row.bill_type}`, row]));
      for (const row of details) {
        const invoice = invoiceMap.get(`${row.billing_no}|${row.bill_type}`);
        if (!invoice) throw new Error(`billing document not found: ${row.billing_no}`);
        const balance = roundMoney(invoice.balance_ref);
        const requestedTotal = roundMoney(detailTotals.get(`${row.billing_no}|${row.bill_type}`) || 0);
        if (amountExceedsBalance(requestedTotal, balance)) {
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
        const debtAmount2 = roundMoney(invoice.sum_debt_amount_2 ?? debtAmount);
        const balanceRef2 = roundMoney(invoice.balance_ref_2 ?? balanceRef);
        const sumPayMoney2 = balanceRef && balanceRef2
          ? roundMoney(row.sum_pay_money * (balanceRef2 / balanceRef))
          : roundMoney(row.sum_pay_money);
        const billingDate = dateToISO(invoice.doc_date, docDate);
        const invoiceDueDate = dateToISO(invoice.due_date, billingDate);
        const refDocDate = nullableDateToISO(invoice.ref_doc_date);
        const billTaxDate = nullableDateToISO(invoice.tax_doc_date);
        await client.query(
          `INSERT INTO ap_ar_trans_detail (
            trans_type, trans_flag, doc_date, doc_no, doc_ref, billing_no,
            billing_date, due_date, sum_debt_amount, sum_debt_balance, remark,
            line_number, bill_type, sum_pay_money, balance_ref, vat_rate,
            final_amount, last_status, calc_flag, ref_doc_no, ref_doc_date,
            bill_tax_no, bill_tax_date, sum_debt_amount_2, currency_code,
            exchange_rate, exchange_rate_old, balance_ref_2, sum_pay_money_2,
            cust_code, creator_code, create_datetime
          ) VALUES (
            $1,$2,$3::date,$4,'',$5,$6::date,$7::date,$8,0,$9,
            $10,$11,$12,$13,$14,0,0,0,$15,$16::date,
            $17,$18::date,$19,$20,$21,$22,$23,$24,'',$25,NOW()
          )`,
          [
            TRANS_TYPE, TRANS_FLAG, docDate, savedDocNo, row.billing_no,
            billingDate, invoiceDueDate, debtAmount, row.remark, i, row.bill_type,
            row.sum_pay_money, balanceRef, roundMoney(invoice.vat_rate),
            safeText(invoice.ref_doc_no), refDocDate,
            safeText(invoice.tax_doc_no), billTaxDate, debtAmount2,
            safeText(invoice.currency_code), roundMoney(invoice.exchange_rate || 1),
            roundMoney(invoice.exchange_rate || 1), balanceRef2, sumPayMoney2,
            creatorCode,
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
    if (ex.message && (ex.message.includes('exceeds balance') || ex.message.includes('already used'))) {
      return res.status(400).json({ success: false, msg: ex.message });
    }
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

module.exports = router;

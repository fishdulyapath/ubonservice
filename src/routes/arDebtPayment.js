const express = require('express');
const router = express.Router();
const { withTransaction, query } = require('../db');
const { resolveDocumentNo } = require('../utils/docFormat');
const { getEmployeePermissions } = require('../utils/permissions');
const { renderSalePrintHtml } = require('../utils/salePrintRenderer');

const TRANS_TYPE = 2;
const TRANS_FLAG = 239;
const CANCEL_TRANS_FLAG = 240;
const BILLING_TRANS_FLAG = 235;
const BILLING_CANCEL_TRANS_FLAG = 236;
const REF_TRANS_FLAG = 99;
const SCREEN_CODE = 'EE';
const DOC_TABLE = 'ap_ar_trans';
const VIEW_PERMISSION = 'sales.ar_debt_payment.view';
const HISTORY_PERMISSION = 'sales.ar_debt_payment.history.view';
const READ_PERMISSIONS = [VIEW_PERMISSION, HISTORY_PERMISSION];
const CREATE_PERMISSION = 'sales.ar_debt_payment.create';
const VAT_SALE_CALC = 1;
const SALE_FLAGS = [44];
const DEBIT_NOTE_FLAGS = [46, 93, 95, 99, 101];
const CREDIT_NOTE_FLAGS = [48, 97, 103];
const DEBT_DOC_FLAGS = [...SALE_FLAGS, ...DEBIT_NOTE_FLAGS, ...CREDIT_NOTE_FLAGS];

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

async function loadArDebtPaymentProfile(queryFn, userCode = '') {
  const profile = {
    branchStatus: 0,
    arPayFromBillNote: false,
    showBranchDocOnly: false,
    useCreditPayBillCalc: false,
    userCanChangeBranch: false,
    userBranchCode: '',
  };
  try {
    const company = await queryFn(
      `SELECT COALESCE(branch_status,0) AS branch_status
       FROM erp_company_profile
       ORDER BY roworder
       LIMIT 1`,
    );
    profile.branchStatus = toInt(company.rows[0]?.branch_status);
  } catch {
    profile.branchStatus = 0;
  }
  try {
    const option = await queryFn(
      `SELECT COALESCE(ar_pay_from_bill_note,0) AS ar_pay_from_bill_note,
              COALESCE(show_branch_doc_only,0) AS show_branch_doc_only,
              COALESCE(use_credit_pay_bill_calc,0) AS use_credit_pay_bill_calc
       FROM erp_option
       LIMIT 1`,
    );
    const row = option.rows[0] || {};
    profile.arPayFromBillNote = boolFlag(row.ar_pay_from_bill_note);
    profile.showBranchDocOnly = boolFlag(row.show_branch_doc_only);
    profile.useCreditPayBillCalc = boolFlag(row.use_credit_pay_bill_calc);
  } catch {
    // Keep defaults if an older database has no option table/columns.
  }
  const code = safeText(userCode);
  if (code) {
    try {
      const user = await queryFn(
        `SELECT COALESCE(change_branch_code,0) AS change_branch_code,
                COALESCE(branch_code,'') AS branch_code
         FROM erp_user
         WHERE UPPER(code) = UPPER($1)
         LIMIT 1`,
        [code],
      );
      const row = user.rows[0] || {};
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

function arDebtBalanceCte({ includeSearch = false, includeBranch = false, includeDocKeys = false, useCreditPayBillCalc = false }) {
  const searchSql = includeSearch
    ? `AND (
         temp3.doc_no ILIKE $search
         OR COALESCE(temp3.ref_doc_no,'') ILIKE $search
         OR COALESCE(temp3.tax_doc_no,'') ILIKE $search
         OR COALESCE(temp3.ship_code,'') ILIKE $search
       )`
    : '';
  const branchSql = includeBranch ? `AND COALESCE(temp3.branch_code,'') = $branch` : '';
  const docKeysSql = includeDocKeys
    ? `AND EXISTS (
         SELECT 1
         FROM unnest($docNos::text[], $billTypes::int[]) AS k(doc_no, bill_type)
         WHERE k.doc_no = temp3.doc_no
           AND k.bill_type = temp3.bill_type
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
        SELECT t.cust_code, t.doc_no, t.doc_date,
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
                   AND d.trans_flag IN (${TRANS_FLAG})
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
                     AND d.trans_flag IN (${TRANS_FLAG},19)
                     AND d.billing_no = t.doc_no
                     AND d.bill_type = t.trans_flag
                 ),0)
               ELSE
                 COALESCE(t.total_amount_2,t.total_amount,0) - COALESCE((
                   SELECT SUM(COALESCE(d.sum_pay_money_2,0))
                   FROM ap_ar_trans_detail d
                   WHERE COALESCE(d.last_status,0) = 0
                     AND d.trans_flag IN (${TRANS_FLAG},19)
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

        SELECT t.cust_code, t.doc_no, t.doc_date,
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
                   AND d.trans_flag IN (${TRANS_FLAG})
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
                     AND d.trans_flag IN (${TRANS_FLAG},19)
                     AND d.billing_no = t.doc_no
                     AND d.bill_type = t.trans_flag
                 ),0)
               ELSE
                 COALESCE(t.total_amount_2,t.total_amount,0) - COALESCE((
                   SELECT SUM(COALESCE(d.sum_pay_money_2,0))
                   FROM ap_ar_trans_detail d
                   WHERE COALESCE(d.last_status,0) = 0
                     AND d.trans_flag IN (${TRANS_FLAG},19)
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

        SELECT t.cust_code, t.doc_no, t.doc_date,
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
                   AND d.trans_flag IN (${TRANS_FLAG})
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
                     AND d.trans_flag IN (${TRANS_FLAG})
                     AND d.billing_no = t.doc_no
                     AND d.bill_type = t.trans_flag
                 ),0))
               ELSE
                 -1 * (COALESCE(t.total_amount_2,t.total_amount,0) + COALESCE((
                   SELECT SUM(COALESCE(d.sum_pay_money_2,0))
                   FROM ap_ar_trans_detail d
                   WHERE COALESCE(d.last_status,0) = 0
                     AND d.trans_flag IN (${TRANS_FLAG})
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
    debt_balance_docs AS (
      SELECT temp3.*
      FROM temp3
      WHERE ABS(ROUND(COALESCE(temp3.balance_ref,0), 2)) > 0.0001
        ${docKeysSql}
        ${searchSql}
        ${branchSql}
        ${dueDateSql}
    )`;
}

function withDebtBalanceParams(sql, params) {
  return sql
    .replace(/\$custCode/g, `$${params.custCode}`)
    .replace(/\$docDate/g, `$${params.docDate}`)
    .replace(/\$saleFlags/g, `$${params.saleFlags}`)
    .replace(/\$debitFlags/g, `$${params.debitFlags}`)
    .replace(/\$creditFlags/g, `$${params.creditFlags}`)
    .replace(/\$search/g, `$${params.search}`)
    .replace(/\$branch/g, `$${params.branch}`)
    .replace(/\$docNos/g, `$${params.docNos}`)
    .replace(/\$billTypes/g, `$${params.billTypes}`)
    .replace(/\$dueDate/g, `$${params.dueDate}`);
}

function parseDebtDocKeys(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [docNo, billType] = item.split('|');
      return { doc_no: safeText(docNo), bill_type: toInt(billType) };
    })
    .filter((row) => row.doc_no && row.bill_type);
}

function debtDocKey(row) {
  return `${safeText(row?.billing_no || row?.doc_no)}|${toInt(row?.bill_type)}`;
}

function debtDocKeySet(keys) {
  return new Set((keys || []).map((row) => `${row.doc_no}|${row.bill_type}`));
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
      source_billing_no: safeText(row?.source_billing_no || row?.billing_doc_no || row?.doc_ref),
      billing_no: safeText(row?.billing_no || row?.ref_doc_no),
      billing_date: normalizeNullableDate(row?.billing_date),
      due_date: normalizeNullableDate(row?.due_date),
      bill_type: toInt(row?.bill_type || row?.trans_flag),
      bill_type_name: safeText(row?.bill_type_name),
      ref_doc_no: safeText(row?.ref_doc_no),
      ref_doc_date: normalizeNullableDate(row?.ref_doc_date),
      sum_debt_amount: roundMoney(row?.sum_debt_amount),
      balance_ref: roundMoney(row?.balance_ref),
      sum_pay_money: roundMoney(row?.sum_pay_money ?? row?.pay_amount),
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

function normalizePayments(value) {
  const source = value && typeof value === 'object' ? value : {};
  const transfer = Array.isArray(source.transfer) ? source.transfer : [];
  const card = Array.isArray(source.card) ? source.card : [];
  const cheque = Array.isArray(source.cheque) ? source.cheque : [];
  const coupon = Array.isArray(source.coupon) ? source.coupon : [];
  const deposit = Array.isArray(source.deposit) ? source.deposit : [];
  const income = Array.isArray(source.income) ? source.income : [];
  const expense = Array.isArray(source.expense) ? source.expense : [];
  const normalizeSimplePayRows = (rows) =>
    rows
      .map((row) => ({
        trans_number: safeText(row?.trans_number || row?.doc_no || row?.code),
        amount: roundMoney(row?.amount ?? row?.pay_amount),
        remark: safeText(row?.remark),
      }))
      .filter((row) => row.amount > 0);
  return {
    cash_amount: roundMoney(source.cash_amount),
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
        bank_code: safeText(row?.bank_code),
        bank_branch: safeText(row?.bank_branch),
        trans_number: safeText(row?.trans_number || row?.chq_number),
        amount: roundMoney(row?.amount ?? row?.pay_amount),
        chq_due_date: normalizeDate(row?.chq_due_date || row?.due_date, ''),
      }))
      .filter((row) => row.amount > 0),
    coupon: normalizeSimplePayRows(coupon),
    deposit: normalizeSimplePayRows(deposit),
    income: normalizeSimplePayRows(income),
    expense: normalizeSimplePayRows(expense),
  };
}

function normalizeVatSaleRows(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((row, index) => {
      const vatDate = normalizeDate(row?.vat_date || row?.vat_doc_date || row?.doc_date);
      const vatYear = toInt(row?.vat_effective_year, 0) || new Date(vatDate).getFullYear() + 543;
      const vatPeriod = toInt(row?.vat_effective_period, 0) || new Date(vatDate).getMonth() + 1;
      const baseAmount = roundMoney(row?.base_caltax_amount ?? row?.base_amount);
      const taxRate = roundMoney(row?.tax_rate ?? row?.vat_rate ?? 7);
      const vatAmount = roundMoney(row?.amount ?? row?.vat_amount);
      return {
        line_number: index,
        vat_date: vatDate,
        vat_number: safeText(row?.vat_number || row?.vat_doc_no || row?.tax_doc_no),
        tax_group: safeText(row?.tax_group),
        description: safeText(row?.description || row?.remark),
        base_caltax_amount: baseAmount,
        tax_rate: taxRate,
        amount: vatAmount,
        except_tax_amount: roundMoney(row?.except_tax_amount ?? row?.except_vat_amount),
        vat_effective_period: vatPeriod,
        vat_effective_year: vatYear,
        vat_type: toInt(row?.vat_type, 0),
        is_add: toInt(row?.is_add, 0),
        manual_add: toInt(row?.manual_add, 0),
        ref_vat_no: safeText(row?.ref_vat_no),
        ref_vat_date: normalizeNullableDate(row?.ref_vat_date),
        ref_doc_no: safeText(row?.ref_doc_no),
        ref_doc_date: normalizeNullableDate(row?.ref_doc_date),
      };
    })
    .filter((row) => row.vat_number && (row.base_caltax_amount !== 0 || row.amount !== 0 || row.except_tax_amount !== 0));
}

function asAmountText(value) {
  const amount = roundMoney(value);
  return Math.abs(amount) > 0.0001 ? amount.toFixed(2) : '';
}

function paymentLabel(row) {
  const docType = toInt(row?.doc_type);
  const ref = safeText(row?.trans_number);
  const map = {
    1: 'Transfer',
    2: 'Cheque',
    3: 'Credit card',
    4: 'Petty cash',
    5: 'Advance/deposit',
    9: 'Coupon',
    11: 'Other expense',
    12: 'Other income',
    19: 'Foreign currency',
    21: 'Wallet',
  };
  const label = map[docType] || 'Payment';
  return ref ? `${label} - ${ref}` : label;
}

async function loadPaymentRowsForPrint(docNo) {
  const cbRes = await query(
    `SELECT
        COALESCE(cash_amount,0) AS cash_amount,
        COALESCE(petty_cash_amount,0) AS petty_cash_amount,
        COALESCE(discount_amount,0) AS discount_amount,
        COALESCE(total_income_amount,0) AS total_income_amount,
        COALESCE(total_amount,0) AS total_amount,
        COALESCE(total_net_amount,0) AS total_net_amount,
        COALESCE(total_amount_pay,0) AS total_amount_pay,
        COALESCE(tranfer_amount,0) AS tranfer_amount,
        COALESCE(chq_amount,0) AS chq_amount,
        COALESCE(card_amount,0) AS card_amount
     FROM cb_trans
     WHERE doc_no = $1 AND trans_flag = $2
     LIMIT 1`,
    [docNo, TRANS_FLAG],
  );

  const labels = [];
  const amounts = [];
  const addPayment = (label, amount) => {
    const text = asAmountText(amount);
    if (!text) return;
    labels.push(label);
    amounts.push(text);
  };

  addPayment('Cash', cbRes.rows[0]?.cash_amount);
  addPayment('Petty cash', cbRes.rows[0]?.petty_cash_amount);
  addPayment('Discount', cbRes.rows[0]?.discount_amount);
  addPayment('Round/income', cbRes.rows[0]?.total_income_amount);

  const detailRes = await query(
    `SELECT doc_type, COALESCE(trans_number,'') AS trans_number,
            COALESCE(amount,0) AS amount, COALESCE(charge,0) AS charge
     FROM cb_trans_detail
     WHERE doc_no = $1 AND trans_flag = $2
     ORDER BY roworder`,
    [docNo, TRANS_FLAG],
  );

  for (const row of detailRes.rows) {
    addPayment(paymentLabel(row), roundMoney(toNumber(row.amount) + toNumber(row.charge)));
  }

  const summary = cbRes.rows[0] || {};
  return [{
    trans_number: labels.join('\n'),
    amount: amounts.join('\n'),
    total_amount: summary.total_amount,
    total_net_amount: summary.total_net_amount,
    total_amount_pay: summary.total_amount_pay,
    discount_amount: summary.discount_amount,
    total_discount: summary.discount_amount,
    cash_amount: summary.cash_amount,
    cash: summary.cash_amount,
    tranfer_amount: summary.tranfer_amount,
    transfer_amount: summary.tranfer_amount,
    tranfer: summary.tranfer_amount,
    transfer: summary.tranfer_amount,
    chq_amount: summary.chq_amount,
    chq: summary.chq_amount,
    card_amount: summary.card_amount,
  }];
}

async function loadArDebtPaymentPrintDocument(docNo) {
  const [headerRes, companyRes, detailsRes, payments] = await Promise.all([
    query(
      `SELECT t.*,
          COALESCE(t.total_net_value,0) AS total_value,
          COALESCE(t.total_net_value,0) AS total_amount,
          COALESCE(t.total_net_value,0) AS total_net_amount,
          GREATEST(ROUND(COALESCE(t.total_net_value,0) - COALESCE(cb.discount_amount,0), 2), 0) AS total_after_discount,
          COALESCE(cb.total_amount_pay, t.total_net_value, 0) AS total_amount_pay,
          COALESCE(cb.cash_amount,0) AS cash_amount,
          COALESCE(cb.tranfer_amount,0) AS tranfer_amount,
          COALESCE(cb.tranfer_amount,0) AS transfer_amount,
          COALESCE(cb.chq_amount,0) AS chq_amount,
          COALESCE(cb.card_amount,0) AS card_amount,
          COALESCE(cb.total_income_amount,0) AS total_income_amount,
          COALESCE(cb.petty_cash_amount,0) AS petty_cash_amount,
          COALESCE(cb.discount_amount,0) AS discount_amount,
          COALESCE(cb.discount_amount,0) AS total_discount,
          COALESCE(t.discount_word,'') AS discount_word,
          COALESCE(df.name_1,'') AS doc_format_name,
          COALESCE(df.form_code,'') AS form_code,
          COALESCE(ar.name_1,'') AS name_1,
          COALESCE(ar.address,'') AS address,
          COALESCE(ar.telephone,'') AS telephone,
          COALESCE(ar.fax,'') AS fax,
          COALESCE(cd.tax_id,'') AS tax_id,
          COALESCE(u.name_1, t.creator_code, '') AS sale_name
       FROM ap_ar_trans t
       LEFT JOIN erp_doc_format df ON df.screen_code = $2 AND df.code = t.doc_format_code
        LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = t.trans_flag
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
          doc_ref,
          billing_no,
          COALESCE(NULLIF(billing_no,''), NULLIF(doc_ref,''), '') AS item_code,
          COALESCE(NULLIF(billing_no,''), NULLIF(doc_ref,''), '') AS item_name,
          bill_type_name,
          '' AS unit_code,
          '' AS unit_name,
          1 AS qty,
          sum_pay_money,
          sum_pay_money AS price,
          sum_pay_money AS sum_amount,
          sum_pay_money AS amount,
          sum_pay_money AS total_amount,
          sum_pay_money AS total_net_amount,
          sum_pay_money AS sum_debt_amount,
          balance_ref,
          billing_date,
          billing_date AS doc_date,
          due_date,
          remark
       FROM (
         SELECT d.*, CASE d.bill_type
                    WHEN 44 THEN 'Credit sale'
                    WHEN 46 THEN 'Debit note'
                    WHEN 48 THEN 'Credit note'
                    WHEN 93 THEN 'Opening debt'
                    WHEN 95 THEN 'Opening debit note'
                    WHEN 97 THEN 'Opening credit note'
                    ELSE d.bill_type::text
                  END AS bill_type_name
         FROM ap_ar_trans_detail d
         WHERE d.trans_flag = $2 AND d.doc_no = $1
       ) x
       ORDER BY line_number, roworder`,
      [docNo, TRANS_FLAG],
    ),
    loadPaymentRowsForPrint(docNo),
  ]);

  const header = headerRes.rows[0];
  if (!header) return null;
  const company = companyRes.rows[0] || {};
  company.tax_text = company.tax_number ? `Tax ID ${company.tax_number}` : '';
  company.telephone_text = company.telephone_number ? `Tel. ${company.telephone_number}` : '';

  return {
    header,
    company,
    details: detailsRes.rows || [],
    payments,
    campaigns: [{
      cash: header.cash_amount,
      chq: header.chq_amount,
      tranfer: header.tranfer_amount,
      transfer: header.tranfer_amount,
      card: header.card_amount,
    }],
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

async function assertAnyPermission(queryFn, userCode, permissionKeys) {
  const code = safeText(userCode);
  if (!code) throw new Error('creator_code or emp_code is required for permission check');
  const permissions = await getEmployeePermissions(queryFn, code);
  if (!permissionKeys.some((key) => permissions.includes(key))) {
    throw new Error(`permission denied: ${permissionKeys.join(' or ')}`);
  }
}

async function assertCreatePermission(client, userCode) {
  await assertPermission(client.query.bind(client), userCode, CREATE_PERMISSION);
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

async function insertSimplePaymentDetail(client, {
  docNo,
  docDate,
  docTime,
  row,
  docType,
  apArCode = '',
  transNumberType = 0,
  apArType = 0,
}) {
  await client.query(
    `INSERT INTO cb_trans_detail (
      trans_type, trans_flag, doc_no, doc_date, doc_time, trans_number,
      amount, sum_amount, doc_type, ap_ar_code, trans_number_type,
      ap_ar_type, remark, last_status
    ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$7,$8,$9,$10,$11,$12,0)`,
    [
      TRANS_TYPE, TRANS_FLAG, docNo, docDate, docTime, row.trans_number,
      row.amount, docType, apArCode, transNumberType, apArType, safeText(row.remark),
    ],
  );
}

async function getCustomerVatProfile(client, custCode) {
  const result = await client.query(
    `SELECT COALESCE(c.name_1,'') AS ar_name,
            COALESCE(d.tax_id, d.vat_license, '') AS tax_no,
            COALESCE(d.branch_type,0) AS branch_type,
            COALESCE(d.branch_code,'') AS branch_code
     FROM ar_customer c
     LEFT JOIN ar_customer_detail d ON d.ar_code = c.code
     WHERE c.code = $1
     LIMIT 1`,
    [custCode],
  );
  return result.rows[0] || { ar_name: '', tax_no: '', branch_type: 0, branch_code: '' };
}

async function insertVatSaleRows(client, { docNo, docDate, custCode, branchCode, rows }) {
  if (!rows.length) return;
  const customerVat = await getCustomerVatProfile(client, custCode);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    await client.query(
      `INSERT INTO gl_journal_vat_sale (
        ignore_sync, is_lock_record, doc_date, doc_no, book_code, line_number,
        vat_number, tax_group, description, base_caltax_amount, tax_rate,
        amount, except_tax_amount, period_number, is_add, vat_date, trans_type,
        trans_flag, vat_effective_period, ar_code, ar_name, vat_calc,
        vat_effective_year, branch_type, branch_code, tax_no, manual_add,
        is_doc_copy, create_date_time_now, vat_type, ref_vat_no, ref_vat_date,
        ref_doc_no, ref_doc_date
      ) VALUES (
        0,0,$1::date,$2,'',$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12::date,
        $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,0,NOW(),$24,
        $25,$26::date,$27,$28::date
      )`,
      [
        docDate, docNo, i, row.vat_number, row.tax_group, row.description,
        row.base_caltax_amount, row.tax_rate, row.amount, row.except_tax_amount,
        row.is_add, row.vat_date, TRANS_TYPE, TRANS_FLAG, row.vat_effective_period,
        custCode, customerVat.ar_name, VAT_SALE_CALC, row.vat_effective_year,
        toInt(customerVat.branch_type, 0), safeText(customerVat.branch_code || branchCode),
        safeText(customerVat.tax_no), row.manual_add, row.vat_type,
        row.ref_vat_no, row.ref_vat_date, row.ref_doc_no, row.ref_doc_date,
      ],
    );
  }
}

async function updateBillingStatuses(client, billingNos = [], detailKeys = []) {
  const billDocs = [...new Set(billingNos.map(safeText).filter(Boolean))];
  if (billDocs.length) {
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
         LEFT JOIN ap_ar_trans_detail p
           ON p.billing_no = b.billing_no
          AND p.bill_type = b.bill_type
          AND p.doc_ref = b.doc_no
          AND p.trans_flag = $2
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
                 WHERE x1.trans_flag = $4
                   AND COALESCE(x1.last_status,0) = 0
                   AND x1.doc_ref = t.doc_no
               ) THEN 1 ELSE 0 END,
           used_status = CASE
             WHEN EXISTS (
               SELECT 1 FROM ap_ar_trans_detail p
               WHERE p.trans_flag = $2
                 AND COALESCE(p.last_status,0) = 0
                 AND p.doc_ref = t.doc_no
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
      [BILLING_TRANS_FLAG, TRANS_FLAG, billDocs, BILLING_CANCEL_TRANS_FLAG],
    );
  }

  const keys = detailKeys
    .map((row) => ({ billing_no: safeText(row.billing_no), bill_type: toInt(row.bill_type) }))
    .filter((row) => row.billing_no && row.bill_type);
  if (!keys.length) return;
  const billingNosOnly = [...new Set(keys.map((row) => row.billing_no))];
  const billTypes = [...new Set(keys.map((row) => row.bill_type))];
  await client.query(
    `UPDATE ic_trans
     SET used_status_2 = CASE
       WHEN EXISTS (
         SELECT 1 FROM ap_ar_trans_detail d
         WHERE d.billing_no = ic_trans.doc_no
           AND d.bill_type = ic_trans.trans_flag
           AND d.trans_flag IN ($1,$2)
           AND COALESCE(d.last_status,0) = 0
       ) THEN 1 ELSE 0 END
     WHERE doc_no = ANY($3::text[])
       AND trans_flag = ANY($4::int[])`,
    [BILLING_TRANS_FLAG, TRANS_FLAG, billingNosOnly, billTypes],
  );
}

router.get('/ar-debt-payment/doc-formats', async (req, res) => {
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, VIEW_PERMISSION);
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

router.get('/ar-debt-payment/next-doc-no', async (req, res) => {
  const { doc_format_code = '', doc_date = '' } = req.query;
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, VIEW_PERMISSION);
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

router.get('/ar-debt-payment/sales-users', async (req, res) => {
  const search = safeText(req.query.search);
  const params = [];
  let where = '1=1';
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (code ILIKE $${params.length} OR COALESCE(name_1,'') ILIKE $${params.length})`;
  }
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, VIEW_PERMISSION);
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

router.get('/ar-debt-payment/list', async (req, res) => {
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
    await assertAnyPermission(query, req.query.user_code || req.query.emp_code, READ_PERMISSIONS);
    const result = await query(
      `SELECT t.doc_no, t.doc_date, t.doc_time, t.doc_format_code, t.cust_code,
              COALESCE(c.name_1,'') AS cust_name, COALESCE(t.sale_code,'') AS sale_code,
              COALESCE(t.total_net_value,0) AS total_net_value,
              COALESCE(cb.total_amount, t.total_net_value, 0) AS total_amount,
              GREATEST(ROUND(COALESCE(t.total_net_value,0) - COALESCE(cb.discount_amount,0), 2), 0) AS total_after_discount,
              COALESCE(t.last_status,0) AS last_status, COALESCE(t.used_status,0) AS used_status,
              COALESCE(t.doc_success,0) AS doc_success, COALESCE(t.remark,'') AS remark,
              COALESCE(cb.cash_amount,0) AS cash_amount,
              COALESCE(cb.tranfer_amount,0) AS tranfer_amount,
              COALESCE(cb.card_amount,0) AS card_amount,
              COALESCE(cb.chq_amount,0) AS chq_amount,
              COALESCE(cb.coupon_amount,0) AS coupon_amount,
              COALESCE(cb.deposit_amount,0) AS deposit_amount,
              COALESCE(cb.petty_cash_amount,0) AS petty_cash_amount,
              COALESCE(cb.discount_amount,0) AS discount_amount,
              COALESCE(t.discount_word,'') AS discount_word,
              COALESCE(cb.total_income_amount,0) AS total_income_amount,
              COALESCE(cb.total_income_other,0) AS total_income_other,
              COALESCE(cb.total_expense_other,0) AS total_expense_other,
              COALESCE(vs.vat_sale_amount,0) AS vat_sale_amount
       FROM ap_ar_trans t
       LEFT JOIN ar_customer c ON c.code = t.cust_code
       LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = t.trans_flag
       LEFT JOIN (
         SELECT doc_no, trans_flag, COALESCE(SUM(amount),0) AS vat_sale_amount
         FROM gl_journal_vat_sale
         GROUP BY doc_no, trans_flag
       ) vs ON vs.doc_no = t.doc_no AND vs.trans_flag = t.trans_flag
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

router.get('/ar-debt-payment/open-billings', async (req, res) => {
  const custCode = safeText(req.query.cust_code);
  const search = safeText(req.query.search);
  const requestedSourceMode = safeText(req.query.source_mode || req.query.mode);
  const excludeKeys = parseDebtDocKeys(req.query.exclude_keys);
  const excludeKeySet = debtDocKeySet(excludeKeys);
  const docDate = normalizeDate(req.query.doc_date);
  const dueDate = normalizeDate(req.query.due_date, docDate);
  const branchCodeFromRequest = safeText(req.query.branch_code);
  const userCode = req.query.user_code || req.query.emp_code;
  if (!custCode) return res.json({ success: true, data: [] });
  try {
    await assertPermission(query, userCode, VIEW_PERMISSION);
    const profile = await loadArDebtPaymentProfile(query, userCode);
    const branchCode = branchCodeFromRequest || profile.userBranchCode;
    const includeBranch = profile.branchStatus === 1 && profile.showBranchDocOnly && !profile.userCanChangeBranch && !!branchCode;
    const useDirectDebtSource = requestedSourceMode === 'direct_debt' || requestedSourceMode === 'debt_doc'
      || (!requestedSourceMode && !profile.arPayFromBillNote);
    if (useDirectDebtSource) {
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
      const cte = withDebtBalanceParams(
        arDebtBalanceCte({
          includeSearch: !!search,
          includeBranch,
          useCreditPayBillCalc: profile.useCreditPayBillCalc,
        }),
        idx,
      );
      const result = await query(
        `${cte}
         SELECT 'direct_debt' AS source_mode,
                doc_no, doc_no AS billing_no, doc_date, doc_date AS billing_date,
                bill_type, bill_type_name, ref_doc_no, ref_doc_date,
                tax_doc_no, tax_doc_date, due_date, due_day, credit_day,
                sum_debt_amount, ROUND(balance_ref,2) AS balance_ref,
                sum_debt_amount_2, ROUND(balance_ref_2,2) AS balance_ref_2,
                currency_code, exchange_rate, vat_rate, branch_code, ship_code,
                source_remark AS remark
         FROM debt_balance_docs
         ORDER BY due_date, doc_date, doc_no
         LIMIT 200`,
        params,
      );
      const rows = result.rows.filter((row) => !excludeKeySet.has(debtDocKey(row)));
      return res.json({ success: true, source_mode: 'direct_debt', data: rows });
    }

    const params = [BILLING_TRANS_FLAG, TRANS_FLAG, TRANS_TYPE, custCode];
    let extra = '';
    if (search) {
      params.push(`%${search}%`);
      extra = `AND (t.doc_no ILIKE $${params.length} OR COALESCE(t.remark,'') ILIKE $${params.length})`;
    }
    if (includeBranch) {
      params.push(branchCode);
      extra += ` AND COALESCE(t.branch_code,'') = $${params.length}`;
    }
    if (excludeKeys.length) {
      const excludeDocNos = excludeKeys.map((row) => row.doc_no);
      const excludeBillTypes = excludeKeys.map((row) => row.bill_type);
      params.push(excludeDocNos);
      const excludeDocNosParam = params.length;
      params.push(excludeBillTypes);
      const excludeBillTypesParam = params.length;
      extra += ` AND EXISTS (
        SELECT 1
        FROM ap_ar_trans_detail b2
        WHERE b2.trans_flag = $1
          AND b2.doc_no = t.doc_no
          AND COALESCE(b2.last_status,0) = 0
          AND NOT EXISTS (
            SELECT 1
            FROM unnest($${excludeDocNosParam}::text[], $${excludeBillTypesParam}::int[]) AS k(doc_no, bill_type)
            WHERE k.doc_no = b2.billing_no
              AND k.bill_type = b2.bill_type
          )
      )`;
    }
    const result = await query(
      `WITH bill_totals AS (
         SELECT b.doc_no,
                COALESCE(SUM(b.sum_pay_money),0) AS bill_total,
                COALESCE(SUM((
                  SELECT COALESCE(SUM(p.sum_pay_money),0)
                  FROM ap_ar_trans_detail p
                  WHERE p.trans_flag = $2
                    AND COALESCE(p.last_status,0) = 0
                    AND p.doc_ref = b.doc_no
                    AND p.billing_no = b.billing_no
                    AND p.bill_type = b.bill_type
                )),0) AS paid_total
         FROM ap_ar_trans_detail b
         WHERE b.trans_flag = $1
           AND COALESCE(b.last_status,0) = 0
         GROUP BY b.doc_no
       )
       SELECT 'billing_note' AS source_mode,
              t.doc_no, t.doc_date, t.doc_time, t.cust_code, COALESCE(c.name_1,'') AS cust_name,
              COALESCE(t.sale_code,'') AS sale_code, COALESCE(t.remark,'') AS remark,
              COALESCE(bt.bill_total,0) AS total_net_value,
              GREATEST(ROUND(COALESCE(bt.bill_total,0) - COALESCE(bt.paid_total,0), 2), 0) AS balance_ref
       FROM ap_ar_trans t
       LEFT JOIN ar_customer c ON c.code = t.cust_code
       LEFT JOIN bill_totals bt ON bt.doc_no = t.doc_no
       WHERE t.trans_flag = $1
         AND t.trans_type = $3
         AND t.cust_code = $4
         AND COALESCE(t.doc_success,0) = 0
         AND COALESCE(t.last_status,0) = 0
         ${extra}
         AND GREATEST(ROUND(COALESCE(bt.bill_total,0) - COALESCE(bt.paid_total,0), 2), 0) > 0
       ORDER BY t.doc_date, t.doc_no
       LIMIT 200`,
      params,
    );
    return res.json({ success: true, source_mode: 'billing_note', data: result.rows });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/ar-debt-payment/advance-balance', async (req, res) => {
  const custCode = safeText(req.query.cust_code);
  if (!custCode) return res.json({ success: true, data: [] });
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, VIEW_PERMISSION);
    const result = await query(
      `SELECT x.doc_no, x.doc_date, x.doc_time, x.cust_code,
              COALESCE(x.remark,'') AS remark,
              COALESCE(x.total_amount,0) AS total_amount,
              COALESCE(x.used_amount,0) AS used_amount,
              GREATEST(ROUND(COALESCE(x.total_amount,0) - COALESCE(x.used_amount,0), 2), 0) AS balance_amount
       FROM (
         SELECT h.doc_no, h.doc_date, h.doc_time, h.cust_code, h.remark,
                COALESCE(h.total_amount, 0) AS total_amount,
                COALESCE((
                  SELECT SUM(d.amount)
                  FROM cb_trans_detail d
                  JOIN cb_trans cb ON cb.doc_no = d.doc_no AND cb.trans_flag = d.trans_flag
                  WHERE d.doc_type = 5
                    AND d.trans_number = h.doc_no
                    AND COALESCE(d.last_status,0) = 0
                ),0) AS used_amount
         FROM ic_trans h
         WHERE h.trans_flag IN (40,9040)
           AND h.cust_code = $1
           AND COALESCE(h.last_status,0) = 0
       ) x
       WHERE GREATEST(ROUND(COALESCE(x.total_amount,0) - COALESCE(x.used_amount,0), 2), 0) > 0
       ORDER BY x.doc_date, x.doc_no
       LIMIT 100`,
      [custCode],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/ar-debt-payment/income-list', async (req, res) => {
  const search = safeText(req.query.search);
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = `WHERE code ILIKE $1 OR COALESCE(name_1,'') ILIKE $1`;
  }
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, VIEW_PERMISSION);
    const result = await query(
      `SELECT code, COALESCE(name_1,'') AS name_1
       FROM erp_income_list
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

router.get('/ar-debt-payment/expense-list', async (req, res) => {
  const search = safeText(req.query.search);
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = `WHERE code ILIKE $1 OR COALESCE(name_1,'') ILIKE $1`;
  }
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, VIEW_PERMISSION);
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

router.get('/ar-debt-payment/billing-detail', async (req, res) => {
  const custCode = safeText(req.query.cust_code);
  const docNos = String(req.query.doc_nos || '')
    .split(',')
    .map(safeText)
    .filter(Boolean);
  const excludeKeys = parseDebtDocKeys(req.query.exclude_keys);
  const excludeKeySet = debtDocKeySet(excludeKeys);
  const docDate = normalizeDate(req.query.doc_date);
  const dueDate = normalizeDate(req.query.due_date, docDate);
  const branchCodeFromRequest = safeText(req.query.branch_code);
  const userCode = req.query.user_code || req.query.emp_code;
  if (!custCode || !docNos.length) return res.json({ success: true, data: [] });
  try {
    await assertPermission(query, userCode, VIEW_PERMISSION);
    const profile = await loadArDebtPaymentProfile(query, userCode);
    const branchCode = branchCodeFromRequest || profile.userBranchCode;
    const includeBranch = profile.branchStatus === 1 && profile.showBranchDocOnly && !profile.userCanChangeBranch && !!branchCode;
    const selected = await query(
      `SELECT b.doc_no AS source_billing_no, h.doc_date AS source_billing_date,
              b.billing_no, b.billing_date, b.bill_type, b.line_number, b.roworder,
              COALESCE(b.sum_pay_money,0) AS billed_amount,
              COALESCE(b.remark,'') AS billing_remark
       FROM ap_ar_trans_detail b
       JOIN ap_ar_trans h ON h.doc_no = b.doc_no AND h.trans_flag = b.trans_flag
       WHERE b.trans_flag = $1
         AND b.doc_no = ANY($2::text[])
         AND h.cust_code = $3
         AND COALESCE(h.doc_success,0) = 0
         AND COALESCE(h.last_status,0) = 0
         AND COALESCE(b.last_status,0) = 0
       ORDER BY h.doc_date, b.doc_no, b.line_number, b.roworder`,
      [BILLING_TRANS_FLAG, docNos, custCode],
    );
    const selectedRows = selected.rows.filter((row) => !excludeKeySet.has(debtDocKey(row)));
    if (!selectedRows.length) return res.json({ success: true, data: [] });

    const params = [];
    const idx = {
      custCode: params.push(custCode),
      docDate: params.push(docDate),
      saleFlags: params.push(SALE_FLAGS),
      debitFlags: params.push(DEBIT_NOTE_FLAGS),
      creditFlags: params.push(CREDIT_NOTE_FLAGS),
      docNos: params.push(selectedRows.map((row) => row.billing_no)),
      billTypes: params.push(selectedRows.map((row) => toInt(row.bill_type))),
    };
    if (includeBranch) idx.branch = params.push(branchCode);
    if (profile.useCreditPayBillCalc) idx.dueDate = params.push(dueDate);
    const cte = withDebtBalanceParams(
      arDebtBalanceCte({
        includeDocKeys: true,
        includeBranch,
        useCreditPayBillCalc: profile.useCreditPayBillCalc,
      }),
      idx,
    );
    const balances = await query(
      `${cte}
       SELECT doc_no, doc_date, bill_type, bill_type_name, ref_doc_no, ref_doc_date,
              tax_doc_no, tax_doc_date, due_date, due_day, credit_day,
              sum_debt_amount, ROUND(balance_ref,2) AS balance_ref,
              sum_debt_amount_2, ROUND(balance_ref_2,2) AS balance_ref_2,
              currency_code, exchange_rate, vat_rate, branch_code, ship_code,
              source_remark AS remark
       FROM debt_balance_docs`,
      params,
    );
    const balanceMap = new Map(balances.rows.map((row) => [debtDocKey(row), row]));
    const rows = [];
    for (const source of selectedRows) {
      const balance = balanceMap.get(debtDocKey(source));
      if (!balance) continue;
      rows.push({
        source_mode: 'billing_note',
        source_billing_no: source.source_billing_no,
        source_billing_date: source.source_billing_date,
        billing_no: balance.doc_no,
        billing_date: balance.doc_date,
        bill_type: balance.bill_type,
        bill_type_name: balance.bill_type_name,
        ref_doc_no: balance.ref_doc_no,
        ref_doc_date: balance.ref_doc_date,
        tax_doc_no: balance.tax_doc_no,
        tax_doc_date: balance.tax_doc_date,
        due_date: balance.due_date,
        due_day: balance.due_day,
        credit_day: balance.credit_day,
        sum_debt_amount: balance.sum_debt_amount,
        balance_ref: balance.balance_ref,
        sum_debt_amount_2: balance.sum_debt_amount_2,
        balance_ref_2: balance.balance_ref_2,
        currency_code: balance.currency_code,
        exchange_rate: balance.exchange_rate,
        vat_rate: balance.vat_rate,
        branch_code: balance.branch_code,
        ship_code: balance.ship_code,
        billed_amount: source.billed_amount,
        remark: source.billing_remark || balance.remark || '',
      });
    }
    return res.json({ success: true, data: rows });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/ar-debt-payment/billing-detail', async (req, res) => {
  const custCode = safeText(req.query.cust_code);
  const docNos = String(req.query.doc_nos || '')
    .split(',')
    .map(safeText)
    .filter(Boolean);
  if (!custCode || !docNos.length) return res.json({ success: true, data: [] });
  try {
    await assertPermission(query, req.query.user_code || req.query.emp_code, VIEW_PERMISSION);
    const result = await query(
      `SELECT b.doc_no AS source_billing_no, h.doc_date AS source_billing_date,
              b.billing_no, b.billing_date, b.bill_type,
              CASE b.bill_type
                WHEN 44 THEN 'ขายเชื่อ'
                WHEN 46 THEN 'เพิ่มหนี้'
                WHEN 48 THEN 'ลดหนี้'
                WHEN 93 THEN 'ตั้งหนี้ยกมา'
                WHEN 95 THEN 'เพิ่มหนี้ยกมา'
                WHEN 97 THEN 'ลดหนี้ยกมา'
                WHEN 99 THEN 'ตั้งหนี้อื่น'
                WHEN 101 THEN 'เพิ่มหนี้อื่น'
                WHEN 103 THEN 'ลดหนี้อื่น'
                ELSE b.bill_type::text
              END AS bill_type_name,
              COALESCE(b.ref_doc_no,'') AS ref_doc_no, b.ref_doc_date, b.due_date,
              COALESCE(b.sum_debt_amount,0) AS sum_debt_amount,
              COALESCE(b.sum_pay_money,0) AS billed_amount,
              GREATEST(ROUND(
                COALESCE(b.sum_pay_money,0)
                - COALESCE((
                  SELECT SUM(p.sum_pay_money)
                  FROM ap_ar_trans_detail p
                  WHERE p.trans_flag = $3
                    AND COALESCE(p.last_status,0) = 0
                    AND p.doc_ref = b.doc_no
                    AND p.billing_no = b.billing_no
                    AND p.bill_type = b.bill_type
                ),0), 2), 0) AS balance_ref,
              COALESCE(b.remark,'') AS remark
       FROM ap_ar_trans_detail b
       JOIN ap_ar_trans h ON h.doc_no = b.doc_no AND h.trans_flag = b.trans_flag
       WHERE b.trans_flag = $1
         AND b.doc_no = ANY($2::text[])
         AND h.cust_code = $4
         AND COALESCE(h.doc_success,0) = 0
         AND COALESCE(h.last_status,0) = 0
         AND COALESCE(b.last_status,0) = 0
         AND GREATEST(ROUND(
           COALESCE(b.sum_pay_money,0)
           - COALESCE((
             SELECT SUM(p.sum_pay_money)
             FROM ap_ar_trans_detail p
             WHERE p.trans_flag = $3
               AND COALESCE(p.last_status,0) = 0
               AND p.doc_ref = b.doc_no
               AND p.billing_no = b.billing_no
               AND p.bill_type = b.bill_type
           ),0), 2), 0) > 0
       ORDER BY h.doc_date, b.doc_no, b.line_number, b.roworder`,
      [BILLING_TRANS_FLAG, docNos, TRANS_FLAG, custCode],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/ar-debt-payment/detail', async (req, res) => {
  const docNo = safeText(req.query.doc_no);
  if (!docNo) return res.status(400).json({ success: false, msg: 'doc_no is required' });
  try {
    await assertAnyPermission(query, req.query.user_code || req.query.emp_code, READ_PERMISSIONS);
    const [header, details, refs, payment, paymentDetails, vatSale] = await Promise.all([
      query(
        `SELECT t.*, COALESCE(c.name_1,'') AS cust_name, COALESCE(c.address,'') AS cust_address,
                COALESCE(c.telephone,'') AS cust_telephone,
                COALESCE(cb.total_amount, t.total_net_value, 0) AS total_amount,
                COALESCE(cb.discount_amount,0) AS discount_amount,
                GREATEST(ROUND(COALESCE(t.total_net_value,0) - COALESCE(cb.discount_amount,0), 2), 0) AS total_after_discount
         FROM ap_ar_trans t
         LEFT JOIN ar_customer c ON c.code = t.cust_code
         LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = t.trans_flag
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
      query(
        `SELECT billing_no, billing_date, remark
         FROM ap_ar_trans_detail
         WHERE doc_no = $1 AND trans_flag = $2
         ORDER BY line_number, roworder`,
        [docNo, REF_TRANS_FLAG],
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
         FROM gl_journal_vat_sale
         WHERE doc_no = $1 AND trans_flag = $2
         ORDER BY line_number, roworder`,
        [docNo, TRANS_FLAG],
      ),
    ]);
    if (!header.rows[0]) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({
      success: true,
      data: {
        header: header.rows[0],
        details: details.rows,
        refs: refs.rows,
        payment: payment.rows[0] || null,
        payment_detail: paymentDetails.rows,
        vat_sale: vatSale.rows,
      },
    });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/ar-debt-payment/print-forms', async (req, res) => {
  const docNo = safeText(req.query.doc_no);
  if (!docNo) return res.status(400).json({ success: false, msg: 'doc_no is required' });
  try {
    await assertAnyPermission(query, req.query.user_code || req.query.emp_code, READ_PERMISSIONS);
    const options = await loadPrintFormOptions(docNo);
    if (!options) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({ success: true, data: options });
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/ar-debt-payment/print/render', async (req, res) => {
  const { doc_no = '', formcodes = '', auto_print = '1', log_print, user_code = '' } = req.query;
  const docNo = safeText(doc_no);
  if (!docNo) return res.status(400).type('text/plain').send('doc_no is required');

  try {
    await assertAnyPermission(query, user_code || req.query.emp_code, READ_PERMISSIONS);
    const [options, printData] = await Promise.all([
      loadPrintFormOptions(docNo),
      loadArDebtPaymentPrintDocument(docNo),
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
      pageSize: 'Letter',
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('html').send(html);
  } catch (ex) {
    if (isPermissionError(ex)) return res.status(403).type('text/plain').send(ex.message);
    return res.status(500).type('text/plain').send(ex.message);
  }
});

router.post('/ar-debt-payment/save', async (req, res) => {
  try {
    const payload = normalizePayload(req.body);
    const docDate = normalizeDate(payload.doc_date);
    const docTime = safeText(payload.doc_time) || currentTimeText();
    const custCode = safeText(payload.cust_code);
    const details = normalizeDetails(payload.details);
    const payments = normalizePayments(payload.payments);
    const vatSaleRows = normalizeVatSaleRows(payload.vat_sale || payload.vatsale || payload.screenvatsale);
    const saleCode = safeText(payload.sale_code);
    const branchCode = safeText(payload.branch_code);
    const requestUserCode = safeText(payload.emp_code) || safeText(payload.creator_code);
    const creatorCode = requestUserCode || 'smlstaff';
    const remark = safeText(payload.remark);
    const discountWord = safeText(payload.discount_word || payload.payments?.discount_word);

    if (!custCode) return res.status(400).json({ success: false, msg: 'cust_code is required' });
    if (!details.length) return res.status(400).json({ success: false, msg: 'details is empty' });

    const totalNetValue = roundMoney(details.reduce((sum, row) => sum + row.sum_pay_money, 0));
    const transferAmount = roundMoney(payments.transfer.reduce((sum, row) => sum + row.amount, 0));
    const cardAmount = roundMoney(payments.card.reduce((sum, row) => sum + row.amount + row.charge, 0));
    const cardCharge = roundMoney(payments.card.reduce((sum, row) => sum + row.charge, 0));
    const chequeAmount = roundMoney(payments.cheque.reduce((sum, row) => sum + row.amount, 0));
    const couponAmount = roundMoney(payments.coupon.reduce((sum, row) => sum + row.amount, 0));
    const depositAmount = roundMoney(payments.deposit.reduce((sum, row) => sum + row.amount, 0));
    const incomeOtherAmount = roundMoney(payments.income.reduce((sum, row) => sum + row.amount, 0));
    const expenseOtherAmount = roundMoney(payments.expense.reduce((sum, row) => sum + row.amount, 0));
    const totalPaid = roundMoney(
      payments.cash_amount
      + payments.petty_cash_amount
      + transferAmount
      + cardAmount
      + chequeAmount
      + couponAmount
      + depositAmount
      + expenseOtherAmount
      + payments.total_income_amount
      + payments.discount_amount,
    );
    const totalDue = roundMoney(totalNetValue + cardCharge + incomeOtherAmount);
    const diff = roundMoney(totalPaid - totalDue);
    if (diff < -0.01) return res.status(400).json({ success: false, msg: 'payment total is less than document total' });
    if (diff > 0.01) return res.status(400).json({ success: false, msg: 'payment total is greater than document total' });

    let savedDocNo = '';
    let savedDocFormatCode = '';
    let savedFormCode = '';

    await withTransaction(async (client) => {
      await assertCreatePermission(client, requestUserCode);
      const customer = await client.query('SELECT code FROM ar_customer WHERE code = $1 LIMIT 1', [custCode]);
      if (!customer.rows[0]) throw new Error('customer not found');
      const profile = await loadArDebtPaymentProfile(client.query.bind(client), requestUserCode);

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

      const sourceBillingNos = [...new Set(details.map((row) => row.source_billing_no).filter(Boolean))];
      const billNoteRows = details.filter((row) => row.source_billing_no);
      const directRows = details.filter((row) => !row.source_billing_no);
      if (profile.arPayFromBillNote && directRows.length) {
        throw new Error('billing note reference is required');
      }

      const validMap = new Map();
      if (billNoteRows.length) {
        const validation = await client.query(
          `SELECT b.doc_no AS source_billing_no, b.billing_no, b.bill_type,
                  COALESCE(b.sum_debt_amount,0) AS sum_debt_amount,
                  COALESCE(b.sum_pay_money,0) AS billed_amount,
                  b.billing_date, b.due_date, b.ref_doc_no, b.ref_doc_date,
                  GREATEST(ROUND(
                    COALESCE(b.sum_pay_money,0)
                    - COALESCE((
                      SELECT SUM(p.sum_pay_money)
                      FROM ap_ar_trans_detail p
                      WHERE p.trans_flag = $3
                        AND COALESCE(p.last_status,0) = 0
                        AND p.doc_ref = b.doc_no
                        AND p.billing_no = b.billing_no
                        AND p.bill_type = b.bill_type
                    ),0), 2), 0) AS balance_ref
           FROM ap_ar_trans_detail b
           JOIN ap_ar_trans h ON h.doc_no = b.doc_no AND h.trans_flag = b.trans_flag
           WHERE b.trans_flag = $1
             AND b.doc_no = ANY($2::text[])
             AND h.cust_code = $4
             AND COALESCE(h.doc_success,0) = 0
             AND COALESCE(h.last_status,0) = 0
             AND COALESCE(b.last_status,0) = 0`,
          [BILLING_TRANS_FLAG, sourceBillingNos, TRANS_FLAG, custCode],
        );
        for (const row of validation.rows) {
          validMap.set(`${row.source_billing_no}|${row.billing_no}|${row.bill_type}`, row);
        }
        const noteDocNos = billNoteRows.map((row) => row.billing_no);
        const noteBillTypes = billNoteRows.map((row) => row.bill_type);
        const params = [];
        const idx = {
          custCode: params.push(custCode),
          docDate: params.push(docDate),
          saleFlags: params.push(SALE_FLAGS),
          debitFlags: params.push(DEBIT_NOTE_FLAGS),
          creditFlags: params.push(CREDIT_NOTE_FLAGS),
          docNos: params.push(noteDocNos),
          billTypes: params.push(noteBillTypes),
        };
        const balanceCte = withDebtBalanceParams(
          arDebtBalanceCte({ includeDocKeys: true }),
          idx,
        );
        const balances = await client.query(
          `${balanceCte}
           SELECT doc_no AS billing_no, bill_type, sum_debt_amount,
                  doc_date AS billing_date, due_date, ref_doc_no, ref_doc_date,
                  ROUND(balance_ref,2) AS balance_ref
           FROM debt_balance_docs`,
          params,
        );
        const balanceMap = new Map(balances.rows.map((row) => [`${row.billing_no}|${row.bill_type}`, row]));
        for (const [key, row] of validMap.entries()) {
          if (!row.source_billing_no) continue;
          const balance = balanceMap.get(`${row.billing_no}|${row.bill_type}`);
          if (balance) validMap.set(key, { ...row, ...balance });
        }
      }

      if (directRows.length) {
        const docNos = directRows.map((row) => row.billing_no);
        const billTypes = directRows.map((row) => row.bill_type);
        const params = [];
        const idx = {
          custCode: params.push(custCode),
          docDate: params.push(docDate),
          saleFlags: params.push(SALE_FLAGS),
          debitFlags: params.push(DEBIT_NOTE_FLAGS),
          creditFlags: params.push(CREDIT_NOTE_FLAGS),
          docNos: params.push(docNos),
          billTypes: params.push(billTypes),
        };
        const directCte = withDebtBalanceParams(
          arDebtBalanceCte({ includeDocKeys: true }),
          idx,
        );
        const validation = await client.query(
          `${directCte}
           SELECT '' AS source_billing_no,
                  doc_no AS billing_no,
                  bill_type,
                  sum_debt_amount,
                  sum_debt_amount AS billed_amount,
                  doc_date AS billing_date,
                  due_date,
                  ref_doc_no,
                  ref_doc_date,
                  ROUND(balance_ref,2) AS balance_ref
           FROM debt_balance_docs`,
          params,
        );
        for (const row of validation.rows) {
          validMap.set(`|${row.billing_no}|${row.bill_type}`, row);
        }
      }

      const detailTotals = new Map();
      for (const row of details) {
        const key = `${row.source_billing_no}|${row.billing_no}|${row.bill_type}`;
        detailTotals.set(key, roundMoney((detailTotals.get(key) || 0) + row.sum_pay_money));
      }
      for (const row of details) {
        const key = `${row.source_billing_no}|${row.billing_no}|${row.bill_type}`;
        const original = validMap.get(key);
        if (!original) throw new Error(`billing detail not found: ${row.source_billing_no ? `${row.source_billing_no}/` : ''}${row.billing_no}`);
        const balance = roundMoney(original.balance_ref);
        if (amountExceedsBalance(detailTotals.get(key) || 0, balance)) {
          throw new Error(`sum_pay_money exceeds balance: ${row.billing_no}`);
        }
      }

      if (payments.deposit.length) {
        const depositNos = [...new Set(payments.deposit.map((row) => row.trans_number).filter(Boolean))];
        const depositRows = await client.query(
          `SELECT x.doc_no,
                  GREATEST(ROUND(COALESCE(x.total_amount,0) - COALESCE(x.used_amount,0), 2), 0) AS balance_amount
           FROM (
             SELECT h.doc_no,
                    COALESCE(h.total_amount, 0) AS total_amount,
                    COALESCE((
                      SELECT SUM(d.amount)
                      FROM cb_trans_detail d
                      JOIN cb_trans cb ON cb.doc_no = d.doc_no AND cb.trans_flag = d.trans_flag
                      WHERE d.doc_type = 5
                        AND d.trans_number = h.doc_no
                        AND COALESCE(d.last_status,0) = 0
                    ),0) AS used_amount
             FROM ic_trans h
             WHERE h.trans_flag IN (40,9040)
               AND h.cust_code = $1
               AND h.doc_no = ANY($2::text[])
               AND COALESCE(h.last_status,0) = 0
           ) x`,
          [custCode, depositNos],
        );
        const depositMap = new Map(depositRows.rows.map((row) => [row.doc_no, roundMoney(row.balance_amount)]));
        for (const row of payments.deposit) {
          if (!row.trans_number) throw new Error('advance/deposit document number is required');
          const balance = depositMap.get(row.trans_number);
          if (balance === undefined) throw new Error(`advance/deposit not found: ${row.trans_number}`);
          if (row.amount > balance + 0.01) throw new Error(`advance/deposit exceeds balance: ${row.trans_number}`);
        }
      }

      await client.query(
        `INSERT INTO ap_ar_trans (
          trans_type, trans_flag, doc_date, doc_no, cust_code, sale_code, remark,
          total_net_value, doc_time, doc_format_code, last_status, used_status,
          doc_success, creator_code, create_datetime, branch_code, is_cancel, discount_word
        ) VALUES (
          $1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,0,0,0,$11,NOW(),$12,0,$13
        )`,
        [
          TRANS_TYPE, TRANS_FLAG, docDate, savedDocNo, custCode, saleCode,
          remark, totalNetValue, docTime, savedDocFormatCode, creatorCode, branchCode, discountWord,
        ],
      );

      for (let i = 0; i < details.length; i++) {
        const row = details[i];
        const original = validMap.get(`${row.source_billing_no}|${row.billing_no}|${row.bill_type}`);
        const beforeBalance = roundMoney(original.balance_ref);
        await client.query(
          `INSERT INTO ap_ar_trans_detail (
            trans_type, trans_flag, doc_date, doc_no, doc_ref, billing_no,
            billing_date, due_date, bill_type, ref_doc_no, ref_doc_date,
            sum_debt_amount, balance_ref, sum_pay_money, remark,
            line_number, last_status, calc_flag, cust_code, creator_code, create_datetime
          ) VALUES (
            $1,$2,$3::date,$4,$5,$6,$7::date,$8::date,$9,$10,$11::date,
            $12,$13,$14,$15,$16,0,0,'',$17,NOW()
          )`,
          [
            TRANS_TYPE, TRANS_FLAG, docDate, savedDocNo, row.source_billing_no,
            row.billing_no, row.billing_date || dateToISO(original.billing_date, docDate),
            row.due_date || dateToISO(original.due_date, docDate),
            row.bill_type, safeText(original.ref_doc_no || row.ref_doc_no),
            nullableDateToISO(original.ref_doc_date || row.ref_doc_date),
            roundMoney(original.sum_debt_amount || row.sum_debt_amount),
            beforeBalance, row.sum_pay_money, row.remark, i, creatorCode,
          ],
        );
      }

      const refRows = await client.query(
        `SELECT doc_no, doc_date, remark
         FROM ap_ar_trans
         WHERE trans_flag = $1 AND doc_no = ANY($2::text[])`,
        [BILLING_TRANS_FLAG, sourceBillingNos],
      );
      for (let i = 0; i < refRows.rows.length; i++) {
        const row = refRows.rows[i];
        await client.query(
          `INSERT INTO ap_ar_trans_detail (
            trans_type, trans_flag, doc_date, doc_no, billing_no, billing_date,
            remark, line_number, last_status, creator_code, create_datetime
          ) VALUES ($1,$2,$3::date,$4,$5,$6::date,$7,$8,0,$9,NOW())`,
          [
            TRANS_TYPE, REF_TRANS_FLAG, docDate, savedDocNo, row.doc_no,
            dateToISO(row.doc_date, docDate), safeText(row.remark), i, creatorCode,
          ],
        );
      }

      await insertVatSaleRows(client, {
        docNo: savedDocNo,
        docDate,
        custCode,
        branchCode,
        rows: vatSaleRows,
      });

      await client.query(
        `INSERT INTO cb_trans (
          trans_type, trans_flag, doc_no, doc_date, doc_time, ap_ar_code,
          pay_type, doc_format_code, total_amount, total_net_amount, cash_amount,
          chq_amount, tranfer_amount, card_amount, total_amount_pay,
          total_income_amount, petty_cash_amount, discount_amount,
          coupon_amount, deposit_amount, total_income_other, total_expense_other,
          total_credit_charge, remark
        ) VALUES (
          $1,$2,$3,$4::date,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
        )`,
        [
          TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime, custCode,
          savedDocFormatCode, totalNetValue, totalDue, payments.cash_amount,
          chequeAmount, transferAmount, cardAmount, totalPaid,
          payments.total_income_amount, payments.petty_cash_amount,
          payments.discount_amount, couponAmount, depositAmount,
          incomeOtherAmount, expenseOtherAmount, cardCharge, remark,
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
          ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,3,$10,1,1,$11,$6,$12,0)`,
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
            trans_type, trans_flag, doc_no, doc_date, doc_time, bank_code,
            bank_branch, trans_number, amount, sum_amount, chq_due_date, doc_type,
            ap_ar_code, trans_number_type, ap_ar_type, last_status
          ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$9,$10::date,2,$11,1,1,0)`,
          [
            TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime,
            row.bank_code, row.bank_branch, row.trans_number, row.amount,
            row.chq_due_date || docDate, custCode,
          ],
        );
      }

      for (const row of payments.deposit) {
        await insertSimplePaymentDetail(client, {
          docNo: savedDocNo,
          docDate,
          docTime,
          row,
          docType: 5,
        });
      }

      for (const row of payments.coupon) {
        await insertSimplePaymentDetail(client, {
          docNo: savedDocNo,
          docDate,
          docTime,
          row,
          docType: 9,
        });
      }

      for (const row of payments.expense) {
        await insertSimplePaymentDetail(client, {
          docNo: savedDocNo,
          docDate,
          docTime,
          row,
          docType: 11,
        });
      }

      for (const row of payments.income) {
        await insertSimplePaymentDetail(client, {
          docNo: savedDocNo,
          docDate,
          docTime,
          row,
          docType: 12,
        });
      }

      await updateBillingStatuses(client, sourceBillingNos, details);
    });

    return res.json({
      success: true,
      doc_no: savedDocNo,
      doc_format_code: savedDocFormatCode,
      form_code: savedFormCode,
      total_net_value: totalNetValue,
      msg: 'success',
    });
  } catch (ex) {
    if (ex.message && ex.message.includes('not found')) return res.status(404).json({ success: false, msg: ex.message });
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    if (ex.message && (ex.message.includes('exceeds balance') || ex.message.includes('reference is required'))) return res.status(400).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

module.exports = router;

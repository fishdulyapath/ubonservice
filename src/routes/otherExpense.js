const express = require('express');
const router = express.Router();
const { withTransaction, query } = require('../db');
const { resolveDocumentNo } = require('../utils/docFormat');
const { getEmployeePermissions } = require('../utils/permissions');

const TRANS_TYPE = 1;
const TRANS_FLAG = 260;
const SCREEN_CODE = 'EPO';
const OTHER_EXPENSE_VIEW_PERMISSION = 'cash.other_expense.view';
const OTHER_EXPENSE_CREATE_PERMISSION = 'cash.other_expense.create';

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

function normalizePayload(body) {
  let payload = body || {};
  if (typeof payload === 'string') payload = JSON.parse(payload);
  if (payload && typeof payload.payload === 'object') payload = payload.payload;
  return payload || {};
}

function calcVatTotals(baseAmount, vatType = 0, vatRate = 0) {
  const amount = roundMoney(baseAmount);
  const rate = roundMoney(vatRate);
  if (rate <= 0 || toInt(vatType, 0) === 0) {
    return {
      total_value: amount,
      total_before_vat: amount,
      total_vat_value: 0,
      total_except_vat: amount,
      total_amount: amount,
    };
  }
  if (toInt(vatType, 0) === 1) {
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
  return {
    cash_amount: roundMoney(source.cash_amount),
    transfer: transfer
      .map((row) => ({
        pass_book_code: safeText(row?.pass_book_code || row?.trans_number),
        bank_code: safeText(row?.bank_code),
        bank_branch: safeText(row?.bank_branch),
        amount: roundMoney(row?.amount ?? row?.pay_amount),
      }))
      .filter((row) => row.amount > 0),
    card: card
      .map((row) => ({
        credit_card_type: safeText(row?.credit_card_type || row?.credit_type) || 'WR',
        trans_number: safeText(row?.trans_number) || '1',
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
        income_type: safeText(row?.income_type) || 'ค่าบริการ',
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
              t.tax_doc_date, COALESCE(t.vat_type,0) AS vat_type, COALESCE(t.vat_rate,0) AS vat_rate,
              COALESCE(t.total_value,0) AS total_value, COALESCE(t.total_before_vat,0) AS total_before_vat,
              COALESCE(t.total_vat_value,0) AS total_vat_value, COALESCE(t.total_amount,0) AS total_amount,
              COALESCE(w.wht_tax_value, COALESCE(cb.total_tax_at_pay,0), 0) AS total_wht_value,
              COALESCE(cb.total_net_amount, COALESCE(t.total_amount,0) - COALESCE(w.wht_tax_value,0)) AS total_net_payable,
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

router.post('/other-expense/save', async (req, res) => {
  try {
    const payload = normalizePayload(req.body);
    const docDate = normalizeDate(payload.doc_date);
    const docTime = safeText(payload.doc_time) || currentTimeText();
    const supplierCode = safeText(payload.cust_code || payload.supplier_code);
    const requestUserCode = safeText(payload.emp_code) || safeText(payload.creator_code);
    const creatorCode = requestUserCode || 'smlstaff';
    const details = normalizeDetails(payload.details);
    const payments = normalizePayments(payload.payments);
    const whtList = normalizeWhtList(payload.wht_list || payload.withholding_tax, docDate);
    const vatType = toInt(payload.vat_type, 0);
    const vatRate = roundMoney(payload.vat_rate);
    const branchCode = safeText(payload.branch_code);
    const remark = safeText(payload.remark);
    const taxDocNo = safeText(payload.tax_doc_no);
    const taxDocDate = normalizeNullableDate(payload.tax_doc_date);

    if (!supplierCode) return res.status(400).json({ success: false, msg: 'supplier_code is required' });
    if (!details.length) return res.status(400).json({ success: false, msg: 'details is empty' });
    if (![0, 1, 2].includes(vatType)) return res.status(400).json({ success: false, msg: 'vat_type must be 0, 1, or 2' });
    const invalidWht = whtList.find((row) => Math.abs(row.tax_value - row.submitted_tax_value) > 0.01);
    if (invalidWht) return res.status(400).json({ success: false, msg: 'withholding tax value does not match amount and tax rate' });

    const detailAmount = roundMoney(details.reduce((sum, row) => sum + row.amount, 0));
    const totals = calcVatTotals(detailAmount, vatType, vatRate);
    const transferAmount = roundMoney(payments.transfer.reduce((sum, row) => sum + row.amount, 0));
    const cardAmount = roundMoney(payments.card.reduce((sum, row) => sum + row.amount + row.charge, 0));
    const cardCharge = roundMoney(payments.card.reduce((sum, row) => sum + row.charge, 0));
    const chequeAmount = roundMoney(payments.cheque.reduce((sum, row) => sum + row.amount, 0));
    const whtAmount = roundMoney(whtList.reduce((sum, row) => sum + row.tax_value, 0));
    const whtBaseAmount = roundMoney(whtList.reduce((sum, row) => sum + row.amount, 0));
    if (whtBaseAmount > totals.total_before_vat + 0.01) return res.status(400).json({ success: false, msg: 'withholding tax base is greater than document base' });
    if (whtAmount > totals.total_amount + 0.01) return res.status(400).json({ success: false, msg: 'withholding tax is greater than document total' });
    const totalNetAmount = roundMoney(totals.total_amount + cardCharge - whtAmount);
    const totalPaid = roundMoney(payments.cash_amount + transferAmount + cardAmount + chequeAmount);
    const diff = roundMoney(totalPaid - totalNetAmount);
    if (diff < -0.01) return res.status(400).json({ success: false, msg: 'payment total is less than document total' });
    if (diff > 0.01) return res.status(400).json({ success: false, msg: 'payment total is greater than document total' });

    let savedDocNo = '';
    let savedDocFormatCode = '';
    let savedFormCode = '';

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
          total_except_vat, total_amount, remark, doc_format_code, last_status,
          used_status, creator_code, create_datetime, is_cancel
        ) VALUES (
          $1,$2,$3::date,$4,$5,'',NULL,0,$6,$7,$8,$9,$10,$11::date,
          $12,$13,$14,$15,$16,$17,$18,0,0,$19,NOW(),0
        )`,
        [
          TRANS_TYPE, TRANS_FLAG, docDate, docTime, savedDocNo,
          vatType, supplierCode, branchCode, vatRate, taxDocNo || savedDocNo,
          taxDocDate || docDate, totals.total_value, totals.total_before_vat,
          totals.total_vat_value, totals.total_except_vat, totals.total_amount,
          remark, savedDocFormatCode, creatorCode,
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
            item_code, item_name, qty, price, sum_amount, sum_amount_exclude_vat,
            total_vat_value, branch_code, remark, line_number, calc_flag,
            last_status, creator_code, create_datetime
          ) VALUES (
            $1,$2,$3::date,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,$15,1,0,$16,NOW()
          )`,
          [
            TRANS_TYPE, TRANS_FLAG, docDate, docTime, savedDocNo, supplierCode,
            row.expense_code, itemName, row.amount, row.amount,
            rowVat.total_value, rowVat.total_vat_value, row.branch_code || branchCode,
            row.remark, i, creatorCode,
          ],
        );
      }

      if (totals.total_vat_value > 0) {
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
        const supplierRow = supplier.rows[0];
        const whtTaxDocNo = safeText(payload.wht_tax_doc_no) || savedDocNo;
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
            whtList[0].due_date || docDate, supplierCode, supplierRow.card_id || '',
            supplierRow.tax_id || '', toInt(supplierRow.ap_status, 0),
            supplierRow.name_1 || '', whtTaxDocNo, supplierRow.address || '',
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
              $1::date,$2,$3,$4,$5,$6,0,$7,$8::date,$9,$10,$11,$12
            )`,
            [
              docDate, savedDocNo, row.income_type, row.tax_rate, row.amount,
              row.tax_value, TRANS_FLAG, row.due_date || docDate, i,
              supplierCode, roundMoney(row.amount - row.tax_value), rowTaxDocNo,
            ],
          );
        }
      }

      await client.query(
        `INSERT INTO cb_trans (
          trans_type, trans_flag, doc_no, doc_date, doc_time, ap_ar_code,
          pay_type, doc_format_code, total_amount, total_net_amount, cash_amount,
          chq_amount, tranfer_amount, card_amount, total_amount_pay,
          total_credit_charge, total_tax_at_pay, pay_cash_amount, money_change,
          remark
        ) VALUES (
          $1,$2,$3,$4::date,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$10,0,$17
        )`,
        [
          TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime, supplierCode,
          savedDocFormatCode, totals.total_amount, totalNetAmount,
          payments.cash_amount, chequeAmount, transferAmount, cardAmount,
          totalPaid, cardCharge, whtAmount, remark,
        ],
      );

      for (const row of payments.transfer) {
        const passBook = await getPassBook(client, row.pass_book_code);
        if (!passBook) throw new Error(`pass book not found: ${row.pass_book_code}`);
        await client.query(
          `INSERT INTO cb_trans_detail (
            trans_type, trans_flag, doc_no, doc_date, doc_time, trans_number,
            bank_code, bank_branch, amount, sum_amount, doc_type, ap_ar_code,
            trans_number_type, ap_ar_type, last_status
          ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$9,1,$10,0,0,0)`,
          [
            TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime,
            passBook.code, passBook.bank_code || row.bank_code,
            passBook.bank_branch || row.bank_branch, row.amount, supplierCode,
          ],
        );
      }

      for (const row of payments.card) {
        await client.query(
          `INSERT INTO cb_trans_detail (
            trans_type, trans_flag, doc_no, doc_date, doc_time, trans_number,
            credit_card_type, amount, sum_amount, doc_type, ap_ar_code,
            trans_number_type, ap_ar_type, charge, last_status
          ) VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,3,$10,1,1,$11,0)`,
          [
            TRANS_TYPE, TRANS_FLAG, savedDocNo, docDate, docTime,
            row.trans_number, row.credit_card_type, row.amount,
            roundMoney(row.amount + row.charge), supplierCode, row.charge,
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
    });

    return res.json({
      success: true,
      doc_no: savedDocNo,
      doc_format_code: savedDocFormatCode,
      form_code: savedFormCode,
      wht_amount: whtAmount,
      msg: 'success',
    });
  } catch (ex) {
    if (ex.message && ex.message.includes('not found')) return res.status(404).json({ success: false, msg: ex.message });
    if (isPermissionError(ex)) return res.status(403).json({ success: false, msg: ex.message });
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

module.exports = router;

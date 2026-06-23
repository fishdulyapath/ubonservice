const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool, query } = require('../db');
const { successResponse, failResponse } = require('../utils/response');
const { resolveDocFormat, resolveDocumentNo } = require('../utils/docFormat');
const { getEmployeePermissions } = require('../utils/permissions');

const PU_TRANS_FLAG = 12;
const PO_TRANS_FLAG = 6;
const PU_CREATE_PERMISSION = 'purchase.pu.create';
const PU_EDIT_PERMISSION = 'purchase.pu.edit';

function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
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

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function roundPoint(value, point = 2) {
  const factor = Math.pow(10, point);
  return Math.round(toNumber(value) * factor) / factor;
}

function calcAfterDiscount(discountWord, amount, point = 2, qty = 1, alwaysRound = true) {
  if (!discountWord || !String(discountWord).trim()) return toNumber(amount);
  let result = toNumber(amount);
  for (const raw of String(discountWord).replace(/\s/g, '').split(',')) {
    const token = raw.trim();
    if (!token) continue;
    if (token.startsWith('@')) {
      const val = parseFloat(token.slice(1)) || 0;
      result -= alwaysRound ? roundPoint(val * toNumber(qty), point) : val * toNumber(qty);
    } else if (token.includes('%')) {
      const pct = parseFloat(token.replace(/%/g, '')) || 0;
      result -= alwaysRound ? roundPoint((pct / 100) * result, point) : (pct / 100) * result;
    } else {
      const val = parseFloat(token) || 0;
      result -= alwaysRound ? roundPoint(val, point) : val;
    }
  }
  return roundPoint(result, point);
}

function isPermiumItem(item) {
  // ic_trans_detail.is_permium (1=ของแถม) — สะกดตาม schema ต้นฉบับ
  return String(item?.is_permium ?? item?.is_premium ?? '0') === '1';
}

function calcPULineAmounts(item) {
  const qty = toNumber(item?.qty);
  // ของแถม (is_permium=1): บังคับ price/sum_amount = 0 ฝั่ง server กัน client ส่งผิด
  if (isPermiumItem(item)) {
    return {
      qty,
      price: 0,
      discount: '',
      discount_amount: 0,
      sum_amount: 0,
      is_permium: 1,
    };
  }
  const price = toNumber(item?.price);
  const gross = roundMoney(price * qty);
  const discountWord = String(item?.discount || '').trim()
    || (toNumber(item?.discount_amount) ? String(item.discount_amount) : '');
  const net = discountWord ? calcAfterDiscount(discountWord, gross, 2, qty) : gross;
  return {
    qty,
    price,
    discount: discountWord,
    discount_amount: roundMoney(gross - net),
    sum_amount: Math.max(0, roundMoney(net)),
    is_permium: 0,
  };
}

function normalizePUItem(item) {
  const amounts = calcPULineAmounts(item);
  return {
    ...item,
    qty: amounts.qty,
    price: amounts.price,
    discount: amounts.discount,
    discount_amount: amounts.discount_amount,
    sum_amount: amounts.sum_amount,
    is_permium: amounts.is_permium,
  };
}

function toInt(value, fallback = 0) {
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeText(value) {
  return String(value ?? '').trim();
}

function paymentTransferAmount(payment) {
  return toNumber(payment?.pay_amount ?? payment?.amount);
}

function paymentTransferAccount(payment) {
  return safeText(payment?.pass_book_code || payment?.trans_number);
}

function validateTransferPaymentDetail(payments, transferAmount) {
  const normalizedTransferAmount = roundMoney(transferAmount);
  const paymentTotal = roundMoney(payments.reduce((sum, payment) => sum + paymentTransferAmount(payment), 0));
  const invalidLines = payments
    .map((payment, index) => ({
      line: index + 1,
      amount: paymentTransferAmount(payment),
      passBook: paymentTransferAccount(payment),
    }))
    .filter((payment) => payment.amount <= 0 || !payment.passBook);

  const errors = [];
  if (invalidLines.length) {
    errors.push(`invalid transfer payment rows: ${invalidLines.map((row) => row.line).join(', ')}`);
  }
  if (normalizedTransferAmount > 0 && payments.length === 0) {
    errors.push('transfer payment_detail is required when transfer_amount is greater than 0');
  }
  if (Math.abs(roundMoney(paymentTotal - normalizedTransferAmount)) > 0.01) {
    errors.push(`transfer payment_detail total must equal transfer_amount: detail ${paymentTotal}, transfer ${normalizedTransferAmount}`);
  }
  return {
    errors,
    paymentTotal,
  };
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

function normalizeSavePayload(body) {
  let payload = body || {};
  if (typeof payload === 'string') payload = JSON.parse(payload);
  if (payload && typeof payload.payload === 'object') payload = payload.payload;
  return payload || {};
}

function requestedMode(body, payload) {
  const mode = String(body?.mode || payload?.mode || '').trim().toLowerCase();
  if (mode === 'update' || mode === 'create') return mode;
  return String(payload?.doc_no || '').trim() ? 'update' : 'create';
}

function buildPUSaveWritePlan({ mode, itemCount, poCount, paymentCount, isCashSale }) {
  const steps = [];
  if (mode === 'update') {
    steps.push({ table: 'ic_trans', action: 'update', rows: 1, scope: `doc_no + trans_flag=${PU_TRANS_FLAG}` });
    steps.push({ table: 'ic_trans_detail', action: 'delete_insert', rows: itemCount, scope: `doc_no + trans_flag=${PU_TRANS_FLAG}` });
    steps.push({ table: 'gl_journal_vat_buy', action: 'update', rows: 1, scope: `doc_no + trans_flag=${PU_TRANS_FLAG}` });
    steps.push({ table: 'ap_ar_trans_detail', action: 'rebuild', rows: poCount, scope: `doc_no + trans_flag=${PU_TRANS_FLAG}` });
  } else {
    steps.push({ table: 'ic_trans', action: 'insert', rows: 1, scope: `trans_flag=${PU_TRANS_FLAG}` });
    steps.push({ table: 'ic_trans_detail', action: 'insert', rows: itemCount, scope: `trans_flag=${PU_TRANS_FLAG}` });
    steps.push({ table: 'gl_journal_vat_buy', action: 'insert', rows: 1, scope: `trans_flag=${PU_TRANS_FLAG}` });
    steps.push({ table: 'ap_ar_trans_detail', action: 'insert', rows: poCount, scope: `trans_flag=${PU_TRANS_FLAG}` });
  }
  if (poCount > 0) {
    steps.push({ table: 'ic_trans', action: 'update_po_status', rows: poCount, scope: `PO trans_flag=${PO_TRANS_FLAG}` });
  }
  steps.push({ table: 'process', action: 'insert', rows: itemCount, scope: "process_name='IC'" });
  steps.push({ table: 'logs', action: 'insert', rows: 1, scope: `screen_code=${PU_TRANS_FLAG}` });
  if (isCashSale) {
    steps.push({ table: 'cb_trans', action: mode === 'update' ? 'delete_insert' : 'insert', rows: 1, scope: `trans_flag=${PU_TRANS_FLAG}` });
    steps.push({ table: 'cb_trans_detail', action: mode === 'update' ? 'delete_insert' : 'insert', rows: paymentCount, scope: `trans_flag=${PU_TRANS_FLAG}` });
  }
  return steps;
}

async function employeeHasPermission(client, userCode, permissionKey) {
  const code = safeText(userCode);
  if (!code) return false;
  const permissions = await getEmployeePermissions(client.query.bind(client), code);
  return permissions.includes(permissionKey);
}

async function requirePUSavePermission(client, payload, mode) {
  const userCode = safeText(payload.emp_code);
  const permissionKey = mode === 'update' ? PU_EDIT_PERMISSION : PU_CREATE_PERMISSION;
  if (!userCode) throw new Error('emp_code is required for PU save permission check');
  if (!(await employeeHasPermission(client, userCode, permissionKey))) {
    throw new Error(`permission denied: ${permissionKey}`);
  }
}

async function getCurrentPURefs(client, currentDocNo) {
  const docNo = safeText(currentDocNo);
  if (!docNo) return new Set();
  const result = await client.query(
    `SELECT billing_no
     FROM ap_ar_trans_detail
     WHERE doc_no = $1 AND trans_flag = $2`,
    [docNo, PU_TRANS_FLAG],
  );
  return new Set(result.rows.map((row) => safeText(row.billing_no)).filter(Boolean));
}

async function validatePUSavePlan(client, body) {
  const payload = normalizeSavePayload(body);
  const mode = requestedMode(body, payload);
  const errors = [];
  const warnings = [];

  const docDate = normalizeDate(payload.doc_date);
  const docNo = String(payload.doc_no || '').trim();
  const docFormatCode = String(payload.doc_format_code || '').trim();
  const supplierCode = String(payload.cust_code || payload.ap_cust_code || '').trim();
  const docTime = String(payload.doc_time || '').trim();
  const saleType = String(payload.sale_type ?? payload.inquiry_type ?? '0');
  const taxType = String(payload.tax_type ?? payload.vat_type ?? '1');
  const taxDocNo = safeText(payload.tax_doc_no);
  const whFrom = safeText(payload.wh_from);
  const locationFrom = safeText(payload.location_from);
  const items = normalizeArray(payload.items);
  const docList = normalizeArray(payload.doc_list);
  const payments = normalizeArray(payload.payment_detail);
  const poDocs = uniqueCodes(docList.map((row) => String(row?.doc_no || '').trim()).filter(Boolean));
  const isCashSale = saleType === '1' || saleType === '3';

  if (mode === 'update' && !docNo) errors.push('doc_no is required for update');
  if (!docDate) errors.push('doc_date is required as YYYY-MM-DD');
  if (!docTime) warnings.push('doc_time is empty; save should send current document time');
  if (!supplierCode) errors.push('cust_code is required');
  if (!docFormatCode && mode === 'create') errors.push('doc_format_code is required for PU create');
  if (!taxDocNo) errors.push('tax_doc_no is required');
  if (!whFrom) errors.push('wh_from is required');
  if (!locationFrom) errors.push('location_from is required');
  if (items.length === 0) errors.push('items is empty');

  const invalidItems = [];
  const missingWhRows = [];
  const missingShelfRows = [];
  const recalculatedAmountRows = [];
  const freeItemRows = [];
  for (const [index, item] of items.entries()) {
    const code = String(item?.item_code || '').trim();
    const unit = String(item?.unit_code || '').trim();
    const qty = toNumber(item?.qty);
    const expected = calcPULineAmounts(item);
    if (!code || !unit || qty <= 0) {
      invalidItems.push({ line: index + 1, item_code: code, unit_code: unit, qty });
    }
    if (
      Math.abs(toNumber(item?.discount_amount) - expected.discount_amount) > 0.01
      || Math.abs(toNumber(item?.sum_amount) - expected.sum_amount) > 0.01
    ) {
      recalculatedAmountRows.push(index + 1);
    }
    if (!safeText(item?.wh_code)) missingWhRows.push(index + 1);
    if (!safeText(item?.shelf_code)) missingShelfRows.push(index + 1);
    if (expected.is_permium === 1) freeItemRows.push(index + 1);
  }
  if (invalidItems.length) errors.push(`invalid item rows: ${invalidItems.map((row) => row.line).join(', ')}`);
  if (missingWhRows.length) errors.push(`item wh_code is required: ${missingWhRows.join(', ')}`);
  if (missingShelfRows.length) errors.push(`item shelf_code is required: ${missingShelfRows.join(', ')}`);
  if (recalculatedAmountRows.length) {
    warnings.push(`line discount_amount/sum_amount will be recalculated on save: ${recalculatedAmountRows.join(', ')}`);
  }
  if (freeItemRows.length) {
    warnings.push(`free/bonus items (is_permium=1): lines ${freeItemRows.join(', ')}`);
  }

  let resolvedDoc = null;
  let existingDoc = null;
  const currentRefs = mode === 'update' ? await getCurrentPURefs(client, docNo) : new Set();

  if (docDate && docFormatCode && mode === 'create') {
    try {
      resolvedDoc = await resolveDocumentNo(client, {
        screenCode: 'PU',
        docFormatCode,
        docDate,
        transFlag: PU_TRANS_FLAG,
      });
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (supplierCode) {
    const supplierRes = await client.query(
      `SELECT code, COALESCE(name_1,'') AS name_1
       FROM ap_supplier
       WHERE code = $1
       LIMIT 1`,
      [supplierCode],
    );
    if (!supplierRes.rows[0]) errors.push(`supplier not found: ${supplierCode}`);
  }

  if (mode === 'update') {
    const existingRes = await client.query(
      `SELECT doc_no, doc_date, doc_format_code
       FROM ic_trans
       WHERE doc_no = $1 AND trans_flag = $2
       LIMIT 1`,
      [docNo, PU_TRANS_FLAG],
    );
    existingDoc = existingRes.rows[0] || null;
    if (!existingDoc) {
      errors.push(`PU document not found for update: ${docNo}`);
    } else if (docFormatCode && docFormatCode !== existingDoc.doc_format_code) {
      errors.push(`doc_format_code cannot be changed after create: ${existingDoc.doc_format_code}`);
    } else if (docFormatCode) {
      try {
        await resolveDocFormat(client, 'PU', docFormatCode);
      } catch (err) {
        errors.push(err.message);
      }
    }
  } else if (docNo) {
    const duplicateRes = await client.query(
      `SELECT 1
       FROM ic_trans
       WHERE doc_no = $1 AND trans_flag = $2
       LIMIT 1`,
      [docNo, PU_TRANS_FLAG],
    );
    if (duplicateRes.rows[0]) errors.push(`PU document already exists: ${docNo}`);
  }

  let poRows = [];
  if (poDocs.length) {
    const missingDocDate = docList
      .filter((row) => poDocs.includes(safeText(row?.doc_no)) && !normalizeDate(row?.doc_date))
      .map((row) => safeText(row?.doc_no));
    if (missingDocDate.length) errors.push(`PO doc_date is required: ${uniqueCodes(missingDocDate).join(', ')}`);

    const poRes = await client.query(
      `SELECT doc_no, doc_date, COALESCE(doc_success,0) AS doc_success, COALESCE(used_status,0) AS used_status
       FROM ic_trans
       WHERE trans_flag = $1 AND doc_no = ANY($2::text[])`,
      [PO_TRANS_FLAG, poDocs],
    );
    poRows = poRes.rows;
    const found = new Set(poRows.map((row) => row.doc_no));
    const missing = poDocs.filter((doc) => !found.has(doc));
    if (missing.length) errors.push(`PO not found: ${missing.join(', ')}`);

    const statusBlocked = poRows
      .filter((row) => toInt(row.doc_success) !== 0 && !currentRefs.has(row.doc_no))
      .map((row) => row.doc_no);
    if (statusBlocked.length) errors.push(`PO already completed: ${statusBlocked.join(', ')}`);
  } else {
    warnings.push('doc_list is empty; PU will be saved without PO references');
  }

  if (isCashSale) {
    const cashAmount = toNumber(payload.cash_amount);
    const transferAmount = toNumber(payload.transfer_amount);
    const totalAfterRounded = toNumber(payload.total_after_rounded, toNumber(payload.total_amount));
    const paidAmount = cashAmount + transferAmount;
    const paymentDiff = roundMoney(paidAmount - totalAfterRounded);
    if (paidAmount <= 0) errors.push('cash PU requires cash_amount or transfer_amount');
    else if (paymentDiff < 0) {
      errors.push(`cash PU payment is not enough: paid ${roundMoney(paidAmount)}, required ${roundMoney(totalAfterRounded)}`);
    }

    const transferValidation = validateTransferPaymentDetail(payments, transferAmount);
    errors.push(...transferValidation.errors);
  }

  const writePlan = buildPUSaveWritePlan({
    mode,
    itemCount: items.length,
    poCount: poDocs.length,
    paymentCount: payments.length,
    isCashSale,
  });

  return {
    mode,
    write_enabled: true,
    can_prepare_save: errors.length === 0,
    doc_no: mode === 'create' ? (docNo || resolvedDoc?.doc_no || '') : docNo,
    doc_format_code: docFormatCode || resolvedDoc?.doc_format_code || existingDoc?.doc_format_code || '',
    doc_format_name: resolvedDoc?.doc_format_name || '',
    form_code: resolvedDoc?.form_code || '',
    supplier_code: supplierCode,
    sale_type: Number(saleType),
    tax_type: Number(taxType),
    counts: {
      items: items.length,
      po_refs: poDocs.length,
      payment_detail: payments.length,
    },
    po_refs: poRows,
    errors,
    warnings: [
      ...warnings,
      'doc_no must be resolved again inside the final save transaction',
    ],
    write_plan: writePlan,
  };
}

function normalizedPUSaveFields(payload) {
  const docDate = normalizeDate(payload.doc_date);
  const taxDocDate = normalizeDate(payload.tax_doc_date) || docDate;
  const docRefDate = normalizeDate(payload.doc_ref_date);
  const saleType = toInt(payload.sale_type ?? payload.inquiry_type, 0);
  const taxType = toInt(payload.tax_type ?? payload.vat_type, 1);
  const totalAmount = toNumber(payload.total_amount);
  const totalAfterRounded = toNumber(payload.total_after_rounded, totalAmount) || totalAmount;
  const cashAmount = toNumber(payload.cash_amount);
  const transferAmount = toNumber(payload.transfer_amount);
  const roundedAmount = toNumber(payload.rounded_amount);

  return {
    docDate,
    docTime: safeText(payload.doc_time),
    docFormatCode: safeText(payload.doc_format_code),
    custCode: safeText(payload.cust_code || payload.ap_cust_code),
    branchCode: safeText(payload.branch_code),
    vatRate: toNumber(payload.vat_rate, 7),
    creatorCode: safeText(payload.emp_code),
    programCreatorCode: safeText(payload.creator_code),
    remark: String(payload.remark ?? ''),
    apCustCode: safeText(payload.ap_cust_code || payload.cust_code),
    apCustName: safeText(payload.ap_cust_name),
    apBranchCode: safeText(payload.ap_branch_code || payload.branch_code),
    apTaxId: safeText(payload.ap_tax_id),
    totalValue: toNumber(payload.total_value),
    totalBeforeVat: toNumber(payload.total_before_vat),
    totalExceptVat: toNumber(payload.total_except_vat),
    totalAfterVat: toNumber(payload.total_after_vat, totalAmount),
    totalVatValue: toNumber(payload.total_vat_value),
    totalAmount,
    totalDiscount: toNumber(payload.total_discount),
    discountWord: String(payload.discount_word ?? ''),
    saleType,
    taxType,
    docRef: safeText(payload.doc_ref),
    docRefDate,
    taxDocNo: safeText(payload.tax_doc_no),
    taxDocDate,
    cashAmount,
    transferAmount,
    roundedAmount,
    totalAfterRounded,
    whFrom: safeText(payload.wh_from),
    locationFrom: safeText(payload.location_from),
    items: normalizeArray(payload.items).map(normalizePUItem),
    docList: normalizeArray(payload.doc_list),
    payments: normalizeArray(payload.payment_detail),
    isCashSale: saleType === 1 || saleType === 3,
  };
}

async function supplierTaxInfo(client, fields) {
  const result = await client.query(
    `SELECT s.code,
            COALESCE(s.name_1,'') AS name_1,
            COALESCE(d.branch_code,'') AS branch_code,
            COALESCE(d.tax_id,'') AS tax_id
     FROM ap_supplier s
     LEFT JOIN ap_supplier_detail d ON d.ap_code = s.code
     WHERE s.code = $1
     LIMIT 1`,
    [fields.custCode],
  );
  const row = result.rows[0] || {};
  return {
    apCustCode: fields.apCustCode || row.code || fields.custCode,
    apCustName: fields.apCustName || row.name_1 || '',
    apBranchCode: fields.apBranchCode || row.branch_code || fields.branchCode,
    apTaxId: fields.apTaxId || row.tax_id || '',
  };
}

async function insertPUReferences(client, docNo, fields) {
  const poDocs = uniqueCodes(fields.docList.map((row) => safeText(row?.doc_no)).filter(Boolean));
  for (const poDocNo of poDocs) {
    const row = fields.docList.find((item) => safeText(item?.doc_no) === poDocNo) || {};
    const poDate = normalizeDate(row.doc_date);
    if (!poDate) throw new Error(`PO doc_date is required: ${poDocNo}`);
    await client.query(
      `INSERT INTO ap_ar_trans_detail
         (trans_type, trans_flag, doc_date, doc_no, billing_no, billing_date, calc_flag)
       VALUES (1, $1, $2::date, $3, $4, $5::date, 1)`,
      [PU_TRANS_FLAG, fields.docDate, docNo, poDocNo, poDate],
    );
  }
  return poDocs;
}

async function updatePOStatuses(client, newPoDocs, oldPoDocs) {
  const affected = uniqueCodes([...oldPoDocs, ...newPoDocs]);
  for (const poDocNo of affected) {
    const status = await client.query(
      `WITH po_items AS (
         SELECT item_code, unit_code, SUM(qty) AS po_qty
         FROM ic_trans_detail
         WHERE doc_no = $1 AND trans_flag = $2
         GROUP BY item_code, unit_code
       ),
       pu_items AS (
         SELECT d.item_code, d.unit_code, SUM(d.qty) AS pu_qty
         FROM ic_trans_detail d
         JOIN ap_ar_trans_detail ref
           ON ref.doc_no = d.doc_no
          AND ref.billing_no = $1
          AND ref.trans_flag IN ($3,310)
         WHERE d.trans_flag IN ($3,310)
           AND COALESCE(d.ref_doc_no,'') = $1
         GROUP BY d.item_code, d.unit_code
       )
       SELECT
         COALESCE(SUM(COALESCE(pu.pu_qty,0)),0) AS pu_qty,
         COALESCE(SUM(po.po_qty),0) AS po_qty,
         COALESCE(BOOL_AND(COALESCE(pu.pu_qty,0) >= po.po_qty), false) AS is_complete
       FROM po_items po
       LEFT JOIN pu_items pu
         ON pu.item_code = po.item_code
        AND pu.unit_code = po.unit_code`,
      [poDocNo, PO_TRANS_FLAG, PU_TRANS_FLAG],
    );
    const row = status.rows[0] || {};
    const usedStatus = toNumber(row.pu_qty) > 0 ? 1 : 0;
    const docSuccess = usedStatus && toNumber(row.po_qty) > 0 && row.is_complete === true ? 1 : 0;
    await client.query(
      `UPDATE ic_trans
       SET doc_success = $1, used_status = $2
       WHERE doc_no = $3 AND trans_flag = $4`,
      [docSuccess, usedStatus, poDocNo, PO_TRANS_FLAG],
    );
  }
}

async function lockPORefs(client, fields, currentDocNo) {
  const poDocs = uniqueCodes(fields.docList.map((row) => safeText(row?.doc_no)).filter(Boolean));
  if (!poDocs.length) return [];
  const currentRefs = await getCurrentPURefs(client, currentDocNo);

  const result = await client.query(
    `SELECT doc_no, doc_date, COALESCE(last_status,0) AS last_status,
            COALESCE(doc_success,0) AS doc_success, COALESCE(used_status,0) AS used_status
     FROM ic_trans
     WHERE trans_flag = $1 AND doc_no = ANY($2::text[])
     FOR UPDATE`,
    [PO_TRANS_FLAG, poDocs],
  );
  const byDoc = new Map(result.rows.map((row) => [row.doc_no, row]));
  const missing = poDocs.filter((docNo) => !byDoc.has(docNo));
  if (missing.length) throw new Error(`PO not found: ${missing.join(', ')}`);

  for (const poDocNo of poDocs) {
    const po = byDoc.get(poDocNo);
    if (Number(po.last_status || 0) !== 0) throw new Error(`PO is cancelled or closed: ${poDocNo}`);
    if (toInt(po.doc_success) !== 0 && !currentRefs.has(poDocNo)) {
      throw new Error(`PO already completed: ${poDocNo}`);
    }
    const row = fields.docList.find((item) => safeText(item?.doc_no) === poDocNo);
    const poDate = normalizeDate(row?.doc_date);
    if (!poDate) throw new Error(`PO doc_date is required: ${poDocNo}`);
    const dbDate = normalizeDate(po.doc_date);
    if (dbDate && poDate !== dbDate) throw new Error(`PO doc_date mismatch: ${poDocNo}`);
  }

  return result.rows;
}

async function refreshInventoryBalanceQty(client, itemCodes = []) {
  const codes = uniqueCodes(itemCodes.map((code) => safeText(code)).filter(Boolean));
  for (const itemCode of codes) {
    const newBalRes = await client.query(
      `SELECT COALESCE(SUM(balance_qty), 0) AS new_balance
       FROM sml_ic_function_stock_balance_warehouse_location('NOW()', $1, '', '')`,
      [itemCode],
    );
    const newBalance = Number(newBalRes.rows[0]?.new_balance ?? 0);
    await client.query(
      `UPDATE ic_inventory SET balance_qty = $1 WHERE code = $2`,
      [newBalance, itemCode],
    );
  }
}

async function insertPUDetails(client, docNo, fields) {
  for (let index = 0; index < fields.items.length; index += 1) {
    const item = fields.items[index] || {};
    const sumAmount = toNumber(item.sum_amount);
    const isPermium = isPermiumItem(item) ? 1 : 0;
    // sum_of_cost = มูลค่ารับเข้าจริง (price × qty), average_cost = ราคาต่อหน่วย (price)
    // ตรงกับ C# — ของแถม (is_permium=1) ทั้งคู่เป็น 0
    const unitPrice = toNumber(item.price);
    const lineQty = toNumber(item.qty);
    const sumOfCost = isPermium ? 0 : roundMoney(unitPrice * lineQty);
    await client.query(
      `INSERT INTO ic_trans_detail
        (trans_type, trans_flag, doc_date, doc_time, doc_no, cust_code, inquiry_type,
         item_code, item_name, unit_code, qty, price, sum_amount, line_number,
         stand_value, divide_value, ratio, calc_flag, doc_date_calc, doc_time_calc,
         creator_code, sum_of_cost, ref_doc_no, ref_row, wh_code, shelf_code, vat_type,
         average_cost, tax_type, discount, discount_amount, barcode, is_permium)
       VALUES
        (1, $1, $2::date, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, 1, $2::date, $3,
         $17, $18, $19, -1, $20, $21, $22,
         $23, $24, $25, $26, $27, $28)`,
      [
        PU_TRANS_FLAG,
        fields.docDate,
        fields.docTime,
        docNo,
        fields.custCode,
        fields.saleType,
        safeText(item.item_code),
        String(item.item_name ?? ''),
        safeText(item.unit_code),
        lineQty,
        unitPrice,
        sumAmount,
        index,
        toNumber(item.stand_value, 1),
        toNumber(item.divide_value, 1),
        0,
        fields.creatorCode,
        sumOfCost,
        safeText(item.doc_no || item.ref_doc_no),
        safeText(item.wh_code),
        safeText(item.shelf_code),
        fields.taxType,
        isPermium ? 0 : unitPrice,
        toInt(item.tax_type, 0),
        String(item.discount ?? ''),
        toNumber(item.discount_amount),
        safeText(item.barcode),
        isPermium,
      ],
    );
  }
}

async function insertOrUpdatePUGL(client, docNo, fields, supplier, mode) {
  const params = [
    fields.docDate,
    fields.taxDocDate,
    fields.taxDocNo || docNo,
    fields.totalBeforeVat,
    fields.vatRate,
    fields.totalAfterVat,
    0,
    fields.totalVatValue,
    supplier.apBranchCode,
    supplier.apTaxId,
    supplier.apCustCode,
    supplier.apCustName,
    toInt(fields.docDate.slice(5, 7), 0),
    toInt(fields.docDate.slice(0, 4), 0) + 543,
    docNo,
    PU_TRANS_FLAG,
  ];

  if (mode === 'update') {
    const update = await client.query(
      `UPDATE gl_journal_vat_buy
       SET doc_date = $1::date, vat_date = $2::date, vat_doc_no = $3,
           vat_base_amount = $4, vat_rate = $5, vat_total_amount = $6,
           vat_type = $7, vat_amount = $8, branch_code = $9, tax_no = $10,
           ap_code = $11, ap_name = $12, vat_effective_period = $13,
           vat_effective_year = $14, vat_calc = 1
       WHERE doc_no = $15 AND trans_flag = $16`,
      params,
    );
    if (update.rowCount > 0) return;
  }

  await client.query(
    `INSERT INTO gl_journal_vat_buy
       (trans_type, trans_flag, doc_date, doc_no, vat_date, vat_doc_no,
        vat_base_amount, vat_rate, vat_total_amount, vat_type, vat_amount,
        branch_code, tax_no, ap_code, ap_name, vat_effective_period,
        vat_effective_year, vat_calc)
     VALUES (1, $16, $1::date, $15, $2::date, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14, 1)`,
    params,
  );
}

async function insertPULog(client, docNo, fields, mode) {
  const data1 = logXml({
    doc_date: fields.docDate,
    doc_time: fields.docTime,
    doc_no: docNo,
    doc_format_code: fields.docFormatCode,
    cust_code: fields.custCode,
    doc_ref: fields.docRef,
    doc_ref_date: fields.docRefDate,
    inquiry_type: fields.saleType,
    vat_type: fields.taxType,
    tax_doc_date: fields.taxDocDate,
    tax_doc_no: fields.taxDocNo || docNo,
    wh_from: fields.whFrom,
    location_from: fields.locationFrom,
  });
  await client.query(
    `INSERT INTO logs
       (function_code, data1, user_code, date_time, screen_code, guid,
        doc_date, doc_no, doc_amount, function_type, menu_name, doc_qty)
     VALUES (1, $1, $2, NOW(), $3, $4, $5::date, $6, $7, $8, $9, $10)`,
    [
      data1,
      fields.creatorCode,
      PU_TRANS_FLAG,
      crypto.randomUUID().replace(/-/g, ''),
      fields.docDate,
      docNo,
      fields.totalAmount,
      mode === 'update' ? 3 : 2,
      'ซื้อสินค้า/ตั้งหนี้',
      fields.items.length,
    ],
  );
}

async function insertPUCashbook(client, docNo, fields) {
  await client.query('DELETE FROM cb_trans WHERE doc_no = $1 AND trans_flag = $2', [docNo, PU_TRANS_FLAG]);
  await client.query('DELETE FROM cb_trans_detail WHERE doc_no = $1 AND trans_flag = $2', [docNo, PU_TRANS_FLAG]);

  if (!fields.isCashSale) return;

  const moneyChange = Math.max(0, fields.cashAmount + fields.transferAmount - fields.totalAfterRounded);
  const totalIncomeAmount = fields.roundedAmount * -1;
  await client.query(
    `INSERT INTO cb_trans
       (trans_type, trans_flag, doc_no, doc_date, doc_time, ap_ar_code, pay_type,
        doc_format_code, total_amount, total_net_amount, cash_amount, tranfer_amount,
        total_amount_pay, total_income_amount, pay_cash_amount, money_change)
     VALUES (1, $1, $2, $3::date, $4, $5, 1, $6, $7, $8, $9, $10, $8, $11, $9, $12)`,
    [
      PU_TRANS_FLAG,
      docNo,
      fields.docDate,
      fields.docTime,
      fields.custCode,
      fields.docFormatCode,
      fields.totalAmount,
      fields.totalAfterRounded,
      fields.cashAmount,
      fields.transferAmount,
      totalIncomeAmount,
      moneyChange,
    ],
  );

  for (const payment of fields.payments) {
    const amount = paymentTransferAmount(payment);
    await client.query(
      `INSERT INTO cb_trans_detail
         (trans_type, trans_flag, doc_no, doc_date, doc_time, trans_number,
          bank_code, bank_branch, credit_card_type, amount, sum_amount, doc_type,
          ap_ar_code, trans_number_type, ap_ar_type, ref1)
       VALUES (1, $1, $2, $3::date, $4, $5, $6, $7, 'NONE', $8, $8, '0', $9, 0, 0, $10)`,
      [
        PU_TRANS_FLAG,
        docNo,
        fields.docDate,
        fields.docTime,
        paymentTransferAccount(payment),
        safeText(payment.bank_code),
        safeText(payment.bank_branch),
        amount,
        fields.custCode,
        safeText(payment.transfer_date || payment.ref1 || docNo),
      ],
    );
  }
}

async function savePUDocTransaction(client, payload, mode) {
  const fields = normalizedPUSaveFields(payload);
  const supplier = await supplierTaxInfo(client, fields);
  let docNo = safeText(payload.doc_no);

  if (mode === 'create') {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`PU:${fields.docFormatCode}:${fields.docDate}`]);
    const resolved = await resolveDocumentNo(client, {
      screenCode: 'PU',
      docFormatCode: fields.docFormatCode,
      docDate: fields.docDate,
      transFlag: PU_TRANS_FLAG,
    });
    docNo = resolved.doc_no;
    fields.docFormatCode = resolved.doc_format_code;
  } else {
    const existing = await client.query(
      `SELECT doc_no, COALESCE(doc_format_code,'') AS doc_format_code
       FROM ic_trans
       WHERE doc_no = $1 AND trans_flag = $2
       LIMIT 1
       FOR UPDATE`,
      [docNo, PU_TRANS_FLAG],
    );
    if (!existing.rows[0]) throw new Error(`PU document not found: ${docNo}`);
    if (fields.docFormatCode && fields.docFormatCode !== existing.rows[0].doc_format_code) {
      throw new Error(`doc_format_code cannot be changed after create: ${existing.rows[0].doc_format_code}`);
    }
    fields.docFormatCode = existing.rows[0].doc_format_code || fields.docFormatCode || 'PU';
  }

  await lockPORefs(client, fields, docNo);

  const oldRefs = mode === 'update'
    ? (await client.query(
      `SELECT billing_no
       FROM ap_ar_trans_detail
       WHERE doc_no = $1 AND trans_flag = $2`,
      [docNo, PU_TRANS_FLAG],
    )).rows.map((row) => row.billing_no)
    : [];
  const oldItemCodes = mode === 'update'
    ? (await client.query(
      `SELECT DISTINCT item_code
       FROM ic_trans_detail
       WHERE doc_no = $1 AND trans_flag = $2`,
      [docNo, PU_TRANS_FLAG],
    )).rows.map((row) => safeText(row.item_code)).filter(Boolean)
    : [];

  if (mode === 'create') {
    await client.query(
      `INSERT INTO ic_trans
        (trans_type, trans_flag, doc_date, doc_time, doc_no, inquiry_type, vat_type,
         cust_code, vat_rate, user_request, doc_format_code, creator_code, remark,
         branch_code, total_value, total_before_vat, total_vat_value, total_after_vat,
         total_except_vat, total_amount, balance_amount, tax_doc_no, tax_doc_date,
         total_discount, discount_word, doc_ref, doc_ref_date, wh_from, location_from)
       VALUES
        (1, $1, $2::date, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17,
         $18, $19, 0, $20, $21::date,
         $22, $23, $24, NULLIF($25,'')::date, $26, $27)`,
      [
        PU_TRANS_FLAG,
        fields.docDate,
        fields.docTime,
        docNo,
        fields.saleType,
        fields.taxType,
        fields.custCode,
        fields.vatRate,
        fields.creatorCode,
        fields.docFormatCode,
        fields.programCreatorCode,
        fields.remark,
        fields.branchCode,
        fields.totalValue,
        fields.totalBeforeVat,
        fields.totalVatValue,
        fields.totalAfterVat,
        fields.totalExceptVat,
        fields.totalAmount,
        fields.taxDocNo || docNo,
        fields.taxDocDate,
        fields.totalDiscount,
        fields.discountWord,
        fields.docRef,
        fields.docRefDate,
        fields.whFrom,
        fields.locationFrom,
      ],
    );
  } else {
    await client.query(
      `UPDATE ic_trans
       SET doc_date = $1::date, doc_time = $2, cust_code = $3, remark = $4,
           vat_type = $5, vat_rate = $6, total_value = $7, total_before_vat = $8,
           total_vat_value = $9, total_after_vat = $10, total_except_vat = $11,
           total_amount = $12, balance_amount = 0, total_discount = $13,
           discount_word = $14, wh_from = $15, location_from = $16, inquiry_type = $17,
           tax_doc_no = $18, tax_doc_date = $19::date, doc_ref = $20,
           doc_ref_date = NULLIF($21,'')::date,
           creator_code = $22, last_editor_code = $23, lastedit_datetime = NOW()
       WHERE doc_no = $24 AND trans_flag = $25`,
      [
        fields.docDate,
        fields.docTime,
        fields.custCode,
        fields.remark,
        fields.taxType,
        fields.vatRate,
        fields.totalValue,
        fields.totalBeforeVat,
        fields.totalVatValue,
        fields.totalAfterVat,
        fields.totalExceptVat,
        fields.totalAmount,
        fields.totalDiscount,
        fields.discountWord,
        fields.whFrom,
        fields.locationFrom,
        fields.saleType,
        fields.taxDocNo || docNo,
        fields.taxDocDate,
        fields.docRef,
        fields.docRefDate,
        fields.programCreatorCode,
        fields.creatorCode,
        docNo,
        PU_TRANS_FLAG,
      ],
    );
    await client.query('DELETE FROM ic_trans_detail WHERE doc_no = $1 AND trans_flag = $2', [docNo, PU_TRANS_FLAG]);
    await client.query('DELETE FROM ap_ar_trans_detail WHERE doc_no = $1 AND trans_flag = $2', [docNo, PU_TRANS_FLAG]);
  }

  const newRefs = await insertPUReferences(client, docNo, fields);
  await insertPUDetails(client, docNo, fields);
  await updatePOStatuses(client, newRefs, oldRefs);
  await insertOrUpdatePUGL(client, docNo, fields, supplier, mode);
  const processItemCodes = uniqueCodes([
    ...oldItemCodes,
    ...fields.items.map((item) => safeText(item.item_code)).filter(Boolean),
  ]);
  if (processItemCodes.length) {
    await client.query(
      `DELETE FROM process
       WHERE process_name = 'IC'
         AND wherein = ANY($1::text[])`,
      [processItemCodes],
    );
    await client.query(
      `INSERT INTO process (process_name, wherein)
       SELECT DISTINCT 'IC', code
       FROM unnest($1::text[]) AS codes(code)`,
      [processItemCodes],
    );
    await refreshInventoryBalanceQty(client, processItemCodes);
  }
  await insertPULog(client, docNo, fields, mode);
  await insertPUCashbook(client, docNo, fields);

  return {
    doc_no: docNo,
    doc_format_code: fields.docFormatCode,
    item_count: fields.items.length,
    po_ref_count: newRefs.length,
  };
}

async function handlePUSave(req, res, mode) {
  const payload = normalizeSavePayload(req.body);

  const client = await pool.connect();
  try {
    const plan = await validatePUSavePlan(client, { mode, payload });
    if (!plan.can_prepare_save) {
      return res.status(400).json({ success: false, msg: 'PU save validation failed', data: plan });
    }
    await requirePUSavePermission(client, payload, mode);

    await client.query('BEGIN');
    try {
      const saved = await savePUDocTransaction(client, payload, mode);
      await client.query('COMMIT');
      return res.json({ success: true, msg: 'success', ...saved });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } catch (ex) {
    const statusCode = String(ex.message || '').startsWith('permission denied') || String(ex.message || '').includes('permission check')
      ? 403
      : 400;
    return failResponse(res, ex.message, statusCode);
  } finally {
    client.release();
  }
}

// GET /service/v1/getPurchaseDocFormatList
router.get('/getPurchaseDocFormatList', async (req, res) => {
  try {
    const result = await query(
      `SELECT code, name_1, format, COALESCE(form_code,'') AS form_code
       FROM erp_doc_format
       WHERE screen_code = 'PU'
       ORDER BY code`,
    );
    return successResponse(res, result.rows);
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

// Generic read-only helper for future document screens.
// GET /service/v1/getDocFormatList?screen_code=PU
router.get('/getDocFormatList', async (req, res) => {
  const screenCode = String(req.query.screen_code || '').trim();
  if (!screenCode) return failResponse(res, 'screen_code is required', 400);

  try {
    const result = await query(
      `SELECT code, name_1, format, COALESCE(form_code,'') AS form_code
       FROM erp_doc_format
       WHERE screen_code = $1
       ORDER BY code`,
      [screenCode],
    );
    return successResponse(res, result.rows);
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

// GET /service/v1/getNextPurchaseDocNo?doc_format_code=...&doc_date=YYYY-MM-DD
router.get('/getNextPurchaseDocNo', async (req, res) => {
  const { doc_format_code = '', doc_date = '' } = req.query;
  const client = await pool.connect();
  try {
    const resolved = await resolveDocumentNo(client, {
      screenCode: 'PU',
      docFormatCode: doc_format_code,
      docDate: doc_date,
      transFlag: PU_TRANS_FLAG,
    });
    return res.json({ success: true, ...resolved });
  } catch (ex) {
    return failResponse(res, ex.message, 400);
  } finally {
    client.release();
  }
});

// GET /service/v1/getVatRate
router.get('/getVatRate', async (req, res) => {
  try {
    const result = await query(
      `SELECT COALESCE(vat_rate,7) AS vat_rate
       FROM erp_option
       LIMIT 1`,
    );
    return res.json({ success: true, vat_rate: result.rows[0]?.vat_rate || '7' });
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

// POST /service/v1/getPurchaseLatestItemPrices
router.post('/getPurchaseLatestItemPrices', async (req, res) => {
  const items = normalizeArray(req.body?.items)
    .map((item) => ({
      item_code: safeText(item?.item_code || item?.code || item?.ic_code),
      unit_code: safeText(item?.unit_code || item?.unit_cost || item?.unit_standard || item?.start_sale_unit),
      barcode: safeText(item?.barcode),
    }))
    .filter((item) => item.item_code && item.unit_code);

  if (!items.length) return successResponse(res, []);

  try {
    const result = await query(
      `WITH requested AS (
         SELECT DISTINCT
            item_code,
            COALESCE(unit_code,'') AS unit_code,
            COALESCE(barcode,'') AS barcode
         FROM jsonb_to_recordset($1::jsonb) AS x(item_code text, unit_code text, barcode text)
         WHERE COALESCE(item_code,'') <> ''
           AND COALESCE(unit_code,'') <> ''
       )
       SELECT
          r.item_code,
          r.unit_code,
          r.barcode,
          COALESCE(last_pu.price, last_po.price, 0) AS price,
          COALESCE(last_pu.doc_no, last_po.doc_no, '') AS price_doc_no,
          COALESCE(last_pu.doc_date::text, last_po.doc_date::text, '') AS price_doc_date,
          COALESCE(last_pu.unit_code, last_po.unit_code, r.unit_code) AS price_unit_code,
          COALESCE(last_pu.barcode, last_po.barcode, '') AS price_barcode
       FROM requested r
       LEFT JOIN LATERAL (
         -- ดึงราคาซื้อล่าสุดจาก PU (trans_flag=12) ก่อน
         SELECT d.price, d.doc_no, d.doc_date, d.unit_code, d.barcode, d.line_number, t.doc_time
         FROM ic_trans_detail d
         JOIN ic_trans t ON t.doc_no = d.doc_no AND t.trans_flag = d.trans_flag
         WHERE d.trans_flag = $2
           AND COALESCE(t.last_status,0) = 0
           AND d.item_code = r.item_code
           AND COALESCE(d.unit_code,'') = r.unit_code
         ORDER BY
           d.doc_date DESC,
           d.doc_no DESC,
           COALESCE(t.doc_time,'') DESC,
           d.line_number DESC
         LIMIT 1
       ) last_pu ON true
       LEFT JOIN LATERAL (
         -- fallback: ดึงราคาจาก PO (trans_flag=6) ล่าสุด ถ้าไม่มี PU
         SELECT d.price, d.doc_no, d.doc_date, d.unit_code, d.barcode, d.line_number, t.doc_time
         FROM ic_trans_detail d
         JOIN ic_trans t ON t.doc_no = d.doc_no AND t.trans_flag = d.trans_flag
         WHERE d.trans_flag = $3
           AND COALESCE(t.last_status,0) = 0
           AND COALESCE(d.is_permium,0) = 0
           AND d.item_code = r.item_code
           AND COALESCE(d.unit_code,'') = r.unit_code
         ORDER BY
           d.doc_date DESC,
           d.doc_no DESC,
           COALESCE(t.doc_time,'') DESC,
           d.line_number DESC
         LIMIT 1
       ) last_po ON true
       ORDER BY r.item_code, r.unit_code, r.barcode`,
      [JSON.stringify(items), PU_TRANS_FLAG, PO_TRANS_FLAG],
    );
    return successResponse(res, result.rows);
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

// GET /service/v1/getPurchaseProductDetail?item_code=
router.get('/getPurchaseProductDetail', async (req, res) => {
  const itemCode = safeText(req.query.item_code || req.query.code);
  if (!itemCode) return failResponse(res, 'item_code is required', 400);

  try {
    const result = await query(
      `WITH unit_rows AS (
         SELECT
            i.code AS item_code,
            COALESCE(i.name_1,'') AS item_name,
            COALESCE(NULLIF(u.code,''), NULLIF(i.unit_standard,''), NULLIF(i.unit_cost,''), '') AS unit_code,
            COALESCE(u.stand_value, i.unit_standard_stand_value, 1) AS stand_value,
            COALESCE(u.divide_value, i.unit_standard_divide_value, 1) AS divide_value,
            CASE WHEN COALESCE(u.divide_value, i.unit_standard_divide_value, 1) <> 0
                 THEN COALESCE(u.stand_value, i.unit_standard_stand_value, 1)::numeric
                   / COALESCE(u.divide_value, i.unit_standard_divide_value, 1)::numeric
                 ELSE 1 END AS ratio,
            COALESCE(i.tax_type,0) AS tax_type
         FROM ic_inventory i
         LEFT JOIN ic_inventory_detail d ON d.ic_code = i.code
         LEFT JOIN ic_unit_use u ON u.ic_code = i.code
         WHERE i.code = $1
           AND COALESCE(d.is_hold_sale,0) <> 1
           AND COALESCE(d.is_hold_purchase,0) <> 1
       )
       SELECT DISTINCT ON (u.item_code, u.unit_code)
          u.item_code,
          u.item_name,
          u.unit_code,
          COALESCE(barcode.barcode,'') AS barcode,
          u.stand_value,
          u.divide_value,
          u.ratio,
          u.tax_type,
          COALESCE(last_pu.price,0) AS price,
          COALESCE(last_pu.doc_no,'') AS last_purchase_doc_no,
          COALESCE(last_pu.doc_date::text,'') AS last_purchase_doc_date
       FROM unit_rows u
       LEFT JOIN LATERAL (
         SELECT b.barcode
         FROM ic_inventory_barcode b
         WHERE b.ic_code = u.item_code AND COALESCE(b.unit_code,'') = u.unit_code
         ORDER BY b.barcode
         LIMIT 1
       ) barcode ON true
       LEFT JOIN LATERAL (
         SELECT d.price, d.doc_no, d.doc_date, d.line_number, t.doc_time
         FROM ic_trans_detail d
         JOIN ic_trans t ON t.doc_no = d.doc_no AND t.trans_flag = d.trans_flag
         WHERE d.trans_flag = $2
           AND COALESCE(t.last_status,0) = 0
           AND d.item_code = u.item_code
           AND COALESCE(d.unit_code,'') = u.unit_code
         ORDER BY
           d.doc_date DESC,
           d.doc_no DESC,
           COALESCE(t.doc_time,'') DESC,
           d.line_number DESC
         LIMIT 1
       ) last_pu ON true
       WHERE u.unit_code <> ''
       ORDER BY u.item_code, u.unit_code, u.ratio`,
      [itemCode, PU_TRANS_FLAG],
    );
    return successResponse(res, result.rows);
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

// POST /service/v1/createPUDoc
router.post('/createPUDoc', (req, res) => handlePUSave(req, res, 'create'));

// POST /service/v1/updatePUDoc
router.post('/updatePUDoc', (req, res) => handlePUSave(req, res, 'update'));

// GET /service/v1/getSupplierList?search=
router.get('/getSupplierList', async (req, res) => {
  const { search = '' } = req.query;
  const params = [];
  let where = '';

  if (String(search || '').trim()) {
    params.push(`%${String(search).trim()}%`);
    where = `AND (s.code ILIKE $1 OR s.name_1 ILIKE $1)`;
  }

  try {
    const result = await query(
      `SELECT s.code, COALESCE(s.name_1,'') AS name
       FROM ap_supplier s
       WHERE 1=1 ${where}
       ORDER BY s.code
       LIMIT 50`,
      params,
    );
    return successResponse(res, result.rows);
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

// GET /service/v1/getSupplierDetail?cust_code=
router.get('/getSupplierDetail', async (req, res) => {
  const custCode = String(req.query.cust_code || '').trim();
  if (!custCode) return failResponse(res, 'cust_code is required', 400);

  try {
    const result = await query(
      `SELECT
          s.code AS cust_code,
          COALESCE(s.name_1,'') AS cust_name,
          COALESCE(s.address,'') AS address,
          COALESCE(s.telephone,'') AS telephone,
          COALESCE(d.tax_id,'') AS tax_id,
          COALESCE(d.branch_code,'') AS branch_code,
          COALESCE(d.branch_type::text,'0') AS branch_type
       FROM ap_supplier s
       LEFT JOIN ap_supplier_detail d ON d.ap_code = s.code
       WHERE s.code = $1
       LIMIT 1`,
      [custCode],
    );

    if (!result.rows[0]) return failResponse(res, 'supplier not found', 404);
    return successResponse(res, result.rows[0]);
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

// GET /service/v1/getPODocWait
router.get('/getPODocWait', async (req, res) => {
  const {
    search = '',
    fromdate = '',
    todate = '',
    approve_only = '',
    vat_type = '',
    cust_code = '',
    branch_code = '',
  } = req.query;
  const params = [];
  const where = [
    `po.trans_flag = ${PO_TRANS_FLAG}`,
    'COALESCE(po.last_status,0) = 0',
    'COALESCE(po.doc_success,0) = 0',
  ];

  // กรองตามเจ้าหนี้ — ตรงกับ C# _icTransRefControl.cs:1424
  if (String(cust_code || '').trim()) {
    params.push(String(cust_code).trim());
    where.push(`po.cust_code = $${params.length}`);
  }

  // กรองตาม vat_type ของ PU ที่กำลังสร้าง — ตรงกับ C# _icTransRefControl.cs:1429
  const vatTypeNum = parseInt(vat_type, 10);
  if (Number.isFinite(vatTypeNum)) {
    params.push(vatTypeNum);
    where.push(`po.vat_type = $${params.length}`);
  }

  // กรองตาม branch_code — ตรงกับ C# _icTransRefControl.cs:1503-1508 (เฉพาะโหมดสาขา)
  if (String(branch_code || '').trim()) {
    params.push(String(branch_code).trim());
    where.push(`COALESCE(po.branch_code,'') = $${params.length}`);
  }

  const searchText = String(search || '').trim();
  if (searchText) {
    params.push(`%${searchText}%`);
    where.push(`(po.doc_no ILIKE $${params.length} OR po.cust_code ILIKE $${params.length} OR po.user_request ILIKE $${params.length})`);
  } else if (normalizeDate(fromdate) && normalizeDate(todate)) {
    params.push(normalizeDate(fromdate), normalizeDate(todate));
    where.push(`po.doc_date BETWEEN $${params.length - 1}::date AND $${params.length}::date`);
  }

  // approve_only=1 บังคับ approve_status=1 (รองรับ ref_po_approve ใน C#)
  if (String(approve_only) === '1') {
    where.push('COALESCE(po.approve_status,0) = 1');
  }

  try {
    const result = await query(
      `SELECT
          po.trans_type, po.trans_flag, po.doc_date, po.doc_time, po.doc_no,
          po.inquiry_type, po.vat_type, po.cust_code,
          COALESCE(ap.name_1,'') AS cust_name,
          po.vat_rate, po.user_request, po.doc_format_code, po.creator_code,
          COALESCE(po.remark,'') AS remark,
          COALESCE((SELECT SUM(qty) FROM ic_trans_detail d WHERE d.doc_no = po.doc_no AND d.trans_flag = ${PO_TRANS_FLAG}),0) AS total_qty,
          COALESCE(po.total_amount,0) AS total_amount,
          COALESCE((
            SELECT pra.remark
            FROM ic_trans pra
            INNER JOIN ap_ar_trans_detail ref ON ref.doc_no = po.doc_no AND ref.billing_no = pra.doc_no
            WHERE pra.trans_flag = 4 AND ref.trans_flag = ${PO_TRANS_FLAG}
            LIMIT 1
          ),'') AS pra_remark,
          COALESCE((
            SELECT pr.remark
            FROM ic_trans pr
            WHERE pr.doc_no = (
              SELECT pra.doc_ref
              FROM ic_trans pra
              INNER JOIN ap_ar_trans_detail ref ON ref.doc_no = po.doc_no AND ref.billing_no = pra.doc_no
              WHERE pra.trans_flag = 4 AND ref.trans_flag = ${PO_TRANS_FLAG}
              LIMIT 1
            )
            LIMIT 1
          ),'') AS pr_remark,
          COALESCE((
            SELECT string_agg(billing_no, ',' ORDER BY billing_no)
            FROM ap_ar_trans_detail
            WHERE doc_no = po.doc_no AND trans_flag = ${PO_TRANS_FLAG}
          ),'') AS pra_doc_list
       FROM ic_trans po
       LEFT JOIN ap_supplier ap ON ap.code = po.cust_code
       WHERE ${where.join(' AND ')}
       ORDER BY po.doc_date DESC, po.doc_time DESC
       LIMIT 100`,
      params,
    );
    return successResponse(res, result.rows);
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

// GET /service/v1/getPUDocList
router.get('/getPUDocList', async (req, res) => {
  const { search = '', fromdate = '', todate = '' } = req.query;
  const params = [];
  const where = [
    `pu.trans_flag = ${PU_TRANS_FLAG}`,
    'COALESCE(pu.last_status,0) = 0',
  ];

  const searchText = String(search || '').trim();
  if (searchText) {
    params.push(`%${searchText}%`);
    where.push(`(pu.doc_no ILIKE $${params.length} OR pu.cust_code ILIKE $${params.length} OR pu.user_request ILIKE $${params.length})`);
  } else if (normalizeDate(fromdate) && normalizeDate(todate)) {
    params.push(normalizeDate(fromdate), normalizeDate(todate));
    where.push(`pu.doc_date BETWEEN $${params.length - 1}::date AND $${params.length}::date`);
  }

  try {
    const result = await query(
      `SELECT
          pu.trans_type, pu.trans_flag, pu.doc_date, pu.doc_time, pu.doc_no,
          COALESCE(pu.doc_ref,'') AS doc_ref,
          pu.cust_code,
          COALESCE(ap.name_1,'') AS cust_name,
          pu.creator_code,
          COALESCE(pu.remark,'') AS remark,
          COALESCE(pu.doc_format_code,'') AS doc_format_code,
          COALESCE(df.name_1,'') AS doc_format_name,
          COALESCE(df.form_code,'') AS form_code,
          COALESCE((SELECT SUM(qty) FROM ic_trans_detail d WHERE d.doc_no = pu.doc_no AND d.trans_flag = ${PU_TRANS_FLAG}),0) AS total_qty,
          COALESCE(pu.total_amount,0) AS total_amount,
          COALESCE((
            SELECT string_agg(billing_no, ',' ORDER BY billing_no)
            FROM ap_ar_trans_detail
            WHERE doc_no = pu.doc_no AND trans_flag = ${PU_TRANS_FLAG}
          ),'') AS po_doc_list
       FROM ic_trans pu
       LEFT JOIN ap_supplier ap ON ap.code = pu.cust_code
       LEFT JOIN erp_doc_format df ON df.screen_code = 'PU' AND df.code = pu.doc_format_code
       WHERE ${where.join(' AND ')}
       ORDER BY pu.doc_date DESC, pu.doc_time DESC
       LIMIT 100`,
      params,
    );
    return successResponse(res, result.rows);
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

// GET /service/v1/getDocPoDetail?doc_no=
router.get('/getDocPoDetail', async (req, res) => {
  const docNo = String(req.query.doc_no || '').trim();
  if (!docNo) return failResponse(res, 'doc_no is required', 400);

  try {
    const headerRes = await query(
      `SELECT po.*,
          po.creator_code AS emp_code,
          COALESCE(u.name_1,'') AS emp_name,
          COALESCE(ap.name_1,'') AS cust_name,
          COALESCE(po.wh_from,'') AS wh_from,
          COALESCE(po.location_from,'') AS location_from,
          COALESCE(po.approve_status,0) AS approve_status,
          COALESCE(po.send_to_pick_and_pack,0) AS send_to_pick_and_pack,
          COALESCE(po.doc_success,0) AS doc_success,
          COALESCE(pra.doc_no,'') AS pra_doc_no,
          COALESCE(pra.remark,'') AS pra_remark,
          COALESCE(pra.doc_ref,'') AS pr_doc_no,
          COALESCE(pr.remark,'') AS pr_remark
       FROM ic_trans po
       LEFT JOIN erp_user u ON UPPER(u.code) = UPPER(po.creator_code)
       LEFT JOIN ap_supplier ap ON ap.code = po.cust_code
       LEFT JOIN ap_ar_trans_detail ref ON ref.doc_no = po.doc_no AND ref.trans_flag = ${PO_TRANS_FLAG}
       LEFT JOIN ic_trans pra ON pra.doc_no = ref.billing_no AND pra.trans_flag = 4
       LEFT JOIN ic_trans pr ON pr.doc_no = pra.doc_ref
       WHERE po.doc_no = $1 AND po.trans_flag = ${PO_TRANS_FLAG}
       LIMIT 1`,
      [docNo],
    );

    const header = headerRes.rows[0];
    if (!header) return failResponse(res, 'document not found', 404);

    const itemsRes = await query(
      `SELECT
          po.item_code,
          po.item_name,
          po.unit_code,
          MIN(po.line_number) AS line_number,
          po.qty AS po_qty,
          COALESCE(SUM(pu.qty),0) AS pu_qty,
          po.qty - COALESCE(SUM(pu.qty),0) AS balance_qty,
          po.price,
          COALESCE(po.wh_code,'') AS wh_code,
          COALESCE(po.shelf_code,'') AS shelf_code,
          COALESCE(po.barcode,'') AS barcode,
          COALESCE(po.stand_value,1) AS stand_value,
          COALESCE(po.divide_value,1) AS divide_value,
          COALESCE(po.ratio,1) AS ratio,
          COALESCE(inv.tax_type,0) AS tax_type,
          COALESCE(MAX(po.is_permium),0) AS is_permium,
          COALESCE(det.maximum_qty,0) AS maximum_qty,
          COALESCE(det.minimum_qty,0) AS minimum_qty,
          CASE WHEN COALESCE(SUM(pu.qty),0) > 0 THEN 1 ELSE 0 END AS updateable
       FROM ic_trans_detail po
       LEFT JOIN ap_ar_trans_detail ref ON ref.billing_no = po.doc_no AND ref.trans_flag IN (${PU_TRANS_FLAG},310)
       LEFT JOIN ic_trans_detail pu
         ON pu.doc_no = ref.doc_no
        AND pu.item_code = po.item_code
        AND pu.unit_code = po.unit_code
        AND pu.trans_flag IN (${PU_TRANS_FLAG},310)
       LEFT JOIN ic_inventory inv ON inv.code = po.item_code
       LEFT JOIN ic_inventory_detail det ON det.ic_code = po.item_code
       WHERE po.doc_no = $1 AND po.trans_flag = ${PO_TRANS_FLAG}
       GROUP BY
          po.item_code, po.item_name, po.unit_code, po.qty, po.price,
          po.wh_code, po.shelf_code, po.barcode, po.stand_value,
          po.divide_value, po.ratio, inv.tax_type, det.maximum_qty, det.minimum_qty,
          COALESCE(po.is_permium,0)
       ORDER BY MIN(po.line_number)`,
      [docNo],
    );

    return successResponse(res, { ...header, items: itemsRes.rows });
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

// GET /service/v1/getPUDocDetail?doc_no=
router.get('/getPUDocDetail', async (req, res) => {
  const docNo = String(req.query.doc_no || '').trim();
  if (!docNo) return failResponse(res, 'doc_no is required', 400);

  try {
    const headerRes = await query(
      `SELECT pu.*,
          COALESCE(NULLIF(pu.user_request,''), pu.creator_code) AS emp_code,
          COALESCE(u.name_1,'') AS emp_name,
          COALESCE(ap.name_1,'') AS cust_name,
          COALESCE(df.name_1,'') AS doc_format_name,
          COALESCE(df.form_code,'') AS form_code,
          COALESCE(pu.vat_type,0) AS tax_type,
          COALESCE(pu.inquiry_type,0) AS sale_type,
          COALESCE(pu.tax_doc_no,'') AS tax_doc_no,
          COALESCE(pu.tax_doc_date::text,'') AS tax_doc_date,
          COALESCE(pu.doc_ref,'') AS doc_ref,
          COALESCE(pu.doc_ref_date::text,'') AS doc_ref_date,
          COALESCE(pu.wh_from,'') AS wh_from,
          COALESCE(pu.location_from,'') AS location_from,
          COALESCE(pu.doc_success,0) AS doc_success
       FROM ic_trans pu
       LEFT JOIN erp_user u ON UPPER(u.code) = UPPER(COALESCE(NULLIF(pu.user_request,''), pu.creator_code))
       LEFT JOIN ap_supplier ap ON ap.code = pu.cust_code
       LEFT JOIN erp_doc_format df ON df.screen_code = 'PU' AND df.code = pu.doc_format_code
       WHERE pu.doc_no = $1 AND pu.trans_flag = ${PU_TRANS_FLAG}
       LIMIT 1`,
      [docNo],
    );

    const header = headerRes.rows[0];
    if (!header) return failResponse(res, 'document not found', 404);

    const [itemsRes, paymentRes, paymentDetailRes, poRefsRes] = await Promise.all([
      query(
        `SELECT
            COALESCE(d.ref_doc_no,'') AS ref_doc_no,
            COALESCE(po_ref.doc_date::text,'') AS ref_doc_date,
            d.item_code, d.item_name, d.qty, d.unit_code, d.price,
            COALESCE(d.wh_code,'') AS wh_code,
            COALESCE(d.shelf_code,'') AS shelf_code,
            COALESCE(d.barcode,'') AS barcode,
            COALESCE(d.stand_value,1) AS stand_value,
            COALESCE(d.divide_value,1) AS divide_value,
            COALESCE(d.ratio,1) AS ratio,
            COALESCE(d.sum_amount,0) AS sum_amount,
            COALESCE(d.discount,'') AS discount,
            COALESCE(d.discount_amount,0) AS discount_amount,
            COALESCE(d.tax_type,0) AS tax_type,
            COALESCE(d.is_permium,0) AS is_permium,
            COALESCE(det.maximum_qty,0) AS maximum_qty,
            COALESCE(det.minimum_qty,0) AS minimum_qty
         FROM ic_trans_detail d
         LEFT JOIN ic_trans po_ref ON po_ref.doc_no = d.ref_doc_no AND po_ref.trans_flag = ${PO_TRANS_FLAG}
         LEFT JOIN ic_inventory_detail det ON det.ic_code = d.item_code
         WHERE d.doc_no = $1 AND d.trans_flag = ${PU_TRANS_FLAG}
         ORDER BY d.line_number`,
        [docNo],
      ),
      query(
        `SELECT cash_amount, tranfer_amount, total_net_amount, total_income_amount, money_change
         FROM cb_trans
         WHERE doc_no = $1 AND trans_flag = ${PU_TRANS_FLAG}
         LIMIT 1`,
        [docNo],
      ),
      query(
        `SELECT trans_number, bank_code, bank_branch, amount, ref1
         FROM cb_trans_detail
         WHERE doc_no = $1 AND trans_flag = ${PU_TRANS_FLAG}`,
        [docNo],
      ),
      query(
        `SELECT
            ref.billing_no AS doc_no,
            COALESCE(ref.billing_date::text, po.doc_date::text, '') AS doc_date
         FROM ap_ar_trans_detail ref
         LEFT JOIN ic_trans po ON po.doc_no = ref.billing_no AND po.trans_flag = ${PO_TRANS_FLAG}
         WHERE ref.doc_no = $1 AND ref.trans_flag = ${PU_TRANS_FLAG}
         ORDER BY ref.billing_no`,
        [docNo],
      ),
    ]);

    const payment = paymentRes.rows[0] || {};
    return successResponse(res, {
      ...header,
      cash_amount: payment.cash_amount || '0',
      transfer_amount: payment.tranfer_amount || '0',
      total_after_rounded: payment.total_net_amount || header.total_amount || '0',
      rounded_amount: payment.total_income_amount ? String(Number(payment.total_income_amount) * -1) : '0',
      money_change: payment.money_change || '0',
      po_refs: poRefsRes.rows,
      po_doc_list: poRefsRes.rows.map((row) => row.doc_no).join(','),
      payment_detail: paymentDetailRes.rows.map((row) => ({
        pass_book_code: row.trans_number || '',
        bank_code: row.bank_code || '',
        bank_branch: row.bank_branch || '',
        pay_amount: row.amount || '0',
        transfer_date: row.ref1 || '',
      })),
      items: itemsRes.rows,
    });
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

// GET /service/v1/getPurchasePrintForms?doc_no=
router.get('/getPurchasePrintForms', async (req, res) => {
  const docNo = String(req.query.doc_no || '').trim();
  if (!docNo) return failResponse(res, 'doc_no is required', 400);

  try {
    const docRes = await query(
      `SELECT pu.doc_no,
          COALESCE(pu.doc_format_code,'') AS doc_format_code,
          COALESCE(df.name_1,'') AS doc_format_name,
          COALESCE(df.form_code,'') AS form_code
       FROM ic_trans pu
       LEFT JOIN erp_doc_format df ON df.screen_code = 'PU' AND df.code = pu.doc_format_code
       WHERE pu.trans_flag = ${PU_TRANS_FLAG} AND pu.doc_no = $1
       LIMIT 1`,
      [docNo],
    );

    const doc = docRes.rows[0];
    if (!doc) return failResponse(res, 'document not found', 404);

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

    return successResponse(res, {
      doc_no: doc.doc_no,
      doc_format_code: doc.doc_format_code,
      doc_format_name: doc.doc_format_name,
      form_code: doc.form_code,
      forms,
    });
  } catch (ex) {
    return failResponse(res, ex.message, 500);
  }
});

module.exports = router;

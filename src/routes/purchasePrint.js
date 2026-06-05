const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { renderSalePrintHtml } = require('../utils/salePrintRenderer');

const PU_TRANS_FLAG = 12;

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

async function loadPurchaseDocument(docNo) {
  const [headerRes, companyRes, detailsRes] = await Promise.all([
    query(
      `SELECT pu.*,
          COALESCE(df.name_1,'') AS doc_format_name,
          COALESCE(df.form_code,'') AS form_code,
          COALESCE(ap.name_1,'') AS name_1,
          COALESCE(ap.address,'') AS address,
          COALESCE(ap.telephone,'') AS telephone,
          '' AS fax,
          COALESCE(apd.tax_id,'') AS tax_id,
          COALESCE(pu.contactor,'') AS contactor,
          COALESCE(u.name_1, NULLIF(pu.user_request,''), pu.creator_code, '') AS creator_name,
          COALESCE(pu.vat_type,0) AS tax_type,
          COALESCE(pu.inquiry_type,0) AS sale_type
       FROM ic_trans pu
       LEFT JOIN erp_doc_format df ON df.screen_code = 'PU' AND df.code = pu.doc_format_code
       LEFT JOIN ap_supplier ap ON ap.code = pu.cust_code
       LEFT JOIN ap_supplier_detail apd ON apd.ap_code = pu.cust_code
       LEFT JOIN erp_user u ON UPPER(u.code) = UPPER(COALESCE(NULLIF(pu.user_request,''), pu.creator_code))
       WHERE pu.trans_flag = $2 AND pu.doc_no = $1
       LIMIT 1`,
      [docNo, PU_TRANS_FLAG],
    ),
    query('SELECT * FROM erp_company_profile ORDER BY roworder LIMIT 1'),
    query(
      `SELECT d.*,
          COALESCE(u.name_1, d.unit_code, '') AS unit_name,
          COALESCE(d.ref_doc_no,'') AS doc_ref,
          COALESCE(d.ref_doc_no,'') AS po_doc_no,
          COALESCE(d.sum_amount,0) AS amount,
          COALESCE(d.discount,'') AS discount_word
       FROM ic_trans_detail d
       LEFT JOIN ic_unit u ON u.code = d.unit_code
       WHERE d.trans_flag = $2 AND d.doc_no = $1
       ORDER BY d.line_number`,
      [docNo, PU_TRANS_FLAG],
    ),
  ]);

  const header = headerRes.rows[0];
  if (!header) return null;

  const company = companyRes.rows[0] || {};
  company.tax_text = company.tax_number ? `หมายเลขประจำตัวผู้เสียภาษี ${company.tax_number}` : '';
  company.telephone_text = company.telephone_number ? `โทร. ${company.telephone_number}` : '';

  const poRefsRes = await query(
    `SELECT string_agg(billing_no, ',' ORDER BY billing_no) AS po_doc_list
     FROM ap_ar_trans_detail
     WHERE doc_no = $1 AND trans_flag = $2`,
    [docNo, PU_TRANS_FLAG],
  );
  header.po_doc_list = poRefsRes.rows[0]?.po_doc_list || '';
  header.ap_code = header.cust_code || '';
  header.ap_name = header.name_1 || '';
  header.ap_address = header.address || '';
  header.ap_telephone = header.telephone || '';
  header.ap_tax_id = header.tax_id || '';

  return {
    header,
    company,
    details: detailsRes.rows || [],
  };
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
    [docNo, PU_TRANS_FLAG],
  );
  return Number(result.rows[0]?.print_count || 0);
}

async function createPrintLog(docNo, userCode) {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO erp_print_logs (doc_no, trans_flag, user_code, print_datetime)
       VALUES ($1, $2, $3, NOW())`,
      [docNo, PU_TRANS_FLAG, String(userCode || 'WEB').trim() || 'WEB'],
    );
    const result = await client.query(
      `SELECT COUNT(*)::int AS print_count
       FROM erp_print_logs
       WHERE trans_flag = $2 AND doc_no = $1`,
      [docNo, PU_TRANS_FLAG],
    );
    return Number(result.rows[0]?.print_count || 0);
  });
}

async function loadPrintFormOptions(docNo) {
  const docRes = await query(
    `SELECT pu.doc_no, COALESCE(pu.doc_format_code,'') AS doc_format_code,
        COALESCE(df.name_1,'') AS doc_format_name,
        COALESCE(df.form_code,'') AS form_code
     FROM ic_trans pu
     LEFT JOIN erp_doc_format df ON df.screen_code = 'PU' AND df.code = pu.doc_format_code
     WHERE pu.trans_flag = $2 AND pu.doc_no = $1
     LIMIT 1`,
    [docNo, PU_TRANS_FLAG],
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

router.get('/purchase-print/render', async (req, res) => {
  const { doc_no = '', formcodes = '', auto_print = '1', log_print, user_code = '' } = req.query;
  if (!doc_no) return res.status(400).type('text/plain').send('doc_no is required');

  try {
    const [options, purchaseData] = await Promise.all([
      loadPrintFormOptions(doc_no),
      loadPurchaseDocument(doc_no),
    ]);

    if (!options || !purchaseData) return res.status(404).type('text/plain').send('document not found');

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
      ? await createPrintLog(doc_no, user_code || purchaseData.header.creator_code)
      : await getPrintCount(doc_no);
    purchaseData.header.print_count = printCount;

    const html = renderSalePrintHtml({
      formRows,
      data: purchaseData,
      autoPrint: String(auto_print) !== '0',
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('html').send(html);
  } catch (ex) {
    return res.status(500).type('text/plain').send(ex.message);
  }
});

module.exports = router;

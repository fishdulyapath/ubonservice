const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { renderSalePrintHtml } = require('../utils/salePrintRenderer');

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

async function loadSalePromotionRows(docNo) {
  const tableRes = await query(`SELECT to_regclass('public.ic_trans_detail_promotion') AS table_name`);
  if (!tableRes.rows[0]?.table_name) return [];

  const result = await query(
    `SELECT
        COALESCE(promotion_code,'') AS promotion_code,
        COALESCE(promotion_name,'') AS promotion_name,
        COALESCE(qty,0) AS qty,
        COALESCE(price,0) AS price,
        COALESCE(sum_amount,0) AS sum_amount,
        COALESCE(line_number,0) AS line_number
     FROM ic_trans_detail_promotion
     WHERE trans_flag = 44 AND doc_no = $1
     ORDER BY line_number, promotion_code`,
    [docNo]
  );
  return result.rows || [];
}

async function loadSaleCampaignRows(docNo) {
  const tableRes = await query(
    `SELECT
        to_regclass('public.ic_trans_pos_campaign') AS trans_table,
        to_regclass('public.pos_slip_campaign') AS campaign_table`
  );
  if (!tableRes.rows[0]?.trans_table || !tableRes.rows[0]?.campaign_table) return [];

  const result = await query(
    `SELECT COALESCE(string_agg(CONCAT(pc.display_wording, ' x ', tc.qty), E'\n'), '') AS all_display
     FROM ic_trans_pos_campaign tc
     JOIN pos_slip_campaign pc ON pc.code = tc.campaign_code
     WHERE tc.doc_no = $1 AND tc.trans_flag = 44`,
    [docNo]
  );
  const allDisplay = String(result.rows[0]?.all_display || '').trim();
  return allDisplay ? [{ all_display: allDisplay }] : [];
}

async function loadSalePaymentRows(docNo) {
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
     WHERE doc_no = $1 AND trans_flag = 44
     LIMIT 1`,
    [docNo]
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
       WHERE doc_no = $1 AND trans_flag = 44
       ORDER BY roworder`,
      [docNo]
    );

    for (const row of detailRes.rows) {
      const amount = asAmountText(row.amount);
      if (!amount) continue;
      const docType = Number(row.doc_type || 0);
      let label = String(row.trans_number || '').trim();
      if (docType === 1) label = label ? `เงินโอน ~ ${label}` : 'เงินโอน';
      else if (docType === 3) label = label ? `เลขที่บัตรเครดิต ~ ${label}` : 'บัตรเครดิต';
      else if (docType === 2) label = label ? `เลขที่เช็ค ~ ${label}` : 'เช็ค';
      else if (docType === 4) label = label ? `เงินสดย่อย ~ ${label}` : 'เงินสดย่อย';
      labels.push(label || 'ชำระเงิน');
      amounts.push(amount);
    }
  }

  return labels.length
    ? [{ trans_number: labels.join('\n'), amount: amounts.join('\n') }]
    : [];
}

async function loadSaleDocument(docNo) {
  const [headerRes, companyRes, detailsRes, promotions, campaigns, payments] = await Promise.all([
    query(
      `SELECT t.*,
          COALESCE(NULLIF(cb.total_net_amount,0), t.total_amount, 0) AS total_net_amount,
          COALESCE(cb.total_amount_pay,0) AS total_amount_pay,
          COALESCE(cb.cash_amount,0) AS cash_amount,
          COALESCE(cb.tranfer_amount,0) AS tranfer_amount,
          COALESCE(cb.card_amount,0) AS card_amount,
          COALESCE(cb.wallet_amount,0) AS wallet_amount,
          COALESCE(cb.deposit_amount,0) AS deposit_amount,
          COALESCE(cb.total_credit_charge,0) AS total_credit_charge,
          COALESCE(cb.total_income_amount,0) AS total_income_amount,
          COALESCE(cb.money_change,0) AS money_change,
          COALESCE(df.name_1,'') AS doc_format_name,
          COALESCE(df.form_code,'') AS form_code,
          COALESCE(ar.name_1,'') AS name_1,
          COALESCE(ar.address,'') AS address,
          COALESCE(ar.telephone,'') AS telephone,
          COALESCE(ar.fax,'') AS fax,
          COALESCE(cd.tax_id,'') AS tax_id,
          COALESCE(t.contactor,'') AS contactor,
          COALESCE(u.name_1, t.sale_code, '') AS sale_name
       FROM ic_trans t
       LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = 44
       LEFT JOIN erp_doc_format df ON df.screen_code = 'SI' AND df.code = t.doc_format_code
       LEFT JOIN ar_customer ar ON ar.code = t.cust_code
       LEFT JOIN ar_customer_detail cd ON cd.ar_code = t.cust_code
       LEFT JOIN erp_user u ON UPPER(u.code) = UPPER(t.sale_code)
       WHERE t.trans_flag = 44 AND t.doc_no = $1
       LIMIT 1`,
      [docNo]
    ),
    query('SELECT * FROM erp_company_profile ORDER BY roworder LIMIT 1'),
    query(
      `SELECT d.*,
          COALESCE(u.name_1, d.unit_code, '') AS unit_name
       FROM ic_trans_detail d
       LEFT JOIN ic_unit u ON u.code = d.unit_code
       WHERE d.trans_flag = 44 AND d.doc_no = $1
         AND (COALESCE(d.set_ref_line,'') = '' OR COALESCE(d.item_type,0) = 3)
       ORDER BY d.line_number`,
      [docNo]
    ),
    loadSalePromotionRows(docNo),
    loadSaleCampaignRows(docNo),
    loadSalePaymentRows(docNo),
  ]);

  const header = headerRes.rows[0];
  if (!header) return null;
  const company = companyRes.rows[0] || {};
  company.tax_text = company.tax_number ? `หมายเลขประจำตัวผู้เสียภาษี ${company.tax_number}` : '';
  company.telephone_text = company.telephone_number ? `โทร. ${company.telephone_number}` : '';

  header.promotion_count = promotions.length;
  header.promotion_code = promotions.map((row) => row.promotion_code).filter(Boolean).join('\n');
  header.promotion_name = promotions.map((row) => row.promotion_name).filter(Boolean).join('\n');
  header.promotion_discount_amount = promotions.reduce((sum, row) => sum + Math.abs(Number(row.sum_amount || 0)), 0);
  header.promotion_amount = promotions.reduce((sum, row) => sum + Number(row.sum_amount || 0), 0);

  return {
    header,
    company,
    details: detailsRes.rows || [],
    promotions,
    campaigns,
    payments,
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
     WHERE trans_flag = 44 AND doc_no = $1`,
    [docNo]
  );
  return Number(result.rows[0]?.print_count || 0);
}

async function createPrintLog(docNo, userCode) {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO erp_print_logs (doc_no, trans_flag, user_code, print_datetime)
       VALUES ($1, 44, $2, NOW())`,
      [docNo, String(userCode || 'WEB').trim() || 'WEB']
    );
    const result = await client.query(
      `SELECT COUNT(*)::int AS print_count
       FROM erp_print_logs
       WHERE trans_flag = 44 AND doc_no = $1`,
      [docNo]
    );
    return Number(result.rows[0]?.print_count || 0);
  });
}

async function loadPrintFormOptions(docNo) {
  const docRes = await query(
    `SELECT t.doc_no, COALESCE(t.doc_format_code,'') AS doc_format_code,
        COALESCE(df.name_1,'') AS doc_format_name,
        COALESCE(df.form_code,'') AS form_code
     FROM ic_trans t
     LEFT JOIN erp_doc_format df ON df.screen_code = 'SI' AND df.code = t.doc_format_code
     WHERE t.trans_flag = 44 AND t.doc_no = $1
     LIMIT 1`,
    [docNo]
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
      [lowerCodes(codes)]
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
    [lowerCodes(formCodes)]
  );
  const byCode = new Map(result.rows.map((row) => [String(row.formcode || '').toLowerCase(), row]));
  return formCodes.map((code) => byCode.get(code.toLowerCase())).filter(Boolean);
}

router.get('/getSalePrintForms', async (req, res) => {
  const { doc_no = '' } = req.query;
  if (!doc_no) return res.status(400).json({ success: false, msg: 'doc_no is required' });

  try {
    const options = await loadPrintFormOptions(doc_no);
    if (!options) return res.status(404).json({ success: false, msg: 'document not found' });
    return res.json({ success: true, data: options });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/sale-print/render', async (req, res) => {
  const { doc_no = '', formcodes = '', auto_print = '1', log_print, user_code = '' } = req.query;
  if (!doc_no) return res.status(400).type('text/plain').send('doc_no is required');

  try {
    const [options, saleData] = await Promise.all([
      loadPrintFormOptions(doc_no),
      loadSaleDocument(doc_no),
    ]);

    if (!options || !saleData) return res.status(404).type('text/plain').send('document not found');

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
      ? await createPrintLog(doc_no, user_code || saleData.header.creator_code || saleData.header.cashier_code)
      : await getPrintCount(doc_no);
    saleData.header.print_count = printCount;

    const html = renderSalePrintHtml({
      formRows,
      data: saleData,
      autoPrint: String(auto_print) !== '0',
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('html').send(html);
  } catch (ex) {
    return res.status(500).type('text/plain').send(ex.message);
  }
});

module.exports = router;

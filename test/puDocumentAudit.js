// Read-only inspection of existing PU documents. Run manually against the configured database.
const { pool } = require('../src/db');
const { calculatePUDocument, calcPULineAmounts } = require('../src/utils/puPricing');

const moneyFields = [
  'total_value', 'total_discount', 'total_before_vat', 'total_vat_value',
  'total_after_vat', 'total_except_vat', 'total_amount',
];
const different = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) > 0.011;

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const option = await client.query(`SELECT vat_rate, item_amount_decimal, item_price_decimal,
      discout_type, discount_vat_type, discount_step_round_off,
      calc_item_price_discount, round_type FROM erp_option LIMIT 1`);
    const options = option.rows[0] || {};
    console.log('erp_option', JSON.stringify(options));
    const groups = await client.query(`SELECT vat_type, inquiry_type, COUNT(*)::int AS documents,
      COUNT(*) FILTER (WHERE COALESCE(discount_word,'') <> '')::int AS bill_discount_documents
      FROM ic_trans WHERE trans_flag = 12 AND COALESCE(last_status,0) = 0
      GROUP BY vat_type, inquiry_type ORDER BY vat_type, inquiry_type`);
    console.log('pu_groups', JSON.stringify(groups.rows));
    const lineDiscountCount = await client.query(`SELECT COUNT(DISTINCT doc_no)::int AS documents
      FROM ic_trans_detail WHERE trans_flag = 12 AND COALESCE(discount,'') <> ''`);
    console.log('line_discount_documents', lineDiscountCount.rows[0].documents);
    const formats = await client.query(`SELECT code, name_1, COALESCE(form_code,'') AS form_code
      FROM erp_doc_format WHERE screen_code='PU' ORDER BY code`);
    console.log('pu_print_formats', JSON.stringify(formats.rows));
    const docs = await client.query(`SELECT doc_no, doc_date::text, inquiry_type, vat_type, vat_rate, total_value,
        total_discount, discount_word, total_before_vat, total_vat_value,
        total_after_vat, total_except_vat, total_amount, creator_code
      FROM ic_trans WHERE trans_flag=12 AND COALESCE(last_status,0)=0
      ORDER BY doc_date DESC, doc_no DESC`);
    const docNos = docs.rows.map((row) => row.doc_no);
    const detailRes = await client.query(`SELECT doc_no, item_code, qty, price, discount,
        discount_amount, sum_amount, tax_type, is_permium FROM ic_trans_detail
        WHERE doc_no=ANY($1::text[]) AND trans_flag=12 ORDER BY doc_no,line_number,roworder`, [docNos]);
    const glRes = await client.query(`SELECT doc_no, vat_base_amount, vat_amount, vat_total_amount
      FROM gl_journal_vat_buy WHERE doc_no=ANY($1::text[]) AND trans_flag=12`, [docNos]);
    const cashRes = await client.query(`SELECT doc_no, total_amount, total_net_amount, cash_amount, tranfer_amount
      FROM cb_trans WHERE doc_no=ANY($1::text[]) AND trans_flag=12`, [docNos]);
    const groupByDoc = (rows) => rows.reduce((map, row) => {
      if (!map.has(row.doc_no)) map.set(row.doc_no, []);
      map.get(row.doc_no).push(row);
      return map;
    }, new Map());
    const detailsByDoc = groupByDoc(detailRes.rows);
    const glByDoc = groupByDoc(glRes.rows);
    const cashByDoc = groupByDoc(cashRes.rows);
    const issues = [];
    const summary = { checked: docs.rows.length, matched: 0, mismatched: 0,
      with_discounts: 0, vat_journal_documents: glByDoc.size,
      cashbook_documents: cashByDoc.size };
    for (const doc of docs.rows) {
      const details = detailsByDoc.get(doc.doc_no) || [];
      const calculation = calculatePUDocument(
        details, doc.discount_word, doc.vat_rate, doc.vat_type, options,
      );
      const differences = [];
      for (const [index, row] of details.entries()) {
        const calculated = calcPULineAmounts(row, options);
        for (const key of ['discount_amount', 'sum_amount']) {
          if (different(row[key], calculated[key])) {
            differences.push({ line: index + 1, item_code: row.item_code, field: key,
              stored: row[key], calculated: calculated[key] });
          }
        }
      }
      for (const key of moneyFields) {
        if (different(doc[key], calculation.totals[key])) {
          differences.push({ field: key, stored: doc[key], calculated: calculation.totals[key] });
        }
      }
      const gl = glByDoc.get(doc.doc_no) || [];
      for (const row of gl) {
        if (different(row.vat_base_amount, doc.total_before_vat)) differences.push({ field: 'GL.vat_base_amount', stored: row.vat_base_amount, header: doc.total_before_vat });
        if (different(row.vat_amount, doc.total_vat_value)) differences.push({ field: 'GL.vat_amount', stored: row.vat_amount, header: doc.total_vat_value });
      }
      const cash = cashByDoc.get(doc.doc_no) || [];
      for (const row of cash) {
        if (different(row.total_amount, doc.total_amount)) differences.push({ field: 'CB.total_amount', stored: row.total_amount, header: doc.total_amount });
      }
      if (doc.discount_word || details.some((row) => row.discount)) summary.with_discounts++;
      if (differences.length) {
        summary.mismatched++;
        issues.push({ doc_no: doc.doc_no, doc_date: doc.doc_date, vat_type: doc.vat_type,
          inquiry_type: doc.inquiry_type, creator_code: doc.creator_code, line_count: details.length,
          gl_rows: gl.length, cash_rows: cash.length, differences });
      } else summary.matched++;
    }
    console.log('audit_summary', JSON.stringify(summary));
    console.log('audit_issue_fields', JSON.stringify(issues.flatMap((row) => row.differences.map((diff) => diff.field))
      .reduce((counts, field) => ({ ...counts, [field]: (counts[field] || 0) + 1 }), {})));
    console.log('audit_issues_sample', JSON.stringify(issues.slice(0, 20)));
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.code || error.name, error.message);
  process.exitCode = 1;
});

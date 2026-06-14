const { query, pool } = require('../src/db');

const requiredColumns = {
  ic_trans: [
    'trans_type',
    'trans_flag',
    'doc_date',
    'doc_time',
    'doc_no',
    'doc_ref',
    'doc_ref_date',
    'inquiry_type',
    'vat_type',
    'cust_code',
    'branch_code',
    'vat_rate',
    'tax_doc_no',
    'tax_doc_date',
    'total_value',
    'total_before_vat',
    'total_vat_value',
    'total_except_vat',
    'total_amount',
    'remark',
    'doc_format_code',
    'last_status',
    'used_status',
    'creator_code',
    'create_datetime',
    'is_cancel',
  ],
  ic_trans_detail: [
    'trans_type',
    'trans_flag',
    'doc_date',
    'doc_time',
    'doc_no',
    'cust_code',
    'item_code',
    'item_name',
    'qty',
    'price',
    'sum_amount',
    'sum_amount_exclude_vat',
    'total_vat_value',
    'branch_code',
    'remark',
    'line_number',
    'calc_flag',
    'last_status',
    'creator_code',
    'create_datetime',
  ],
  gl_journal_vat_buy: [
    'trans_type',
    'trans_flag',
    'doc_date',
    'doc_no',
    'vat_date',
    'vat_doc_no',
    'vat_base_amount',
    'vat_rate',
    'vat_total_amount',
    'vat_type',
    'vat_amount',
    'branch_code',
    'tax_no',
    'ap_code',
    'ap_name',
    'vat_effective_period',
    'vat_effective_year',
    'vat_calc',
  ],
  cb_trans: [
    'trans_type',
    'trans_flag',
    'doc_no',
    'doc_date',
    'doc_time',
    'ap_ar_code',
    'pay_type',
    'doc_format_code',
    'total_amount',
    'total_net_amount',
    'cash_amount',
    'chq_amount',
    'tranfer_amount',
    'card_amount',
    'total_amount_pay',
    'total_credit_charge',
    'total_tax_at_pay',
    'pay_cash_amount',
    'money_change',
    'remark',
  ],
  cb_trans_detail: [
    'trans_type',
    'trans_flag',
    'doc_no',
    'doc_date',
    'doc_time',
    'trans_number',
    'bank_code',
    'bank_branch',
    'amount',
    'sum_amount',
    'doc_type',
    'ap_ar_code',
    'trans_number_type',
    'ap_ar_type',
    'last_status',
    'credit_card_type',
    'charge',
    'chq_due_date',
  ],
};

async function main() {
  let failures = 0;

  for (const [tableName, columns] of Object.entries(requiredColumns)) {
    const result = await query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
         AND column_name = ANY($2::text[])
       ORDER BY column_name`,
      [tableName, columns],
    );
    const found = new Set(result.rows.map((row) => row.column_name));
    const missing = columns.filter((column) => !found.has(column));
    if (missing.length) {
      failures += 1;
      console.log(`${tableName}: missing ${missing.join(', ')}`);
    } else {
      console.log(`${tableName}: ok (${found.size}/${columns.length})`);
    }
  }

  const latest = await query(
    `SELECT doc_no, inquiry_type, vat_type, total_amount
     FROM ic_trans
     WHERE trans_flag = 260
     ORDER BY doc_date DESC, doc_no DESC
     LIMIT 5`,
  );
  console.log(`latest_other_expense_docs: ${latest.rows.length}`);
  latest.rows.forEach((row) => {
    console.log(`- ${row.doc_no} inquiry=${row.inquiry_type} vat=${row.vat_type} total=${row.total_amount}`);
  });

  const invariantResult = await query(
    `SELECT
       COUNT(*) FILTER (
         WHERE COALESCE(t.inquiry_type, 0) NOT IN (1, 2)
           AND cb.doc_no IS NOT NULL
       )::int AS credit_with_payment,
       COUNT(*) FILTER (
         WHERE COALESCE(t.inquiry_type, 0) IN (1, 2)
           AND COALESCE(t.last_status, 0) = 0
           AND cb.doc_no IS NULL
       )::int AS cash_without_payment,
       COUNT(*) FILTER (
         WHERE COALESCE(t.vat_type, 0) = 3
           AND vb.doc_no IS NOT NULL
       )::int AS vat3_with_vat_buy
     FROM ic_trans t
     LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = t.trans_flag
     LEFT JOIN gl_journal_vat_buy vb ON vb.doc_no = t.doc_no AND vb.trans_flag = t.trans_flag
     WHERE t.trans_flag = 260`,
  );
  const invariant = invariantResult.rows[0] || {};
  console.log(
    `data_invariants: credit_with_payment=${invariant.credit_with_payment || 0}, ` +
    `cash_without_payment=${invariant.cash_without_payment || 0}, ` +
    `vat3_with_vat_buy=${invariant.vat3_with_vat_buy || 0}`,
  );
  if (Number(invariant.credit_with_payment || 0) > 0) {
    const mismatch = await query(
      `SELECT t.doc_no, t.doc_date, COALESCE(t.inquiry_type, 0) AS inquiry_type,
              COALESCE(t.vat_type, 0) AS vat_type, COALESCE(t.total_amount, 0) AS total_amount,
              COALESCE(cb.total_amount_pay, 0) AS total_amount_pay
       FROM ic_trans t
       JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = t.trans_flag
       WHERE t.trans_flag = 260
         AND COALESCE(t.inquiry_type, 0) NOT IN (1, 2)
       ORDER BY t.doc_date DESC, t.doc_no DESC
       LIMIT 20`,
    );
    mismatch.rows.forEach((row) => {
      const docDate = row.doc_date instanceof Date ? row.doc_date.toISOString().slice(0, 10) : row.doc_date;
      console.log(`legacy_credit_with_payment: ${row.doc_no} date=${docDate} inquiry=${row.inquiry_type} vat=${row.vat_type} total=${row.total_amount} paid=${row.total_amount_pay}`);
    });
  }

  if (failures) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(`validation_error: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });

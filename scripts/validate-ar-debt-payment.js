const { query, pool } = require('../src/db');

const TRANS_FLAG = 239;
const BILLING_FLAG = 235;
const BILLING_CANCEL_FLAG = 236;
const REF_FLAG = 99;

const requiredColumns = {
  ap_ar_trans: [
    'trans_type',
    'trans_flag',
    'doc_date',
    'doc_time',
    'doc_no',
    'cust_code',
    'sale_code',
    'remark',
    'total_net_value',
    'doc_format_code',
    'last_status',
    'used_status',
    'doc_success',
    'creator_code',
    'create_datetime',
    'branch_code',
    'is_cancel',
  ],
  ap_ar_trans_detail: [
    'trans_type',
    'trans_flag',
    'doc_date',
    'doc_no',
    'doc_ref',
    'billing_no',
    'billing_date',
    'due_date',
    'bill_type',
    'ref_doc_no',
    'ref_doc_date',
    'sum_debt_amount',
    'balance_ref',
    'sum_pay_money',
    'remark',
    'line_number',
    'last_status',
    'calc_flag',
    'cust_code',
    'creator_code',
    'create_datetime',
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
    'total_income_amount',
    'petty_cash_amount',
    'discount_amount',
    'coupon_amount',
    'deposit_amount',
    'total_income_other',
    'total_expense_other',
    'total_credit_charge',
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
    'remark',
    'last_status',
    'credit_card_type',
    'charge',
    'chq_due_date',
  ],
  gl_journal_vat_sale: [
    'doc_date',
    'doc_no',
    'line_number',
    'vat_number',
    'base_caltax_amount',
    'tax_rate',
    'amount',
    'vat_date',
    'trans_type',
    'trans_flag',
    'vat_effective_period',
    'vat_effective_year',
    'ar_code',
    'ar_name',
    'vat_calc',
    'vat_type',
  ],
  ic_trans: [
    'doc_no',
    'trans_flag',
    'used_status_2',
    'last_status',
  ],
};

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function checkRequiredColumns() {
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
  return failures;
}

async function printLatestDocs() {
  const latest = await query(
    `SELECT h.doc_no, h.doc_date, h.cust_code, COALESCE(h.sale_code,'') AS sale_code,
            COALESCE(h.total_net_value,0) AS total_net_value,
            COALESCE(cb.cash_amount,0) AS cash_amount,
            COALESCE(cb.tranfer_amount,0) AS transfer_amount,
            COALESCE(cb.card_amount,0) AS card_amount,
            COALESCE(cb.deposit_amount,0) AS deposit_amount,
            COALESCE(cb.total_credit_charge,0) AS card_charge,
            COALESCE(cb.total_amount_pay,0) AS total_amount_pay
     FROM ap_ar_trans h
     LEFT JOIN cb_trans cb ON cb.doc_no = h.doc_no AND cb.trans_flag = h.trans_flag
     WHERE h.trans_flag = $1
     ORDER BY h.doc_date DESC, h.doc_no DESC
     LIMIT 8`,
    [TRANS_FLAG],
  );
  console.log(`latest_ar_debt_payment_docs: ${latest.rows.length}`);
  latest.rows.forEach((row) => {
    const docDate = row.doc_date instanceof Date ? row.doc_date.toISOString().slice(0, 10) : row.doc_date;
    console.log(
      `- ${row.doc_no} date=${docDate} cust=${row.cust_code} sale=${row.sale_code || '-'} ` +
      `net=${row.total_net_value} cash=${row.cash_amount} transfer=${row.transfer_amount} ` +
      `card=${row.card_amount} deposit=${row.deposit_amount} charge=${row.card_charge} paid=${row.total_amount_pay}`,
    );
  });
}

async function checkInvariants() {
  const invariant = await query(
    `WITH docs AS (
       SELECT h.doc_no, h.trans_flag, h.total_net_value,
              COALESCE(SUM(d.sum_pay_money),0) AS detail_sum
       FROM ap_ar_trans h
       LEFT JOIN ap_ar_trans_detail d
         ON d.doc_no = h.doc_no
        AND d.trans_flag = h.trans_flag
        AND COALESCE(d.last_status,0) = 0
       WHERE h.trans_flag = $1
         AND COALESCE(h.last_status,0) = 0
       GROUP BY h.doc_no, h.trans_flag, h.total_net_value
     ),
     cb AS (
       SELECT cb.doc_no,
              cb.total_amount,
              cb.total_net_amount,
              cb.total_amount_pay,
              cb.cash_amount,
              cb.chq_amount,
              cb.tranfer_amount,
              cb.card_amount,
              cb.total_income_amount,
              cb.petty_cash_amount,
              cb.discount_amount,
              cb.coupon_amount,
              cb.deposit_amount,
              cb.total_expense_other,
              cb.total_credit_charge
       FROM cb_trans cb
       WHERE cb.trans_flag = $1
     )
     SELECT
       COUNT(*) FILTER (WHERE cb.doc_no IS NULL)::int AS receipt_without_cb,
       COUNT(*) FILTER (WHERE ABS(ROUND(docs.detail_sum - docs.total_net_value, 2)) > 0.01)::int AS header_detail_mismatch,
       COUNT(*) FILTER (WHERE cb.doc_no IS NOT NULL AND ABS(ROUND(COALESCE(cb.total_amount,0) - docs.total_net_value, 2)) > 0.01)::int AS cb_total_mismatch,
       COUNT(*) FILTER (
         WHERE cb.doc_no IS NOT NULL
           AND ABS(ROUND(
             COALESCE(cb.cash_amount,0)
             + COALESCE(cb.chq_amount,0)
             + COALESCE(cb.tranfer_amount,0)
             + COALESCE(cb.card_amount,0)
             + COALESCE(cb.total_income_amount,0)
             + COALESCE(cb.petty_cash_amount,0)
             + COALESCE(cb.discount_amount,0)
             + COALESCE(cb.coupon_amount,0)
             + COALESCE(cb.deposit_amount,0)
             + COALESCE(cb.total_expense_other,0)
             - COALESCE(cb.total_amount_pay,0), 2)) > 0.01
       )::int AS payment_header_sum_mismatch,
       COUNT(*) FILTER (
         WHERE cb.doc_no IS NOT NULL
           AND ABS(ROUND(COALESCE(cb.total_net_amount,0) - COALESCE(cb.total_amount_pay,0), 2)) > 0.01
       )::int AS payment_due_paid_mismatch
     FROM docs
     LEFT JOIN cb ON cb.doc_no = docs.doc_no`,
    [TRANS_FLAG],
  );
  const row = invariant.rows[0] || {};
  console.log(
    `data_invariants: receipt_without_cb=${row.receipt_without_cb || 0}, ` +
    `header_detail_mismatch=${row.header_detail_mismatch || 0}, ` +
    `cb_total_mismatch=${row.cb_total_mismatch || 0}, ` +
    `payment_header_sum_mismatch=${row.payment_header_sum_mismatch || 0}, ` +
    `payment_due_paid_mismatch=${row.payment_due_paid_mismatch || 0}`,
  );
  if (num(row.payment_header_sum_mismatch) > 0) {
    const mismatchRows = await query(
      `SELECT cb.doc_no,
              COALESCE(cb.cash_amount,0)
              + COALESCE(cb.chq_amount,0)
              + COALESCE(cb.tranfer_amount,0)
              + COALESCE(cb.card_amount,0)
              + COALESCE(cb.total_income_amount,0)
              + COALESCE(cb.petty_cash_amount,0)
              + COALESCE(cb.discount_amount,0)
              + COALESCE(cb.coupon_amount,0)
              + COALESCE(cb.deposit_amount,0)
              + COALESCE(cb.total_expense_other,0) AS header_payment_sum,
              COALESCE(cb.total_amount_pay,0) AS total_amount_pay,
              COALESCE(cb.cash_amount,0) AS cash_amount,
              COALESCE(cb.deposit_amount,0) AS deposit_amount,
              COALESCE(cb.total_income_amount,0) AS total_income_amount,
              COALESCE(cb.total_expense_other,0) AS total_expense_other
       FROM cb_trans cb
       JOIN ap_ar_trans h ON h.doc_no = cb.doc_no AND h.trans_flag = cb.trans_flag
       WHERE cb.trans_flag = $1
         AND COALESCE(h.last_status,0) = 0
         AND ABS(ROUND(
           COALESCE(cb.cash_amount,0)
           + COALESCE(cb.chq_amount,0)
           + COALESCE(cb.tranfer_amount,0)
           + COALESCE(cb.card_amount,0)
           + COALESCE(cb.total_income_amount,0)
           + COALESCE(cb.petty_cash_amount,0)
           + COALESCE(cb.discount_amount,0)
           + COALESCE(cb.coupon_amount,0)
           + COALESCE(cb.deposit_amount,0)
           + COALESCE(cb.total_expense_other,0)
           - COALESCE(cb.total_amount_pay,0), 2)) > 0.01
       ORDER BY cb.doc_date DESC, cb.doc_no DESC
       LIMIT 12`,
      [TRANS_FLAG],
    );
    mismatchRows.rows.forEach((m) => {
      console.log(
        `payment_header_sum_mismatch_doc: ${m.doc_no} header_sum=${m.header_payment_sum} ` +
        `paid=${m.total_amount_pay} cash=${m.cash_amount} deposit=${m.deposit_amount} ` +
        `income=${m.total_income_amount} expense=${m.total_expense_other}`,
      );
    });
  }

  const overpay = await query(
    `WITH paid AS (
       SELECT doc_ref, billing_no, bill_type,
              COALESCE(SUM(sum_pay_money),0) AS paid_amount
       FROM ap_ar_trans_detail
       WHERE trans_flag = $1
         AND COALESCE(last_status,0) = 0
       GROUP BY doc_ref, billing_no, bill_type
     )
     SELECT COUNT(*)::int AS count
     FROM ap_ar_trans_detail b
     JOIN paid p
       ON p.doc_ref = b.doc_no
      AND p.billing_no = b.billing_no
      AND p.bill_type = b.bill_type
     WHERE b.trans_flag = $2
       AND COALESCE(b.last_status,0) = 0
       AND ROUND(COALESCE(p.paid_amount,0) - COALESCE(b.sum_pay_money,0), 2) > 0.01`,
    [TRANS_FLAG, BILLING_FLAG],
  );
  console.log(`billing_overpaid_rows=${overpay.rows[0]?.count || 0}`);

  const deposit = await query(
    `WITH deposit_usage AS (
       SELECT d.trans_number, cb.ap_ar_code AS cust_code, SUM(d.amount) AS used_amount
       FROM cb_trans_detail d
       JOIN cb_trans cb ON cb.doc_no = d.doc_no AND cb.trans_flag = d.trans_flag
       WHERE d.trans_flag = $1
         AND d.doc_type = 5
         AND COALESCE(d.last_status,0) = 0
       GROUP BY d.trans_number, cb.ap_ar_code
     ),
     deposit_balance AS (
       SELECT h.doc_no, h.cust_code, COALESCE(h.total_amount,0) AS total_amount,
              COALESCE((
                SELECT SUM(x.amount)
                FROM cb_trans_detail x
                JOIN cb_trans xh ON xh.doc_no = x.doc_no AND xh.trans_flag = x.trans_flag
                WHERE x.doc_type = 5
                  AND x.trans_number = h.doc_no
                  AND COALESCE(x.last_status,0) = 0
              ),0) AS all_used_amount
       FROM ic_trans h
       WHERE h.trans_flag IN (40,9040)
         AND COALESCE(h.last_status,0) = 0
     )
     SELECT
       COUNT(*) FILTER (WHERE b.doc_no IS NULL)::int AS deposit_not_found,
       COUNT(*) FILTER (WHERE b.doc_no IS NOT NULL AND u.cust_code <> b.cust_code)::int AS deposit_wrong_customer,
       COUNT(*) FILTER (WHERE b.doc_no IS NOT NULL AND ROUND(b.all_used_amount - b.total_amount, 2) > 0.01)::int AS deposit_overused
     FROM deposit_usage u
     LEFT JOIN deposit_balance b ON b.doc_no = u.trans_number`,
    [TRANS_FLAG],
  );
  const dep = deposit.rows[0] || {};
  console.log(
    `advance_deposit_invariants: not_found=${dep.deposit_not_found || 0}, ` +
    `wrong_customer=${dep.deposit_wrong_customer || 0}, overused=${dep.deposit_overused || 0}`,
  );

  const billingStatus = await query(
    `WITH bill AS (
       SELECT b.doc_no,
              COALESCE(SUM(b.sum_pay_money),0) AS bill_total,
              COALESCE(SUM((
                SELECT SUM(p.sum_pay_money)
                FROM ap_ar_trans_detail p
                WHERE p.trans_flag = $1
                  AND COALESCE(p.last_status,0) = 0
                  AND p.doc_ref = b.doc_no
                  AND p.billing_no = b.billing_no
                  AND p.bill_type = b.bill_type
              )),0) AS paid_total
       FROM ap_ar_trans_detail b
       WHERE b.trans_flag = $2
         AND COALESCE(b.last_status,0) = 0
       GROUP BY b.doc_no
     )
     SELECT
       COUNT(*) FILTER (
         WHERE ROUND(bill_total - paid_total, 2) <= 0
           AND COALESCE(h.doc_success,0) <> 1
       )::int AS paid_billing_not_success,
       COUNT(*) FILTER (
         WHERE ROUND(bill_total - paid_total, 2) > 0
           AND COALESCE(h.doc_success,0) = 1
       )::int AS unpaid_billing_success
     FROM bill
     JOIN ap_ar_trans h ON h.doc_no = bill.doc_no AND h.trans_flag = $2
     WHERE COALESCE(h.last_status,0) = 0
       AND NOT EXISTS (
         SELECT 1 FROM ap_ar_trans x
         WHERE x.trans_flag = $3
           AND x.doc_ref = h.doc_no
           AND COALESCE(x.last_status,0) = 0
       )`,
    [TRANS_FLAG, BILLING_FLAG, BILLING_CANCEL_FLAG],
  );
  const status = billingStatus.rows[0] || {};
  console.log(
    `billing_status_invariants: paid_not_success=${status.paid_billing_not_success || 0}, ` +
    `unpaid_marked_success=${status.unpaid_billing_success || 0}`,
  );

  const refCount = await query(
    `SELECT COUNT(*)::int AS missing_ref_count
     FROM ap_ar_trans h
     WHERE h.trans_flag = $1
       AND COALESCE(h.last_status,0) = 0
       AND EXISTS (
         SELECT 1
         FROM ap_ar_trans_detail d
         WHERE d.trans_flag = $1
           AND d.doc_no = h.doc_no
           AND COALESCE(d.last_status,0) = 0
       )
       AND NOT EXISTS (
         SELECT 1
         FROM ap_ar_trans_detail r
         WHERE r.trans_flag = $2
           AND r.doc_no = h.doc_no
           AND COALESCE(r.last_status,0) = 0
       )`,
    [TRANS_FLAG, REF_FLAG],
  );
  console.log(`receipt_missing_ref_rows=${refCount.rows[0]?.missing_ref_count || 0}`);
  if (num(refCount.rows[0]?.missing_ref_count) > 0) {
    const missingRefs = await query(
      `SELECT h.doc_no, h.doc_date, h.cust_code
       FROM ap_ar_trans h
       WHERE h.trans_flag = $1
         AND COALESCE(h.last_status,0) = 0
         AND EXISTS (
           SELECT 1
           FROM ap_ar_trans_detail d
           WHERE d.trans_flag = $1
             AND d.doc_no = h.doc_no
             AND COALESCE(d.last_status,0) = 0
         )
         AND NOT EXISTS (
           SELECT 1
           FROM ap_ar_trans_detail r
           WHERE r.trans_flag = $2
             AND r.doc_no = h.doc_no
             AND COALESCE(r.last_status,0) = 0
         )
       ORDER BY h.doc_date DESC, h.doc_no DESC
       LIMIT 12`,
      [TRANS_FLAG, REF_FLAG],
    );
    missingRefs.rows.forEach((m) => {
      const docDate = m.doc_date instanceof Date ? m.doc_date.toISOString().slice(0, 10) : m.doc_date;
      console.log(`receipt_missing_ref_doc: ${m.doc_no} date=${docDate} cust=${m.cust_code}`);
    });
  }

  const hasCriticalFailure = [
    row.receipt_without_cb,
    row.header_detail_mismatch,
    row.cb_total_mismatch,
    row.payment_due_paid_mismatch,
    overpay.rows[0]?.count,
    dep.deposit_not_found,
    dep.deposit_wrong_customer,
    dep.deposit_overused,
    status.paid_billing_not_success,
    status.unpaid_billing_success,
  ].some((value) => num(value) > 0);

  if (num(row.payment_header_sum_mismatch) > 0 || num(refCount.rows[0]?.missing_ref_count) > 0) {
    console.log('legacy_warnings: payment_header_sum_mismatch and receipt_missing_ref_rows are reported for review but are not treated as C# parity blockers.');
  }

  return hasCriticalFailure;
}

async function main() {
  let failures = await checkRequiredColumns();
  await printLatestDocs();
  const hasInvariantFailure = await checkInvariants();
  if (hasInvariantFailure) failures += 1;
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

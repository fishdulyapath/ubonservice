const { query, pool } = require('../src/db');

const TRANS_FLAG = 235;
const CANCEL_FLAG = 236;
const RECEIPT_FLAG = 239;
const BILLABLE_FLAGS = [44, 46, 48, 93, 95, 97];

const requiredColumns = {
  ap_ar_trans: [
    'trans_type',
    'trans_flag',
    'doc_date',
    'doc_time',
    'doc_no',
    'doc_ref',
    'doc_ref_date',
    'cust_code',
    'sale_code',
    'credit_day',
    'due_date',
    'remark',
    'total_net_value',
    'total_after_discount',
    'total_pay_money',
    'total_debt_value',
    'sum_pay_money_diff',
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
    'sum_debt_amount',
    'sum_debt_balance',
    'remark',
    'line_number',
    'bill_type',
    'sum_pay_money',
    'balance_ref',
    'vat_rate',
    'final_amount',
    'last_status',
    'calc_flag',
    'ref_doc_no',
    'ref_doc_date',
    'cust_code',
    'creator_code',
    'create_datetime',
  ],
  ic_trans: [
    'doc_no',
    'trans_flag',
    'doc_date',
    'due_date',
    'cust_code',
    'total_amount',
    'vat_rate',
    'doc_ref',
    'doc_ref_date',
    'last_status',
    'is_cancel',
    'is_doc_copy',
    'used_status_2',
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
            COUNT(d.*)::int AS detail_count,
            COALESCE(SUM(d.sum_pay_money),0) AS detail_sum,
            COALESCE(h.doc_success,0) AS doc_success,
            COALESCE(h.used_status,0) AS used_status
     FROM ap_ar_trans h
     LEFT JOIN ap_ar_trans_detail d
       ON d.doc_no = h.doc_no
      AND d.trans_flag = h.trans_flag
      AND COALESCE(d.last_status,0) = 0
     WHERE h.trans_flag = $1
     GROUP BY h.doc_no, h.doc_date, h.cust_code, h.sale_code, h.total_net_value, h.doc_success, h.used_status
     ORDER BY h.doc_date DESC, h.doc_no DESC
     LIMIT 8`,
    [TRANS_FLAG],
  );
  console.log(`latest_ar_billing_docs: ${latest.rows.length}`);
  latest.rows.forEach((row) => {
    const docDate = row.doc_date instanceof Date ? row.doc_date.toISOString().slice(0, 10) : row.doc_date;
    console.log(
      `- ${row.doc_no} date=${docDate} cust=${row.cust_code} sale=${row.sale_code || '-'} ` +
      `total=${row.total_net_value} detail_count=${row.detail_count} detail_sum=${row.detail_sum} ` +
      `success=${row.doc_success} used=${row.used_status}`,
    );
  });
}

async function checkInvariants() {
  const header = await query(
    `WITH docs AS (
       SELECT h.doc_no, COALESCE(h.total_net_value,0) AS total_net_value,
              COUNT(d.*)::int AS detail_count,
              COALESCE(SUM(d.sum_pay_money),0) AS detail_sum
       FROM ap_ar_trans h
       LEFT JOIN ap_ar_trans_detail d
         ON d.doc_no = h.doc_no
        AND d.trans_flag = h.trans_flag
        AND COALESCE(d.last_status,0) = 0
       WHERE h.trans_flag = $1
         AND COALESCE(h.last_status,0) = 0
       GROUP BY h.doc_no, h.total_net_value
     )
     SELECT
       COUNT(*) FILTER (WHERE detail_count = 0)::int AS billing_without_detail,
       COUNT(*) FILTER (WHERE detail_count > 0 AND ABS(ROUND(detail_sum - total_net_value, 2)) > 0.01)::int AS header_detail_mismatch
     FROM docs`,
    [TRANS_FLAG],
  );
  const h = header.rows[0] || {};
  console.log(
    `data_invariants: billing_without_detail=${h.billing_without_detail || 0}, ` +
    `header_detail_mismatch=${h.header_detail_mismatch || 0}`,
  );

  const detail = await query(
    `SELECT
       COUNT(*) FILTER (WHERE d.bill_type <> ALL($2::int[]))::int AS invalid_bill_type,
       COUNT(*) FILTER (WHERE src.doc_no IS NULL)::int AS source_not_found,
       COUNT(*) FILTER (WHERE src.doc_no IS NOT NULL AND src.cust_code <> h.cust_code)::int AS wrong_customer,
       COUNT(*) FILTER (
         WHERE src.doc_no IS NOT NULL
           AND ABS(ROUND(
             COALESCE(d.sum_debt_amount,0)
             - CASE WHEN src.trans_flag IN (48,97)
                    THEN -1 * COALESCE(src.total_amount,0)
                    ELSE COALESCE(src.total_amount,0)
               END, 2)) > 0.01
       )::int AS debt_amount_mismatch,
       COUNT(*) FILTER (WHERE src.doc_no IS NOT NULL AND d.billing_date <> src.doc_date)::int AS billing_date_mismatch
     FROM ap_ar_trans_detail d
     JOIN ap_ar_trans h ON h.doc_no = d.doc_no AND h.trans_flag = d.trans_flag
     LEFT JOIN ic_trans src ON src.doc_no = d.billing_no AND src.trans_flag = d.bill_type
     WHERE d.trans_flag = $1
       AND COALESCE(d.last_status,0) = 0
       AND COALESCE(h.last_status,0) = 0`,
    [TRANS_FLAG, BILLABLE_FLAGS],
  );
  const d = detail.rows[0] || {};
  console.log(
    `detail_invariants: invalid_bill_type=${d.invalid_bill_type || 0}, ` +
    `source_not_found=${d.source_not_found || 0}, wrong_customer=${d.wrong_customer || 0}, ` +
    `debt_amount_mismatch=${d.debt_amount_mismatch || 0}, billing_date_mismatch=${d.billing_date_mismatch || 0}`,
  );

  const over = await query(
    `WITH bill_usage AS (
       SELECT billing_no, bill_type, COALESCE(SUM(sum_pay_money),0) AS billed_amount
       FROM ap_ar_trans_detail
       WHERE trans_flag = $1
         AND COALESCE(last_status,0) = 0
       GROUP BY billing_no, bill_type
     ),
     pay_usage AS (
       SELECT billing_no, bill_type, COALESCE(SUM(sum_pay_money),0) AS paid_amount
       FROM ap_ar_trans_detail
       WHERE trans_flag = $2
         AND COALESCE(last_status,0) = 0
       GROUP BY billing_no, bill_type
     )
     SELECT
       COUNT(*) FILTER (
         WHERE ABS(ROUND(COALESCE(b.billed_amount,0), 2))
           - ABS(ROUND(
             CASE WHEN src.trans_flag IN (48,97)
                  THEN -1 * COALESCE(src.total_amount,0)
                  ELSE COALESCE(src.total_amount,0)
             END, 2)) > 0.01
       )::int AS source_overbilled,
       COUNT(*) FILTER (
         WHERE ABS(ROUND(COALESCE(p.paid_amount,0), 2))
           - ABS(ROUND(
             CASE WHEN src.trans_flag IN (48,97)
                  THEN -1 * COALESCE(src.total_amount,0)
                  ELSE COALESCE(src.total_amount,0)
             END, 2)) > 0.01
       )::int AS source_overpaid
     FROM ic_trans src
     LEFT JOIN bill_usage b ON b.billing_no = src.doc_no AND b.bill_type = src.trans_flag
     LEFT JOIN pay_usage p ON p.billing_no = src.doc_no AND p.bill_type = src.trans_flag
     WHERE src.trans_flag = ANY($3::int[])
       AND COALESCE(src.last_status,0) = 0
       AND COALESCE(src.is_cancel,0) = 0`,
    [TRANS_FLAG, RECEIPT_FLAG, BILLABLE_FLAGS],
  );
  const o = over.rows[0] || {};
  console.log(
    `source_usage_invariants: source_overbilled=${o.source_overbilled || 0}, ` +
    `source_overpaid=${o.source_overpaid || 0}`,
  );

  const status = await query(
    `WITH usage AS (
       SELECT src.doc_no, src.trans_flag,
              EXISTS (
                SELECT 1
                FROM ap_ar_trans_detail d
                WHERE d.billing_no = src.doc_no
                  AND d.bill_type = src.trans_flag
                  AND d.trans_flag IN ($1,$2)
                  AND COALESCE(d.last_status,0) = 0
              ) AS should_used
       FROM ic_trans src
       WHERE src.trans_flag = ANY($3::int[])
         AND COALESCE(src.last_status,0) = 0
         AND COALESCE(src.is_cancel,0) = 0
     )
     SELECT
       COUNT(*) FILTER (WHERE should_used AND COALESCE(src.used_status_2,0) <> 1)::int AS source_should_be_used,
       COUNT(*) FILTER (WHERE NOT should_used AND COALESCE(src.used_status_2,0) = 1)::int AS source_should_not_be_used
     FROM usage u
     JOIN ic_trans src ON src.doc_no = u.doc_no AND src.trans_flag = u.trans_flag`,
    [TRANS_FLAG, RECEIPT_FLAG, BILLABLE_FLAGS],
  );
  const s = status.rows[0] || {};
  console.log(
    `source_status_invariants: source_should_be_used=${s.source_should_be_used || 0}, ` +
    `source_should_not_be_used=${s.source_should_not_be_used || 0}`,
  );

  const billingStatus = await query(
    `WITH bill AS (
       SELECT b.doc_no,
              COALESCE(SUM(b.sum_pay_money),0) AS bill_total,
              COALESCE(SUM((
                SELECT SUM(p.sum_pay_money)
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
     JOIN ap_ar_trans h ON h.doc_no = bill.doc_no AND h.trans_flag = $1
     WHERE COALESCE(h.last_status,0) = 0
       AND NOT EXISTS (
         SELECT 1 FROM ap_ar_trans x
         WHERE x.trans_flag = $3
           AND x.doc_ref = h.doc_no
           AND COALESCE(x.last_status,0) = 0
       )`,
    [TRANS_FLAG, RECEIPT_FLAG, CANCEL_FLAG],
  );
  const bs = billingStatus.rows[0] || {};
  console.log(
    `billing_status_invariants: paid_not_success=${bs.paid_billing_not_success || 0}, ` +
    `unpaid_marked_success=${bs.unpaid_billing_success || 0}`,
  );

  const values = [
    h.billing_without_detail,
    h.header_detail_mismatch,
    d.invalid_bill_type,
    d.source_not_found,
    d.wrong_customer,
    d.debt_amount_mismatch,
    d.billing_date_mismatch,
    o.source_overbilled,
    o.source_overpaid,
    s.source_should_be_used,
    bs.paid_billing_not_success,
    bs.unpaid_billing_success,
  ];

  if (num(s.source_should_not_be_used) > 0) {
    console.log('legacy_warning: source_should_not_be_used is reported for review but is not treated as a blocker because legacy documents may leave used_status_2 set.');
  }

  return values.some((value) => num(value) > 0);
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

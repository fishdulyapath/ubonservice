function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function querySaleAdvanceDepositBalances(queryFn, custCode, docNos = []) {
  const params = [String(custCode || '').trim()];
  let docFilter = '';
  if (docNos.length > 0) {
    params.push(docNos);
    docFilter = `AND h.doc_no = ANY($${params.length}::text[])`;
  }

  const result = await queryFn(
    `SELECT x.doc_no, x.doc_date, x.doc_time, x.cust_code, x.trans_flag,
            CASE WHEN x.trans_flag IN (110,9110) THEN 6 ELSE 5 END AS doc_type,
            CASE WHEN x.trans_flag IN (110,9110) THEN 'deposit' ELSE 'advance' END AS payment_kind,
            CASE WHEN x.trans_flag IN (110,9110) THEN 'เงินมัดจำ' ELSE 'เงินล่วงหน้า' END AS type_label,
            COALESCE(x.remark,'') AS remark,
            COALESCE(x.total_amount,0) AS total_amount,
            COALESCE(x.used_amount,0) AS used_amount,
            GREATEST(ROUND(COALESCE(x.total_amount,0) - COALESCE(x.used_amount,0), 2), 0) AS balance_amount
     FROM (
       SELECT h.doc_no, h.doc_date, h.doc_time, h.cust_code, h.trans_flag, h.remark,
              COALESCE(h.total_amount,0) AS total_amount,
              COALESCE((
                SELECT SUM(COALESCE(r.total_amount,0))
                FROM ic_trans r
                WHERE COALESCE(r.last_status,0) = 0
                  AND r.doc_ref = h.doc_no
                  AND (
                    (h.trans_flag IN (40,9040) AND r.trans_flag = 42)
                    OR (h.trans_flag IN (110,9110) AND r.trans_flag = 112)
                  )
              ),0)
              + COALESCE((
                SELECT SUM(COALESCE(d.amount,0))
                FROM cb_trans_detail d
                WHERE COALESCE(d.last_status,0) = 0
                  AND d.trans_number = h.doc_no
                  AND d.doc_type = CASE WHEN h.trans_flag IN (110,9110) THEN 6 ELSE 5 END
              ),0) AS used_amount
       FROM ic_trans h
       WHERE h.trans_flag IN (40,9040,110,9110)
         AND h.cust_code = $1
         AND COALESCE(h.last_status,0) = 0
         AND COALESCE(h.is_doc_copy,0) <> 1
         ${docFilter}
     ) x
     WHERE GREATEST(ROUND(COALESCE(x.total_amount,0) - COALESCE(x.used_amount,0), 2), 0) > 0
     ORDER BY x.doc_date DESC, x.doc_no DESC`,
    params,
  );
  return result.rows;
}

function summarizeSaleAdvanceDepositBalances(rows = []) {
  return rows.reduce((sum, row) => sum + toNumber(row?.balance_amount), 0);
}

module.exports = {
  querySaleAdvanceDepositBalances,
  summarizeSaleAdvanceDepositBalances,
};

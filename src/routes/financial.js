const express = require('express');
const router = express.Router();
const { query } = require('../db');

// GET /service/v1/getCustomerCredit
router.get('/getCustomerCredit', async (req, res) => {
  const { cust_code = '', doc_date = '' } = req.query;
  try {
    const baseDateExpr = doc_date ? '$2::date' : 'CURRENT_DATE';
    const params = doc_date ? [cust_code, doc_date] : [cust_code];
    const sql = `
      WITH opt AS (
        SELECT COALESCE(use_credit_pay_bill_calc,0)::int AS use_credit_pay_bill_calc
        FROM erp_option
        LIMIT 1
      ),
      base AS (
        SELECT
          c.code AS user_code,
          c.name_1 AS user_name,
          COALESCE(c.address,'') AS address,
          COALESCE(c.telephone,'') AS telephone,
          COALESCE(c.website,'') AS website,
          COALESCE(d.logistic_area,'') AS logistic_area,
          COALESCE(d.credit_day,0)::int AS credit_day,
          COALESCE(d.pay_bill_date,0)::int AS pay_bill_date,
          COALESCE(d.group_main,'') AS group_main
        FROM ar_customer c
        LEFT JOIN ar_customer_detail d ON d.ar_code = c.code
        WHERE c.code = $1
        LIMIT 1
      ),
      calc AS (
        SELECT base.*, opt.use_credit_pay_bill_calc, cp.day_to_due, cp.month_to_due
        FROM base
        CROSS JOIN opt
        LEFT JOIN ar_credit_pay_bill cp ON cp.credit_day = base.credit_day
      )
      SELECT
        user_code, user_name, address, telephone, website, logistic_area, credit_day, group_main,
        CASE
          WHEN use_credit_pay_bill_calc = 1 AND day_to_due IS NOT NULL THEN
            (date_trunc('month', ${baseDateExpr})::date
              + (COALESCE(month_to_due,0)::int * interval '1 month')
              + ((GREATEST(COALESCE(day_to_due,1)::int,1) - 1) * interval '1 day'))::date
          WHEN pay_bill_date > 0 THEN
            make_date(
              extract(year from (CASE WHEN extract(day from ${baseDateExpr})::int >= pay_bill_date THEN (${baseDateExpr} + interval '1 month')::date ELSE ${baseDateExpr} END))::int,
              extract(month from (CASE WHEN extract(day from ${baseDateExpr})::int >= pay_bill_date THEN (${baseDateExpr} + interval '1 month')::date ELSE ${baseDateExpr} END))::int,
              LEAST(pay_bill_date, extract(day from (date_trunc('month', (CASE WHEN extract(day from ${baseDateExpr})::int >= pay_bill_date THEN (${baseDateExpr} + interval '1 month')::date ELSE ${baseDateExpr} END)) + interval '1 month - 1 day'))::int)
            )
          ELSE (${baseDateExpr} + credit_day)
        END AS credit_date
      FROM calc
    `;
    const result = await query(sql, params);
    const obj = result.rows.length > 0 ? {
      code: result.rows[0].user_code,
      name: result.rows[0].user_name,
      credit_day: result.rows[0].credit_day,
      credit_date: result.rows[0].credit_date,
    } : {};
    return res.json({ success: true, data: obj });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getAdvancePayment
router.get('/getAdvancePayment', async (req, res) => {
  const { cust_code = '' } = req.query;
  try {
    const sql = `
      SELECT cust_code,
        CASE WHEN _def_last_status=1 THEN 0 ELSE deposit_buy2 END AS deposit_buy2,
        CASE WHEN _def_last_status=1 THEN 0 ELSE sum_used END AS sum_used,
        CASE WHEN _def_last_status=1 THEN 0 ELSE total_amount-(deposit_buy2+sum_used) END AS balance_amount,
        doc_date, doc_no, total_amount
      FROM (
        SELECT cust_code,
          COALESCE((SELECT SUM(total_amount) FROM ic_trans AS x1 WHERE x1.last_status=0 AND x1.doc_ref=ic_trans.doc_no AND x1.trans_flag IN (112,42)),0) AS deposit_buy2,
          COALESCE((SELECT SUM(amount) FROM cb_trans_detail AS x2 WHERE x2.last_status=0 AND x2.trans_number=ic_trans.doc_no AND x2.trans_flag NOT IN (40,110)),0) AS sum_used,
          doc_date, doc_no, doc_time, total_amount,
          last_status AS _def_last_status
        FROM ic_trans
        WHERE trans_flag IN (40,9040)
          AND is_doc_copy <> 1
          AND cust_code = $1
      ) AS temp1
      ORDER BY doc_date DESC, doc_no
      LIMIT 20
    `;
    const result = await query(sql, [cust_code]);
    const data = result.rows.map(r => ({
      doc_no: r.doc_no,
      doc_date: r.doc_date,
      total_amount: r.total_amount,
      used: r.sum_used,
      balance_amount: r.balance_amount,
    }));
    return res.json({ success: true, data });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getTotalBalance
router.get('/getTotalBalance', async (req, res) => {
  const { cust_code = '' } = req.query;
  try {
    const sql = `
      SELECT ar_balance AS total_balance FROM (
        SELECT SUM(balance_amount) AS ar_balance
        FROM (
          SELECT cust_code, doc_date, doc_no,
            COALESCE(total_amount,0) AS amount,
            COALESCE(total_amount,0) - (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date AND doc_date <= date(NOW())) AS balance_amount
          FROM ic_trans WHERE COALESCE(last_status,0)=0 AND trans_flag=44 AND (inquiry_type=0 OR inquiry_type=2) AND doc_date <= date(NOW())
          UNION ALL
          SELECT cust_code, doc_date, doc_no,
            COALESCE(total_amount,0) AS amount,
            COALESCE(total_amount,0) - (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date AND doc_date <= date(NOW())) AS balance_amount
          FROM ic_trans WHERE COALESCE(last_status,0)=0 AND (trans_flag=46 OR trans_flag=93 OR trans_flag=99 OR trans_flag=95 OR trans_flag=101) AND doc_date <= date(NOW())
          UNION ALL
          SELECT cust_code, doc_date, doc_no,
            -1*COALESCE(total_amount,0) AS amount,
            -1*(COALESCE(total_amount,0) + (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date AND doc_date <= date(NOW()))) AS balance_amount
          FROM ic_trans WHERE COALESCE(last_status,0)=0 AND ((trans_flag=48 AND inquiry_type IN (0,2,4)) OR trans_flag=97 OR trans_flag=103) AND doc_date <= date(NOW())
        ) AS temp2 WHERE doc_no <> '' AND cust_code = $1
      ) AS temp3 WHERE ar_balance <> 0
    `;
    const result = await query(sql, [cust_code]);
    let total_balance = 0;
    for (const r of result.rows) {
      total_balance += parseFloat(r.total_balance) || 0;
    }
    return res.json({ success: true, total_balance });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

module.exports = router;

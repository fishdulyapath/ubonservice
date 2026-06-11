const express = require('express');
const router = express.Router();
const { query, pool } = require('../db');

// GET /service/v1/getDocList
router.get('/getDocList', async (req, res) => {
  const { cust_code = '', trans_flag = '' } = req.query;
  try {
    const tf = parseInt(trans_flag);
    const transWhere = (!isNaN(tf) && trans_flag !== '')
      ? ` AND ic.trans_flag = ${tf}`
      : ' AND ic.trans_flag IN (40,44,48,46)';

    const sql = `
      WITH SUM_CN AS (
        SELECT ref_doc_no,
          SUM(total_amount) AS cn_total_amount,
          SUM(total_except_vat) AS cn_total_except_vat,
          SUM(total_after_vat) AS cn_total_after_vat,
          SUM(total_vat_value) AS cn_total_vat_value
        FROM (
          SELECT DISTINCT
            b.ref_doc_no,
            a.doc_no,
            COALESCE(a.total_amount,0) AS total_amount,
            COALESCE(a.total_except_vat,0) AS total_except_vat,
            COALESCE(a.total_after_vat,0) AS total_after_vat,
            COALESCE(a.total_vat_value,0) AS total_vat_value
          FROM ic_trans a
          JOIN ic_trans_detail b ON a.doc_no = b.doc_no
          WHERE COALESCE(a.last_status,0) = 0
            AND COALESCE(b.ref_doc_no,'') <> ''
        ) AS cn
        GROUP BY ref_doc_no
      )
      SELECT
        ic.inquiry_type, ic.last_status, ic.trans_flag, ic.send_type,
        ic.doc_no, ic.doc_date, ic.cust_code, ic.doc_time,
        COALESCE((SELECT name_1 FROM erp_user WHERE UPPER(code)=UPPER(ic.sale_code) LIMIT 1),'') AS emp_name,
        COALESCE(ic.sale_code,'') AS emp_code,
        ic.remark,
        ic.doc_group AS status,
        COALESCE(ic.total_discount,0) AS total_discount,
        COALESCE(ic.discount_word,'') AS discount_word,
        COALESCE((
          SELECT SUM(balance_amount) FROM (
            SELECT cust_code, doc_date, credit_date AS due_date, doc_no, trans_flag AS doc_type, used_status,
              doc_ref AS ref_doc_no, doc_ref_date AS ref_doc_date,
              COALESCE(total_amount,0) AS amount,
              COALESCE(total_amount,0) - (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date) AS balance_amount,
              branch_code
            FROM ic_trans WHERE COALESCE(last_status,0)=0 AND trans_flag=44 AND (inquiry_type=0 OR inquiry_type=2) AND cust_code=ic.cust_code
            UNION ALL
            SELECT cust_code, doc_date, credit_date AS due_date, doc_no, trans_flag AS doc_type, used_status,
              '' AS ref_doc_no, NULL AS ref_doc_date,
              COALESCE(total_amount,0) AS amount,
              COALESCE(total_amount,0) - (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date) AS balance_amount,
              branch_code
            FROM ic_trans WHERE COALESCE(last_status,0)=0 AND trans_flag IN (46,93,99,95,101) AND cust_code=ic.cust_code
            UNION ALL
            SELECT cust_code, doc_date, credit_date AS due_date, doc_no, trans_flag AS doc_type, used_status,
              '' AS ref_doc_no, NULL AS ref_doc_date,
              -1*COALESCE(total_amount,0) AS amount,
              -1*(COALESCE(total_amount,0) + (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date)) AS balance_amount,
              branch_code
            FROM ic_trans WHERE COALESCE(last_status,0)=0 AND ((trans_flag=48 AND inquiry_type IN (0,2,4)) OR trans_flag IN (97,103)) AND cust_code=ic.cust_code
          ) AS xx WHERE balance_amount <> 0 AND doc_no = ar.doc_no
          GROUP BY cust_code, doc_date, doc_no
          ORDER BY cust_code, doc_date, doc_no
        ),0) AS balance,
        COALESCE(cus.name_1,'') AS cust_name,
        COALESCE(ar.doc_no,'') AS ar_no,
        ic.total_amount - COALESCE((SELECT cn_total_amount FROM SUM_CN WHERE ic.doc_no=SUM_CN.ref_doc_no),0) AS total_amount,
        COALESCE((SELECT cn_total_amount FROM SUM_CN WHERE ic.doc_no=SUM_CN.ref_doc_no),0) AS cn_total_amount
      FROM ic_trans ic
      LEFT JOIN ar_customer cus ON cus.code = ic.cust_code
      LEFT JOIN ap_ar_trans_detail ar ON ar.billing_no = ic.doc_no AND ar.trans_flag = 239
      WHERE 1=1 AND ic.cust_code = $1 ${transWhere}
      ORDER BY ic.create_datetime DESC, ic.doc_no ASC
    `;

    const result = await query(sql, [cust_code]);
    const data = result.rows.map(r => ({
      inquiry_type: r.inquiry_type,
      trans_flag: r.trans_flag,
      last_status: r.last_status,
      doc_no: r.doc_no,
      doc_date: r.doc_date,
      doc_time: r.doc_time,
      cust_code: r.cust_code,
      send_type: r.send_type,
      total_amount: r.total_amount,
      emp_code: r.emp_code,
      emp_name: r.emp_name,
      remark: r.remark,
      ar_no: r.ar_no,
      total_discount: r.total_discount,
      balance: r.balance,
      discount_word: r.discount_word,
      status: r.status,
      cust_name: r.cust_name,
      cn_total_amount: r.cn_total_amount,
    }));

    return res.json({ success: true, data });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getDocDetail
router.get('/getDocDetail', async (req, res) => {
  const { cust_code = '', doc_no = '' } = req.query;
  try {
    const client = await pool.connect();
    try {
      const headerResult = await client.query(
        `SELECT *, sale_code AS emp_code,
          COALESCE((SELECT name_1 FROM erp_user WHERE UPPER(code)=UPPER(sale_code) LIMIT 1),'') AS emp_name
        FROM ic_trans WHERE cust_code=$1 AND doc_no=$2`,
        [cust_code, doc_no]
      );

      if (headerResult.rows.length === 0) {
        return res.json({ success: true, data: {} });
      }

      const h = headerResult.rows[0];
      const obj = {
        remark_5: h.remark_5 || '',
        doc_no: h.doc_no,
        doc_date: h.doc_date,
        doc_time: h.doc_time,
        cust_code: h.cust_code,
        send_type: h.send_type,
        total_amount: h.total_amount,
        emp_code: h.emp_code,
        emp_name: h.emp_name,
        items: [],
      };

      const detailResult = await client.query(
        `SELECT qty,item_code,item_name,unit_code,price,wh_code,shelf_code,
          stand_value,divide_value,ratio,sum_amount,
          COALESCE(discount,'') AS discount, COALESCE(discount_amount,0) AS discount_amount
        FROM ic_trans_detail
        WHERE doc_no=$1
          AND (COALESCE(set_ref_line,'') = '' OR COALESCE(item_type,0) = 3)`,
        [h.doc_no]
      );

      obj.items = detailResult.rows.map(r => ({
        item_code: r.item_code,
        item_name: r.item_name,
        unit_code: r.unit_code,
        wh_code: r.wh_code,
        shelf_code: r.shelf_code,
        stand_value: r.stand_value,
        qty: r.qty,
        divide_value: r.divide_value,
        ratio: r.ratio,
        price: r.price,
        sum_amount: r.sum_amount,
        discount: r.discount,
        discount_amount: r.discount_amount,
      }));

      return res.json({ success: true, data: obj });
    } finally {
      client.release();
    }
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getReceiptDetail
router.get('/getReceiptDetail', async (req, res) => {
  const { doc_no = '' } = req.query;
  if (!doc_no) return res.status(400).json({ success: false, msg: 'doc_no is required' });
  try {
    const headerResult = await query(
      `SELECT t.doc_no, t.doc_date, t.doc_time, t.cust_code, t.inquiry_type,
          t.vat_type, t.vat_rate, t.total_amount, t.total_before_vat,
          t.total_vat_value, t.total_after_vat, t.total_discount,
          COALESCE(t.discount_word,'') AS discount_word, t.remark,
          COALESCE(t.sale_code,'') AS sale_code,
          COALESCE((SELECT name_1 FROM erp_user WHERE UPPER(code)=UPPER(t.sale_code) LIMIT 1),'') AS sale_name,
          COALESCE(ar.name_1,'') AS cust_name,
          COALESCE(cb.cash_amount,0) AS cash_amount,
          COALESCE(cb.tranfer_amount,0) AS tranfer_amount,
          COALESCE(cb.card_amount,0) AS card_amount,
          COALESCE(cb.total_credit_charge,0) AS total_credit_charge,
          COALESCE(cb.money_change,0) AS money_change,
          COALESCE(cb.total_net_amount,0) AS total_net_amount,
          COALESCE(cb.total_income_amount,0) AS total_income_amount
       FROM ic_trans t
       LEFT JOIN ar_customer ar ON ar.code = t.cust_code
       LEFT JOIN cb_trans cb ON cb.doc_no = t.doc_no AND cb.trans_flag = 44
       WHERE t.doc_no = $1 AND t.trans_flag = 44
       LIMIT 1`,
      [doc_no]
    );

    if (headerResult.rows.length === 0) {
      return res.status(404).json({ success: false, msg: 'document not found' });
    }

    const h = headerResult.rows[0];

    const itemsResult = await query(
      `SELECT item_code, item_name, unit_code, qty, price, sum_amount,
        COALESCE(discount,'') AS discount, COALESCE(discount_amount,0) AS discount_amount
       FROM ic_trans_detail
       WHERE doc_no = $1
         AND (COALESCE(set_ref_line,'') = '' OR COALESCE(item_type,0) = 3)
       ORDER BY line_number`,
      [doc_no]
    );

    const companyResult = await query(
      'SELECT company_name_1, address_1, telephone_number FROM erp_company_profile LIMIT 1'
    );
    const company = companyResult.rows[0] || {};

    return res.json({
      success: true,
      data: {
        doc_no: h.doc_no,
        doc_date: h.doc_date,
        doc_time: h.doc_time,
        cust_code: h.cust_code,
        cust_name: h.cust_name,
        inquiry_type: h.inquiry_type,
        vat_type: h.vat_type,
        vat_rate: h.vat_rate,
        sale_code: h.sale_code,
        sale_name: h.sale_name,
        total_discount: h.total_discount,
        discount_word: h.discount_word,
        total_before_vat: h.total_before_vat,
        total_vat_value: h.total_vat_value,
        total_after_vat: h.total_after_vat,
        total_amount: h.total_amount,
        total_net_amount: h.total_net_amount,
        remark: h.remark,
        cash_amount: h.cash_amount,
        tranfer_amount: h.tranfer_amount,
        card_amount: h.card_amount,
        total_credit_charge: h.total_credit_charge,
        money_change: h.money_change,
        total_income_amount: h.total_income_amount,
        items: itemsResult.rows.map(r => ({
          item_code: r.item_code,
          item_name: r.item_name,
          unit_code: r.unit_code,
          qty: Number(r.qty),
          price: Number(r.price),
          sum_amount: Number(r.sum_amount),
          discount: r.discount,
          discount_amount: Number(r.discount_amount),
        })),
        company: {
          name: company.company_name_1 || '',
          address: company.address_1 || '',
          tel: company.telephone_number || '',
        },
      },
    });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// GET /service/v1/getCompanyProfile
router.get('/getCompanyProfile', async (req, res) => {
  try {
    const result = await query(
      'SELECT company_name_1, address_1, telephone_number FROM erp_company_profile LIMIT 1'
    );
    const data = result.rows.map(r => ({
      company_name: r.company_name_1,
      address: r.address_1,
      telephone_number: r.telephone_number,
    }));
    return res.json({ success: true, data });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

module.exports = router;

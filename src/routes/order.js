const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const { pool, withTransaction, query } = require('../db');

// POST /service/v1/sendorder
router.post('/sendorder', async (req, res) => {
  try {
    let obj = req.body;
    if (typeof obj === 'string') obj = JSON.parse(obj);

    const doc_date = obj.doc_date || '';
    const send_date = obj.send_date || doc_date;
    const send_day = obj.send_day || '0';
    const doc_no = obj.doc_no || '';
    const cust_code = obj.cust_code || '';
    const send_type = obj.send_type || '0';
    const vat_rate = '7';
    const total_after_vat = obj.total_after_vat || '0';
    const total_value = obj.total_value || '0';
    const total_except_vat = obj.total_except_vat || '0';
    const total_amount = obj.total_amount || '0';
    const doc_time = obj.doc_time || '';
    const remark = obj.remark || '';
    const emp_code = obj.emp_code || '';
    const creator_code = String(obj.creator_code || '').trim();
    const credit_day = obj.credit_day || '0';
    const credit_date = obj.credit_date || doc_date;
    const items = obj.items || [];

    const total_before_vat = (parseFloat(total_after_vat) * 100) / (100 + parseFloat(vat_rate));
    const total_vat_value = parseFloat(total_after_vat) - total_before_vat;

    await withTransaction(async (client) => {
      // INSERT HEADER
      await client.query(
        `INSERT INTO ic_trans (
          inquiry_type,vat_type,trans_type,trans_flag,doc_date,doc_no,
          cust_code,send_date,send_day,vat_rate,total_value,
          total_vat_value,total_after_vat,total_amount,total_before_vat,
          doc_time,doc_format_code,creator_code,sale_code,total_discount,
          remark,send_type,total_except_vat,credit_day,credit_date
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [
          0, 1, 2, 30,
          doc_date, doc_no, cust_code, send_date,
          parseInt(send_day), parseFloat(vat_rate),
          parseFloat(total_value), total_vat_value,
          parseFloat(total_after_vat), parseFloat(total_amount),
          total_before_vat, doc_time, 'QT', creator_code, emp_code,
          0, remark, parseInt(send_type),
          parseFloat(total_except_vat), parseInt(credit_day), credit_date,
        ]
      );

      // INSERT DETAIL
      let line = 0;
      for (const it of items) {
        if (it.item_type !== '3' && it.item_type !== 3) {
          line++;
          await client.query(
            `INSERT INTO ic_trans_detail (
              set_ref_line,set_ref_price,set_ref_qty,item_type,item_code_main,ref_guid,
              price_set_ratio,inquiry_type,vat_type,trans_type,trans_flag,doc_date,doc_no,
              cust_code,item_code,item_name,unit_code,qty,price,sum_amount,line_number,
              remark,wh_code,shelf_code,stand_value,divide_value,ratio,doc_time,doc_date_calc,
              discount,discount_amount
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
            [
              '', parseFloat(it.price || 0), 0,  // set_ref_price = price (Java bindDetail setRefPrice=price)
              0, '', '',
              0, 0, 1, 2, 30,
              doc_date, doc_no, cust_code,
              it.item_code, it.item_name, it.unit_code,
              parseFloat(it.qty || 0), parseFloat(it.price || 0),
              parseFloat(it.sum_amount || 0), line,
              '', it.wh_code || '', it.shelf_code || '',
              parseFloat(it.stand_value || 0), parseFloat(it.divide_value || 0),
              0,
              doc_time, doc_date, '', 0,
            ]
          );
        } else {
          // Product set
          const guid = uuidv4();
          line++;
          await client.query(
            `INSERT INTO ic_trans_detail (
              set_ref_line,set_ref_price,set_ref_qty,item_type,item_code_main,ref_guid,
              price_set_ratio,inquiry_type,vat_type,trans_type,trans_flag,doc_date,doc_no,
              cust_code,item_code,item_name,unit_code,qty,price,sum_amount,line_number,
              remark,wh_code,shelf_code,stand_value,divide_value,ratio,doc_time,doc_date_calc,
              discount,discount_amount
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
            [
              '', 0, 0,
              3, '', guid,
              0, 0, 1, 2, 30,
              doc_date, doc_no, cust_code,
              it.item_code, it.item_name, it.unit_code,
              parseFloat(it.qty || 0), parseFloat(it.price || 0),
              parseFloat(it.sum_amount || 0), line,
              '', it.wh_code || '', it.shelf_code || '',
              parseFloat(it.stand_value || 0), parseFloat(it.divide_value || 0),
              0,
              doc_time, doc_date, '', 0,
            ]
          );

          const subs = it.sub_item || [];
          for (const sub of subs) {
            line++;
            const qty = parseFloat(it.qty || 0) * parseFloat(sub.qty || 0);
            const sum_amt = parseFloat(sub.price || 0) * qty;
            await client.query(
              `INSERT INTO ic_trans_detail (
                set_ref_line,set_ref_price,set_ref_qty,item_type,item_code_main,ref_guid,
                price_set_ratio,inquiry_type,vat_type,trans_type,trans_flag,doc_date,doc_no,
                cust_code,item_code,item_name,unit_code,qty,price,sum_amount,line_number,
                remark,wh_code,shelf_code,stand_value,divide_value,ratio,doc_time,doc_date_calc,
                discount,discount_amount
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)`,
              [
                guid, parseFloat(sub.price || 0), parseFloat(sub.qty || 0),
                0, it.item_code, '',
                parseFloat(sub.price_ratio || 0), 0, 1, 2, 30,
                doc_date, doc_no, cust_code,
                sub.item_code, sub.item_name, sub.unit_code,
                qty, parseFloat(sub.price || 0),
                sum_amt, line,
                '', it.wh_code || '', it.shelf_code || '',
                parseFloat(sub.stand_value || 0), parseFloat(sub.divide_value || 0),
                0,
                doc_time, doc_date, '', 0,
              ]
            );
          }
        }
      }
    });

    return res.json({ success: true });
  } catch (ex) {
    return res.status(400).send(ex.message);
  }
});

// POST /service/v1/pay
router.post('/pay', async (req, res) => {
  const resp = { success: false };
  try {
    let obj = req.body;
    if (typeof obj === 'string') obj = JSON.parse(obj);

    const doc_no_rc = obj.doc_no || '';
    const doc_time = obj.doc_time || '';
    const cust_code = obj.cust_code || '';
    const doc_date = obj.doc_date || '';
    const wallet_amount = (obj.wallet_amount || '0').toString();
    const total_amount = (obj.total_amount || '0').toString();
    const trans_number = (obj.trans_number || '0').toString();
    const no_approved = (obj.no_approved || '0').toString();
    const emp_code = obj.emp_code || '';
    const creator_code = emp_code;
    const remark = obj.remark || '';
    const branch_code = '0000';
    const docList = obj.doc_detail || [];

    if (docList.length === 0) {
      resp.success = false;
      return res.json(resp);
    }

    const client = await pool.connect();
    try {
      // DELETE existing records for this doc_no
      await client.query(`DELETE FROM ap_ar_trans_detail WHERE doc_no = $1`, [doc_no_rc]);
      await client.query(`DELETE FROM ap_ar_trans WHERE doc_no = $1`, [doc_no_rc]);
      await client.query(`DELETE FROM cb_trans WHERE doc_no = $1`, [doc_no_rc]);
      await client.query(`DELETE FROM cb_trans_detail WHERE doc_no = $1`, [doc_no_rc]);

      // Loop doc_detail: update ic_trans + insert ap_ar_trans_detail
      for (let i = 0; i < docList.length; i++) {
        const item = docList[i];
        const item_doc_no = item.doc_no || '';
        const item_doc_date = item.doc_date || '';
        const dept_amount = (item.total_amount || '0').toString();

        await client.query(
          `UPDATE ic_trans SET used_status_2='1' WHERE doc_no=$1 AND trans_flag=44`,
          [item_doc_no]
        );

        await client.query(
          `INSERT INTO ap_ar_trans_detail (
            trans_type,trans_flag,doc_date,doc_no,billing_no,billing_date,due_date,
            sum_debt_amount,sum_pay_money,balance_ref,calc_flag,line_number,bill_type
          ) VALUES (2,239,$1,$2,$3,$4,$5,$6,$7,$8,0,$9,'44')`,
          [doc_date, doc_no_rc, item_doc_no, item_doc_date, doc_date,
            dept_amount, dept_amount, dept_amount, i]
        );
      }

      // INSERT ap_ar_trans
      await client.query(
        `INSERT INTO ap_ar_trans (
          trans_type,trans_flag,doc_date,doc_time,doc_no,doc_format_code,
          cust_code,branch_code,total_net_value,creator_code
        ) VALUES (2,239,$1,$2,$3,'EE',$4,$5,$6,$7)`,
        [doc_date, doc_time, doc_no_rc, cust_code, branch_code, total_amount, creator_code]
      );

      // INSERT cb_trans
      await client.query(
        `INSERT INTO cb_trans (
          trans_type,trans_flag,doc_no,doc_date,doc_time,ap_ar_code,pay_type,
          doc_format_code,total_amount,total_net_amount,total_amount_pay,wallet_amount
        ) VALUES (2,239,$1,$2,$3,$4,1,'EE',$5,$6,$7,$8)`,
        [doc_no_rc, doc_date, doc_time, cust_code, total_amount, wallet_amount, wallet_amount, wallet_amount]
      );

      // INSERT cb_trans_detail
      await client.query(
        `INSERT INTO cb_trans_detail (
          trans_type,trans_flag,doc_no,doc_date,doc_time,trans_number,credit_card_type,
          amount,sum_amount,doc_type,ap_ar_code,trans_number_type,ap_ar_type,ref1,no_approved
        ) VALUES (2,239,$1,$2,$3,$4,'NONE',$5,$6,'21',$7,1,1,$8,$9)`,
        [doc_no_rc, doc_date, doc_time, trans_number, wallet_amount, wallet_amount, cust_code, doc_no_rc, no_approved]
      );

      resp.success = true;
      resp.msg = 'success';
    } finally {
      client.release();
    }

    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// POST /service/v1/cancelOrder
router.post('/cancelOrder', async (req, res) => {
  const resp = { success: false };
  try {
    let obj = req.body;
    if (typeof obj === 'string') obj = JSON.parse(obj);
    if (!obj) obj = {};

    const docDateStr = obj.doc_date || '';
    const docTime = obj.doc_time || '';
    const docNoSOC = obj.doc_no || '';
    const docRefQT = obj.doc_ref || '';
    const custCode = obj.cust_code || '';
    const empCode = obj.emp_code || '';
    const creatorCode = String(obj.creator_code || '').trim();
    const remark = obj.remark || '';
    const sendTypeStr = obj.send_type || '0';

    if (!docDateStr || !docNoSOC || !docRefQT || !custCode) {
      return res.status(400).send('{ERROR: doc_date, doc_no, doc_ref, cust_code are required}');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1) Check SOC duplicate
      const chkSOC = await client.query(
        'SELECT 1 FROM ic_trans WHERE doc_no=$1 AND trans_flag=31 LIMIT 1',
        [docNoSOC]
      );
      if (chkSOC.rows.length > 0) {
        await client.query('ROLLBACK');
        resp.msg = 'duplicate_doc_no';
        return res.json(resp);
      }

      // 2) Load QT header
      const qtRes = await client.query(
        `SELECT doc_date, inquiry_type, vat_type,
          COALESCE(branch_code,'') AS branch_code,
          COALESCE(sale_code,'') AS sale_code,
          COALESCE(send_type,0) AS send_type,
          COALESCE(send_day,0) AS send_day,
          COALESCE(send_date, doc_date) AS send_date,
          COALESCE(credit_day,0) AS credit_day,
          COALESCE(credit_date, doc_date) AS credit_date,
          COALESCE(vat_rate,0) AS vat_rate,
          COALESCE(total_value,0) AS total_value,
          COALESCE(total_discount,0) AS total_discount,
          COALESCE(total_vat_value,0) AS total_vat_value,
          COALESCE(total_after_vat,0) AS total_after_vat,
          COALESCE(total_except_vat,0) AS total_except_vat,
          COALESCE(total_amount,0) AS total_amount,
          COALESCE(total_before_vat,0) AS total_before_vat,
          COALESCE(last_status,0) AS last_status
        FROM ic_trans
        WHERE doc_no=$1 AND trans_flag=30 AND doc_format_code='QT' AND cust_code=$2
        LIMIT 1`,
        [docRefQT, custCode]
      );

      if (qtRes.rows.length === 0) {
        await client.query('ROLLBACK');
        resp.msg = 'ref_doc_not_found';
        return res.json(resp);
      }

      const qt = qtRes.rows[0];

      if (parseInt(qt.last_status) === 1) {
        await client.query('ROLLBACK');
        resp.msg = 'already_cancelled';
        return res.json(resp);
      }

      // 3) Check SOC referencing this QT already exists
      const chkRef = await client.query(
        `SELECT 1 FROM ic_trans WHERE doc_ref=$1 AND trans_flag=31 AND doc_format_code='SOC' LIMIT 1`,
        [docRefQT]
      );
      if (chkRef.rows.length > 0) {
        await client.query('ROLLBACK');
        resp.msg = 'already_cancelled';
        return res.json(resp);
      }

      // 4) QT must have detail
      const chkDetail = await client.query(
        'SELECT 1 FROM ic_trans_detail WHERE doc_no=$1 LIMIT 1',
        [docRefQT]
      );
      if (chkDetail.rows.length === 0) {
        await client.query('ROLLBACK');
        resp.msg = 'ref_doc_has_no_detail';
        return res.json(resp);
      }

      // 5) Insert SOC header
      const saleCode = (!empCode) ? qt.sale_code : empCode;
      const sendType = parseInt(sendTypeStr) || parseInt(qt.send_type) || 0;

      await client.query(
        `INSERT INTO ic_trans (
          trans_type,trans_flag,doc_date,doc_no,doc_ref,doc_ref_date,
          tax_doc_no,tax_doc_date,inquiry_type,vat_type,cust_code,branch_code,
          sale_code,send_type,send_day,send_date,credit_day,credit_date,
          vat_rate,total_value,total_discount,total_vat_value,total_after_vat,
          total_except_vat,total_amount,total_before_vat,
          remark,doc_time,doc_format_code,creator_code
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
        [
          2, 31, docDateStr, docNoSOC, docRefQT, qt.doc_date,
          docNoSOC, docDateStr,
          qt.inquiry_type, qt.vat_type, custCode, qt.branch_code,
          saleCode, sendType, qt.send_day, qt.send_date, qt.credit_day, qt.credit_date,
          qt.vat_rate, qt.total_value, qt.total_discount, qt.total_vat_value, qt.total_after_vat,
          qt.total_except_vat, qt.total_amount, qt.total_before_vat,
          remark, docTime, 'SOC', creatorCode,
        ]
      );

      // 6) Copy detail QT -> SOC
      await client.query(
        `INSERT INTO ic_trans_detail (
          trans_type,trans_flag,doc_date,doc_no,doc_ref,cust_code,inquiry_type,
          item_code,item_name,unit_code,qty,price,discount,sum_amount,remark,line_number,
          branch_code,wh_code,shelf_code,stand_value,divide_value,ratio,vat_type,
          set_ref_line,set_ref_price,set_ref_qty,item_type,item_code_main,ref_guid,
          doc_time,doc_date_calc,discount_amount,price_set_ratio,sale_code
        )
        SELECT
          trans_type,$1 AS trans_flag,$2 AS doc_date,$3 AS doc_no,'' AS doc_ref,cust_code,inquiry_type,
          item_code,item_name,unit_code,qty,price,discount,sum_amount,remark,line_number,
          branch_code,wh_code,shelf_code,stand_value,divide_value,ratio,vat_type,
          set_ref_line,set_ref_price,set_ref_qty,item_type,item_code_main,ref_guid,
          $4 AS doc_time,$5 AS doc_date_calc,discount_amount,price_set_ratio,sale_code
        FROM ic_trans_detail
        WHERE doc_no=$6
        ORDER BY line_number`,
        [31, docDateStr, docNoSOC, docTime, docDateStr, docRefQT]
      );

      // 7) Update QT last_status = 1
      await client.query(
        'UPDATE ic_trans SET last_status=1 WHERE doc_no=$1 AND trans_flag=30',
        [docRefQT]
      );

      await client.query('COMMIT');

      resp.success = true;
      resp.msg = 'success';
      resp.cancel_doc_no = docNoSOC;
      resp.ref_doc_no = docRefQT;
      return res.json(resp);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (ex) {
    return res.status(400).send('{ERROR: ' + ex.message + '}');
  }
});

// Shared SQL for order history (same CTE used in getOrderHistory and getOrderHeader)
const ORDER_HISTORY_CTE = `
WITH SUM_CN AS (
  SELECT b.ref_doc_no AS ref_doc_no,
    SUM(a.total_amount) AS cn_total_amount,
    SUM(a.total_except_vat) AS cn_total_except_vat,
    SUM(a.total_after_vat) AS cn_total_after_vat,
    SUM(a.total_vat_value) AS cn_total_vat_value
  FROM ic_trans a
  LEFT JOIN ic_trans_detail b ON a.doc_no = b.doc_no
  GROUP BY b.ref_doc_no
)
SELECT DISTINCT *
FROM (
  SELECT
    COALESCE(ic_inv.remark_5,'') AS remark_5,
    COALESCE(ap_inv.doc_no,'') AS inv_doc_no,
    COALESCE(ap_inv.doc_date::text,'') AS inv_doc_date,
    COALESCE(ap_ar_cb.wallet_amount,0) AS wallet_amount,
    COALESCE(ic_qt.remark,'') AS remark_qt,
    COALESCE(ic_soc.remark,'') AS remark_cancel,
    COALESCE(ap_inv.remark,'') AS remark_inv,
    ic_qt.doc_no, ic_qt.doc_date, ic_qt.doc_time, ic_qt.cust_code,
    ic_qt.send_type, ic_qt.sale_code AS emp_code,
    COALESCE((SELECT name_1 FROM erp_user WHERE UPPER(code)=UPPER(ic_qt.sale_code) LIMIT 1),'') AS emp_name,
    ic_qt.total_amount - COALESCE((SELECT cn_total_amount FROM SUM_CN WHERE ic_inv.doc_no=SUM_CN.ref_doc_no),0) AS total_amount,
    COALESCE((SELECT cn_total_amount FROM SUM_CN WHERE ic_inv.doc_no=SUM_CN.ref_doc_no),0) AS cn_total_amount,
    ic_qt.total_except_vat - COALESCE((SELECT cn_total_except_vat FROM SUM_CN WHERE ic_inv.doc_no=SUM_CN.ref_doc_no),0) AS total_except_vat,
    ic_qt.total_after_vat - COALESCE((SELECT cn_total_after_vat FROM SUM_CN WHERE ic_inv.doc_no=SUM_CN.ref_doc_no),0) AS total_after_vat,
    ic_qt.total_vat_value - COALESCE((SELECT cn_total_vat_value FROM SUM_CN WHERE ic_inv.doc_no=SUM_CN.ref_doc_no),0) AS total_vat_value,
    COALESCE((
      SELECT balance_amount FROM (
        SELECT cust_code, doc_date, credit_date AS due_date, doc_no, trans_flag AS doc_type, used_status, doc_ref AS ref_doc_no, doc_ref_date AS ref_doc_date,
          COALESCE(total_amount,0) AS amount,
          COALESCE(total_amount,0) - (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date) AS balance_amount,
          branch_code
        FROM ic_trans WHERE COALESCE(last_status,0)=0 AND trans_flag=44 AND inquiry_type IN (0,2) AND cust_code=ic_qt.cust_code
        UNION ALL
        SELECT cust_code, doc_date, credit_date AS due_date, doc_no, trans_flag AS doc_type, used_status, '' AS ref_doc_no, NULL AS ref_doc_date,
          COALESCE(total_amount,0) AS amount,
          COALESCE(total_amount,0) - (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date) AS balance_amount,
          branch_code
        FROM ic_trans WHERE COALESCE(last_status,0)=0 AND trans_flag IN (46,93,95,99,101) AND cust_code=ic_qt.cust_code
        UNION ALL
        SELECT cust_code, doc_date, credit_date AS due_date, doc_no, trans_flag AS doc_type, used_status, '' AS ref_doc_no, NULL AS ref_doc_date,
          -1*COALESCE(total_amount,0) AS amount,
          -1*(COALESCE(total_amount,0) + (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date)) AS balance_amount,
          branch_code
        FROM ic_trans WHERE COALESCE(last_status,0)=0 AND ((trans_flag=48 AND inquiry_type IN (0,2,4)) OR trans_flag IN (97,103)) AND cust_code=ic_qt.cust_code
      ) AS xx WHERE balance_amount <> 0 AND doc_no = ap_ar.billing_no ORDER BY cust_code, doc_date, doc_no LIMIT 1
    ),0) AS balance,
    CASE
      WHEN ic_soc.doc_no IS NOT NULL OR ic_ssc.doc_no IS NOT NULL THEN 'cancel'
      WHEN ap_ar.doc_no IS NOT NULL OR cb_inv.total_amount_pay > 0 THEN 'success'
      WHEN ap_ar.doc_no IS NULL AND ap_inv.doc_no IS NOT NULL THEN 'payment'
      WHEN ap_ar.doc_no IS NULL AND ap_inv.doc_no IS NULL AND ap_so.doc_no IS NOT NULL THEN 'packing'
      ELSE 'pending'
    END AS status
  FROM ic_trans ic_qt
  LEFT JOIN ic_trans ic_soc ON ic_soc.doc_ref = ic_qt.doc_no AND ic_soc.trans_flag = 31
  LEFT JOIN ap_ar_trans_detail ap_so ON ap_so.billing_no = ic_qt.doc_no AND ap_so.trans_flag = 36
  LEFT JOIN ic_trans ic_ssc ON ic_ssc.doc_ref = ap_so.doc_no AND ic_ssc.trans_flag = 37
  LEFT JOIN ap_ar_trans_detail ap_inv ON ap_inv.billing_no = ap_so.doc_no AND ap_inv.trans_flag = 44
  LEFT JOIN ic_trans ic_inv ON ic_inv.doc_no = ap_inv.doc_no AND ic_inv.trans_flag = 44
  LEFT JOIN cb_trans cb_inv ON cb_inv.doc_no = ap_inv.doc_no AND ic_inv.trans_flag = 44
  LEFT JOIN ap_ar_trans_detail ap_ar ON ap_ar.billing_no = ap_inv.doc_no AND ap_ar.trans_flag = 239
  LEFT JOIN cb_trans ap_ar_cb ON ap_ar_cb.doc_no = ap_ar.doc_no AND ap_ar_cb.trans_flag = 239
  WHERE ic_qt.trans_flag = 30 AND ic_qt.cust_code = $1 AND ic_qt.doc_no LIKE '%WEBQT%'
  ORDER BY doc_date DESC
) AS temp WHERE 1=1
`;

function mapOrderRow(r) {
  const status = r.status;
  const balance = parseFloat(r.balance) || 0;
  return {
    doc_no: r.doc_no,
    doc_date: r.doc_date,
    doc_time: r.doc_time,
    cust_code: r.cust_code,
    send_type: r.send_type,
    total_amount: r.total_amount,
    emp_code: r.emp_code,
    emp_name: r.emp_name,
    balance: r.balance,
    remark_qt: r.remark_qt,
    remark_cancel: r.remark_cancel,
    remark_inv: r.remark_inv,
    remark_5: r.remark_5,
    inv_doc_no: r.inv_doc_no,
    inv_doc_date: r.inv_doc_date,
    wallet_amount: r.wallet_amount,
    total_except_vat: r.total_except_vat,
    total_after_vat: r.total_after_vat,
    total_vat_value: r.total_vat_value,
    cn_total_amount: r.cn_total_amount,
    status: (status === 'success' && balance > 0) ? 'partial' : status,
  };
}

// GET /service/v1/getOrderHistory
router.get('/getOrderHistory', async (req, res) => {
  const { cust_code = '', status = '' } = req.query;
  try {
    // Java: ถ้า status != '' และ != 'partial' → ใส่ AND status='xxx' ใน SQL
    // Java: ถ้า status='partial' → ไม่ filter ใน SQL, filter ใน app layer (status=success AND balance>0)
    let extraWhere = '';
    if (status && status !== 'partial') {
      extraWhere = ` AND status = '${status.replace(/'/g, "''")}' `;
    }

    const sql = ORDER_HISTORY_CTE + extraWhere + ' ORDER BY doc_date DESC, doc_time DESC LIMIT 40';
    const result = await query(sql, [cust_code]);

    const data = [];
    for (const r of result.rows) {
      const balance = parseFloat(r.balance) || 0;
      const rawStatus = r.status;

      if (status === 'partial') {
        // Java: เอาเฉพาะ status=success AND balance>0
        if (rawStatus === 'success' && balance > 0) {
          data.push({ ...mapOrderRow(r), status: 'partial' });
        }
      } else if (status === 'success') {
        // Java: เอาเฉพาะ status=success AND balance==0
        if (rawStatus === 'success' && balance === 0) {
          data.push({ ...mapOrderRow(r), status: 'success' });
        }
      } else {
        // Java: เอาทุก row แต่ rename success+balance>0 → partial
        data.push(mapOrderRow(r));
      }
    }

    return res.json({ success: true, data });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getOrderHeader
router.get('/getOrderHeader', async (req, res) => {
  const { cust_code, doc_no } = req.query;
  if (!cust_code || !doc_no) {
    return res.status(400).send('{ERROR: cust_code and doc_no are required}');
  }

  try {
    const sql = `
      SELECT * FROM (
        SELECT
          COALESCE(ic_inv.remark_5,'') AS remark_5,
          COALESCE(its.transport_name,'') AS address,
          COALESCE(its.transport_telephone,'') AS telephone,
          COALESCE(its.transport_address,'') AS address_name,
          ic_qt.doc_no, ic_qt.doc_date, ic_qt.doc_time, ic_qt.cust_code,
          ic_qt.send_type, ic_qt.send_date, ic_qt.send_day,
          ic_qt.sale_code AS emp_code,
          COALESCE((SELECT name_1 FROM erp_user WHERE UPPER(code)=UPPER(ic_qt.sale_code) LIMIT 1),'') AS emp_name,
          ic_qt.total_amount, ic_qt.total_except_vat, ic_qt.total_after_vat, ic_qt.total_vat_value,
          COALESCE((
            SELECT balance_amount FROM (
              SELECT cust_code, doc_date, credit_date AS due_date, doc_no, trans_flag AS doc_type, used_status, doc_ref AS ref_doc_no, doc_ref_date AS ref_doc_date,
                COALESCE(total_amount,0) AS amount,
                COALESCE(total_amount,0) - (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date) AS balance_amount,
                branch_code
              FROM ic_trans WHERE COALESCE(last_status,0)=0 AND trans_flag=44 AND (inquiry_type=0 OR inquiry_type=2) AND cust_code=ic_qt.cust_code
              UNION ALL
              SELECT cust_code, doc_date, credit_date AS due_date, doc_no, trans_flag AS doc_type, used_status, '' AS ref_doc_no, NULL AS ref_doc_date,
                COALESCE(total_amount,0) AS amount,
                COALESCE(total_amount,0) - (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date) AS balance_amount,
                branch_code
              FROM ic_trans WHERE COALESCE(last_status,0)=0 AND (trans_flag=46 OR trans_flag=93 OR trans_flag=99 OR trans_flag=95 OR trans_flag=101) AND cust_code=ic_qt.cust_code
              UNION ALL
              SELECT cust_code, doc_date, credit_date AS due_date, doc_no, trans_flag AS doc_type, used_status, '' AS ref_doc_no, NULL AS ref_doc_date,
                -1*COALESCE(total_amount,0) AS amount,
                -1*(COALESCE(total_amount,0) + (SELECT COALESCE(SUM(COALESCE(sum_pay_money,0)),0) FROM ap_ar_trans_detail WHERE COALESCE(last_status,0)=0 AND trans_flag IN (239) AND ic_trans.doc_no=ap_ar_trans_detail.billing_no AND ic_trans.doc_date=ap_ar_trans_detail.billing_date)) AS balance_amount,
                branch_code
              FROM ic_trans WHERE COALESCE(last_status,0)=0 AND ((trans_flag=48 AND inquiry_type IN (0,2,4)) OR trans_flag=97 OR trans_flag=103) AND cust_code=ic_qt.cust_code
            ) AS xx WHERE balance_amount <> 0 AND doc_no = ap_ar.billing_no ORDER BY cust_code, doc_date, doc_no LIMIT 1
          ),0) AS balance,
          CASE
            WHEN ap_ar.doc_no IS NOT NULL THEN 'success'
            WHEN ap_ar.doc_no IS NULL AND ap_inv.doc_no IS NOT NULL THEN 'payment'
            WHEN ap_ar.doc_no IS NULL AND ap_inv.doc_no IS NULL AND ap_so.doc_no IS NOT NULL THEN 'packing'
            WHEN ic_soc.doc_no IS NOT NULL THEN 'cancel'
            ELSE 'pending'
          END AS status
        FROM ic_trans ic_qt
        LEFT JOIN ic_trans ic_soc ON ic_soc.doc_ref = ic_qt.doc_no AND ic_soc.trans_flag = 31
        LEFT JOIN ap_ar_trans_detail ap_so ON ap_so.billing_no = ic_qt.doc_no AND ap_so.trans_flag = 36
        LEFT JOIN ap_ar_trans_detail ap_inv ON ap_inv.billing_no = ap_so.doc_no AND ap_inv.trans_flag = 44
        LEFT JOIN ic_trans ic_inv ON ic_inv.doc_no = ap_inv.doc_no AND ic_inv.trans_flag = 44
        LEFT JOIN ap_ar_trans_detail ap_ar ON ap_ar.billing_no = ap_inv.doc_no AND ap_ar.trans_flag = 239
        LEFT JOIN ic_trans_shipment its ON its.doc_no = ic_qt.doc_no
        WHERE ic_qt.trans_flag = 30 AND ic_qt.cust_code = $1 AND ic_qt.doc_no = $2
        ORDER BY doc_date DESC LIMIT 1
      ) AS temp WHERE 1=1
    `;

    const result = await query(sql, [cust_code, doc_no]);
    if (result.rows.length === 0) {
      return res.json({ success: true, data: null });
    }

    const r = result.rows[0];
    const balance = parseFloat(r.balance) || 0;
    const status = r.status;
    const data = {
      remark_5: r.remark_5,
      doc_no: r.doc_no,
      doc_date: r.doc_date,
      doc_time: r.doc_time,
      cust_code: r.cust_code,
      send_type: r.send_type,
      send_date: r.send_date,
      send_day: r.send_day,
      total_amount: r.total_amount,
      emp_code: r.emp_code,
      emp_name: r.emp_name,
      balance: r.balance,
      address: r.address,
      telephone: r.telephone,
      address_name: r.address_name,
      total_except_vat: r.total_except_vat,
      total_after_vat: r.total_after_vat,
      total_vat_value: r.total_vat_value,
      status: (status === 'success' && balance > 0) ? 'partial' : status,
    };

    return res.json({ success: true, data });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getOrderDetail
router.get('/getOrderDetail', async (req, res) => {
  const { cust_code, doc_no, page, page_size, q } = req.query;
  if (!cust_code || !doc_no) {
    return res.status(400).send('{ERROR: cust_code and doc_no are required}');
  }

  const p = Math.max(1, parseInt(page) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(page_size) || 20));
  const offset = (p - 1) * ps;
  const hasQ = q && q.trim() !== '';
  const qLike = hasQ ? `%${q.trim()}%` : null;

  try {
    const client = await pool.connect();
    try {
      const baseWhere = `
        FROM ic_trans_detail d
        WHERE d.doc_no = $1
          AND (d.item_type = 3 OR COALESCE(d.set_ref_line,'') = '')
          AND EXISTS (SELECT 1 FROM ic_trans t WHERE t.doc_no = d.doc_no AND t.trans_flag = 30 AND t.cust_code = $2)
      `;
      const searchClause = `
        AND (d.item_code ILIKE $3
          OR d.item_name ILIKE $3
          OR (d.item_type = 3 AND COALESCE(d.ref_guid,'') <> ''
            AND EXISTS (SELECT 1 FROM ic_trans_detail s
              WHERE s.doc_no = d.doc_no AND s.set_ref_line = d.ref_guid
                AND COALESCE(s.set_ref_line,'') <> ''
                AND (s.item_code ILIKE $3 OR s.item_name ILIKE $3))))
      `;

      // COUNT
      const countSql = `SELECT COUNT(*) AS cnt ${baseWhere} ${hasQ ? searchClause : ''}`;
      const countParams = hasQ ? [doc_no, cust_code, qLike] : [doc_no, cust_code];
      const countResult = await client.query(countSql, countParams);
      const totalItems = parseInt(countResult.rows[0].cnt);
      const totalPages = Math.ceil(totalItems / ps);

      // SELECT top-level
      const topSql = `
        SELECT d.item_code, d.item_name, d.qty, d.unit_code, d.price, d.wh_code, d.shelf_code,
          d.stand_value, d.divide_value, d.ratio, d.sum_amount,
          d.item_type, d.set_ref_line, d.ref_guid, d.line_number
        ${baseWhere} ${hasQ ? searchClause : ''}
        ORDER BY d.line_number
        LIMIT $${hasQ ? 4 : 3} OFFSET $${hasQ ? 5 : 4}
      `;
      const topParams = hasQ
        ? [doc_no, cust_code, qLike, ps, offset]
        : [doc_no, cust_code, ps, offset];

      const topResult = await client.query(topSql, topParams);

      const topItemsArr = [];
      const setMap = {};
      const parentGuids = [];

      for (const r of topResult.rows) {
        const it = {
          qty: r.qty,
          item_code: r.item_code,
          item_name: r.item_name,
          unit_code: r.unit_code,
          wh_code: r.wh_code,
          shelf_code: r.shelf_code,
          stand_value: r.stand_value,
          divide_value: r.divide_value,
          ratio: r.ratio,
          price: r.price,
          sum_amount: r.sum_amount,
          item_type: r.item_type,
          set_ref_line: r.set_ref_line,
          ref_guid: r.ref_guid,
        };

        if (parseInt(r.item_type) === 3) {
          it.sub_item = [];
          setMap[r.ref_guid] = it;
          parentGuids.push(r.ref_guid);
        }

        topItemsArr.push(it);
      }

      // Fetch sub items
      if (parentGuids.length > 0) {
        const inPlaceholders = parentGuids.map((_, i) => `$${i + 3}`).join(',');
        const subBase = `
          SELECT item_code, item_name, qty, unit_code, price, wh_code, shelf_code,
            stand_value, divide_value, ratio, sum_amount, item_type, set_ref_line, ref_guid, line_number
          FROM ic_trans_detail
          WHERE doc_no = $1 AND set_ref_line IN (${inPlaceholders})
        `;
        const subSearchOff = parentGuids.length + 3;
        const subSearch = ` AND (item_code ILIKE $${subSearchOff} OR item_name ILIKE $${subSearchOff})`;
        const subSql = subBase + (hasQ ? subSearch : '') + ' ORDER BY set_ref_line, line_number';
        const subParams = hasQ
          ? [doc_no, ...parentGuids.map(() => null).slice(0, 0), doc_no, ...parentGuids, qLike]
          : [doc_no, ...parentGuids];

        // Rebuild properly
        const subParamsFinal = [doc_no, ...parentGuids];
        if (hasQ) subParamsFinal.push(qLike);

        const subSqlFinal = `
          SELECT item_code, item_name, qty, unit_code, price, wh_code, shelf_code,
            stand_value, divide_value, ratio, sum_amount, item_type, set_ref_line, ref_guid, line_number
          FROM ic_trans_detail
          WHERE doc_no = $1 AND set_ref_line IN (${parentGuids.map((_, i) => `$${i + 2}`).join(',')})
          ${hasQ ? `AND (item_code ILIKE $${parentGuids.length + 2} OR item_name ILIKE $${parentGuids.length + 2})` : ''}
          ORDER BY set_ref_line, line_number
        `;

        const subResult = await client.query(subSqlFinal, subParamsFinal);
        for (const r of subResult.rows) {
          const parent = setMap[r.set_ref_line];
          if (!parent) continue;
          parent.sub_item.push({
            qty: r.qty,
            item_code: r.item_code,
            item_name: r.item_name,
            unit_code: r.unit_code,
            wh_code: r.wh_code,
            shelf_code: r.shelf_code,
            stand_value: r.stand_value,
            divide_value: r.divide_value,
            ratio: r.ratio,
            price: r.price,
            sum_amount: r.sum_amount,
            item_type: r.item_type,
            set_ref_line: r.set_ref_line,
            ref_guid: r.ref_guid,
          });
        }
      }

      return res.json({
        success: true,
        paging: { page: p, page_size: ps, total_items: totalItems, total_pages: totalPages },
        data: { doc_no, items: topItemsArr },
      });
    } finally {
      client.release();
    }
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

module.exports = router;

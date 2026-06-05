const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { successResponse, failResponse } = require('../utils/response');

// GET /service/v1/getBasketList
// ดึงรายการตะกร้าทั้งหมด พร้อม item_count และ total_price จาก staff_cart_order
router.get('/getBasketList', async (req, res) => {
  try {
    const sql = `
      SELECT
        b.basket_id, b.cust_code, b.cust_name, b.inquiry_type, b.vat_type, b.vat_rate,
        b.sale_code, b.sale_name, b.status, b.updated_at,
        COALESCE(NULLIF(b.doc_format_code,''), dd.code, '') AS doc_format_code,
        COALESCE(df.name_1, dd.name_1, '') AS doc_format_name,
        COALESCE(df.format, dd.format, '') AS doc_format,
        COALESCE(NULLIF(b.form_code,''), df.form_code, dd.form_code, '') AS form_code,
        COALESCE(c.item_count, 0) AS total_items,
        COALESCE(c.total_price, 0) AS total_price
      FROM pos_basket b
      LEFT JOIN (
        SELECT code, name_1, format, form_code
        FROM erp_doc_format
        WHERE screen_code = 'SI'
        ORDER BY code
        LIMIT 1
      ) dd ON TRUE
      LEFT JOIN erp_doc_format df
        ON df.screen_code = 'SI'
       AND df.code = b.doc_format_code
      LEFT JOIN (
        SELECT cust_code, COUNT(*) AS item_count, SUM(qty * price) AS total_price
        FROM staff_cart_order
        WHERE cust_code LIKE 'BASKET-%'
        GROUP BY cust_code
      ) c ON c.cust_code = 'BASKET-' || b.basket_id::text
      ORDER BY b.basket_id
    `;
    const result = await query(sql, []);
    return successResponse(res, result.rows);
  } catch (ex) {
    console.error('getBasketList error:', ex.message);
    return failResponse(res, ex.message, 500);
  }
});

// GET /service/v1/getSaleDocFormatList
// ดึงรหัสเอกสารขายจาก erp_doc_format สำหรับหน้าตั้งค่าตะกร้า
router.get('/getSaleDocFormatList', async (req, res) => {
  try {
    const result = await query(
      `SELECT code, name_1, format, COALESCE(form_code,'') AS form_code
       FROM erp_doc_format
       WHERE screen_code = 'SI'
       ORDER BY code`,
      [],
    );
    return successResponse(res, result.rows);
  } catch (ex) {
    console.error('getSaleDocFormatList error:', ex.message);
    return failResponse(res, ex.message, 500);
  }
});

// POST /service/v1/setBasketInfo
// ตั้งค่าข้อมูลตะกร้า — เปิดใช้งาน (status = 'active')
router.post('/setBasketInfo', async (req, res) => {
  const { basket_id, cust_code = '', cust_name = '', inquiry_type = 1,
    vat_type = 1, vat_rate = 7.0, sale_code = '', sale_name = '', doc_format_code = '' } = req.body;

  if (!basket_id) {
    return failResponse(res, 'basket_id is required', 400);
  }

  try {
    let docFormatRes;
    const docFormatCode = String(doc_format_code || '').trim();
    if (docFormatCode) {
      docFormatRes = await query(
        `SELECT code, COALESCE(form_code,'') AS form_code
         FROM erp_doc_format
         WHERE screen_code = 'SI' AND code = $1
         LIMIT 1`,
        [docFormatCode],
      );
    } else {
      docFormatRes = await query(
        `SELECT code, COALESCE(form_code,'') AS form_code
         FROM erp_doc_format
         WHERE screen_code = 'SI'
         ORDER BY code
         LIMIT 1`,
        [],
      );
    }

    const docFormat = docFormatRes.rows[0];
    if (!docFormat) {
      return failResponse(res, 'ไม่พบรหัสเอกสารขาย', 400);
    }

    await query(
      `UPDATE pos_basket
       SET cust_code=$2, cust_name=$3, inquiry_type=$4, vat_type=$5, vat_rate=$6,
           sale_code=$7, sale_name=$8, doc_format_code=$9, form_code=$10,
           status='active', updated_at=NOW()
       WHERE basket_id=$1`,
      [
        basket_id, cust_code, cust_name, inquiry_type, vat_type, vat_rate,
        sale_code, sale_name, docFormat.code, docFormat.form_code,
      ],
    );
    return successResponse(res, null);
  } catch (ex) {
    console.error('setBasketInfo error:', ex.message);
    return failResponse(res, ex.message, 500);
  }
});

// POST /service/v1/clearBasket
// เคลียร์ตะกร้า — ลบสินค้าทั้งหมดและรีเซ็ต pos_basket กลับ empty
router.post('/clearBasket', async (req, res) => {
  const { basket_id } = req.body;

  if (!basket_id) {
    return failResponse(res, 'basket_id is required', 400);
  }

  try {
    await withTransaction(async (client) => {
      await client.query(
        `DELETE FROM staff_cart_order WHERE cust_code = 'BASKET-' || $1::text`,
        [basket_id],
      );
      await client.query(
        `UPDATE pos_basket
         SET cust_code='', cust_name='', sale_code='', sale_name='',
             doc_format_code='', form_code='',
             status='empty', updated_at=NOW()
         WHERE basket_id=$1`,
        [basket_id],
      );
    });
    return successResponse(res, null);
  } catch (ex) {
    console.error('clearBasket error:', ex.message);
    return failResponse(res, ex.message, 500);
  }
});

// GET /service/v1/getItemReservedQty
// ดึงจำนวนหน่วยฐานที่ถูกจองจากทุกตะกร้า BASKET-% สำหรับสินค้าชิ้นนี้
router.get('/getItemReservedQty', async (req, res) => {
  const { item_code } = req.query;

  if (!item_code) {
    return failResponse(res, 'item_code is required', 400);
  }

  try {
    const result = await query(
      `WITH direct_reserved AS (
         SELECT COALESCE(SUM(qty::numeric * COALESCE(NULLIF(ratio::numeric, 0), 1)), 0) AS qty
         FROM staff_cart_order
         WHERE item_code = $1
           AND cust_code LIKE 'BASKET-%'
       ),
       set_reserved AS (
         SELECT COALESCE(SUM(
           c.qty::numeric
           * d.qty::numeric
           * COALESCE(NULLIF(u.ratio::numeric, 0), COALESCE(u.stand_value::numeric, 1) / NULLIF(COALESCE(u.divide_value::numeric, 1), 0), 1)
         ), 0) AS qty
         FROM staff_cart_order c
         JOIN ic_inventory_set_detail d ON d.ic_set_code = c.item_code
         LEFT JOIN ic_unit_use u ON u.ic_code = d.ic_code AND u.code = d.unit_code
         WHERE c.cust_code LIKE 'BASKET-%'
           AND COALESCE(c.item_type, 0) = 3
           AND d.ic_code = $1
       )
       SELECT (direct_reserved.qty + set_reserved.qty) AS reserved_base_units
       FROM direct_reserved, set_reserved`,
      [item_code],
    );
    return successResponse(res, {
      item_code,
      reserved_base_units: Number(result.rows[0].reserved_base_units),
    });
  } catch (ex) {
    console.error('getItemReservedQty error:', ex.message);
    return failResponse(res, ex.message, 500);
  }
});

module.exports = router;

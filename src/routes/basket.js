const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { successResponse, failResponse } = require('../utils/response');
const {
  assertBasketAccess,
  getEmployeeBasketAccess,
  resolveBasketAccess,
} = require('../utils/basketAccess');

function toNumber(value) {
  return Number(value || 0);
}

// Keep the reserved quantity used by the product dialog aligned with stock availability.
// Direct cart rows and product-set components must both be included.
async function getItemCartReservationSnapshot(queryFn, itemCode) {
  const result = await queryFn(
    `WITH direct_reservations AS (
       SELECT
         c.cust_code AS basket_key,
         COALESCE(b.basket_id::text, REGEXP_REPLACE(c.cust_code, '^BASKET-', '', 'i')) AS basket_id,
         COALESCE(b.cust_code, '') AS customer_code,
         COALESCE(b.cust_name, '') AS customer_name,
         COALESCE(c.creator_code, '') AS employee_code,
         'direct'::text AS source_type,
         c.item_code AS source_item_code,
         COALESCE(c.item_name, '') AS source_item_name,
         COALESCE(c.unit_code, '') AS unit_code,
         COALESCE(SUM(c.qty::numeric), 0)::numeric AS reserved_qty,
         COALESCE(SUM(
           c.qty::numeric * COALESCE(NULLIF(c.ratio::numeric, 0), 1)
         ), 0)::numeric AS reserved_base_qty
       FROM staff_cart_order c
       LEFT JOIN pos_basket b ON c.cust_code = 'BASKET-' || b.basket_id::text
       WHERE c.item_code = $1
         AND c.cust_code LIKE 'BASKET-%'
       GROUP BY
         c.cust_code, b.basket_id, b.cust_code, b.cust_name,
         c.creator_code, c.item_code, c.item_name, c.unit_code
     ),
     set_reservations AS (
       SELECT
         c.cust_code AS basket_key,
         COALESCE(b.basket_id::text, REGEXP_REPLACE(c.cust_code, '^BASKET-', '', 'i')) AS basket_id,
         COALESCE(b.cust_code, '') AS customer_code,
         COALESCE(b.cust_name, '') AS customer_name,
         COALESCE(c.creator_code, '') AS employee_code,
         'set'::text AS source_type,
         c.item_code AS source_item_code,
         COALESCE(c.item_name, '') AS source_item_name,
         COALESCE(d.unit_code, '') AS unit_code,
         COALESCE(SUM(c.qty::numeric * d.qty::numeric), 0)::numeric AS reserved_qty,
         COALESCE(SUM(
           c.qty::numeric
           * d.qty::numeric
           * COALESCE(
             NULLIF(u.ratio::numeric, 0),
             COALESCE(u.stand_value::numeric, 1)
               / NULLIF(COALESCE(u.divide_value::numeric, 1), 0),
             1
           )
         ), 0)::numeric AS reserved_base_qty
       FROM staff_cart_order c
       JOIN ic_inventory_set_detail d ON d.ic_set_code = c.item_code
       LEFT JOIN ic_unit_use u ON u.ic_code = d.ic_code AND u.code = d.unit_code
       LEFT JOIN pos_basket b ON c.cust_code = 'BASKET-' || b.basket_id::text
       WHERE c.cust_code LIKE 'BASKET-%'
         AND COALESCE(NULLIF(c.item_type::text, ''), '0') = '3'
         AND d.ic_code = $1
       GROUP BY
         c.cust_code, b.basket_id, b.cust_code, b.cust_name,
         c.creator_code, c.item_code, c.item_name, d.unit_code
     ),
     reservation_lines AS (
       SELECT * FROM direct_reservations
       UNION ALL
       SELECT * FROM set_reservations
     ),
     summary AS (
       SELECT
         COALESCE(SUM(reserved_base_qty), 0)::numeric AS reserved_base_units,
         COUNT(DISTINCT basket_key)::int AS basket_count
       FROM reservation_lines
     )
     SELECT
       r.*,
       s.reserved_base_units AS total_reserved_base_units,
       s.basket_count
     FROM reservation_lines r
     CROSS JOIN summary s
     ORDER BY r.basket_id, r.source_type, r.source_item_code, r.unit_code, r.employee_code`,
    [itemCode],
  );

  const rows = result.rows.map(row => ({
    basket_key: row.basket_key,
    basket_id: row.basket_id,
    customer_code: row.customer_code || '',
    customer_name: row.customer_name || '',
    employee_code: row.employee_code || '',
    source_type: row.source_type,
    source_item_code: row.source_item_code || '',
    source_item_name: row.source_item_name || '',
    unit_code: row.unit_code || '',
    reserved_qty: toNumber(row.reserved_qty),
    reserved_base_qty: toNumber(row.reserved_base_qty),
  }));

  return {
    rows,
    summary: {
      reserved_base_units: rows.length > 0 ? toNumber(result.rows[0].total_reserved_base_units) : 0,
      basket_count: rows.length > 0 ? toNumber(result.rows[0].basket_count) : 0,
    },
  };
}

// GET /service/v1/getBasketList
// ดึงรายการตะกร้าทั้งหมด พร้อม item_count และ total_price จาก staff_cart_order
router.get('/getBasketList', async (req, res) => {
  try {
    const userCode = String(req.query.user_code || req.query.emp_code || req.get('x-user-code') || '').trim();
    const employeeAccess = await getEmployeeBasketAccess(query, userCode);
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
    const rows = await Promise.all(result.rows.map(async (row) => {
      const access = await resolveBasketAccess(query, userCode, row.basket_id);
      return {
        ...row,
        allow_all_baskets: employeeAccess.allow_all_baskets,
        is_allowed_basket: access.is_allowed_basket,
        is_other_staff_basket: access.is_other_staff_basket,
        access_level: access.access_level,
        can_enter: access.can_enter,
        can_edit_basket: access.can_edit_basket,
        can_edit_items: access.can_edit_items,
        can_save_sale: access.can_save_sale,
      };
    }));
    return successResponse(res, rows);
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
  const userCode = String(req.body.user_code || req.body.emp_code || req.get('x-user-code') || '').trim();

  if (!basket_id) {
    return failResponse(res, 'basket_id is required', 400);
  }

  try {
    await assertBasketAccess(query, userCode, basket_id, 'can_edit_basket');
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
    return failResponse(res, ex.message, ex.statusCode || 500);
  }
});

// POST /service/v1/clearBasket
// เคลียร์ตะกร้า — ลบสินค้าทั้งหมดและรีเซ็ต pos_basket กลับ empty
router.post('/clearBasket', async (req, res) => {
  const { basket_id } = req.body;
  const userCode = String(req.body.user_code || req.body.emp_code || req.get('x-user-code') || '').trim();

  if (!basket_id) {
    return failResponse(res, 'basket_id is required', 400);
  }

  try {
    await withTransaction(async (client) => {
      await assertBasketAccess(client.query.bind(client), userCode, basket_id, 'can_edit_basket');
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
    return failResponse(res, ex.message, ex.statusCode || 500);
  }
});

// GET /service/v1/getItemCartReservations
// ดึงตะกร้าทั้งหมดที่กำลังจองสินค้านี้ รวมสินค้าที่ถูกจองผ่านสินค้าชุด
router.get('/getItemCartReservations', async (req, res) => {
  const { item_code } = req.query;

  if (!item_code) {
    return failResponse(res, 'item_code is required', 400);
  }

  try {
    const snapshot = await getItemCartReservationSnapshot(query, item_code);
    return successResponse(res, { item_code, ...snapshot });
  } catch (ex) {
    console.error('getItemCartReservations error:', ex.message);
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
    const snapshot = await getItemCartReservationSnapshot(query, item_code);
    return successResponse(res, {
      item_code,
      reserved_base_units: snapshot.summary.reserved_base_units,
    });
  } catch (ex) {
    console.error('getItemReservedQty error:', ex.message);
    return failResponse(res, ex.message, 500);
  }
});

module.exports = router;

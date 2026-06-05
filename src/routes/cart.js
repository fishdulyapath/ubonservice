const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { safePage, safePageSize } = require('../utils/response');
const { validateCartStock } = require('../utils/cartStockValidator');

async function resolveBasketPricingContext(custCode) {
  if (!custCode || !String(custCode).trim()) {
    return { saleType: null, vatType: null, vatRate: null };
  }
  try {
    const rs = await query(
      `SELECT COALESCE(inquiry_type,0) AS sale_type,
              COALESCE(vat_type,0) AS vat_type,
              COALESCE(vat_rate,0) AS vat_rate
       FROM pos_basket
       WHERE cust_code=$1
       ORDER BY basket_id DESC
       LIMIT 1`,
      [custCode]
    );
    if (rs.rows.length > 0) {
      return {
        saleType: parseInt(rs.rows[0].sale_type, 10),
        vatType: parseInt(rs.rows[0].vat_type, 10),
        vatRate: parseFloat(rs.rows[0].vat_rate),
      };
    }
  } catch (_) {}
  return { saleType: null, vatType: null, vatRate: null };
}

// POST /service/v1/additemtocart
// Body: JSON Array [...] — เลียนแบบ Java: รับ String data แล้ว new JSONArray(data)
router.post('/additemtocart', async (req, res) => {
  const resp = { success: false };
  try {
    let bodyStr = req.body;
    if (typeof bodyStr === 'object') bodyStr = JSON.stringify(bodyStr);

    const items = JSON.parse(bodyStr);
    if (!Array.isArray(items)) {
      return res.status(400).json({ ERROR: 'Data must be a JSON array' });
    }

    // เลียนแบบ Java: loop ทุก item → DELETE เดิม → INSERT ใหม่
    const client = await require('../db').pool.connect();
    try {
      for (const item of items) {
        const cust_code = item.cust_code || '';
        const emp_code = item.emp_code || '';
        const guid_code = item.guid_code || '';
        const item_code = item.item_code || '';
        const item_name = item.item_name || '';
        const unit_code = item.unit_code || '';
        const barcode = item.barcode || '';
        const qty = item.qty !== undefined ? item.qty.toString() : '1';
        const price = item.price !== undefined ? item.price.toString() : '0';
        const item_type = item.item_type !== undefined ? item.item_type.toString() : '0';
        const wh_code = item.wh_code || '';
        const shelf_code = item.shelf_code || '';
        const stand_value = item.stand_value !== undefined ? item.stand_value.toString() : '1';
        const divide_value = item.divide_value !== undefined ? item.divide_value.toString() : '1';
        const ratio = item.ratio !== undefined ? item.ratio.toString() : '1';
        const remark = item.remark || '';

        // DELETE เดิมก่อน (เหมือน Java)
        await client.query(
          `DELETE FROM staff_cart_order
           WHERE item_code = $1 AND unit_code = $2 AND barcode = $3 AND cust_code = $4`,
          [item_code, unit_code, barcode, cust_code]
        );

        // INSERT ใหม่
        await client.query(
          `INSERT INTO staff_cart_order
           (item_type, cust_code, guid_code, item_code, item_name, unit_code, barcode,
            qty, price, wh_code, shelf_code, creator_code, create_datetime,
            stand_value, divide_value, ratio, remark)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),$13,$14,$15,$16)`,
          [item_type, cust_code, guid_code, item_code, item_name, unit_code, barcode,
           qty, price, wh_code, shelf_code, emp_code,
           stand_value, divide_value, ratio, remark]
        );
      }
      resp.success = true;
      resp.msg = 'success';
      return res.json(resp);
    } finally {
      client.release();
    }
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getcartitemlist
router.get('/getcartitemlist', async (req, res) => {
  const custCode = req.query.cust_code;
  const page = safePage(req.query.page);
  const pageSize = safePageSize(req.query.page_size);
  const search = req.query.search;

  const resp = { success: false };

  if (!custCode || !custCode.trim()) {
    return res.status(400).json({ error: 'cust_code is required' });
  }

  const offset = (page - 1) * pageSize;
  let searchCondition = '';
  const params = [custCode];

  if (search && search.trim()) {
    searchCondition = ' AND (item_code ILIKE $2 OR item_name ILIKE $2)';
    params.push(`%${search.trim()}%`);
  }

  try {
    // COUNT
    const countSql = `SELECT COUNT(*) AS total_count FROM staff_cart_order WHERE cust_code = $1${searchCondition}`;
    const countResult = await query(countSql, params);
    const totalCount = parseInt(countResult.rows[0].total_count);

    // DATA — เลียนแบบ Java: fields ครบ + balance_qty=0 + tax_type จาก ic_inventory
    const dataSql = `
      SELECT sco.cust_code, sco.guid_code, sco.item_code, sco.item_name, sco.unit_code,
             sco.item_type, sco.barcode, sco.qty, sco.price, sco.wh_code, sco.shelf_code,
             sco.creator_code, sco.create_datetime, sco.stand_value, sco.divide_value,
             sco.ratio, sco.remark, 0 AS balance_qty,
             COALESCE(i.tax_type, 0) AS tax_type
      FROM staff_cart_order sco
      LEFT JOIN ic_inventory i ON i.code = sco.item_code
      WHERE sco.cust_code = $1${searchCondition}
      ORDER BY sco.item_code ASC, sco.unit_code ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    const dataParams = [...params, pageSize, offset];
    const dataResult = await query(dataSql, dataParams);

    const data = dataResult.rows.map(r => ({
      cust_code: r.cust_code,
      guid_code: r.guid_code,
      item_code: r.item_code,
      item_name: r.item_name,
      unit_code: r.unit_code,
      item_type: r.item_type,
      barcode: r.barcode,
      qty: r.qty,
      price: r.price,
      wh_code: r.wh_code,
      shelf_code: r.shelf_code,
      creator_code: r.creator_code,
      create_datetime: r.create_datetime,
      stand_value: r.stand_value,
      divide_value: r.divide_value,
      ratio: r.ratio,
      remark: r.remark,
      balance_qty: 0,
      tax_type: Number(r.tax_type ?? 0),
    }));

    resp.success = true;
    resp.page = page;
    resp.page_size = pageSize;
    resp.total_count = totalCount;
    resp.data = data;
    return res.json(resp);
  } catch (ex) {
    return res.status(500).json({ error: ex.message });
  }
});

// GET /service/v1/getCartSummary
router.get('/getCartSummary', async (req, res) => {
  const custCode = req.query.cust_code;
  const resp = { success: false };

  if (!custCode || !custCode.trim()) {
    return res.status(400).json({ error: 'cust_code is required' });
  }

  try {
    const sql = `
      SELECT
        COALESCE(SUM(qty * price), 0) AS total_price,
        COALESCE(SUM(qty), 0)         AS total_qty,
        COUNT(*)                      AS total_items
      FROM staff_cart_order
      WHERE cust_code = $1
    `;
    const result = await query(sql, [custCode]);
    const row = result.rows[0];

    resp.success = true;
    resp.total_price = row ? row.total_price : 0;
    resp.total_qty = row ? row.total_qty : 0;
    resp.total_items = row ? parseInt(row.total_items) : 0;
    return res.json(resp);
  } catch (ex) {
    return res.status(500).json({ error: ex.message });
  }
});

// POST /service/v1/getcartitemstock
// Body: { items: [{ item_code, unit_code }] }
router.post('/getcartitemstock', async (req, res) => {
  const resp = { success: false };
  try {
    let bodyStr = req.body;
    if (typeof bodyStr !== 'object') bodyStr = JSON.parse(bodyStr);
    const { items } = bodyStr;

    if (!items || items.length === 0) {
      resp.success = true;
      resp.data = [];
      return res.json(resp);
    }

    // เลียนแบบ Java: ส่ง items เป็น jsonb string เดียว
    const sql = `
      WITH input_items AS (
        SELECT
          i->>'item_code' AS item_code,
          i->>'unit_code' AS unit_code
        FROM jsonb_array_elements($1::jsonb) AS i
      ), stock AS (
        SELECT ic_code, SUM(balance_qty) sum_qty
        FROM sml_ic_function_stock_balance_warehouse_location(
          'NOW()',
          (SELECT string_agg(DISTINCT item_code, ',') FROM input_items),
          '', ''
        )
        WHERE balance_qty > 0
        GROUP BY ic_code
      )
      SELECT
        i.item_code,
        i.unit_code,
        TRUNC(COALESCE(s.sum_qty,0) / NULLIF(u.ratio,0)) AS balance_qty
      FROM input_items i
      LEFT JOIN stock s ON s.ic_code = i.item_code
      LEFT JOIN ic_unit_use u ON u.ic_code = i.item_code AND u.code = i.unit_code
    `;

    const result = await query(sql, [JSON.stringify(items)]);
    const data = result.rows.map(r => ({
      item_code: r.item_code,
      unit_code: r.unit_code,
      balance_qty: r.balance_qty !== null ? parseInt(r.balance_qty) : 0,
    }));

    resp.success = true;
    resp.data = data;
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json(ex.message);
  }
});

// GET /service/v1/getcartorder
// เลียนแบบ Java: SELECT staff_cart_order LEFT JOIN ic_inventory ดึง tax_type
// price_confirm: item_type!='3' → '0', item_type='3' → price
router.get('/getcartorder', async (req, res) => {
  const custCode = req.query.cust_code;
  const page = safePage(req.query.page);
  const pageSize = safePageSize(req.query.page_size);

  const resp = { success: false };

  if (!custCode || !custCode.trim()) {
    return res.status(400).json({ error: 'cust_code is required' });
  }

  const offset = (page - 1) * pageSize;

  try {
    // COUNT
    const countResult = await query(
      'SELECT COUNT(*) AS total_count FROM staff_cart_order WHERE cust_code = $1',
      [custCode]
    );
    const totalCount = parseInt(countResult.rows[0].total_count);

    // DATA
    const sql = `
      SELECT
        w.*,
        COALESCE(i.tax_type, 0) AS tax_type
      FROM staff_cart_order w
      LEFT JOIN ic_inventory i ON i.code = w.item_code
      WHERE w.cust_code = $1
      ORDER BY w.item_code
      LIMIT $2 OFFSET $3
    `;
    const result = await query(sql, [custCode, pageSize, offset]);

    const data = result.rows.map(r => {
      // price_confirm: ถ้า item_type != '3' → '0', ถ้า '3' → price (เหมือน Java)
      const priceConfirm = String(r.item_type) !== '3' ? '0' : r.price;
      return {
        tax_type: r.tax_type,
        cust_code: r.cust_code,
        guid_code: r.guid_code,
        item_code: r.item_code,
        item_name: r.item_name,
        unit_code: r.unit_code,
        item_type: r.item_type,
        barcode: r.barcode,
        qty: r.qty,
        price: r.price,
        wh_code: r.wh_code,
        shelf_code: r.shelf_code,
        creator_code: r.creator_code,
        create_datetime: r.create_datetime,
        stand_value: r.stand_value,
        divide_value: r.divide_value,
        ratio: r.ratio,
        price_confirm: priceConfirm,
      };
    });

    resp.success = true;
    resp.page = page;
    resp.page_size = pageSize;
    resp.total_count = totalCount;
    resp.data = data;
    return res.json(resp);
  } catch (ex) {
    return res.status(500).json({ error: ex.message });
  }
});

// POST /service/v1/getcartorderprice
// Body: { cust_code, items: [{ item_code, unit_code, qty, item_type, price }] }
router.post('/getcartorderprice', async (req, res) => {
  const resp = { success: false };
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);

    const { cust_code, items } = body;
    const { getProductPriceLocalx } = require('../utils/priceHelper');
    const basketCtx = await resolveBasketPricingContext(cust_code);

    const bodySaleType = parseInt(body.sale_type, 10);
    const bodyVatType = parseInt(body.vat_type, 10);
    const bodyVatRate = parseFloat(body.vat_rate);
    const docDate = body.doc_date ? String(body.doc_date).trim() : undefined;

    const result = [];
    for (const it of items) {
      const itemCode = it.item_code;
      const unitCode = it.unit_code;
      const qty = it.qty !== undefined ? it.qty.toString() : '1';
      const itemType = it.item_type !== undefined ? it.item_type.toString() : '0';
      const barcode = it.barcode !== undefined ? String(it.barcode) : '';

      const o = { item_code: itemCode, unit_code: unitCode };
      try {
        let priceConfirm = 0;
        if (itemType !== '3') {
          let vatType = parseInt(it.vat_type, 10);
          if (Number.isNaN(vatType)) vatType = Number.isNaN(bodyVatType) ? basketCtx.vatType : bodyVatType;
          if (Number.isNaN(vatType)) vatType = parseInt(it.tax_type, 10);
          if (Number.isNaN(vatType)) vatType = 0;

          let saleType = parseInt(it.sale_type, 10);
          if (Number.isNaN(saleType)) saleType = Number.isNaN(bodySaleType) ? basketCtx.saleType : bodySaleType;
          if (Number.isNaN(saleType)) saleType = 0;

          let vatRate = parseFloat(it.vat_rate);
          if (Number.isNaN(vatRate)) vatRate = Number.isNaN(bodyVatRate) ? basketCtx.vatRate : bodyVatRate;
          if (Number.isNaN(vatRate)) vatRate = null;

          const priceRes = await getProductPriceLocalx(itemCode, unitCode, qty, cust_code, vatType, vatRate, saleType, barcode, docDate);
          const arr = priceRes.data || [];
          if (arr.length > 0) {
            priceConfirm = safeBigDecimal(arr[0].price);
          }
        } else {
          priceConfirm = safeBigDecimal(it.price !== undefined ? it.price.toString() : '0');
        }
        o.price_confirm = priceConfirm;
        o.success = true;
      } catch (ex) {
        o.success = false;
        o.error_type = ex.constructor.name;
        o.message = ex.message;
        o.detail = ex.toString();
        o.qty = qty;
        o.item_type = itemType;
      }
      result.push(o);
    }

    resp.success = true;
    resp.data = result;
    return res.json(resp);
  } catch (e) {
    return res.status(400).json({
      success: false,
      error_type: e.constructor.name,
      message: e.message,
      detail: e.toString(),
    });
  }
});

// GET /service/v1/getcartfinalsummary
// เลียนแบบ Java: loop ทุก item คำนวณ price_confirm แล้ว sum
router.get('/getcartfinalsummary', async (req, res) => {
  const custCode = req.query.cust_code;
  const saleTypeReq = parseInt(req.query.sale_type, 10);
  const vatTypeReq = parseInt(req.query.vat_type, 10);
  const vatRateReq = parseFloat(req.query.vat_rate);
  const resp = { success: false };

  try {
    const sql = `
            SELECT c.cust_code, c.item_code, c.item_name, c.unit_code, c.item_type, c.qty, c.price, c.barcode,
             COALESCE(i.tax_type,0) AS tax_type
      FROM staff_cart_order c
      LEFT JOIN ic_inventory i ON i.code = c.item_code
      WHERE c.cust_code = $1
    `;
    const result = await query(sql, [custCode]);
    const { getProductPriceLocalx } = require('../utils/priceHelper');
    const basketCtx = await resolveBasketPricingContext(custCode);
    const docDate = req.query.doc_date ? String(req.query.doc_date).trim() : undefined;

    let totalItems = 0;
    let totalQty = 0;
    let totalPrice = 0;

    for (const r of result.rows) {
      totalItems++;
      const qty = parseFloat(r.qty) || 0;
      totalQty += qty;

      let priceConfirm = 0;
      if (String(r.item_type) !== '3') {
        try {
          const saleType = Number.isNaN(saleTypeReq) ? (Number.isNaN(basketCtx.saleType) ? 0 : basketCtx.saleType) : saleTypeReq;
          const vatType = Number.isNaN(vatTypeReq)
            ? (Number.isNaN(basketCtx.vatType) ? (parseInt(r.tax_type, 10) || 0) : basketCtx.vatType)
            : vatTypeReq;
          const vatRate = Number.isNaN(vatRateReq)
            ? (Number.isNaN(basketCtx.vatRate) ? null : basketCtx.vatRate)
            : vatRateReq;

          const priceRes = await getProductPriceLocalx(r.item_code, r.unit_code, r.qty.toString(), custCode, vatType, vatRate, saleType, r.barcode, docDate);
          const arr = priceRes.data || [];
          if (arr.length > 0) {
            priceConfirm = safeBigDecimal(arr[0].price);
          }
        } catch (_) {}
      } else {
        priceConfirm = parseFloat(r.price) || 0;
      }

      totalPrice += priceConfirm * qty;
    }

    resp.success = true;
    resp.data = {
      total_items: totalItems,
      total_qty: totalQty,
      total_price: totalPrice,
    };
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ error: ex.message });
  }
});

// GET /service/v1/validatecartstock
// เลียนแบบ Java: CTE query ตรวจ stock ของทุก item ใน cart
router.get('/validatecartstock', async (req, res) => {
  const custCode = req.query.cust_code;

  if (!custCode || !custCode.trim()) {
    return res.status(400).json({ error: 'cust_code is required' });
  }

  try {
    return res.json(await validateCartStock(query, custCode.trim()));
  } catch (ex) {
    return res.status(500).json({ error: ex.message });
  }
});

// GET /service/v1/deleteItem
// เลียนแบบ Java: DELETE WHERE guid_code=? AND cust_code=?
router.get('/deleteItem', async (req, res) => {
  const { guid_code, cust_code } = req.query;
  const resp = { success: false };
  try {
    await query(
      `DELETE FROM staff_cart_order WHERE guid_code = $1 AND cust_code = $2`,
      [guid_code || '', cust_code || '']
    );
    resp.success = true;
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/deleteAllItems
// เลียนแบบ Java: DELETE WHERE cust_code=?
router.get('/deleteAllItems', async (req, res) => {
  const { cust_code } = req.query;
  const resp = { success: false };
  try {
    await query(
      `DELETE FROM staff_cart_order WHERE cust_code = $1`,
      [cust_code || '']
    );
    resp.success = true;
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// helper
function safeBigDecimal(s) {
  if (s === null || s === undefined) return 0;
  const str = String(s).trim().replace(',', '');
  if (!str || str.toLowerCase() === 'null') return 0;
  const n = parseFloat(str);
  return isNaN(n) ? 0 : n;
}

module.exports = router;

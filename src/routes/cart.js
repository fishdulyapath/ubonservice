const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { safePage, safePageSize } = require('../utils/response');
const { validateCartStock, validateSaleItemsStock } = require('../utils/cartStockValidator');
const { assertBasketAccessFromCartKey } = require('../utils/basketAccess');
const { buildSalePremiumFulfillment } = require('../utils/salePremiumBacklogHelper');

async function ensureSalePremiumCartColumns(queryFn = query) {
  await queryFn(`ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sale_premium_code VARCHAR(25) DEFAULT ''`);
  await queryFn(`ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sale_premium_name VARCHAR(255) DEFAULT ''`);
  await queryFn(`ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sale_premium_data TEXT DEFAULT ''`);
  await queryFn(`ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sale_premium_line_type VARCHAR(10) DEFAULT ''`);
  await queryFn(`ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sale_premium_backlog_id INTEGER DEFAULT 0`);
  await queryFn(`ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sale_premium_backlog_detail_id INTEGER DEFAULT 0`);
  await queryFn(`ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS is_permium SMALLINT DEFAULT 0`);
}
function parseJsonText(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}
function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function safeText(value) {
  return String(value ?? '').trim();
}
async function validateSalePremiumBacklogCartRows(queryFn, rows = []) {
  const cartRows = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      ...row,
      sale_premium_backlog_detail_id: parseInt(row?.sale_premium_backlog_detail_id || 0, 10) || 0,
      qty: toNumber(row?.qty),
      item_code: safeText(row?.item_code),
      item_name: safeText(row?.item_name),
      unit_code: safeText(row?.unit_code),
    }))
    .filter((row) => row.sale_premium_backlog_detail_id > 0 && row.qty > 0);

  if (cartRows.length === 0) return [];

  const ids = [...new Set(cartRows.map((row) => row.sale_premium_backlog_detail_id))];
  const rs = await queryFn(
    `SELECT d.roworder AS detail_id, d.backlog_id, d.item_code, d.item_name, d.unit_code,
            COALESCE(d.pending_qty,0)::numeric AS pending_qty,
            COALESCE(d.status,'') AS detail_status,
            COALESCE(h.status,'') AS backlog_status
       FROM sml_sale_premium_backlog_detail d
       JOIN sml_sale_premium_backlog h ON h.roworder=d.backlog_id
      WHERE d.roworder = ANY($1::int[])`,
    [ids],
  );
  const detailMap = new Map(rs.rows.map((row) => [Number(row.detail_id), row]));
  const issues = [];
  const issueDetailIds = new Set();
  const groups = new Map();

  for (const row of cartRows) {
    const current = groups.get(row.sale_premium_backlog_detail_id) || { qty: 0, row };
    current.qty += row.qty;
    groups.set(row.sale_premium_backlog_detail_id, current);
  }

  for (const row of cartRows) {
    const detail = detailMap.get(row.sale_premium_backlog_detail_id);
    const itemName = row.item_name || row.item_code;
    if (!detail) {
      issues.push({
        item_code: row.item_code,
        item_name: itemName,
        unit_code: row.unit_code,
        qty_in_cart: row.qty,
        balance_qty: 0,
        stock_qty: 0,
        reserved_other_qty: 0,
        issue_type: 'premium_backlog_missing',
      });
      issueDetailIds.add(row.sale_premium_backlog_detail_id);
      continue;
    }

    const pendingQty = toNumber(detail.pending_qty);
    const itemMismatch = safeText(detail.item_code) !== row.item_code
      || (safeText(detail.unit_code) && row.unit_code && safeText(detail.unit_code) !== row.unit_code);
    const closed = pendingQty <= 0
      || ['closed', 'cancelled'].includes(safeText(detail.detail_status).toLowerCase())
      || safeText(detail.backlog_status).toLowerCase() === 'closed'
      || safeText(detail.backlog_status).toLowerCase() === 'cancelled';

    let issueType = '';
    if (itemMismatch) issueType = 'premium_backlog_mismatch';
    else if (closed) issueType = 'premium_backlog_closed';

    if (issueType) {
      issues.push({
        item_code: row.item_code,
        item_name: itemName || safeText(detail.item_name) || safeText(detail.item_code),
        unit_code: row.unit_code || safeText(detail.unit_code),
        qty_in_cart: row.qty,
        balance_qty: Math.max(0, pendingQty),
        stock_qty: Math.max(0, pendingQty),
        reserved_other_qty: 0,
        issue_type: issueType,
      });
      issueDetailIds.add(row.sale_premium_backlog_detail_id);
    }
  }

  for (const [detailId, group] of groups.entries()) {
    if (issueDetailIds.has(detailId)) continue;
    const detail = detailMap.get(detailId);
    if (!detail) continue;
    const pendingQty = toNumber(detail.pending_qty);
    if (group.qty > pendingQty + 0.0001) {
      const row = group.row;
      issues.push({
        item_code: row.item_code,
        item_name: row.item_name || safeText(detail.item_name) || row.item_code,
        unit_code: row.unit_code || safeText(detail.unit_code),
        qty_in_cart: group.qty,
        balance_qty: Math.max(0, pendingQty),
        stock_qty: Math.max(0, pendingQty),
        reserved_other_qty: 0,
        issue_type: 'premium_backlog_exceeding',
      });
    }
  }

  return issues;
}

function salePremiumBacklogErrorMessage(issue) {
  if (!issue) return 'ตรวจสอบสินค้าคงค้างไม่สำเร็จ';
  if (issue.issue_type === 'premium_backlog_missing') return 'ไม่พบรายการสินค้าคงค้างนี้';
  if (issue.issue_type === 'premium_backlog_mismatch') return 'ข้อมูลสินค้าคงค้างไม่ตรงกับสินค้าในตะกร้า';
  if (issue.issue_type === 'premium_backlog_closed') return 'รายการสินค้าคงค้างนี้ปิดแล้ว';
  if (issue.issue_type === 'premium_backlog_exceeding') {
    return `จำนวนสินค้าคงค้างเกินจำนวนที่ค้างอยู่: ${issue.item_name || issue.item_code}`;
  }
  if (issue.issue_type === 'premium_backlog_stock_exceeding' || issue.issue_type === 'premium_backlog_out_of_stock') {
    return `สต๊อกสินค้าคงค้างไม่พอ: ${issue.item_name || issue.item_code}`;
  }
  return 'ตรวจสอบสินค้าคงค้างไม่สำเร็จ';
}

async function validateSalePremiumBacklogCartStock(queryFn, item) {
  const itemCode = safeText(item?.item_code);
  const itemName = safeText(item?.item_name) || itemCode;
  const unitCode = safeText(item?.unit_code);
  const qty = toNumber(item?.qty);
  const ratio = Math.max(1, toNumber(item?.ratio, 1));
  const cartKey = safeText(item?.cust_code);
  const guidCode = safeText(item?.guid_code);
  if (!itemCode || qty <= 0) return null;

  const rs = await queryFn(
    `WITH stock AS (
       SELECT COALESCE(SUM(f.balance_qty),0)::numeric AS stock_qty
         FROM sml_ic_function_stock_balance_warehouse_location(current_date, $1::text, '', '') f
     ), reserved AS (
       SELECT COALESCE(SUM(
                COALESCE(c.qty,0)::numeric
                * COALESCE(
                    NULLIF(c.ratio::numeric,0),
                    NULLIF(u.ratio::numeric,0),
                    COALESCE(u.stand_value::numeric,1) / NULLIF(COALESCE(u.divide_value::numeric,1),0),
                    1
                  )
              ),0)::numeric AS reserved_qty
         FROM staff_cart_order c
         LEFT JOIN ic_inventory i ON i.code=c.item_code
         LEFT JOIN ic_unit_use u ON u.ic_code=c.item_code AND u.code=c.unit_code
        WHERE c.cust_code LIKE 'BASKET-%'
          AND c.item_code=$1
          AND NOT (c.cust_code=$2 AND c.guid_code=$3)
          AND COALESCE(NULLIF(c.item_type::text,'')::int, i.item_type, 0) NOT IN (1,3)
     )
     SELECT stock.stock_qty,
            reserved.reserved_qty,
            GREATEST(stock.stock_qty - reserved.reserved_qty, 0)::numeric AS available_qty
       FROM stock, reserved`,
    [itemCode, cartKey, guidCode],
  );
  const row = rs.rows[0] || {};
  const requestedBaseQty = qty * ratio;
  const stockQty = toNumber(row.stock_qty);
  const reservedQty = toNumber(row.reserved_qty);
  const availableQty = toNumber(row.available_qty);
  if (stockQty <= 0) {
    return {
      item_code: itemCode,
      item_name: itemName,
      unit_code: unitCode,
      qty_in_cart: qty,
      balance_qty: 0,
      stock_qty: 0,
      reserved_other_qty: reservedQty,
      issue_type: 'premium_backlog_out_of_stock',
    };
  }
  if (requestedBaseQty > availableQty + 0.0001) {
    return {
      item_code: itemCode,
      item_name: itemName,
      unit_code: unitCode,
      qty_in_cart: qty,
      balance_qty: Math.max(0, availableQty / ratio),
      stock_qty: Math.max(0, stockQty / ratio),
      reserved_other_qty: Math.max(0, reservedQty / ratio),
      issue_type: 'premium_backlog_stock_exceeding',
    };
  }
  return null;
}

async function assertSalePremiumBacklogCartItem(queryFn, item) {
  const detailId = parseInt(item?.sale_premium_backlog_detail_id || 0, 10) || 0;
  if (detailId <= 0 || toNumber(item?.qty) <= 0) return;
  const existingRes = await queryFn(
    `SELECT sale_premium_backlog_detail_id, item_code, item_name, unit_code, qty, ratio
       FROM staff_cart_order
      WHERE cust_code=$1
        AND COALESCE(sale_premium_backlog_detail_id,0)=$2
        AND guid_code <> $3`,
    [safeText(item?.cust_code), detailId, safeText(item?.guid_code)],
  );
  const issues = await validateSalePremiumBacklogCartRows(queryFn, [
    ...existingRes.rows,
    item,
  ]);
  if (issues.length > 0) {
    const error = new Error(salePremiumBacklogErrorMessage(issues[0]));
    error.statusCode = 400;
    error.issue_type = issues[0].issue_type;
    throw error;
  }
  const stockIssue = await validateSalePremiumBacklogCartStock(queryFn, item);
  if (stockIssue) {
    const error = new Error(salePremiumBacklogErrorMessage(stockIssue));
    error.statusCode = 400;
    error.issue_type = stockIssue.issue_type;
    throw error;
  }
}
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
      await ensureSalePremiumCartColumns(client.query.bind(client));
      const checkedCarts = new Set();
      for (const item of items) {
        const custCodeForCheck = item?.cust_code || '';
        const userCodeForCheck = item?.user_code || item?.emp_code || req.get('x-user-code') || '';
        if (/^BASKET-\d+$/i.test(String(custCodeForCheck)) && !checkedCarts.has(custCodeForCheck)) {
          await assertBasketAccessFromCartKey(client.query.bind(client), userCodeForCheck, custCodeForCheck, 'can_edit_items');
          checkedCarts.add(custCodeForCheck);
        }
      }

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
        const sale_premium_code = item.sale_premium_code || '';
        const sale_premium_name = item.sale_premium_name || '';
        const sale_premium_data = typeof item.sale_premium_data === 'string' ? item.sale_premium_data : JSON.stringify(item.sale_premium_data || null);
        const sale_premium_line_type = item.sale_premium_line_type || '';
        const sale_premium_backlog_id = item.sale_premium_backlog_id !== undefined ? parseInt(item.sale_premium_backlog_id, 10) || 0 : 0;
        const sale_premium_backlog_detail_id = item.sale_premium_backlog_detail_id !== undefined ? parseInt(item.sale_premium_backlog_detail_id, 10) || 0 : 0;
        const is_permium = item.is_permium !== undefined ? parseInt(item.is_permium, 10) || 0 : 0;

        await assertSalePremiumBacklogCartItem(client.query.bind(client), {
          ...item,
          item_code,
          item_name,
          unit_code,
          qty,
          ratio,
          cust_code,
          guid_code,
          sale_premium_backlog_detail_id,
        });

        // DELETE เดิมก่อน (เหมือน Java) แต่รายการคงค้างต้องแยกตาม guid ไม่ merge ข้าม backlog
        const deleteSql = sale_premium_backlog_detail_id > 0
          ? `DELETE FROM staff_cart_order WHERE guid_code = $1 AND cust_code = $2`
          : `DELETE FROM staff_cart_order
             WHERE item_code = $1 AND unit_code = $2 AND barcode = $3 AND cust_code = $4`;
        const deleteParams = sale_premium_backlog_detail_id > 0
          ? [guid_code, cust_code]
          : [item_code, unit_code, barcode, cust_code];
        await client.query(deleteSql, deleteParams);

        // INSERT ใหม่
        await client.query(
          `INSERT INTO staff_cart_order
           (item_type, cust_code, guid_code, item_code, item_name, unit_code, barcode,
            qty, price, wh_code, shelf_code, creator_code, create_datetime,
            stand_value, divide_value, ratio, remark, sale_premium_code, sale_premium_name, sale_premium_data,
            sale_premium_line_type, sale_premium_backlog_id, sale_premium_backlog_detail_id, is_permium)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
          [item_type, cust_code, guid_code, item_code, item_name, unit_code, barcode,
           qty, price, wh_code, shelf_code, emp_code,
           stand_value, divide_value, ratio, remark, sale_premium_code, sale_premium_name, sale_premium_data,
           sale_premium_line_type, sale_premium_backlog_id, sale_premium_backlog_detail_id, is_permium]
        );
      }
      resp.success = true;
      resp.msg = 'success';
      return res.json(resp);
    } finally {
      client.release();
    }
  } catch (ex) {
    return res.status(ex.statusCode || 400).json({ success: false, ERROR: ex.message, msg: ex.message });
  }
});

// GET /service/v1/getcartitemlist
router.get('/getcartitemlist', async (req, res) => {
  const custCode = req.query.cust_code;
  const page = safePage(req.query.page);
  const pageSize = safePageSize(req.query.page_size);
  const search = req.query.search;
  const userCode = String(req.query.user_code || req.query.emp_code || req.get('x-user-code') || '').trim();
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
    await assertBasketAccessFromCartKey(query, userCode, custCode, 'can_enter');
    await ensureSalePremiumCartColumns(query);
    // COUNT
    const countSql = `SELECT COUNT(*) AS total_count FROM staff_cart_order WHERE cust_code = $1${searchCondition}`;
    const countResult = await query(countSql, params);
    const totalCount = parseInt(countResult.rows[0].total_count);

    // DATA — เลียนแบบ Java: fields ครบ + balance_qty=0 + tax_type จาก ic_inventory
    const dataSql = `
      SELECT sco.cust_code, sco.guid_code, sco.item_code, sco.item_name, sco.unit_code,
             sco.item_type, sco.barcode, sco.qty, sco.price, sco.wh_code, sco.shelf_code,
             sco.creator_code, sco.create_datetime, sco.stand_value, sco.divide_value,
             sco.ratio, sco.remark, sco.sale_premium_code, sco.sale_premium_name, sco.sale_premium_data,
             COALESCE(sco.sale_premium_line_type,'') AS sale_premium_line_type,
             COALESCE(sco.sale_premium_backlog_id,0) AS sale_premium_backlog_id,
             COALESCE(sco.sale_premium_backlog_detail_id,0) AS sale_premium_backlog_detail_id,
             COALESCE(sco.is_permium,0) AS is_permium, 0 AS balance_qty,
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
      sale_premium_code: r.sale_premium_code || '',
      sale_premium_name: r.sale_premium_name || '',
      sale_premium_data: parseJsonText(r.sale_premium_data),
      sale_premium_line_type: r.sale_premium_line_type || '',
      sale_premium_backlog_id: Number(r.sale_premium_backlog_id || 0),
      sale_premium_backlog_detail_id: Number(r.sale_premium_backlog_detail_id || 0),
      is_permium: Number(r.is_permium || 0),
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
    return res.status(ex.statusCode || 500).json({ success: false, error: ex.message, msg: ex.message });
  }
});

// GET /service/v1/getCartSummary
router.get('/getCartSummary', async (req, res) => {
  const custCode = req.query.cust_code;
  const userCode = String(req.query.user_code || req.query.emp_code || req.get('x-user-code') || '').trim();
  const resp = { success: false };

  if (!custCode || !custCode.trim()) {
    return res.status(400).json({ error: 'cust_code is required' });
  }

  try {
    await assertBasketAccessFromCartKey(query, userCode, custCode, 'can_enter');
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
  const userCode = String(req.query.user_code || req.query.emp_code || req.get('x-user-code') || '').trim();
  const page = safePage(req.query.page);
  const pageSize = safePageSize(req.query.page_size);

  const resp = { success: false };

  if (!custCode || !custCode.trim()) {
    return res.status(400).json({ error: 'cust_code is required' });
  }

  const offset = (page - 1) * pageSize;

  try {
    await ensureSalePremiumCartColumns(query);
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
      const priceConfirm = ['3', '4'].includes(String(r.item_type)) ? r.price : '0';
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
        sale_premium_code: r.sale_premium_code || '',
        sale_premium_name: r.sale_premium_name || '',
        sale_premium_data: parseJsonText(r.sale_premium_data),
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
    const userCode = String(body.user_code || body.emp_code || req.get('x-user-code') || '').trim();
    await assertBasketAccessFromCartKey(query, userCode, cust_code, 'can_enter');
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
        if (!['3', '4'].includes(itemType)) {
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
  const userCode = String(req.query.user_code || req.query.emp_code || req.get('x-user-code') || '').trim();
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
      if (!['3', '4'].includes(String(r.item_type))) {
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
  const userCode = String(req.query.user_code || req.query.emp_code || req.get('x-user-code') || '').trim();

  if (!custCode || !custCode.trim()) {
    return res.status(400).json({ error: 'cust_code is required' });
  }

  try {
    await assertBasketAccessFromCartKey(query, userCode, custCode, 'can_enter');
    await ensureSalePremiumCartColumns(query);
    const cartRes = await query(
      `SELECT c.*, COALESCE(i.tax_type,0) AS tax_type
         FROM staff_cart_order c
         LEFT JOIN ic_inventory i ON i.code=c.item_code
        WHERE c.cust_code=$1`,
      [custCode.trim()],
    );
    const detailItems = [];
    const premiumBacklogPreview = [];
    const salePremiumPricingItems = [];
    const premiumNoDeliverableIssues = [];
    for (const item of cartRes.rows) {
      const itemType = String(item?.item_type ?? '0');
      const backlogDetailId = parseInt(item?.sale_premium_backlog_detail_id || 0, 10) || 0;
      if (!backlogDetailId && (item?.sale_premium_code || itemType === '4')) {
        const fulfillment = await buildSalePremiumFulfillment(query, item, {
          custCode: '',
          excludeCartKey: custCode.trim(),
        });
        detailItems.push(...fulfillment.deliveredItems);
        if (fulfillment.deliveredItems.length === 0) {
          premiumNoDeliverableIssues.push({
            item_code: item.item_code,
            item_name: item.item_name,
            unit_code: item.unit_code,
            qty_in_cart: Number(item.qty || 0),
            balance_qty: 0,
            stock_qty: 0,
            reserved_other_qty: 0,
            issue_type: 'out_of_stock',
          });
        }
        salePremiumPricingItems.push(...fulfillment.deliveredItems.map((row, index) => ({
          ...row,
          guid_code: `${fulfillment.source_cart_guid || item.guid_code || item.item_code}-premium-${index}`,
          source_guid_code: fulfillment.source_cart_guid || item.guid_code || '',
          source_cart_guid: fulfillment.source_cart_guid || item.guid_code || '',
          source_premium_code: fulfillment.premium_code,
          source_premium_name: fulfillment.premium_name,
        })));
        if (fulfillment.pendingDetails.length > 0) {
          premiumBacklogPreview.push({
            premium_code: fulfillment.premium_code,
            premium_name: fulfillment.premium_name,
            pending_details: fulfillment.pendingDetails,
          });
        }
      } else {
        detailItems.push(item);
      }
    }
    const validation = await validateSaleItemsStock(query, detailItems, { excludeCartKey: custCode.trim() });
    const backlogIssues = await validateSalePremiumBacklogCartRows(query, cartRes.rows);
    const stockIssues = [
      ...(Array.isArray(validation.stock_issues) ? validation.stock_issues : []),
      ...backlogIssues,
      ...premiumNoDeliverableIssues,
    ];
    return res.json({
      ...validation,
      is_valid: stockIssues.length === 0,
      stock_issues: stockIssues,
      sale_premium_backlogs: premiumBacklogPreview,
      sale_premium_pricing_items: salePremiumPricingItems,
    });
  } catch (ex) {
    return res.status(ex.statusCode || 500).json({ success: false, error: ex.message, msg: ex.message });
  }
});

// GET /service/v1/deleteItem
// เลียนแบบ Java: DELETE WHERE guid_code=? AND cust_code=?
router.get('/deleteItem', async (req, res) => {
  const { guid_code, cust_code } = req.query;
  const userCode = String(req.query.user_code || req.query.emp_code || req.get('x-user-code') || '').trim();
  const resp = { success: false };
  try {
    await assertBasketAccessFromCartKey(query, userCode, cust_code, 'can_edit_items');
    await query(
      `DELETE FROM staff_cart_order WHERE guid_code = $1 AND cust_code = $2`,
      [guid_code || '', cust_code || '']
    );
    resp.success = true;
    return res.json(resp);
  } catch (ex) {
    return res.status(ex.statusCode || 400).json({ success: false, ERROR: ex.message, msg: ex.message });
  }
});

// GET /service/v1/deleteAllItems
// เลียนแบบ Java: DELETE WHERE cust_code=?
router.get('/deleteAllItems', async (req, res) => {
  const { cust_code } = req.query;
  const userCode = String(req.query.user_code || req.query.emp_code || req.get('x-user-code') || '').trim();
  const resp = { success: false };
  try {
    await assertBasketAccessFromCartKey(query, userCode, cust_code, 'can_edit_items');
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














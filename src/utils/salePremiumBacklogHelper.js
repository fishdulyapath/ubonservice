const { query } = require('../db');
const { loadSalePremiumDetail, ensureSalePremiumSchema, safeText, toNumber } = require('./salePremiumHelper');

function roundQty(value) {
  return Math.round(toNumber(value) * 10000) / 10000;
}

function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function statusFromPending(pendingQty) {
  return roundQty(pendingQty) <= 0 ? 'closed' : 'open';
}

function calculateBacklogFreeEntitlement(details = [], freeDetail = null, packQty = 0) {
  const packCount = Math.max(0, toNumber(packQty));
  if (packCount <= 0) return 0;
  const paidDetails = details.filter((row) => safeText(row.line_type) !== 'free');
  if (paidDetails.length === 0) return roundQty(toNumber(freeDetail?.target_qty));
  const fulfilledPacks = paidDetails.reduce((minPack, row) => {
    const targetQty = roundQty(row.target_qty);
    const perPackQty = targetQty / packCount;
    if (perPackQty <= 0) return minPack;
    const deliveredQty = roundQty(row.delivered_qty);
    return Math.min(minPack, Math.floor((deliveredQty / perPackQty) + 0.000001));
  }, packCount);
  const freeTargetQty = roundQty(toNumber(freeDetail?.target_qty));
  const freePerPackQty = freeTargetQty / packCount;
  return roundQty(Math.max(0, fulfilledPacks) * freePerPackQty);
}

function calculateBacklogFreeDeliverable(details = [], freeDetail = null, packQty = 0) {
  const entitlementQty = calculateBacklogFreeEntitlement(details, freeDetail, packQty);
  return Math.max(0, roundQty(entitlementQty - toNumber(freeDetail?.delivered_qty)));
}

async function ensureSalePremiumBacklogSchema(queryFn = query) {
  await ensureSalePremiumSchema(queryFn);
  await queryFn(`
    CREATE TABLE IF NOT EXISTS sml_sale_premium_backlog (
      roworder SERIAL PRIMARY KEY,
      guid_code VARCHAR(50) DEFAULT '',
      cust_code VARCHAR(25) NOT NULL,
      cust_name VARCHAR(255) DEFAULT '',
      premium_code VARCHAR(25) NOT NULL,
      premium_name VARCHAR(255) DEFAULT '',
      source_doc_no VARCHAR(25) DEFAULT '',
      source_basket_id VARCHAR(25) DEFAULT '',
      source_cart_guid VARCHAR(50) DEFAULT '',
      pack_qty NUMERIC(18,4) DEFAULT 0,
      sale_code VARCHAR(25) DEFAULT '',
      creator_code VARCHAR(25) DEFAULT '',
      status VARCHAR(20) DEFAULT 'open',
      remark TEXT DEFAULT '',
      create_date_time_now TIMESTAMP DEFAULT NOW(),
      update_date_time_now TIMESTAMP DEFAULT NOW(),
      close_date_time_now TIMESTAMP NULL
    )
  `);
  await queryFn(`CREATE INDEX IF NOT EXISTS sml_sale_premium_backlog_cust_idx ON sml_sale_premium_backlog (cust_code, status)`);
  await queryFn(`CREATE INDEX IF NOT EXISTS sml_sale_premium_backlog_premium_idx ON sml_sale_premium_backlog (premium_code, status)`);

  await queryFn(`
    CREATE TABLE IF NOT EXISTS sml_sale_premium_backlog_detail (
      roworder SERIAL PRIMARY KEY,
      backlog_id INTEGER NOT NULL,
      guid_code VARCHAR(50) DEFAULT '',
      line_number INTEGER DEFAULT 0,
      line_type VARCHAR(10) DEFAULT 'sale',
      item_code VARCHAR(25) NOT NULL,
      item_name VARCHAR(255) DEFAULT '',
      unit_code VARCHAR(25) DEFAULT '',
      barcode VARCHAR(50) DEFAULT '',
      wh_code VARCHAR(25) DEFAULT '',
      shelf_code VARCHAR(25) DEFAULT '',
      stand_value NUMERIC(18,4) DEFAULT 1,
      divide_value NUMERIC(18,4) DEFAULT 1,
      ratio NUMERIC(18,4) DEFAULT 1,
      tax_type SMALLINT DEFAULT 0,
      target_qty NUMERIC(18,4) DEFAULT 0,
      delivered_qty NUMERIC(18,4) DEFAULT 0,
      pending_qty NUMERIC(18,4) DEFAULT 0,
      unit_price NUMERIC(18,4) DEFAULT 0,
      sum_amount NUMERIC(18,2) DEFAULT 0,
      is_permium SMALLINT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'open',
      create_date_time_now TIMESTAMP DEFAULT NOW(),
      update_date_time_now TIMESTAMP DEFAULT NOW(),
      close_date_time_now TIMESTAMP NULL
    )
  `);
  await queryFn(`CREATE INDEX IF NOT EXISTS sml_sale_premium_backlog_detail_backlog_idx ON sml_sale_premium_backlog_detail (backlog_id, status)`);
  await queryFn(`CREATE INDEX IF NOT EXISTS sml_sale_premium_backlog_detail_item_idx ON sml_sale_premium_backlog_detail (item_code, status)`);

  await queryFn(`
    CREATE TABLE IF NOT EXISTS sml_sale_premium_backlog_delivery (
      roworder SERIAL PRIMARY KEY,
      backlog_id INTEGER NOT NULL,
      backlog_detail_id INTEGER NOT NULL,
      doc_no VARCHAR(25) DEFAULT '',
      doc_date DATE,
      item_code VARCHAR(25) DEFAULT '',
      unit_code VARCHAR(25) DEFAULT '',
      qty NUMERIC(18,4) DEFAULT 0,
      unit_price NUMERIC(18,4) DEFAULT 0,
      sum_amount NUMERIC(18,2) DEFAULT 0,
      wh_code VARCHAR(25) DEFAULT '',
      shelf_code VARCHAR(25) DEFAULT '',
      creator_code VARCHAR(25) DEFAULT '',
      create_date_time_now TIMESTAMP DEFAULT NOW()
    )
  `);
  await queryFn(`CREATE INDEX IF NOT EXISTS sml_sale_premium_backlog_delivery_detail_idx ON sml_sale_premium_backlog_delivery (backlog_detail_id)`);
}

async function loadAvailableBaseStock(queryFn, lines = [], excludeCartKey = '') {
  const codes = [...new Set(lines.map((line) => safeText(line.item_code)).filter(Boolean))];
  if (!codes.length) return new Map();
  const result = await queryFn(
    `WITH wanted AS (
       SELECT unnest($1::text[]) AS item_code
     ), stock AS (
       SELECT f.ic_code AS item_code, COALESCE(SUM(f.balance_qty),0) AS stock_qty
         FROM wanted w
         CROSS JOIN LATERAL sml_ic_function_stock_balance_warehouse_location(current_date, w.item_code, '', '') f
        GROUP BY f.ic_code
     ), reserved AS (
       SELECT c.item_code,
              COALESCE(SUM(COALESCE(c.qty,0)::numeric * COALESCE(NULLIF(c.ratio::numeric,0), NULLIF(u.ratio::numeric,0), COALESCE(u.stand_value::numeric,1) / NULLIF(COALESCE(u.divide_value::numeric,1),0), 1)),0) AS reserved_qty
         FROM staff_cart_order c
         LEFT JOIN ic_inventory i ON i.code=c.item_code
         LEFT JOIN ic_unit_use u ON u.ic_code=c.item_code AND u.code=c.unit_code
        WHERE c.cust_code LIKE 'BASKET-%'
          AND ($2::text = '' OR c.cust_code <> $2::text)
          AND c.item_code IN (SELECT item_code FROM wanted)
          AND COALESCE(NULLIF(c.item_type::text,'')::int, i.item_type, 0) NOT IN (1,3)
        GROUP BY c.item_code
     )
     SELECT w.item_code,
            COALESCE(s.stock_qty,0) AS stock_qty,
            COALESCE(r.reserved_qty,0) AS reserved_qty,
            GREATEST(COALESCE(s.stock_qty,0) - COALESCE(r.reserved_qty,0), 0) AS available_qty
       FROM wanted w
       LEFT JOIN stock s ON s.item_code=w.item_code
       LEFT JOIN reserved r ON r.item_code=w.item_code`,
    [codes, excludeCartKey || ''],
  );
  return new Map(result.rows.map((row) => [row.item_code, {
    stockBaseQty: toNumber(row.stock_qty),
    reservedBaseQty: toNumber(row.reserved_qty),
    availableBaseQty: toNumber(row.available_qty),
  }]));
}

function makePremiumLines(detail, packQty) {
  const code = safeText(detail.premium_code);
  const name = safeText(detail.premium_name || detail.name_1);
  const paid = (detail.paid_items || []).map((item, index) => ({
    ...item,
    line_number: toNumber(item.line_number, index),
    line_type: 'sale',
    target_qty: roundQty(toNumber(item.qty) * packQty),
    unit_price: roundMoney(item.price),
    sum_amount: roundMoney(toNumber(item.price) * toNumber(item.qty) * packQty),
    is_permium: 0,
    sale_premium_code: code,
    sale_premium_name: name,
  }));
  const free = (detail.free_items || []).map((item, index) => ({
    ...item,
    line_number: toNumber(item.line_number, paid.length + index),
    line_type: 'free',
    target_qty: roundQty(toNumber(item.qty) * packQty),
    unit_price: 0,
    sum_amount: 0,
    is_permium: 1,
    sale_premium_code: code,
    sale_premium_name: name,
  }));
  return [...paid, ...free];
}

async function buildSalePremiumFulfillment(queryFn, item, options = {}) {
  const code = safeText(item.sale_premium_code || item.premium_code || item.item_code);
  const packQty = Math.max(0, toNumber(item.qty, 1));
  const detail = await loadSalePremiumDetail(queryFn, code, options);
  const lines = makePremiumLines(detail, packQty);
  const paidLines = lines.filter((line) => line.line_type !== 'free');
  const freeLines = lines.filter((line) => line.line_type === 'free');
  const stockMap = await loadAvailableBaseStock(queryFn, lines, options.excludeCartKey || '');
  const remainingBase = new Map([...stockMap.entries()].map(([key, value]) => [key, value.availableBaseQty]));
  const deliveredItems = [];
  const pendingDetails = [];
  const fallbackWhCode = safeText(item.wh_code);
  const fallbackShelfCode = safeText(item.shelf_code);
  const paidDeliveredByLine = new Map();

  const allocateLine = (line, eligibleTargetQty) => {
    const itemCode = safeText(line.item_code);
    const ratio = Math.max(1, toNumber(line.ratio, 1));
    const targetQty = roundQty(line.target_qty);
    const deliverTargetQty = Math.max(0, Math.min(targetQty, roundQty(eligibleTargetQty)));
    const neededBaseQty = roundQty(deliverTargetQty * ratio);
    const availableBaseQty = Math.max(0, toNumber(remainingBase.get(itemCode)));
    const deliverBaseQty = Math.min(neededBaseQty, availableBaseQty);
    const deliverQty = Math.min(deliverTargetQty, roundQty(deliverBaseQty / ratio));
    const usedBaseQty = roundQty(deliverQty * ratio);
    const pendingQty = roundQty(targetQty - deliverQty);
    remainingBase.set(itemCode, roundQty(availableBaseQty - usedBaseQty));

    const normalizedLine = {
      ...line,
      wh_code: safeText(line.wh_code) || fallbackWhCode,
      shelf_code: safeText(line.shelf_code) || fallbackShelfCode,
      ratio,
      sale_premium_code: detail.premium_code,
      sale_premium_name: detail.premium_name || detail.name_1,
    };

    if (deliverQty > 0) {
      deliveredItems.push({
        ...normalizedLine,
        qty: deliverQty,
        price: roundMoney(line.unit_price),
        sum_amount: roundMoney(toNumber(line.unit_price) * deliverQty),
        discount: '',
        discount_amount: 0,
        item_type: '0',
        is_permium: toNumber(line.is_permium) === 1 ? 1 : 0,
        sale_premium_line_type: line.line_type,
        sale_premium_pack_qty: packQty,
      });
    }

    if (pendingQty > 0) {
      const stockInfo = stockMap.get(itemCode) || { stockBaseQty: 0, reservedBaseQty: 0, availableBaseQty: 0 };
      pendingDetails.push({
        ...normalizedLine,
        target_qty: targetQty,
        delivered_qty: deliverQty,
        pending_qty: pendingQty,
        unit_price: roundMoney(line.unit_price),
        sum_amount: roundMoney(toNumber(line.unit_price) * pendingQty),
        is_permium: toNumber(line.is_permium) === 1 ? 1 : 0,
        stock_qty: roundQty(stockInfo.stockBaseQty / ratio),
        available_qty: roundQty(stockInfo.availableBaseQty / ratio),
      });
    }
    return deliverQty;
  };

  for (const line of paidLines) {
    const deliverQty = allocateLine(line, roundQty(line.target_qty));
    paidDeliveredByLine.set(line.line_number, deliverQty);
  }

  let fulfilledPackQty = packQty;
  if (paidLines.length > 0) {
    fulfilledPackQty = paidLines.reduce((minPack, line) => {
      const perPackQty = roundQty(toNumber(line.qty));
      if (perPackQty <= 0) return minPack;
      const deliveredQty = toNumber(paidDeliveredByLine.get(line.line_number));
      return Math.min(minPack, Math.floor((deliveredQty / perPackQty) + 0.000001));
    }, packQty);
  }
  fulfilledPackQty = Math.max(0, Math.min(packQty, fulfilledPackQty));

  for (const line of freeLines) {
    const eligibleFreeQty = roundQty(toNumber(line.qty) * fulfilledPackQty);
    allocateLine(line, eligibleFreeQty);
  }

  return {
    premium_code: detail.premium_code,
    premium_name: detail.premium_name || detail.name_1,
    pack_qty: packQty,
    fulfilled_pack_qty: fulfilledPackQty,
    source_cart_guid: safeText(item.guid_code),
    source_basket_id: safeText(options.basketId),
    deliveredItems,
    pendingDetails,
    delivered_amount: roundMoney(deliveredItems.reduce((sum, row) => sum + toNumber(row.sum_amount), 0)),
    pending_amount: roundMoney(pendingDetails.reduce((sum, row) => sum + toNumber(row.sum_amount), 0)),
  };
}
async function createSalePremiumBacklogs(client, fulfillments = [], context = {}) {
  await ensureSalePremiumBacklogSchema(client.query.bind(client));
  const created = [];
  for (const fulfillment of fulfillments) {
    if (!fulfillment.pendingDetails?.length) continue;
    const headerRes = await client.query(
      `INSERT INTO sml_sale_premium_backlog
        (guid_code,cust_code,cust_name,premium_code,premium_name,source_doc_no,source_basket_id,source_cart_guid,pack_qty,sale_code,creator_code,status,remark,create_date_time_now,update_date_time_now)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,NOW(),NOW())
       RETURNING roworder`,
      [
        context.guidCode || '',
        context.custCode || '',
        context.custName || '',
        fulfillment.premium_code || '',
        fulfillment.premium_name || '',
        context.docNo || '',
        fulfillment.source_basket_id || context.basketId || '',
        fulfillment.source_cart_guid || '',
        fulfillment.pack_qty || 0,
        context.saleCode || '',
        context.creatorCode || '',
        context.remark || '',
      ],
    );
    const backlogId = headerRes.rows[0].roworder;
    for (const [idx, detail] of fulfillment.pendingDetails.entries()) {
      await client.query(
        `INSERT INTO sml_sale_premium_backlog_detail
          (backlog_id,guid_code,line_number,line_type,item_code,item_name,unit_code,barcode,wh_code,shelf_code,stand_value,divide_value,ratio,tax_type,target_qty,delivered_qty,pending_qty,unit_price,sum_amount,is_permium,status,create_date_time_now,update_date_time_now)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW(),NOW())`,
        [
          backlogId,
          '',
          toNumber(detail.line_number, idx),
          detail.line_type || 'sale',
          detail.item_code || '',
          detail.item_name || '',
          detail.unit_code || '',
          detail.barcode || '',
          detail.wh_code || '',
          detail.shelf_code || '',
          toNumber(detail.stand_value, 1),
          toNumber(detail.divide_value, 1),
          toNumber(detail.ratio, 1),
          Number(detail.tax_type ?? 0),
          toNumber(detail.target_qty),
          toNumber(detail.delivered_qty),
          toNumber(detail.pending_qty),
          toNumber(detail.unit_price),
          toNumber(detail.sum_amount),
          toNumber(detail.is_permium) === 1 ? 1 : 0,
          statusFromPending(detail.pending_qty),
        ],
      );
    }
    created.push({ backlog_id: backlogId, premium_code: fulfillment.premium_code, premium_name: fulfillment.premium_name, pending_details: fulfillment.pendingDetails });
  }
  return created;
}

async function applySalePremiumBacklogDeliveries(client, deliveredItems = [], context = {}) {
  await ensureSalePremiumBacklogSchema(client.query.bind(client));
  const rows = deliveredItems
    .filter((item) => toNumber(item.sale_premium_backlog_detail_id) > 0 && toNumber(item.qty) > 0)
    .sort((a, b) => (safeText(a.sale_premium_line_type) === 'free' ? 1 : 0) - (safeText(b.sale_premium_line_type) === 'free' ? 1 : 0));
  const applied = [];
  for (const item of rows) {
    const detailId = toNumber(item.sale_premium_backlog_detail_id);
    const lockRes = await client.query(
      `SELECT d.*, h.roworder AS header_id, h.status AS header_status
         FROM sml_sale_premium_backlog_detail d
         JOIN sml_sale_premium_backlog h ON h.roworder=d.backlog_id
        WHERE d.roworder=$1
        FOR UPDATE`,
      [detailId],
    );
    const detail = lockRes.rows[0];
    if (!detail) throw new Error(`premium backlog detail not found: ${detailId}`);
    if (safeText(detail.item_code) !== safeText(item.item_code)) throw new Error(`premium backlog item mismatch: ${detailId}`);
    const qty = roundQty(item.qty);
    const pendingQty = roundQty(detail.pending_qty);
    if (qty <= 0) continue;
    if (qty > pendingQty + 0.0001) throw new Error(`premium backlog qty exceeds pending: ${detail.item_code}`);
    const nextPending = roundQty(pendingQty - qty);
    const nextDelivered = roundQty(toNumber(detail.delivered_qty) + qty);
    await client.query(
      `UPDATE sml_sale_premium_backlog_detail
          SET delivered_qty=$2::numeric, pending_qty=$3::numeric, status=$4::text, update_date_time_now=NOW(), close_date_time_now=CASE WHEN $3::numeric <= 0 THEN NOW() ELSE NULL END
        WHERE roworder=$1`,
      [detailId, nextDelivered, nextPending, statusFromPending(nextPending)],
    );
    await client.query(
      `INSERT INTO sml_sale_premium_backlog_delivery
        (backlog_id,backlog_detail_id,doc_no,doc_date,item_code,unit_code,qty,unit_price,sum_amount,wh_code,shelf_code,creator_code,create_date_time_now)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
      [
        detail.backlog_id,
        detailId,
        context.docNo || '',
        context.docDate || null,
        item.item_code || '',
        item.unit_code || '',
        qty,
        toNumber(item.price),
        roundMoney(toNumber(item.price) * qty),
        item.wh_code || '',
        item.shelf_code || '',
        context.creatorCode || '',
      ],
    );
    const remainingRes = await client.query(
      `SELECT COUNT(*)::int AS open_count
         FROM sml_sale_premium_backlog_detail
        WHERE backlog_id=$1 AND pending_qty > 0 AND status <> 'cancelled'`,
      [detail.backlog_id],
    );
    const isClosed = Number(remainingRes.rows[0]?.open_count || 0) === 0;
    await client.query(
      `UPDATE sml_sale_premium_backlog
          SET status=$2::text, update_date_time_now=NOW(), close_date_time_now=CASE WHEN $2::text='closed' THEN NOW() ELSE NULL END
        WHERE roworder=$1`,
      [detail.backlog_id, isClosed ? 'closed' : 'partial'],
    );
    applied.push({ backlog_id: detail.backlog_id, backlog_detail_id: detailId, item_code: item.item_code, qty });
  }
  return applied;
}

async function listSalePremiumBacklogs(queryFn = query, options = {}) {
  await ensureSalePremiumBacklogSchema(queryFn);
  const params = [];
  const where = [];
  const custCode = safeText(options.custCode);
  const search = safeText(options.search);
  const includeClosed = String(options.includeClosed || '') === '1';
  if (custCode) {
    params.push(custCode);
    where.push(`h.cust_code=$${params.length}`);
  }
  if (!includeClosed) where.push(`h.status IN ('open','partial')`);
  if (search) {
    params.push(`%${search}%`);
    where.push(`(h.cust_code ILIKE $${params.length} OR h.cust_name ILIKE $${params.length} OR h.premium_code ILIKE $${params.length} OR h.premium_name ILIKE $${params.length} OR d.item_code ILIKE $${params.length} OR d.item_name ILIKE $${params.length})`);
  }
  const limit = Math.max(1, Math.min(500, parseInt(options.limit, 10) || 200));
  params.push(limit);
  const sql = `
    WITH base AS (
      SELECT h.roworder AS backlog_id, h.cust_code, h.cust_name, h.premium_code, h.premium_name,
             h.source_doc_no, h.source_basket_id, h.pack_qty, h.sale_code, h.creator_code,
             h.status AS backlog_status, h.create_date_time_now, h.update_date_time_now,
             d.roworder AS detail_id, d.line_number, d.line_type, d.item_code, d.item_name,
             d.unit_code, d.barcode, d.wh_code, d.shelf_code, d.stand_value, d.divide_value,
             d.ratio, d.tax_type, d.target_qty, d.delivered_qty, d.pending_qty,
             d.unit_price, d.sum_amount, d.is_permium, d.status AS detail_status
        FROM sml_sale_premium_backlog h
        JOIN sml_sale_premium_backlog_detail d ON d.backlog_id=h.roworder
       WHERE ${where.length ? where.join(' AND ') : '1=1'}
         AND d.pending_qty > 0
       ORDER BY h.update_date_time_now DESC, h.roworder DESC, d.line_number, d.roworder
       LIMIT $${params.length}
    ), codes AS (
      SELECT string_agg(DISTINCT item_code, ',') AS item_codes FROM base
    ), stock AS (
      SELECT f.ic_code AS item_code, COALESCE(SUM(f.balance_qty),0) AS stock_qty
        FROM codes c
        CROSS JOIN LATERAL sml_ic_function_stock_balance_warehouse_location(current_date, COALESCE(c.item_codes,''), '', '') f
       WHERE COALESCE(c.item_codes,'') <> ''
       GROUP BY f.ic_code
    )
    SELECT b.*, COALESCE(s.stock_qty,0) AS stock_base_qty,
           GREATEST(COALESCE(s.stock_qty,0),0) / COALESCE(NULLIF(b.ratio,0),1) AS stock_qty,
           LEAST(b.pending_qty, FLOOR((GREATEST(COALESCE(s.stock_qty,0),0) / COALESCE(NULLIF(b.ratio,0),1)) * 10000) / 10000) AS deliverable_qty
      FROM base b
      LEFT JOIN stock s ON s.item_code=b.item_code
     ORDER BY b.update_date_time_now DESC, b.backlog_id DESC, b.line_number, b.detail_id`;
  const result = await queryFn(sql, params);
  const rows = result.rows;
  return rows;
}

async function getSalePremiumBacklogSummary(queryFn = query) {
  await ensureSalePremiumBacklogSchema(queryFn);
  const result = await queryFn(
    `SELECT COUNT(DISTINCT h.cust_code)::int AS customer_count,
            COUNT(DISTINCT h.roworder)::int AS backlog_count,
            COUNT(d.roworder)::int AS line_count,
            COALESCE(SUM(d.pending_qty),0) AS pending_qty,
            COALESCE(SUM(d.sum_amount),0) AS pending_amount
       FROM sml_sale_premium_backlog h
       JOIN sml_sale_premium_backlog_detail d ON d.backlog_id=h.roworder
      WHERE h.status IN ('open','partial')
        AND d.pending_qty > 0
        AND d.status <> 'cancelled'`,
  );
  const recent = await listSalePremiumBacklogs(queryFn, { limit: 8 });
  return { ...(result.rows[0] || {}), recent };
}

module.exports = {
  ensureSalePremiumBacklogSchema,
  loadAvailableBaseStock,
  buildSalePremiumFulfillment,
  createSalePremiumBacklogs,
  applySalePremiumBacklogDeliveries,
  listSalePremiumBacklogs,
  getSalePremiumBacklogSummary,
};

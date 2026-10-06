const crypto = require('crypto');
const { query } = require('../db');
const { getProductPriceLocalx } = require('./priceHelper');
const { loadAvailableBaseStock } = require('./salePremiumBacklogHelper');
const { calcDiscount } = require('./vatHelper');

const EPSILON = 0.0001;

function safeText(value) {
  return String(value ?? '').trim();
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundQty(value) {
  return Math.round(toNumber(value) * 10000) / 10000;
}

function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function lineRatio(item = {}) {
  const explicit = toNumber(item.ratio);
  if (explicit > 0) return explicit;
  const stand = toNumber(item.stand_value, 1);
  const divide = toNumber(item.divide_value, 1);
  return divide > 0 ? Math.max(stand / divide, EPSILON) : 1;
}

function calculateLineAmount(price, qty, discountWord = '') {
  const gross = roundMoney(toNumber(price) * toNumber(qty));
  return roundMoney(gross - calcDiscount(safeText(discountWord), gross));
}

async function ensureSmlPromotionBacklogSchema(queryFn = query) {
  await queryFn(`
    CREATE TABLE IF NOT EXISTS sml_sml_promotion_backlog (
      roworder SERIAL PRIMARY KEY,
      guid_code VARCHAR(50) DEFAULT '',
      cust_code VARCHAR(25) NOT NULL,
      cust_name VARCHAR(255) DEFAULT '',
      source_doc_no VARCHAR(25) DEFAULT '',
      source_doc_date DATE,
      origin_request_ref VARCHAR(60) DEFAULT '',
      source_basket_id VARCHAR(25) DEFAULT '',
      source_cart_guid VARCHAR(50) DEFAULT '',
      sale_code VARCHAR(25) DEFAULT '',
      creator_code VARCHAR(25) DEFAULT '',
      pricing_context JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(20) DEFAULT 'open',
      remark TEXT DEFAULT '',
      create_date_time_now TIMESTAMP DEFAULT NOW(),
      update_date_time_now TIMESTAMP DEFAULT NOW(),
      close_date_time_now TIMESTAMP NULL
    )
  `);
  await queryFn(`
    CREATE TABLE IF NOT EXISTS sml_sml_promotion_backlog_detail (
      roworder SERIAL PRIMARY KEY,
      backlog_id INTEGER NOT NULL,
      source_line_guid VARCHAR(50) DEFAULT '',
      line_number INTEGER DEFAULT 0,
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
      original_qty NUMERIC(18,4) DEFAULT 0,
      full_price_qty NUMERIC(18,4) DEFAULT 0,
      delivered_qty NUMERIC(18,4) DEFAULT 0,
      pending_qty NUMERIC(18,4) DEFAULT 0,
      pricing_context JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(20) DEFAULT 'open',
      create_date_time_now TIMESTAMP DEFAULT NOW(),
      update_date_time_now TIMESTAMP DEFAULT NOW(),
      close_date_time_now TIMESTAMP NULL
    )
  `);
  await queryFn(`
    CREATE TABLE IF NOT EXISTS sml_sml_promotion_backlog_delivery (
      roworder SERIAL PRIMARY KEY,
      backlog_id INTEGER NOT NULL,
      backlog_detail_id INTEGER NOT NULL,
      doc_no VARCHAR(25) DEFAULT '',
      doc_date DATE,
      item_code VARCHAR(25) DEFAULT '',
      unit_code VARCHAR(25) DEFAULT '',
      qty NUMERIC(18,4) DEFAULT 0,
      unit_price NUMERIC(18,4) DEFAULT 0,
      discount_word VARCHAR(255) DEFAULT '',
      sum_amount NUMERIC(18,2) DEFAULT 0,
      wh_code VARCHAR(25) DEFAULT '',
      shelf_code VARCHAR(25) DEFAULT '',
      creator_code VARCHAR(25) DEFAULT '',
      is_initial_delivery SMALLINT DEFAULT 0,
      create_date_time_now TIMESTAMP DEFAULT NOW()
    )
  `);

  await queryFn(`ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sml_promotion_backlog_id INTEGER DEFAULT 0`);
  await queryFn(`ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sml_promotion_backlog_detail_id INTEGER DEFAULT 0`);
  await queryFn(`ALTER TABLE staff_cart_order ADD COLUMN IF NOT EXISTS sml_promotion_full_qty NUMERIC(18,4) DEFAULT 0`);

  await queryFn(`CREATE INDEX IF NOT EXISTS sml_sml_promotion_backlog_customer_idx ON sml_sml_promotion_backlog (cust_code, status, create_date_time_now)`);
  await queryFn(`CREATE INDEX IF NOT EXISTS sml_sml_promotion_backlog_source_doc_idx ON sml_sml_promotion_backlog (source_doc_no)`);
  await queryFn(`CREATE INDEX IF NOT EXISTS sml_sml_promotion_backlog_detail_open_idx ON sml_sml_promotion_backlog_detail (item_code, unit_code, status, backlog_id)`);
  await queryFn(`CREATE INDEX IF NOT EXISTS sml_sml_promotion_backlog_delivery_detail_idx ON sml_sml_promotion_backlog_delivery (backlog_detail_id)`);
  await queryFn(`CREATE INDEX IF NOT EXISTS staff_cart_order_sml_promotion_backlog_detail_idx ON staff_cart_order (sml_promotion_backlog_detail_id)`);
}

function buildPricingContext(item, options = {}, quote = {}) {
  return {
    version: 1,
    customer_code: safeText(options.custCode),
    sale_type: toNumber(options.saleType),
    vat_type: toNumber(options.vatType),
    vat_rate: Number.isFinite(Number(options.vatRate)) ? Number(options.vatRate) : null,
    original_qty: roundQty(item.qty),
    item_code: safeText(item.item_code),
    unit_code: safeText(item.unit_code),
    barcode: safeText(item.barcode),
    price_source_type: safeText(quote.type),
    price_source_mode: safeText(quote.mode),
    price_source_roworder: safeText(quote.roworder),
    full_items: Array.isArray(options.fullItems)
      ? options.fullItems.map((row) => ({
        item_code: safeText(row.item_code),
        unit_code: safeText(row.unit_code),
        qty: roundQty(row.qty),
      }))
      : [],
  };
}

async function quoteItemAtOriginalQty(item, options = {}) {
  const qty = Math.max(roundQty(options.fullQty ?? item.full_price_qty ?? item.qty), 1);
  const priceResult = await getProductPriceLocalx(
    safeText(item.item_code),
    safeText(item.unit_code),
    String(qty),
    safeText(options.custCode),
    toNumber(options.vatType),
    Number.isFinite(Number(options.vatRate)) ? Number(options.vatRate) : null,
    toNumber(options.saleType),
    safeText(item.barcode),
    options.docDate || undefined,
  );
  const priceRow = (priceResult.data || [])[0] || {};
  return {
    price: roundMoney(priceRow.price),
    discount: safeText(priceRow.defaultDiscount ?? priceRow.default_discount),
    type: safeText(priceRow.type),
    mode: safeText(priceRow.mode),
    roworder: safeText(priceRow.roworder),
  };
}

async function isSmlPromotionCatalogItem(queryFn, itemCode, custCode) {
  const result = await queryFn(
    `SELECT (
       EXISTS (
         SELECT 1
           FROM ic_inventory_price p
          WHERE p.ic_code=$1
            AND CURRENT_DATE BETWEEN p.from_date AND p.to_date
            AND (COALESCE(p.cust_code,'')='' OR p.cust_code=$2)
            AND (COALESCE(p.cust_group_1,'')='' OR p.cust_group_1=(
              SELECT MAX(d.group_main) FROM ar_customer_detail d WHERE d.ar_code=$2
            ))
       )
       OR EXISTS (
         SELECT 1
           FROM ic_inventory_discount d
          WHERE d.ic_code=$1
            AND CURRENT_DATE BETWEEN d.from_date AND d.to_date
            AND (
              d.discount_type=0
              OR (d.discount_type=2 AND d.cust_code=$2)
              OR (d.discount_type=1 AND d.cust_group_1=(
                SELECT MAX(cd.group_main) FROM ar_customer_detail cd WHERE cd.ar_code=$2
              ))
            )
       )
     ) AS is_promotion`,
    [safeText(itemCode), safeText(custCode)],
  );
  return Boolean(result.rows[0]?.is_promotion);
}

async function buildSmlPromotionFulfillment(queryFn, item, options = {}) {
  const originalQty = roundQty(item.qty);
  if (!safeText(item.item_code) || originalQty <= 0) return null;
  if (['3', '4'].includes(String(item.item_type ?? '0'))) return null;
  if (!(await isSmlPromotionCatalogItem(queryFn, item.item_code, options.custCode))) return null;
  const quote = await quoteItemAtOriginalQty(item, { ...options, fullQty: originalQty });
  // A quantity of one resolves the regular/first-tier price under the same
  // customer, VAT, sale type, and document-date context as the promotion.
  const normalQuote = await quoteItemAtOriginalQty(item, { ...options, fullQty: 1 });

  const ratio = lineRatio(item);
  const stockMap = options.stockMap || await loadAvailableBaseStock(queryFn, [item], options.excludeCartKey || '');
  const stock = stockMap.get(safeText(item.item_code)) || { availableBaseQty: 0, stockBaseQty: 0, reservedBaseQty: 0 };
  const alreadyAllocated = toNumber(options.allocatedBaseQty?.get?.(safeText(item.item_code)));
  const availableBaseQty = Math.max(0, toNumber(stock.availableBaseQty) - alreadyAllocated);
  const deliverQty = Math.min(originalQty, roundQty(availableBaseQty / ratio));
  const pendingQty = roundQty(originalQty - deliverQty);
  if (options.allocatedBaseQty?.set) {
    options.allocatedBaseQty.set(safeText(item.item_code), alreadyAllocated + (deliverQty * ratio));
  }

  const pricingContext = buildPricingContext(item, options, quote);
  const line = {
    ...item,
    qty: deliverQty,
    price: quote.price,
    normal_price: normalQuote.price,
    discount: quote.discount,
    discount_amount: calcDiscount(quote.discount, quote.price * deliverQty),
    sum_amount: calculateLineAmount(quote.price, deliverQty, quote.discount),
    ratio,
    sml_promotion_context: pricingContext,
    sml_promotion_full_qty: originalQty,
  };

  return {
    source_cart_guid: safeText(item.guid_code),
    source_basket_id: safeText(options.basketId),
    original_item: { ...item, ratio },
    pricing_context: pricingContext,
    original_qty: originalQty,
    delivered_item: deliverQty > 0 ? line : null,
    pending_detail: pendingQty > 0 ? {
      ...line,
      qty: pendingQty,
      delivered_qty: deliverQty,
      pending_qty: pendingQty,
      original_qty: originalQty,
      full_price_qty: originalQty,
    } : null,
  };
}

async function createSmlPromotionBacklogs(client, fulfillments = [], context = {}) {
  await ensureSmlPromotionBacklogSchema(client.query.bind(client));
  const created = [];
  for (const fulfillment of fulfillments) {
    if (!fulfillment?.pending_detail) continue;
    const detail = fulfillment.pending_detail;
    const originRequestRef = safeText(context.docNo)
      ? ''
      : `SML-BACKLOG-${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    const header = await client.query(
      `INSERT INTO sml_sml_promotion_backlog
        (guid_code,cust_code,cust_name,source_doc_no,source_doc_date,origin_request_ref,source_basket_id,source_cart_guid,sale_code,creator_code,pricing_context,status,remark,create_date_time_now,update_date_time_now)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11::jsonb,'open',$12,NOW(),NOW())
       RETURNING roworder`,
      [
        crypto.randomUUID(), context.custCode || '', context.custName || '', context.docNo || '', context.docDate || null,
        originRequestRef, fulfillment.source_basket_id || context.basketId || '', fulfillment.source_cart_guid || '',
        context.saleCode || '', context.creatorCode || '', JSON.stringify(fulfillment.pricing_context || {}), context.remark || '',
      ],
    );
    const backlogId = Number(header.rows[0].roworder);
    const detailRes = await client.query(
      `INSERT INTO sml_sml_promotion_backlog_detail
        (backlog_id,source_line_guid,line_number,item_code,item_name,unit_code,barcode,wh_code,shelf_code,stand_value,divide_value,ratio,tax_type,original_qty,full_price_qty,delivered_qty,pending_qty,pricing_context,status,create_date_time_now,update_date_time_now)
       VALUES ($1,$2,0,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,'open',NOW(),NOW())
       RETURNING roworder`,
      [
        backlogId, fulfillment.source_cart_guid || '', detail.item_code || '', detail.item_name || '', detail.unit_code || '',
        detail.barcode || '', detail.wh_code || '', detail.shelf_code || '', toNumber(detail.stand_value, 1),
        toNumber(detail.divide_value, 1), toNumber(detail.ratio, 1), toNumber(detail.tax_type),
        toNumber(detail.original_qty), toNumber(detail.full_price_qty), toNumber(detail.delivered_qty), toNumber(detail.pending_qty),
        JSON.stringify(fulfillment.pricing_context || {}),
      ],
    );
    const detailId = Number(detailRes.rows[0].roworder);
    if (fulfillment.delivered_item && toNumber(fulfillment.delivered_item.qty) > 0 && context.docNo) {
      const delivered = fulfillment.delivered_item;
      await client.query(
        `INSERT INTO sml_sml_promotion_backlog_delivery
          (backlog_id,backlog_detail_id,doc_no,doc_date,item_code,unit_code,qty,unit_price,discount_word,sum_amount,wh_code,shelf_code,creator_code,is_initial_delivery,create_date_time_now)
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,NOW())`,
        [backlogId, detailId, context.docNo, context.docDate || null, delivered.item_code || '', delivered.unit_code || '',
          toNumber(delivered.qty), toNumber(delivered.price), delivered.discount || '', toNumber(delivered.sum_amount),
          delivered.wh_code || '', delivered.shelf_code || '', context.creatorCode || ''],
      );
    }
    created.push({ backlog_id: backlogId, detail_id: detailId, origin_request_ref: originRequestRef });
  }
  return created;
}

async function getSmlBacklogDetailForUpdate(client, detailId) {
  const result = await client.query(
    `SELECT d.*, h.cust_code, h.cust_name, h.status AS backlog_status, h.pricing_context AS header_pricing_context
       FROM sml_sml_promotion_backlog_detail d
       JOIN sml_sml_promotion_backlog h ON h.roworder=d.backlog_id
      WHERE d.roworder=$1
      FOR UPDATE`,
    [detailId],
  );
  return result.rows[0] || null;
}

async function getSmlPromotionBacklogCartPricing(queryFn, item, context = {}) {
  const detailId = toNumber(item?.sml_promotion_backlog_detail_id);
  if (detailId <= 0) return null;

  const result = await queryFn(
    `SELECT d.*, h.cust_code, h.status AS backlog_status
       FROM sml_sml_promotion_backlog_detail d
       JOIN sml_sml_promotion_backlog h ON h.roworder=d.backlog_id
      WHERE d.roworder=$1`,
    [detailId],
  );
  const detail = result.rows[0];
  if (!detail) return null;
  if (safeText(context.custCode) && safeText(detail.cust_code) !== safeText(context.custCode)) return null;
  if (safeText(detail.item_code) !== safeText(item.item_code) || safeText(detail.unit_code) !== safeText(item.unit_code)) return null;

  const pricingContext = typeof detail.pricing_context === 'object' && detail.pricing_context
    ? detail.pricing_context
    : {};
  const fullQty = toNumber(detail.full_price_qty);
  const quoteOptions = {
    custCode: detail.cust_code,
    vatType: pricingContext.vat_type ?? context.vatType,
    vatRate: pricingContext.vat_rate ?? context.vatRate,
    saleType: pricingContext.sale_type ?? context.saleType,
  };
  const quote = await quoteItemAtOriginalQty(item, { ...quoteOptions, fullQty });
  const normalQuote = await quoteItemAtOriginalQty(item, { ...quoteOptions, fullQty: 1 });
  const qty = roundQty(item.qty);

  return {
    ...item,
    price: quote.price,
    normal_price: normalQuote.price,
    discount: quote.discount,
    discount_amount: calcDiscount(quote.discount, quote.price * qty),
    sum_amount: calculateLineAmount(quote.price, qty, quote.discount),
    sml_promotion_full_qty: fullQty,
    sml_promotion_pricing_context: pricingContext,
  };
}

async function refreshSmlPromotionBacklogItems(client, items = [], context = {}) {
  await ensureSmlPromotionBacklogSchema(client.query.bind(client));
  const refreshed = [];
  for (const item of items) {
    const detailId = toNumber(item.sml_promotion_backlog_detail_id);
    if (detailId <= 0) {
      refreshed.push(item);
      continue;
    }
    const detail = await getSmlBacklogDetailForUpdate(client, detailId);
    if (!detail) throw new Error(`sml promotion backlog detail not found: ${detailId}`);
    if (safeText(detail.cust_code) !== safeText(context.custCode)) throw new Error('sml promotion backlog customer mismatch');
    if (safeText(detail.item_code) !== safeText(item.item_code) || safeText(detail.unit_code) !== safeText(item.unit_code)) {
      throw new Error(`sml promotion backlog item mismatch: ${detailId}`);
    }
    const qty = roundQty(item.qty);
    if (qty <= 0 || qty > roundQty(detail.pending_qty) + EPSILON) {
      throw new Error(`sml promotion backlog qty exceeds pending: ${detail.item_code}`);
    }
    const pricingContext = typeof detail.pricing_context === 'object' && detail.pricing_context
      ? detail.pricing_context
      : {};
    const quote = await quoteItemAtOriginalQty(item, {
      custCode: detail.cust_code,
      vatType: pricingContext.vat_type ?? context.vatType,
      vatRate: pricingContext.vat_rate ?? context.vatRate,
      saleType: pricingContext.sale_type ?? context.saleType,
      docDate: context.docDate,
      fullQty: detail.full_price_qty,
    });
    refreshed.push({
      ...item,
      price: quote.price,
      discount: quote.discount,
      discount_amount: calcDiscount(quote.discount, quote.price * qty),
      sum_amount: calculateLineAmount(quote.price, qty, quote.discount),
      sml_promotion_full_qty: toNumber(detail.full_price_qty),
      sml_promotion_pricing_context: pricingContext,
    });
  }
  return refreshed;
}

async function applySmlPromotionBacklogDeliveries(client, items = [], context = {}) {
  await ensureSmlPromotionBacklogSchema(client.query.bind(client));
  const applied = [];
  for (const item of items) {
    const detailId = toNumber(item.sml_promotion_backlog_detail_id);
    if (detailId <= 0) continue;
    const detail = await getSmlBacklogDetailForUpdate(client, detailId);
    if (!detail) throw new Error(`sml promotion backlog detail not found: ${detailId}`);
    const qty = roundQty(item.qty);
    if (qty <= 0 || qty > roundQty(detail.pending_qty) + EPSILON) {
      throw new Error(`sml promotion backlog qty exceeds pending: ${detail.item_code}`);
    }
    const pendingQty = roundQty(detail.pending_qty - qty);
    const deliveredQty = roundQty(toNumber(detail.delivered_qty) + qty);
    const status = pendingQty <= EPSILON ? 'closed' : 'partial';
    await client.query(
      `UPDATE sml_sml_promotion_backlog_detail
          SET delivered_qty=$2::numeric,pending_qty=$3::numeric,status=$4::text,update_date_time_now=NOW(),close_date_time_now=CASE WHEN $3::numeric <= 0 THEN NOW() ELSE NULL END
        WHERE roworder=$1`,
      [detailId, deliveredQty, Math.max(0, pendingQty), status],
    );
    await client.query(
      `INSERT INTO sml_sml_promotion_backlog_delivery
        (backlog_id,backlog_detail_id,doc_no,doc_date,item_code,unit_code,qty,unit_price,discount_word,sum_amount,wh_code,shelf_code,creator_code,is_initial_delivery,create_date_time_now)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,NOW())`,
      [detail.backlog_id, detailId, context.docNo || '', context.docDate || null, item.item_code || '', item.unit_code || '',
        qty, toNumber(item.price), item.discount || '', toNumber(item.sum_amount), item.wh_code || '', item.shelf_code || '', context.creatorCode || ''],
    );
    const stillOpen = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM sml_sml_promotion_backlog_detail
        WHERE backlog_id=$1 AND pending_qty > 0 AND status <> 'cancelled'`,
      [detail.backlog_id],
    );
    const headerStatus = Number(stillOpen.rows[0]?.count || 0) === 0 ? 'closed' : 'partial';
    await client.query(
      `UPDATE sml_sml_promotion_backlog
          SET status=$2::text,update_date_time_now=NOW(),close_date_time_now=CASE WHEN $2::text='closed' THEN NOW() ELSE NULL END
        WHERE roworder=$1`,
      [detail.backlog_id, headerStatus],
    );
    applied.push({ backlog_id: Number(detail.backlog_id), detail_id: detailId, qty });
  }
  return applied;
}

async function listSmlPromotionBacklogLots(queryFn = query, options = {}) {
  await ensureSmlPromotionBacklogSchema(queryFn);
  const params = [];
  const where = [`d.pending_qty > 0`, `d.status <> 'cancelled'`, `h.status IN ('open','partial')`];
  if (safeText(options.custCode)) {
    params.push(safeText(options.custCode));
    where.push(`h.cust_code=$${params.length}`);
  }
  if (safeText(options.itemCode)) {
    params.push(safeText(options.itemCode));
    where.push(`d.item_code=$${params.length}`);
  }
  if (safeText(options.unitCode)) {
    params.push(safeText(options.unitCode));
    where.push(`d.unit_code=$${params.length}`);
  }
  const result = await queryFn(
    `SELECT h.roworder AS backlog_id,h.cust_code,h.cust_name,h.source_doc_no,h.source_doc_date,h.origin_request_ref,h.source_basket_id,h.sale_code,h.creator_code,h.status AS backlog_status,h.create_date_time_now,
            d.roworder AS detail_id,d.item_code,d.item_name,d.unit_code,d.barcode,d.wh_code,d.shelf_code,d.stand_value,d.divide_value,d.ratio,d.tax_type,d.original_qty,d.full_price_qty,d.delivered_qty,d.pending_qty,d.pricing_context,d.status AS detail_status
       FROM sml_sml_promotion_backlog h
       JOIN sml_sml_promotion_backlog_detail d ON d.backlog_id=h.roworder
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(h.source_doc_date,h.create_date_time_now::date),h.create_date_time_now,h.roworder,d.roworder`,
    params,
  );
  return result.rows;
}

async function listSmlPromotionBacklogs(queryFn = query, options = {}) {
  const lots = await listSmlPromotionBacklogLots(queryFn, options);
  const stockMap = await loadAvailableBaseStock(queryFn, lots, options.excludeCartKey || '');
  return lots.map((row) => {
    const ratio = lineRatio(row);
    const stock = stockMap.get(safeText(row.item_code)) || { stockBaseQty: 0, availableBaseQty: 0 };
    return {
      ...row,
      backlog_type: 'sml_promotion',
      premium_code: 'SML-PRICE',
      premium_name: 'โปรโมชั่น SML',
      line_type: 'sale',
      is_permium: 0,
      stock_qty: roundQty(toNumber(stock.stockBaseQty) / ratio),
      available_stock_qty: roundQty(toNumber(stock.availableBaseQty) / ratio),
      deliverable_qty: Math.min(roundQty(row.pending_qty), roundQty(toNumber(stock.availableBaseQty) / ratio)),
    };
  });
}

async function getSmlPromotionBacklogSummary(queryFn = query) {
  await ensureSmlPromotionBacklogSchema(queryFn);
  const result = await queryFn(
    `SELECT COUNT(DISTINCT h.cust_code)::int AS customer_count,
            COUNT(DISTINCT h.roworder)::int AS backlog_count,
            COUNT(d.roworder)::int AS line_count,
            COALESCE(SUM(d.pending_qty),0) AS pending_qty
       FROM sml_sml_promotion_backlog h
       JOIN sml_sml_promotion_backlog_detail d ON d.backlog_id=h.roworder
      WHERE h.status IN ('open','partial')
        AND d.pending_qty > 0
        AND d.status <> 'cancelled'`,
  );
  const recent = await listSmlPromotionBacklogs(queryFn, { limit: 8 });
  return { ...(result.rows[0] || {}), recent };
}

async function listGroupedSmlPromotionBacklogs(queryFn = query, options = {}) {
  const rows = await listSmlPromotionBacklogs(queryFn, options);
  const groups = new Map();
  for (const row of rows) {
    const key = `${safeText(row.item_code)}::${safeText(row.unit_code)}`;
    const current = groups.get(key) || {
      ...row,
      detail_id: 0,
      backlog_id: 0,
      pending_qty: 0,
      delivered_qty: 0,
      source_doc_no: '',
      source_doc_count: 0,
      source_doc_nos: [],
      detail_ids: [],
      lot_count: 0,
      available_stock_qty: roundQty(row.available_stock_qty),
    };
    current.pending_qty = roundQty(current.pending_qty + toNumber(row.pending_qty));
    current.delivered_qty = roundQty(current.delivered_qty + toNumber(row.delivered_qty));
    current.lot_count += 1;
    current.detail_ids.push(Number(row.detail_id));
    current.available_stock_qty = Math.max(toNumber(current.available_stock_qty), toNumber(row.available_stock_qty));
    if (safeText(row.source_doc_no) && !current.source_doc_nos.includes(row.source_doc_no)) current.source_doc_nos.push(row.source_doc_no);
    groups.set(key, current);
  }
  return [...groups.values()].map((row) => ({
    ...row,
    source_doc_count: row.source_doc_nos.length,
    source_doc_no: row.source_doc_nos[0] || row.origin_request_ref || '',
    deliverable_qty: Math.min(roundQty(row.pending_qty), roundQty(row.available_stock_qty)),
  }));
}

async function addSmlPromotionBacklogToCart(client, options = {}) {
  await ensureSmlPromotionBacklogSchema(client.query.bind(client));
  const custCode = safeText(options.custCode);
  const cartKey = safeText(options.cartKey);
  const itemCode = safeText(options.itemCode);
  const unitCode = safeText(options.unitCode);
  let requestedQty = roundQty(options.qty);
  if (!custCode || !cartKey || !itemCode || !unitCode || requestedQty <= 0) {
    throw new Error('customer, cart, item, unit, and quantity are required');
  }

  const lotsResult = await client.query(
    `SELECT h.roworder AS backlog_id,h.cust_code,h.cust_name,h.source_doc_no,h.origin_request_ref,h.status AS backlog_status,
            d.roworder AS detail_id,d.item_code,d.item_name,d.unit_code,d.barcode,d.wh_code,d.shelf_code,
            d.stand_value,d.divide_value,d.ratio,d.tax_type,d.full_price_qty,d.pending_qty,d.pricing_context,d.status AS detail_status
       FROM sml_sml_promotion_backlog h
       JOIN sml_sml_promotion_backlog_detail d ON d.backlog_id=h.roworder
      WHERE h.cust_code=$1
        AND d.item_code=$2
        AND d.unit_code=$3
        AND d.pending_qty > 0
        AND d.status <> 'cancelled'
        AND h.status IN ('open','partial')
      ORDER BY COALESCE(h.source_doc_date,h.create_date_time_now::date),h.create_date_time_now,h.roworder,d.roworder
      FOR UPDATE OF d,h`,
    [custCode, itemCode, unitCode],
  );
  const lots = lotsResult.rows;
  if (!lots.length) throw new Error('ไม่พบสินค้าคงค้างโปรโมชั่น SML ที่ยังส่งได้');

  const detailIds = lots.map((lot) => Number(lot.detail_id));
  const reservedResult = await client.query(
    `SELECT sml_promotion_backlog_detail_id AS detail_id,
            COALESCE(SUM(qty),0)::numeric AS reserved_qty
       FROM staff_cart_order
      WHERE COALESCE(sml_promotion_backlog_detail_id,0)=ANY($1::int[])
      GROUP BY sml_promotion_backlog_detail_id`,
    [detailIds],
  );
  const reservedByDetail = new Map(reservedResult.rows.map((row) => [
    Number(row.detail_id),
    roundQty(row.reserved_qty),
  ]));

  const ratio = lineRatio(lots[0]);
  const stockMap = await loadAvailableBaseStock(client.query.bind(client), [lots[0]], cartKey);
  const stock = stockMap.get(itemCode) || { availableBaseQty: 0 };
  const currentCartResult = await client.query(
    `SELECT COALESCE(SUM(
              COALESCE(c.qty,0)::numeric
              * COALESCE(NULLIF(c.ratio::numeric,0), NULLIF(u.ratio::numeric,0),
                COALESCE(u.stand_value::numeric,1) / NULLIF(COALESCE(u.divide_value::numeric,1),0), 1)
            ),0)::numeric AS reserved_qty
       FROM staff_cart_order c
       LEFT JOIN ic_unit_use u ON u.ic_code=c.item_code AND u.code=c.unit_code
      WHERE c.cust_code=$1 AND c.item_code=$2`,
    [cartKey, itemCode],
  );
  let availableBaseQty = Math.max(0, toNumber(stock.availableBaseQty) - toNumber(currentCartResult.rows[0]?.reserved_qty));
  const allocations = [];

  for (const lot of lots) {
    if (requestedQty <= EPSILON || availableBaseQty <= EPSILON) break;
    const lotRatio = lineRatio(lot);
    const alreadyReserved = toNumber(reservedByDetail.get(Number(lot.detail_id)));
    const availableLotQty = Math.max(0, roundQty(toNumber(lot.pending_qty) - alreadyReserved));
    const availableStockQty = Math.max(0, roundQty(availableBaseQty / lotRatio));
    const qty = Math.min(requestedQty, availableLotQty, availableStockQty);
    if (qty <= EPSILON) continue;

    const pricingContext = typeof lot.pricing_context === 'object' && lot.pricing_context
      ? lot.pricing_context
      : {};
    const quote = await quoteItemAtOriginalQty(lot, {
      custCode: safeText(pricingContext.customer_code) || custCode,
      saleType: toNumber(pricingContext.sale_type),
      vatType: toNumber(pricingContext.vat_type),
      vatRate: pricingContext.vat_rate,
      fullQty: lot.full_price_qty,
    });
    const existing = await client.query(
      `SELECT guid_code,qty
         FROM staff_cart_order
        WHERE cust_code=$1 AND sml_promotion_backlog_detail_id=$2
        FOR UPDATE`,
      [cartKey, Number(lot.detail_id)],
    );
    if (existing.rows[0]) {
      await client.query(
        `UPDATE staff_cart_order
            SET qty=COALESCE(qty,0)::numeric + $3::numeric,
                price=$4::numeric,
                remark=$5,
                sml_promotion_full_qty=$6::numeric,
                create_datetime=NOW()
          WHERE guid_code=$1 AND cust_code=$2`,
        [
          existing.rows[0].guid_code, cartKey, qty, quote.price,
          `สินค้าคงค้างโปรโมชั่น SML: ${safeText(lot.source_doc_no) || safeText(lot.origin_request_ref)}`,
          toNumber(lot.full_price_qty),
        ],
      );
    } else {
      await client.query(
        `INSERT INTO staff_cart_order
          (item_type,cust_code,guid_code,item_code,item_name,unit_code,barcode,qty,price,wh_code,shelf_code,creator_code,create_datetime,
           stand_value,divide_value,ratio,remark,sml_promotion_backlog_id,sml_promotion_backlog_detail_id,sml_promotion_full_qty)
         VALUES (0,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12,$13,$14,$15,$16,$17,$18)`,
        [
          cartKey, `SML-BACKLOG-${crypto.randomUUID()}`, lot.item_code, lot.item_name, lot.unit_code,
          lot.barcode || '', qty, quote.price, lot.wh_code || '', lot.shelf_code || '', options.creatorCode || '',
          toNumber(lot.stand_value, 1), toNumber(lot.divide_value, 1), lotRatio,
          `สินค้าคงค้างโปรโมชั่น SML: ${safeText(lot.source_doc_no) || safeText(lot.origin_request_ref)}`,
          Number(lot.backlog_id), Number(lot.detail_id), toNumber(lot.full_price_qty),
        ],
      );
    }
    allocations.push({
      backlog_id: Number(lot.backlog_id),
      detail_id: Number(lot.detail_id),
      source_doc_no: safeText(lot.source_doc_no),
      origin_request_ref: safeText(lot.origin_request_ref),
      qty: roundQty(qty),
      full_price_qty: toNumber(lot.full_price_qty),
    });
    requestedQty = roundQty(requestedQty - qty);
    availableBaseQty = Math.max(0, roundQty(availableBaseQty - (qty * lotRatio)));
  }

  return {
    allocations,
    added_qty: roundQty(allocations.reduce((sum, row) => sum + toNumber(row.qty), 0)),
    unfulfilled_qty: Math.max(0, requestedQty),
  };
}

module.exports = {
  safeText,
  toNumber,
  roundQty,
  roundMoney,
  lineRatio,
  calculateLineAmount,
  quoteItemAtOriginalQty,
  getSmlPromotionBacklogCartPricing,
  loadAvailableBaseStock,
  isSmlPromotionCatalogItem,
  ensureSmlPromotionBacklogSchema,
  buildSmlPromotionFulfillment,
  createSmlPromotionBacklogs,
  refreshSmlPromotionBacklogItems,
  applySmlPromotionBacklogDeliveries,
  listSmlPromotionBacklogLots,
  listSmlPromotionBacklogs,
  getSmlPromotionBacklogSummary,
  listGroupedSmlPromotionBacklogs,
  addSmlPromotionBacklogToCart,
};

const { query } = require('../db');
const { getProductPriceLocalx } = require('./priceHelper');

function safeText(value) {
  return String(value ?? '').trim();
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function normalizeDate(value) {
  const text = safeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

async function ensureSalePremiumSchema(queryFn = query) {
  await queryFn(`
    CREATE TABLE IF NOT EXISTS sml_sale_premium (
      roworder SERIAL PRIMARY KEY,
      premium_code VARCHAR(25) NOT NULL,
      name_1 VARCHAR(255) NOT NULL,
      date_begin DATE,
      date_end DATE,
      important SMALLINT DEFAULT 0,
      remark VARCHAR(255) DEFAULT '',
      guid_code VARCHAR(50) DEFAULT '',
      creator_code VARCHAR(25) DEFAULT '',
      create_date_time_now TIMESTAMP DEFAULT NOW()
    )
  `);
  await queryFn(`CREATE UNIQUE INDEX IF NOT EXISTS sml_sale_premium_code_uq ON sml_sale_premium (premium_code)`);
  await queryFn(`
    CREATE TABLE IF NOT EXISTS sml_sale_premium_condition (
      roworder SERIAL PRIMARY KEY,
      premium_code VARCHAR(25) NOT NULL,
      ic_code VARCHAR(25) NOT NULL,
      unit_code VARCHAR(25) NOT NULL,
      qty NUMERIC(18,4) DEFAULT 0,
      stand_value NUMERIC(18,4) DEFAULT 1,
      divide_value NUMERIC(18,4) DEFAULT 1
    )
  `);
  await queryFn(`CREATE INDEX IF NOT EXISTS sml_sale_premium_condition_code_idx ON sml_sale_premium_condition (premium_code)`);
  await queryFn(`
    CREATE TABLE IF NOT EXISTS sml_sale_premium_free_list (
      roworder SERIAL PRIMARY KEY,
      premium_code VARCHAR(25) NOT NULL,
      ic_code VARCHAR(25) NOT NULL,
      unit_code VARCHAR(25) NOT NULL,
      qty NUMERIC(18,4) DEFAULT 0,
      stand_value NUMERIC(18,4) DEFAULT 1,
      divide_value NUMERIC(18,4) DEFAULT 1
    )
  `);
  await queryFn(`CREATE INDEX IF NOT EXISTS sml_sale_premium_free_list_code_idx ON sml_sale_premium_free_list (premium_code)`);
}

async function resolveBasketPricingContext(queryFn, custCode) {
  const code = safeText(custCode);
  if (!code) return { saleType: 0, vatType: 0, vatRate: null };
  try {
    const rs = await queryFn(
      `SELECT COALESCE(inquiry_type,0) AS sale_type,
              COALESCE(vat_type,0) AS vat_type,
              COALESCE(vat_rate,0) AS vat_rate
         FROM pos_basket
        WHERE cust_code=$1
        ORDER BY basket_id DESC
        LIMIT 1`,
      [code],
    );
    const row = rs.rows[0];
    if (row) {
      return {
        saleType: parseInt(row.sale_type, 10) || 0,
        vatType: parseInt(row.vat_type, 10) || 0,
        vatRate: parseFloat(row.vat_rate),
      };
    }
  } catch (_) {}
  return { saleType: 0, vatType: 0, vatRate: null };
}

async function getItemUnitInfo(queryFn, itemCode, unitCode) {
  const result = await queryFn(
    `WITH balance_stock AS (
       SELECT ic_code, SUM(balance_qty) AS sum_balance_qty
         FROM sml_ic_function_stock_balance_warehouse_location('NOW()', $1, '', '')
        WHERE balance_qty > 0
        GROUP BY ic_code
     )
     SELECT i.code AS item_code,
            COALESCE(i.name_1, i.code) AS item_name,
            COALESCE(i.item_type,0) AS item_type,
            COALESCE(i.tax_type,0) AS tax_type,
            COALESCE(d.start_sale_wh,'') AS wh_code,
            COALESCE(d.start_sale_shelf,'') AS shelf_code,
            u.code AS unit_code,
            COALESCE(u.stand_value,1) AS stand_value,
            COALESCE(u.divide_value,1) AS divide_value,
            COALESCE(NULLIF(u.ratio,0),1) AS ratio,
            COALESCE((SELECT barcode FROM ic_inventory_barcode b WHERE b.ic_code=i.code AND b.unit_code=u.code LIMIT 1),'') AS barcode,
            COALESCE((SELECT sum_balance_qty FROM balance_stock WHERE ic_code=i.code LIMIT 1),0) AS sum_balance_qty
       FROM ic_inventory i
       JOIN ic_unit_use u ON u.ic_code=i.code
      LEFT JOIN ic_inventory_detail d ON d.ic_code=i.code
      WHERE i.code=$1 AND u.code=$2
      LIMIT 1`,
    [itemCode, unitCode],
  );
  const row = result.rows[0];
  if (!row) return null;
  const ratio = Math.max(1, toNumber(row.ratio, 1));
  return {
    item_code: row.item_code,
    item_name: row.item_name,
    item_type: String(row.item_type ?? '0'),
    tax_type: Number(row.tax_type ?? 0),
    unit_code: row.unit_code,
    wh_code: row.wh_code || '',
    shelf_code: row.shelf_code || '',
    stand_value: toNumber(row.stand_value, 1),
    divide_value: toNumber(row.divide_value, 1),
    ratio,
    barcode: row.barcode || '',
    sum_balance_qty: toNumber(row.sum_balance_qty),
    balance_qty: Math.floor(toNumber(row.sum_balance_qty) / ratio),
  };
}

async function pricedItem(row, custCode, qty, priceContext = {}) {
  const priceRes = await getProductPriceLocalx(
    row.item_code,
    row.unit_code,
    String(qty || 1),
    custCode,
    priceContext.vatType ?? 0,
    priceContext.vatRate ?? null,
    priceContext.saleType ?? 0,
    row.barcode || '',
    priceContext.docDate || undefined,
  );
  const priceRow = (priceRes.data || [])[0] || {};
  const price = roundMoney(priceRow.price ?? 0);
  const discount = safeText(priceRow.defaultDiscount ?? priceRow.default_discount ?? '');
  return { ...row, price, discount };
}

async function loadSalePremiumDetail(queryFn, premiumCode, options = {}) {
  await ensureSalePremiumSchema(queryFn);
  const code = safeText(premiumCode);
  if (!code) throw new Error('premium_code is required');

  const docDate = normalizeDate(options.docDate) || new Date().toISOString().slice(0, 10);
  const headerRes = await queryFn(
    `SELECT premium_code, name_1, date_begin::text AS date_begin, date_end::text AS date_end,
            COALESCE(important,0) AS important, COALESCE(remark,'') AS remark
       FROM sml_sale_premium
      WHERE premium_code=$1
        AND COALESCE(important,0)=0
        AND (date_begin IS NULL OR date_begin <= $2::date)
        AND (date_end IS NULL OR date_end >= $2::date)
      LIMIT 1`,
    [code, docDate],
  );
  const header = headerRes.rows[0];
  if (!header) throw new Error(`premium not found or inactive: ${code}`);

  const [condRes, freeRes] = await Promise.all([
    queryFn(
      `SELECT premium_code, ic_code, unit_code, qty, stand_value, divide_value, roworder AS line_number
         FROM sml_sale_premium_condition
        WHERE premium_code=$1
        ORDER BY roworder, ic_code`,
      [code],
    ),
    queryFn(
      `SELECT premium_code, ic_code, unit_code, qty, stand_value, divide_value, roworder AS line_number
         FROM sml_sale_premium_free_list
        WHERE premium_code=$1
        ORDER BY roworder, ic_code`,
      [code],
    ),
  ]);
  if (!condRes.rows.length) throw new Error(`premium condition is empty: ${code}`);
  if (!freeRes.rows.length) throw new Error(`premium free list is empty: ${code}`);

  const pricingContext = {
    saleType: options.saleType,
    vatType: options.vatType,
    vatRate: options.vatRate,
    docDate,
  };
  const custCode = safeText(options.custCode);

  const paidItems = [];
  for (const row of condRes.rows) {
    const unit = await getItemUnitInfo(queryFn, safeText(row.ic_code), safeText(row.unit_code));
    if (!unit) throw new Error(`product unit not found: ${row.ic_code}/${row.unit_code}`);
    const qty = toNumber(row.qty);
    const priced = await pricedItem(unit, custCode, qty, pricingContext);
    paidItems.push({
      ...priced,
      qty,
      sum_amount: roundMoney(priced.price * qty),
      is_permium: 0,
      line_number: row.line_number,
    });
  }

  const freeItems = [];
  for (const row of freeRes.rows) {
    const unit = await getItemUnitInfo(queryFn, safeText(row.ic_code), safeText(row.unit_code));
    if (!unit) throw new Error(`free product unit not found: ${row.ic_code}/${row.unit_code}`);
    freeItems.push({
      ...unit,
      qty: toNumber(row.qty),
      price: 0,
      discount: '',
      sum_amount: 0,
      is_permium: 1,
      line_number: row.line_number,
    });
  }

  const packPrice = roundMoney(paidItems.reduce((sum, item) => sum + toNumber(item.sum_amount), 0));
  const availablePackQty = paidItems.reduce((min, item) => {
    const needed = Math.max(1, toNumber(item.qty, 1));
    return Math.min(min, Math.floor(toNumber(item.balance_qty) / needed));
  }, Number.POSITIVE_INFINITY);
  const firstPaid = paidItems[0];

  return {
    premium_code: header.premium_code,
    premium_name: header.name_1,
    name_1: header.name_1,
    remark: header.remark || '',
    item_code: header.premium_code,
    item_name: header.name_1,
    unit_code: firstPaid.unit_code,
    unit_name: firstPaid.unit_code,
    item_type: '4',
    tax_type: firstPaid.tax_type,
    price: packPrice,
    stock_qty: Number.isFinite(availablePackQty) ? availablePackQty : 0,
    balance_qty: Number.isFinite(availablePackQty) ? availablePackQty : 0,
    sum_balance_qty: firstPaid.sum_balance_qty,
    sold_out: Number.isFinite(availablePackQty) && availablePackQty > 0 ? '0' : '1',
    wh_code: firstPaid.wh_code || '',
    shelf_code: firstPaid.shelf_code || '',
    stand_value: 1,
    divide_value: 1,
    ratio: 1,
    barcode: '',
    is_sale_premium: 1,
    sale_premium_code: header.premium_code,
    sale_premium_name: header.name_1,
    paid_items: paidItems,
    free_items: freeItems,
  };
}

async function listSalePremiumProductsForSale(queryFn = query, options = {}) {
  await ensureSalePremiumSchema(queryFn);
  const docDate = normalizeDate(options.docDate) || new Date().toISOString().slice(0, 10);
  const search = safeText(options.search);
  const includeOutOfStock = String(options.isStock || '') !== '1';
  const offset = Math.max(0, parseInt(options.offset, 10) || 0);
  const limit = Math.max(1, Math.min(100, parseInt(options.limit, 10) || 20));

  const params = [docDate];
  let where = `COALESCE(p.important,0)=0
    AND (p.date_begin IS NULL OR p.date_begin <= $1::date)
    AND (p.date_end IS NULL OR p.date_end >= $1::date)`;
  if (search) {
    params.push(`%${search}%`);
    const searchParam = params.length;
    where += ` AND (` +
      `p.premium_code ILIKE $${searchParam} OR p.name_1 ILIKE $${searchParam}` +
      ` OR EXISTS (` +
        `SELECT 1 FROM sml_sale_premium_condition cc` +
        ` LEFT JOIN ic_inventory ci ON ci.code=cc.ic_code` +
        ` WHERE cc.premium_code=p.premium_code` +
        ` AND (cc.ic_code ILIKE $${searchParam} OR ci.name_1 ILIKE $${searchParam})` +
      `)` +
      ` OR EXISTS (` +
        `SELECT 1 FROM sml_sale_premium_free_list ff` +
        ` LEFT JOIN ic_inventory fi ON fi.code=ff.ic_code` +
        ` WHERE ff.premium_code=p.premium_code` +
        ` AND (ff.ic_code ILIKE $${searchParam} OR fi.name_1 ILIKE $${searchParam})` +
      `)` +
    `)`;
  }

  const rowsRes = await queryFn(
    `SELECT p.premium_code, p.name_1, c.ic_code, c.unit_code, c.qty,
            COALESCE(i.name_1,'') AS condition_item_name
       FROM sml_sale_premium p
       JOIN LATERAL (
         SELECT *
           FROM sml_sale_premium_condition c
          WHERE c.premium_code=p.premium_code
          ORDER BY c.roworder
          LIMIT 1
       ) c ON TRUE
       LEFT JOIN ic_inventory i ON i.code=c.ic_code
      WHERE ${where}
      ORDER BY p.premium_code
      OFFSET ${offset} LIMIT ${limit}`,
    params,
  );

  const pricingContext = {
    saleType: options.saleType,
    vatType: options.vatType,
    vatRate: options.vatRate,
    docDate,
  };
  const result = [];
  for (const row of rowsRes.rows) {
    try {
      const detail = await loadSalePremiumDetail(queryFn, row.premium_code, {
        custCode: options.custCode,
        saleType: pricingContext.saleType,
        vatType: pricingContext.vatType,
        vatRate: pricingContext.vatRate,
        docDate,
      });
      if (!includeOutOfStock && String(detail.sold_out) === '1') continue;
      result.push({
        item_code: detail.premium_code,
        item_name: detail.premium_name,
        item_type: '4',
        stock_qty: detail.stock_qty,
        sold_out: detail.sold_out,
        unit_standard: detail.unit_code,
        unit_cost: detail.unit_code,
        start_sale_unit: detail.unit_code,
        is_promotion: '1',
        favorite_item: 0,
        is_return: '0',
        price: detail.price,
        is_sale_premium: 1,
        sale_premium_code: detail.premium_code,
        sale_premium_name: detail.premium_name,
        condition_item_code: row.ic_code,
        condition_item_name: row.condition_item_name,
        condition_qty: toNumber(row.qty),
        condition_unit_code: row.unit_code,
      });
    } catch (ex) {
      console.warn(`skip sale premium ${row.premium_code}: ${ex.message}`);
    }
  }
  return result;
}

async function expandSalePremiumItemForSave(queryFn, item, options = {}) {
  const code = safeText(item.sale_premium_code || item.premium_code || item.item_code);
  const packQty = toNumber(item.qty, 1);
  const detail = await loadSalePremiumDetail(queryFn, code, options);
  const fallbackWhCode = safeText(item.wh_code);
  const fallbackShelfCode = safeText(item.shelf_code);
  const rows = [];
  for (const paid of detail.paid_items) {
    rows.push({
      ...paid,
      wh_code: safeText(paid.wh_code) || fallbackWhCode,
      shelf_code: safeText(paid.shelf_code) || fallbackShelfCode,
      qty: roundMoney(toNumber(paid.qty) * packQty),
      price: paid.price,
      sum_amount: roundMoney(toNumber(paid.price) * toNumber(paid.qty) * packQty),
      discount: '',
      discount_amount: 0,
      is_permium: 0,
      sale_premium_code: code,
    });
  }
  for (const free of detail.free_items) {
    rows.push({
      ...free,
      wh_code: safeText(free.wh_code) || fallbackWhCode,
      shelf_code: safeText(free.shelf_code) || fallbackShelfCode,
      qty: roundMoney(toNumber(free.qty) * packQty),
      price: 0,
      sum_amount: 0,
      discount: '',
      discount_amount: 0,
      is_permium: 1,
      sale_premium_code: code,
    });
  }
  return rows;
}

module.exports = {
  safeText,
  toNumber,
  normalizeDate,
  ensureSalePremiumSchema,
  resolveBasketPricingContext,
  loadSalePremiumDetail,
  listSalePremiumProductsForSale,
  expandSalePremiumItemForSave,
};

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { assertBasketAccessFromCartKey } = require('../utils/basketAccess');
const { getEmployeePermissions } = require('../utils/permissions');
const { quoteClaim, capClaimQuotes, money, cartClaims } = require('../utils/saleClaim');
const { getProductPriceLocalx } = require('../utils/priceHelper');
const { calcAfterDiscount } = require('./purchase');

const str = (value) => String(value || '').trim();
const errorResponse = (res, ex) => res.status(ex.statusCode || 400).json({ success: false, msg: ex.message });

async function canManage(queryFn, userCode) {
  if (!userCode) return false;
  const permissions = await getEmployeePermissions(queryFn, userCode);
  return permissions.includes('product.main.edit');
}

router.get('/claim/product', async (req, res) => {
  try {
    const result = await query(`SELECT c.can_claim,c.is_claim_item,
      COALESCE((SELECT json_agg(json_build_object('unit_code',p.unit_code,'claim_price',p.claim_price) ORDER BY p.unit_code)
        FROM sml_staff_claim_unit_price p WHERE p.item_code=c.item_code),'[]'::json) AS prices
      FROM sml_staff_claim_item c WHERE c.item_code=$1`, [str(req.query.item_code)]);
    res.json({ success: true, data: result.rows[0] || { can_claim: false, is_claim_item: false, prices: [] } });
  } catch (ex) { errorResponse(res, ex); }
});

router.post('/claim/product', async (req, res) => {
  try {
    const { item_code, can_claim, is_claim_item, user_code, prices } = req.body || {};
    if (!(await canManage(query, str(user_code)))) return res.status(403).json({ success: false, msg: 'permission denied' });
    const exists = await query('SELECT 1 FROM ic_inventory WHERE code=$1', [str(item_code)]);
    if (!exists.rows.length) throw new Error('item not found');
    if (!Array.isArray(prices)) throw new Error('claim prices are required');
    const seen = new Set();
    for (const row of prices) {
      const unit = str(row?.unit_code);
      const price = Number(row?.claim_price);
      if (!unit || seen.has(unit) || row?.claim_price === null || row?.claim_price === ''
        || !Number.isFinite(price) || price < 0 || Math.round(price * 10000) / 10000 !== price) {
        throw new Error('invalid claim price or unit');
      }
      seen.add(unit);
    }
    await withTransaction(async (client) => {
      const units = await client.query('SELECT code FROM ic_unit_use WHERE ic_code=$1', [str(item_code)]);
      const validUnits = new Set(units.rows.map((row) => row.code));
      if (prices.some((row) => !validUnits.has(str(row.unit_code)))) throw new Error('claim price unit is not in item master');
      await client.query(`INSERT INTO sml_staff_claim_item (item_code,can_claim,is_claim_item,updated_by)
        VALUES ($1,$2,$3,$4) ON CONFLICT (item_code) DO UPDATE SET can_claim=$2,is_claim_item=$3,updated_by=$4,updated_at=NOW()`,
        [str(item_code), can_claim === true, is_claim_item === true, str(user_code)]);
      await client.query('DELETE FROM sml_staff_claim_unit_price WHERE item_code=$1', [str(item_code)]);
      for (const row of prices) {
        await client.query(`INSERT INTO sml_staff_claim_unit_price (item_code,unit_code,claim_price,updated_by)
          VALUES ($1,$2,$3,$4)`, [str(item_code), str(row.unit_code), Number(row.claim_price), str(user_code)]);
      }
    });
    res.json({ success: true });
  } catch (ex) { errorResponse(res, ex); }
});

router.get('/claim/branch', async (req, res) => {
  try {
    const result = await query(`SELECT * FROM sml_staff_claim_branch
      WHERE branch_code IN ('','0000')
      ORDER BY CASE WHEN branch_code='' THEN 0 ELSE 1 END LIMIT 1`);
    res.json({ success: true, data: result.rows[0] || null });
  } catch (ex) { errorResponse(res, ex); }
});

router.post('/claim/branch', async (req, res) => {
  try {
    const { wh_code, shelf_code, pu_doc_format_code, user_code } = req.body || {};
    if (!(await canManage(query, str(user_code)))) return res.status(403).json({ success: false, msg: 'permission denied' });
    if (!str(wh_code) || !str(shelf_code) || !str(pu_doc_format_code)) throw new Error('warehouse, shelf and PU format are required');
    const checks = await Promise.all([
      query('SELECT 1 FROM ic_warehouse WHERE code=$1', [str(wh_code)]),
      query('SELECT 1 FROM ic_shelf WHERE whcode=$1 AND code=$2', [str(wh_code), str(shelf_code)]),
      query("SELECT 1 FROM erp_doc_format WHERE screen_code='PU' AND code=$1", [str(pu_doc_format_code)]),
    ]);
    if (checks.some((row) => !row.rows.length)) throw new Error('invalid warehouse, shelf or PU format');
    await query(`INSERT INTO sml_staff_claim_branch (branch_code,wh_code,shelf_code,pu_doc_format_code,updated_by)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (branch_code) DO UPDATE SET wh_code=$2,shelf_code=$3,pu_doc_format_code=$4,updated_by=$5,updated_at=NOW()`,
      ['', str(wh_code), str(shelf_code), str(pu_doc_format_code), str(user_code)]);
    res.json({ success: true });
  } catch (ex) { errorResponse(res, ex); }
});

router.get('/claim/items', async (req, res) => {
  try {
    const search = `%${str(req.query.search)}%`;
    const result = await query(`SELECT i.code AS item_code,i.name_1 AS item_name,u.code AS unit_code
      FROM sml_staff_claim_item c JOIN ic_inventory i ON i.code=c.item_code
      JOIN ic_unit_use u ON u.ic_code=i.code
      WHERE c.is_claim_item=TRUE AND (i.code ILIKE $1 OR i.name_1 ILIKE $1)
      ORDER BY i.code,u.code LIMIT 50`, [search]);
    res.json({ success: true, data: result.rows });
  } catch (ex) { errorResponse(res, ex); }
});

router.post('/claim/quote', async (req, res) => {
  try {
    const input = req.body || {};
    const rows = Array.isArray(input.items) ? input.items : [];
    if (rows.length > 30) throw new Error('too many claim items');
    let quotes = [];
    for (const row of rows) quotes.push(await quoteClaim(query, { ...row, item_code: row.item_code, unit_code: row.unit_code, qty: row.qty }));
    if (input.max_amount !== undefined) {
      const maximum = Number(input.max_amount);
      if (!Number.isFinite(maximum) || maximum < 0) throw new Error('invalid maximum claim amount');
      quotes = capClaimQuotes(quotes, maximum);
    }
    res.json({ success: true, data: { items: quotes, total: money(quotes.reduce((sum, row) => sum + row.amount, 0)) } });
  } catch (ex) { errorResponse(res, ex); }
});

router.get('/claim/cart', async (req, res) => {
  try {
    const cartKey = str(req.query.cart_key);
    await assertBasketAccessFromCartKey(query, str(req.query.user_code), cartKey, 'can_enter');
    res.json({ success: true, data: await cartClaims(query, cartKey, str(req.query.sale_guid)) });
  } catch (ex) { errorResponse(res, ex); }
});

router.post('/claim/cart', async (req, res) => {
  try {
    const body = req.body || {};
    const cartKey = str(body.cart_key);
    const saleGuid = str(body.sale_guid);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!saleGuid || !cartKey || items.length > 30) throw new Error('invalid cart claim');
    await withTransaction(async (client) => {
      await assertBasketAccessFromCartKey(client.query.bind(client), str(body.user_code), cartKey, 'can_edit_items');
      const sale = await client.query('SELECT item_code,unit_code,qty,price,barcode FROM staff_cart_order WHERE cust_code=$1 AND guid_code=$2 FOR UPDATE', [cartKey, saleGuid]);
      if (sale.rows.length !== 1) throw new Error('sale cart item not found');
      const eligible = await client.query('SELECT can_claim FROM sml_staff_claim_item WHERE item_code=$1', [sale.rows[0].item_code]);
      if (!eligible.rows[0]?.can_claim) throw new Error('sale item does not accept claims');
      const saleRow = sale.rows[0];
      const salePriceResult = await getProductPriceLocalx(saleRow.item_code, saleRow.unit_code,
        String(saleRow.qty), str(body.cust_code), Number(body.vat_type ?? 1),
        Number(body.vat_rate ?? 7), Number(body.sale_type ?? 1), saleRow.barcode || '');
      const salePrice = salePriceResult.data?.[0];
      if (!salePrice || !Number.isFinite(Number(salePrice.price))) throw new Error('sale price unavailable for claim cap');
      const saleNet = Math.max(0, money(calcAfterDiscount(
        str(salePrice.defaultDiscount ?? salePrice.default_discount),
        money(Number(salePrice.price) * Number(saleRow.qty)), 2, Number(saleRow.qty))));
      const rawQuotes = [];
      for (const row of items) rawQuotes.push(await quoteClaim(client.query.bind(client), row));
      const quotes = capClaimQuotes(rawQuotes, saleNet);
      await client.query('DELETE FROM sml_staff_cart_claim WHERE cart_key=$1 AND sale_guid=$2', [cartKey, saleGuid]);
      for (let i = 0; i < quotes.length; i++) {
        const row = quotes[i];
        await client.query(`INSERT INTO sml_staff_cart_claim
          (cart_key,sale_guid,line_no,claim_item_code,unit_code,qty,quoted_unit_price,quoted_amount,configured_unit_price)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [cartKey, saleGuid, i, row.item_code, row.unit_code, row.qty, row.unit_price, row.amount, row.configured_unit_price]);
      }
    });
    res.json({ success: true });
  } catch (ex) { errorResponse(res, ex); }
});

module.exports = router;

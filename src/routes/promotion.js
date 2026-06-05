const express = require('express');
const router = express.Router();
const {
  loadPromotionOption,
  loadPromotionsFromDb,
  processPromotion,
} = require('../utils/promotionProcessor');
const { query } = require('../db');

function parseBody(req) {
  if (typeof req.body === 'string') {
    return JSON.parse(req.body);
  }
  return req.body || {};
}

function normalizedMemberCode(body) {
  const memberCode = String(body.member_code ?? body.memberCode ?? '');
  const posDefaultCust = String(body.pos_default_cust ?? body.posDefaultCust ?? '');
  return posDefaultCust.length > 0 && memberCode === posDefaultCust ? '' : memberCode;
}

function boolValue(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1') return true;
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'true' || text === 'yes';
}

function promotionHintDate(body) {
  const value = String(body.doc_date ?? body.docDate ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date().toISOString().slice(0, 10);
}

function normalizePromotionHintItem(item) {
  const qty = Number(item.qty ?? item._qty ?? 0) || 0;
  const price = Number(item.price ?? item._price ?? 0) || 0;
  return {
    item_code: String(item.item_code ?? item._itemCode ?? '').trim(),
    item_name: String(item.item_name ?? item._itemName ?? '').trim(),
    unit_code: String(item.unit_code ?? item._unitCode ?? '').trim(),
    qty,
    price,
    amount: Number(item.amount ?? item._amount ?? item.sum_amount ?? (qty * price)) || 0,
    price_type: Number(item.price_type ?? item._price_type ?? 1) || 1,
    discount_number: Number(item.discount_number ?? item._discountNumber ?? 0) || 0,
  };
}

function promotionHintKey(itemCode, unitCode) {
  return `${String(itemCode || '').trim()}|${String(unitCode || '').trim()}`;
}

function normalizePromotionHintItems(items) {
  const map = new Map();
  for (const raw of items || []) {
    const item = normalizePromotionHintItem(raw || {});
    if (!item.item_code) continue;
    const key = promotionHintKey(item.item_code, item.unit_code);
    if (!map.has(key)) map.set(key, item);
  }
  return Array.from(map.values());
}

function buildCartQtyMaps(items) {
  const exact = new Map();
  const byItem = new Map();
  for (const raw of items || []) {
    const item = normalizePromotionHintItem(raw || {});
    if (!item.item_code) continue;
    const qty = Number(item.qty || 0);
    const exactKey = promotionHintKey(item.item_code, item.unit_code);
    exact.set(exactKey, (exact.get(exactKey) || 0) + qty);
    byItem.set(item.item_code, (byItem.get(item.item_code) || 0) + qty);
  }
  return { exact, byItem };
}

function promotionActionProduct(command) {
  const text = String(command?.Command ?? command?.command ?? '').trim();
  const value = text.startsWith('=') ? text.slice(1).trim() : text;
  if (!value.includes(',')) return null;
  const [itemCode, unitCode] = value.split(',').map((part) => String(part || '').trim());
  if (!itemCode) return null;
  return {
    item_code: itemCode,
    unit_code: unitCode || '',
    qty: Number(command?.Qty ?? command?.qty ?? 0) || 0,
  };
}

async function loadPromotionItemNames(promotions) {
  const codes = new Set();
  for (const promotion of promotions || []) {
    for (const condition of promotion.Conditions || []) {
      const code = String(condition.ItemCode || '').trim();
      if (code) codes.add(code);
    }
    for (const action of promotion.Actions || []) {
      const product = promotionActionProduct(action);
      if (product?.item_code) codes.add(product.item_code);
    }
  }
  if (!codes.size) return new Map();

  const result = await query(
    `SELECT code, COALESCE(name_1, '') AS item_name
     FROM ic_inventory
     WHERE code = ANY($1::text[])`,
    [Array.from(codes)],
  );
  return new Map(result.rows.map((row) => [String(row.code), String(row.item_name || '')]));
}

function buildPromotionDetails(promotions, appliedCodes, itemNameByCode, cartQtyMaps, promotionFixedUnitCode) {
  const details = new Map();
  for (const promotion of promotions || []) {
    const promotionCode = String(promotion.PromotionCode || '').trim();
    if (!promotionCode) continue;
    const isApplied = appliedCodes.has(promotionCode);

    const conditionItems = (promotion.Conditions || [])
      .filter((condition) => String(condition.ItemCode || '').trim())
      .map((condition) => {
        const itemCode = String(condition.ItemCode || '').trim();
        const unitCode = String(condition.UnitCode || '').trim();
        const exactQty = cartQtyMaps.exact.get(promotionHintKey(itemCode, unitCode)) || 0;
        const itemQty = cartQtyMaps.byItem.get(itemCode) || 0;
        const cartQty = promotionFixedUnitCode ? exactQty : itemQty;
        return {
          item_code: itemCode,
          item_name: itemNameByCode.get(itemCode) || '',
          unit_code: unitCode,
          group_number: Number(condition.GroupNumber || 0),
          required_qty: Number(condition.Qty || 0),
          cart_qty: cartQty,
          is_in_cart: cartQty > 0,
        };
      });

    const actionItems = (promotion.Actions || [])
      .map((action) => promotionActionProduct(action))
      .filter(Boolean)
      .map((item) => ({
        ...item,
        item_name: itemNameByCode.get(item.item_code) || '',
      }));

    details.set(promotionCode, {
      is_applied: isApplied,
      condition_items: conditionItems,
      action_items: actionItems,
    });
  }
  return details;
}

function mapPromotionHintRows(items, rows, promotionDetails = new Map()) {
  const byItem = new Map();
  for (const item of items) {
    byItem.set(promotionHintKey(item.item_code, item.unit_code), {
      item_code: item.item_code,
      unit_code: item.unit_code,
      has_promotion: false,
      promotion_count: 0,
      promotions: [],
    });
  }

  const seen = new Set();
  for (const row of rows || []) {
    const key = promotionHintKey(row.item_code, row.unit_code);
    const target = byItem.get(key);
    if (!target) continue;
    const promotionCode = String(row.promotion_code || '').trim();
    if (!promotionCode) continue;
    const promotionKey = `${key}|${promotionCode}`;
    if (seen.has(promotionKey)) continue;
    seen.add(promotionKey);
    const details = promotionDetails.get(promotionCode) || {};
    target.promotions.push({
      promotion_code: promotionCode,
      promotion_name: String(row.promotion_name || ''),
      is_applied: details.is_applied === true,
      condition_items: details.condition_items || [],
      action_items: details.action_items || [],
    });
  }

  for (const item of byItem.values()) {
    item.promotion_count = item.promotions.length;
    item.has_promotion = item.promotion_count > 0;
  }

  return Array.from(byItem.values());
}

function buildPromotionProductRows(results) {
  return results.map((result) => {
    const qty = Number(result._qty || 0);
    const amount = Number(result._amount || 0);
    const price = qty === 0 ? 0 : amount / qty;
    return {
      barcode: '',
      item_code: '',
      promotion_code: result._promotionCode,
      item_name: result._promotionName,
      item_type: 0,
      stand_value: 0,
      divide_value: 0,
      unit_code: '',
      qty_last: qty,
      qty,
      tax_type: 0,
      vat_rate: 0,
      price,
      have_point: false,
      discount_word: '',
      discount: 0,
      price_info: '',
      discount_number: 0,
      is_change_discount: 0,
      is_change_price: 0,
      price_default: 0,
      serial_number: '',
      is_promotion_product: true,
      amount: qty * price,
      no_discount_amount: Number(result._no_discount_amount || 0),
      no_point_amount: Number(result._noPointAmount || 0),
    };
  });
}

function normalizePromotionItem(item) {
  const qty = Number(item.qty ?? item._qty ?? 0);
  const price = Number(item.price ?? item._price ?? 0);
  return {
    item_code: String(item.item_code ?? item._itemCode ?? ''),
    item_name: String(item.item_name ?? item._itemName ?? ''),
    unit_code: String(item.unit_code ?? item._unitCode ?? ''),
    qty,
    price,
    amount: Number(item.amount ?? item._amount ?? (qty * price) ?? 0),
  };
}

function promotionConditionCodes(promotion) {
  const codes = new Set();
  for (const condition of promotion?.Conditions || []) {
    const code = String(condition.ItemCode || '').trim();
    if (code) codes.add(code);
  }
  return codes;
}

function attachRelatedItems(results, promotions, items) {
  return results.map((result) => {
    const promotionCode = String(result._promotionCode || '');
    const promotion = promotions.find((row) => String(row.PromotionCode || '') === promotionCode);
    const conditionCodes = promotionConditionCodes(promotion);
    const hasAllItemGroup = (promotion?.GroupConditions || []).some((row) => Number(row.GroupNumber) === 9999);
    let relatedItems = [];

    if (conditionCodes.size > 0) {
      relatedItems = items.filter((item) => conditionCodes.has(String(item.item_code ?? item._itemCode ?? '').trim()));
    } else if (hasAllItemGroup) {
      relatedItems = items;
    }

    if (relatedItems.length === 0 && result._itemCode) {
      relatedItems = items.filter((item) => String(item.item_code ?? item._itemCode ?? '') === String(result._itemCode));
    }

    return {
      ...result,
      _relatedItems: relatedItems.map(normalizePromotionItem),
    };
  });
}

// POST /service/v1/getPromotionItemHints
// Body: { pos_id, member_code, pos_default_cust, doc_date, items: [{ item_code, unit_code, price_type, discount_number }] }
router.post('/getPromotionItemHints', async (req, res) => {
  try {
    const body = parseBody(req);
    const items = normalizePromotionHintItems(Array.isArray(body.items) ? body.items : []);
    if (items.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const processItems = Array.isArray(body.items) ? body.items : [];
    const [promotionOption, promotions] = await Promise.all([
      loadPromotionOption(),
      loadPromotionsFromDb({ includeInactive: false }),
    ]);
    const docDate = promotionHintDate(body);
    const memberCode = normalizedMemberCode(body).trim();
    const posId = String(body.pos_id ?? body.posId ?? '').trim();
    const fixedUnitCode = body.promotion_fixed_unitcode !== undefined
      ? boolValue(body.promotion_fixed_unitcode)
      : promotionOption.promotionFixedUnitCode;

    const sql = `
      WITH input_items AS (
        SELECT DISTINCT
          TRIM(COALESCE(item_code, '')) AS item_code,
          TRIM(COALESCE(unit_code, '')) AS unit_code,
          COALESCE(price_type, 1) AS price_type,
          COALESCE(discount_number, 0) AS discount_number
        FROM jsonb_to_recordset($1::jsonb) AS x(
          item_code text,
          unit_code text,
          price_type numeric,
          discount_number numeric
        )
        WHERE TRIM(COALESCE(item_code, '')) <> ''
      )
      SELECT
        i.item_code,
        i.unit_code,
        f.code AS promotion_code,
        COALESCE(f.name_1, '') AS promotion_name
      FROM input_items i
      JOIN ic_promotion_formula_condition c
        ON COALESCE(c.condition_from, '') = i.item_code
      JOIN ic_promotion_formula f
        ON f.code = c.code
      WHERE COALESCE(f.status, 0) = 1
        AND (
          COALESCE(f.use_date_range, 0) <> 1
          OR (
            f.from_date IS NOT NULL
            AND f.to_date IS NOT NULL
            AND $2::date BETWEEN f.from_date::date AND f.to_date::date
          )
        )
        AND (
          COALESCE(f.lock_day, '') = ''
          OR POSITION(EXTRACT(DOW FROM $2::date)::int::text IN COALESCE(f.lock_day, '')) > 0
        )
        AND (
          COALESCE(f.member_condition, 0) = 0
          OR (COALESCE(f.member_condition, 0) = 1 AND $3::text <> '')
          OR (COALESCE(f.member_condition, 0) = 2 AND $3::text = '')
        )
        AND (
          COALESCE(f.lock_promotion, 0) = 0
          OR (
            $4::text <> ''
            AND POSITION(
              ',' || UPPER($4::text) || ','
              IN ',' || UPPER(REPLACE(COALESCE(f.lock_code_list, ''), ' ', '')) || ','
            ) > 0
          )
        )
        AND ($5::boolean = false OR COALESCE(c.condition_unit_code, '') = i.unit_code)
        AND (
          COALESCE(f.item_normal_price, 0) <> 1
          OR (
            CASE
              WHEN COALESCE(f.case_number, 0) = 1 THEN COALESCE(i.price_type, 1) IN (1, 5)
              ELSE COALESCE(i.price_type, 1) IN (1, 5, 7)
            END
            AND COALESCE(i.discount_number, 0) = 0
          )
        )
      ORDER BY i.item_code, i.unit_code, COALESCE(f.order_number, 0), COALESCE(f.roworder, 0), f.code
    `;

    const result = await query(sql, [
      JSON.stringify(items),
      docDate,
      memberCode,
      posId,
      fixedUnitCode,
    ]);

    const appliedResult = processPromotion({
      ...body,
      member_code: memberCode,
      items: processItems,
      promotions,
      promotion_fixed_unitcode: fixedUnitCode,
    });
    const appliedCodes = new Set(
      (appliedResult.promotion_result || [])
        .map((promotion) => String(promotion._promotionCode || promotion.promotion_code || '').trim())
        .filter(Boolean),
    );

    const candidateCodes = new Set(result.rows.map((row) => String(row.promotion_code || '').trim()).filter(Boolean));
    const candidatePromotions = promotions.filter((promotion) => candidateCodes.has(String(promotion.PromotionCode || '').trim()));
    const itemNameByCode = await loadPromotionItemNames(candidatePromotions);
    const promotionDetails = buildPromotionDetails(
      candidatePromotions,
      appliedCodes,
      itemNameByCode,
      buildCartQtyMaps(processItems),
      fixedUnitCode,
    );

    return res.json({
      success: true,
      data: mapPromotionHintRows(items, result.rows, promotionDetails),
    });
  } catch (ex) {
    return res.status(400).json({
      success: false,
      error_type: ex.constructor.name,
      message: ex.message,
      detail: ex.toString(),
    });
  }
});

// POST /service/v1/processPromotion
// Body: { cust_code/member_code, doc_date, items: [{ item_code, unit_code, qty, price, ... }] }
router.post('/processPromotion', async (req, res) => {
  try {
    const body = parseBody(req);
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ success: false, msg: 'items is required' });
    }

    const [promotionOption, promotions] = await Promise.all([
      loadPromotionOption(),
      loadPromotionsFromDb({ includeInactive: body.include_inactive === true || body.include_inactive === '1' }),
    ]);

    const result = processPromotion({
      ...body,
      member_code: normalizedMemberCode(body),
      items,
      promotions,
      promotion_fixed_unitcode: body.promotion_fixed_unitcode !== undefined
        ? body.promotion_fixed_unitcode
        : promotionOption.promotionFixedUnitCode,
    });

    const promotionResult = attachRelatedItems(result.promotion_result, promotions, items);

    return res.json({
      success: true,
      data: promotionResult,
      promotion_discount_amount: result.promotion_discount_amount,
      promotion_pass_amount: result.promotion_pass_amount,
      sale_item_result: result.sale_item_result,
      promotion_product_rows: buildPromotionProductRows(result.promotion_result),
    });
  } catch (ex) {
    return res.status(400).json({
      success: false,
      error_type: ex.constructor.name,
      message: ex.message,
      detail: ex.toString(),
    });
  }
});

module.exports = router;

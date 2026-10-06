const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { getEmployeePermissions } = require('../utils/permissions');
const { safeText } = require('../utils/salePremiumHelper');
const { assertBasketAccess } = require('../utils/basketAccess');
const {
  listSalePremiumBacklogs,
  getSalePremiumBacklogSummary,
  ensureSalePremiumBacklogSchema,
} = require('../utils/salePremiumBacklogHelper');
const {
  ensureSmlPromotionBacklogSchema,
  listSmlPromotionBacklogs,
  listGroupedSmlPromotionBacklogs,
  getSmlPromotionBacklogSummary,
  addSmlPromotionBacklogToCart,
  toNumber,
} = require('../utils/smlPromotionBacklogHelper');

const BACKLOG_VIEW_PERMISSION = 'sale.premium_backlog.view';
const SELL_VIEW_PERMISSION = 'sell.view';

async function employeeHasAnyPermission(queryFn, userCode, keys = []) {
  const code = safeText(userCode);
  if (!code) return true;
  const permissions = await getEmployeePermissions(queryFn, code);
  return keys.some((key) => permissions.includes(key));
}

function rowToResponse(row) {
  return {
    backlog_type: row.backlog_type || 'sale_premium',
    backlog_id: Number(row.backlog_id || 0),
    detail_id: Number(row.detail_id || 0),
    cust_code: row.cust_code || '',
    cust_name: row.cust_name || '',
    premium_code: row.premium_code || '',
    premium_name: row.premium_name || '',
    source_doc_no: row.source_doc_no || '',
    origin_request_ref: row.origin_request_ref || '',
    source_basket_id: row.source_basket_id || '',
    pack_qty: Number(row.pack_qty || 0),
    sale_code: row.sale_code || '',
    creator_code: row.creator_code || '',
    backlog_status: row.backlog_status || '',
    detail_status: row.detail_status || '',
    line_number: Number(row.line_number || 0),
    line_type: row.line_type || 'sale',
    item_code: row.item_code || '',
    item_name: row.item_name || '',
    unit_code: row.unit_code || '',
    barcode: row.barcode || '',
    wh_code: row.wh_code || '',
    shelf_code: row.shelf_code || '',
    stand_value: Number(row.stand_value || 1),
    divide_value: Number(row.divide_value || 1),
    ratio: Number(row.ratio || 1),
    tax_type: Number(row.tax_type || 0),
    target_qty: Number(row.target_qty || 0),
    delivered_qty: Number(row.delivered_qty || 0),
    pending_qty: Number(row.pending_qty || 0),
    unit_price: Number(row.unit_price || 0),
    full_price_qty: Number(row.full_price_qty || 0),
    detail_ids: Array.isArray(row.detail_ids) ? row.detail_ids.map((id) => Number(id || 0)).filter(Boolean) : [],
    lot_count: Number(row.lot_count || 0),
    source_doc_count: Number(row.source_doc_count || 0),
    source_doc_nos: Array.isArray(row.source_doc_nos) ? row.source_doc_nos : [],
    available_stock_qty: Number(row.available_stock_qty || 0),
    sum_amount: Number(row.sum_amount || 0),
    is_permium: Number(row.is_permium || 0),
    stock_qty: Number(row.stock_qty || 0),
    deliverable_qty: Number(row.deliverable_qty || 0),
    free_entitlement_qty: Number(row.free_entitlement_qty || 0),
    free_deliverable_qty_by_entitlement: Number(row.free_deliverable_qty_by_entitlement || 0),
    create_date_time_now: row.create_date_time_now,
    update_date_time_now: row.update_date_time_now,
  };
}

router.get('/sale-premium-backlog/list', async (req, res) => {
  try {
    const userCode = safeText(req.query.user_code || req.query.emp_code || req.get('x-user-code'));
    if (!(await employeeHasAnyPermission(query, userCode, [BACKLOG_VIEW_PERMISSION, SELL_VIEW_PERMISSION]))) {
      return res.status(403).json({ success: false, msg: `permission denied: ${BACKLOG_VIEW_PERMISSION}` });
    }
    const options = {
      custCode: req.query.cust_code,
      search: req.query.search,
      includeClosed: req.query.include_closed,
      limit: req.query.limit,
    };
    const [premiumRows, smlRows] = await Promise.all([
      listSalePremiumBacklogs(query, options),
      listSmlPromotionBacklogs(query, options),
    ]);
    return res.json({ success: true, data: [...premiumRows, ...smlRows].map(rowToResponse) });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/sml-promotion-backlog/customer', async (req, res) => {
  try {
    const custCode = safeText(req.query.cust_code);
    if (!custCode) return res.status(400).json({ success: false, msg: 'cust_code is required' });
    const userCode = safeText(req.query.user_code || req.query.emp_code || req.get('x-user-code'));
    if (!(await employeeHasAnyPermission(query, userCode, [SELL_VIEW_PERMISSION, BACKLOG_VIEW_PERMISSION]))) {
      return res.status(403).json({ success: false, msg: `permission denied: ${SELL_VIEW_PERMISSION}` });
    }
    const basketId = Number(req.query.basket_id || 0);
    const cartKey = basketId > 0 ? `BASKET-${basketId}` : '';
    if (basketId > 0) await assertBasketAccess(query, userCode, basketId, 'can_enter');
    const rows = await listGroupedSmlPromotionBacklogs(query, { custCode, excludeCartKey: cartKey });
    return res.json({ success: true, data: rows.map(rowToResponse) });
  } catch (ex) {
    return res.status(ex.statusCode || 500).json({ success: false, msg: ex.message });
  }
});

router.post('/sml-promotion-backlog/add-to-cart', async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const basketId = Number(body.basket_id || 0);
    const custCode = safeText(body.cust_code);
    const userCode = safeText(body.user_code || body.emp_code || req.get('x-user-code'));
    if (!basketId || !custCode) {
      return res.status(400).json({ success: false, msg: 'basket_id and cust_code are required' });
    }
    if (!(await employeeHasAnyPermission(query, userCode, [SELL_VIEW_PERMISSION, BACKLOG_VIEW_PERMISSION]))) {
      return res.status(403).json({ success: false, msg: `permission denied: ${SELL_VIEW_PERMISSION}` });
    }
    const data = await withTransaction(async (client) => {
      await assertBasketAccess(client.query.bind(client), userCode, basketId, 'can_edit_items');
      await ensureSmlPromotionBacklogSchema(client.query.bind(client));
      const basketResult = await client.query(
        `SELECT COALESCE(cust_code,'') AS cust_code
           FROM pos_basket
          WHERE basket_id=$1
          FOR UPDATE`,
        [basketId],
      );
      const basket = basketResult.rows[0];
      if (!basket) throw new Error('ไม่พบตะกร้าขาย');
      if (safeText(basket.cust_code) !== custCode) throw new Error('ลูกค้าในตะกร้าไม่ตรงกับสินค้าคงค้าง');
      return addSmlPromotionBacklogToCart(client, {
        custCode,
        cartKey: `BASKET-${basketId}`,
        itemCode: body.item_code,
        unitCode: body.unit_code,
        qty: toNumber(body.qty),
        creatorCode: userCode,
      });
    });
    return res.json({ success: true, data });
  } catch (ex) {
    return res.status(ex.statusCode || 400).json({ success: false, msg: ex.message });
  }
});

router.get('/sale-premium-backlog/customer', async (req, res) => {
  try {
    const custCode = safeText(req.query.cust_code);
    if (!custCode) return res.status(400).json({ success: false, msg: 'cust_code is required' });
    const userCode = safeText(req.query.user_code || req.query.emp_code || req.get('x-user-code'));
    if (!(await employeeHasAnyPermission(query, userCode, [SELL_VIEW_PERMISSION, BACKLOG_VIEW_PERMISSION]))) {
      return res.status(403).json({ success: false, msg: `permission denied: ${SELL_VIEW_PERMISSION}` });
    }
    const rows = await listSalePremiumBacklogs(query, { custCode, limit: req.query.limit || 200 });
    return res.json({ success: true, data: rows.map(rowToResponse) });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/sale-premium-backlog/summary', async (req, res) => {
  try {
    const userCode = safeText(req.query.user_code || req.query.emp_code || req.get('x-user-code'));
    if (!(await employeeHasAnyPermission(query, userCode, [BACKLOG_VIEW_PERMISSION, SELL_VIEW_PERMISSION]))) {
      return res.status(403).json({ success: false, msg: `permission denied: ${BACKLOG_VIEW_PERMISSION}` });
    }
    await ensureSmlPromotionBacklogSchema(query);
    const [premiumSummary, smlSummary, customerResult] = await Promise.all([
      getSalePremiumBacklogSummary(query),
      getSmlPromotionBacklogSummary(query),
      query(
        `SELECT COUNT(DISTINCT cust_code)::int AS customer_count
           FROM (
             SELECT h.cust_code
               FROM sml_sale_premium_backlog h
              WHERE h.status IN ('open','partial')
             UNION
             SELECT h.cust_code
               FROM sml_sml_promotion_backlog h
              WHERE h.status IN ('open','partial')
           ) customers`,
      ),
    ]);
    const recent = [...(premiumSummary.recent || []), ...(smlSummary.recent || [])]
      .sort((left, right) => new Date(right.update_date_time_now || right.create_date_time_now || 0) - new Date(left.update_date_time_now || left.create_date_time_now || 0))
      .slice(0, 8)
      .map(rowToResponse);
    return res.json({
      success: true,
      data: {
        customer_count: Number(customerResult.rows[0]?.customer_count || 0),
        backlog_count: Number(premiumSummary.backlog_count || 0) + Number(smlSummary.backlog_count || 0),
        line_count: Number(premiumSummary.line_count || 0) + Number(smlSummary.line_count || 0),
        pending_qty: Number(premiumSummary.pending_qty || 0) + Number(smlSummary.pending_qty || 0),
        pending_amount: Number(premiumSummary.pending_amount || 0),
        recent,
      },
    });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.post('/sale-premium-backlog/ensure-schema', async (req, res) => {
  try {
    const userCode = safeText(req.body?.user_code || req.query.user_code || req.get('x-user-code'));
    if (!(await employeeHasAnyPermission(query, userCode, [BACKLOG_VIEW_PERMISSION]))) {
      return res.status(403).json({ success: false, msg: `permission denied: ${BACKLOG_VIEW_PERMISSION}` });
    }
    await ensureSalePremiumBacklogSchema(query);
    return res.json({ success: true, msg: 'success' });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

module.exports = router;

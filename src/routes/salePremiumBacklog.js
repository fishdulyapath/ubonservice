const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { getEmployeePermissions } = require('../utils/permissions');
const { safeText } = require('../utils/salePremiumHelper');
const {
  listSalePremiumBacklogs,
  getSalePremiumBacklogSummary,
  ensureSalePremiumBacklogSchema,
} = require('../utils/salePremiumBacklogHelper');

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
    backlog_id: Number(row.backlog_id || 0),
    detail_id: Number(row.detail_id || 0),
    cust_code: row.cust_code || '',
    cust_name: row.cust_name || '',
    premium_code: row.premium_code || '',
    premium_name: row.premium_name || '',
    source_doc_no: row.source_doc_no || '',
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
    const rows = await listSalePremiumBacklogs(query, {
      custCode: req.query.cust_code,
      search: req.query.search,
      includeClosed: req.query.include_closed,
      limit: req.query.limit,
    });
    return res.json({ success: true, data: rows.map(rowToResponse) });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
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
    const summary = await getSalePremiumBacklogSummary(query);
    return res.json({ success: true, data: { ...summary, recent: (summary.recent || []).map(rowToResponse) } });
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

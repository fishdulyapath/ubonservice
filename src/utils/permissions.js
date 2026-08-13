const PERMISSIONS = [
  { key: 'permission.manage', label: 'à¸à¸³à¸«à¸™à¸”à¸ªà¸´à¸—à¸˜à¸´à¹Œà¸œà¸¹à¹‰à¹ƒà¸Šà¹‰' },
  { key: 'dashboard.sold_out_report', label: 'à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”: à¸”à¸¹à¸£à¸²à¸¢à¸‡à¸²à¸™à¸ªà¸´à¸™à¸„à¹‰à¸²à¸‚à¸²à¸¢à¸«à¸¡à¸”' },
  { key: 'dashboard.monthly_summary', label: 'à¹à¸”à¸Šà¸šà¸­à¸£à¹Œà¸”: à¸ªà¸£à¸¸à¸›à¸¢à¸­à¸”à¸›à¸£à¸°à¸ˆà¸³à¹€à¸”à¸·à¸­à¸™' },
  { key: 'sell.view', label: 'à¸‚à¸²à¸¢à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'inventory.view', label: 'à¸„à¸¥à¸±à¸‡à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'inventory.adjust_stock', label: 'à¸„à¸¥à¸±à¸‡à¸ªà¸´à¸™à¸„à¹‰à¸²: à¸›à¸£à¸±à¸šà¸›à¸£à¸¸à¸‡à¸ªà¸•à¹Šà¸­à¸' },
  { key: 'product.price_check.view', label: 'à¹€à¸Šà¹‡à¸„à¸£à¸²à¸„à¸²à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'sales.cash.view', label: 'à¸›à¸£à¸°à¸§à¸±à¸•à¸´à¸‚à¸²à¸¢à¹€à¸‡à¸´à¸™à¸ªà¸”: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'sales.credit.view', label: 'à¸›à¸£à¸°à¸§à¸±à¸•à¸´à¸‚à¸²à¸¢à¹€à¸‡à¸´à¸™à¹€à¸Šà¸·à¹ˆà¸­: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'sales.product_history.view', label: 'à¸›à¸£à¸°à¸§à¸±à¸•à¸´à¸à¸²à¸£à¸‚à¸²à¸¢à¸•à¸²à¸¡à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'sales.cancel', label: 'à¸›à¸£à¸°à¸§à¸±à¸•à¸´à¸à¸²à¸£à¸‚à¸²à¸¢: à¸¢à¸à¹€à¸¥à¸´à¸à¹€à¸­à¸à¸ªà¸²à¸£à¸‚à¸²à¸¢' },
  { key: 'sales.return.view', label: 'à¸£à¸±à¸šà¸„à¸·à¸™à¸ªà¸´à¸™à¸„à¹‰à¸²/à¸¥à¸”à¸«à¸™à¸µà¹‰: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'sales.return.create', label: 'à¸£à¸±à¸šà¸„à¸·à¸™à¸ªà¸´à¸™à¸„à¹‰à¸²/à¸¥à¸”à¸«à¸™à¸µà¹‰: à¸ªà¸£à¹‰à¸²à¸‡à¹€à¸­à¸à¸ªà¸²à¸£' },
  { key: 'sales.return.print', label: 'à¸£à¸±à¸šà¸„à¸·à¸™à¸ªà¸´à¸™à¸„à¹‰à¸²/à¸¥à¸”à¸«à¸™à¸µà¹‰: à¸žà¸´à¸¡à¸žà¹Œà¹€à¸­à¸à¸ªà¸²à¸£' },
  { key: 'sales.return.cash_history.view', label: 'à¸›à¸£à¸°à¸§à¸±à¸•à¸´à¹ƒà¸šà¸„à¸·à¸™à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'sales.return.credit_history.view', label: 'à¸›à¸£à¸°à¸§à¸±à¸•à¸´à¹ƒà¸šà¸¥à¸”à¸«à¸™à¸µà¹‰: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'sales.advance_payment.history.view', label: 'à¸£à¸±à¸šà¹€à¸‡à¸´à¸™à¸¥à¹ˆà¸§à¸‡à¸«à¸™à¹‰à¸²: à¸”à¸¹à¸›à¸£à¸°à¸§à¸±à¸•à¸´' },
  { key: 'sales.advance_payment.view', label: 'à¸£à¸±à¸šà¹€à¸‡à¸´à¸™à¸¥à¹ˆà¸§à¸‡à¸«à¸™à¹‰à¸²: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'sales.advance_payment.create', label: 'à¸£à¸±à¸šà¹€à¸‡à¸´à¸™à¸¥à¹ˆà¸§à¸‡à¸«à¸™à¹‰à¸²: à¸ªà¸£à¹‰à¸²à¸‡à¹€à¸­à¸à¸ªà¸²à¸£' },
  { key: 'sales.ar_billing.view', label: 'à¹ƒà¸šà¸§à¸²à¸‡à¸šà¸´à¸¥ (à¸¥à¸¹à¸à¸«à¸™à¸µà¹‰): à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'sales.ar_billing.create', label: 'à¹ƒà¸šà¸§à¸²à¸‡à¸šà¸´à¸¥ (à¸¥à¸¹à¸à¸«à¸™à¸µà¹‰): à¸ªà¸£à¹‰à¸²à¸‡à¹€à¸­à¸à¸ªà¸²à¸£' },
  { key: 'sales.ar_debt_payment.history.view', label: 'à¹ƒà¸šà¹€à¸ªà¸£à¹‡à¸ˆà¸£à¸±à¸šà¹€à¸‡à¸´à¸™: à¸”à¸¹à¸›à¸£à¸°à¸§à¸±à¸•à¸´' },
  { key: 'sales.ar_debt_payment.view', label: 'à¸£à¸±à¸šà¸Šà¸³à¸£à¸°à¸«à¸™à¸µà¹‰/à¸­à¸­à¸à¹ƒà¸šà¹€à¸ªà¸£à¹‡à¸ˆà¸£à¸±à¸šà¹€à¸‡à¸´à¸™: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'sales.ar_debt_payment.create', label: 'à¸£à¸±à¸šà¸Šà¸³à¸£à¸°à¸«à¸™à¸µà¹‰/à¸­à¸­à¸à¹ƒà¸šà¹€à¸ªà¸£à¹‡à¸ˆà¸£à¸±à¸šà¹€à¸‡à¸´à¸™: à¸ªà¸£à¹‰à¸²à¸‡à¹€à¸­à¸à¸ªà¸²à¸£' },
  { key: 'cash.other_expense.view', label: 'à¸„à¹ˆà¸²à¹ƒà¸Šà¹‰à¸ˆà¹ˆà¸²à¸¢à¸­à¸·à¹ˆà¸™à¹†: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸›à¸£à¸°à¸§à¸±à¸•à¸´' },
  { key: 'cash.other_expense.create', label: 'à¸„à¹ˆà¸²à¹ƒà¸Šà¹‰à¸ˆà¹ˆà¸²à¸¢à¸­à¸·à¹ˆà¸™à¹†: à¸ªà¸£à¹‰à¸²à¸‡à¹€à¸­à¸à¸ªà¸²à¸£' },
  { key: 'sold_out.view', label: 'à¸ªà¸´à¸™à¸„à¹‰à¸²à¸‚à¸²à¸¢à¸«à¸¡à¸”: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'sold_out.purchase_info.view', label: 'à¸ªà¸´à¸™à¸„à¹‰à¸²à¸‚à¸²à¸¢à¸«à¸¡à¸”: à¸”à¸¹à¸£à¸²à¸„à¸²à¸‹à¸·à¹‰à¸­à¸¥à¹ˆà¸²à¸ªà¸¸à¸”/à¹€à¸ˆà¹‰à¸²à¸«à¸™à¸µà¹‰' },
  { key: 'purchase.stock_reorder.view', label: 'à¸‹à¸·à¹‰à¸­à¸ªà¸´à¸™à¸„à¹‰à¸²: à¸”à¸¹à¸ªà¸•à¹Šà¸­à¸à¸ªà¸´à¸™à¸„à¹‰à¸²à¹€à¸žà¸·à¹ˆà¸­à¸ªà¸±à¹ˆà¸‡à¸‹à¸·à¹‰à¸­' },
  { key: 'purchase.pu.view', label: 'à¸‹à¸·à¹‰à¸­/à¸•à¸±à¹‰à¸‡à¸«à¸™à¸µà¹‰ (PU): à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'purchase.pu.create', label: 'à¸‹à¸·à¹‰à¸­/à¸•à¸±à¹‰à¸‡à¸«à¸™à¸µà¹‰ (PU): à¸ªà¸£à¹‰à¸²à¸‡à¹€à¸­à¸à¸ªà¸²à¸£' },
  { key: 'purchase.pu.edit', label: 'à¸‹à¸·à¹‰à¸­/à¸•à¸±à¹‰à¸‡à¸«à¸™à¸µà¹‰ (PU): à¹à¸à¹‰à¹„à¸‚à¹€à¸­à¸à¸ªà¸²à¸£' },
  { key: 'purchase.pu.print', label: 'à¸‹à¸·à¹‰à¸­/à¸•à¸±à¹‰à¸‡à¸«à¸™à¸µà¹‰ (PU): à¸žà¸´à¸¡à¸žà¹Œà¹€à¸­à¸à¸ªà¸²à¸£' },
  { key: 'purchase.premium.manage', label: 'ของแถมซื้อ: จัดการเงื่อนไขของแถม' },
  { key: 'sale.premium.manage', label: 'ของแถมขาย: จัดการเงื่อนไขของแถม' },
  { key: 'product.view', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹€à¸‚à¹‰à¸²à¸«à¸™à¹‰à¸²à¸ˆà¸­' },
  { key: 'product.images', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¸”à¸¹à¸£à¸¹à¸›à¸ à¸²à¸ž' },
  { key: 'product.images.edit', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹à¸à¹‰à¹„à¸‚à¸£à¸¹à¸›à¸ à¸²à¸ž' },
  { key: 'product.main', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¸”à¸¹à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸«à¸¥à¸±à¸' },
  { key: 'product.main.edit', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹à¸à¹‰à¹„à¸‚à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸«à¸¥à¸±à¸' },
  { key: 'product.price_formula', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¸”à¸¹à¸ªà¸¹à¸•à¸£à¸£à¸²à¸„à¸²à¸‚à¸²à¸¢' },
  { key: 'product.price_formula.edit', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹à¸à¹‰à¹„à¸‚à¸ªà¸¹à¸•à¸£à¸£à¸²à¸„à¸²à¸‚à¸²à¸¢' },
  { key: 'product.sale_price', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¸”à¸¹à¸£à¸²à¸„à¸²à¸‚à¸²à¸¢/à¹‚à¸›à¸£à¹‚à¸¡à¸Šà¸±à¹ˆà¸™' },
  { key: 'product.sale_price.edit', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹à¸à¹‰à¹„à¸‚à¸£à¸²à¸„à¸²à¸‚à¸²à¸¢/à¹‚à¸›à¸£à¹‚à¸¡à¸Šà¸±à¹ˆà¸™' },
  { key: 'product.discount', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¸”à¸¹à¹€à¸‡à¸·à¹ˆà¸­à¸™à¹„à¸‚à¸ªà¹ˆà¸§à¸™à¸¥à¸”' },
  { key: 'product.discount.edit', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹à¸à¹‰à¹„à¸‚à¹€à¸‡à¸·à¹ˆà¸­à¸™à¹„à¸‚à¸ªà¹ˆà¸§à¸™à¸¥à¸”' },
  { key: 'product.units', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¸”à¸¹à¸«à¸™à¹ˆà¸§à¸¢à¸™à¸±à¸š' },
  { key: 'product.units.edit', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹à¸à¹‰à¹„à¸‚à¸«à¸™à¹ˆà¸§à¸¢à¸™à¸±à¸š' },
  { key: 'product.barcodes', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¸”à¸¹à¸šà¸²à¸£à¹Œà¹‚à¸„à¹‰à¸”à¸ªà¸´à¸™à¸„à¹‰à¸²' },
  { key: 'product.barcodes.edit', label: 'à¸ˆà¸±à¸”à¸à¸²à¸£à¸ªà¸´à¸™à¸„à¹‰à¸²: à¹à¸à¹‰à¹„à¸‚à¸šà¸²à¸£à¹Œà¹‚à¸„à¹‰à¸”à¸ªà¸´à¸™à¸„à¹‰à¸²' },
];

const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
const DEFAULT_DENIED_PERMISSION_KEYS = new Set(['sales.cancel']);
const DEFAULT_PERMISSION_KEYS = ALL_PERMISSION_KEYS.filter((key) => !DEFAULT_DENIED_PERMISSION_KEYS.has(key));

async function getEmployeePermissions(query, userCode) {
  if (!userCode) return ALL_PERMISSION_KEYS;
  if (String(userCode).trim().toUpperCase() === 'SUPERADMIN') return ALL_PERMISSION_KEYS;
  try {
    const result = await query(
      `SELECT permission_key, is_allowed
       FROM sml_staff_permission
       WHERE UPPER(user_code) = UPPER($1)
       ORDER BY permission_key`,
      [userCode],
    );
    if (result.rows.length === 0) return DEFAULT_PERMISSION_KEYS;
    return result.rows
      .filter((r) => r.is_allowed === true)
      .map((r) => r.permission_key)
      .filter((key) => ALL_PERMISSION_KEYS.includes(key));
  } catch (ex) {
    if (ex.code === '42P01') return DEFAULT_PERMISSION_KEYS;
    throw ex;
  }
}

module.exports = { PERMISSIONS, ALL_PERMISSION_KEYS, getEmployeePermissions };


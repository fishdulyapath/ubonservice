const PERMISSIONS = [
  { key: 'permission.manage', label: 'กำหนดสิทธิ์ผู้ใช้' },
  { key: 'dashboard.sold_out_report', label: 'แดชบอร์ด: ดูรายงานสินค้าขายหมด' },
  { key: 'dashboard.monthly_summary', label: 'แดชบอร์ด: สรุปยอดประจำเดือน' },
  { key: 'sell.view', label: 'ขายสินค้า: เข้าหน้าจอ' },
  { key: 'inventory.view', label: 'คลังสินค้า: เข้าหน้าจอ' },
  { key: 'inventory.adjust_stock', label: 'คลังสินค้า: ปรับปรุงสต๊อก' },
  { key: 'sales.cash.view', label: 'ประวัติขายเงินสด: เข้าหน้าจอ' },
  { key: 'sales.credit.view', label: 'ประวัติขายเงินเชื่อ: เข้าหน้าจอ' },
  { key: 'sales.product_history.view', label: 'ประวัติการขายตามสินค้า: เข้าหน้าจอ' },
  { key: 'sales.return.view', label: 'รับคืนสินค้า/ลดหนี้: เข้าหน้าจอ' },
  { key: 'sales.return.create', label: 'รับคืนสินค้า/ลดหนี้: สร้างเอกสาร' },
  { key: 'sales.return.print', label: 'รับคืนสินค้า/ลดหนี้: พิมพ์เอกสาร' },
  { key: 'sales.advance_payment.history.view', label: 'รับเงินล่วงหน้า: ดูประวัติ' },
  { key: 'sales.advance_payment.view', label: 'รับเงินล่วงหน้า: เข้าหน้าจอ' },
  { key: 'sales.advance_payment.create', label: 'รับเงินล่วงหน้า: สร้างเอกสาร' },
  { key: 'sales.ar_billing.view', label: 'ใบวางบิล (ลูกหนี้): เข้าหน้าจอ' },
  { key: 'sales.ar_billing.create', label: 'ใบวางบิล (ลูกหนี้): สร้างเอกสาร' },
  { key: 'sales.ar_debt_payment.history.view', label: 'ใบเสร็จรับเงิน: ดูประวัติ' },
  { key: 'sales.ar_debt_payment.view', label: 'รับชำระหนี้/ออกใบเสร็จรับเงิน: เข้าหน้าจอ' },
  { key: 'sales.ar_debt_payment.create', label: 'รับชำระหนี้/ออกใบเสร็จรับเงิน: สร้างเอกสาร' },
  { key: 'cash.other_expense.view', label: 'ค่าใช้จ่ายอื่นๆ: เข้าหน้าประวัติ' },
  { key: 'cash.other_expense.create', label: 'ค่าใช้จ่ายอื่นๆ: สร้างเอกสาร' },
  { key: 'sold_out.view', label: 'สินค้าขายหมด: เข้าหน้าจอ' },
  { key: 'sold_out.purchase_info.view', label: 'สินค้าขายหมด: ดูราคาซื้อล่าสุด/เจ้าหนี้' },
  { key: 'purchase.stock_reorder.view', label: 'ซื้อสินค้า: ดูสต๊อกสินค้าเพื่อสั่งซื้อ' },
  { key: 'purchase.pu.view', label: 'ซื้อ/ตั้งหนี้ (PU): เข้าหน้าจอ' },
  { key: 'purchase.pu.create', label: 'ซื้อ/ตั้งหนี้ (PU): สร้างเอกสาร' },
  { key: 'purchase.pu.edit', label: 'ซื้อ/ตั้งหนี้ (PU): แก้ไขเอกสาร' },
  { key: 'purchase.pu.print', label: 'ซื้อ/ตั้งหนี้ (PU): พิมพ์เอกสาร' },
  { key: 'purchase.premium.manage', label: 'ของแถมซื้อ: จัดการเงื่อนไขของแถม' },
  { key: 'product.view', label: 'จัดการสินค้า: เข้าหน้าจอ' },
  { key: 'product.images', label: 'จัดการสินค้า: ดูรูปภาพ' },
  { key: 'product.images.edit', label: 'จัดการสินค้า: แก้ไขรูปภาพ' },
  { key: 'product.main', label: 'จัดการสินค้า: ดูข้อมูลหลัก' },
  { key: 'product.main.edit', label: 'จัดการสินค้า: แก้ไขข้อมูลหลัก' },
  { key: 'product.price_formula', label: 'จัดการสินค้า: ดูสูตรราคาขาย' },
  { key: 'product.price_formula.edit', label: 'จัดการสินค้า: แก้ไขสูตรราคาขาย' },
  { key: 'product.units', label: 'จัดการสินค้า: ดูหน่วยนับ' },
  { key: 'product.units.edit', label: 'จัดการสินค้า: แก้ไขหน่วยนับ' },
  { key: 'product.barcodes', label: 'จัดการสินค้า: ดูบาร์โค้ดสินค้า' },
  { key: 'product.barcodes.edit', label: 'จัดการสินค้า: แก้ไขบาร์โค้ดสินค้า' },
];

const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

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
    if (result.rows.length === 0) return ALL_PERMISSION_KEYS;
    return result.rows
      .filter((r) => r.is_allowed === true)
      .map((r) => r.permission_key)
      .filter((key) => ALL_PERMISSION_KEYS.includes(key));
  } catch (ex) {
    if (ex.code === '42P01') return ALL_PERMISSION_KEYS;
    throw ex;
  }
}

module.exports = { PERMISSIONS, ALL_PERMISSION_KEYS, getEmployeePermissions };

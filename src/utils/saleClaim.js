const { getProductPriceLocalx } = require('./priceHelper');
const { calcAfterDiscount } = require('../routes/purchase');

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

function claimNetPrice(price, qty, discountWord = '') {
  const gross = money(price * qty);
  const amount = money(calcAfterDiscount(discountWord, gross, 2, qty));
  const unitPrice = Math.round((amount / qty) * 10000) / 10000;
  if (!Number.isFinite(unitPrice) || unitPrice < 0 || Math.abs(money(unitPrice * qty) - amount) > 0.005) {
    throw new Error('claim price cannot be represented at four decimal places');
  }
  return { unit_price: unitPrice, amount };
}

function applyClaimDiscount(line, original, claimAmount) {
  const amount = money(claimAmount);
  const alreadyDiscounted = line === original;
  const net = money(line.sum_amount);
  const beforeClaim = money(net + (alreadyDiscounted ? amount : 0));
  if (net < -0.005 || amount > beforeClaim + 0.005) {
    throw new Error('claim amount exceeds sale item net amount');
  }
  if (alreadyDiscounted) {
    const gross = money(Number(line.price) * Number(line.qty));
    const totalDiscount = money(line.discount_amount);
    if (!Number.isFinite(gross) || gross < 0 || totalDiscount + 0.005 < amount
      || totalDiscount > gross + 0.005 || Math.abs(money(net + totalDiscount) - gross) > 0.01) {
      throw new Error('claim discount exceeds sale item gross amount');
    }
  }
  if (!alreadyDiscounted) {
    line.sum_amount = money(net - amount);
    line.discount_amount = money(Number(line.discount_amount || 0) + amount);
    line.discount = [line.discount, String(amount)].filter(Boolean).join(',');
  }
  return line;
}

function buildClaimPUPayload({ claimQuotes, branch, docNo, docDate, docTime, branchCode, empCode, creatorCode }) {
  const totalClaim = money(claimQuotes.reduce((sum, row) => sum + row.amount, 0));
  return {
    doc_date: docDate, doc_time: docTime, doc_format_code: branch.pu_doc_format_code,
    cust_code: 'AP0186', emp_code: empCode, creator_code: creatorCode || empCode,
    branch_code: branchCode, inquiry_type: 0, tax_type: 3, vat_rate: 0,
    wh_from: branch.wh_code, location_from: branch.shelf_code,
    remark: `รับสินค้าเคลมจากใบขาย ${docNo}`, doc_ref: docNo, doc_ref_date: docDate,
    total_value: totalClaim, total_before_vat: totalClaim, total_after_vat: totalClaim,
    total_amount: totalClaim, total_vat_value: 0, total_except_vat: totalClaim,
    items: claimQuotes.map((row) => ({
      item_code: row.item_code, item_name: row.item_name, unit_code: row.unit_code,
      qty: row.qty, price: row.unit_price, sum_amount: row.amount,
      stand_value: row.stand_value, divide_value: row.divide_value,
      barcode: row.barcode, tax_type: 1,
      wh_code: branch.wh_code, shelf_code: branch.shelf_code,
    })),
  };
}

async function quoteClaim(queryFn, input, priceFn = getProductPriceLocalx) {
  const itemCode = String(input.item_code || '').trim();
  const unitCode = String(input.unit_code || '').trim();
  const qty = Number(input.qty);
  if (!itemCode || !unitCode || !Number.isFinite(qty) || qty <= 0 || qty > 999999) {
    throw new Error('invalid claim item, unit or quantity');
  }
  const item = await queryFn(
    `SELECT i.code, i.name_1, i.unit_standard, COALESCE(u.stand_value,1) AS stand_value,
            COALESCE(u.divide_value,1) AS divide_value,
            COALESCE(b.barcode,'') AS barcode
       FROM ic_inventory i
       JOIN sml_staff_claim_item c ON c.item_code=i.code AND c.is_claim_item=TRUE
       JOIN ic_unit_use u ON u.ic_code=i.code AND u.code=$2
       LEFT JOIN LATERAL (SELECT barcode FROM ic_inventory_barcode WHERE ic_code=i.code AND unit_code=$2 ORDER BY barcode LIMIT 1) b ON TRUE
      WHERE i.code=$1 LIMIT 1`,
    [itemCode, unitCode],
  );
  if (!item.rows[0]) throw new Error(`item is not configured for claim: ${itemCode}/${unitCode}`);
  const row = item.rows[0];
  const result = await priceFn(itemCode, unitCode, String(qty), String(input.cust_code || ''),
    Number(input.vat_type ?? 1), Number(input.vat_rate ?? 7), Number(input.sale_type ?? 1), row.barcode);
  const priceRow = result.data?.[0];
  const price = Number(priceRow?.price);
  if (!Number.isFinite(price) || price < 0) throw new Error(`claim price unavailable: ${itemCode}/${unitCode}`);
  const discountWord = String(priceRow.defaultDiscount ?? priceRow.default_discount ?? '').trim();
  const { amount, unit_price } = claimNetPrice(price, qty, discountWord);
  if (amount < 0) throw new Error('claim amount is negative');
  return {
    item_code: itemCode, item_name: row.name_1, unit_code: unitCode, qty,
    unit_price, amount, discount_word: discountWord,
    stand_value: Number(row.stand_value) || 1, divide_value: Number(row.divide_value) || 1,
    barcode: row.barcode,
  };
}

async function cartClaims(queryFn, cartKey, saleGuid = '') {
  const params = [cartKey];
  const filter = saleGuid ? ' AND c.sale_guid=$2' : '';
  if (saleGuid) params.push(saleGuid);
  const result = await queryFn(
    `SELECT c.* FROM sml_staff_cart_claim c WHERE c.cart_key=$1${filter} ORDER BY c.sale_guid,c.line_no`, params,
  );
  return result.rows;
}

module.exports = { money, claimNetPrice, applyClaimDiscount, buildClaimPUPayload, quoteClaim, cartClaims };

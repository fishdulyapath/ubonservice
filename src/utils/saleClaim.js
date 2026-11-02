const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

function capClaimQuotes(quotes, maximum) {
  let remaining = Math.max(0, money(maximum));
  return quotes.map((quote) => {
    const configuredAmount = money(quote.configured_amount ?? quote.amount);
    const amount = Math.min(remaining, configuredAmount);
    const unit_price = amount === configuredAmount
      ? Number(quote.configured_unit_price ?? quote.unit_price)
      : Math.round((amount / Number(quote.qty)) * 10000) / 10000;
    if (!Number.isFinite(unit_price) || Math.abs(money(unit_price * Number(quote.qty)) - amount) > 0.005) {
      throw new Error(`claim amount cannot be represented at four decimal places: ${quote.item_code}/${quote.unit_code}`);
    }
    remaining = money(remaining - amount);
    return { ...quote, unit_price, amount, is_capped: amount < configuredAmount };
  });
}

function claimQuoteChanged(saved, fresh) {
  if (saved.configured_unit_price === null || saved.configured_unit_price === undefined) return true;
  const savedPrice = Number(saved.configured_unit_price);
  const savedAmount = Number(saved.quoted_amount);
  if (!Number.isFinite(savedPrice) || !Number.isFinite(savedAmount)) return true;
  return Math.abs(savedPrice - Number(fresh.configured_unit_price)) > 0.00005
    || Math.abs(savedAmount - Number(fresh.amount)) > 0.005;
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

async function quoteClaim(queryFn, input) {
  const itemCode = String(input.item_code || '').trim();
  const unitCode = String(input.unit_code || '').trim();
  const qty = Number(input.qty);
  if (!itemCode || !unitCode || !Number.isFinite(qty) || qty <= 0 || qty > 999999) {
    throw new Error('invalid claim item, unit or quantity');
  }
  const item = await queryFn(
    `SELECT i.code, i.name_1, i.unit_standard, COALESCE(u.stand_value,1) AS stand_value,
            COALESCE(u.divide_value,1) AS divide_value,
            COALESCE(b.barcode,'') AS barcode, p.claim_price
       FROM ic_inventory i
       JOIN sml_staff_claim_item c ON c.item_code=i.code AND c.is_claim_item=TRUE
       JOIN ic_unit_use u ON u.ic_code=i.code AND u.code=$2
       LEFT JOIN sml_staff_claim_unit_price p ON p.item_code=i.code AND p.unit_code=u.code
       LEFT JOIN LATERAL (SELECT barcode FROM ic_inventory_barcode WHERE ic_code=i.code AND unit_code=$2 ORDER BY barcode LIMIT 1) b ON TRUE
      WHERE i.code=$1 LIMIT 1`,
    [itemCode, unitCode],
  );
  if (!item.rows[0]) throw new Error(`item is not configured for claim: ${itemCode}/${unitCode}`);
  const row = item.rows[0];
  if (row.claim_price === null || row.claim_price === undefined) {
    throw new Error(`ยังไม่ได้ตั้งราคารับเคลม: ${itemCode}/${unitCode}`);
  }
  const price = Number(row.claim_price);
  if (!Number.isFinite(price) || price < 0) throw new Error(`invalid claim price: ${itemCode}/${unitCode}`);
  const amount = money(price * qty);
  const unit_price = price;
  if (amount < 0) throw new Error('claim amount is negative');
  return {
    item_code: itemCode, item_name: row.name_1, unit_code: unitCode, qty,
    unit_price, amount, configured_unit_price: price, configured_amount: amount,
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

module.exports = { money, capClaimQuotes, claimQuoteChanged, applyClaimDiscount, buildClaimPUPayload, quoteClaim, cartClaims };

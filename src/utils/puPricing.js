// Purchase discount and VAT calculation follows SMLInventoryControl _icTransItemGridControl
// and _icTransProcess. Keep this module in sync with the staff PU preview.
function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pricingOptions(row = {}) {
  const decimal = (value, fallback) => Math.max(0, Math.min(6, Math.trunc(number(value, fallback))));
  return {
    amountPoint: decimal(row.item_amount_decimal, 2),
    pricePoint: decimal(row.item_price_decimal, 2),
    discountType: Math.trunc(number(row.discout_type, 0)),
    discountVatType: Math.trunc(number(row.discount_vat_type, 0)),
    stepRoundOff: Number(row.discount_step_round_off) === 1,
    itemPriceDiscount: Number(row.calc_item_price_discount) === 1,
    roundType: Math.trunc(number(row.round_type, 0)),
  };
}

function roundAway(value, point) {
  const factor = 10 ** point;
  return Math.sign(value) * Math.round(Math.abs(value) * factor + 1e-10) / factor;
}

function roundERP(value, point = 2, roundType = 0) {
  let result = number(value);
  if (roundType === 1) return roundAway(result + 0.000001, point);
  result = Number(result.toFixed(12));
  const decimals = (result.toFixed(12).split('.')[1] || '').replace(/0+$/, '').length;
  for (let digit = Math.min(decimals - 1, 12); digit >= point; digit -= 1) {
    result = roundAway(result, digit);
  }
  return result;
}

function calcAfterDiscount(word, amount, point = 2, qty = 1, alwaysRound = true, roundType = 0) {
  let result = number(amount);
  if (!String(word || '').trim()) return result;
  for (const token of String(word).replace(/\s/g, '').split(',')) {
    if (!token) continue;
    if (token.startsWith('@')) {
      const discount = number(token.slice(1)) * number(qty);
      result -= alwaysRound ? roundERP(discount, point, roundType) : discount;
    } else if (token.includes('%')) {
      const rate = number(token.replace('%', ''));
      const adjustment = result * rate / 100;
      const applied = alwaysRound ? roundERP(adjustment, point, roundType) : adjustment;
      result += token.startsWith('+') ? applied : -applied;
    } else {
      const discount = number(token);
      result -= alwaysRound ? roundERP(discount, point, roundType) : discount;
    }
  }
  return roundERP(result, point, roundType);
}

function calcPULineAmounts(item, optionRow = {}) {
  const options = pricingOptions(optionRow);
  const qty = number(item?.qty);
  if (String(item?.is_permium ?? item?.is_premium ?? '0') === '1') {
    return { qty, price: 0, discount: '', discount_amount: 0, sum_amount: 0, is_permium: 1 };
  }
  const price = number(item?.price);
  const gross = roundERP(price * qty, options.amountPoint, options.roundType);
  const word = String(item?.discount || '').trim()
    || (number(item?.discount_amount) ? String(item.discount_amount) : '');
  let net = gross;
  if (word && options.itemPriceDiscount) {
    const unitNet = calcAfterDiscount(word, price, options.pricePoint, 1, !options.stepRoundOff, options.roundType);
    net = roundERP(qty * unitNet, options.amountPoint, options.roundType);
  } else if (word) {
    net = calcAfterDiscount(word, gross, options.amountPoint, qty, !options.stepRoundOff, options.roundType);
  }
  net = Math.max(0, net);
  return {
    qty, price, discount: word,
    discount_amount: roundERP(gross - net, options.amountPoint, options.roundType),
    sum_amount: net, is_permium: 0,
  };
}

function calcPUVatTotals(totalValueVat, totalValueNoVat, discountWord, vatRate, vatType, optionRow = {}) {
  const options = pricingOptions(optionRow);
  const round = (value) => roundERP(value, options.amountPoint, options.roundType);
  const totalValue = number(totalValueVat) + number(totalValueNoVat);
  const discount = round(totalValue - calcAfterDiscount(
    discountWord, totalValue, options.amountPoint, 1, !options.stepRoundOff, options.roundType,
  ));
  const rate = number(vatRate);
  let beforeVat = 0;
  let vatValue = 0;
  let afterVat = 0;
  let totalExceptVat = number(totalValueNoVat);
  let totalAmount = 0;
  let discountNoVat = 0;

  if (Number(vatType) === 0) {
    if (options.discountType === 1) {
      if (options.discountVatType === 1) {
        const discountVat = totalValue > 0 ? round(discount * totalValueVat / totalValue) : 0;
        discountNoVat = discount - discountVat;
        beforeVat = totalValueVat - discountVat;
        vatValue = round(beforeVat * rate / 100);
      } else if (options.discountVatType === 0) {
        beforeVat = Math.max(0, totalValueVat - discount);
        discountNoVat = Math.max(0, discount - totalValueVat);
        vatValue = round(beforeVat * rate / 100);
      }
      afterVat = beforeVat + vatValue;
      totalExceptVat -= discountNoVat;
      totalAmount = totalExceptVat + afterVat;
    } else {
      beforeVat = totalValueVat;
      vatValue = round(beforeVat * rate / 100);
      afterVat = beforeVat + vatValue;
      totalAmount = beforeVat + totalExceptVat + vatValue - discount;
    }
  } else if (Number(vatType) === 1) {
    totalAmount = totalValue - discount;
    if (options.discountType === 1) {
      if (options.discountVatType === 1) {
        const discountVat = totalValue > 0 ? round(discount * totalValueVat / totalValue) : 0;
        discountNoVat = discount - discountVat;
        const taxable = totalValueVat - discountVat;
        beforeVat = round(taxable * 100 / (100 + rate));
        vatValue = round(taxable - beforeVat);
      } else if (options.discountVatType === 0) {
        const taxable = Math.max(0, totalValueVat - discount);
        discountNoVat = Math.max(0, discount - totalValueVat);
        beforeVat = round(taxable * 100 / (100 + rate));
        vatValue = round(taxable - beforeVat);
      }
      afterVat = beforeVat + vatValue;
      totalExceptVat -= discountNoVat;
    } else {
      beforeVat = round(totalValueVat * 100 / (100 + rate));
      vatValue = round(totalValueVat - beforeVat);
      afterVat = beforeVat + vatValue;
    }
  } else {
    if (options.discountVatType === 1 && totalValue > 0) {
      discountNoVat = discount - round(discount * totalValueVat / totalValue);
    } else if (options.discountVatType === 0) {
      discountNoVat = Math.max(0, discount - totalValueVat);
    }
    totalExceptVat -= discountNoVat;
    totalAmount = totalValue - discount;
  }
  return {
    total_value: round(totalValue), total_discount: round(discount),
    total_before_vat: round(beforeVat), total_vat_value: round(vatValue),
    total_after_vat: round(afterVat), total_except_vat: round(totalExceptVat),
    total_amount: round(totalAmount),
  };
}

function calculatePUDocument(items, discountWord, vatRate, vatType, optionRow = {}) {
  const lines = (items || []).map((item) => ({ ...item, ...calcPULineAmounts(item, optionRow) }));
  const taxable = lines.filter((item) => Number(item.tax_type || 0) !== 1)
    .reduce((sum, item) => sum + item.sum_amount, 0);
  const exempt = lines.filter((item) => Number(item.tax_type || 0) === 1)
    .reduce((sum, item) => sum + item.sum_amount, 0);
  return {
    items: lines,
    totals: calcPUVatTotals(taxable, exempt, discountWord, vatRate, vatType, optionRow),
  };
}

module.exports = { pricingOptions, roundERP, calcAfterDiscount, calcPULineAmounts, calcPUVatTotals, calculatePUDocument };

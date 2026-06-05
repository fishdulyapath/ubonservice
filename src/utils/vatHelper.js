function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function calcDiscount(discountWord, totalValue) {
  if (!discountWord || discountWord.trim() === '') return 0;
  let remaining = totalValue;
  const parts = discountWord.trim().split('+');
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    if (part.toUpperCase().endsWith('B')) {
      const amt = parseFloat(part.slice(0, -1)) || 0;
      remaining -= amt;
    } else {
      const pct = parseFloat(part) || 0;
      remaining = remaining * (1.0 - pct / 100.0);
    }
    if (remaining < 0) remaining = 0;
  }
  return round4(totalValue - remaining);
}

// vatType: 0=ภาษีแยกนอก(exclusive), 1=ภาษีรวมใน(inclusive), 2/3=ยกเว้น/ไม่กระทบ
// discountType: 0=ลดก่อน vat, 1=ลดหลัง vat
// returns [beforeVat, vatValue, afterVat, totalAmount]
function calcVat(vatType, vatRate, discountType, totalValue, totalDiscount) {
  let before_vat = 0, vat_value = 0, after_vat = 0, total_amount = 0;

  switch (vatType) {
    case 0: {
      if (discountType === 1) {
        before_vat = totalValue;
        vat_value = round4(before_vat * (vatRate / 100.0));
        after_vat = before_vat + vat_value;
        total_amount = after_vat - totalDiscount;
      } else {
        before_vat = Math.max(0, totalValue - totalDiscount);
        vat_value = round4(before_vat * (vatRate / 100.0));
        after_vat = before_vat + vat_value;
        total_amount = after_vat;
      }
      break;
    }
    case 1: {
      const discounted = Math.max(0, totalValue - totalDiscount);
      before_vat = round4((discounted * 100.0) / (100.0 + vatRate));
      vat_value = round4(discounted - before_vat);
      after_vat = before_vat + vat_value;
      total_amount = discounted;
      break;
    }
    case 2:
    case 3:
    default: {
      vat_value = 0;
      before_vat = Math.max(0, totalValue - totalDiscount);
      after_vat = before_vat;
      total_amount = Math.max(0, totalValue - totalDiscount);
      break;
    }
  }

  return [before_vat, vat_value, after_vat, total_amount];
}

module.exports = { round4, calcDiscount, calcVat };

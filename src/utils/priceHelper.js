// เลียนแบบ getProductPriceLocalx() ใน RestService.java บรรทัด 4642–5165
// sequential queries, ผลลัพธ์มี roworder field จาก DB จริง

const { pool } = require('../db');

// คืนวันปัจจุบันรูปแบบ YYYY-MM-DD ตาม local timezone
// (toISOString จะให้ UTC ทำให้ช่วง 00:00–06:59 ตามเวลาไทยได้วันก่อนหน้า)
function todayLocalDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// เลียนแบบ myglobal._calcFormulaPrice()
function calcFormulaPrice(qty, price, formula) {
  let newPrice = price;
  if (!formula || formula.trim().length === 0) return price;

  const first = formula.trim().charAt(0);
  if (first === '=' || first === '-' || first === '+') {
    const parts = formula.split(',');
    if (parts.length > 0) {
      const valStr = parts[0].replace(/^[=+\-]/, '');
      if (first === '=') {
        newPrice = valStr;
      } else if (first === '-') {
        newPrice = String(parseFloat(newPrice) - parseFloat(valStr));
      } else if (first === '+') {
        newPrice = String(parseFloat(newPrice) + parseFloat(valStr));
      }
    }
  } else {
    newPrice = formula;
  }
  return newPrice;
}


async function getProductPriceLocalx(
  icCode,
  unitCode,
  qty,
  custCode,
  vatType = 0,
  vatRate = null,
  saleType = 0,
  barcode = '',
  docDate = null,
  currencyCode = ''
) {
  const today = docDate || todayLocalDate();
  const qtyVal = (!qty || qty === '0' || qty === 0) ? 1 : (parseInt(qty) || 1);
  const vatTypeVal = parseInt(vatType, 10);
  const isVatExcluded = vatTypeVal === 0;
  const saleTypeVal = parseInt(saleType, 10);
  const saleTypeSecondary = (saleTypeVal === 0 || saleTypeVal === 2) ? 2 : 1;
  const saleTypeInClause = `(0,${saleTypeSecondary})`;
  let formulaSaleTypeInClause = '(0)';
  if (saleTypeVal === 0) {
    formulaSaleTypeInClause = '(0,2)';
  } else if (saleTypeVal === 1) {
    formulaSaleTypeInClause = '(0,1)';
  }

  let formulaTaxTypeInClause = '(0)';
  if (vatTypeVal === 0) {
    formulaTaxTypeInClause = '(0,1)';
  } else if (vatTypeVal === 1) {
    formulaTaxTypeInClause = '(0,2)';
  } else if (vatTypeVal === 2 || vatTypeVal === 3) {
    formulaTaxTypeInClause = '(0,3)';
  }

  let whereInventoryPriceCurrency = '';
  let whereInventoryPriceFormulaCurrency = '';
  const hasCurrency = String(currencyCode || '').trim().length > 0;
  if (hasCurrency) {
    whereInventoryPriceCurrency = `
           AND (
             (COALESCE(price_currency,0)=0)
             OR ((currency_code=$6) AND (COALESCE(price_currency,0)=1))
           )`;
    whereInventoryPriceFormulaCurrency = `
             AND (
               (COALESCE(price_currency,0)=0)
               OR ((currency_code=$3) AND (COALESCE(price_currency,0)=1))
             )`;
  }

  const client = await pool.connect();
  const res = { success: false, data: [] };

  try {
    // โหลด erp_option
    let get_last_price_type = 0;
    let ic_price_formula_control = 0;
    let defaultVatRate = 0;
    try {
      const optRes = await client.query('SELECT get_last_price_type, ic_price_formula_control FROM erp_option LIMIT 1');
      if (optRes.rows.length > 0) {
        get_last_price_type = optRes.rows[0].get_last_price_type || 0;
        ic_price_formula_control = optRes.rows[0].ic_price_formula_control || 0;
      }
    } catch (_) {}

    try {
      const vatRateColRes = await client.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name='erp_option' AND column_name IN ('vat_rate','default_vat_rate','sale_vat_rate')
         ORDER BY CASE column_name
           WHEN 'vat_rate' THEN 1
           WHEN 'default_vat_rate' THEN 2
           WHEN 'sale_vat_rate' THEN 3
           ELSE 99 END
         LIMIT 1`
      );
      if (vatRateColRes.rows.length > 0) {
        const vatCol = vatRateColRes.rows[0].column_name;
        const vatRes = await client.query(`SELECT COALESCE(${vatCol},0) AS vat_rate FROM erp_option LIMIT 1`);
        if (vatRes.rows.length > 0) {
          defaultVatRate = parseFloat(vatRes.rows[0].vat_rate) || 0;
        }
      }
    } catch (_) {}

    let foundPrice = false;
    let foundByCondition = false;
    const tmpList = {};

    // Query 0: ราคาตามลูกค้า (price_type=3)
    try {
      const r0 = await client.query(
        `SELECT roworder, sale_price1, sale_price2, price_mode, price_type
         FROM ic_inventory_price
         WHERE ic_code=$1 AND unit_code=$2 AND cust_code=$3 AND price_type=3
           AND ($4::date BETWEEN from_date AND to_date)
           AND ($5::numeric BETWEEN from_qty AND to_qty)
           AND sale_type IN ${saleTypeInClause}
           ${whereInventoryPriceCurrency}
         ORDER BY price_mode DESC, sale_type DESC, transport_type DESC
         LIMIT 1`,
        hasCurrency
          ? [icCode, unitCode, custCode, today, qtyVal, currencyCode]
          : [icCode, unitCode, custCode, today, qtyVal]
      );
      if (r0.rows.length > 0) {
        const r = r0.rows[0];
        foundPrice = true;
        foundByCondition = true;
        tmpList.price1 = r.sale_price1;
        tmpList.price2 = r.sale_price2;
        tmpList.price = isVatExcluded ? r.sale_price1 : r.sale_price2;
        tmpList.mode = r.price_mode;
        tmpList.roworder = String(r.roworder || 0);
        tmpList.type = '1';
      }
    } catch (_) {}

    // Query 1: ราคาตามกลุ่มลูกค้า (price_type=2)
    if (!foundByCondition) {
      try {
        const r1 = await client.query(
          `SELECT roworder, sale_price1, sale_price2, price_mode, price_type
           FROM ic_inventory_price
           WHERE ic_code=$1 AND unit_code=$2 AND price_type=2
             AND cust_group_1=(SELECT group_main FROM ar_customer_detail WHERE ar_code=$3)
             AND (
               cust_group_2=(SELECT group_sub_1 FROM ar_customer_detail WHERE ar_code=$3)
               OR cust_group_2=(SELECT group_sub_1 FROM ar_customer_detail WHERE ar_code=$3)
               OR cust_group_2=(SELECT group_sub_3 FROM ar_customer_detail WHERE ar_code=$3)
               OR cust_group_2=(SELECT group_sub_4 FROM ar_customer_detail WHERE ar_code=$3)
               OR COALESCE(cust_group_2,'')=''
             )
             AND ($4::date BETWEEN from_date AND to_date)
             AND ($5::numeric BETWEEN from_qty AND to_qty)
             AND sale_type IN ${saleTypeInClause}
             ${whereInventoryPriceCurrency}
           ORDER BY price_mode DESC, sale_type DESC, transport_type DESC, cust_group_2
           LIMIT 1`,
          hasCurrency
            ? [icCode, unitCode, custCode, today, qtyVal, currencyCode]
            : [icCode, unitCode, custCode, today, qtyVal]
        );
        if (r1.rows.length > 0) {
          const r = r1.rows[0];
          foundPrice = true;
          foundByCondition = true;
          tmpList.price1 = r.sale_price1;
          tmpList.price2 = r.sale_price2;
          tmpList.price = isVatExcluded ? r.sale_price1 : r.sale_price2;
          tmpList.mode = r.price_mode;
          tmpList.roworder = String(r.roworder || 0);
          tmpList.type = '2';
        }
      } catch (_) {}
    }

    // Query 2: ราคาขายทั่วไป (price_type=1, price_mode=1)
    if (!foundByCondition) {
      try {
        const wherePriceCurrency2 = hasCurrency ? `
           AND (
             (COALESCE(price_currency,0)=0)
             OR ((currency_code=$5) AND (COALESCE(price_currency,0)=1))
           )` : '';
        const r2 = await client.query(
          `SELECT roworder, sale_price1, sale_price2, price_mode, price_type
           FROM ic_inventory_price
           WHERE ic_code=$1 AND unit_code=$2 AND price_type=1 AND price_mode=1
             AND ($3::date BETWEEN from_date AND to_date)
             AND ($4::numeric BETWEEN from_qty AND to_qty)
             AND sale_type IN ${saleTypeInClause}
             ${wherePriceCurrency2}
           ORDER BY price_mode DESC, sale_type DESC, transport_type DESC
           LIMIT 1`,
          hasCurrency
            ? [icCode, unitCode, today, qtyVal, currencyCode]
            : [icCode, unitCode, today, qtyVal]
        );
        if (r2.rows.length > 0) {
          const r = r2.rows[0];
          foundPrice = true;
          foundByCondition = true;
          tmpList.price1 = r.sale_price1;
          tmpList.price2 = r.sale_price2;
          tmpList.price = isVatExcluded ? r.sale_price1 : r.sale_price2;
          tmpList.mode = r.price_mode;
          tmpList.roworder = String(r.roworder || 0);
          tmpList.type = '3';
        }
      } catch (_) {}
    }

    // Query 3: ราคามาตราฐาน (price_type=1, price_mode=0)
    if (!foundByCondition) {
      try {
        const wherePriceCurrency3 = hasCurrency ? `
           AND (
             (COALESCE(price_currency,0)=0)
             OR ((currency_code=$5) AND (COALESCE(price_currency,0)=1))
           )` : '';
        const r3 = await client.query(
          `SELECT roworder, sale_price1, sale_price2, price_mode, price_type
           FROM ic_inventory_price
           WHERE ic_code=$1 AND unit_code=$2 AND price_type=1 AND price_mode=0
             AND ($3::date BETWEEN from_date AND to_date)
             AND ($4::numeric BETWEEN from_qty AND to_qty)
             AND sale_type IN ${saleTypeInClause}
             ${wherePriceCurrency3}
           ORDER BY price_mode DESC, sale_type DESC, transport_type DESC
           LIMIT 1`,
          hasCurrency
            ? [icCode, unitCode, today, qtyVal, currencyCode]
            : [icCode, unitCode, today, qtyVal]
        );
        if (r3.rows.length > 0) {
          const r = r3.rows[0];
          foundPrice = true;
          foundByCondition = true;
          tmpList.price1 = r.sale_price1;
          tmpList.price2 = r.sale_price2;
          tmpList.price = isVatExcluded ? r.sale_price1 : r.sale_price2;
          tmpList.mode = r.price_mode;
          tmpList.roworder = String(r.roworder || 0);
          tmpList.type = '3';
        }
      } catch (_) {}
    }

    // Query 4+5: ราคาตามสูตร (formula)
    if (!foundPrice) {
      try {
        let priceLevel = 0;
        const r4 = await client.query(
          'SELECT price_level FROM ar_customer WHERE code=$1',
          [custCode]
        );
        if (r4.rows.length > 0) priceLevel = r4.rows[0].price_level || 0;

        // strResultVatType = "0,2,3" (ภาษีรวมใน case fallthrough → adds ,2 then ,3)
        // strResultSaleType = "0,2" (saleType=0)
        const r5 = await client.query(
          `SELECT * FROM ic_inventory_price_formula
           WHERE ic_code=$1 AND unit_code=$2
             AND sale_type IN ${formulaSaleTypeInClause}
             AND COALESCE(tax_type,0) IN ${formulaTaxTypeInClause}
             ${whereInventoryPriceFormulaCurrency}
           ORDER BY sale_type DESC LIMIT 1`,
          hasCurrency ? [icCode, unitCode, currencyCode] : [icCode, unitCode]
        );
        if (r5.rows.length > 0) {
          const row = r5.rows[0];
          const strPriceStandard = row.price_0 || '';
          let strFormula = strPriceStandard;
          const level = parseInt(priceLevel) || 0;
          if (level >= 1 && level <= 9) {
            strFormula = row[`price_${level}`] || strPriceStandard;
          }
          const resultPrice = calcFormulaPrice(String(qtyVal), strPriceStandard, strFormula);
          foundPrice = true;
          tmpList.price = resultPrice;
          tmpList.price2 = resultPrice;
          tmpList.mode = '6';
          tmpList.roworder = '0';
          tmpList.type = '6';
        }
      } catch (_) {}
    }

    // barcode price fallback (เหมือน C#: ใช้ barcode input โดยตรง)
    if (!foundPrice && String(barcode).trim().length > 0) {
      try {
        const bcPriceRes = await client.query(
          'SELECT price FROM ic_inventory_barcode WHERE barcode=$1',
          [String(barcode).trim()]
        );
        if (bcPriceRes.rows.length > 0) {
          foundPrice = true;
          tmpList.price = bcPriceRes.rows[0].price;
          tmpList.price2 = bcPriceRes.rows[0].price;
          tmpList.mode = '5';
          tmpList.roworder = '0';
          tmpList.type = '5';
        }
      } catch (_) {}
    }

    // Last price (get_last_price_type=1: latest, =2: average)
    if (!foundPrice && get_last_price_type !== 0) {
      try {
        let lastSql = '';
        if (get_last_price_type === 1) {
          lastSql = `SELECT price_exclude_vat,
            price,
            (SELECT vat_type FROM ic_trans
              WHERE ic_trans.doc_no = ic_trans_detail.doc_no
                AND ic_trans.trans_flag = ic_trans_detail.trans_flag) AS vat_type
            FROM ic_trans_detail
            WHERE cust_code=$1 AND item_code=$2 AND unit_code=$3
              AND last_status=0 AND trans_flag=44 AND price_exclude_vat>0
            ORDER BY doc_date DESC, doc_time DESC LIMIT 1`;
        } else if (get_last_price_type === 2) {
          lastSql = `SELECT SUM(price_exclude_vat)/COUNT(*) AS price_exclude_vat
            FROM ic_trans_detail
            WHERE cust_code=$1 AND item_code=$2 AND unit_code=$3
              AND last_status=0 AND trans_flag=44 AND price_exclude_vat>0`;
        }
        if (lastSql) {
          const lastRes = await client.query(lastSql, [custCode, icCode, unitCode]);
          const rows = lastRes.rows;
          if (rows.length > 0) {
            let p = parseFloat(rows[0].price_exclude_vat) || 0;
            const effectiveVatRate = Number.isFinite(parseFloat(vatRate))
              ? (parseFloat(vatRate) || 0)
              : defaultVatRate;
            if (vatTypeVal === 1 && effectiveVatRate > 0) {
              p = p + (p * (effectiveVatRate / 100));
            }
            if (
              vatTypeVal === 1 &&
              String(rows[0].vat_type || '') === '1' &&
              rows[0].price !== undefined &&
              rows[0].price !== null
            ) {
              p = parseFloat(rows[0].price) || p;
            }
            foundPrice = true;
            tmpList.price = String(p);
            tmpList.price2 = String(p);
            tmpList.mode = '5';
            tmpList.roworder = '0';
            tmpList.type = '7';
          }
        }
      } catch (_) {}
    }

    // formula_control: get stand_price if ic_price_formula_control=1 and foundPrice
    if (foundPrice && ic_price_formula_control === 1) {
      try {
        const fcRes = await client.query(
          `SELECT * FROM ic_inventory_price_formula
           WHERE ic_code=$1 AND unit_code=$2
             AND sale_type IN ${formulaSaleTypeInClause}
             AND COALESCE(tax_type,0) IN ${formulaTaxTypeInClause}
             ${whereInventoryPriceFormulaCurrency}
           ORDER BY sale_type DESC LIMIT 1`,
          hasCurrency ? [icCode, unitCode, currencyCode] : [icCode, unitCode]
        );
        if (fcRes.rows.length > 0) {
          tmpList.stand_price = fcRes.rows[0].price_0 || '';
        }
      } catch (_) {}
    }

    // find discount (C#: customer -> group -> normal)
    let foundDiscount = false;
    // Discount Query 8: ลดตามลูกค้า (ic_inventory_discount, discount_type=2)
    if (!foundDiscount) {
      try {
        const dq8 = await client.query(
          `SELECT roworder, discount FROM ic_inventory_discount
           WHERE ic_code=$1 AND unit_code=$2 AND cust_code=$3 AND discount_type=2
             AND ($4::date BETWEEN from_date AND to_date)
             AND ($5::numeric BETWEEN from_qty AND to_qty)
             AND sale_type IN ${saleTypeInClause}
           ORDER BY line_number
           LIMIT 1`,
          [icCode, unitCode, custCode, today, qtyVal]
        );
        if (dq8.rows.length > 0) {
          foundDiscount = true;
          tmpList.defaultDiscount = dq8.rows[0].discount;
        }
      } catch (_) {}
    }

    // Discount Query 9: ลดตามกลุ่ม (ic_inventory_discount, discount_type=1)
    if (!foundDiscount) {
      try {
        const dq9 = await client.query(
          `SELECT roworder, discount FROM ic_inventory_discount
           WHERE ic_code=$1 AND unit_code=$2 AND discount_type=1
             AND cust_group_1=(SELECT group_main FROM ar_customer_detail WHERE ar_code=$3)
             AND (
               cust_group_2=(SELECT group_sub_1 FROM ar_customer_detail WHERE ar_code=$3)
               OR cust_group_2=(SELECT group_sub_1 FROM ar_customer_detail WHERE ar_code=$3)
               OR cust_group_2=(SELECT group_sub_3 FROM ar_customer_detail WHERE ar_code=$3)
               OR cust_group_2=(SELECT group_sub_4 FROM ar_customer_detail WHERE ar_code=$3)
               OR COALESCE(cust_group_2,'')=''
             )
             AND ($4::date BETWEEN from_date AND to_date)
             AND ($5::numeric BETWEEN from_qty AND to_qty)
             AND sale_type IN ${saleTypeInClause}
           ORDER BY roworder
           LIMIT 1`,
          [icCode, unitCode, custCode, today, qtyVal]
        );
        if (dq9.rows.length > 0) {
          foundDiscount = true;
          tmpList.defaultDiscount = dq9.rows[0].discount;
        }
      } catch (_) {}
    }

        // Discount Query 10: ลดทั่วไป (ic_inventory_discount, discount_type=0)
    if (!foundDiscount) {
      try {
        const dq10 = await client.query(
          `SELECT roworder, discount FROM ic_inventory_discount
           WHERE ic_code=$1 AND unit_code=$2 AND discount_type=0
             AND ($3::date BETWEEN from_date AND to_date)
             AND ($4::numeric BETWEEN from_qty AND to_qty)
             AND sale_type IN ${saleTypeInClause}
           ORDER BY line_number
           LIMIT 1`,
          [icCode, unitCode, today, qtyVal]
        );
        if (dq10.rows.length > 0) {
          foundDiscount = true;
          tmpList.defaultDiscount = dq10.rows[0].discount;
        }
      } catch (_) {}
    }


    res.success = true;
    if (foundPrice || Object.keys(tmpList).length > 0) {
      res.data = [tmpList];
    }
    return res;
  } finally {
    client.release();
  }
}

module.exports = { getProductPriceLocalx, calcFormulaPrice };

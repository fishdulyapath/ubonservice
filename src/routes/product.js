const express = require("express");
const router = express.Router();
const { query, pool, poolImages, withTransaction, queryImages } = require("../db");
const { getProductPriceLocalx } = require("../utils/priceHelper");
const { randomInt, randomUUID } = require("crypto");

const PRODUCT_CODE_PATTERN = /^[A-Z0-9_-]+$/;
const EAN13_INTERNAL_PREFIX = "20";
const ADJUST_STOCK_SQL_DEBUG = String(process.env.DEBUG_ADJUST_STOCK_SQL || "").trim() === "1";

function activeProductCondition(alias = "d") {
  return `COALESCE(${alias}.is_hold_sale,0) <> 1 AND COALESCE(${alias}.is_hold_purchase,0) <> 1`;
}

function normalizeStockLevelQty(value) {
  const num = Number(String(value ?? 0).replace(/,/g, ""));
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function ensureProductExists(client, icCode) {
  const c = String(icCode || "").trim();
  if (!c) throw httpError("กรุณาระบุรหัสสินค้า", 400);
  const exists = await client.query(`SELECT 1 FROM ic_inventory WHERE code=$1 LIMIT 1`, [c]);
  if (!exists.rows.length) throw httpError("ไม่พบสินค้า", 404);
}

async function ensureWarehouseShelfExists(client, whCode, shelfCode) {
  const wh = String(whCode || "").trim();
  const shelf = String(shelfCode || "").trim();
  if (!wh) throw httpError("กรุณาเลือกคลัง", 400);
  if (!shelf) throw httpError("กรุณาเลือกที่เก็บ", 400);
  const result = await client.query(`SELECT 1 FROM ic_shelf WHERE whcode=$1::text AND code=$2::text LIMIT 1`, [wh, shelf]);
  if (!result.rows.length) throw httpError("คลัง/ที่เก็บไม่ถูกต้อง", 400);
}

function normalizeWarehouseShelfRows(rows, fallbackWhCode = "", fallbackShelfCode = "") {
  const list = Array.isArray(rows) ? rows : [];
  const unique = new Map();

  function add(row) {
    const whCode = String(row?.wh_code || row?.whcode || "").trim();
    const shelfCode = String(row?.shelf_code || row?.code || "").trim();
    if (!whCode || !shelfCode) return;
    unique.set(`${whCode}\u0000${shelfCode}`, {
      wh_code: whCode,
      shelf_code: shelfCode,
      shelf_list: String(row?.shelf_list || "").trim(),
      min_point: normalizeStockLevelQty(row?.min_point),
      max_point: normalizeStockLevelQty(row?.max_point),
      status: Number(row?.status ?? 1) === 0 ? 0 : 1,
    });
  }

  for (const row of list) add(row);
  add({ wh_code: fallbackWhCode, shelf_code: fallbackShelfCode });
  return Array.from(unique.values());
}

async function ensureWarehouseShelfRowsExist(client, rows) {
  for (const row of rows) {
    await ensureWarehouseShelfExists(client, row.wh_code, row.shelf_code);
  }
}

async function replaceProductWarehouseShelves(client, icCode, rows) {
  const c = String(icCode || "").trim();
  await client.query(`DELETE FROM ic_wh_shelf WHERE ic_code=$1::text`, [c]);
  for (const row of rows) {
    await client.query(
      `INSERT INTO ic_wh_shelf (ic_code, wh_code, shelf_code, shelf_list, min_point, max_point, status)` +
        ` VALUES ($1::text,$2::text,$3::text,$4::text,$5::numeric,$6::numeric,$7::integer)`,
      [c, row.wh_code, row.shelf_code, row.shelf_list, row.min_point, row.max_point, row.status],
    );
  }
}

async function ensureProductUnitUse(client, icCode, unitCode) {
  const c = String(icCode || "").trim();
  const u = String(unitCode || "").trim();
  if (!c || !u) return;
  await client.query(
    `INSERT INTO ic_unit_use (ic_code, code, stand_value, divide_value, ratio, row_order)` +
      ` SELECT $1::text,$2::text,1,1,1,0` +
      ` WHERE NOT EXISTS (SELECT 1 FROM ic_unit_use WHERE ic_code=$1::text AND code=$2::text)`,
    [c, u],
  );
}

async function syncProductUnitType(client, icCode) {
  const c = String(icCode || "").trim();
  if (!c) return;
  const unitCountResult = await client.query(
    `SELECT COUNT(DISTINCT NULLIF(TRIM(code::text), ''))::int AS unit_count FROM ic_unit_use WHERE ic_code=$1::text`,
    [c],
  );
  const unitCount = Number(unitCountResult.rows[0]?.unit_count || 0);
  const updateResult = await client.query(
    `WITH standard_unit AS (` +
      ` SELECT COALESCE(NULLIF(u.stand_value, 0), 1) AS stand_value,` +
      `        COALESCE(NULLIF(u.divide_value, 0), 1) AS divide_value` +
      ` FROM ic_inventory i` +
      ` LEFT JOIN ic_unit_use u ON u.ic_code = i.code AND u.code = i.unit_standard` +
      ` WHERE i.code=$2::text` +
      ` LIMIT 1` +
      `)` +
      ` UPDATE ic_inventory SET unit_type=$1::integer,` +
      ` unit_standard_stand_value = (SELECT stand_value FROM standard_unit),` +
      ` unit_standard_divide_value = (SELECT divide_value FROM standard_unit)` +
      ` WHERE code=$2::text`,
    [unitCount > 1 ? 1 : 0, c],
  );
  if (updateResult.rowCount === 0) throw httpError("ไม่พบสินค้า", 404);
}

function ean13CheckDigit(base12) {
  const digits = String(base12 || "").replace(/\D/g, "");
  if (digits.length !== 12) throw new Error("EAN-13 base must be 12 digits");
  const sum = digits.split("").reduce((total, digit, index) => {
    const value = Number(digit);
    return total + value * (index % 2 === 0 ? 1 : 3);
  }, 0);
  return String((10 - (sum % 10)) % 10);
}

function generateEan13Candidate() {
  const randomBody = String(randomInt(0, 10_000_000_000)).padStart(10, "0");
  const base12 = `${EAN13_INTERNAL_PREFIX}${randomBody}`;
  return `${base12}${ean13CheckDigit(base12)}`;
}

async function resolveBasketPricingContext(custCode) {
  if (!custCode || !String(custCode).trim()) {
    return { saleType: null, vatType: null, vatRate: null };
  }
  try {
    const rs = await query(
      `SELECT COALESCE(inquiry_type,0) AS sale_type,
              COALESCE(vat_type,0) AS vat_type,
              COALESCE(vat_rate,0) AS vat_rate
       FROM pos_basket
       WHERE cust_code=$1
       ORDER BY basket_id DESC
       LIMIT 1`,
      [custCode]
    );
    if (rs.rows.length > 0) {
      return {
        saleType: parseInt(rs.rows[0].sale_type, 10),
        vatType: parseInt(rs.rows[0].vat_type, 10),
        vatRate: parseFloat(rs.rows[0].vat_rate),
      };
    }
  } catch (_) {}
  return { saleType: null, vatType: null, vatRate: null };
}

// GET /service/v1/getProductList
// เลียนแบบ Java ทุกอย่าง: dynamic WHERE, pagination ด้วย offset/limit
router.get("/getProductList", async (req, res) => {
  const {
    cust_code: strCustCode = "",
    search: strSearch = "",
    category: strCategory = "",
    offset: strOffset = "0",
    premium: strPremium = "",
    ispromotion: strPromotion = "",
    isstock: strStock = "",
    favorite: strFavorite = "",
    isproductset: strProductSet = "",
    exclude_hold_sale: strExcludeHoldSale = "",
    exclude_hold_purchase: strExcludeHoldPurchase = "",
    limit: strLimit = "20",
  } = req.query;

  const resp = { success: false };

  try {
    // เลียนแบบ Java search condition: ค้นหา name_1, code, name_eng_2 + barcode (1 สินค้ามีหลายบาร์โค้ด)
    let searchWhere = "";
    if (strSearch && strSearch.trim()) {
      const keywords = strSearch.trim().split(" ");
      const fields = ["b.name_1", "b.code", "b.name_eng_1", "b.name_eng_2"];
      const parts = fields.map((field) => {
        const kw = keywords.map((k) => `upper(${field}) LIKE '%${k.toUpperCase().replace(/'/g, "''")}%'`).join(" AND ");
        return `(${kw})`;
      });
      const barcodeKw = keywords
        .map((k) => `upper(ibc.barcode) LIKE '%${k.toUpperCase().replace(/'/g, "''")}%'`)
        .join(" AND ");
      parts.push(
        `EXISTS (SELECT 1 FROM ic_inventory_barcode ibc WHERE ibc.ic_code = b.code AND (${barcodeKw}))`,
      );
      searchWhere = ` AND (${parts.join(" OR ")}) `;
    }

    let whereFinal = `${searchWhere} AND ${activeProductCondition("c")}`;

    if (strCategory && strCategory.trim()) {
      whereFinal += ` AND b.item_category='${strCategory.replace(/'/g, "''")}'`;
    }
    if (strPremium === "1") whereFinal += ` AND c.is_premium='1'`;
    if (strProductSet === "1") whereFinal += ` AND b.item_type='3'`;
    if (strFavorite === "1") whereFinal += ` AND arc.status='1'`;
    if (strExcludeHoldSale === "1") whereFinal += ` AND COALESCE(c.is_hold_sale,0) <> 1`;
    if (strExcludeHoldPurchase === "1") whereFinal += ` AND COALESCE(c.is_hold_purchase,0) <> 1`;

    if (strPromotion === "1") {
      whereFinal +=
        ` AND COALESCE((SELECT ic_code FROM ic_inventory_price WHERE ic_code = b.code` +
        ` AND ((cust_code = '' OR cust_code = '${strCustCode.replace(/'/g, "''")}') ` +
        ` AND (cust_group_1 = '' OR cust_group_1 = (SELECT ar_customer_detail.group_main FROM ar_customer_detail WHERE ar_customer_detail.ar_code='${strCustCode.replace(/'/g, "''")}'))) LIMIT 1),'') != ''`;
    }

    // stockQtyExpr เหมือน Java
    const normalStockQtyExpr =
      `((select balance_qty from ic_inventory where code=b.code) / ` +
      `NULLIF( ((select unit_standard_stand_value from ic_inventory where code=b.code) / ` +
      `NULLIF((select unit_standard_divide_value from ic_inventory where code=b.code),0) ), 0))`;
    const setStockQtyExpr =
      `(SELECT COALESCE(MIN(TRUNC(COALESCE(sb.sum_balance_qty,0) / NULLIF(sd.qty,0), 0)), 0)` +
      ` FROM ic_inventory_set_detail sd` +
      ` LEFT JOIN LATERAL (` +
      `   SELECT SUM(balance_qty) AS sum_balance_qty` +
      `   FROM sml_ic_function_stock_balance_warehouse_location('NOW()', sd.ic_code, '', '')` +
      `   WHERE balance_qty > 0` +
      ` ) sb ON TRUE` +
      ` WHERE sd.ic_set_code = b.code)`;
    const stockQtyExpr =
      `(CASE WHEN COALESCE(b.item_type,0) = 3 THEN COALESCE(${setStockQtyExpr}, 0) ELSE ${normalStockQtyExpr} END)`;

    if (strStock === "1") {
      whereFinal += ` AND (COALESCE(b.item_type,0) = 1 OR ((${stockQtyExpr}) > 0 ))`;
    }

    const baseFrom =
      ` FROM ic_inventory b` +
      ` LEFT JOIN ic_inventory_detail c ON b.code=c.ic_code` +
      ` LEFT JOIN ar_item_by_customer arc ON arc.ic_code = b.code AND arc.ar_code='${strCustCode.replace(/'/g, "''")}'` +
      ` WHERE 1=1 ${whereFinal}`;

    const dataSQL =
      `SELECT b.code AS item_code, b.name_1 AS item_name, c.start_sale_unit,b.unit_cost,b.unit_standard, b.item_type,` +
      ` (CASE WHEN COALESCE(b.item_type,0) = 1 THEN '0' WHEN (${stockQtyExpr}) <= 0 THEN '1' ELSE '0' END) AS sold_out,` +
      ` CASE WHEN COALESCE(b.item_grade,'') = 'R' THEN '1' ELSE '0' END AS is_return,` +
      ` CASE WHEN (` +
      `   COALESCE((SELECT ic_code FROM ic_inventory_price WHERE ic_code = b.code` +
      `     AND CURRENT_DATE BETWEEN from_date AND to_date` +
      `     AND ((cust_code = '' OR cust_code = '${strCustCode.replace(/'/g, "''")}')` +
      `     AND (cust_group_1 = '' OR cust_group_1=(SELECT ar_customer_detail.group_main FROM ar_customer_detail WHERE ar_customer_detail.ar_code='${strCustCode.replace(/'/g, "''")}'))) LIMIT 1),'') != ''` +
      `   OR EXISTS (SELECT 1 FROM ic_inventory_discount` +
      `     WHERE ic_code = b.code` +
      `       AND CURRENT_DATE BETWEEN from_date AND to_date` +
      `       AND (` +
      `         discount_type = 0` +
      `         OR (discount_type = 2 AND cust_code = '${strCustCode.replace(/'/g, "''")}')` +
      `         OR (discount_type = 1 AND cust_group_1 = (SELECT group_main FROM ar_customer_detail WHERE ar_code='${strCustCode.replace(/'/g, "''")}'))` +
      `       ))` +
      ` ) THEN '1' ELSE '0' END AS is_promotion,` +
      ` COALESCE(arc.status,0) AS favorite_item` +
      `${baseFrom} OFFSET ${parseInt(strOffset) || 0} LIMIT ${parseInt(strLimit) || 20}`;

    const dataResult = await query(dataSQL, []);

    const data = dataResult.rows.map((r) => ({
      item_code: r.item_code,
      item_name: r.item_name,
      item_type: r.item_type,
      sold_out: r.sold_out,
      unit_standard: r.unit_standard,
      unit_cost: r.unit_cost,
      start_sale_unit: r.start_sale_unit,
      is_promotion: r.is_promotion,
      favorite_item: r.favorite_item,
      is_return: r.is_return,
    }));

    resp.success = true;
    resp.data = data;
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getProductBarcodeSearch
// Search product choices at barcode/unit level so sales screens can choose the exact selling unit.
router.get("/getProductBarcodeSearch", async (req, res) => {
  const {
    search: strSearch = "",
    offset: strOffset = "0",
    limit: strLimit = "50",
    exclude_hold_sale: strExcludeHoldSale = "",
    exclude_hold_purchase: strExcludeHoldPurchase = "",
  } = req.query;
  const resp = { success: false };

  try {
    const params = [];
    const whereParts = [activeProductCondition("d")];
    const keywords = String(strSearch || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    for (const keyword of keywords) {
      params.push(`%${keyword.toUpperCase()}%`);
      const p = `$${params.length}`;
      whereParts.push(`(
        UPPER(COALESCE(b.barcode,'')) LIKE ${p}
        OR UPPER(COALESCE(b.ic_code,'')) LIKE ${p}
        OR UPPER(COALESCE(b.unit_code,'')) LIKE ${p}
        OR UPPER(COALESCE(i.name_1,'')) LIKE ${p}
        OR UPPER(COALESCE(i.name_eng_1,'')) LIKE ${p}
        OR UPPER(COALESCE(i.name_eng_2,'')) LIKE ${p}
      )`);
    }
    if (strExcludeHoldSale === "1") whereParts.push("COALESCE(d.is_hold_sale,0) <> 1");
    if (strExcludeHoldPurchase === "1") whereParts.push("COALESCE(d.is_hold_purchase,0) <> 1");

    const offset = Math.max(0, parseInt(strOffset, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(strLimit, 10) || 50));
    params.push(offset);
    const offsetParam = `$${params.length}`;
    params.push(limit);
    const limitParam = `$${params.length}`;

    const sql = `
      WITH base AS (
        SELECT
          b.ic_code AS item_code,
          COALESCE(b.barcode, '') AS barcode,
          COALESCE(NULLIF(b.unit_code, ''), NULLIF(d.start_sale_unit, ''), NULLIF(i.unit_standard, ''), NULLIF(i.unit_cost, '')) AS unit_code,
          i.name_1 AS item_name,
          COALESCE(i.item_type, 0) AS item_type,
          COALESCE(i.tax_type, 0) AS tax_type,
          i.unit_standard,
          i.unit_cost,
          COALESCE(i.unit_standard_stand_value, 1) AS unit_standard_stand_value,
          COALESCE(i.unit_standard_divide_value, 1) AS unit_standard_divide_value,
          d.start_sale_unit,
          d.start_sale_wh,
          d.start_sale_shelf
        FROM ic_inventory_barcode b
        JOIN ic_inventory i ON i.code = b.ic_code
        LEFT JOIN ic_inventory_detail d ON d.ic_code = i.code
        WHERE 1=1
        ${whereParts.length ? `AND ${whereParts.join(" AND ")}` : ""}
      )
      SELECT
        base.item_code,
        base.item_name,
        base.item_type,
        base.tax_type,
        base.unit_code,
        base.barcode,
        base.start_sale_unit,
        base.unit_standard,
        base.unit_cost,
        base.start_sale_wh AS wh_code,
        base.start_sale_shelf AS shelf_code,
        COALESCE(u.stand_value, base.unit_standard_stand_value, 1) AS stand_value,
        COALESCE(u.divide_value, base.unit_standard_divide_value, 1) AS divide_value,
        COALESCE(
          u.ratio,
          CASE WHEN COALESCE(base.unit_standard_divide_value, 1) <> 0
               THEN COALESCE(base.unit_standard_stand_value, 1)::numeric / COALESCE(base.unit_standard_divide_value, 1)::numeric
               ELSE 1
          END
        ) AS ratio
      FROM base
      LEFT JOIN ic_unit_use u ON u.ic_code = base.item_code AND u.code = base.unit_code
      WHERE COALESCE(base.unit_code, '') <> ''
      ORDER BY base.item_code, base.unit_code, base.barcode
      OFFSET ${offsetParam} LIMIT ${limitParam}
    `;

    const result = await query(sql, params);
    const data = result.rows.map((r) => ({
      item_code: r.item_code,
      item_name: r.item_name,
      item_type: r.item_type,
      tax_type: r.tax_type,
      unit_code: r.unit_code,
      barcode: r.barcode,
      unit_standard: r.unit_standard,
      unit_cost: r.unit_cost,
      start_sale_unit: r.start_sale_unit,
      wh_code: r.wh_code,
      shelf_code: r.shelf_code,
      stand_value: r.stand_value,
      divide_value: r.divide_value,
      ratio: r.ratio,
    }));

    resp.success = true;
    resp.data = data;
    return res.json(resp);
  } catch (ex) {
    console.error("getProductBarcodeSearch error:", ex.message);
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getProductDetail
// เลียนแบบ Java: CTE balance_stock + ic_unit_use + เรียก getProductPriceLocalx ต่อ unit
router.get("/getProductDetail", async (req, res) => {
  const {
    cust_code: strCustCode = "",
    item_code: strItemCode = "",
    show_promotion: strShowPromotion = "1",
    sale_type: strSaleType = "",
    vat_type: strVatType = "",
    vat_rate: strVatRate = "",
    doc_date: strDocDate = "",
  } = req.query;
  const resp = { success: false };

  try {
    const sql = `
      WITH balance_stock AS (
        SELECT ic_code, SUM(balance_qty) AS sum_balance_qty
        FROM sml_ic_function_stock_balance_warehouse_location('NOW()','${strItemCode.replace(/'/g, "''")}', '', '')
        GROUP BY ic_code
      )
      SELECT a.ic_code, b.name_1 AS item_name, a.code AS unit_code, b.item_type,
        COALESCE(b.tax_type,0) AS tax_type,
        COALESCE((SELECT barcode FROM ic_inventory_barcode ib WHERE ib.ic_code=a.ic_code AND ib.unit_code=a.code LIMIT 1),'') AS barcode,
        CASE WHEN COALESCE(b.item_grade,'') = upper('r') THEN '1' ELSE '0' END AS is_return,
        COALESCE(b.description,'') AS description,
        COALESCE((SELECT sum_balance_qty FROM balance_stock g WHERE g.ic_code=a.ic_code LIMIT 1),0) AS sum_balance_qty,
        TRUNC(COALESCE((SELECT sum_balance_qty FROM balance_stock g WHERE g.ic_code=a.ic_code LIMIT 1),0)/COALESCE(a.ratio,0),0) AS balance_qty,
        (CASE WHEN COALESCE((SELECT sum_balance_qty FROM balance_stock g WHERE g.ic_code=a.ic_code LIMIT 1),0) <= ROUND(COALESCE(c.minimum_qty,0)) THEN '1' ELSE '0' END) AS sold_out,
        COALESCE(((SELECT SUM(qty) FROM ic_trans_detail e WHERE a.ic_code=e.item_code AND a.code=e.unit_code AND e.doc_date BETWEEN '2025-01-01' AND 'NOW()' LIMIT 1)
          *(SELECT stand_value FROM ic_trans_detail e WHERE a.ic_code=e.item_code AND a.code=e.unit_code LIMIT 1)),0) AS sum_sale,
        COALESCE((SELECT status FROM ar_item_by_customer WHERE ic_code=b.code AND ar_code='${strCustCode.replace(/'/g, "''")}' LIMIT 1),0) AS favorite_item,
        0 AS price,
        c.start_sale_wh, c.start_sale_shelf, a.stand_value, a.divide_value, a.ratio
      FROM ic_unit_use a
      LEFT JOIN ic_inventory b ON a.ic_code=b.code
      LEFT JOIN ic_inventory_detail c ON a.ic_code=c.ic_code
      WHERE a.ic_code IN ('${strItemCode.replace(/'/g, "''")}')
        AND ${activeProductCondition("c")}
      ORDER BY a.ic_code, ratio
    `;

    const result = await query(sql, []);
    const basketCtx = await resolveBasketPricingContext(strCustCode);
    const saleTypeReq = parseInt(strSaleType, 10);
    const vatTypeReq = parseInt(strVatType, 10);
    const vatRateReq = parseFloat(strVatRate);
    const docDate = strDocDate.trim() || undefined;

    const data = [];

    for (const r of result.rows) {
      const obj = {
        barcode: r.barcode,
        item_type: r.item_type,
        item_code: r.ic_code,
        item_name: r.item_name,
        unit_code: r.unit_code,
        balance_qty: Number(r.balance_qty || 0),
        sum_balance_qty: Number(r.sum_balance_qty || 0),
        sold_out: r.sold_out,
        sum_sale: Number(r.sum_sale || 0),
        wh_code: r.start_sale_wh,
        shelf_code: r.start_sale_shelf,
        stand_value: r.stand_value,
        divide_value: r.divide_value,
        ratio: r.ratio,
        favorite_item: r.favorite_item,
        price: "0",
        is_return: r.is_return,
        description: r.description,
        promotion: [],
      };

      try {
        const saleType = Number.isNaN(saleTypeReq) ? (Number.isNaN(basketCtx.saleType) ? 0 : basketCtx.saleType) : saleTypeReq;
        const vatType = Number.isNaN(vatTypeReq)
          ? (Number.isNaN(basketCtx.vatType) ? (parseInt(r.tax_type, 10) || 0) : basketCtx.vatType)
          : vatTypeReq;
        const vatRate = Number.isNaN(vatRateReq)
          ? (Number.isNaN(basketCtx.vatRate) ? null : basketCtx.vatRate)
          : vatRateReq;

        const priceRes = await getProductPriceLocalx(r.ic_code, r.unit_code, "1", strCustCode, vatType, vatRate, saleType, r.barcode, docDate);
        const arr = priceRes.data || [];
        if (arr.length > 0) {
          const priceObj = arr[0];
          obj.price = String(priceObj.price || "0");
          const type = String(priceObj.type || "0");
          const mode = String(priceObj.mode || "0");
          const roworder = String(priceObj.roworder || "0");
          obj.type = type;
          obj.mode = mode;
          obj.price_type = roworder;

          if (strShowPromotion == "1") {
            // query promotion ถ้า type IN (1,2,3) — เหมือน Java lines 3490-3524
            if (["1", "2", "3"].includes(type)) {
              const proParams = [r.ic_code, r.unit_code, mode];
              let moreWhere = "";
              if (roworder === "3") {
                moreWhere = " AND cust_code=$4";
                proParams.push(strCustCode);
              } else if (roworder === "4") {
                moreWhere = " AND cust_group_1=(SELECT group_main FROM ar_customer_detail WHERE ar_code=$4)";
                proParams.push(strCustCode);
              }
              const proResult = await query(
                `SELECT line_number, sale_price2 AS price, from_qty, to_qty,
                COALESCE((SELECT name_1 FROM ic_unit WHERE code=unit_code), unit_code) AS unit_name
               FROM ic_inventory_price
               WHERE ic_code=$1 AND unit_code=$2
                 AND CURRENT_DATE BETWEEN from_date AND to_date
                 AND price_mode=$3
                 ${moreWhere}
               ORDER BY from_qty ASC, line_number ASC`,
                proParams,
              );
              let lineNum = 1;
              obj.promotion = proResult.rows.map((p) => ({
                from_qty: p.from_qty,
                to_qty: p.to_qty,
                unit_name: p.unit_name,
                price: p.price,
                line_number: lineNum++,
              }));
            }

            // query discount_promotion จาก ic_inventory_discount (ไม่ filter qty)
            const dpResult = await query(
              `SELECT from_qty, to_qty, discount, discount_type, line_number
               FROM ic_inventory_discount
               WHERE ic_code=$1 AND unit_code=$2
                 AND CURRENT_DATE BETWEEN from_date AND to_date
                 AND (
                   discount_type = 0
                   OR (discount_type = 2 AND cust_code = $3)
                   OR (discount_type = 1 AND cust_group_1 = (SELECT group_main FROM ar_customer_detail WHERE ar_code = $3))
                 )
               ORDER BY discount_type DESC, line_number`,
              [r.ic_code, r.unit_code, strCustCode],
            );
            obj.discount_promotion = dpResult.rows.map((d) => ({
              from_qty: d.from_qty,
              to_qty: d.to_qty,
              discount: d.discount,
              discount_type: d.discount_type,
            }));
          }
        }
      } catch (ex) {
        console.error(`getProductDetail price/promotion error for ${r.ic_code}/${r.unit_code}:`, ex.message);
      }

      data.push(obj);
    }

    resp.success = true;
    resp.data = data;
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getProductSetDetail
// เลียนแบบ Java: CTE set_detail + balance_stock + set_stock + set_price
router.get("/getProductSetDetail", async (req, res) => {
  const { cust_code: strCustCode = "", item_code: strItemCode = "" } = req.query;
  const resp = { success: false };

  try {
    const sql = `
      WITH set_detail AS (
        SELECT ic_set_code, ic_code, qty
        FROM ic_inventory_set_detail
        WHERE ic_set_code = '${strItemCode.replace(/'/g, "''")}'
      ),
      balance_stock AS (
        SELECT d.ic_set_code, d.ic_code, d.qty,
               SUM(f.balance_qty) AS sum_balance_qty
        FROM set_detail d
        LEFT JOIN LATERAL (
          SELECT balance_qty
          FROM sml_ic_function_stock_balance_warehouse_location('NOW()', d.ic_code, '', '')
        ) f ON TRUE
        WHERE f.balance_qty > 0
        GROUP BY d.ic_set_code, d.ic_code, d.qty
      ),
      set_stock AS (
        SELECT ic_set_code, MIN(TRUNC(sum_balance_qty / qty, 0)) AS set_balance_qty
        FROM balance_stock
        GROUP BY ic_set_code
      ),
      set_price AS (
        SELECT ic_set_code, SUM(sum_amount) AS set_price
        FROM ic_inventory_set_detail
        WHERE ic_set_code = '${strItemCode.replace(/'/g, "''")}'
        GROUP BY ic_set_code
      )
      SELECT i.code AS ic_code, i.item_type,
             i.name_1 AS item_name,
             u.code AS unit_code,
             CASE WHEN COALESCE(i.item_grade,'') = upper('r') THEN '1' ELSE '0' END AS is_return,
             COALESCE(i.description,'') AS description,
             COALESCE(ss.set_balance_qty,0) AS balance_qty,
             CASE WHEN COALESCE(ss.set_balance_qty,0) <= ROUND(COALESCE(d.minimum_qty,0)) THEN '1' ELSE '0' END AS sold_out,
             0 AS sum_sale,
             COALESCE(f.status,0) AS favorite_item,
             COALESCE(sp.set_price,0) AS price,
             d.start_sale_wh, d.start_sale_shelf,
             u.stand_value, u.divide_value, u.ratio
      FROM ic_inventory i
      LEFT JOIN ic_unit_use u ON i.code = u.ic_code
      LEFT JOIN ic_inventory_detail d ON i.code = d.ic_code
      LEFT JOIN set_stock ss ON i.code = ss.ic_set_code
      LEFT JOIN set_price sp ON i.code = sp.ic_set_code
      LEFT JOIN ar_item_by_customer f ON f.ic_code = i.code AND f.ar_code = '${strCustCode.replace(/'/g, "''")}'
      WHERE i.code = '${strItemCode.replace(/'/g, "''")}'
        AND ${activeProductCondition("d")}
      ORDER BY u.ratio
    `;

    const result = await query(sql, []);
    const data = result.rows.map((r) => ({
      barcode: "",
      item_type: r.item_type,
      item_code: r.ic_code,
      item_name: r.item_name,
      unit_code: r.unit_code,
      balance_qty: parseInt(r.balance_qty) || 0,
      sold_out: r.sold_out,
      sum_sale: parseInt(r.sum_sale) || 0,
      wh_code: r.start_sale_wh,
      shelf_code: r.start_sale_shelf,
      stand_value: r.stand_value,
      divide_value: r.divide_value,
      ratio: r.ratio,
      favorite_item: r.favorite_item,
      price: r.price,
      is_return: r.is_return,
      description: r.description,
      promotion: [],
    }));

    resp.success = true;
    resp.data = data;
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ error: ex.message });
  }
});

// GET /service/v1/getProductSetItem
router.get("/getProductSetItem", async (req, res) => {
  const { item_code: strSetCode = "" } = req.query;
  const resp = { success: false };

  try {
    const sql = `
      WITH set_detail AS (
        SELECT d.ic_set_code, d.ic_code, d.unit_code, d.qty,
               d.price, d.sum_amount, d.barcode, d.price_ratio,
               d.line_number, d.roworder
        FROM ic_inventory_set_detail d
        WHERE d.ic_set_code = '${strSetCode.replace(/'/g, "''")}'
      ),
      balance_stock AS (
        SELECT s.ic_code, SUM(f.balance_qty) AS sum_balance_qty
        FROM set_detail s
        LEFT JOIN LATERAL (
          SELECT balance_qty
          FROM sml_ic_function_stock_balance_warehouse_location('NOW()', s.ic_code, '', '')
        ) f ON TRUE
        WHERE f.balance_qty > 0
        GROUP BY s.ic_code
      )
      SELECT s.ic_set_code, s.ic_code,
             i.name_1 AS item_name,
             s.unit_code, s.qty,
             COALESCE(b.sum_balance_qty,0) AS balance_qty,
             s.price, s.sum_amount, s.barcode, s.price_ratio,
             icu.stand_value, icu.divide_value,
             s.line_number, s.roworder
      FROM set_detail s
      LEFT JOIN ic_inventory i ON s.ic_code = i.code
      LEFT JOIN ic_inventory_detail d ON d.ic_code = s.ic_code
      LEFT JOIN balance_stock b ON s.ic_code = b.ic_code
      LEFT JOIN ic_unit_use icu ON icu.ic_code = s.ic_code AND icu.code = s.unit_code
      WHERE ${activeProductCondition("d")}
      ORDER BY COALESCE(s.line_number, s.roworder, 0), COALESCE(s.roworder, 0), s.ic_code
    `;

    const result = await query(sql, []);
    const data = result.rows.map((r) => ({
      item_code: r.ic_code,
      item_name: r.item_name,
      unit_code: r.unit_code,
      qty: r.qty,
      balance_qty: parseInt(r.balance_qty) || 0,
      price: r.price,
      sum_amount: r.sum_amount,
      barcode: r.barcode,
      price_ratio: r.price_ratio,
      stand_value: r.stand_value,
      divide_value: r.divide_value,
      line_number: r.line_number,
      roworder: r.roworder,
    }));

    resp.success = true;
    resp.data = data;
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ error: ex.message });
  }
});

// GET /service/v1/getProductBalancePrice
// เลียนแบบ Java: query ic_inventory_barcode + เรียก getProductPriceLocalx
router.get("/getProductBalancePrice", async (req, res) => {
  const {
    item_code: strItemCode = "",
    unit_code: strUnit = "",
    cust_code: strCust = "",
    sale_type: strSaleType = "",
    vat_type: strVatType = "",
    vat_rate: strVatRate = "",
    doc_date: strDocDate = "",
  } = req.query;
  const resp = { success: false };

  try {
    const sql = `
      SELECT a.ic_code, a.barcode, b.name_1 AS item_name, a.unit_code,
        COALESCE(b.tax_type,0) AS tax_type,
        (((COALESCE((SELECT MAX(balance_qty) FROM sml_ic_function_stock_balance_warehouse_location('NOW()',a.ic_code, '', '') WHERE ic_unit_code = a.unit_code),0)
           /((SELECT unit_standard_stand_value FROM ic_inventory WHERE code=a.ic_code)
             /(SELECT unit_standard_divide_value FROM ic_inventory WHERE code=a.ic_code))))
          -(SELECT accrued_out_qty FROM ic_inventory WHERE code=a.ic_code)) AS sum_balance_qty,
        COALESCE((SELECT MAX(balance_qty) FROM sml_ic_function_stock_balance_warehouse_location('NOW()',a.ic_code, '', '')),0) AS balance_qty,
        (CASE WHEN (COALESCE((SELECT MAX(balance_qty) FROM sml_ic_function_stock_balance_warehouse_location('NOW()',a.ic_code, '', '') WHERE ic_unit_code = a.unit_code LIMIT 1),0)
                /((SELECT unit_standard_stand_value FROM ic_inventory WHERE code=a.ic_code)
                  /(SELECT unit_standard_divide_value FROM ic_inventory WHERE code=a.ic_code)))
              <= ROUND((COALESCE(c.maximum_qty,0)*5)/100) THEN '1' ELSE '0' END) AS sold_out,
        COALESCE(((SELECT SUM(qty) FROM ic_trans_detail WHERE a.ic_code=item_code AND a.unit_code=unit_code AND doc_date BETWEEN '2025-01-01' AND 'NOW()')
          *(SELECT stand_value FROM ic_trans_detail WHERE a.ic_code=item_code AND a.unit_code=unit_code LIMIT 1)),0) AS sum_sale,
        COALESCE((SELECT status FROM ar_item_by_customer WHERE ic_code=a.ic_code AND ar_code='${strCust.replace(/'/g, "''")}' LIMIT 1),0) AS favorite_item,
        c.start_sale_wh, c.start_sale_shelf,
        0 AS price, icu.stand_value, icu.divide_value, icu.ratio
      FROM ic_inventory_barcode a
      LEFT JOIN ic_inventory b ON a.ic_code=b.code
      LEFT JOIN ic_inventory_detail c ON a.ic_code=c.ic_code
      LEFT JOIN ic_unit_use icu ON icu.code = a.unit_code AND icu.ic_code = a.ic_code
      WHERE a.ic_code = '${strItemCode.replace(/'/g, "''")}' AND a.unit_code = '${strUnit.replace(/'/g, "''")}'
        AND ${activeProductCondition("c")}
    `;

    const result = await query(sql, []);
    const basketCtx = await resolveBasketPricingContext(strCust);
    const saleTypeReq = parseInt(strSaleType, 10);
    const vatTypeReq = parseInt(strVatType, 10);
    const vatRateReq = parseFloat(strVatRate);
    const docDate = strDocDate.trim() || undefined;

    const data = [];

    for (const r of result.rows) {
      const obj = {
        barcode: r.barcode,
        item_code: r.ic_code,
        item_name: r.item_name,
        unit_code: r.unit_code,
        balance_qty: r.balance_qty,
        sold_out: r.sold_out,
        sum_sale: r.sum_sale,
        wh_code: r.start_sale_wh,
        shelf_code: r.start_sale_shelf,
        stand_value: r.stand_value,
        divide_value: r.divide_value,
        ratio: r.ratio,
        favorite_item: r.favorite_item,
        price: "0",
      };

      try {
        const saleType = Number.isNaN(saleTypeReq) ? (Number.isNaN(basketCtx.saleType) ? 0 : basketCtx.saleType) : saleTypeReq;
        const vatType = Number.isNaN(vatTypeReq)
          ? (Number.isNaN(basketCtx.vatType) ? (parseInt(r.tax_type, 10) || 0) : basketCtx.vatType)
          : vatTypeReq;
        const vatRate = Number.isNaN(vatRateReq)
          ? (Number.isNaN(basketCtx.vatRate) ? null : basketCtx.vatRate)
          : vatRateReq;

        const prices = await getProductPriceLocalx(r.ic_code, r.unit_code, "1", strCust, vatType, vatRate, saleType, r.barcode, docDate);
        const arr = prices.data || [];
        if (arr.length > 0) {
          obj.price = arr[0].price !== undefined ? String(arr[0].price) : "0";
        }
      } catch (_) {}

      data.push(obj);
    }

    resp.success = true;
    resp.data = data;
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getProductPrice
// ดึงราคาสินค้าตัวเดียวผ่าน getProductPriceLocalx โดยตรง — ใช้สำหรับ catalog lazy-price
router.get("/getProductPrice", async (req, res) => {
  const {
    item_code: strItemCode = "",
    unit_code: strUnitCode = "",
    qty: strQty = "1",
    cust_code: strCustCode = "",
    vat_type: strVatType = "",
    sale_type: strSaleType = "",
    vat_rate: strVatRate = "",
    barcode: strBarcode = "",
    doc_date: strDocDate = "",
  } = req.query;

  const resp = { success: false };

  try {
    const basketCtx = await resolveBasketPricingContext(strCustCode);

    let vatType = parseInt(strVatType, 10);
    if (Number.isNaN(vatType)) {
      vatType = Number.isNaN(basketCtx.vatType) ? 0 : basketCtx.vatType;
    }

    let saleType = parseInt(strSaleType, 10);
    if (Number.isNaN(saleType)) {
      saleType = Number.isNaN(basketCtx.saleType) ? 0 : basketCtx.saleType;
    }

    let vatRate = parseFloat(strVatRate);
    if (Number.isNaN(vatRate)) {
      vatRate = Number.isNaN(basketCtx.vatRate) ? null : basketCtx.vatRate;
    }

    const docDate = strDocDate.trim() || undefined;
    let barcodeForPrice = strBarcode.trim();
    if (!barcodeForPrice && strItemCode.trim() && strUnitCode.trim()) {
      try {
        const barcodeResult = await query(
          `SELECT barcode FROM ic_inventory_barcode WHERE ic_code=$1 AND unit_code=$2 ORDER BY barcode LIMIT 1`,
          [strItemCode.trim(), strUnitCode.trim()],
        );
        barcodeForPrice = barcodeResult.rows[0]?.barcode || "";
      } catch (_) {}
    }
    const result = await getProductPriceLocalx(strItemCode, strUnitCode, strQty || "1", strCustCode, vatType, vatRate, saleType, barcodeForPrice, docDate);
    resp.success = true;
    resp.data = result.data || [];
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getCategoryList
// เลียนแบบ Java: SELECT code, name_1 FROM ic_category
router.get("/getCategoryList", async (req, res) => {
  const resp = { success: false };
  try {
    const result = await query("SELECT code, name_1 FROM ic_category", []);
    const data = result.rows.map((r) => ({ code: r.code, name: r.name_1 }));
    resp.success = true;
    resp.data = data;
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getProductByBarcode
// ค้นหาสินค้าจากบาร์โค้ดใน ic_inventory_barcode
router.get("/getProductByBarcode", async (req, res) => {
  const {
    barcode: strBarcode = "",
    exclude_hold_sale: strExcludeHoldSale = "",
    exclude_hold_purchase: strExcludeHoldPurchase = "",
  } = req.query;
  const resp = { success: false };

  if (!strBarcode.trim()) {
    return res.status(400).json({ ERROR: "barcode is required" });
  }

  try {
    const holdWhere = [
      activeProductCondition("d"),
      strExcludeHoldSale === "1" ? "COALESCE(d.is_hold_sale,0) <> 1" : "",
      strExcludeHoldPurchase === "1" ? "COALESCE(d.is_hold_purchase,0) <> 1" : "",
    ].filter(Boolean).join(" AND ");

    const result = await query(
      `SELECT b.ic_code AS item_code, i.name_1 AS item_name,
        i.item_type, i.unit_standard, i.unit_cost, d.start_sale_unit,
        CASE WHEN COALESCE(i.item_type,0) = 1 THEN '0'
             WHEN COALESCE(i.balance_qty,0) <= 0 THEN '1'
             ELSE '0'
        END AS sold_out
       FROM ic_inventory_barcode b
       JOIN ic_inventory i ON i.code = b.ic_code
       LEFT JOIN ic_inventory_detail d ON d.ic_code = i.code
       WHERE b.barcode = $1
       ${holdWhere ? `AND ${holdWhere}` : ""}
       LIMIT 1`,
      [strBarcode.trim()],
    );

    if (result.rows.length === 0) {
      resp.success = false;
      resp.data = null;
      return res.json(resp);
    }

    resp.success = true;
    resp.data = {
      item_code: result.rows[0].item_code,
      item_name: result.rows[0].item_name,
      item_type: result.rows[0].item_type,
      unit_standard: result.rows[0].unit_standard,
      unit_cost: result.rows[0].unit_cost,
      start_sale_unit: result.rows[0].start_sale_unit,
      sold_out: result.rows[0].sold_out,
    };
    return res.json(resp);
  } catch (ex) {
    console.error("getProductByBarcode error:", ex.message);
    return res.status(500).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getProductByBarcodeDetail
// ใช้สำหรับหน้าขาย BizSuit: คืนหน่วย/ratio/stock ที่ผูกกับ barcode โดยตรง
router.get("/getProductByBarcodeDetail", async (req, res) => {
  const { barcode: strBarcode = "" } = req.query;
  const resp = { success: false };

  if (!strBarcode.trim()) {
    return res.status(400).json({ ERROR: "barcode is required" });
  }

  try {
    const result = await query(
      `WITH barcode_row AS (
         SELECT
           b.ic_code AS item_code,
           COALESCE(b.unit_code, '') AS barcode_unit_code,
           b.barcode,
           i.name_1 AS item_name,
           i.item_type,
           COALESCE(i.tax_type, 0) AS tax_type,
           i.unit_standard,
           i.unit_cost,
           COALESCE(i.unit_standard_stand_value, 1) AS unit_standard_stand_value,
           COALESCE(i.unit_standard_divide_value, 1) AS unit_standard_divide_value,
           d.start_sale_unit,
           d.start_sale_wh,
           d.start_sale_shelf
         FROM ic_inventory_barcode b
         JOIN ic_inventory i ON i.code = b.ic_code
         LEFT JOIN ic_inventory_detail d ON d.ic_code = i.code
         WHERE b.barcode = $1
           AND ${activeProductCondition("d")}
         LIMIT 1
       ),
       resolved AS (
         SELECT *,
           COALESCE(NULLIF(barcode_unit_code, ''), NULLIF(start_sale_unit, ''), NULLIF(unit_standard, ''), NULLIF(unit_cost, '')) AS unit_code
         FROM barcode_row
       ),
       balance_stock AS (
         SELECT ic_code, SUM(balance_qty) AS sum_balance_qty
         FROM sml_ic_function_stock_balance_warehouse_location('NOW()', (SELECT item_code FROM resolved), '', '')
         WHERE balance_qty > 0
         GROUP BY ic_code
       )
       SELECT
         r.item_code,
         r.item_name,
         r.item_type,
         r.tax_type,
         r.unit_code,
         r.barcode,
         r.start_sale_wh AS wh_code,
         r.start_sale_shelf AS shelf_code,
         COALESCE(u.stand_value, r.unit_standard_stand_value, 1) AS stand_value,
         COALESCE(u.divide_value, r.unit_standard_divide_value, 1) AS divide_value,
         COALESCE(
           u.ratio,
           CASE WHEN COALESCE(r.unit_standard_divide_value, 1) <> 0
                THEN COALESCE(r.unit_standard_stand_value, 1)::numeric / COALESCE(r.unit_standard_divide_value, 1)::numeric
                ELSE 1
           END
         ) AS ratio,
         COALESCE(bs.sum_balance_qty, 0) AS sum_balance_qty,
         TRUNC(
           COALESCE(bs.sum_balance_qty, 0)
           / COALESCE(NULLIF(COALESCE(u.ratio, 1), 0), 1),
           0
         ) AS balance_qty,
         CASE WHEN COALESCE(r.item_type, 0) = 1 THEN '0'
              WHEN COALESCE(bs.sum_balance_qty, 0) <= 0 THEN '1'
              ELSE '0'
         END AS sold_out
       FROM resolved r
       LEFT JOIN ic_unit_use u ON u.ic_code = r.item_code AND u.code = r.unit_code
       LEFT JOIN balance_stock bs ON bs.ic_code = r.item_code`,
      [strBarcode.trim()],
    );

    if (result.rows.length === 0) {
      resp.success = false;
      resp.data = null;
      return res.json(resp);
    }

    resp.success = true;
    resp.data = result.rows[0];
    return res.json(resp);
  } catch (ex) {
    console.error("getProductByBarcodeDetail error:", ex.message);
    return res.status(500).json({ ERROR: ex.message });
  }
});

// POST /service/v1/adjustStock
// ตรวจนับสต๊อก (76) + ปรับปรุงผลต่าง: เพิ่ม (66) หรือ ลด (68)
router.post("/adjustStock", async (req, res) => {
  const { item_code = "", item_name = "", unit_code = "", barcode = "", wh_code = "", shelf_code = "", branch_code = "", emp_code = "", creator_code = "", qty } = req.body;
  const resp = { success: false };
  const check_qty = Number(qty);
  let lastSqlContext = null;

  const compactSql = (sql) => String(sql || "").replace(/\s+/g, " ").trim();
  const logSqlStart = (ctx) => {
    if (!ADJUST_STOCK_SQL_DEBUG) return;
    console.log(`[adjustStock][${ctx.label}] SQL: ${ctx.sql}`);
    console.log(`[adjustStock][${ctx.label}] params: ${JSON.stringify(ctx.params)}`);
  };
  const logSqlDone = (ctx, rowCount) => {
    if (!ADJUST_STOCK_SQL_DEBUG) return;
    console.log(`[adjustStock][${ctx.label}] done in ${Date.now() - ctx.startedAt} ms, rowCount=${rowCount}`);
  };

  const runQuery = async (label, sql, params = []) => {
    const ctx = { label, sql: compactSql(sql), params, startedAt: Date.now() };
    lastSqlContext = ctx;
    logSqlStart(ctx);
    try {
      const rs = await query(sql, params);
      logSqlDone(ctx, rs.rowCount ?? rs.rows?.length ?? 0);
      return rs;
    } catch (ex) {
      ex.adjustStockSqlContext = ctx;
      throw ex;
    }
  };

  const runTxQuery = async (client, label, sql, params = []) => {
    const ctx = { label, sql: compactSql(sql), params, startedAt: Date.now() };
    lastSqlContext = ctx;
    logSqlStart(ctx);
    try {
      const rs = await client.query(sql, params);
      logSqlDone(ctx, rs.rowCount ?? rs.rows?.length ?? 0);
      return rs;
    } catch (ex) {
      ex.adjustStockSqlContext = ctx;
      throw ex;
    }
  };

  if (!item_code || qty === undefined || qty === null) {
    return res.status(400).json({ ERROR: "item_code and qty are required" });
  }
  if (!Number.isFinite(check_qty) || check_qty < 0) {
    return res.status(400).json({ ERROR: "qty must be a valid non-negative number" });
  }

  try {
    const now = new Date();
    let balanceSyncWarning = "";
    const doc_date = now.toISOString().slice(0, 10);
    const doc_time = now.toTimeString().slice(0, 5);

    // generate doc_no รูปแบบ MSTCYYYYDDMM-#### running 4 หลัก
    const yyyy = String(now.getFullYear());
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const prefix = `MSTC${yyyy}${dd}${mm}-`;
    const lastRes = await runQuery("load-last-stock-count-doc", `SELECT doc_no FROM ic_trans WHERE doc_no LIKE $1 ORDER BY doc_no DESC LIMIT 1`, [`${prefix}%`]);
    const lastRunning = lastRes.rows.length > 0 ? parseInt(lastRes.rows[0].doc_no.slice(-4), 10) : 0;
    const doc_no = `${prefix}${String(lastRunning + 1).padStart(4, "0")}`;

    // generate doc_no_adj รูปแบบ ISYYYYMMDD-#### running 4 หลัก
    const adjPrefix = `IS${yyyy}${mm}${dd}-`;
    const lastAdjRes = await runQuery("load-last-adjust-doc", `SELECT doc_no FROM ic_trans WHERE doc_no LIKE $1 ORDER BY doc_no DESC LIMIT 1`, [`${adjPrefix}%`]);
    const lastAdjRunning = lastAdjRes.rows.length > 0 ? parseInt(lastAdjRes.rows[0].doc_no.slice(-4), 10) : 0;
    const doc_no_adj = `${adjPrefix}${String(lastAdjRunning + 1).padStart(4, "0")}`;

    // ดึง ratio, stand_value, divide_value จาก ic_unit_use
    const unitRes = await runQuery(`load-unit-use`, `SELECT ratio, stand_value, divide_value FROM ic_unit_use WHERE ic_code = $1 AND code = $2 LIMIT 1`, [item_code, unit_code]);
    const unitRow = unitRes.rows[0] || {};
    if (!unitRes.rows.length) {
      return res.status(400).json({ ERROR: `unit setup not found for item_code=${item_code}, unit_code=${unit_code}` });
    }
    const stand_value = Number(unitRow.stand_value);
    const divide_value = Number(unitRow.divide_value);
    const ratioFromRow = Number(unitRow.ratio);
    if (!Number.isFinite(stand_value) || !Number.isFinite(divide_value) || stand_value <= 0 || divide_value <= 0) {
      return res.status(400).json({
        ERROR: "invalid unit setup: stand_value and divide_value must be > 0",
        unit: { item_code, unit_code, stand_value: unitRow.stand_value, divide_value: unitRow.divide_value, ratio: unitRow.ratio },
      });
    }
    const ratio = Number.isFinite(ratioFromRow) && ratioFromRow > 0 ? ratioFromRow : stand_value / divide_value;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      return res.status(400).json({
        ERROR: "invalid unit setup: ratio must be > 0",
        unit: { item_code, unit_code, stand_value: unitRow.stand_value, divide_value: unitRow.divide_value, ratio: unitRow.ratio },
      });
    }

    // คำนวณยอดคงเหลือปัจจุบัน (base units) เพื่อหา diff
    await syncProductUnitType(pool, item_code);

    const balRes = await runQuery(
      "load-current-balance",
      `SELECT COALESCE(SUM(balance_qty), 0) AS sum_balance_qty
       FROM sml_ic_function_stock_balance_warehouse_location('NOW()', $1, $2, $3)`,
      [item_code, wh_code, shelf_code],
    );
  
    const sum_balance_qty = Number(balRes.rows[0]?.sum_balance_qty ?? 0);

      const balance_in_unit = Math.floor(sum_balance_qty / ratio);
    const diff_qty = check_qty - balance_in_unit;

    await withTransaction(async (client) => {
      // 1. ic_trans_detail_temp (log scan)
        await runTxQuery(
          client,
          "insert-ic_trans_detail_temp",
        `INSERT INTO ic_trans_detail_temp
          (doc_no, doc_date, trans_flag, item_code, item_name, unit_code, barcode,
           wh_code, shelf_code, doc_time, user_code, qty)
         VALUES ($1, NOW(), 13, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [doc_no, item_code, item_name, unit_code, barcode, wh_code, shelf_code, doc_time, emp_code, check_qty],
      );

      // 2. ic_trans header (76 = ตรวจนับ)
        await runTxQuery(
          client,
          "insert-ic_trans-76-header",
        `INSERT INTO ic_trans
          (trans_flag, trans_type, doc_no, doc_date, doc_time, doc_format_code,
           remark, branch_code, wh_from, location_from)
         VALUES (76, 3, $1, $2, $3, 'CO', 'ปรับปรุงสต๊อกไม่ตรง', $4, $5, $6)`,
        [doc_no, doc_date, doc_time, branch_code, wh_code, shelf_code],
      );
        await runTxQuery(
          client,
          "update-ic_trans-76-creator",
        `UPDATE ic_trans SET creator_code = $1 WHERE doc_no = $2 AND trans_flag = 76`,
        [creator_code, doc_no],
      );

      // 3. ic_trans_detail (76)
        const detailRes = await runTxQuery(
          client,
          "insert-ic_trans_detail-76",
        `INSERT INTO ic_trans_detail
          (trans_flag, trans_type, calc_flag, doc_no, doc_date, doc_time,
           doc_date_calc, doc_time_calc, last_status, line_number,
           ratio, stand_value, divide_value,
           item_code, item_name, unit_code, qty,
           wh_code, shelf_code, branch_code)
         VALUES (76, 3, 1, $1, $2, $3, $2, $3, 0, 0, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [doc_no, doc_date, doc_time, ratio, stand_value, divide_value, item_code, item_name, unit_code, check_qty, wh_code, shelf_code, branch_code],
      );
      if (detailRes.rowCount === 0) {
        throw new Error("ic_trans_detail(76): insert failed (rowCount=0)");
      }

      // 4. เอกสารปรับผลต่าง — 66 (เพิ่ม) หรือ 68 (ลด) เฉพาะเมื่อ diff != 0
      if (diff_qty !== 0) {
        const adj_flag = diff_qty > 0 ? 66 : 68;
        const adj_calc_flag = diff_qty > 0 ? 1 : -1;
        const adj_qty = Math.abs(diff_qty);

        await runTxQuery(
          client,
          "insert-ic_trans-adjust-header",
          `INSERT INTO ic_trans
            (trans_flag, trans_type, doc_no, doc_date, doc_time, doc_format_code,
             branch_code, wh_from, location_from,doc_ref)
           VALUES ($1, 3, $2, $3, $4, 'IS', $5, $6, $7, $8)`,
          [adj_flag, doc_no_adj, doc_date, doc_time, branch_code, wh_code, shelf_code, doc_no],
        );
        await runTxQuery(
          client,
          "update-ic_trans-adjust-creator",
          `UPDATE ic_trans SET creator_code = $1 WHERE doc_no = $2 AND trans_flag = $3`,
          [creator_code, doc_no_adj, adj_flag],
        );

        await runTxQuery(
          client,
          "insert-ap_ar_trans_detail",
          `INSERT INTO ap_ar_trans_detail (
            trans_type,trans_flag,doc_date,doc_no,billing_no,calc_flag)
            VALUES (2, $1, $2, $3, $4, $5)`,
          [adj_flag, doc_date, doc_no_adj, doc_no, adj_calc_flag],
        );

        const adjRes = await runTxQuery(
          client,
          "insert-ic_trans_detail-adjust",
          `INSERT INTO ic_trans_detail
            (trans_flag, trans_type, calc_flag, doc_no, doc_date, doc_time,
             doc_date_calc, doc_time_calc, last_status, line_number,
             ratio, stand_value, divide_value,
             item_code, item_name, unit_code, qty,
             wh_code, shelf_code, branch_code, doc_ref)
           VALUES ($1, 3, $2, $3, $4, $5, $4, $5, 0, 0, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [adj_flag, adj_calc_flag, doc_no_adj, doc_date, doc_time, ratio, stand_value, divide_value, item_code, item_name, unit_code, adj_qty, wh_code, shelf_code, branch_code, doc_no],
        );
        if (adjRes.rowCount === 0) {
          throw new Error(`ic_trans_detail(${adj_flag}): insert failed (rowCount=0)`);
        }
      }

      // 5. process queue
      const docNos = diff_qty !== 0 ? [doc_no, doc_no_adj] : [doc_no];
      await runTxQuery(
        client,
        "insert-process-queue",
        `INSERT INTO process (process_name, wherein)
         SELECT 'IC', item_code FROM ic_trans_detail WHERE doc_no = ANY($1::text[]) and trans_flag = '76' `,
        [docNos],
      );

      // 6. อัปเดต balance_qty ใน ic_inventory จากยอดจริงหลังปรับ
      try {
        const newBalRes = await runTxQuery(
          client,
          "load-new-item-balance",
          `SELECT COALESCE(SUM(balance_qty), 0) AS new_balance
           FROM sml_ic_function_stock_balance_warehouse_location('NOW()', $1, '', '')`,
          [item_code],
        );
        const new_balance = Number(newBalRes.rows[0].new_balance);
        if (Number.isFinite(new_balance)) {
          await runTxQuery(client, "update-ic_inventory-balance", `UPDATE ic_inventory SET balance_qty = $1 WHERE code = $2`, [new_balance, item_code]);
        }
      } catch (balanceEx) {
        const ctx = balanceEx.adjustStockSqlContext || lastSqlContext;
        balanceSyncWarning = "balance sync skipped due to stock-balance function error";
        if (ctx) {
          console.error(`[adjustStock][${ctx.label}] non-critical sync error:`, balanceEx.message);
          console.error(`[adjustStock][${ctx.label}] SQL: ${ctx.sql}`);
          console.error(`[adjustStock][${ctx.label}] params: ${JSON.stringify(ctx.params)}`);
        } else {
          console.error("[adjustStock] non-critical balance sync error:", balanceEx.message);
        }
      }
    });

    resp.success = true;
    resp.doc_no = doc_no;
    resp.balance_qty = balance_in_unit;
    resp.check_qty = check_qty;
    resp.diff_qty = diff_qty;
    if (balanceSyncWarning) {
      resp.warning = balanceSyncWarning;
    }
    return res.json(resp);
  } catch (ex) {
    const sqlCtx = ex.adjustStockSqlContext || lastSqlContext;
    if (sqlCtx) {
      console.error(`[adjustStock][${sqlCtx.label}] error:`, ex.message);
      console.error(`[adjustStock][${sqlCtx.label}] SQL: ${sqlCtx.sql}`);
      console.error(`[adjustStock][${sqlCtx.label}] params: ${JSON.stringify(sqlCtx.params)}`);
    } else {
      console.error("adjustStock error:", ex.message);
    }
    const errorResponse = { ERROR: ex.message };
    if (ADJUST_STOCK_SQL_DEBUG && sqlCtx) {
      errorResponse.query_debug = {
        label: sqlCtx.label,
        sql: sqlCtx.sql,
        params: sqlCtx.params,
      };
    }
    return res.status(500).json(errorResponse);
  }
});

// GET /service/v1/getInventoryBalance
router.get("/getInventoryBalance", async (req, res) => {
  const { item_code = "", wh_code = "", shelf_code = "" } = req.query;
  if (!item_code) return res.status(400).json({ ERROR: "item_code is required" });
  try {
    const balRes = await query(
      `SELECT COALESCE(SUM(balance_qty), 0) AS sum_balance_qty
       FROM sml_ic_function_stock_balance_warehouse_location('NOW()', $1, $2, $3)`,
      [item_code, wh_code, shelf_code],
    );
    return res.json({ success: true, data: { sum_balance_qty: Number(balRes.rows[0].sum_balance_qty) } });
  } catch (ex) {
    console.error("getInventoryBalance error:", ex.message);
    return res.status(500).json({ ERROR: ex.message });
  }
});

// ========== MASTER DATA DROPDOWNS ==========

// helper ลด code ซ้ำสำหรับ master data ที่มี search filter
function makeMasterListRoute(tableName, extraFields = "") {
  return async (req, res) => {
    const s = (req.query.search || "").trim();
    const like = `%${s}%`;
    try {
      const result = await query(`SELECT code, name_1${extraFields} FROM ${tableName}` + ` WHERE ($1 = '' OR code ILIKE $2 OR name_1 ILIKE $2)` + ` ORDER BY code`, [s, like]);
      return res.json({ success: true, data: result.rows });
    } catch (ex) {
      console.error(`${tableName} list error:`, ex.message);
      return res.status(500).json({ success: false, message: ex.message });
    }
  };
}

// GET /service/v1/getProductGroupList
router.get("/getProductGroupList", makeMasterListRoute("ic_group"));
// GET /service/v1/getProductGroupSubList
router.get("/getProductGroupSubList", makeMasterListRoute("ic_group_sub"));
// GET /service/v1/getProductGroupSub2List
router.get("/getProductGroupSub2List", makeMasterListRoute("ic_group_sub2"));
// GET /service/v1/getProductBrandList
router.get("/getProductBrandList", makeMasterListRoute("ic_brand"));
// GET /service/v1/getProductCategoryList
router.get("/getProductCategoryList", makeMasterListRoute("ic_category"));
// GET /service/v1/getProductDesignList
router.get("/getProductDesignList", makeMasterListRoute("ic_design"));
// GET /service/v1/getProductModelList
router.get("/getProductModelList", makeMasterListRoute("ic_model"));

// GET /service/v1/getUnitManageList
router.get("/getUnitManageList", async (req, res) => {
  const s = (req.query.search || "").trim();
  const like = `%${s}%`;
  try {
    const result = await query(
      `SELECT code, COALESCE(name_1,'') AS name_1, COALESCE(name_2,'') AS name_2` + ` FROM ic_unit` + ` WHERE ($1 = '' OR code ILIKE $2 OR name_1 ILIKE $2 OR name_2 ILIKE $2)` + ` ORDER BY code`,
      [s, like],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    console.error("getUnitManageList error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// ========== PRODUCT MANAGE LIST ==========

// GET /service/v1/getProductManageList
// port จาก Java getProductManageList — parameterized WHERE, sort whitelist, parallel count
router.get("/getProductManageList", async (req, res) => {
  const { search = "", group = "", groupsub = "", groupsub2 = "", brand = "", category = "", design = "", model = "", sort_field = "", sort_order = "", offset = "0", limit = "20" } = req.query;

  const s = search.trim();
  const g = group.trim() === "all" ? "" : group.trim();
  const gs = groupsub.trim() === "all" ? "" : groupsub.trim();
  const gs2 = groupsub2.trim() === "all" ? "" : groupsub2.trim();
  const br = brand.trim() === "all" ? "" : brand.trim();
  const cat = category.trim() === "all" ? "" : category.trim();
  const des = design.trim() === "all" ? "" : design.trim();
  const mod = model.trim() === "all" ? "" : model.trim();

  const offsetNum = Math.max(0, parseInt(offset) || 0);
  let limitNum = parseInt(limit) || 20;
  if (limitNum <= 0 || limitNum > 500) limitNum = 20;

  const sortWhitelist = {
    code: "i.code",
    name_1: "i.name_1",
    balance_qty: "COALESCE(i.balance_qty,0)",
    book_out_qty: "COALESCE(i.book_out_qty,0)",
    accrued_out_qty: "COALESCE(i.accrued_out_qty,0)",
    accrued_in_qty: "COALESCE(i.accrued_in_qty,0)",
    purchase_point: "COALESCE(d.purchase_point,0)",
    minimum_qty: "COALESCE(d.minimum_qty,0)",
    maximum_qty: "COALESCE(d.maximum_qty,0)",
  };
  const sortCol = sortWhitelist[sort_field] || "code";
  const sortDir = sort_order === "desc" ? "DESC" : "ASC";
  const orderBy = `${sortCol} ${sortDir}`;

  const whereParams = [];
  const whereParts = [activeProductCondition("d")];
  const addParam = (value) => {
    whereParams.push(value);
    return `$${whereParams.length}`;
  };

  const keywords = s.split(/\s+/).filter(Boolean);
  if (keywords.length > 0) {
    const fields = ["i.name_1", "i.code", "i.name_eng_1", "i.name_eng_2"];
    const fieldParts = fields.map((field) => {
      const keywordParts = keywords.map((keyword) => `${field} ILIKE ${addParam(`%${keyword}%`)}`);
      return `(${keywordParts.join(" AND ")})`;
    });
    const barcodeParts = keywords.map((keyword) => `ibc.barcode ILIKE ${addParam(`%${keyword}%`)}`);
    fieldParts.push(
      `EXISTS (SELECT 1 FROM ic_inventory_barcode ibc WHERE ibc.ic_code = i.code AND (${barcodeParts.join(" AND ")}))`,
    );
    whereParts.push(`(${fieldParts.join(" OR ")})`);
  }

  if (g) whereParts.push(`i.group_main = ${addParam(g)}`);
  if (gs) whereParts.push(`i.group_sub = ${addParam(gs)}`);
  if (gs2) whereParts.push(`i.group_sub2 = ${addParam(gs2)}`);
  if (br) whereParts.push(`i.item_brand = ${addParam(br)}`);
  if (cat) whereParts.push(`i.item_category = ${addParam(cat)}`);
  if (des) whereParts.push(`i.item_design = ${addParam(des)}`);
  if (mod) whereParts.push(`i.item_model = ${addParam(mod)}`);

  const whereSql = whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";

  try {
    const dataParams = [...whereParams, offsetNum, limitNum];
    const offsetParam = `$${whereParams.length + 1}`;
    const limitParam = `$${whereParams.length + 2}`;
    const [countRes, dataRes] = await Promise.all([
      query(`SELECT COUNT(*) AS cnt FROM ic_inventory i LEFT JOIN ic_inventory_detail d ON d.ic_code = i.code${whereSql}`, whereParams),
      query(
        `SELECT i.code, COALESCE(i.name_1,'') AS name_1, COALESCE(i.name_eng_1,'') AS name_eng_1,` +
          ` COALESCE(i.unit_standard,'') AS unit_standard,` +
          ` COALESCE(i.balance_qty,0) AS balance_qty, COALESCE(i.book_out_qty,0) AS book_out_qty,` +
          ` COALESCE(i.accrued_out_qty,0) AS accrued_out_qty, COALESCE(i.accrued_in_qty,0) AS accrued_in_qty,` +
          ` COALESCE(d.purchase_point,0) AS purchase_point, COALESCE(d.minimum_qty,0) AS minimum_qty,` +
          ` COALESCE(d.maximum_qty,0) AS maximum_qty` +
          ` FROM ic_inventory i LEFT JOIN ic_inventory_detail d ON d.ic_code = i.code${whereSql}` +
          ` ORDER BY ${orderBy} OFFSET ${offsetParam} LIMIT ${limitParam}`,
        dataParams,
      ),
    ]);
    const totalCount = parseInt(countRes.rows[0].cnt) || 0;
    return res.json({ success: true, data: dataRes.rows, totalCount });
  } catch (ex) {
    console.error("getProductManageList error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// GET /service/v1/getPurchaseStockReorderList
router.get("/getPurchaseStockReorderList", async (req, res) => {
  const { search = "", sort_field = "", sort_order = "", offset = "0", limit = "50", only_reorder = "0" } = req.query;
  const s = String(search || "").trim();
  const onlyReorder = String(only_reorder || "").toLowerCase() === "1" || String(only_reorder || "").toLowerCase() === "true";
  const offsetNum = Math.max(0, parseInt(offset) || 0);
  let limitNum = parseInt(limit) || 50;
  if (limitNum <= 0 || limitNum > 500) limitNum = 50;

  const sortWhitelist = {
    item_code: "item_code",
    item_name: "item_name",
    real_balance_qty: "real_balance_qty",
    cart_qty: "cart_qty",
    available_qty: "available_qty",
    purchase_point: "purchase_point",
    minimum_qty: "minimum_qty",
    maximum_qty: "maximum_qty",
    suggest_qty: "suggest_qty",
    reached_reorder_point: "reached_reorder_point",
  };
  const sortCol = sortWhitelist[sort_field] || "available_qty";
  const sortDir = sort_order === "desc" ? "DESC" : "ASC";
  const stockSortFields = new Set(["real_balance_qty", "cart_qty", "available_qty", "suggest_qty", "reached_reorder_point"]);

  const whereParams = [];
  const whereParts = [
    "COALESCE(i.item_type,0) NOT IN (1,3)",
    activeProductCondition("d"),
  ];
  const addParam = (value) => {
    whereParams.push(value);
    return `$${whereParams.length}`;
  };

  const keywords = s.split(/\s+/).filter(Boolean);
  if (keywords.length > 0) {
    const fields = ["i.name_1", "i.code", "i.name_eng_1", "i.name_eng_2"];
    const fieldParts = fields.map((field) => {
      const keywordParts = keywords.map((keyword) => `${field} ILIKE ${addParam(`%${keyword}%`)}`);
      return `(${keywordParts.join(" AND ")})`;
    });
    const barcodeParts = keywords.map((keyword) => `ibc.barcode ILIKE ${addParam(`%${keyword}%`)}`);
    fieldParts.push(
      `EXISTS (SELECT 1 FROM ic_inventory_barcode ibc WHERE ibc.ic_code = i.code AND (${barcodeParts.join(" AND ")}))`,
    );
    whereParts.push(`(${fieldParts.join(" OR ")})`);
  }
  if (onlyReorder) {
    whereParts.push("COALESCE(d.purchase_point,0) > 0");
  }

  const offsetParam = `$${whereParams.length + 1}`;
  const limitParam = `$${whereParams.length + 2}`;

  try {
    if (!onlyReorder && !stockSortFields.has(sort_field)) {
      const countRes = await query(
        `SELECT COUNT(*) AS cnt
         FROM ic_inventory i
         JOIN ic_inventory_detail d ON d.ic_code = i.code
         WHERE ${whereParts.join(" AND ")}`,
        whereParams,
      );
      const result = await query(
        `WITH candidates AS (
           SELECT
             i.code AS item_code,
             COALESCE(i.name_1,'') AS item_name,
             COALESCE(i.name_eng_1,'') AS item_name_eng,
             COALESCE(i.unit_standard,'') AS unit_code,
             COALESCE(un.name_1, i.unit_standard, '') AS unit_name,
             COALESCE(d.purchase_point,0)::numeric AS purchase_point,
             COALESCE(d.minimum_qty,0)::numeric AS minimum_qty,
             COALESCE(d.maximum_qty,0)::numeric AS maximum_qty
           FROM ic_inventory i
           JOIN ic_inventory_detail d ON d.ic_code = i.code
           LEFT JOIN ic_unit un ON un.code = i.unit_standard
           WHERE ${whereParts.join(" AND ")}
           ORDER BY ${sortCol} ${sortDir}, i.code ASC
           OFFSET ${offsetParam} LIMIT ${limitParam}
         ),
         item_code_list AS (
           SELECT string_agg(item_code, ',') AS codes
           FROM candidates
         ),
         stock AS (
           SELECT s.ic_code, SUM(s.balance_qty)::numeric AS real_balance_qty
           FROM item_code_list icl
           CROSS JOIN LATERAL sml_ic_function_stock_balance_warehouse_location('NOW()', icl.codes, '', '') s
           WHERE icl.codes IS NOT NULL
           GROUP BY s.ic_code
         ),
         cart AS (
           SELECT
             c.item_code,
             SUM(
               COALESCE(c.qty,0)::numeric
               * COALESCE(u.stand_value,1)::numeric
               / NULLIF(COALESCE(u.divide_value,1),0)::numeric
             ) AS cart_qty
           FROM staff_cart_order c
           LEFT JOIN ic_unit_use u
                  ON u.ic_code = c.item_code
                 AND u.code = c.unit_code
           WHERE c.item_code IN (SELECT item_code FROM candidates)
           GROUP BY c.item_code
         ),
         availability AS (
           SELECT
             c.item_code,
             c.item_name,
             c.item_name_eng,
             c.unit_code,
             c.unit_name,
             COALESCE(s.real_balance_qty,0)::numeric AS real_balance_qty,
             COALESCE(cart.cart_qty,0)::numeric AS cart_qty,
             (COALESCE(s.real_balance_qty,0) - COALESCE(cart.cart_qty,0))::numeric AS available_qty,
             c.purchase_point,
             c.minimum_qty,
             c.maximum_qty
           FROM candidates c
           LEFT JOIN stock s ON s.ic_code = c.item_code
           LEFT JOIN cart ON cart.item_code = c.item_code
         )
         SELECT
           *,
           (purchase_point > 0 AND available_qty <= purchase_point) AS reached_reorder_point,
           CASE
             WHEN purchase_point > 0 AND available_qty <= purchase_point THEN
               GREATEST(
                 minimum_qty,
                 CASE
                   WHEN maximum_qty > 0 THEN maximum_qty - available_qty
                   ELSE minimum_qty
                 END,
                 0
               )
             ELSE 0
           END::numeric AS suggest_qty,
           COALESCE(SUM(
             CASE
               WHEN purchase_point > 0 AND available_qty <= purchase_point THEN
                 GREATEST(
                   minimum_qty,
                   CASE
                     WHEN maximum_qty > 0 THEN maximum_qty - available_qty
                     ELSE minimum_qty
                   END,
                   0
                 )
               ELSE 0
             END
           ) OVER(),0)::numeric AS total_suggest_qty
         FROM availability
         ORDER BY ${sortCol} ${sortDir}, item_code ASC`,
        [...whereParams, offsetNum, limitNum],
      );

      const totalCount = Number(countRes.rows[0]?.cnt || 0);
      const totalSuggestQty = Number(result.rows[0]?.total_suggest_qty || 0);
      const rows = result.rows.map(({ total_suggest_qty, ...row }) => ({
        ...row,
        real_balance_qty: Number(row.real_balance_qty || 0),
        cart_qty: Number(row.cart_qty || 0),
        available_qty: Number(row.available_qty || 0),
        purchase_point: Number(row.purchase_point || 0),
        minimum_qty: Number(row.minimum_qty || 0),
        maximum_qty: Number(row.maximum_qty || 0),
        suggest_qty: Number(row.suggest_qty || 0),
        reached_reorder_point: row.reached_reorder_point === true || row.reached_reorder_point === "true",
      }));
      return res.json({ success: true, data: rows, totalCount, totalSuggestQty });
    }

    const result = await query(
      `WITH candidates AS (
         SELECT
           i.code AS item_code,
           COALESCE(i.name_1,'') AS item_name,
           COALESCE(i.name_eng_1,'') AS item_name_eng,
           COALESCE(i.unit_standard,'') AS unit_code,
           COALESCE(un.name_1, i.unit_standard, '') AS unit_name,
           COALESCE(d.purchase_point,0)::numeric AS purchase_point,
           COALESCE(d.minimum_qty,0)::numeric AS minimum_qty,
           COALESCE(d.maximum_qty,0)::numeric AS maximum_qty
         FROM ic_inventory i
         JOIN ic_inventory_detail d ON d.ic_code = i.code
         LEFT JOIN ic_unit un ON un.code = i.unit_standard
         WHERE ${whereParts.join(" AND ")}
       ),
       item_code_list AS (
         SELECT string_agg(item_code, ',') AS codes
         FROM candidates
       ),
       stock AS (
         SELECT s.ic_code, SUM(s.balance_qty)::numeric AS real_balance_qty
         FROM item_code_list icl
         CROSS JOIN LATERAL sml_ic_function_stock_balance_warehouse_location('NOW()', icl.codes, '', '') s
         WHERE icl.codes IS NOT NULL
         GROUP BY s.ic_code
       ),
       cart AS (
         SELECT
           c.item_code,
           SUM(
             COALESCE(c.qty,0)::numeric
             * COALESCE(u.stand_value,1)::numeric
             / NULLIF(COALESCE(u.divide_value,1),0)::numeric
           ) AS cart_qty
         FROM staff_cart_order c
         LEFT JOIN ic_unit_use u
                ON u.ic_code = c.item_code
               AND u.code = c.unit_code
         WHERE c.item_code IN (SELECT item_code FROM candidates)
         GROUP BY c.item_code
       ),
       availability AS (
         SELECT
           c.item_code,
           c.item_name,
           c.item_name_eng,
           c.unit_code,
           c.unit_name,
           COALESCE(s.real_balance_qty,0)::numeric AS real_balance_qty,
           COALESCE(cart.cart_qty,0)::numeric AS cart_qty,
           (COALESCE(s.real_balance_qty,0) - COALESCE(cart.cart_qty,0))::numeric AS available_qty,
           c.purchase_point,
           c.minimum_qty,
           c.maximum_qty
         FROM candidates c
         LEFT JOIN stock s ON s.ic_code = c.item_code
         LEFT JOIN cart ON cart.item_code = c.item_code
       ),
       reorder AS (
         SELECT
           *,
           (purchase_point > 0 AND available_qty <= purchase_point) AS reached_reorder_point,
           CASE
             WHEN purchase_point > 0 AND available_qty <= purchase_point THEN
               GREATEST(
                 minimum_qty,
                 CASE
                   WHEN maximum_qty > 0 THEN maximum_qty - available_qty
                   ELSE minimum_qty
                 END,
                 0
               )
             ELSE 0
           END::numeric AS suggest_qty
         FROM availability
       )
       SELECT
         *,
         COUNT(*) OVER()::int AS total_count,
         COALESCE(SUM(suggest_qty) OVER(),0)::numeric AS total_suggest_qty
       FROM reorder
       WHERE ${onlyReorder ? "reached_reorder_point = TRUE" : "TRUE"}
       ORDER BY ${sortCol} ${sortDir}, item_code ASC
       OFFSET ${offsetParam} LIMIT ${limitParam}`,
      [...whereParams, offsetNum, limitNum],
    );

    const totalCount = Number(result.rows[0]?.total_count || 0);
    const totalSuggestQty = Number(result.rows[0]?.total_suggest_qty || 0);
    const rows = result.rows.map(({ total_count, total_suggest_qty, ...row }) => ({
      ...row,
      real_balance_qty: Number(row.real_balance_qty || 0),
      cart_qty: Number(row.cart_qty || 0),
      available_qty: Number(row.available_qty || 0),
      purchase_point: Number(row.purchase_point || 0),
      minimum_qty: Number(row.minimum_qty || 0),
      maximum_qty: Number(row.maximum_qty || 0),
      suggest_qty: Number(row.suggest_qty || 0),
      reached_reorder_point: row.reached_reorder_point === true || row.reached_reorder_point === "true",
    }));
    return res.json({ success: true, data: rows, totalCount, totalSuggestQty });
  } catch (ex) {
    console.error("getPurchaseStockReorderList error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// ========== PRODUCT ITEM DETAIL (สำหรับหน้าแก้ไข) ==========

// GET /service/v1/getProductItemDetail?code=
router.get("/getProductItemDetail", async (req, res) => {
  const code = (req.query.code || "").trim();
  if (!code) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้า" });
  try {
    const result = await query(
      `SELECT i.code, COALESCE(i.name_1,'') AS name_1, COALESCE(i.name_2,'') AS name_2,` +
        ` COALESCE(i.name_eng_1,'') AS name_eng_1, COALESCE(i.name_eng_2,'') AS name_eng_2,` +
        ` COALESCE(i.unit_standard,'') AS unit_standard, COALESCE(i.unit_cost,'') AS unit_cost,` +
        ` COALESCE(i.item_category,'') AS item_category, COALESCE(i.item_brand,'') AS item_brand,` +
        ` COALESCE(i.group_main,'') AS group_main, COALESCE(i.group_sub,'') AS group_sub,` +
        ` COALESCE(i.group_sub2,'') AS group_sub2,` +
        ` COALESCE(i.item_design,'') AS item_design, COALESCE(i.item_model,'') AS item_model,` +
        ` COALESCE(d.purchase_point,0) AS purchase_point, COALESCE(d.minimum_qty,0) AS minimum_qty,` +
        ` COALESCE(d.maximum_qty,0) AS maximum_qty,` +
        ` COALESCE(d.start_sale_wh,'') AS wh_code, COALESCE(d.start_sale_shelf,'') AS shelf_code` +
        ` FROM ic_inventory i` +
        ` LEFT JOIN ic_inventory_detail d ON d.ic_code = i.code` +
        ` WHERE i.code = $1 AND ${activeProductCondition("d")}`,
      [code],
    );
    if (!result.rows.length) return res.status(400).json({ success: false, message: "ไม่พบสินค้า" });
    const warehouseShelfResult = await query(
      `SELECT ws.wh_code, COALESCE(w.name_1,'') AS wh_name,` +
        ` ws.shelf_code, COALESCE(s.name_1,'') AS shelf_name,` +
        ` COALESCE(ws.shelf_list,'') AS shelf_list,` +
        ` COALESCE(ws.min_point,0) AS min_point, COALESCE(ws.max_point,0) AS max_point,` +
        ` COALESCE(ws.status,1) AS status` +
        ` FROM ic_wh_shelf ws` +
        ` LEFT JOIN ic_warehouse w ON w.code = ws.wh_code` +
        ` LEFT JOIN ic_shelf s ON s.whcode = ws.wh_code AND s.code = ws.shelf_code` +
        ` WHERE ws.ic_code=$1::text` +
        ` ORDER BY ws.wh_code, ws.shelf_code`,
      [code],
    );
    return res.json({ success: true, data: { ...result.rows[0], warehouse_shelves: warehouseShelfResult.rows } });
  } catch (ex) {
    console.error("getProductItemDetail error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/updateProductItemMain
router.post("/updateProductItemMain", async (req, res) => {
  const {
    code = "",
    name_1 = "",
    name_2 = "",
    name_eng_1 = "",
    name_eng_2 = "",
    unit_standard = "",
    unit_cost = "",
    item_category = "",
    item_brand = "",
    group_main = "",
    group_sub = "",
    group_sub2 = "",
    item_design = "",
    item_model = "",
    wh_code = "",
    shelf_code = "",
    start_sale_wh = "",
    start_sale_shelf = "",
    warehouse_shelves = [],
    purchase_point = 0,
    minimum_qty = 0,
    maximum_qty = 0,
  } = req.body || {};

  const c = String(code).trim();
  if (!c) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้า" });
  if (!String(unit_standard).trim()) return res.status(400).json({ success: false, message: "กรุณาเลือกหน่วยมาตรฐาน" });
  const whCode = String(wh_code || start_sale_wh || "").trim();
  const shelfCode = String(shelf_code || start_sale_shelf || "").trim();
  if (!whCode) return res.status(400).json({ success: false, message: "กรุณาเลือกคลัง" });
  if (!shelfCode) return res.status(400).json({ success: false, message: "กรุณาเลือกที่เก็บ" });
  const purchasePoint = normalizeStockLevelQty(purchase_point);
  const minimumQty = normalizeStockLevelQty(minimum_qty);
  const maximumQty = normalizeStockLevelQty(maximum_qty);
  const warehouseShelves = normalizeWarehouseShelfRows(warehouse_shelves, whCode, shelfCode);

  try {
    await withTransaction(async (client) => {
      const updateResult = await client.query(
        `UPDATE ic_inventory SET name_1=$1, name_2=$2, name_eng_1=$3, name_eng_2=$4,` +
          ` unit_standard=$5, unit_cost=$6, item_category=$7, item_brand=$8,` +
          ` group_main=$9, group_sub=$10, group_sub2=$11, item_design=$12, item_model=$13` +
          ` WHERE code=$14::text`,
        [
          String(name_1).trim(),
          String(name_2).trim(),
          String(name_eng_1).trim(),
          String(name_eng_2).trim(),
          String(unit_standard).trim(),
          String(unit_cost).trim(),
          String(item_category).trim(),
          String(item_brand).trim(),
          String(group_main).trim(),
          String(group_sub).trim(),
          String(group_sub2).trim(),
          String(item_design).trim(),
          String(item_model).trim(),
          c,
        ],
      );
      if (updateResult.rowCount === 0) throw httpError("ไม่พบสินค้า", 404);

      await ensureWarehouseShelfExists(client, whCode, shelfCode);
      await ensureWarehouseShelfRowsExist(client, warehouseShelves);
      await ensureProductUnitUse(client, c, String(unit_standard).trim());

      await client.query(
        `INSERT INTO ic_inventory_detail (ic_code, purchase_point, minimum_qty, maximum_qty, start_sale_wh, start_sale_shelf)` +
          ` VALUES ($1::text,$2::numeric,$3::numeric,$4::numeric,$5::text,$6::text)` +
          ` ON CONFLICT (ic_code) DO UPDATE SET` +
          ` purchase_point = EXCLUDED.purchase_point,` +
          ` minimum_qty = EXCLUDED.minimum_qty,` +
          ` maximum_qty = EXCLUDED.maximum_qty,` +
          ` start_sale_wh = EXCLUDED.start_sale_wh,` +
          ` start_sale_shelf = EXCLUDED.start_sale_shelf`,
        [c, purchasePoint, minimumQty, maximumQty, whCode, shelfCode],
      );
      await replaceProductWarehouseShelves(client, c, warehouseShelves);
      await syncProductUnitType(client, c);
    });
    return res.json({ success: true });
  } catch (ex) {
    console.error("updateProductItemMain error:", ex.message);
    return res.status(ex.statusCode || 500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/createProductItemMain
router.post("/createProductItemMain", async (req, res) => {
  const {
    code = "",
    name_1 = "",
    name_2 = "",
    name_eng_1 = "",
    name_eng_2 = "",
    unit_standard = "",
    unit_cost = "",
    item_category = "",
    item_brand = "",
    group_main = "",
    group_sub = "",
    group_sub2 = "",
    item_design = "",
    item_model = "",
    wh_code = "",
    shelf_code = "",
    start_sale_wh = "",
    start_sale_shelf = "",
    warehouse_shelves = [],
    purchase_point = 0,
    minimum_qty = 0,
    maximum_qty = 0,
  } = req.body || {};

  const c = String(code).trim().toUpperCase();
  if (!c) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้า" });
  if (!PRODUCT_CODE_PATTERN.test(c)) {
    return res.status(400).json({ success: false, message: "รูปแบบรหัสสินค้าไม่ถูกต้อง (อนุญาต A-Z, 0-9, -, _)" });
  }
  if (!String(name_1).trim()) return res.status(400).json({ success: false, message: "กรุณาระบุชื่อสินค้า" });
  if (!String(unit_standard).trim()) return res.status(400).json({ success: false, message: "กรุณาเลือกหน่วยมาตรฐาน" });
  const whCode = String(wh_code || start_sale_wh || "").trim();
  const shelfCode = String(shelf_code || start_sale_shelf || "").trim();
  if (!whCode) return res.status(400).json({ success: false, message: "กรุณาเลือกคลัง" });
  if (!shelfCode) return res.status(400).json({ success: false, message: "กรุณาเลือกที่เก็บ" });
  const purchasePoint = normalizeStockLevelQty(purchase_point);
  const minimumQty = normalizeStockLevelQty(minimum_qty);
  const maximumQty = normalizeStockLevelQty(maximum_qty);
  const warehouseShelves = normalizeWarehouseShelfRows(warehouse_shelves, whCode, shelfCode);

  try {
    await withTransaction(async (client) => {
      const exists = await client.query(`SELECT 1 FROM ic_inventory WHERE code = $1::text LIMIT 1`, [c]);
      if (exists.rows.length) {
        const err = new Error("รหัสสินค้านี้มีอยู่แล้ว");
        err.statusCode = 400;
        throw err;
      }

      await client.query(
        `INSERT INTO ic_inventory (` +
          ` code, name_1, name_2, name_eng_1, name_eng_2,` +
          ` unit_standard, unit_cost, item_category, item_brand,` +
          ` group_main, group_sub, group_sub2, item_design, item_model,` +
          ` unit_standard_stand_value, unit_standard_divide_value, update_detail, update_price` +
          `) VALUES (` +
          ` $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::text,$13::text,$14::text,1,1,1,1` +
          `)`,
        [
          c,
          String(name_1).trim(),
          String(name_2).trim(),
          String(name_eng_1).trim(),
          String(name_eng_2).trim(),
          String(unit_standard).trim(),
          String(unit_cost).trim() || String(unit_standard).trim(),
          String(item_category).trim(),
          String(item_brand).trim(),
          String(group_main).trim(),
          String(group_sub).trim(),
          String(group_sub2).trim(),
          String(item_design).trim(),
          String(item_model).trim(),
        ],
      );

      const unitStd = String(unit_standard).trim();
      await ensureWarehouseShelfExists(client, whCode, shelfCode);
      await ensureWarehouseShelfRowsExist(client, warehouseShelves);
      await ensureProductUnitUse(client, c, unitStd);

      await client.query(
        `INSERT INTO ic_inventory_detail (ic_code, purchase_point, minimum_qty, maximum_qty, start_sale_wh, start_sale_shelf)` +
          ` VALUES ($1::text,$2::numeric,$3::numeric,$4::numeric,$5::text,$6::text)` +
          ` ON CONFLICT (ic_code) DO UPDATE SET` +
          ` purchase_point = EXCLUDED.purchase_point,` +
          ` minimum_qty = EXCLUDED.minimum_qty,` +
          ` maximum_qty = EXCLUDED.maximum_qty,` +
          ` start_sale_wh = EXCLUDED.start_sale_wh,` +
          ` start_sale_shelf = EXCLUDED.start_sale_shelf`,
        [c, purchasePoint, minimumQty, maximumQty, whCode, shelfCode],
      );
      await replaceProductWarehouseShelves(client, c, warehouseShelves);
      await syncProductUnitType(client, c);
    });

    return res.json({ success: true, code: c });
  } catch (ex) {
    console.error("createProductItemMain error:", ex.message);
    return res.status(ex.statusCode || 500).json({ success: false, message: ex.message });
  }
});

// ========== BARCODE CRUD ==========

// GET /service/v1/generateProductItemBarcode?ic_code=
router.get("/generateProductItemBarcode", async (req, res) => {
  const ic_code = (req.query.ic_code || "").trim();
  if (!ic_code) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้า" });

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const barcode = generateEan13Candidate();
      const exists = await query(`SELECT 1 FROM ic_inventory_barcode WHERE barcode = $1 LIMIT 1`, [barcode]);
      if (!exists.rows.length) return res.json({ success: true, barcode });
    }
    return res.status(409).json({ success: false, message: "ไม่สามารถสร้างบาร์โค้ดที่ไม่ซ้ำได้ กรุณาลองใหม่อีกครั้ง" });
  } catch (ex) {
    console.error("generateProductItemBarcode error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// GET /service/v1/getProductItemBarcodes?ic_code=
router.get("/getProductItemBarcodes", async (req, res) => {
  const ic_code = (req.query.ic_code || "").trim();
  if (!ic_code) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้า" });
  try {
    const result = await query(
      `SELECT b.barcode, b.unit_code,` +
        ` COALESCE(b.price,0) AS price, COALESCE(b.price_member,0) AS price_member,` +
        ` COALESCE(b.price_2,0) AS price_2, COALESCE(b.price_member_2,0) AS price_member_2,` +
        ` COALESCE(u.name_1,'') AS unit_name` +
        ` FROM ic_inventory_barcode b LEFT JOIN ic_unit u ON u.code = b.unit_code` +
        ` WHERE b.ic_code = $1 ORDER BY b.barcode DESC`,
      [ic_code],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    console.error("getProductItemBarcodes error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// GET /service/v1/checkBarcodeInUse?ic_code=&barcode=
router.get("/checkBarcodeInUse", async (req, res) => {
  const ic_code = (req.query.ic_code || "").trim();
  const barcode = (req.query.barcode || "").trim();
  try {
    const result = await query(`SELECT COUNT(*) AS cnt FROM ic_trans_detail WHERE barcode=$1 AND item_code=$2`, [barcode, ic_code]);
    return res.json({ success: true, in_use: parseInt(result.rows[0].cnt) > 0 });
  } catch (ex) {
    console.error("checkBarcodeInUse error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/createProductItemBarcode
router.post("/createProductItemBarcode", async (req, res) => {
  const { ic_code = "", barcode = "", unit_code = "", price = 0, price_member = 0, price_2 = 0, price_member_2 = 0 } = req.body || {};
  const c = String(ic_code).trim();
  const b = String(barcode).trim();
  if (!c || !b) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้าและบาร์โค้ด" });
  try {
    const exists = await query(`SELECT 1 FROM ic_inventory_barcode WHERE barcode = $1 LIMIT 1`, [b]);
    if (exists.rows.length) return res.status(409).json({ success: false, message: "บาร์โค้ดนี้มีอยู่แล้ว" });
    await query(`INSERT INTO ic_inventory_barcode (ic_code, barcode, unit_code, price, price_member, price_2, price_member_2)` + ` VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      c,
      b,
      String(unit_code).trim(),
      Number(price) || 0,
      Number(price_member) || 0,
      Number(price_2) || 0,
      Number(price_member_2) || 0,
    ]);
    return res.json({ success: true });
  } catch (ex) {
    console.error("createProductItemBarcode error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/updateProductItemBarcode
router.post("/updateProductItemBarcode", async (req, res) => {
  const { ic_code = "", barcode = "", unit_code = "", price = 0, price_member = 0, price_2 = 0, price_member_2 = 0 } = req.body || {};
  const c = String(ic_code).trim();
  const b = String(barcode).trim();
  if (!c || !b) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้าและบาร์โค้ด" });
  try {
    await query(`UPDATE ic_inventory_barcode SET unit_code=$1, price=$2, price_member=$3, price_2=$4, price_member_2=$5` + ` WHERE barcode=$6 AND ic_code=$7`, [
      String(unit_code).trim(),
      Number(price) || 0,
      Number(price_member) || 0,
      Number(price_2) || 0,
      Number(price_member_2) || 0,
      b,
      c,
    ]);
    return res.json({ success: true });
  } catch (ex) {
    console.error("updateProductItemBarcode error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/deleteProductItemBarcode
router.post("/deleteProductItemBarcode", async (req, res) => {
  const { ic_code = "", barcode = "" } = req.body || {};
  const c = String(ic_code).trim();
  const b = String(barcode).trim();
  if (!c || !b) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้าและบาร์โค้ด" });
  try {
    await query(`DELETE FROM ic_inventory_barcode WHERE barcode=$1 AND ic_code=$2`, [b, c]);
    return res.json({ success: true });
  } catch (ex) {
    console.error("deleteProductItemBarcode error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// ========== UNIT USE CRUD ==========

// GET /service/v1/getProductItemUnitUse?ic_code=
router.get("/getProductItemUnitUse", async (req, res) => {
  const ic_code = (req.query.ic_code || "").trim();
  if (!ic_code) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้า" });
  try {
    const result = await query(
      `SELECT u.code, COALESCE(u.stand_value,1::numeric) AS stand_value,` +
        ` COALESCE(u.divide_value,1::numeric) AS divide_value,` +
        ` COALESCE(u.ratio,1::numeric) AS ratio,` +
        ` COALESCE(u.row_order,0) AS row_order,` +
        ` COALESCE(u.width_length_height,'') AS width_length_height,` +
        ` COALESCE(u.weight,'') AS weight,` +
        ` COALESCE(m.name_1,'') AS unit_name` +
        ` FROM ic_unit_use u LEFT JOIN ic_unit m ON m.code = u.code` +
        ` WHERE u.ic_code = $1 ORDER BY u.row_order`,
      [ic_code],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    console.error("getProductItemUnitUse error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// GET /service/v1/checkUnitUseInUse?ic_code=&unit_code=
router.get("/checkUnitUseInUse", async (req, res) => {
  const ic_code = (req.query.ic_code || "").trim();
  const unit_code = (req.query.unit_code || "").trim();
  try {
    const result = await query(`SELECT COUNT(*) AS cnt FROM ic_trans_detail WHERE item_code=$1 AND unit_code=$2`, [ic_code, unit_code]);
    return res.json({ success: true, in_use: parseInt(result.rows[0].cnt) > 0 });
  } catch (ex) {
    console.error("checkUnitUseInUse error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/createProductItemUnitUse
router.post("/createProductItemUnitUse", async (req, res) => {
  const { ic_code = "", code = "", stand_value = 1, divide_value = 1, row_order = 0, width_length_height = "", weight = "" } = req.body || {};
  const c = String(ic_code).trim();
  const u = String(code).trim();
  if (!c || !u) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้าและรหัสหน่วยนับ" });
  const sv = Number(stand_value) || 1;
  const dv = Number(divide_value) || 1;
  const ratio = dv !== 0 ? sv / dv : 0;
  try {
    await withTransaction(async (client) => {
      await ensureProductExists(client, c);
      await client.query(`INSERT INTO ic_unit_use (ic_code, code, stand_value, divide_value, ratio, row_order, width_length_height, weight)` + ` VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
        c,
        u,
        sv,
        dv,
        ratio,
        Number(row_order) || 0,
        String(width_length_height).trim(),
        String(weight).trim(),
      ]);
      await syncProductUnitType(client, c);
    });
    return res.json({ success: true });
  } catch (ex) {
    console.error("createProductItemUnitUse error:", ex.message);
    return res.status(ex.statusCode || 500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/updateProductItemUnitUse
router.post("/updateProductItemUnitUse", async (req, res) => {
  const { ic_code = "", code = "", stand_value = 1, divide_value = 1, row_order = 0, width_length_height = "", weight = "" } = req.body || {};
  const c = String(ic_code).trim();
  const u = String(code).trim();
  if (!c || !u) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้าและรหัสหน่วยนับ" });
  const sv = Number(stand_value) || 1;
  const dv = Number(divide_value) || 1;
  const ratio = dv !== 0 ? sv / dv : 0;
  try {
    await withTransaction(async (client) => {
      await ensureProductExists(client, c);
      const updateResult = await client.query(`UPDATE ic_unit_use SET stand_value=$1, divide_value=$2, ratio=$3, row_order=$4,` + ` width_length_height=$5, weight=$6 WHERE ic_code=$7 AND code=$8`, [
        sv,
        dv,
        ratio,
        Number(row_order) || 0,
        String(width_length_height).trim(),
        String(weight).trim(),
        c,
        u,
      ]);
      if (updateResult.rowCount === 0) throw httpError("ไม่พบหน่วยนับ", 404);
      await syncProductUnitType(client, c);
    });
    return res.json({ success: true });
  } catch (ex) {
    console.error("updateProductItemUnitUse error:", ex.message);
    return res.status(ex.statusCode || 500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/deleteProductItemUnitUse
router.post("/deleteProductItemUnitUse", async (req, res) => {
  const { ic_code = "", code = "" } = req.body || {};
  const c = String(ic_code).trim();
  const u = String(code).trim();
  if (!c || !u) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้าและรหัสหน่วยนับ" });
  try {
    await withTransaction(async (client) => {
      await ensureProductExists(client, c);
      const deleteResult = await client.query(`DELETE FROM ic_unit_use WHERE ic_code=$1 AND code=$2`, [c, u]);
      if (deleteResult.rowCount === 0) throw httpError("ไม่พบหน่วยนับ", 404);
      await syncProductUnitType(client, c);
    });
    return res.json({ success: true });
  } catch (ex) {
    console.error("deleteProductItemUnitUse error:", ex.message);
    return res.status(ex.statusCode || 500).json({ success: false, message: ex.message });
  }
});

// ========== IMAGE MANAGEMENT ==========

// GET /service/v1/getProductImages?item_code=
// query จาก main pool (metadata only) — ตรงตาม Java
router.get("/getProductImages", async (req, res) => {
  const item_code = (req.query.item_code || "").trim();
  if (!item_code) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้า" });
  try {
    const result = await queryImages(`SELECT image_id, guid_code, image_order FROM images WHERE image_id = $1 ORDER BY image_order ASC`, [item_code]);
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    console.error("getProductImages error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/saveProductImage
// dual-pool transaction: main + images — ตรงตาม Java saveProductImage
router.post("/saveProductImage", async (req, res) => {
  const { item_code = "", image_file = "" } = req.body || {};
  const ic = String(item_code).trim();
  const imgData = String(image_file);
  if (!ic || !imgData) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้าและรูปภาพ" });

  const base64 = imgData.replace(/^data:[^;]+;base64,/, "");
  const bytes = Buffer.from(base64, "base64");
  const guid = randomUUID();

  const clientMain = await pool.connect();
  const clientImg = await poolImages.connect();
  try {
    await clientMain.query("BEGIN");
    await clientImg.query("BEGIN");

    const orderRes = await clientMain.query(`SELECT COALESCE(MAX(image_order), -1) + 1 AS next_order FROM images WHERE image_id = $1`, [ic]);
    const nextOrder = parseInt(orderRes.rows[0].next_order) || 0;

    await clientImg.query(`INSERT INTO images (image_id, image_file, guid_code, image_order) VALUES ($1,$2,$3,$4)`, [ic, bytes, guid, nextOrder]);
    await clientMain.query(`INSERT INTO images (image_id, guid_code, image_order) VALUES ($1,$2,$3)`, [ic, guid, nextOrder]);

    await clientMain.query("COMMIT");
    await clientImg.query("COMMIT");
    return res.json({ success: true, guid_code: guid });
  } catch (ex) {
    await clientMain.query("ROLLBACK").catch(() => {});
    await clientImg.query("ROLLBACK").catch(() => {});
    console.error("saveProductImage error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  } finally {
    clientMain.release();
    clientImg.release();
  }
});

// POST /service/v1/deleteProductImage
// dual-pool: ลบทั้ง 2 DB
router.post("/deleteProductImage", async (req, res) => {
  const { guid_code = "" } = req.body || {};
  const guid = String(guid_code).trim();
  if (!guid) return res.status(400).json({ success: false, message: "กรุณาระบุ guid_code" });

  const clientMain = await pool.connect();
  const clientImg = await poolImages.connect();
  try {
    await clientMain.query("BEGIN");
    await clientImg.query("BEGIN");

    await clientImg.query(`DELETE FROM images WHERE guid_code = $1`, [guid]);
    await clientMain.query(`DELETE FROM images WHERE guid_code = $1`, [guid]);

    await clientMain.query("COMMIT");
    await clientImg.query("COMMIT");
    return res.json({ success: true });
  } catch (ex) {
    await clientMain.query("ROLLBACK").catch(() => {});
    await clientImg.query("ROLLBACK").catch(() => {});
    console.error("deleteProductImage error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  } finally {
    clientMain.release();
    clientImg.release();
  }
});

// POST /service/v1/reorderProductImages
// dual-pool batch UPDATE image_order
router.post("/reorderProductImages", async (req, res) => {
  const { item_code = "", orders = [] } = req.body || {};
  const ic = String(item_code).trim();
  if (!ic || !Array.isArray(orders) || !orders.length) {
    return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบ" });
  }

  const clientMain = await pool.connect();
  const clientImg = await poolImages.connect();
  try {
    await clientMain.query("BEGIN");
    await clientImg.query("BEGIN");

    for (const o of orders) {
      const guid = String(o.guid_code || "");
      const order = parseInt(o.image_order) || 0;
      await clientImg.query(`UPDATE images SET image_order=$1 WHERE guid_code=$2 AND image_id=$3`, [order, guid, ic]);
      await clientMain.query(`UPDATE images SET image_order=$1 WHERE guid_code=$2 AND image_id=$3`, [order, guid, ic]);
    }

    await clientMain.query("COMMIT");
    await clientImg.query("COMMIT");
    return res.json({ success: true });
  } catch (ex) {
    await clientMain.query("ROLLBACK").catch(() => {});
    await clientImg.query("ROLLBACK").catch(() => {});
    console.error("reorderProductImages error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  } finally {
    clientMain.release();
    clientImg.release();
  }
});

// ========== PRICE FORMULA CRUD ==========

// GET /service/v1/getProductPriceFormulas?ic_code=
router.get("/getProductPriceFormulas", async (req, res) => {
  const ic_code = (req.query.ic_code || "").trim();
  if (!ic_code) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้า" });
  try {
    const result = await query(
      `SELECT ic_code, unit_code, sale_type, tax_type,` +
        ` COALESCE(price_0,'') AS price_0, COALESCE(price_1,'') AS price_1,` +
        ` COALESCE(price_2,'') AS price_2, COALESCE(price_3,'') AS price_3,` +
        ` COALESCE(price_4,'') AS price_4, COALESCE(price_5,'') AS price_5,` +
        ` COALESCE(price_6,'') AS price_6, COALESCE(price_7,'') AS price_7,` +
        ` COALESCE(price_8,'') AS price_8, COALESCE(price_9,'') AS price_9` +
        ` FROM ic_inventory_price_formula WHERE ic_code = $1 AND currency_code = ''` +
        ` ORDER BY unit_code, sale_type, tax_type`,
      [ic_code],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    console.error("getProductPriceFormulas error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/saveProductPriceFormula
router.post("/saveProductPriceFormula", async (req, res) => {
  const {
    ic_code = "",
    unit_code = "",
    sale_type = 0,
    tax_type = 0,
    price_0 = "",
    price_1 = "",
    price_2 = "",
    price_3 = "",
    price_4 = "",
    price_5 = "",
    price_6 = "",
    price_7 = "",
    price_8 = "",
    price_9 = "",
  } = req.body || {};
  const c = String(ic_code).trim();
  const uc = String(unit_code).trim();
  if (!c || !uc) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้าและหน่วยนับ" });
  const st = parseInt(sale_type) || 0;
  const tt = parseInt(tax_type) || 0;
  const toStr = (v) => String(v ?? "").trim();
  const prices = [toStr(price_0), toStr(price_1), toStr(price_2), toStr(price_3), toStr(price_4), toStr(price_5), toStr(price_6), toStr(price_7), toStr(price_8), toStr(price_9)];
  try {
    await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE ic_inventory_price_formula SET` +
          `  price_0=$5, price_1=$6, price_2=$7, price_3=$8, price_4=$9,` +
          `  price_5=$10, price_6=$11, price_7=$12, price_8=$13, price_9=$14` +
          ` WHERE ic_code=$1 AND unit_code=$2 AND sale_type=$3 AND tax_type=$4 AND currency_code=''`,
        [c, uc, st, tt, ...prices],
      );
      if (upd.rowCount === 0) {
        await client.query(
          `INSERT INTO ic_inventory_price_formula` +
            ` (ic_code, unit_code, sale_type, tax_type, currency_code,` +
            `  price_0, price_1, price_2, price_3, price_4, price_5, price_6, price_7, price_8, price_9)` +
            ` VALUES ($1,$2,$3,$4,'',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [c, uc, st, tt, ...prices],
        );
      }
    });
    return res.json({ success: true });
  } catch (ex) {
    console.error("saveProductPriceFormula error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/deleteProductPriceFormula
router.post("/deleteProductPriceFormula", async (req, res) => {
  const { ic_code = "", unit_code = "", sale_type = 0, tax_type = 0 } = req.body || {};
  const c = String(ic_code).trim();
  const uc = String(unit_code).trim();
  if (!c || !uc) return res.status(400).json({ success: false, message: "กรุณาระบุรหัสสินค้าและหน่วยนับ" });
  try {
    await query(`DELETE FROM ic_inventory_price_formula WHERE ic_code=$1 AND unit_code=$2 AND sale_type=$3 AND tax_type=$4 AND currency_code=''`, [
      c,
      uc,
      parseInt(sale_type) || 0,
      parseInt(tax_type) || 0,
    ]);
    return res.json({ success: true });
  } catch (ex) {
    console.error("deleteProductPriceFormula error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

module.exports = router;

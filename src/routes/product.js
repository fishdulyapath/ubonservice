const express = require("express");
const router = express.Router();
const { query, pool, poolImages, withTransaction, queryImages } = require("../db");
const { getProductPriceLocalx } = require("../utils/priceHelper");
const { listSalePremiumProductsForSale, expandSalePremiumItemForSave } = require("../utils/salePremiumHelper");
const { randomInt, randomUUID } = require("crypto");

const PRODUCT_CODE_PATTERN = /^[A-Z0-9_-]+$/;
const PRODUCT_CODE_FORMAT_SCREEN = "IC";
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
  if (!c) throw httpError("à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²", 400);
  const exists = await client.query(`SELECT 1 FROM ic_inventory WHERE code=$1 LIMIT 1`, [c]);
  if (!exists.rows.length) throw httpError("à¹„à¸¡à¹ˆà¸žà¸šà¸ªà¸´à¸™à¸„à¹‰à¸²", 404);
}

async function ensureWarehouseShelfExists(client, whCode, shelfCode) {
  const wh = String(whCode || "").trim();
  const shelf = String(shelfCode || "").trim();
  if (!wh) throw httpError("à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸„à¸¥à¸±à¸‡", 400);
  if (!shelf) throw httpError("à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸—à¸µà¹ˆà¹€à¸à¹‡à¸š", 400);
  const result = await client.query(`SELECT 1 FROM ic_shelf WHERE whcode=$1::text AND code=$2::text LIMIT 1`, [wh, shelf]);
  if (!result.rows.length) throw httpError("à¸„à¸¥à¸±à¸‡/à¸—à¸µà¹ˆà¹€à¸à¹‡à¸šà¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡", 400);
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

async function upsertProductInventoryDetail(client, icCode, purchasePoint, minimumQty, maximumQty, whCode, shelfCode) {
  const c = String(icCode || "").trim();
  if (!c) return;
  const params = [c, purchasePoint, minimumQty, maximumQty, whCode, shelfCode];
  const updateResult = await client.query(
    `UPDATE ic_inventory_detail SET purchase_point=$2::numeric, minimum_qty=$3::numeric, maximum_qty=$4::numeric,` +
      ` start_sale_wh=$5::text, start_sale_shelf=$6::text WHERE ic_code=$1::text`,
    params,
  );
  if (updateResult.rowCount > 0) return;
  await client.query(
    `INSERT INTO ic_inventory_detail (ic_code, purchase_point, minimum_qty, maximum_qty, start_sale_wh, start_sale_shelf)` +
      ` SELECT $1::text,$2::numeric,$3::numeric,$4::numeric,$5::text,$6::text` +
      ` WHERE NOT EXISTS (SELECT 1 FROM ic_inventory_detail WHERE ic_code=$1::text)`,
    params,
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
  if (updateResult.rowCount === 0) throw httpError("à¹„à¸¡à¹ˆà¸žà¸šà¸ªà¸´à¸™à¸„à¹‰à¸²", 404);
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
function productCodeDateParts(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date();
  const yyyy = String(d.getFullYear()).padStart(4, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return { yyyy, yy: yyyy.slice(-2), mm, dd };
}

function escapeRegexLiteral(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeLikePattern(value) {
  return String(value || "").replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function compileProductItemCodeFormat(format, formatCode, docDate, runningNumber = null) {
  const formatText = String(format || "@####").trim() || "@####";
  const prefixCode = String(formatCode || "").trim().toUpperCase();
  const date = productCodeDateParts(docDate);
  const tokens = [
    ["YYYY", date.yyyy], ["yyyy", date.yyyy],
    ["YY", date.yy], ["yy", date.yy],
    ["MM", date.mm], ["mm", date.mm],
    ["DD", date.dd], ["dd", date.dd],
    ["à¸›à¸›à¸›à¸›", date.yyyy], ["à¸›à¸›", date.yy], ["à¸”à¸”", date.mm], ["à¸§à¸§", date.dd],
  ];

  let generated = "";
  let regex = "^";
  let prefixBeforeRunning = "";
  let runningWidth = 0;
  let hasRunning = false;

  for (let i = 0; i < formatText.length;) {
    if (formatText[i] === "#") {
      let width = 1;
      while (formatText[i + width] === "#") width += 1;
      if (!hasRunning) {
        runningWidth = width;
        hasRunning = true;
        regex += `([0-9]{${width}})`;
      } else {
        regex += `[0-9]{${width}}`;
      }
      generated += runningNumber == null ? "" : String(runningNumber).padStart(width, "0");
      i += width;
      continue;
    }

    let replacement = "";
    let matched = "";
    if (formatText[i] === "@") {
      matched = "@";
      replacement = prefixCode;
    } else {
      for (const [token, value] of tokens) {
        if (formatText.startsWith(token, i)) {
          matched = token;
          replacement = value;
          break;
        }
      }
    }
    if (!matched) {
      matched = formatText[i];
      replacement = matched;
    }

    generated += replacement;
    regex += escapeRegexLiteral(replacement);
    if (!hasRunning) prefixBeforeRunning += replacement;
    i += matched.length;
  }

  regex += "$";
  return { generated, regex, prefixBeforeRunning, runningWidth };
}

async function findNextProductItemCode(formatRow, docDate) {
  const formatCode = String(formatRow?.code || "").trim().toUpperCase();
  const format = String(formatRow?.format || "@####").trim() || "@####";
  const compiled = compileProductItemCodeFormat(format, formatCode, docDate);
  if (!compiled.runningWidth) throw httpError("à¸£à¸¹à¸›à¹à¸šà¸šà¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¸•à¹‰à¸­à¸‡à¸¡à¸µ # à¸ªà¸³à¸«à¸£à¸±à¸šà¹€à¸¥à¸‚ running", 400);

  const result = await query(
    `SELECT code FROM ic_inventory WHERE code LIKE $1 ESCAPE '\\' AND code ~ $2 ORDER BY code DESC LIMIT 5000`,
    [`${escapeLikePattern(compiled.prefixBeforeRunning)}%`, compiled.regex],
  );
  const jsRegex = new RegExp(compiled.regex);
  let maxRunning = 0;
  for (const row of result.rows) {
    const match = String(row.code || "").match(jsRegex);
    const running = Number(match?.[1] || 0);
    if (Number.isFinite(running) && running > maxRunning) maxRunning = running;
  }

  for (let nextRunning = maxRunning + 1; nextRunning < maxRunning + 1001; nextRunning += 1) {
    const candidate = compileProductItemCodeFormat(format, formatCode, docDate, nextRunning).generated;
    const exists = await query(`SELECT 1 FROM ic_inventory WHERE code=$1::text LIMIT 1`, [candidate]);
    if (!exists.rows.length) {
      return { code: candidate, running: nextRunning, running_width: compiled.runningWidth, format_code: formatCode, format };
    }
  }
  throw httpError("à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸«à¸²à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¸–à¸±à¸”à¹„à¸›à¹„à¸”à¹‰", 500);
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
// à¹€à¸¥à¸µà¸¢à¸™à¹à¸šà¸š Java à¸—à¸¸à¸à¸­à¸¢à¹ˆà¸²à¸‡: dynamic WHERE, pagination à¸”à¹‰à¸§à¸¢ offset/limit
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
    sort_stock_desc: strSortStockDesc = "",
    limit: strLimit = "20",
  } = req.query;

  const resp = { success: false };

  try {
    // à¹€à¸¥à¸µà¸¢à¸™à¹à¸šà¸š Java search condition: à¸„à¹‰à¸™à¸«à¸² name_1, code, name_eng_2 + barcode (1 à¸ªà¸´à¸™à¸„à¹‰à¸²à¸¡à¸µà¸«à¸¥à¸²à¸¢à¸šà¸²à¸£à¹Œà¹‚à¸„à¹‰à¸”)
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

    // à¹ƒà¸Šà¹‰à¸¢à¸­à¸” real-time à¸ˆà¸²à¸ stock balance function à¹à¸—à¸™ ic_inventory.balance_qty
    const normalStockQtyExpr =
      `((SELECT COALESCE(SUM(balance_qty),0)` +
      ` FROM sml_ic_function_stock_balance_warehouse_location('NOW()', b.code, '', '')` +
      ` WHERE balance_qty > 0) / ` +
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

    const orderBy = strSortStockDesc === "1"
      ? ` ORDER BY COALESCE(b.balance_qty,0) DESC, b.code ASC`
      : "";

    const offsetInt = Math.max(0, parseInt(strOffset, 10) || 0);
    const limitInt = Math.max(1, parseInt(strLimit, 10) || 20);
    let salePremiumRows = [];
    let normalOffset = offsetInt;
    let normalLimit = limitInt;
    if (strPromotion === "1") {
      const basketCtxForPremium = await resolveBasketPricingContext(strCustCode);
      const allSalePremiumRows = await listSalePremiumProductsForSale(query, {
        custCode: strCustCode,
        search: strSearch,
        isStock: strStock,
        offset: 0,
        limit: 500,
        saleType: basketCtxForPremium.saleType ?? 0,
        vatType: basketCtxForPremium.vatType ?? 0,
        vatRate: basketCtxForPremium.vatRate ?? null,
      });
      salePremiumRows = allSalePremiumRows.slice(offsetInt, offsetInt + limitInt);
      normalOffset = Math.max(0, offsetInt - allSalePremiumRows.length);
      normalLimit = offsetInt < allSalePremiumRows.length
        ? Math.max(0, limitInt - salePremiumRows.length)
        : limitInt;
    }




    const dataSQL =


      `SELECT b.code AS item_code, b.name_1 AS item_name, c.start_sale_unit,b.unit_cost,b.unit_standard, b.item_type,` +
      ` COALESCE((${stockQtyExpr}),0) AS stock_qty,` +
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
      `${baseFrom}${orderBy} OFFSET ${normalOffset} LIMIT ${normalLimit}`;

    const dataResult = normalLimit > 0 ? await query(dataSQL, []) : { rows: [] };

    const normalData = dataResult.rows.map((r) => ({
      item_code: r.item_code,
      item_name: r.item_name,
      item_type: r.item_type,
      stock_qty: Number(r.stock_qty || 0),
      sold_out: r.sold_out,
      unit_standard: r.unit_standard,
      unit_cost: r.unit_cost,
      start_sale_unit: r.start_sale_unit,
      is_promotion: r.is_promotion,
      favorite_item: r.favorite_item,
      is_return: r.is_return,
    }));


    const data = strPromotion === "1" ? [...salePremiumRows, ...normalData] : normalData;
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
      stock_qty: Number(r.stock_qty || 0),
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
// à¹€à¸¥à¸µà¸¢à¸™à¹à¸šà¸š Java: CTE balance_stock + ic_unit_use + à¹€à¸£à¸µà¸¢à¸ getProductPriceLocalx à¸•à¹ˆà¸­ unit
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
      stock_qty: Number(r.stock_qty || 0),
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
            // query promotion à¸–à¹‰à¸² type IN (1,2,3) â€” à¹€à¸«à¸¡à¸·à¸­à¸™ Java lines 3490-3524
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

            // query discount_promotion à¸ˆà¸²à¸ ic_inventory_discount (à¹„à¸¡à¹ˆ filter qty)
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
// à¹€à¸¥à¸µà¸¢à¸™à¹à¸šà¸š Java: CTE set_detail + balance_stock + set_stock + set_price
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
      stock_qty: Number(r.stock_qty || 0),
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
// à¹€à¸¥à¸µà¸¢à¸™à¹à¸šà¸š Java: query ic_inventory_barcode + à¹€à¸£à¸µà¸¢à¸ getProductPriceLocalx
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

function saleLowCostNumber(value) {
  const num = Number(String(value ?? 0).replace(/,/g, ""));
  return Number.isFinite(num) ? num : 0;
}

function saleLowCostRound(value, point = 2) {
  const factor = Math.pow(10, point);
  return Math.round(saleLowCostNumber(value) * factor) / factor;
}

function saleLowCostAfterDiscount(word, amount, point = 2, qty = 1) {
  if (!word || !String(word).trim()) return saleLowCostRound(amount, point);
  let result = saleLowCostNumber(amount);
  for (const raw of String(word).replace(/\s/g, "").split(",")) {
    const token = raw.trim();
    if (!token) continue;
    if (token.startsWith("@")) {
      result -= saleLowCostRound(saleLowCostNumber(token.slice(1)) * saleLowCostNumber(qty), point);
    } else if (token.includes("%")) {
      result -= saleLowCostRound((saleLowCostNumber(token.replace(/%/g, "")) / 100) * result, point);
    } else {
      result -= saleLowCostRound(saleLowCostNumber(token), point);
    }
  }
  return saleLowCostRound(result, point);
}

function saleLowCostAmount(item) {
  const supplied = saleLowCostNumber(item?.sum_amount);
  if (Number.isFinite(supplied) && supplied !== 0) return supplied;
  const gross = saleLowCostRound(saleLowCostNumber(item?.price) * saleLowCostNumber(item?.qty), 2);
  return saleLowCostAfterDiscount(item?.discount || "", gross, 2, saleLowCostNumber(item?.qty));
}

// POST /service/v1/checkSaleLowCost
// Mirrors SML ERP sale check: net sale amount per base unit, VAT-in prices excluded, compared with ic_inventory.average_cost.
router.post("/checkSaleLowCost", async (req, res) => {
  const resp = { success: false, data: [] };
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const vatType = parseInt(req.body?.vat_type ?? "", 10);
  const vatRateNum = saleLowCostNumber(req.body?.vat_rate);
  const vatRate = vatRateNum > 0 ? vatRateNum : 0;

  try {
    const detailItems = [];
    for (const item of items) {
      const itemType = String(item?.item_type ?? "0");
      if (item?.sale_premium_code || itemType === "4") {
        const expanded = await expandSalePremiumItemForSave(query, item, {
          custCode: String(req.body?.cust_code || ""),
          saleType: parseInt(req.body?.sale_type ?? "0", 10) || 0,
          vatType,
          vatRate,
          docDate: String(req.body?.doc_date || ""),
        });
        detailItems.push(...expanded);
      } else {
        detailItems.push(item);
      }
    }

    const issues = [];
    for (const item of detailItems) {
      const itemCode = String(item?.item_code || "").trim();
      const unitCode = String(item?.unit_code || "").trim();
      if (!itemCode || !unitCode) continue;

      const itemResult = await query(
        `SELECT i.code AS item_code,
                COALESCE(i.name_1,'') AS item_name,
                COALESCE(i.average_cost,0) AS average_cost,
                COALESCE(d.is_premium,0) AS is_premium,
                COALESCE(cu.stand_value,1) AS average_cost_stand,
                COALESCE(cu.divide_value,1) AS average_cost_div,
                COALESCE(su.stand_value, i.unit_standard_stand_value, 1) AS sale_stand_value,
                COALESCE(su.divide_value, i.unit_standard_divide_value, 1) AS sale_divide_value
           FROM ic_inventory i
           LEFT JOIN ic_inventory_detail d ON d.ic_code = i.code
           LEFT JOIN ic_unit_use cu ON cu.ic_code = i.code AND cu.code = i.unit_cost
           LEFT JOIN ic_unit_use su ON su.ic_code = i.code AND su.code = $2
          WHERE i.code = $1
          LIMIT 1`,
        [itemCode, unitCode],
      );
      const row = itemResult.rows[0];
      if (!row) continue;

      const qty = saleLowCostNumber(item.qty);
      const amount = saleLowCostAmount(item);
      const saleStand = saleLowCostNumber(item.stand_value) || saleLowCostNumber(row.sale_stand_value) || 1;
      const saleDiv = saleLowCostNumber(item.divide_value) || saleLowCostNumber(row.sale_divide_value) || 1;
      const costStand = saleLowCostNumber(row.average_cost_stand) || 1;
      const costDiv = saleLowCostNumber(row.average_cost_div) || 1;
      const cost = saleLowCostNumber(row.average_cost);
      const isPremium = String(row.is_premium ?? "0") === "1" || Number(item?.is_permium ?? 0) === 1;

      if (qty === 0 || saleDiv === 0 || costDiv === 0 || isPremium) continue;

      let salePriceForCostUnit = amount / (qty * (saleStand / saleDiv));
      if (vatType === 1 && vatRate > 0) {
        salePriceForCostUnit = (salePriceForCostUnit * 100) / (100 + vatRate);
      }
      salePriceForCostUnit = salePriceForCostUnit * (costStand / costDiv);

      if (salePriceForCostUnit + 0.0001 < cost) {
        issues.push({
          item_code: itemCode,
          item_name: row.item_name || item.item_name || "",
          unit_code: unitCode,
          qty,
          sum_amount: saleLowCostRound(amount, 2),
          sale_price_for_cost_unit: saleLowCostRound(salePriceForCostUnit, 4),
          average_cost: saleLowCostRound(cost, 4),
        });
      }
    }

    resp.success = true;
    resp.data = issues;
    return res.json(resp);
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});
// GET /service/v1/getProductPrice
// à¸”à¸¶à¸‡à¸£à¸²à¸„à¸²à¸ªà¸´à¸™à¸„à¹‰à¸²à¸•à¸±à¸§à¹€à¸”à¸µà¸¢à¸§à¸œà¹ˆà¸²à¸™ getProductPriceLocalx à¹‚à¸”à¸¢à¸•à¸£à¸‡ â€” à¹ƒà¸Šà¹‰à¸ªà¸³à¸«à¸£à¸±à¸š catalog lazy-price
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
// à¹€à¸¥à¸µà¸¢à¸™à¹à¸šà¸š Java: SELECT code, name_1 FROM ic_category
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
// à¸„à¹‰à¸™à¸«à¸²à¸ªà¸´à¸™à¸„à¹‰à¸²à¸ˆà¸²à¸à¸šà¸²à¸£à¹Œà¹‚à¸„à¹‰à¸”à¹ƒà¸™ ic_inventory_barcode
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
// à¹ƒà¸Šà¹‰à¸ªà¸³à¸«à¸£à¸±à¸šà¸«à¸™à¹‰à¸²à¸‚à¸²à¸¢ BizSuit: à¸„à¸·à¸™à¸«à¸™à¹ˆà¸§à¸¢/ratio/stock à¸—à¸µà¹ˆà¸œà¸¹à¸à¸à¸±à¸š barcode à¹‚à¸”à¸¢à¸•à¸£à¸‡
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
// à¸•à¸£à¸§à¸ˆà¸™à¸±à¸šà¸ªà¸•à¹Šà¸­à¸ (76) + à¸›à¸£à¸±à¸šà¸›à¸£à¸¸à¸‡à¸œà¸¥à¸•à¹ˆà¸²à¸‡: à¹€à¸žà¸´à¹ˆà¸¡ (66) à¸«à¸£à¸·à¸­ à¸¥à¸” (68)
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

    // generate doc_no à¸£à¸¹à¸›à¹à¸šà¸š MSTCYYYYDDMM-#### running 4 à¸«à¸¥à¸±à¸
    const yyyy = String(now.getFullYear());
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const prefix = `MSTC${yyyy}${dd}${mm}-`;
    const lastRes = await runQuery("load-last-stock-count-doc", `SELECT doc_no FROM ic_trans WHERE doc_no LIKE $1 ORDER BY doc_no DESC LIMIT 1`, [`${prefix}%`]);
    const lastRunning = lastRes.rows.length > 0 ? parseInt(lastRes.rows[0].doc_no.slice(-4), 10) : 0;
    const doc_no = `${prefix}${String(lastRunning + 1).padStart(4, "0")}`;

    // generate doc_no_adj à¸£à¸¹à¸›à¹à¸šà¸š ISYYYYMMDD-#### running 4 à¸«à¸¥à¸±à¸
    const adjPrefix = `IS${yyyy}${mm}${dd}-`;
    const lastAdjRes = await runQuery("load-last-adjust-doc", `SELECT doc_no FROM ic_trans WHERE doc_no LIKE $1 ORDER BY doc_no DESC LIMIT 1`, [`${adjPrefix}%`]);
    const lastAdjRunning = lastAdjRes.rows.length > 0 ? parseInt(lastAdjRes.rows[0].doc_no.slice(-4), 10) : 0;
    const doc_no_adj = `${adjPrefix}${String(lastAdjRunning + 1).padStart(4, "0")}`;

    // à¸”à¸¶à¸‡ ratio, stand_value, divide_value à¸ˆà¸²à¸ ic_unit_use
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

    // à¸„à¸³à¸™à¸§à¸“à¸¢à¸­à¸”à¸„à¸‡à¹€à¸«à¸¥à¸·à¸­à¸›à¸±à¸ˆà¸ˆà¸¸à¸šà¸±à¸™ (base units) à¹€à¸žà¸·à¹ˆà¸­à¸«à¸² diff
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

      // 2. ic_trans header (76 = à¸•à¸£à¸§à¸ˆà¸™à¸±à¸š)
        await runTxQuery(
          client,
          "insert-ic_trans-76-header",
        `INSERT INTO ic_trans
          (trans_flag, trans_type, doc_no, doc_date, doc_time, doc_format_code,
           remark, branch_code, wh_from, location_from)
         VALUES (76, 3, $1, $2, $3, 'CO', 'à¸›à¸£à¸±à¸šà¸›à¸£à¸¸à¸‡à¸ªà¸•à¹Šà¸­à¸à¹„à¸¡à¹ˆà¸•à¸£à¸‡', $4, $5, $6)`,
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

      // 4. à¹€à¸­à¸à¸ªà¸²à¸£à¸›à¸£à¸±à¸šà¸œà¸¥à¸•à¹ˆà¸²à¸‡ â€” 66 (à¹€à¸žà¸´à¹ˆà¸¡) à¸«à¸£à¸·à¸­ 68 (à¸¥à¸”) à¹€à¸‰à¸žà¸²à¸°à¹€à¸¡à¸·à¹ˆà¸­ diff != 0
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

      // 6. à¸­à¸±à¸›à¹€à¸”à¸• balance_qty à¹ƒà¸™ ic_inventory à¸ˆà¸²à¸à¸¢à¸­à¸”à¸ˆà¸£à¸´à¸‡à¸«à¸¥à¸±à¸‡à¸›à¸£à¸±à¸š
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

// helper à¸¥à¸” code à¸‹à¹‰à¸³à¸ªà¸³à¸«à¸£à¸±à¸š master data à¸—à¸µà¹ˆà¸¡à¸µ search filter
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

// GET /service/v1/getProductItemCodeFormats
router.get("/getProductItemCodeFormats", async (req, res) => {
  try {
    const result = await query(
      `SELECT code, COALESCE(name_1,'') AS name_1, COALESCE(format,'') AS format
       FROM erp_doc_format
       WHERE screen_code = $1
       ORDER BY code`,
      [PRODUCT_CODE_FORMAT_SCREEN],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    console.error("getProductItemCodeFormats error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// GET /service/v1/generateProductItemCode?format_code=&doc_date=
router.get("/generateProductItemCode", async (req, res) => {
  const formatCode = String(req.query.format_code || req.query.code || "").trim().toUpperCase();
  const docDate = String(req.query.doc_date || "").trim();
  if (!formatCode) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸£à¸¹à¸›à¹à¸šà¸šà¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });
  try {
    const formatRes = await query(
      `SELECT code, COALESCE(name_1,'') AS name_1, COALESCE(format,'') AS format
       FROM erp_doc_format
       WHERE screen_code = $1 AND code = $2
       LIMIT 1`,
      [PRODUCT_CODE_FORMAT_SCREEN, formatCode],
    );
    if (!formatRes.rows.length) return res.status(404).json({ success: false, message: "à¹„à¸¡à¹ˆà¸žà¸šà¸£à¸¹à¸›à¹à¸šà¸šà¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });
    const nextCode = await findNextProductItemCode(formatRes.rows[0], docDate);
    return res.json({ success: true, data: { ...nextCode, name_1: formatRes.rows[0].name_1 } });
  } catch (ex) {
    console.error("generateProductItemCode error:", ex.message);
    return res.status(ex.statusCode || 500).json({ success: false, message: ex.message });
  }
});
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
// port à¸ˆà¸²à¸ Java getProductManageList â€” parameterized WHERE, sort whitelist, parallel count
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
    last_purchase_price: "last_purchase_price",
    last_purchase_cust_code: "last_purchase_cust_code",
    last_purchase_cust_name: "last_purchase_cust_name",
    last_purchase_doc_date: "last_purchase_doc_date",
    last_purchase_qty: "last_purchase_qty",
  };
  const effectiveSortField = sortWhitelist[sort_field] ? sort_field : "available_qty";
  const sortCol = sortWhitelist[effectiveSortField];
  const sortDir = sort_order === "desc" ? "DESC" : "ASC";
  const stockSortFields = new Set([
    "real_balance_qty",
    "cart_qty",
    "available_qty",
    "suggest_qty",
    "reached_reorder_point",
    "last_purchase_price",
    "last_purchase_cust_code",
    "last_purchase_cust_name",
    "last_purchase_doc_date",
    "last_purchase_qty",
  ]);

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
    if (!onlyReorder && !stockSortFields.has(effectiveSortField)) {
      const countRes = await query(
        `SELECT COUNT(DISTINCT i.code) AS cnt
         FROM ic_inventory i
         JOIN ic_inventory_detail d ON d.ic_code = i.code
         WHERE ${whereParts.join(" AND ")}`,
        whereParams,
      );
      const result = await query(
        `WITH candidates AS (
           SELECT
             i.code AS item_code,
             MIN(COALESCE(i.name_1,'')) AS item_name,
             MIN(COALESCE(i.name_eng_1,'')) AS item_name_eng,
             COALESCE(i.unit_standard,'') AS unit_code,
             COALESCE(un.name_1, i.unit_standard, '') AS unit_name,
             MAX(COALESCE(d.purchase_point,0))::numeric AS purchase_point,
             MAX(COALESCE(d.minimum_qty,0))::numeric AS minimum_qty,
             MAX(COALESCE(d.maximum_qty,0))::numeric AS maximum_qty
           FROM ic_inventory i
           JOIN ic_inventory_detail d ON d.ic_code = i.code
           LEFT JOIN (SELECT code, MIN(name_1) AS name_1 FROM ic_unit GROUP BY code) un ON un.code = i.unit_standard
           WHERE ${whereParts.join(" AND ")}
           GROUP BY i.code, i.unit_standard, un.name_1
           ORDER BY ${sortCol} ${sortDir}, i.code ASC
           OFFSET ${offsetParam} LIMIT ${limitParam}
         ),
         item_code_list AS (
           SELECT string_agg(item_code, ',') AS codes
           FROM candidates
         ),
         last_purchase AS (
           SELECT
             c.item_code,
             c.unit_code,
             COALESCE(lp.price,0)::numeric AS last_purchase_price,
             COALESCE(lp.cust_code,'') AS last_purchase_cust_code,
             COALESCE(ap.name_1,'') AS last_purchase_cust_name,
             COALESCE(lp.doc_date::text,'') AS last_purchase_doc_date,
             COALESCE(lp.qty,0)::numeric AS last_purchase_qty
           FROM candidates c
           LEFT JOIN LATERAL (
             SELECT d.price, d.cust_code, d.doc_date, d.qty
             FROM ic_trans_detail d
             WHERE d.trans_flag = 12
               AND COALESCE(d.last_status,0) = 0
               AND d.item_code = c.item_code
               AND d.unit_code = c.unit_code
             ORDER BY d.doc_date DESC, d.doc_time DESC
             LIMIT 1
           ) lp ON true
           LEFT JOIN LATERAL (SELECT name_1 FROM ap_supplier WHERE code = lp.cust_code LIMIT 1) ap ON true
         ),
         stock_candidates AS (
           SELECT c.item_code
           FROM candidates c
           JOIN (
             SELECT code
             FROM ic_inventory
             GROUP BY code
             HAVING COUNT(*) = 1
           ) unique_item ON unique_item.code = c.item_code
         ),
         stock AS (
           SELECT c.item_code AS ic_code, COALESCE(SUM(s.balance_qty),0)::numeric AS real_balance_qty
           FROM stock_candidates c
           LEFT JOIN LATERAL sml_ic_function_stock_balance_warehouse_location('NOW()', c.item_code, '', '') s ON true
           GROUP BY c.item_code
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
             c.maximum_qty,
             COALESCE(lp.last_purchase_price,0)::numeric AS last_purchase_price,
             COALESCE(lp.last_purchase_cust_code,'') AS last_purchase_cust_code,
             COALESCE(lp.last_purchase_cust_name,'') AS last_purchase_cust_name,
              COALESCE(lp.last_purchase_doc_date,'') AS last_purchase_doc_date,
              COALESCE(lp.last_purchase_qty,0)::numeric AS last_purchase_qty
           FROM candidates c
           LEFT JOIN stock s ON s.ic_code = c.item_code
           LEFT JOIN cart ON cart.item_code = c.item_code
           LEFT JOIN last_purchase lp ON lp.item_code = c.item_code AND lp.unit_code = c.unit_code
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
        last_purchase_price: Number(row.last_purchase_price || 0),
        last_purchase_qty: Number(row.last_purchase_qty || 0),
        reached_reorder_point: row.reached_reorder_point === true || row.reached_reorder_point === "true",
      }));
      return res.json({ success: true, data: rows, totalCount, totalSuggestQty });
    }

    const result = await query(
      `WITH candidates AS (
         SELECT
           i.code AS item_code,
           MIN(COALESCE(i.name_1,'')) AS item_name,
           MIN(COALESCE(i.name_eng_1,'')) AS item_name_eng,
           COALESCE(i.unit_standard,'') AS unit_code,
           COALESCE(un.name_1, i.unit_standard, '') AS unit_name,
           MAX(COALESCE(d.purchase_point,0))::numeric AS purchase_point,
           MAX(COALESCE(d.minimum_qty,0))::numeric AS minimum_qty,
           MAX(COALESCE(d.maximum_qty,0))::numeric AS maximum_qty
         FROM ic_inventory i
         JOIN ic_inventory_detail d ON d.ic_code = i.code
         LEFT JOIN (SELECT code, MIN(name_1) AS name_1 FROM ic_unit GROUP BY code) un ON un.code = i.unit_standard
         WHERE ${whereParts.join(" AND ")}
         GROUP BY i.code, i.unit_standard, un.name_1
       ),
       last_purchase AS (
         SELECT
           c.item_code,
           c.unit_code,
           COALESCE(lp.price,0)::numeric AS last_purchase_price,
           COALESCE(lp.cust_code,'') AS last_purchase_cust_code,
           COALESCE(ap.name_1,'') AS last_purchase_cust_name,
             COALESCE(lp.doc_date::text,'') AS last_purchase_doc_date,
             COALESCE(lp.qty,0)::numeric AS last_purchase_qty
         FROM candidates c
         LEFT JOIN LATERAL (
           SELECT d.price, d.cust_code, d.doc_date, d.qty
           FROM ic_trans_detail d
           WHERE d.trans_flag = 12
             AND COALESCE(d.last_status,0) = 0
             AND d.item_code = c.item_code
             AND d.unit_code = c.unit_code
           ORDER BY d.doc_date DESC, d.doc_time DESC
           LIMIT 1
         ) lp ON true
         LEFT JOIN LATERAL (SELECT name_1 FROM ap_supplier WHERE code = lp.cust_code LIMIT 1) ap ON true
       ),
       stock_candidates AS (
         SELECT c.item_code
         FROM candidates c
         JOIN (
           SELECT code
           FROM ic_inventory
           GROUP BY code
           HAVING COUNT(*) = 1
         ) unique_item ON unique_item.code = c.item_code
       ),
       stock AS (
         SELECT c.item_code AS ic_code, COALESCE(SUM(s.balance_qty),0)::numeric AS real_balance_qty
         FROM stock_candidates c
         LEFT JOIN LATERAL sml_ic_function_stock_balance_warehouse_location('NOW()', c.item_code, '', '') s ON true
         GROUP BY c.item_code
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
           c.maximum_qty,
           COALESCE(lp.last_purchase_price,0)::numeric AS last_purchase_price,
           COALESCE(lp.last_purchase_cust_code,'') AS last_purchase_cust_code,
           COALESCE(lp.last_purchase_cust_name,'') AS last_purchase_cust_name,
              COALESCE(lp.last_purchase_doc_date,'') AS last_purchase_doc_date,
              COALESCE(lp.last_purchase_qty,0)::numeric AS last_purchase_qty
         FROM candidates c
         LEFT JOIN stock s ON s.ic_code = c.item_code
         LEFT JOIN cart ON cart.item_code = c.item_code
         LEFT JOIN last_purchase lp ON lp.item_code = c.item_code AND lp.unit_code = c.unit_code
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
      last_purchase_price: Number(row.last_purchase_price || 0),
      last_purchase_qty: Number(row.last_purchase_qty || 0),
      reached_reorder_point: row.reached_reorder_point === true || row.reached_reorder_point === "true",
    }));
    return res.json({ success: true, data: rows, totalCount, totalSuggestQty });
  } catch (ex) {
    console.error("getPurchaseStockReorderList error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// ========== PRODUCT ITEM DETAIL (à¸ªà¸³à¸«à¸£à¸±à¸šà¸«à¸™à¹‰à¸²à¹à¸à¹‰à¹„à¸‚) ==========

// GET /service/v1/getProductItemDetail?code=
router.get("/getProductItemDetail", async (req, res) => {
  const code = (req.query.code || "").trim();
  if (!code) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });
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
    if (!result.rows.length) return res.status(400).json({ success: false, message: "à¹„à¸¡à¹ˆà¸žà¸šà¸ªà¸´à¸™à¸„à¹‰à¸²" });
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
  if (!c) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });
  if (!String(unit_standard).trim()) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸«à¸™à¹ˆà¸§à¸¢à¸¡à¸²à¸•à¸£à¸à¸²à¸™" });
  const whCode = String(wh_code || start_sale_wh || "").trim();
  const shelfCode = String(shelf_code || start_sale_shelf || "").trim();
  if (!whCode) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸„à¸¥à¸±à¸‡" });
  if (!shelfCode) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸—à¸µà¹ˆà¹€à¸à¹‡à¸š" });
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
      if (updateResult.rowCount === 0) throw httpError("à¹„à¸¡à¹ˆà¸žà¸šà¸ªà¸´à¸™à¸„à¹‰à¸²", 404);

      await ensureWarehouseShelfExists(client, whCode, shelfCode);
      await ensureWarehouseShelfRowsExist(client, warehouseShelves);
      await ensureProductUnitUse(client, c, String(unit_standard).trim());

      await upsertProductInventoryDetail(client, c, purchasePoint, minimumQty, maximumQty, whCode, shelfCode);
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
  if (!c) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });
  if (!PRODUCT_CODE_PATTERN.test(c)) {
    return res.status(400).json({ success: false, message: "à¸£à¸¹à¸›à¹à¸šà¸šà¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡ (à¸­à¸™à¸¸à¸à¸²à¸• A-Z, 0-9, -, _)" });
  }
  if (!String(name_1).trim()) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸Šà¸·à¹ˆà¸­à¸ªà¸´à¸™à¸„à¹‰à¸²" });
  if (!String(unit_standard).trim()) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸«à¸™à¹ˆà¸§à¸¢à¸¡à¸²à¸•à¸£à¸à¸²à¸™" });
  const whCode = String(wh_code || start_sale_wh || "").trim();
  const shelfCode = String(shelf_code || start_sale_shelf || "").trim();
  if (!whCode) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸„à¸¥à¸±à¸‡" });
  if (!shelfCode) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸—à¸µà¹ˆà¹€à¸à¹‡à¸š" });
  const purchasePoint = normalizeStockLevelQty(purchase_point);
  const minimumQty = normalizeStockLevelQty(minimum_qty);
  const maximumQty = normalizeStockLevelQty(maximum_qty);
  const warehouseShelves = normalizeWarehouseShelfRows(warehouse_shelves, whCode, shelfCode);

  try {
    await withTransaction(async (client) => {
      const exists = await client.query(`SELECT 1 FROM ic_inventory WHERE code = $1::text LIMIT 1`, [c]);
      if (exists.rows.length) {
        const err = new Error("à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¸™à¸µà¹‰à¸¡à¸µà¸­à¸¢à¸¹à¹ˆà¹à¸¥à¹‰à¸§");
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

      await upsertProductInventoryDetail(client, c, purchasePoint, minimumQty, maximumQty, whCode, shelfCode);
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
  if (!ic_code) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const barcode = generateEan13Candidate();
      const exists = await query(`SELECT 1 FROM ic_inventory_barcode WHERE barcode = $1 LIMIT 1`, [barcode]);
      if (!exists.rows.length) return res.json({ success: true, barcode });
    }
    return res.status(409).json({ success: false, message: "à¹„à¸¡à¹ˆà¸ªà¸²à¸¡à¸²à¸£à¸–à¸ªà¸£à¹‰à¸²à¸‡à¸šà¸²à¸£à¹Œà¹‚à¸„à¹‰à¸”à¸—à¸µà¹ˆà¹„à¸¡à¹ˆà¸‹à¹‰à¸³à¹„à¸”à¹‰ à¸à¸£à¸¸à¸“à¸²à¸¥à¸­à¸‡à¹ƒà¸«à¸¡à¹ˆà¸­à¸µà¸à¸„à¸£à¸±à¹‰à¸‡" });
  } catch (ex) {
    console.error("generateProductItemBarcode error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// GET /service/v1/getProductItemBarcodes?ic_code=
router.get("/getProductItemBarcodes", async (req, res) => {
  const ic_code = (req.query.ic_code || "").trim();
  if (!ic_code) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });
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
  if (!c || !b) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¸°à¸šà¸²à¸£à¹Œà¹‚à¸„à¹‰à¸”" });
  try {
    const exists = await query(`SELECT 1 FROM ic_inventory_barcode WHERE barcode = $1 LIMIT 1`, [b]);
    if (exists.rows.length) return res.status(409).json({ success: false, message: "à¸šà¸²à¸£à¹Œà¹‚à¸„à¹‰à¸”à¸™à¸µà¹‰à¸¡à¸µà¸­à¸¢à¸¹à¹ˆà¹à¸¥à¹‰à¸§" });
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
  if (!c || !b) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¸°à¸šà¸²à¸£à¹Œà¹‚à¸„à¹‰à¸”" });
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
  if (!c || !b) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¸°à¸šà¸²à¸£à¹Œà¹‚à¸„à¹‰à¸”" });
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
  if (!ic_code) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });
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
  if (!c || !u) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¸°à¸£à¸«à¸±à¸ªà¸«à¸™à¹ˆà¸§à¸¢à¸™à¸±à¸š" });
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
  if (!c || !u) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¸°à¸£à¸«à¸±à¸ªà¸«à¸™à¹ˆà¸§à¸¢à¸™à¸±à¸š" });
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
      if (updateResult.rowCount === 0) throw httpError("à¹„à¸¡à¹ˆà¸žà¸šà¸«à¸™à¹ˆà¸§à¸¢à¸™à¸±à¸š", 404);
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
  if (!c || !u) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¸°à¸£à¸«à¸±à¸ªà¸«à¸™à¹ˆà¸§à¸¢à¸™à¸±à¸š" });
  try {
    await withTransaction(async (client) => {
      await ensureProductExists(client, c);
      const deleteResult = await client.query(`DELETE FROM ic_unit_use WHERE ic_code=$1 AND code=$2`, [c, u]);
      if (deleteResult.rowCount === 0) throw httpError("à¹„à¸¡à¹ˆà¸žà¸šà¸«à¸™à¹ˆà¸§à¸¢à¸™à¸±à¸š", 404);
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
// query à¸ˆà¸²à¸ main pool (metadata only) â€” à¸•à¸£à¸‡à¸•à¸²à¸¡ Java
router.get("/getProductImages", async (req, res) => {
  const item_code = (req.query.item_code || "").trim();
  if (!item_code) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });
  try {
    const result = await queryImages(`SELECT image_id, guid_code, image_order FROM images WHERE image_id = $1 ORDER BY image_order ASC`, [item_code]);
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    console.error("getProductImages error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// POST /service/v1/saveProductImage
// dual-pool transaction: main + images â€” à¸•à¸£à¸‡à¸•à¸²à¸¡ Java saveProductImage
router.post("/saveProductImage", async (req, res) => {
  const { item_code = "", image_file = "" } = req.body || {};
  const ic = String(item_code).trim();
  const imgData = String(image_file);
  if (!ic || !imgData) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¸°à¸£à¸¹à¸›à¸ à¸²à¸ž" });

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
// dual-pool: à¸¥à¸šà¸—à¸±à¹‰à¸‡ 2 DB
router.post("/deleteProductImage", async (req, res) => {
  const { guid_code = "" } = req.body || {};
  const guid = String(guid_code).trim();
  if (!guid) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸ guid_code" });

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
    return res.status(400).json({ success: false, message: "à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¹„à¸¡à¹ˆà¸„à¸£à¸š" });
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

// ========== SALE PRICE / PROMOTION CRUD ==========

function productManageToInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function productManageNumber(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function productManageDateText(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

async function syncInventoryRoworderSequence(client, tableName) {
  if (!["ic_inventory_price", "ic_inventory_discount"].includes(tableName)) throw httpError("invalid roworder table", 500);
  await client.query(
    `WITH stats AS (SELECT COALESCE(MAX(roworder), 0) AS max_roworder FROM ${tableName})
     SELECT setval(
       pg_get_serial_sequence($1, 'roworder'),
       GREATEST((SELECT max_roworder FROM stats), 1),
       (SELECT max_roworder > 0 FROM stats)
     )`,
    [tableName],
  );
}

router.get("/getProductSalePrices", async (req, res) => {
  const ic_code = String(req.query.ic_code || "").trim();
  if (!ic_code) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });
  try {
    const result = await query(
      `SELECT COALESCE(roworder,0) AS roworder, COALESCE(line_number,0) AS line_number,
              ic_code, unit_code,
              COALESCE(price_type,1) AS price_type,
              COALESCE(price_mode,0) AS price_mode,
              COALESCE(sale_type,0) AS sale_type,
              to_char(from_date,'YYYY-MM-DD') AS from_date,
              to_char(to_date,'YYYY-MM-DD') AS to_date,
              COALESCE(from_qty,0) AS from_qty,
              COALESCE(to_qty,0) AS to_qty,
              COALESCE(sale_price1,0) AS sale_price1,
              COALESCE(sale_price2,0) AS sale_price2,
              COALESCE(cust_code,'') AS cust_code,
              COALESCE(cust_group_1,'') AS cust_group_1,
              COALESCE(cust_group_2,'') AS cust_group_2,
              COALESCE(transport_type,0) AS transport_type,
              COALESCE(currency_code,'') AS currency_code,
              COALESCE(price_currency,0) AS price_currency
         FROM ic_inventory_price
        WHERE ic_code=$1
        ORDER BY unit_code, price_type DESC, price_mode DESC, sale_type DESC, from_date DESC, from_qty, roworder DESC, line_number DESC`,
      [ic_code],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    console.error("getProductSalePrices error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

router.post("/saveProductSalePrice", async (req, res) => {
  const body = req.body || {};
  const icCode = String(body.ic_code || "").trim();
  const unitCode = String(body.unit_code || "").trim();
  const roworder = body.roworder === undefined || body.roworder === null || body.roworder === "" ? null : productManageToInt(body.roworder, NaN);
  if (!icCode || !unitCode) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¸°à¸«à¸™à¹ˆà¸§à¸¢à¸™à¸±à¸š" });
  if (!productManageDateText(body.from_date) || !productManageDateText(body.to_date)) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸Šà¹ˆà¸§à¸‡à¸§à¸±à¸™à¸—à¸µà¹ˆ" });
  if (productManageNumber(body.from_qty, 0) > productManageNumber(body.to_qty, 0)) return res.status(400).json({ success: false, message: "à¸Šà¹ˆà¸§à¸‡à¸ˆà¸³à¸™à¸§à¸™à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡" });

  const priceType = productManageToInt(body.price_type, 1) || 1;
  if (priceType === 1) {
    body.cust_code = "";
    body.cust_group_1 = "";
    body.cust_group_2 = "";
  } else if (priceType === 2) {
    body.cust_code = "";
    if (!String(body.cust_group_1 || "").trim()) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸à¸¥à¸¸à¹ˆà¸¡à¸¥à¸¹à¸à¸„à¹‰à¸² 1" });
  } else if (priceType === 3) {
    body.cust_group_1 = "";
    body.cust_group_2 = "";
    if (!String(body.cust_code || "").trim()) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸£à¸«à¸±à¸ªà¸¥à¸¹à¸à¸„à¹‰à¸²" });
  }

  try {
    await withTransaction(async (client) => {
      await ensureProductExists(client, icCode);
      await ensureProductUnitUse(client, icCode, unitCode);

      const params = [
        icCode,
        roworder,
        unitCode,
        priceType,
        productManageToInt(body.price_mode, 0) || 0,
        productManageToInt(body.sale_type, 0) || 0,
        productManageDateText(body.from_date),
        productManageDateText(body.to_date),
        productManageNumber(body.from_qty, 0),
        productManageNumber(body.to_qty, 0),
        productManageNumber(body.sale_price1, 0),
        productManageNumber(body.sale_price2, 0),
        String(body.cust_code || "").trim(),
        String(body.cust_group_1 || "").trim(),
        String(body.cust_group_2 || "").trim(),
        productManageToInt(body.transport_type, 0) || 0,
        String(body.currency_code || "").trim(),
        productManageToInt(body.price_currency, 0) || 0,
      ];

      if (roworder !== null && Number.isFinite(roworder)) {
        const updated = await client.query(
          `UPDATE ic_inventory_price
              SET unit_code=$3, price_type=$4, price_mode=$5, sale_type=$6,
                  from_date=$7::date, to_date=$8::date, from_qty=$9, to_qty=$10,
                  sale_price1=$11, sale_price2=$12,
                  cust_code=$13, cust_group_1=$14, cust_group_2=$15,
                  transport_type=$16, currency_code=$17, price_currency=$18
            WHERE ic_code=$1 AND roworder=$2`,
          params,
        );
        if (updated.rowCount > 0) return;
      }

      const next = await client.query(`SELECT COALESCE(MAX(line_number),0)+1 AS line_number FROM ic_inventory_price WHERE ic_code=$1`, [icCode]);
      await syncInventoryRoworderSequence(client, "ic_inventory_price");
      await client.query(
        `INSERT INTO ic_inventory_price (
            ic_code, unit_code, line_number, price_type, price_mode, sale_type,
            from_date, to_date, from_qty, to_qty, sale_price1, sale_price2,
            cust_code, cust_group_1, cust_group_2, transport_type, currency_code, price_currency
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [icCode, unitCode, productManageToInt(next.rows[0].line_number, 1) || 1, ...params.slice(3)],
      );
    });
    return res.json({ success: true });
  } catch (ex) {
    console.error("saveProductSalePrice error:", ex.message);
    return res.status(ex.statusCode || 500).json({ success: false, message: ex.message });
  }
});

router.post("/deleteProductSalePrice", async (req, res) => {
  const icCode = String(req.body?.ic_code || "").trim();
  const roworder = productManageToInt(req.body?.roworder, NaN);
  if (!icCode || !Number.isFinite(roworder)) return res.status(400).json({ success: false, message: "à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¹„à¸¡à¹ˆà¸„à¸£à¸š" });
  try {
    await query(`DELETE FROM ic_inventory_price WHERE ic_code=$1 AND roworder=$2`, [icCode, roworder]);
    return res.json({ success: true });
  } catch (ex) {
    console.error("deleteProductSalePrice error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

// ========== DISCOUNT CONDITION CRUD ==========

router.get("/getProductDiscountConditions", async (req, res) => {
  const ic_code = String(req.query.ic_code || "").trim();
  if (!ic_code) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });
  try {
    const result = await query(
      `SELECT COALESCE(roworder,0) AS roworder, COALESCE(line_number,0) AS line_number,
              ic_code, unit_code,
              COALESCE(discount_type,0) AS discount_type,
              COALESCE(sale_type,0) AS sale_type,
              to_char(from_date,'YYYY-MM-DD') AS from_date,
              to_char(to_date,'YYYY-MM-DD') AS to_date,
              COALESCE(from_qty,0) AS from_qty,
              COALESCE(to_qty,0) AS to_qty,
              COALESCE(discount,'') AS discount,
              COALESCE(cust_code,'') AS cust_code,
              COALESCE(cust_group_1,'') AS cust_group_1,
              COALESCE(cust_group_2,'') AS cust_group_2
         FROM ic_inventory_discount
        WHERE ic_code=$1
        ORDER BY unit_code, discount_type DESC, sale_type DESC, from_date DESC, from_qty, roworder DESC, line_number DESC`,
      [ic_code],
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    console.error("getProductDiscountConditions error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});

router.post("/saveProductDiscountCondition", async (req, res) => {
  const body = req.body || {};
  const icCode = String(body.ic_code || "").trim();
  const unitCode = String(body.unit_code || "").trim();
  const roworder = body.roworder === undefined || body.roworder === null || body.roworder === "" ? null : productManageToInt(body.roworder, NaN);
  if (!icCode || !unitCode) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¸°à¸«à¸™à¹ˆà¸§à¸¢à¸™à¸±à¸š" });
  if (!String(body.discount || "").trim()) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸ªà¹ˆà¸§à¸™à¸¥à¸”" });
  if (!productManageDateText(body.from_date) || !productManageDateText(body.to_date)) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸Šà¹ˆà¸§à¸‡à¸§à¸±à¸™à¸—à¸µà¹ˆ" });
  if (productManageNumber(body.from_qty, 0) > productManageNumber(body.to_qty, 0)) return res.status(400).json({ success: false, message: "à¸Šà¹ˆà¸§à¸‡à¸ˆà¸³à¸™à¸§à¸™à¹„à¸¡à¹ˆà¸–à¸¹à¸à¸•à¹‰à¸­à¸‡" });

  const discountType = productManageToInt(body.discount_type, 0) || 0;
  if (discountType === 0) {
    body.cust_code = "";
    body.cust_group_1 = "";
    body.cust_group_2 = "";
  } else if (discountType === 1) {
    body.cust_code = "";
    if (!String(body.cust_group_1 || "").trim()) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸à¸¥à¸¸à¹ˆà¸¡à¸¥à¸¹à¸à¸„à¹‰à¸² 1" });
  } else if (discountType === 2) {
    body.cust_group_1 = "";
    body.cust_group_2 = "";
    if (!String(body.cust_code || "").trim()) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¹€à¸¥à¸·à¸­à¸à¸£à¸«à¸±à¸ªà¸¥à¸¹à¸à¸„à¹‰à¸²" });
  }

  try {
    await withTransaction(async (client) => {
      await ensureProductExists(client, icCode);
      await ensureProductUnitUse(client, icCode, unitCode);

      const params = [
        icCode,
        roworder,
        unitCode,
        discountType,
        productManageToInt(body.sale_type, 0) || 0,
        productManageDateText(body.from_date),
        productManageDateText(body.to_date),
        productManageNumber(body.from_qty, 0),
        productManageNumber(body.to_qty, 0),
        String(body.discount || "").trim(),
        String(body.cust_code || "").trim(),
        String(body.cust_group_1 || "").trim(),
        String(body.cust_group_2 || "").trim(),
      ];

      if (roworder !== null && Number.isFinite(roworder)) {
        const updated = await client.query(
          `UPDATE ic_inventory_discount
              SET unit_code=$3, discount_type=$4, sale_type=$5,
                  from_date=$6::date, to_date=$7::date, from_qty=$8, to_qty=$9,
                  discount=$10, cust_code=$11, cust_group_1=$12, cust_group_2=$13
            WHERE ic_code=$1 AND roworder=$2`,
          params,
        );
        if (updated.rowCount > 0) return;
      }

      const next = await client.query(`SELECT COALESCE(MAX(line_number),0)+1 AS line_number FROM ic_inventory_discount WHERE ic_code=$1`, [icCode]);
      await syncInventoryRoworderSequence(client, "ic_inventory_discount");
      await client.query(
        `INSERT INTO ic_inventory_discount (
            ic_code, unit_code, line_number, discount_type, sale_type,
            from_date, to_date, from_qty, to_qty, discount,
            cust_code, cust_group_1, cust_group_2
         ) VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12,$13)`,
        [icCode, unitCode, productManageToInt(next.rows[0].line_number, 1) || 1, ...params.slice(3)],
      );
    });
    return res.json({ success: true });
  } catch (ex) {
    console.error("saveProductDiscountCondition error:", ex.message);
    return res.status(ex.statusCode || 500).json({ success: false, message: ex.message });
  }
});

router.post("/deleteProductDiscountCondition", async (req, res) => {
  const icCode = String(req.body?.ic_code || "").trim();
  const roworder = productManageToInt(req.body?.roworder, NaN);
  if (!icCode || !Number.isFinite(roworder)) return res.status(400).json({ success: false, message: "à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¹„à¸¡à¹ˆà¸„à¸£à¸š" });
  try {
    await query(`DELETE FROM ic_inventory_discount WHERE ic_code=$1 AND roworder=$2`, [icCode, roworder]);
    return res.json({ success: true });
  } catch (ex) {
    console.error("deleteProductDiscountCondition error:", ex.message);
    return res.status(500).json({ success: false, message: ex.message });
  }
});
// ========== PRICE FORMULA CRUD ==========

// GET /service/v1/getProductPriceFormulas?ic_code=
router.get("/getProductPriceFormulas", async (req, res) => {
  const ic_code = (req.query.ic_code || "").trim();
  if (!ic_code) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²" });
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
  if (!c || !uc) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¸°à¸«à¸™à¹ˆà¸§à¸¢à¸™à¸±à¸š" });
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
  if (!c || !uc) return res.status(400).json({ success: false, message: "à¸à¸£à¸¸à¸“à¸²à¸£à¸°à¸šà¸¸à¸£à¸«à¸±à¸ªà¸ªà¸´à¸™à¸„à¹‰à¸²à¹à¸¥à¸°à¸«à¸™à¹ˆà¸§à¸¢à¸™à¸±à¸š" });
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





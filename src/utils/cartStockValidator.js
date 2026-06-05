function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function runQuery(db, sql, params = []) {
  if (typeof db === 'function') return db(sql, params);
  return db.query(sql, params);
}

function mapStockRows(rows = []) {
  const stockIssues = rows
    .filter((row) => row.issue_type)
    .map((row) => ({
      item_code: row.item_code,
      item_name: row.item_name,
      unit_code: row.unit_code,
      qty_in_cart: toNumber(row.qty_in_cart),
      balance_qty: toNumber(row.available_qty),
      stock_qty: toNumber(row.stock_qty),
      reserved_other_qty: toNumber(row.reserved_other_qty),
      issue_type: row.issue_type,
    }));

  return {
    success: true,
    is_valid: stockIssues.length === 0,
    stock_issues: stockIssues,
    checked_items: rows.map((row) => ({
      item_code: row.item_code,
      item_name: row.item_name,
      unit_code: row.unit_code,
      qty_in_cart: toNumber(row.qty_in_cart),
      balance_qty: toNumber(row.available_qty),
      stock_qty: toNumber(row.stock_qty),
      reserved_other_qty: toNumber(row.reserved_other_qty),
    })),
  };
}

function stockCheckSelectSql(sourceCte, sourceWhere = '') {
  return `
    WITH source_rows AS (
      ${sourceCte}
    ),
    stock_items AS (
      SELECT
        s.item_code,
        MAX(COALESCE(NULLIF(s.item_name, ''), i.name_1, s.item_code)) AS item_name,
        MAX(COALESCE(NULLIF(i.unit_standard, ''), s.unit_code, '')) AS unit_code,
        SUM(
          COALESCE(s.qty, 0)::numeric
          * COALESCE(
              NULLIF(s.ratio, 0),
              NULLIF(u.ratio::numeric, 0),
              COALESCE(u.stand_value::numeric, 1) / NULLIF(COALESCE(u.divide_value::numeric, 1), 0),
              1
            )
        ) AS qty_in_cart
      FROM source_rows s
      LEFT JOIN ic_inventory i ON i.code = s.item_code
      LEFT JOIN ic_unit_use u
             ON u.ic_code = s.item_code
            AND u.code = s.unit_code
      WHERE COALESCE(NULLIF(s.item_type_text, '')::int, i.item_type, 0) NOT IN (1, 3)
        AND COALESCE(NULLIF(s.item_code, ''), '') <> ''
        ${sourceWhere}
      GROUP BY s.item_code
    ),
    item_code_list AS (
      SELECT string_agg(item_code, ',') AS codes
      FROM stock_items
    ),
    stock AS (
      SELECT f.ic_code, SUM(f.balance_qty) AS stock_qty
      FROM (SELECT codes FROM item_code_list WHERE COALESCE(codes, '') <> '') l
      CROSS JOIN LATERAL sml_ic_function_stock_balance_warehouse_location(
        current_date, l.codes, '', ''
      ) f
      GROUP BY f.ic_code
    ),
    other_reserved AS (
      SELECT
        c.item_code,
        SUM(
          COALESCE(c.qty, 0)::numeric
          * COALESCE(
              NULLIF(c.ratio::numeric, 0),
              NULLIF(u.ratio::numeric, 0),
              COALESCE(u.stand_value::numeric, 1) / NULLIF(COALESCE(u.divide_value::numeric, 1), 0),
              1
            )
        ) AS reserved_qty
      FROM staff_cart_order c
      LEFT JOIN ic_inventory i ON i.code = c.item_code
      LEFT JOIN ic_unit_use u
             ON u.ic_code = c.item_code
            AND u.code = c.unit_code
      WHERE c.cust_code LIKE 'BASKET-%'
        AND ($1::text = '' OR c.cust_code <> $1::text)
        AND c.item_code IN (SELECT item_code FROM stock_items)
        AND COALESCE(NULLIF(c.item_type::text, '')::int, i.item_type, 0) NOT IN (1, 3)
      GROUP BY c.item_code
    )
    SELECT
      si.item_code,
      si.item_name,
      si.unit_code,
      si.qty_in_cart,
      COALESCE(st.stock_qty, 0) AS stock_qty,
      COALESCE(orv.reserved_qty, 0) AS reserved_other_qty,
      GREATEST(COALESCE(st.stock_qty, 0) - COALESCE(orv.reserved_qty, 0), 0) AS available_qty,
      CASE
        WHEN COALESCE(st.stock_qty, 0) <= 0 THEN 'out_of_stock'
        WHEN si.qty_in_cart > GREATEST(COALESCE(st.stock_qty, 0) - COALESCE(orv.reserved_qty, 0), 0) THEN 'exceeding'
        ELSE NULL
      END AS issue_type
    FROM stock_items si
    LEFT JOIN stock st ON st.ic_code = si.item_code
    LEFT JOIN other_reserved orv ON orv.item_code = si.item_code
    ORDER BY si.item_name, si.item_code
  `;
}

async function validateCartStock(db, cartKey) {
  const sourceCte = `
    SELECT
      c.item_code,
      c.item_name,
      c.unit_code,
      c.qty::numeric AS qty,
      c.item_type::text AS item_type_text,
      c.ratio::numeric AS ratio
    FROM staff_cart_order c
    WHERE c.cust_code = $1
  `;
  const result = await runQuery(db, stockCheckSelectSql(sourceCte), [cartKey || '']);
  return mapStockRows(result.rows);
}

async function validateSaleItemsStock(db, items = [], { excludeCartKey = '' } = {}) {
  const normalizedItems = (Array.isArray(items) ? items : []).map((item) => ({
    item_code: String(item.item_code || ''),
    item_name: String(item.item_name || ''),
    unit_code: String(item.unit_code || ''),
    qty: toNumber(item.qty),
    item_type: String(item.item_type ?? ''),
    ratio: toNumber(item.ratio, 0),
  }));

  if (normalizedItems.length === 0) {
    return { success: true, is_valid: true, stock_issues: [], checked_items: [] };
  }

  const sourceCte = `
    SELECT
      p.item_code,
      p.item_name,
      p.unit_code,
      p.qty,
      p.item_type AS item_type_text,
      p.ratio
    FROM jsonb_to_recordset($2::jsonb) AS p(
      item_code text,
      item_name text,
      unit_code text,
      qty numeric,
      item_type text,
      ratio numeric
    )
  `;
  const result = await runQuery(db, stockCheckSelectSql(sourceCte), [
    excludeCartKey || '',
    JSON.stringify(normalizedItems),
  ]);
  return mapStockRows(result.rows);
}

module.exports = {
  validateCartStock,
  validateSaleItemsStock,
};

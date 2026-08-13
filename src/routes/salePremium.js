const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { getEmployeePermissions } = require('../utils/permissions');
const {
  safeText,
  toNumber,
  normalizeDate,
  ensureSalePremiumSchema,
  loadSalePremiumDetail,
  resolveBasketPricingContext,
} = require('../utils/salePremiumHelper');

const SALE_PREMIUM_MANAGE_PERMISSION = 'sale.premium.manage';

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePayload(body) {
  let payload = body || {};
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  if (payload && typeof payload.payload === 'object') payload = payload.payload;
  return payload || {};
}

async function employeeHasPermission(queryFn, userCode, permissionKey) {
  const code = safeText(userCode);
  if (!code) return false;
  const permissions = await getEmployeePermissions(queryFn, code);
  return permissions.includes(permissionKey);
}

router.get('/sale-premium/list', async (req, res) => {
  try {
    await ensureSalePremiumSchema(query);
    const search = safeText(req.query.search);
    const includeInactive = String(req.query.include_inactive ?? '0') === '1';
    const params = [];
    let where = '1=1';
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (p.premium_code ILIKE $${params.length} OR p.name_1 ILIKE $${params.length})`;
    }
    if (!includeInactive) where += ` AND COALESCE(p.important,0)=0`;

    const result = await query(
      `SELECT p.premium_code,
              p.name_1,
              p.date_begin::text AS date_begin,
              p.date_end::text AS date_end,
              COALESCE(p.important,0) AS important,
              COALESCE(p.remark,'') AS remark,
              (SELECT COUNT(*) FROM sml_sale_premium_condition c WHERE c.premium_code=p.premium_code) AS condition_count,
              (SELECT COUNT(*) FROM sml_sale_premium_free_list l WHERE l.premium_code=p.premium_code) AS list_count
         FROM sml_sale_premium p
        WHERE ${where}
        ORDER BY p.premium_code`,
      params,
    );
    return res.json({ success: true, data: result.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/sale-premium/detail', async (req, res) => {
  const code = safeText(req.query.premium_code);
  if (!code) return res.status(400).json({ success: false, msg: 'premium_code is required' });
  try {
    await ensureSalePremiumSchema(query);
    const [headerRes, condRes, freeRes] = await Promise.all([
      query(
        `SELECT premium_code, name_1, date_begin::text AS date_begin, date_end::text AS date_end,
                COALESCE(important,0) AS important, COALESCE(remark,'') AS remark
           FROM sml_sale_premium
          WHERE premium_code=$1
          LIMIT 1`,
        [code],
      ),
      query(
        `SELECT c.premium_code, c.ic_code, c.unit_code, c.qty::text AS qty,
                c.stand_value::text AS stand_value, c.divide_value::text AS divide_value,
                COALESCE(i.name_1,'') AS ic_name,
                COALESCE(u.name_1,'') AS unit_name,
                c.roworder AS line_number
           FROM sml_sale_premium_condition c
           LEFT JOIN ic_inventory i ON i.code=c.ic_code
           LEFT JOIN ic_unit u ON u.code=c.unit_code
          WHERE c.premium_code=$1
          ORDER BY c.roworder, c.ic_code`,
        [code],
      ),
      query(
        `SELECT l.premium_code, l.ic_code, l.unit_code, l.qty::text AS qty,
                l.stand_value::text AS stand_value, l.divide_value::text AS divide_value,
                COALESCE(i.name_1,'') AS ic_name,
                COALESCE(u.name_1,'') AS unit_name,
                l.roworder AS line_number
           FROM sml_sale_premium_free_list l
           LEFT JOIN ic_inventory i ON i.code=l.ic_code
           LEFT JOIN ic_unit u ON u.code=l.unit_code
          WHERE l.premium_code=$1
          ORDER BY l.roworder, l.ic_code`,
        [code],
      ),
    ]);
    const header = headerRes.rows[0];
    if (!header) return res.status(404).json({ success: false, msg: 'premium not found' });
    return res.json({ success: true, data: { ...header, conditions: condRes.rows, lists: freeRes.rows } });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

router.get('/sale-premium/detail-for-sale', async (req, res) => {
  const code = safeText(req.query.premium_code);
  if (!code) return res.status(400).json({ success: false, msg: 'premium_code is required' });
  try {
    const basketCtx = await resolveBasketPricingContext(query, safeText(req.query.cust_code));
    const saleTypeReq = parseInt(req.query.sale_type, 10);
    const vatTypeReq = parseInt(req.query.vat_type, 10);
    const vatRateReq = parseFloat(req.query.vat_rate);
    const detail = await loadSalePremiumDetail(query, code, {
      custCode: safeText(req.query.cust_code),
      saleType: Number.isNaN(saleTypeReq) ? basketCtx.saleType : saleTypeReq,
      vatType: Number.isNaN(vatTypeReq) ? basketCtx.vatType : vatTypeReq,
      vatRate: Number.isNaN(vatRateReq) ? basketCtx.vatRate : vatRateReq,
      docDate: safeText(req.query.doc_date),
    });
    return res.json({ success: true, data: detail });
  } catch (ex) {
    return res.status(400).json({ success: false, msg: ex.message });
  }
});

router.post('/sale-premium/save', async (req, res) => {
  const payload = normalizePayload(req.body);
  const userCode = safeText(payload.emp_code || req.query.user_code);
  if (!(await employeeHasPermission(query, userCode, SALE_PREMIUM_MANAGE_PERMISSION))) {
    return res.status(403).json({ success: false, msg: `permission denied: ${SALE_PREMIUM_MANAGE_PERMISSION}` });
  }

  const premiumCode = safeText(payload.premium_code);
  const name1 = safeText(payload.name_1);
  const dateBegin = normalizeDate(payload.date_begin);
  const dateEnd = normalizeDate(payload.date_end);
  const important = toNumber(payload.important) === 1 ? 1 : 0;
  const conditions = normalizeArray(payload.conditions);
  const lists = normalizeArray(payload.lists);
  const mode = safeText(payload.mode).toLowerCase() === 'update' ? 'update' : 'create';

  if (!premiumCode) return res.status(400).json({ success: false, msg: 'premium_code is required' });
  if (!name1) return res.status(400).json({ success: false, msg: 'name_1 is required' });
  if (!conditions.length) return res.status(400).json({ success: false, msg: 'conditions cannot be empty' });
  if (!lists.length) return res.status(400).json({ success: false, msg: 'lists cannot be empty' });

  const invalidConditions = conditions
    .map((row, idx) => ({ idx, code: safeText(row?.ic_code), unit: safeText(row?.unit_code), qty: toNumber(row?.qty) }))
    .filter((row) => !row.code || !row.unit || row.qty <= 0);
  if (invalidConditions.length) {
    return res.status(400).json({ success: false, msg: `invalid condition rows: ${invalidConditions.map((r) => r.idx + 1).join(', ')}` });
  }
  const invalidLists = lists
    .map((row, idx) => ({ idx, code: safeText(row?.ic_code), unit: safeText(row?.unit_code), qty: toNumber(row?.qty) }))
    .filter((row) => !row.code || !row.unit || row.qty <= 0);
  if (invalidLists.length) {
    return res.status(400).json({ success: false, msg: `invalid free rows: ${invalidLists.map((r) => r.idx + 1).join(', ')}` });
  }

  try {
    const result = await withTransaction(async (client) => {
      await ensureSalePremiumSchema(client.query.bind(client));
      if (mode === 'create') {
        const dup = await client.query('SELECT 1 FROM sml_sale_premium WHERE premium_code=$1 LIMIT 1', [premiumCode]);
        if (dup.rows[0]) throw new Error(`premium_code already exists: ${premiumCode}`);
      }

      const existing = await client.query('SELECT roworder FROM sml_sale_premium WHERE premium_code=$1 LIMIT 1', [premiumCode]);
      if (existing.rows[0]) {
        await client.query(
          `UPDATE sml_sale_premium
              SET name_1=$2, date_begin=$3::date, date_end=$4::date,
                  important=$5, remark=$6, guid_code=COALESCE(NULLIF($7,''), guid_code),
                  create_date_time_now=NOW()
            WHERE premium_code=$1`,
          [premiumCode, name1, dateBegin, dateEnd, important, safeText(payload.remark), safeText(payload.guid_code)],
        );
      } else {
        await client.query(
          `INSERT INTO sml_sale_premium
              (premium_code, name_1, date_begin, date_end, important, remark, guid_code, creator_code, create_date_time_now)
           VALUES ($1,$2,$3::date,$4::date,$5,$6,$7,$8,NOW())`,
          [premiumCode, name1, dateBegin, dateEnd, important, safeText(payload.remark), safeText(payload.guid_code), userCode],
        );
      }

      await client.query('DELETE FROM sml_sale_premium_condition WHERE premium_code=$1', [premiumCode]);
      for (const row of conditions) {
        await client.query(
          `INSERT INTO sml_sale_premium_condition
              (premium_code, ic_code, unit_code, qty, stand_value, divide_value)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            premiumCode,
            safeText(row.ic_code),
            safeText(row.unit_code),
            toNumber(row.qty),
            toNumber(row.stand_value, 1),
            toNumber(row.divide_value, 1),
          ],
        );
      }

      await client.query('DELETE FROM sml_sale_premium_free_list WHERE premium_code=$1', [premiumCode]);
      for (const row of lists) {
        await client.query(
          `INSERT INTO sml_sale_premium_free_list
              (premium_code, ic_code, unit_code, qty, stand_value, divide_value)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            premiumCode,
            safeText(row.ic_code),
            safeText(row.unit_code),
            toNumber(row.qty),
            toNumber(row.stand_value, 1),
            toNumber(row.divide_value, 1),
          ],
        );
      }
      return { premium_code: premiumCode, condition_count: conditions.length, list_count: lists.length };
    });
    return res.json({ success: true, msg: 'success', data: result });
  } catch (ex) {
    return res.status(400).json({ success: false, msg: ex.message });
  }
});

router.post('/sale-premium/delete', async (req, res) => {
  const payload = normalizePayload(req.body);
  const userCode = safeText(payload.emp_code || req.query.user_code);
  if (!(await employeeHasPermission(query, userCode, SALE_PREMIUM_MANAGE_PERMISSION))) {
    return res.status(403).json({ success: false, msg: `permission denied: ${SALE_PREMIUM_MANAGE_PERMISSION}` });
  }
  const premiumCode = safeText(payload.premium_code);
  if (!premiumCode) return res.status(400).json({ success: false, msg: 'premium_code is required' });
  try {
    await withTransaction(async (client) => {
      await ensureSalePremiumSchema(client.query.bind(client));
      await client.query('DELETE FROM sml_sale_premium_condition WHERE premium_code=$1', [premiumCode]);
      await client.query('DELETE FROM sml_sale_premium_free_list WHERE premium_code=$1', [premiumCode]);
      const result = await client.query('DELETE FROM sml_sale_premium WHERE premium_code=$1', [premiumCode]);
      if (result.rowCount === 0) throw new Error(`premium_code not found: ${premiumCode}`);
    });
    return res.json({ success: true, msg: 'deleted', data: { premium_code: premiumCode } });
  } catch (ex) {
    return res.status(400).json({ success: false, msg: ex.message });
  }
});

module.exports = router;

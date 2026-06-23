// ของแถมซื้อ (Purchase Premium)
// Master data + calculate engine สำหรับระบบ "ซื้อ A ครบ X → แถม B"
// อ้างอิง: smlerp/SMLERPGlobal/_data.cs:23363-23474 (ic_purchase_permium*)
//          smlerp/SMLInventoryControl/_icTransControl.cs:17795-17856 (_checkPurchasePermiumButton_Click)

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../db');
const { getEmployeePermissions } = require('../utils/permissions');

const PURCHASE_PREMIUM_MANAGE_PERMISSION = 'purchase.premium.manage';

function safeText(value) {
  return String(value ?? '').trim();
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeDate(value) {
  const text = safeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

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

// ============================================================
// GET /purchase-permium/list  — รายการเงื่อนไขของแถม
// ============================================================
router.get('/list', async (req, res) => {
  try {
    const search = safeText(req.query.search);
    const includeInactive = String(req.query.include_inactive ?? '0') === '1';
    const params = [];
    let where = '1=1';
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (p.permium_code ILIKE $${params.length} OR p.name_1 ILIKE $${params.length})`;
    }
    if (!includeInactive) {
      where += ` AND COALESCE(p.important, 0) = 0`;
    }

    const rowsRes = await query(
      `SELECT p.permium_code,
              p.name_1,
              p.date_begin::text  AS date_begin,
              p.date_end::text    AS date_end,
              COALESCE(p.important,0) AS important,
              (SELECT COUNT(*) FROM ic_purchase_permium_condition c WHERE c.permium_code = p.permium_code) AS condition_count,
              (SELECT COUNT(*) FROM ic_purchase_permium_list l     WHERE l.permium_code = p.permium_code)     AS list_count
         FROM ic_purchase_permium p
        WHERE ${where}
        ORDER BY p.permium_code`,
      params,
    );
    return res.json({ success: true, data: rowsRes.rows });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ============================================================
// GET /purchase-permium/detail?permium_code=  — 1 เงื่อนไข + conditions + lists
// ============================================================
router.get('/detail', async (req, res) => {
  const code = safeText(req.query.permium_code);
  if (!code) return res.status(400).json({ success: false, msg: 'permium_code is required' });

  try {
    const [headerRes, conditionRes, listRes] = await Promise.all([
      query(
        `SELECT permium_code, name_1,
                date_begin::text AS date_begin,
                date_end::text   AS date_end,
                COALESCE(important,0) AS important
           FROM ic_purchase_permium
          WHERE permium_code = $1
          LIMIT 1`,
        [code],
      ),
      query(
        // เติม ic_name/unit_name จากตารางสินค้า/หน่วยเพราะตาราง condition ไม่เก็บชื่อจริง
        `SELECT c.permium_code, c.ic_code, c.unit_code, c.qty::text AS qty,
                COALESCE(i.name_1,'') AS ic_name,
                COALESCE(u.name_1,'') AS unit_name,
                c.stand_value::text AS stand_value, c.divide_value::text AS divide_value,
                c.roworder AS line_number
           FROM ic_purchase_permium_condition c
           LEFT JOIN ic_inventory i ON i.code = c.ic_code
           LEFT JOIN ic_unit u ON u.code = c.unit_code
          WHERE c.permium_code = $1
          ORDER BY c.roworder, c.ic_code`,
        [code],
      ),
      query(
        `SELECT l.permium_code, l.ic_code, l.unit_code, l.qty::text AS qty,
                COALESCE(i.name_1,'') AS ic_name,
                COALESCE(u.name_1,'') AS unit_name,
                l.roworder AS line_number
           FROM ic_purchase_permium_list l
           LEFT JOIN ic_inventory i ON i.code = l.ic_code
           LEFT JOIN ic_unit u ON u.code = l.unit_code
          WHERE l.permium_code = $1
          ORDER BY l.roworder, l.ic_code`,
        [code],
      ),
    ]);

    const header = headerRes.rows[0];
    if (!header) return res.status(404).json({ success: false, msg: 'premium not found' });

    return res.json({
      success: true,
      data: { ...header, conditions: conditionRes.rows, lists: listRes.rows },
    });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

// ============================================================
// POST /purchase-permium/save  — create / update
// ============================================================
router.post('/save', async (req, res) => {
  const payload = normalizePayload(req.body);
  const userCode = safeText(payload.emp_code || req.query.user_code);

  // SUPERADMIN ผ่านได้ทุกสิทธิ์; ตารางยังไม่มี row ก็ default allow
  if (!(await employeeHasPermission(query, userCode, PURCHASE_PREMIUM_MANAGE_PERMISSION))) {
    return res.status(403).json({ success: false, msg: `permission denied: ${PURCHASE_PREMIUM_MANAGE_PERMISSION}` });
  }

  const permiumCode = safeText(payload.permium_code);
  const name1 = safeText(payload.name_1);
  const dateBegin = normalizeDate(payload.date_begin);
  const dateEnd = normalizeDate(payload.date_end);
  const important = toNumber(payload.important, 0) === 1 ? 1 : 0;
  const conditions = normalizeArray(payload.conditions);
  const lists = normalizeArray(payload.lists);
  const mode = String(payload.mode || '').trim().toLowerCase() === 'update' ? 'update' : 'create';

  if (!permiumCode) return res.status(400).json({ success: false, msg: 'permium_code is required' });
  if (!name1) return res.status(400).json({ success: false, msg: 'name_1 is required' });
  if (!conditions.length) return res.status(400).json({ success: false, msg: 'conditions cannot be empty' });
  if (!lists.length) return res.status(400).json({ success: false, msg: 'lists cannot be empty' });

  // ตรวจทุกแถว
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
    return res.status(400).json({ success: false, msg: `invalid list rows: ${invalidLists.map((r) => r.idx + 1).join(', ')}` });
  }

  try {
    const result = await withTransaction(async (client) => {
      // ตรวจซ้ำใน mode create
      if (mode === 'create') {
        const dupRes = await client.query(
          `SELECT 1 FROM ic_purchase_permium WHERE permium_code = $1 LIMIT 1`,
          [permiumCode],
        );
        if (dupRes.rows[0]) throw new Error(`permium_code already exists: ${permiumCode}`);
      }

      // header — PK คือ roworder (serial) ไม่ใช่ permium_code จึงใช้ ON CONFLICT ไม่ได้
      // ตรวจซ้ำด้วย permium_code แล้ว insert/update แบบ manual
      const existing = await client.query(
        `SELECT roworder FROM ic_purchase_permium WHERE permium_code = $1 LIMIT 1`,
        [permiumCode],
      );
      if (existing.rows[0]) {
        await client.query(
          `UPDATE ic_purchase_permium
              SET name_1 = $2, date_begin = $3::date, date_end = $4::date,
                  important = $5, guid_code = COALESCE(NULLIF($6,''), guid_code),
                  create_date_time_now = NOW()
            WHERE permium_code = $1`,
          [permiumCode, name1, dateBegin, dateEnd, important, safeText(payload.guid_code)],
        );
      } else {
        await client.query(
          `INSERT INTO ic_purchase_permium
              (permium_code, name_1, date_begin, date_end, important, guid_code, create_date_time_now)
           VALUES ($1, $2, $3::date, $4::date, $5, $6, NOW())`,
          [permiumCode, name1, dateBegin, dateEnd, important, safeText(payload.guid_code)],
        );
      }

      // rebuild conditions — schema จริง: permium_code, ic_code, unit_code, qty,
      // stand_value, divide_value (roworder serial auto)
      await client.query(`DELETE FROM ic_purchase_permium_condition WHERE permium_code = $1`, [permiumCode]);
      for (let i = 0; i < conditions.length; i += 1) {
        const row = conditions[i] || {};
        await client.query(
          `INSERT INTO ic_purchase_permium_condition
              (permium_code, ic_code, unit_code, qty, stand_value, divide_value)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            permiumCode,
            safeText(row.ic_code),
            safeText(row.unit_code),
            toNumber(row.qty),
            toNumber(row.stand_value, 1),
            toNumber(row.divide_value, 1),
          ],
        );
      }

      // rebuild lists — schema จริง: permium_code, ic_code, unit_code, qty (roworder serial)
      await client.query(`DELETE FROM ic_purchase_permium_list WHERE permium_code = $1`, [permiumCode]);
      for (let i = 0; i < lists.length; i += 1) {
        const row = lists[i] || {};
        await client.query(
          `INSERT INTO ic_purchase_permium_list
              (permium_code, ic_code, unit_code, qty)
           VALUES ($1, $2, $3, $4)`,
          [
            permiumCode,
            safeText(row.ic_code),
            safeText(row.unit_code),
            toNumber(row.qty),
          ],
        );
      }
      return { permium_code: permiumCode, condition_count: conditions.length, list_count: lists.length };
    });
    return res.json({ success: true, msg: 'success', data: result });
  } catch (ex) {
    return res.status(400).json({ success: false, msg: ex.message });
  }
});

// ============================================================
// POST /purchase-permium/delete
// ============================================================
router.post('/delete', async (req, res) => {
  const payload = normalizePayload(req.body);
  const userCode = safeText(payload.emp_code || req.query.user_code);
  if (!(await employeeHasPermission(query, userCode, PURCHASE_PREMIUM_MANAGE_PERMISSION))) {
    return res.status(403).json({ success: false, msg: `permission denied: ${PURCHASE_PREMIUM_MANAGE_PERMISSION}` });
  }
  const permiumCode = safeText(payload.permium_code);
  if (!permiumCode) return res.status(400).json({ success: false, msg: 'permium_code is required' });

  try {
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM ic_purchase_permium_condition WHERE permium_code = $1`, [permiumCode]);
      await client.query(`DELETE FROM ic_purchase_permium_list WHERE permium_code = $1`, [permiumCode]);
      const delRes = await client.query(`DELETE FROM ic_purchase_permium WHERE permium_code = $1`, [permiumCode]);
      if (delRes.rowCount === 0) throw new Error(`permium_code not found: ${permiumCode}`);
    });
    return res.json({ success: true, msg: 'deleted', data: { permium_code: permiumCode } });
  } catch (ex) {
    return res.status(400).json({ success: false, msg: ex.message });
  }
});

// ============================================================
// POST /purchase-permium/calculate
//
// รับ: { doc_date: 'YYYY-MM-DD', items: [{ item_code, unit_code, qty }] }
// คืน: { success, data: [{ permium_code, permium_name, item_code, item_name,
//                           unit_code, unit_name, qty, matched_sets }] }
//
// Logic (port จาก Java _purchase_permium_process ที่ C# เรียก):
//   1. ดึงเงื่อนไขที่ active ใน doc_date (date_begin/end คลุม)
//   2. รวมยอดซื้อของลูกค้าตาม item_code + unit_code
//   3. สำหรับแต่ละเงื่อนไข:
//      - คำนวณ sets = min( floor(qty_purchased / qty_required) ) ทุก condition
//      - ถ้า sets > 0 → แต่ละ list row ได้ qty = list.qty * sets
//   4. คืน list รายการของแถมทั้งหมดที่คำนวณได้
// ============================================================
router.post('/calculate', async (req, res) => {
  const payload = normalizePayload(req.body);
  const docDate = normalizeDate(payload.doc_date) || new Date().toISOString().slice(0, 10);
  const items = normalizeArray(payload.items);

  if (!items.length) return res.json({ success: true, data: [] });

  try {
    // 1. ดึงเงื่อนไขที่ active
    const permiumRes = await query(
      `SELECT permium_code, name_1
         FROM ic_purchase_permium
        WHERE COALESCE(important, 0) = 0
          AND (date_begin IS NULL OR date_begin <= $1::date)
          AND (date_end   IS NULL OR date_end   >= $1::date)`,
      [docDate],
    );
    if (!permiumRes.rows.length) return res.json({ success: true, data: [] });

    // 2. รวมยอดซื้อของแต่ละสินค้า (matching key = item_code + unit_code)
    const purchasedMap = new Map();
    for (const item of items) {
      const key = `${safeText(item.item_code)}::${safeText(item.unit_code)}`;
      purchasedMap.set(key, toNumber(purchasedMap.get(key)) + toNumber(item.qty));
    }

    // 3. ดึง conditions + lists ทั้งหมดของเงื่อนไขที่ active
    const codes = permiumRes.rows.map((row) => row.permium_code);
    const [condRes, listRes] = await Promise.all([
      query(
        `SELECT permium_code, ic_code, unit_code, qty
           FROM ic_purchase_permium_condition
          WHERE permium_code = ANY($1::text[])`,
        [codes],
      ),
      query(
        `SELECT l.permium_code, l.ic_code, l.unit_code, l.qty,
                COALESCE(i.name_1,'') AS ic_name,
                COALESCE(u.name_1,'') AS unit_name
           FROM ic_purchase_permium_list l
           LEFT JOIN ic_inventory i ON i.code = l.ic_code
           LEFT JOIN ic_unit u ON u.code = l.unit_code
          WHERE l.permium_code = ANY($1::text[])`,
        [codes],
      ),
    ]);

    // จัดกลุ่ม conditions ตาม permium_code
    const conditionsByCode = new Map();
    for (const row of condRes.rows) {
      if (!conditionsByCode.has(row.permium_code)) conditionsByCode.set(row.permium_code, []);
      conditionsByCode.get(row.permium_code).push(row);
    }

    // 4. คำนวณ sets ของแต่ละเงื่อนไข
    const results = [];
    for (const permium of permiumRes.rows) {
      const conds = conditionsByCode.get(permium.permium_code) || [];
      if (!conds.length) continue;

      // sets = min ของ floor(qty_purchased / qty_required) ทุก condition
      let sets = Infinity;
      for (const cond of conds) {
        const key = `${safeText(cond.ic_code)}::${safeText(cond.unit_code)}`;
        const purchased = toNumber(purchasedMap.get(key));
        const required = toNumber(cond.qty);
        if (required <= 0) { sets = 0; break; }
        sets = Math.min(sets, Math.floor(purchased / required));
      }
      if (!Number.isFinite(sets) || sets <= 0) continue;

      // 5. แต่ละ list row ได้ qty = list.qty * sets
      const permiumLists = listRes.rows.filter((row) => row.permium_code === permium.permium_code);
      for (const listItem of permiumLists) {
        const listQty = toNumber(listItem.qty);
        if (listQty <= 0) continue;
        results.push({
          permium_code: permium.permium_code,
          permium_name: permium.name_1,
          item_code: listItem.ic_code,
          item_name: listItem.ic_name || '',
          unit_code: listItem.unit_code,
          unit_name: listItem.unit_name || '',
          qty: roundQty(listQty * sets),
          matched_sets: sets,
        });
      }
    }

    return res.json({ success: true, data: results });
  } catch (ex) {
    return res.status(500).json({ success: false, msg: ex.message });
  }
});

function roundQty(value) {
  const num = toNumber(value);
  return Math.round(num * 10000) / 10000;
}

module.exports = router;

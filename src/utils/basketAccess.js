const DEFAULT_BASKET_ACCESS = {
  allow_all_baskets: true,
  basket_range_text: '',
  basket_ids: [],
  other_staff_basket_level: 3,
  can_edit_other_basket: true,
  can_edit_other_items: true,
  can_save_other_sale: true,
};

function normalizeUserCode(value) {
  return String(value || '').trim();
}

function isSuperAdmin(userCode) {
  return normalizeUserCode(userCode).toUpperCase() === 'SUPERADMIN';
}

function parseBasketRange(input) {
  const text = String(input || '').trim();
  if (!text) return [];

  const normalized = text.replace(/\s*-\s*/g, '-');
  const tokens = normalized.split(/[,\s]+/).map((token) => token.trim()).filter(Boolean);
  const ids = new Set();

  for (const token of tokens) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      if (start < 1 || end < 1 || end < start) {
        throw new Error(`invalid basket range: ${token}`);
      }
      for (let id = start; id <= end; id += 1) ids.add(id);
      continue;
    }

    if (/^\d+$/.test(token)) {
      const id = parseInt(token, 10);
      if (id < 1) throw new Error(`invalid basket id: ${token}`);
      ids.add(id);
      continue;
    }

    throw new Error(`invalid basket range token: ${token}`);
  }

  return Array.from(ids).sort((a, b) => a - b);
}

function normalizeBasketLevel(value) {
  const level = parseInt(value, 10);
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(3, level));
}

function normalizeBool(value, fallback = false) {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

function flagsFromLegacyLevel(level) {
  const safeLevel = normalizeBasketLevel(level);
  return {
    can_edit_other_basket: safeLevel >= 1,
    can_edit_other_items: safeLevel >= 2,
    can_save_other_sale: safeLevel >= 3,
  };
}

function levelFromFlags(flags) {
  if (flags.can_save_other_sale) return 3;
  if (flags.can_edit_other_items) return 2;
  if (flags.can_edit_other_basket) return 1;
  return 0;
}

async function ensureBasketAccessTable(queryFn) {
  await queryFn(
    `CREATE TABLE IF NOT EXISTS sml_staff_basket_access (
       user_code varchar(25) PRIMARY KEY,
       allow_all_baskets boolean NOT NULL DEFAULT true,
       basket_range_text text NOT NULL DEFAULT '',
       basket_ids integer[] NOT NULL DEFAULT '{}',
       other_staff_basket_level smallint NOT NULL DEFAULT 3,
       can_edit_other_basket boolean,
       can_edit_other_items boolean,
       can_save_other_sale boolean,
       updated_by varchar(25) NOT NULL DEFAULT '',
       updated_at timestamp NOT NULL DEFAULT NOW()
     )`,
    [],
  );
  await queryFn(`ALTER TABLE sml_staff_basket_access ADD COLUMN IF NOT EXISTS can_edit_other_basket boolean`, []);
  await queryFn(`ALTER TABLE sml_staff_basket_access ADD COLUMN IF NOT EXISTS can_edit_other_items boolean`, []);
  await queryFn(`ALTER TABLE sml_staff_basket_access ADD COLUMN IF NOT EXISTS can_save_other_sale boolean`, []);
  await queryFn(
    `CREATE INDEX IF NOT EXISTS idx_sml_staff_basket_access_user
       ON sml_staff_basket_access (UPPER(user_code))`,
    [],
  );
}

function mapBasketAccessRow(row) {
  if (!row) return { ...DEFAULT_BASKET_ACCESS };
  const legacy = flagsFromLegacyLevel(row.other_staff_basket_level);
  const flags = {
    can_edit_other_basket: row.can_edit_other_basket === null || row.can_edit_other_basket === undefined
      ? legacy.can_edit_other_basket
      : row.can_edit_other_basket === true,
    can_edit_other_items: row.can_edit_other_items === null || row.can_edit_other_items === undefined
      ? legacy.can_edit_other_items
      : row.can_edit_other_items === true,
    can_save_other_sale: row.can_save_other_sale === null || row.can_save_other_sale === undefined
      ? legacy.can_save_other_sale
      : row.can_save_other_sale === true,
  };
  return {
    allow_all_baskets: row.allow_all_baskets === true,
    basket_range_text: row.basket_range_text || '',
    basket_ids: Array.isArray(row.basket_ids) ? row.basket_ids.map((id) => Number(id)).filter((id) => id > 0) : [],
    other_staff_basket_level: levelFromFlags(flags),
    ...flags,
  };
}

async function getEmployeeBasketAccess(queryFn, userCode) {
  const code = normalizeUserCode(userCode);
  if (!code || isSuperAdmin(code)) return { ...DEFAULT_BASKET_ACCESS };

  try {
    await ensureBasketAccessTable(queryFn);
    const result = await queryFn(
      `SELECT allow_all_baskets, basket_range_text, basket_ids, other_staff_basket_level,
              can_edit_other_basket, can_edit_other_items, can_save_other_sale
       FROM sml_staff_basket_access
       WHERE UPPER(user_code) = UPPER($1)
       LIMIT 1`,
      [code],
    );
    return mapBasketAccessRow(result.rows[0]);
  } catch (ex) {
    if (ex.code === '42P01') return { ...DEFAULT_BASKET_ACCESS };
    throw ex;
  }
}

async function setEmployeeBasketAccess(queryFn, {
  user_code,
  allow_all_baskets = true,
  basket_range_text = '',
  other_staff_basket_level = null,
  can_edit_other_basket = null,
  can_edit_other_items = null,
  can_save_other_sale = null,
  updated_by = '',
}) {
  const userCode = normalizeUserCode(user_code);
  if (!userCode) throw new Error('user_code is required');

  const allowAll = allow_all_baskets === true || allow_all_baskets === '1' || allow_all_baskets === 1;
  const rangeText = String(basket_range_text || '').trim();
  const basketIds = allowAll ? [] : parseBasketRange(rangeText);
  const legacyFlags = flagsFromLegacyLevel(other_staff_basket_level ?? 0);
  const flags = {
    can_edit_other_basket: normalizeBool(can_edit_other_basket, legacyFlags.can_edit_other_basket),
    can_edit_other_items: normalizeBool(can_edit_other_items, legacyFlags.can_edit_other_items),
    can_save_other_sale: normalizeBool(can_save_other_sale, legacyFlags.can_save_other_sale),
  };
  const otherLevel = levelFromFlags(flags);

  await ensureBasketAccessTable(queryFn);
  await queryFn(
    `INSERT INTO sml_staff_basket_access (
       user_code, allow_all_baskets, basket_range_text, basket_ids,
       other_staff_basket_level, can_edit_other_basket, can_edit_other_items,
       can_save_other_sale, updated_by, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (user_code) DO UPDATE SET
       allow_all_baskets = EXCLUDED.allow_all_baskets,
       basket_range_text = EXCLUDED.basket_range_text,
       basket_ids = EXCLUDED.basket_ids,
       other_staff_basket_level = EXCLUDED.other_staff_basket_level,
       can_edit_other_basket = EXCLUDED.can_edit_other_basket,
       can_edit_other_items = EXCLUDED.can_edit_other_items,
       can_save_other_sale = EXCLUDED.can_save_other_sale,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [
      userCode, allowAll, rangeText, basketIds, otherLevel,
      flags.can_edit_other_basket, flags.can_edit_other_items, flags.can_save_other_sale,
      normalizeUserCode(updated_by),
    ],
  );

  return {
    allow_all_baskets: allowAll,
    basket_range_text: rangeText,
    basket_ids: basketIds,
    other_staff_basket_level: otherLevel,
    ...flags,
  };
}

function basketIdFromCartKey(custCode) {
  const match = String(custCode || '').trim().match(/^BASKET-(\d+)$/i);
  return match ? parseInt(match[1], 10) : null;
}

function fullCapabilities(canEnter = true) {
  return {
    access_level: canEnter ? 3 : 0,
    can_enter: canEnter,
    can_edit_basket: canEnter,
    can_edit_items: canEnter,
    can_save_sale: canEnter,
  };
}

function capabilitiesFromOtherStaffFlags(flags, canEnter) {
  return {
    access_level: canEnter ? levelFromFlags(flags) : 0,
    can_enter: canEnter,
    can_edit_basket: canEnter && flags.can_edit_other_basket,
    can_edit_items: canEnter && flags.can_edit_other_items,
    can_save_sale: canEnter && flags.can_save_other_sale,
  };
}

async function resolveBasketAccess(queryFn, userCode, basketId, { requireUser = false } = {}) {
  const code = normalizeUserCode(userCode);
  if (!basketId) {
    return {
      basket_id: basketId,
      is_allowed_basket: true,
      is_other_staff_basket: false,
      ...fullCapabilities(true),
    };
  }
  if (requireUser && !code) throw new Error('user_code is required for basket permission check');
  if (!code || isSuperAdmin(code)) {
    return {
      basket_id: basketId,
      is_allowed_basket: true,
      is_other_staff_basket: false,
      ...fullCapabilities(true),
    };
  }

  const [access, basketResult] = await Promise.all([
    getEmployeeBasketAccess(queryFn, code),
    queryFn(
      `SELECT basket_id, COALESCE(status,'empty') AS status, COALESCE(sale_code,'') AS sale_code
       FROM pos_basket
       WHERE basket_id = $1
       LIMIT 1`,
      [basketId],
    ),
  ]);

  const basket = basketResult.rows[0] || { status: 'empty', sale_code: '' };
  const isAllowedBasket = access.allow_all_baskets || access.basket_ids.includes(Number(basketId));
  const saleCode = normalizeUserCode(basket.sale_code);
  const isOwnStaffBasket = String(basket.status || '') === 'active'
    && saleCode
    && saleCode.toUpperCase() === code.toUpperCase();
  const isOtherStaffBasket = String(basket.status || '') === 'active'
    && saleCode
    && saleCode.toUpperCase() !== code.toUpperCase();

  const flags = {
    can_edit_other_basket: access.can_edit_other_basket,
    can_edit_other_items: access.can_edit_other_items,
    can_save_other_sale: access.can_save_other_sale,
  };

  if (isOtherStaffBasket) {
    const canEnterOtherStaffBasket = Object.values(flags).some(Boolean);
    return {
      basket_id: basketId,
      is_allowed_basket: isAllowedBasket,
      is_other_staff_basket: true,
      is_own_staff_basket: false,
      ...capabilitiesFromOtherStaffFlags(flags, canEnterOtherStaffBasket),
    };
  }

  if (isOwnStaffBasket) {
    return {
      basket_id: basketId,
      is_allowed_basket: true,
      is_other_staff_basket: false,
      is_own_staff_basket: true,
      ...fullCapabilities(true),
    };
  }

  if (!isAllowedBasket) {
    return {
      basket_id: basketId,
      is_allowed_basket: false,
      is_other_staff_basket: false,
      is_own_staff_basket: false,
      ...fullCapabilities(false),
    };
  }

  return {
    basket_id: basketId,
    is_allowed_basket: true,
    is_other_staff_basket: false,
    is_own_staff_basket: false,
    ...fullCapabilities(true),
  };
}

async function resolveBasketAccessFromCartKey(queryFn, userCode, custCode, options = {}) {
  const basketId = basketIdFromCartKey(custCode);
  return resolveBasketAccess(queryFn, userCode, basketId, options);
}

async function assertBasketAccess(queryFn, userCode, basketId, requiredCapability) {
  const access = await resolveBasketAccess(queryFn, userCode, basketId, { requireUser: true });
  if (!access[requiredCapability]) {
    const err = new Error(`permission denied: basket.${requiredCapability}`);
    err.statusCode = 403;
    err.access = access;
    throw err;
  }
  return access;
}

async function assertBasketAccessFromCartKey(queryFn, userCode, custCode, requiredCapability) {
  const basketId = basketIdFromCartKey(custCode);
  if (!basketId) return null;
  return assertBasketAccess(queryFn, userCode, basketId, requiredCapability);
}

module.exports = {
  parseBasketRange,
  ensureBasketAccessTable,
  getEmployeeBasketAccess,
  setEmployeeBasketAccess,
  basketIdFromCartKey,
  resolveBasketAccess,
  resolveBasketAccessFromCartKey,
  assertBasketAccess,
  assertBasketAccessFromCartKey,
};
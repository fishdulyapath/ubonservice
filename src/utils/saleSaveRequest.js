const crypto = require('node:crypto');

const STAFF_CREATOR = 'smlstaff';
const SALE_TRANS_FLAG = 44;

function normalizeSaveRequestId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const id = raw.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id)) {
    const error = new Error('invalid sale save_request_id');
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function newSaveRequestId() {
  return crypto.randomUUID().replace(/-/g, '');
}

async function lockSaleBasket(client, basketId) {
  await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
    [441044, Number(basketId)]);
}

async function findSavedStaffSale(queryFn, requestId) {
  const result = await queryFn(
    `SELECT doc_no, COALESCE(doc_format_code,'') AS doc_format_code
     FROM ic_trans
     WHERE trans_flag=$1 AND LOWER(creator_code)=$2 AND guid_code=$3
     ORDER BY roworder DESC LIMIT 1`,
    [SALE_TRANS_FLAG, STAFF_CREATOR, requestId],
  );
  return result.rows[0] || null;
}

async function claimStaffSaleSave(client, {
  requestId, basketId, basketEpoch = '', requireBasketEpoch = false, itemGuids = [],
}) {
  const id = normalizeSaveRequestId(requestId);
  const basket = Number(basketId);
  if (!id || !Number.isInteger(basket) || basket <= 0) {
    const error = new Error('save_request_id and basket_id are required for staff sale');
    error.statusCode = 400;
    throw error;
  }

  // Serializes retries even when they reach different API instances.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    ['smlstaff-sale-request', id]);
  const existing = await findSavedStaffSale(client.query.bind(client), id);
  if (existing) return existing;

  if (requireBasketEpoch && !String(basketEpoch || '').trim()) {
    const error = new Error('basket_epoch is required for staff sale');
    error.statusCode = 400;
    throw error;
  }

  // A different request ID for the same basket must wait until the first sale commits.
  await lockSaleBasket(client, basket);
  const basketResult = await client.query(
    `SELECT basket_id, status,
            to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.US') AS basket_epoch
     FROM pos_basket WHERE basket_id=$1`, [basket]);
  if (basketResult.rows[0]?.status !== 'active') {
    const error = new Error('ตะกร้านี้ถูกบันทึกหรือปิดไปแล้ว กรุณาตรวจประวัติการขายก่อนบันทึกใหม่');
    error.statusCode = 409;
    error.code = 'SALE_BASKET_NOT_ACTIVE';
    throw error;
  }
  if (requireBasketEpoch && basketResult.rows[0].basket_epoch !== String(basketEpoch).trim()) {
    const error = new Error('ตะกร้านี้ถูกเปิดหรือเปลี่ยนข้อมูลหลังจากเริ่มบันทึก กรุณาเปิดตะกร้าใหม่และตรวจยอด');
    error.statusCode = 409;
    error.code = 'SALE_BASKET_CHANGED';
    throw error;
  }
  if (!requireBasketEpoch) {
    // Older open tabs have no basket epoch. Cart row GUIDs distinguish the old
    // checkout from a new sale started after the same basket was reused.
    const submitted = itemGuids.map((value) => String(value || '').trim());
    const live = await client.query(
      'SELECT guid_code FROM staff_cart_order WHERE cust_code=$1', [`BASKET-${basket}`]);
    const liveGuids = new Set(live.rows.map((row) => String(row.guid_code || '').trim()));
    if (!submitted.length || submitted.some((guid) => !guid || !liveGuids.has(guid))) {
      const error = new Error('รายการในตะกร้าเปลี่ยนไปแล้ว กรุณารีเฟรชและตรวจรายการก่อนบันทึก');
      error.statusCode = 409;
      error.code = 'SALE_BASKET_ITEMS_CHANGED';
      throw error;
    }
  }
  return null;
}

module.exports = { normalizeSaveRequestId, newSaveRequestId, findSavedStaffSale, lockSaleBasket, claimStaffSaleSave };

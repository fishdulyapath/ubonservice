const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSaveRequestId,
  newSaveRequestId,
  findSavedStaffSale,
  claimStaffSaleSave,
} = require('../src/utils/saleSaveRequest');

test('save request IDs fit the existing ic_trans.guid_code field', () => {
  const id = newSaveRequestId();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(normalizeSaveRequestId(`${id.slice(0, 8)}-${id.slice(8)}`), id);
  assert.throws(() => normalizeSaveRequestId('not-a-uuid'), /invalid sale save_request_id/);
});

test('a retry returns the original invoice before checking the now empty basket', async () => {
  const statements = [];
  const client = { query: async (sql, params) => {
    statements.push({ sql, params });
    if (sql.includes('FROM ic_trans')) return { rows: [{ doc_no: 'INV-001', doc_format_code: 'INV' }] };
    return { rows: [] };
  } };
  const saved = await claimStaffSaleSave(client, {
    requestId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', basketId: 5,
  });
  assert.equal(saved.doc_no, 'INV-001');
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(statements[1].params, [44, 'smlstaff', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
});

test('a different request cannot save an emptied basket', async () => {
  const statements = [];
  const client = { query: async (sql, params) => {
    statements.push({ sql, params });
    if (sql.includes('FROM ic_trans')) return { rows: [] };
    if (sql.includes('FROM pos_basket')) return { rows: [{ basket_id: 5, status: 'empty' }] };
    return { rows: [] };
  } };
  await assert.rejects(claimStaffSaleSave(client, {
    requestId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', basketId: 5,
  }), (error) => error.statusCode === 409 && error.code === 'SALE_BASKET_NOT_ACTIVE');
  assert.match(statements[2].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(statements[2].params, [441044, 5]);
});

test('an active basket can save after acquiring both locks', async () => {
  const client = { query: async (sql) => {
    if (sql.includes('FROM pos_basket')) return { rows: [{ basket_id: 8, status: 'active', basket_epoch: '2026-11-06 09:00:00.123456' }] };
    return { rows: [] };
  } };
  assert.equal(await claimStaffSaleSave(client, {
    requestId: 'cccccccccccccccccccccccccccccccc', basketId: 8,
    basketEpoch: '2026-11-06 09:00:00.123456', requireBasketEpoch: true,
  }), null);
});

test('a delayed request cannot sell against a reused basket', async () => {
  const client = { query: async (sql) => {
    if (sql.includes('FROM pos_basket')) return { rows: [{
      basket_id: 8, status: 'active', basket_epoch: '2026-11-06 09:10:00.000000',
    }] };
    return { rows: [] };
  } };
  await assert.rejects(claimStaffSaleSave(client, {
    requestId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', basketId: 8,
    basketEpoch: '2026-11-06 09:00:00.123456', requireBasketEpoch: true,
  }), (error) => error.statusCode === 409 && error.code === 'SALE_BASKET_CHANGED');
});

test('an older tab without an epoch cannot reuse a basket with different cart lines', async () => {
  const client = { query: async (sql) => {
    if (sql.includes('FROM pos_basket')) return { rows: [{ basket_id: 8, status: 'active' }] };
    if (sql.includes('FROM staff_cart_order')) return { rows: [{ guid_code: 'new-item-guid' }] };
    return { rows: [] };
  } };
  await assert.rejects(claimStaffSaleSave(client, {
    requestId: 'ffffffffffffffffffffffffffffffff', basketId: 8,
    itemGuids: ['old-item-guid'],
  }), (error) => error.statusCode === 409 && error.code === 'SALE_BASKET_ITEMS_CHANGED');
});

test('an older tab with the current cart line can still save', async () => {
  const client = { query: async (sql) => {
    if (sql.includes('FROM pos_basket')) return { rows: [{ basket_id: 8, status: 'active' }] };
    if (sql.includes('FROM staff_cart_order')) return { rows: [{ guid_code: 'current-item-guid' }] };
    return { rows: [] };
  } };
  assert.equal(await claimStaffSaleSave(client, {
    requestId: '11111111111111111111111111111111', basketId: 8,
    itemGuids: ['current-item-guid'],
  }), null);
});

test('status lookup uses the same sale identity as the save path', async () => {
  const result = await findSavedStaffSale(async (sql, params) => {
    assert.match(sql, /LOWER\(creator_code\)/);
    assert.deepEqual(params, [44, 'smlstaff', 'dddddddddddddddddddddddddddddddd']);
    return { rows: [] };
  }, 'dddddddddddddddddddddddddddddddd');
  assert.equal(result, null);
});

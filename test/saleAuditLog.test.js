const test = require('node:test');
const assert = require('node:assert/strict');
const { writeSaleAudit, saleLogGuid, startSaleAuditRecovery } = require('../src/utils/saleAuditLog');

function createFakeDatabases() {
  const mainRows = [];
  const fullRows = [];
  const calls = [];
  const failures = { main: false, full: false };
  const sale = {
    doc_no: 'INV-TEST-001', audit_doc_date: '2026-11-04', doc_date: '2026-11-04',
    creator_code: 'smlstaff', sale_code: 'EMP01', cust_code: 'AR001',
    total_amount: '100.00', total_vat_value: '7.00', pos_id: 'POS-A',
  };
  const details = [
    { line_number: 1, roworder: 1, item_code: 'A', qty: '2', set_ref_line: '' },
    { line_number: 2, roworder: 2, item_code: 'B', qty: '3', set_ref_line: 'parent' },
  ];
  const mainPool = {
    async query(sql) {
      if (sql.includes('FROM ic_trans t')) return { rows: [sale] };
      if (sql.includes('FROM ic_trans_detail')) return { rows: details };
      if (sql.includes('FROM cb_trans_detail')) return { rows: [{ roworder: 1, pay_amount: '100' }] };
      if (sql.includes('FROM cb_trans')) return { rows: [{ total_amount: '100.00' }] };
      throw new Error(`Unexpected main query: ${sql}`);
    },
    async connect() {
      return {
        async query(sql, values = []) {
          calls.push({ db: 'main', sql, values });
          if (sql.includes('SELECT 1 FROM logs')) {
            return { rows: mainRows.filter((row) => row.guid === values[0]) };
          }
          if (sql.includes('INSERT INTO logs')) {
            if (failures.main) throw new Error('main log unavailable');
            mainRows.push({ guid: values[1], sql, values });
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const logsPool = {
    async connect() {
      return {
        async query(sql, values = []) {
          calls.push({ db: 'full', sql, values });
          if (sql.includes('SELECT 1 FROM erp_logs')) {
            return { rows: fullRows.filter((row) => row.docNo === values[0]) };
          }
          if (sql.includes('INSERT INTO erp_logs')) {
            if (failures.full) throw new Error('full log unavailable');
            fullRows.push({ docNo: values[0], sql, values });
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const errors = [];
  return { mainPool, logsPool, mainRows, fullRows, calls, failures,
    logger: { error: (message) => errors.push(message) }, errors };
}

test('writes both SML logs with persisted totals and lets roworder auto-generate', async () => {
  const db = createFakeDatabases();
  const result = await writeSaleAudit({ docNo: 'INV-TEST-001', basketId: 5, userCode: 'EMP01' }, db);
  assert.deepEqual(result, { docNo: 'INV-TEST-001', main: true, full: true });
  assert.equal(db.mainRows[0].guid, saleLogGuid('INV-TEST-001'));
  assert.doesNotMatch(db.mainRows[0].sql, /roworder/i);
  assert.doesNotMatch(db.fullRows[0].sql, /roworder/i);
  assert.equal(db.mainRows[0].values[4], '100.00');
  assert.equal(db.mainRows[0].values[10], 2);
  assert.equal(JSON.parse(db.mainRows[0].values[9]).basket_id, '5');
  const fullSnapshot = JSON.parse(db.fullRows[0].values[10].toString('utf8'));
  assert.equal(fullSnapshot.screentop.total_amount, '100.00');
  assert.equal(fullSnapshot.smlstaff.basket_id, '5');
  assert.equal(fullSnapshot.screendetail.length, 2);
});

test('retry does not duplicate either audit row', async () => {
  const db = createFakeDatabases();
  await writeSaleAudit({ docNo: 'INV-TEST-001' }, db);
  await writeSaleAudit({ docNo: 'INV-TEST-001' }, db);
  assert.equal(db.mainRows.length, 1);
  assert.equal(db.fullRows.length, 1);
});

test('a failed main log does not prevent the full log and can be retried', async () => {
  const db = createFakeDatabases();
  db.failures.main = true;
  const first = await writeSaleAudit({ docNo: 'INV-TEST-001' }, db);
  assert.deepEqual(first, { docNo: 'INV-TEST-001', main: false, full: true });
  assert.match(db.errors[0], /main log unavailable/);
  db.failures.main = false;
  await writeSaleAudit({ docNo: 'INV-TEST-001' }, db);
  assert.equal(db.mainRows.length, 1);
  assert.equal(db.fullRows.length, 1);
});

test('a failed separate logs database does not invalidate the main log', async () => {
  const db = createFakeDatabases();
  db.failures.full = true;
  const first = await writeSaleAudit({ docNo: 'INV-TEST-001' }, db);
  assert.deepEqual(first, { docNo: 'INV-TEST-001', main: true, full: false });
  assert.equal(db.mainRows.length, 1);
  db.failures.full = false;
  await writeSaleAudit({ docNo: 'INV-TEST-001' }, db);
  assert.equal(db.mainRows.length, 1);
  assert.equal(db.fullRows.length, 1);
});

test('recovery checks both existing SML tables and retries a missing sale once', async () => {
  const db = createFakeDatabases();
  const originalQuery = db.mainPool.query;
  db.mainPool.query = async (sql, values) => {
    if (sql.includes('FROM ic_trans') && sql.includes('LIMIT 500')) {
      return { rows: [{ roworder: 100, doc_no: 'INV-TEST-001', trans_flag: 44,
        creator_code: 'smlstaff', in_window: true }] };
    }
    if (sql.includes('FROM logs WHERE guid=ANY')) return { rows: [] };
    return originalQuery(sql, values);
  };
  let stop;
  try {
    const recovered = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('recovery did not run')), 1000);
      stop = startSaleAuditRecovery({
        ...db, initialDelayMs: 1, keepAlive: true,
        audit: async (metadata, options) => {
          clearTimeout(timeout);
          resolve({ metadata, options });
        },
      });
    });
    const { metadata, options } = await recovered;
    assert.equal(metadata.docNo, 'INV-TEST-001');
    assert.equal(options.skipMain, false);
    assert.equal(options.skipFull, false);
  } finally {
    stop?.();
  }
});

const crypto = require('node:crypto');
const { pool, getLogsPool } = require('../db');

const SOURCE = 'SMLSTAFF';
const TRANS_FLAG = 44;
const TRANS_TYPE = 2;
const CREATE_MODE = 1;
const MENU_NAME = 'ขายสินค้า/บริการ (SML Staff)';

function saleLogGuid(docNo) {
  return crypto.createHash('sha256').update(`smlstaff:sale:create:${TRANS_FLAG}:${docNo}`).digest('hex').slice(0, 32);
}

async function loadSaleSnapshot(mainPool, docNo, metadata) {
  const headerResult = await mainPool.query(
    `SELECT t.*, to_char(t.doc_date, 'YYYY-MM-DD') AS audit_doc_date
     FROM ic_trans t
     WHERE t.trans_flag=$1 AND t.doc_no=$2 AND lower(COALESCE(t.creator_code,''))='smlstaff'
     LIMIT 1`,
    [TRANS_FLAG, docNo],
  );
  const header = headerResult.rows[0];
  if (!header) return null;

  const [detailResult, paymentResult, paymentDetailResult] = await Promise.all([
    mainPool.query(
      `SELECT * FROM ic_trans_detail WHERE trans_flag=$1 AND doc_no=$2 ORDER BY line_number, roworder`,
      [TRANS_FLAG, docNo],
    ),
    mainPool.query(
      `SELECT * FROM cb_trans WHERE trans_flag=$1 AND doc_no=$2 LIMIT 1`,
      [TRANS_FLAG, docNo],
    ),
    mainPool.query(
      `SELECT * FROM cb_trans_detail WHERE trans_flag=$1 AND doc_no=$2 ORDER BY roworder`,
      [TRANS_FLAG, docNo],
    ),
  ]);
  const details = detailResult.rows;
  const docQty = details.reduce((total, row) => {
    const isVisibleLine = !String(row.set_ref_line || '').trim() || Number(row.item_type || 0) === 3;
    return total + (isVisibleLine ? Number(row.qty || 0) : 0);
  }, 0);
  const basketId = metadata.basketId == null ? '' : String(metadata.basketId);
  const userCode = String(metadata.userCode || header.sale_code || header.creator_code || SOURCE).trim();
  const dataNew = {
    screentop: header,
    // SMLERP's _getLogsJsonStr stores the bottom totals under "screenmore".
    screenmore: { total_amount: header.total_amount, total_vat_value: header.total_vat_value },
    screenbottom: null,
    screendetail: details,
    screenpay: { header: paymentResult.rows[0] || null, detail: paymentDetailResult.rows },
    smlstaff: { basket_id: basketId, user_code: userCode, source: SOURCE,
      recovered_from_document: metadata.recovered === true },
  };
  return { header, docQty, basketId, userCode, dataNew };
}

async function inTransaction(targetPool, operation) {
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '3s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* Keep the original error. */ }
    throw error;
  } finally {
    client.release();
  }
}

async function writeMainLog(mainPool, docNo, snapshot) {
  return inTransaction(mainPool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [SOURCE, docNo]);
    const guid = saleLogGuid(docNo);
    const existing = await client.query(
      'SELECT 1 FROM logs WHERE guid=$1 LIMIT 1',
      [guid],
    );
    if (existing.rows.length) return false;

    const { header, docQty, basketId, userCode } = snapshot;
    const data1 = JSON.stringify({ source: SOURCE, basket_id: basketId, doc_no: docNo,
      sale_code: header.sale_code || '', pos_id: header.pos_id || '',
      recovered_from_document: snapshot.dataNew.smlstaff.recovered_from_document });
    await client.query(
      `INSERT INTO logs
       (function_type,computer_name,guid,doc_date,doc_no,doc_amount,
        doc_date_old,doc_no_old,doc_amount_old,menu_name,screen_code,
        function_code,user_code,date_time,data1,data2,doc_qty,doc_qty_old)
       VALUES (2,$1,$2,$3,$4,$5,'','',0,$6,$7,$8,$9,NOW(),$10,'',$11,0)`,
      [SOURCE, guid, header.audit_doc_date, docNo, header.total_amount,
        MENU_NAME, TRANS_FLAG, CREATE_MODE, userCode, data1, docQty],
    );
    return true;
  });
}

async function writeFullLog(logsPool, docNo, snapshot) {
  return inTransaction(logsPool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [SOURCE, docNo]);
    const existing = await client.query(
      `SELECT 1 FROM erp_logs
       WHERE doc_no=$1 AND trans_flag=$2 AND function_code=$3 AND computer_name=$4
       LIMIT 1`,
      [docNo, TRANS_FLAG, CREATE_MODE, SOURCE],
    );
    if (existing.rows.length) return false;

    const { header, userCode, dataNew } = snapshot;
    await client.query(
      `INSERT INTO erp_logs
       (doc_no,computer_name,menu_name,function_code,user_code,date_time,
        doc_date,old_doc_date,old_doc_no,trans_flag,trans_type,
        old_doc_amount,doc_amount,old_cust_code,cust_code,data_new)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6::date,NULL,'',$7,$8,0,$9,'',$10,$11)`,
      [docNo, SOURCE, MENU_NAME, CREATE_MODE, userCode,
        header.audit_doc_date, TRANS_FLAG, TRANS_TYPE, header.total_amount,
        header.cust_code || '', Buffer.from(JSON.stringify(dataNew), 'utf8')],
    );
    return true;
  });
}

async function writeSaleAudit(metadata, options = {}) {
  const mainPool = options.mainPool || pool;
  const logsPool = options.logsPool || getLogsPool();
  const logger = options.logger || console;
  const docNo = String(metadata.docNo || '').trim();
  if (!docNo) throw new Error('sale audit requires docNo');
  const snapshot = await loadSaleSnapshot(mainPool, docNo, metadata);
  if (!snapshot) throw new Error(`staff sale not found for audit: ${docNo}`);

  const result = { docNo, main: Boolean(options.skipMain), full: Boolean(options.skipFull) };
  if (!options.skipMain) {
    try {
      await writeMainLog(mainPool, docNo, snapshot);
      result.main = true;
    } catch (error) {
      logger.error(`Sale audit logs failed for ${docNo}: ${error.message}`);
    }
  }
  if (!options.skipFull) {
    try {
      await writeFullLog(logsPool, docNo, snapshot);
      result.full = true;
    } catch (error) {
      logger.error(`Sale audit erp_logs failed for ${docNo}: ${error.message}`);
    }
  }
  return result;
}

function scheduleSaleAudit(metadata) {
  setImmediate(() => {
    writeSaleAudit(metadata).catch((error) => {
      console.error(`Sale audit failed for ${metadata.docNo}: ${error.message}`);
    });
  });
}

function startSaleAuditRecovery(options = {}) {
  const mainPool = options.mainPool || pool;
  const audit = options.audit || writeSaleAudit;
  const logger = options.logger || console;
  const intervalMs = options.intervalMs || 10 * 60 * 1000;
  const lookbackDays = options.lookbackDays || 7;
  let cursor = null;
  let stopped = false;
  let timer;

  async function scan() {
    if (stopped) return;
    try {
      const result = await mainPool.query(
        `SELECT roworder,doc_no,trans_flag,creator_code,
                COALESCE(create_datetime,doc_date::timestamp) >= NOW() - $2::int * INTERVAL '1 day' AS in_window
         FROM ic_trans
         WHERE ($1::integer IS NULL OR roworder < $1)
         ORDER BY roworder DESC LIMIT 500`,
        [cursor, lookbackDays],
      );
      if (!result.rows.length) {
        cursor = null;
      } else {
        const candidates = [];
        let nextCursor = result.rows[result.rows.length - 1].roworder;
        for (const row of result.rows) {
          if (Number(row.trans_flag) === TRANS_FLAG &&
              String(row.creator_code || '').toLowerCase() === 'smlstaff' && row.in_window) {
            candidates.push(row);
            if (candidates.length === 20) {
              nextCursor = row.roworder;
              break;
            }
          }
        }
        const docNos = candidates.map((row) => row.doc_no);
        if (docNos.length) {
          const guids = docNos.map(saleLogGuid);
          let mainRows = new Map();
          let mainAvailable = true;
          try {
            const mainExisting = await mainPool.query(
              'SELECT guid,data1,user_code FROM logs WHERE guid=ANY($1::varchar[])', [guids],
            );
            mainRows = new Map(mainExisting.rows.map((row) => [row.guid, row]));
          } catch (error) {
            mainAvailable = false;
            logger.error(`Sale audit logs recovery check failed: ${error.message}`);
          }
          let fullDocNos = new Set();
          let fullAvailable = true;
          try {
            const fullExisting = await inTransaction(options.logsPool || getLogsPool(), (client) => client.query(
              `SELECT doc_no FROM erp_logs
               WHERE doc_no=ANY($1::varchar[]) AND trans_flag=$2
                 AND function_code=$3 AND computer_name=$4`,
              [docNos, TRANS_FLAG, CREATE_MODE, SOURCE],
            ));
            fullDocNos = new Set(fullExisting.rows.map((row) => row.doc_no));
          } catch (error) {
            fullAvailable = false;
            logger.error(`Sale audit erp_logs recovery check failed: ${error.message}`);
          }
          for (const row of candidates) {
            if (stopped) break;
            const mainRow = mainRows.get(saleLogGuid(row.doc_no));
            const skipMain = !mainAvailable || Boolean(mainRow);
            const skipFull = !fullAvailable || fullDocNos.has(row.doc_no);
            if (!skipMain || !skipFull) {
              let basketId = '';
              if (mainRow?.data1) {
                try { basketId = JSON.parse(mainRow.data1).basket_id || ''; } catch (_) { /* Old SML log text. */ }
              }
              await audit({ docNo: row.doc_no, basketId, userCode: mainRow?.user_code || '', recovered: true },
                { ...options, skipMain, skipFull });
            }
          }
        }
        cursor = result.rows.every((row) => !row.in_window) ? null : nextCursor;
      }
    } catch (error) {
      logger.error(`Sale audit recovery failed: ${error.message}`);
    } finally {
      if (!stopped) {
        timer = setTimeout(scan, intervalMs);
        timer.unref?.();
      }
    }
  }

  timer = setTimeout(scan, options.initialDelayMs ?? 30 * 1000);
  if (!options.keepAlive) timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { saleLogGuid, loadSaleSnapshot, writeSaleAudit, scheduleSaleAudit, startSaleAuditRecovery };

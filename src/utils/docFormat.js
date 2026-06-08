function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseDocDate(docDate) {
  const text = String(docDate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [y, m, d] = text.split('-').map((part) => parseInt(part, 10));
    return new Date(y, m - 1, d);
  }
  return new Date();
}

function buildDocPattern(format, docFormatCode, docDate) {
  const date = parseDocDate(docDate);
  const year4 = String(date.getFullYear());
  const year2 = year4.slice(-2);
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const base = String(format || '@-YYMM####');

  return base
    .replace(/@/g, docFormatCode)
    .replace(/ปปปป/g, year4)
    .replace(/ปป/g, year2)
    .replace(/ดด/g, month)
    .replace(/วว/g, day)
    .replace(/yyyy/g, year4)
    .replace(/YYYY/g, year4)
    .replace(/yy/g, year2)
    .replace(/YY/g, year2)
    .replace(/MM/g, month)
    .replace(/mm/g, month)
    .replace(/dd/g, day)
    .replace(/DD/g, day);
}

async function resolveDocFormat(client, screenCode, docFormatCode = '') {
  const screen = String(screenCode || '').trim();
  const code = String(docFormatCode || '').trim();
  if (!screen) throw new Error('screen_code is required');

  const result = code
    ? await client.query(
      `SELECT code, name_1, format, COALESCE(form_code,'') AS form_code
       FROM erp_doc_format
       WHERE screen_code = $1 AND code = $2
       LIMIT 1`,
      [screen, code],
    )
    : await client.query(
      `SELECT code, name_1, format, COALESCE(form_code,'') AS form_code
       FROM erp_doc_format
       WHERE screen_code = $1
       ORDER BY code
       LIMIT 1`,
      [screen],
    );

  const docFormat = result.rows[0];
  if (!docFormat) {
    throw new Error(code
      ? `doc_format_code not found for ${screen}: ${code}`
      : `doc_format_code not found for ${screen}`);
  }
  return docFormat;
}

function resolveDocumentTable(tableName) {
  const table = String(tableName || 'ic_trans').trim();
  if (!['ic_trans', 'ap_ar_trans'].includes(table)) {
    throw new Error(`unsupported document table: ${table}`);
  }
  return table;
}

async function resolveDocNoFromPattern(client, pattern, transFlag, tableName = 'ic_trans') {
  const firstHash = pattern.indexOf('#');
  if (firstHash < 0) return pattern;

  let runLen = 0;
  while (firstHash + runLen < pattern.length && pattern[firstHash + runLen] === '#') runLen += 1;

  const likePattern = pattern.replace(/#/g, '_');
  const table = resolveDocumentTable(tableName);
  const result = await client.query(
    `SELECT doc_no
     FROM ${table}
     WHERE trans_flag = $1
       AND char_length(doc_no) = $2
       AND doc_no LIKE $3`,
    [transFlag, pattern.length, likePattern],
  );

  let maxRunning = 0;
  for (const row of result.rows) {
    const docNo = String(row.doc_no || '');
    if (docNo.length !== pattern.length) continue;
    const runText = docNo.slice(firstHash, firstHash + runLen);
    if (!/^\d+$/.test(runText)) continue;
    maxRunning = Math.max(maxRunning, parseInt(runText, 10));
  }

  const nextRunning = maxRunning + 1;
  const maxValue = Math.pow(10, runLen) - 1;
  if (nextRunning > maxValue) throw new Error('doc_no running overflow');

  return pattern.slice(0, firstHash) + String(nextRunning).padStart(runLen, '0') + pattern.slice(firstHash + runLen);
}

async function resolveDocumentNo(client, { screenCode, docFormatCode = '', transFlag, docDate = '', tableName = 'ic_trans' }) {
  const docFormat = await resolveDocFormat(client, screenCode, docFormatCode);
  const pattern = buildDocPattern(docFormat.format, docFormat.code, docDate);
  const table = resolveDocumentTable(tableName);
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`${table}|${screenCode}|${docFormat.code}|${transFlag}|${pattern}`],
  );
  const docNo = await resolveDocNoFromPattern(client, pattern, transFlag, table);
  return {
    doc_no: docNo,
    doc_format_code: docFormat.code,
    doc_format_name: docFormat.name_1 || '',
    doc_format: docFormat.format || '',
    form_code: docFormat.form_code || '',
  };
}

module.exports = {
  buildDocPattern,
  resolveDocFormat,
  resolveDocumentTable,
  resolveDocNoFromPattern,
  resolveDocumentNo,
};

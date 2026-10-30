// Read-only inspection of the PU forms configured in erp_doc_format.
const { pool } = require('../src/db');
const { parseFormDesign } = require('../src/utils/salePrintRenderer');

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const formats = await client.query(`SELECT code, COALESCE(form_code,'') AS form_code
      FROM erp_doc_format WHERE screen_code='PU' ORDER BY code`);
    const codes = [...new Set(formats.rows.flatMap((row) => row.form_code.split(',').map((x) => x.trim()).filter(Boolean)))];
    const result = await client.query(`SELECT formcode, formname, formdesigntext
      FROM formdesign WHERE lower(formcode)=ANY($1::text[])`, [codes.map((x) => x.toLowerCase())]);
    for (const row of result.rows) {
      const form = parseFormDesign(row);
      const fields = [];
      for (const page of form.pages) {
        for (const object of page.objects) {
          const text = String(object.text || '');
          const replaceText = String(object.replaceText || '');
          const names = [object.fieldName, ...Array.from((text + replaceText).matchAll(/\[([^\]]+)\]/g), (x) => x[1])].filter(Boolean);
          if (names.length) fields.push({ tool: object.toolType, names,
            query_rule: object.queryRule, format: object.fieldFormat || object.displayFormat });
          for (const column of object.columns || []) {
            fields.push({ tool: 'TableColumn', names: [column.fieldName, column.text, column.replaceText].filter(Boolean),
              query_rule: column.queryRule, format: column.fieldFormat || column.displayFormat });
          }
        }
      }
      console.log(JSON.stringify({ formcode: row.formcode, formname: row.formname,
        pages: form.pages.length, fields }));
    }
    console.log('missing_form_codes', JSON.stringify(codes.filter((code) =>
      !result.rows.some((row) => row.formcode.toLowerCase() === code.toLowerCase()))));
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.code || error.name, error.message);
  process.exitCode = 1;
});

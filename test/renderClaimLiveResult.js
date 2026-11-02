const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const report = JSON.parse(fs.readFileSync(path.join(__dirname, 'claim-live-result.json'), 'utf8'));
const target = path.join(__dirname, 'claim-live-result.png');
const baht = (value) => Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const xml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);
const rows = report.applied_claims.map((row, index) => `
  <rect x="56" y="${345 + index * 70}" width="1088" height="60" rx="12" fill="${index % 2 ? '#f4f7fb' : '#ffffff'}"/>
  <text x="78" y="${383 + index * 70}" font-size="22" fill="#26364e">${xml(row.item_code)} · ${xml(row.qty)} ชิ้น</text>
  <text x="690" y="${383 + index * 70}" font-size="21" fill="#5b6c80">${baht(row.configured_unit_price)}</text>
  <text x="978" y="${383 + index * 70}" font-size="24" font-weight="700" fill="#087d5f">${baht(row.amount)}</text>
`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <rect width="1200" height="800" fill="#edf2f8"/>
  <rect x="24" y="24" width="1152" height="752" rx="20" fill="white"/>
  <rect x="24" y="24" width="1152" height="130" rx="20" fill="#153a5c"/>
  <text x="58" y="83" font-family="Tahoma,Arial,sans-serif" font-size="34" font-weight="700" fill="white">ผลทดสอบราคารับเคลมกับ wawacrm</text>
  <text x="60" y="120" font-family="Tahoma,Arial,sans-serif" font-size="18" fill="#cce5f4">ข้อมูลจากฐานจริง · บันทึก PU ในธุรกรรมแล้ว ROLLBACK</text>
  <g font-family="Tahoma,Arial,sans-serif">
    <rect x="56" y="180" width="335" height="116" rx="14" fill="#e9f7f1"/>
    <text x="78" y="214" font-size="19" fill="#486576">ราคาสินค้าที่ขาย 01-0004</text>
    <text x="78" y="264" font-size="40" font-weight="700" fill="#087d5f">฿${baht(report.sale_price)}</text>
    <rect x="432" y="180" width="335" height="116" rx="14" fill="#fff4e9"/>
    <text x="454" y="214" font-size="19" fill="#486576">ส่วนลดเคลมในใบขาย</text>
    <text x="454" y="264" font-size="40" font-weight="700" fill="#bc681b">−฿${baht(report.sale.discount)}</text>
    <rect x="808" y="180" width="336" height="116" rx="14" fill="#e9f1fd"/>
    <text x="830" y="214" font-size="19" fill="#486576">ยอดสุทธิใบขาย / VAT</text>
    <text x="830" y="264" font-size="37" font-weight="700" fill="#245a94">฿${baht(report.sale.total)} / ${baht(report.sale.vat)}</text>
    <text x="60" y="336" font-size="23" font-weight="700" fill="#26364e">สินค้าเคลม</text>
    <text x="690" y="336" font-size="17" fill="#5b6c80">ราคาที่ตั้ง/หน่วย</text>
    <text x="977" y="336" font-size="17" fill="#5b6c80">หักจริง</text>
    ${rows}
    <line x1="56" y1="497" x2="1144" y2="497" stroke="#d9e3ec"/>
    <text x="60" y="541" font-size="20" fill="#40566d">หน่วยอื่นของ 01-0005: ${xml(report.other_unit.unit_code)} = ฿${baht(report.other_unit.configured_unit_price)}</text>
    <rect x="56" y="568" width="1088" height="120" rx="14" fill="#f2f6fb"/>
    <text x="78" y="604" font-size="22" font-weight="700" fill="#26364e">ใบซื้อ/ตั้งหนี้ ${xml(report.doc_no)} (ทดสอบ)</text>
    <text x="78" y="643" font-size="20" fill="#40566d">รายการ 70.00 + 22.00 = <tspan font-weight="700">฿${baht(report.pu.total_amount)}</tspan>  ·  VAT ฿${baht(report.pu.total_vat_value)}</text>
    <text x="78" y="674" font-size="19" fill="#40566d">ข้อมูลฟอร์มพิมพ์: ${report.print.detail_amounts.map(baht).join(' + ')} = ฿${baht(report.print.total_amount)}</text>
    <text x="60" y="735" font-size="17" fill="#687c90">ตรวจหลัง ROLLBACK: ${report.rolled_back ? 'ไม่มีเอกสาร PU ทดสอบค้างในฐาน' : 'พบเอกสารค้าง'} · ราคาทดสอบไม่ถูกบันทึกถาวร</text>
  </g>
</svg>`;
sharp(Buffer.from(svg)).png().toFile(target)
  .then(() => console.log(target))
  .catch((error) => { console.error(error); process.exitCode = 1; });

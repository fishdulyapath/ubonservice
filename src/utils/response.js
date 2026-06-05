// เลียนแบบ response format ของ RestService.java

function successResponse(res, data, extra = {}) {
  return res.json({ success: true, data, ...extra });
}

function failResponse(res, msg, statusCode = 400) {
  return res.status(statusCode).json({ success: false, msg });
}

function paginatedResponse(res, data, page, pageSize, totalCount) {
  return res.json({
    success: true,
    data,
    page,
    page_size: pageSize,
    total_count: totalCount,
  });
}

function safePage(page) {
  const p = parseInt(page);
  return (!p || p < 1) ? 1 : p;
}

function safePageSize(pageSize) {
  const ps = parseInt(pageSize);
  if (!ps || ps < 1) return 20;
  return Math.min(ps, 200);
}

module.exports = { successResponse, failResponse, paginatedResponse, safePage, safePageSize };

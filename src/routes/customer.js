const express = require('express');
const router = express.Router();
const { query } = require('../db');

// GET /service/v1/getCustomerList
router.get('/getCustomerList', async (req, res) => {
  const { search = '' } = req.query;
  try {
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      where = ` AND (code ILIKE $1 OR name_1 ILIKE $1)`;
    }
    const sql = `SELECT code AS user_code, name_1 AS user_name, address, telephone,
      COALESCE((SELECT tax_id FROM ar_customer_detail WHERE ar_code=code),'') AS tax_id
      FROM ar_customer WHERE 1=1 ${where} LIMIT 50`;
    const result = await query(sql, params);
    const data = result.rows.map(r => ({
      code: r.user_code,
      name: r.user_name,
      address: r.address,
      telephone: r.telephone,
      tax_id: r.tax_id,
    }));
    return res.json({ success: true, data });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getEmployeeList
router.get('/getEmployeeList', async (req, res) => {
  const { search = '' } = req.query;
  try {
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      where = ` AND (code ILIKE $1 OR name_1 ILIKE $1)`;
    }
    const sql = `SELECT code, name_1 AS name FROM erp_user WHERE 1=1 ${where} LIMIT 50`;
    const result = await query(sql, params);
    const data = result.rows.map(r => ({ code: r.code, name: r.name }));
    return res.json({ success: true, data });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getCustomerCRM
router.get('/getCustomerCRM', async (req, res) => {
  const { search = '', limit = '50', offset = '0' } = req.query;
  const lim = parseInt(limit) || 50;
  const off = parseInt(offset) || 0;
  try {
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      where = ` AND (code ILIKE $1 OR name_1 ILIKE $1)`;
    }

    const countSql = `SELECT COUNT(*) AS total FROM ar_customer WHERE 1=1 ${where}`;
    const countResult = await query(countSql, params);
    const total = parseInt(countResult.rows[0].total);

    const paramIdx = params.length + 1;
    const dataSql = `
      SELECT code AS user_code, name_1 AS user_name,
        COALESCE(address,'') AS address, COALESCE(telephone,'') AS telephone,
        COALESCE(website,'') AS website,
        COALESCE((SELECT logistic_area FROM ar_customer_detail WHERE ar_code=code),'') AS logistic_area,
        COALESCE((SELECT group_main FROM ar_customer_detail WHERE ar_code=code),'') AS group_main
      FROM ar_customer WHERE 1=1 ${where}
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    const dataResult = await query(dataSql, [...params, lim, off]);
    const data = dataResult.rows.map(r => ({
      code: r.user_code,
      name: r.user_name,
      address: r.address,
      telephone: r.telephone,
      logistic_area: r.logistic_area,
      gps: r.website,
      group_main: r.group_main,
    }));

    const currentPage = Math.floor(off / lim) + 1;
    const totalPage = Math.ceil(total / lim);

    return res.json({
      success: true,
      data,
      pagination: { total, limit: lim, offset: off, current_page: currentPage, total_page: totalPage },
    });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

// GET /service/v1/getEmployeeCRM
router.get('/getEmployeeCRM', async (req, res) => {
  const { search = '', limit = '50', offset = '0' } = req.query;
  const lim = parseInt(limit) || 50;
  const off = parseInt(offset) || 0;
  try {
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      where = ` AND (code ILIKE $1 OR name_1 ILIKE $1)`;
    }
    const paramIdx = params.length + 1;
    const sql = `SELECT code, name_1 AS name FROM erp_user WHERE 1=1 ${where}
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    const result = await query(sql, [...params, lim, off]);
    const data = result.rows.map(r => ({ code: r.code, name: r.name }));
    return res.json({ success: true, data });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

module.exports = router;

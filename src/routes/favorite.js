const express = require('express');
const router = express.Router();
const { query } = require('../db');

// GET /service/v1/setfav
router.get('/setfav', async (req, res) => {
  const { status = '', cust_code = '', item_code = '' } = req.query;
  try {
    await query(
      'DELETE FROM ar_item_by_customer WHERE ar_code=$1 AND ic_code=$2',
      [cust_code, item_code]
    );
    await query(
      'INSERT INTO ar_item_by_customer (status, ic_code, ar_code) VALUES ($1,$2,$3)',
      [status, item_code, cust_code]
    );
    return res.json({ success: true });
  } catch (ex) {
    return res.status(400).json({ ERROR: ex.message });
  }
});

module.exports = router;

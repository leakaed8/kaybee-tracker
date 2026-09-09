const express = require('express');
const pool = require('../db/pool');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Product list, used to populate the visit-entry product picker. Staff only.
router.get('/', verifyToken, requireRole('staff', 'admin'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, category, price, duration_days FROM products ORDER BY name'
  );
  res.json(rows);
});

module.exports = router;

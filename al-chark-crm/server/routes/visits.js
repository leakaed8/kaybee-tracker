const express = require('express');
const pool = require('../db/pool');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Log a visit. Staff only.
// Body: { patient_id, complaint, assessment, lifestyle_advice, next_followup_date,
//         photo_urls, products: [{ product_id, is_supplement, dosing_notes }] }
router.post('/', verifyToken, requireRole('staff', 'admin'), async (req, res) => {
  const {
    patient_id,
    complaint,
    assessment,
    lifestyle_advice,
    next_followup_date,
    photo_urls,
    products,
  } = req.body;

  if (!patient_id) {
    return res.status(400).json({ error: 'patient_id is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const visitResult = await client.query(
      `INSERT INTO visits (patient_id, staff_id, complaint, assessment, lifestyle_advice, photo_urls, next_followup_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, visit_date`,
      [
        patient_id,
        req.user.id,
        complaint || null,
        assessment || null,
        lifestyle_advice || null,
        photo_urls || null,
        next_followup_date || null,
      ]
    );
    const visit = visitResult.rows[0];

    for (const item of products || []) {
      await client.query(
        `INSERT INTO visit_products (visit_id, product_id, is_supplement, dosing_notes)
         VALUES ($1, $2, $3, $4)`,
        [visit.id, item.product_id, item.is_supplement || false, item.dosing_notes || null]
      );
    }

    if (next_followup_date) {
      await client.query(
        `INSERT INTO followups (visit_id, scheduled_date, status)
         VALUES ($1, $2, 'pending')`,
        [visit.id, next_followup_date]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ id: visit.id, visit_date: visit.visit_date });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;

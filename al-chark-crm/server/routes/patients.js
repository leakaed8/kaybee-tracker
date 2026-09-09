const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Search patients by name or phone. Staff only.
router.get('/', verifyToken, requireRole('staff', 'admin'), async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    const { rows } = await pool.query(
      'SELECT id, name, phone, loyalty_tier FROM patients ORDER BY created_at DESC LIMIT 25'
    );
    return res.json(rows);
  }

  const { rows } = await pool.query(
    `SELECT id, name, phone, loyalty_tier FROM patients
     WHERE name ILIKE $1 OR phone ILIKE $1
     ORDER BY name LIMIT 25`,
    [`%${q}%`]
  );
  res.json(rows);
});

// Create a patient. Staff only (self-service signup lives in /api/auth/patient/signup).
router.post('/', verifyToken, requireRole('staff', 'admin'), async (req, res) => {
  const { name, phone, pin, dob, skin_type, hair_type, allergies, conditions, pregnancy_flag } = req.body;
  if (!name || !phone || !pin) {
    return res.status(400).json({ error: 'name, phone and pin are required' });
  }
  if (!/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ error: 'pin must be 4-6 digits' });
  }

  const existing = await pool.query('SELECT id FROM patients WHERE phone = $1', [phone]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'A patient with this phone number already exists' });
  }

  const pinHash = await bcrypt.hash(pin, 10);
  const { rows } = await pool.query(
    `INSERT INTO patients (name, phone, pin_hash, dob, skin_type, hair_type, allergies, conditions, pregnancy_flag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, name, phone, loyalty_tier`,
    [
      name,
      phone,
      pinHash,
      dob || null,
      skin_type || null,
      hair_type || null,
      allergies || null,
      conditions || null,
      pregnancy_flag || false,
    ]
  );
  res.status(201).json(rows[0]);
});

// Patient timeline: patient profile + visits (with products) + followups.
// Staff can view any patient; a patient can only view their own record.
router.get('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const isStaff = req.user.role === 'staff' || req.user.role === 'admin';
  if (!isStaff && String(req.user.id) !== String(id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const patientResult = await pool.query(
    `SELECT id, name, phone, dob, skin_type, hair_type, allergies, conditions,
            pregnancy_flag, purchase_total_lifetime, purchase_total_rolling_12mo, loyalty_tier
     FROM patients WHERE id = $1`,
    [id]
  );
  const patient = patientResult.rows[0];
  if (!patient) {
    return res.status(404).json({ error: 'Patient not found' });
  }

  const visitsResult = await pool.query(
    `SELECT v.id, v.visit_date, v.complaint, v.assessment, v.lifestyle_advice,
            v.photo_urls, v.next_followup_date, s.name AS staff_name,
            COALESCE(
              json_agg(
                json_build_object(
                  'product_id', vp.product_id,
                  'product_name', p.name,
                  'is_supplement', vp.is_supplement,
                  'dosing_notes', vp.dosing_notes
                )
              ) FILTER (WHERE vp.id IS NOT NULL), '[]'
            ) AS products
     FROM visits v
     LEFT JOIN staff s ON s.id = v.staff_id
     LEFT JOIN visit_products vp ON vp.visit_id = v.id
     LEFT JOIN products p ON p.id = vp.product_id
     WHERE v.patient_id = $1
     GROUP BY v.id, s.name
     ORDER BY v.visit_date DESC`,
    [id]
  );

  const followupsResult = await pool.query(
    `SELECT f.id, f.visit_id, f.scheduled_date, f.sent_date, f.response,
            f.patient_comment, f.status
     FROM followups f
     JOIN visits v ON v.id = f.visit_id
     WHERE v.patient_id = $1
     ORDER BY f.scheduled_date DESC`,
    [id]
  );

  res.json({ patient, visits: visitsResult.rows, followups: followupsResult.rows });
});

module.exports = router;

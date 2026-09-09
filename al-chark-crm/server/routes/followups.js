const express = require('express');
const pool = require('../db/pool');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Follow-up dashboard: pending follow-ups with patient info, flagged as
// overdue (scheduled_date < today) or due (scheduled_date = today), plus
// escalated ones (response = 'worse'). Staff only.
router.get('/', verifyToken, requireRole('staff', 'admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.id, f.scheduled_date, f.sent_date, f.response, f.patient_comment, f.status,
            v.id AS visit_id, v.complaint,
            p.id AS patient_id, p.name AS patient_name, p.phone AS patient_phone,
            CASE
              WHEN f.status != 'pending' THEN f.status
              WHEN f.scheduled_date < CURRENT_DATE THEN 'overdue'
              WHEN f.scheduled_date = CURRENT_DATE THEN 'due_today'
              ELSE 'upcoming'
            END AS dashboard_status
     FROM followups f
     JOIN visits v ON v.id = f.visit_id
     JOIN patients p ON p.id = v.patient_id
     WHERE f.status != 'closed'
     ORDER BY f.scheduled_date ASC`
  );
  res.json(rows);
});

// Log a patient's follow-up response (e.g. after a staff-initiated WhatsApp check-in).
router.patch('/:id', verifyToken, requireRole('staff', 'admin'), async (req, res) => {
  const { id } = req.params;
  const { response, patient_comment, status } = req.body;

  const validResponses = ['better', 'same', 'worse', 'no_response'];
  if (response && !validResponses.includes(response)) {
    return res.status(400).json({ error: `response must be one of ${validResponses.join(', ')}` });
  }

  const { rows } = await pool.query(
    `UPDATE followups
     SET response = COALESCE($1, response),
         patient_comment = COALESCE($2, patient_comment),
         status = COALESCE($3, status),
         sent_date = COALESCE(sent_date, now()),
         logged_by_staff_id = $4
     WHERE id = $5
     RETURNING *`,
    [response || null, patient_comment || null, status || null, req.user.id, id]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Follow-up not found' });
  }
  res.json(rows[0]);
});

module.exports = router;

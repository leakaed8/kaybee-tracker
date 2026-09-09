const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

const router = express.Router();
const TOKEN_TTL = '12h';

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Staff login: username + password
router.post('/staff/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const { rows } = await pool.query('SELECT * FROM staff WHERE username = $1', [username]);
  const staff = rows[0];
  if (!staff || !(await bcrypt.compare(password, staff.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken({ id: staff.id, role: staff.role, name: staff.name });
  res.json({ token, user: { id: staff.id, name: staff.name, role: staff.role } });
});

// Patient login: phone + PIN
router.post('/patient/login', async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) {
    return res.status(400).json({ error: 'phone and pin are required' });
  }

  const { rows } = await pool.query('SELECT * FROM patients WHERE phone = $1', [phone]);
  const patient = rows[0];
  if (!patient || !(await bcrypt.compare(pin, patient.pin_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken({ id: patient.id, role: 'patient', name: patient.name });
  res.json({ token, user: { id: patient.id, name: patient.name, role: 'patient' } });
});

// Patient self-service signup: creates the account with a chosen PIN.
// (Staff can also create a patient with a PIN directly via POST /api/patients.)
router.post('/patient/signup', async (req, res) => {
  const { name, phone, pin, dob } = req.body;
  if (!name || !phone || !pin) {
    return res.status(400).json({ error: 'name, phone and pin are required' });
  }
  if (!/^\d{4,6}$/.test(pin)) {
    return res.status(400).json({ error: 'pin must be 4-6 digits' });
  }

  const existing = await pool.query('SELECT id FROM patients WHERE phone = $1', [phone]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with this phone number already exists' });
  }

  const pinHash = await bcrypt.hash(pin, 10);
  const { rows } = await pool.query(
    `INSERT INTO patients (name, phone, pin_hash, dob)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name`,
    [name, phone, pinHash, dob || null]
  );

  const patient = rows[0];
  const token = signToken({ id: patient.id, role: 'patient', name: patient.name });
  res.status(201).json({ token, user: { id: patient.id, name: patient.name, role: 'patient' } });
});

module.exports = router;

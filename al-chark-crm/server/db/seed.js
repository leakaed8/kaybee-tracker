// Seeds one test staff account, one test patient, and a couple of test
// products so the login flow and staff screens have something to show.
// Safe to re-run: uses ON CONFLICT to skip rows that already exist.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');

async function seed() {
  const staffPasswordHash = await bcrypt.hash('staff123', 10);
  const patientPinHash = await bcrypt.hash('1234', 10);

  await pool.query(
    `INSERT INTO staff (name, username, password_hash, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO NOTHING`,
    ['Test Staff', 'staff', staffPasswordHash, 'admin']
  );

  await pool.query(
    `INSERT INTO patients (name, phone, pin_hash, dob, skin_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (phone) DO NOTHING`,
    ['Test Patient', '+96170123456', patientPinHash, '1990-01-01', 'combination']
  );

  await pool.query(
    `INSERT INTO products (name, category, sku, price, stock_qty, duration_days)
     VALUES
       ('Gentle Cleanser', 'skincare', 'SKU-001', 12.5, 50, 60),
       ('Vitamin D Supplement', 'supplement', 'SKU-002', 8.0, 100, 30)
     ON CONFLICT (sku) DO NOTHING`
  );

  console.log('Seed complete. Staff login: staff / staff123. Patient login: +96170123456 / 1234');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

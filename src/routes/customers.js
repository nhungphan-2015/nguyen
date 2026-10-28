import { Router } from 'express';
import { db } from '../db.js';
import { asyncHandler } from '../asyncHandler.js';

export const customersRouter = Router();

customersRouter.get(
  '/lookup',
  asyncHandler(async (req, res) => {
    const phone = (req.query.phone || '').trim();
    const plate = (req.query.plate || '').trim();

    if (!phone && !plate) return res.json({ matches: [] });

    const conditions = [];
    const params = [];
    if (phone) {
      conditions.push('phone = ?');
      params.push(phone);
    }
    if (plate) {
      conditions.push('UPPER(license_plate) = UPPER(?)');
      params.push(plate);
    }

    const rows = await db.all(
      `SELECT * FROM tickets WHERE (${conditions.join(' OR ')}) ORDER BY created_at DESC LIMIT 50`,
      params
    );

    if (rows.length === 0) return res.json({ matches: [] });

    const byName = new Map();
    for (const r of rows) {
      const key = r.customer_name.trim().toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, {
          customer_name: r.customer_name,
          phone: r.phone,
          license_plate: r.license_plate,
          visit_count: 0,
          last_visit_at: r.created_at,
        });
      }
      const entry = byName.get(key);
      entry.visit_count += 1;
      if (!entry.phone && r.phone) entry.phone = r.phone;
      if (!entry.license_plate && r.license_plate) entry.license_plate = r.license_plate;
    }

    res.json({ matches: Array.from(byName.values()) });
  })
);

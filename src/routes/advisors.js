import { Router } from 'express';
import { db } from '../db.js';
import { asyncHandler } from '../asyncHandler.js';

export const advisorsRouter = Router();

async function advisorsWithStatus() {
  const advisors = await db.all('SELECT * FROM advisors ORDER BY id ASC');
  const result = [];
  for (const a of advisors) {
    const serving = await db.get(
      `SELECT * FROM tickets WHERE advisor_id = ? AND status = 'serving' LIMIT 1`,
      [a.id]
    );
    const waitingCount = (
      await db.get(`SELECT COUNT(*)::int AS n FROM tickets WHERE advisor_id = ? AND status = 'waiting'`, [a.id])
    ).n;
    const holdCount = (
      await db.get(`SELECT COUNT(*)::int AS n FROM tickets WHERE advisor_id = ? AND status = 'hold'`, [a.id])
    ).n;
    result.push({ ...a, serving: serving || null, waitingCount, holdCount });
  }
  return result;
}

advisorsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await advisorsWithStatus());
  })
);

advisorsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Tên cố vấn là bắt buộc' });
    const info = await db.run('INSERT INTO advisors (name, active) VALUES (?, 1)', [name.trim()]);
    req.app.locals.emitChanged();
    res.status(201).json(await db.get('SELECT * FROM advisors WHERE id = ?', [info.lastInsertRowid]));
  })
);

advisorsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await db.get('SELECT * FROM advisors WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Không tìm thấy cố vấn' });
    const name = req.body.name !== undefined ? req.body.name.trim() : existing.name;
    const active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : existing.active;
    await db.run('UPDATE advisors SET name = ?, active = ? WHERE id = ?', [name, active, id]);
    req.app.locals.emitChanged();
    res.json(await db.get('SELECT * FROM advisors WHERE id = ?', [id]));
  })
);

import { db, todayStr } from './db.js';

export async function nextTicketNumber(date) {
  const row = await db.get('SELECT MAX(ticket_number) AS "maxNum" FROM tickets WHERE ticket_date = ?', [date]);
  return (row.maxNum || 0) + 1;
}

export async function endOfQueueOrder(advisorId) {
  const row = await db.get(
    `SELECT MAX(queue_order) AS "maxOrder" FROM tickets
     WHERE advisor_id = ? AND status = 'waiting'`,
    [advisorId]
  );
  return (row.maxOrder || 0) + 1;
}

export async function frontOfQueueOrder(advisorId) {
  const row = await db.get(
    `SELECT MIN(queue_order) AS "minOrder" FROM tickets
     WHERE advisor_id = ? AND status = 'waiting'`,
    [advisorId]
  );
  return (row.minOrder || 0) - 1;
}

export async function pickAutoAdvisor() {
  const advisors = await db.all('SELECT id FROM advisors WHERE active = 1');
  if (advisors.length === 0) return null;

  const scored = [];
  for (const { id } of advisors) {
    const serving = (
      await db.get(`SELECT COUNT(*)::int AS n FROM tickets WHERE advisor_id = ? AND status = 'serving'`, [id])
    ).n;
    const waiting = (
      await db.get(`SELECT COUNT(*)::int AS n FROM tickets WHERE advisor_id = ? AND status = 'waiting'`, [id])
    ).n;
    scored.push({ id, busy: serving > 0 ? 1 : 0, waiting });
  }

  scored.sort((a, b) => a.busy - b.busy || a.waiting - b.waiting);
  return scored[0].id;
}

const DEFAULT_SERVICE_MINUTES = 15;

export async function avgServiceMinutes(advisorId) {
  const rows = await db.all(
    `SELECT called_at, done_at FROM tickets
     WHERE advisor_id = ? AND status = 'done' AND called_at IS NOT NULL AND done_at IS NOT NULL
     ORDER BY done_at DESC LIMIT 20`,
    [advisorId]
  );
  if (rows.length === 0) return DEFAULT_SERVICE_MINUTES;
  const totalMinutes = rows.reduce((sum, r) => {
    const mins = (new Date(r.done_at).getTime() - new Date(r.called_at).getTime()) / 60000;
    return sum + Math.max(mins, 1);
  }, 0);
  return Math.round((totalMinutes / rows.length) * 10) / 10;
}

export async function advisorSummary(advisorId) {
  const date = todayStr();
  const serving = await db.get(
    `SELECT * FROM tickets WHERE advisor_id = ? AND status = 'serving'
     ORDER BY called_at DESC LIMIT 1`,
    [advisorId]
  );
  const waitingRows = await db.all(
    `SELECT * FROM tickets WHERE advisor_id = ? AND status = 'waiting'
     ORDER BY queue_order ASC`,
    [advisorId]
  );
  const hold = await db.all(
    `SELECT * FROM tickets WHERE advisor_id = ? AND status = 'hold'
     ORDER BY called_at ASC`,
    [advisorId]
  );
  const scheduled = await db.all(
    `SELECT * FROM tickets WHERE advisor_id = ? AND status = 'scheduled' AND appointment_time LIKE ? || '%'
     ORDER BY appointment_time ASC`,
    [advisorId, date]
  );

  const avgMinutes = await avgServiceMinutes(advisorId);
  const waiting = waitingRows.map((t, idx) => ({
    ...t,
    estimated_wait_minutes: Math.round(avgMinutes * (idx + (serving ? 1 : 0))),
  }));

  return { serving: serving || null, waiting, hold, scheduled, avgServiceMinutes: avgMinutes };
}

export { todayStr };

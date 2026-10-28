import { Router } from 'express';
import { db, todayStr } from '../db.js';
import { asyncHandler } from '../asyncHandler.js';

export const reportsRouter = Router();

reportsRouter.get(
  '/daily',
  asyncHandler(async (req, res) => {
    const date = req.query.date || todayStr();

    const tickets = await db.all(
      `SELECT t.*, a.name AS advisor_name FROM tickets t
       LEFT JOIN advisors a ON a.id = t.advisor_id
       WHERE t.ticket_date = ?`,
      [date]
    );

  const totalTickets = tickets.length;
  const byType = { appointment: 0, walkin: 0 };
  const byStatus = { scheduled: 0, waiting: 0, serving: 0, hold: 0, done: 0, cancelled: 0 };
  let totalSkip = 0;
  let totalHold = 0;

  const perAdvisorMap = new Map();

  for (const t of tickets) {
    byType[t.type] = (byType[t.type] || 0) + 1;
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    totalSkip += t.skip_count || 0;
    totalHold += t.hold_count || 0;

    const key = t.advisor_id;
    if (!perAdvisorMap.has(key)) {
      perAdvisorMap.set(key, {
        advisor_id: t.advisor_id,
        advisor_name: t.advisor_name,
        total: 0,
        done: 0,
        cancelled: 0,
        skipCount: 0,
        holdCount: 0,
        serviceMinutesSum: 0,
        serviceCount: 0,
      });
    }
    const entry = perAdvisorMap.get(key);
    entry.total += 1;
    entry.skipCount += t.skip_count || 0;
    entry.holdCount += t.hold_count || 0;
    if (t.status === 'done') entry.done += 1;
    if (t.status === 'cancelled') entry.cancelled += 1;
    if (t.called_at && t.done_at) {
      const mins = (new Date(t.done_at).getTime() - new Date(t.called_at).getTime()) / 60000;
      entry.serviceMinutesSum += Math.max(mins, 0);
      entry.serviceCount += 1;
    }
  }

  const perAdvisor = Array.from(perAdvisorMap.values()).map((e) => ({
    advisor_id: e.advisor_id,
    advisor_name: e.advisor_name,
    total: e.total,
    done: e.done,
    cancelled: e.cancelled,
    skipCount: e.skipCount,
    holdCount: e.holdCount,
    avgServiceMinutes:
      e.serviceCount > 0 ? Math.round((e.serviceMinutesSum / e.serviceCount) * 10) / 10 : null,
  }));

  const overallServiced = tickets.filter((t) => t.called_at && t.done_at);
  const overallAvgServiceMinutes =
    overallServiced.length > 0
      ? Math.round(
          (overallServiced.reduce(
            (sum, t) =>
              sum + (new Date(t.done_at).getTime() - new Date(t.called_at).getTime()) / 60000,
            0
          ) /
            overallServiced.length) *
            10
        ) / 10
      : null;

    res.json({
      date,
      totalTickets,
      byType,
      byStatus,
      totalSkip,
      totalHold,
      overallAvgServiceMinutes,
      perAdvisor,
    });
  })
);

import { Router } from 'express';
import { db, nowIso, transaction } from '../db.js';
import { asyncHandler } from '../asyncHandler.js';
import {
  nextTicketNumber,
  endOfQueueOrder,
  frontOfQueueOrder,
  pickAutoAdvisor,
  advisorSummary,
  todayStr,
} from '../queueLogic.js';

export const ticketsRouter = Router();

async function ticketWithAdvisor(id) {
  return db.get(
    `SELECT t.*, a.name AS advisor_name
     FROM tickets t LEFT JOIN advisors a ON a.id = t.advisor_id
     WHERE t.id = ?`,
    [id]
  );
}

ticketsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const date = req.query.date || todayStr();
    const rows = await db.all(
      `SELECT t.*, a.name AS advisor_name
       FROM tickets t LEFT JOIN advisors a ON a.id = t.advisor_id
       WHERE t.ticket_date = ? OR (t.type = 'appointment' AND t.status = 'scheduled' AND t.appointment_time LIKE ? || '%')
       ORDER BY
         CASE WHEN t.ticket_number IS NULL THEN 1 ELSE 0 END,
         t.ticket_number ASC,
         t.appointment_time ASC`,
      [date, date]
    );
    res.json(rows);
  })
);

ticketsRouter.get(
  '/queue/:advisorId',
  asyncHandler(async (req, res) => {
    res.json(await advisorSummary(req.params.advisorId));
  })
);

ticketsRouter.get(
  '/board',
  asyncHandler(async (req, res) => {
    const advisors = await db.all('SELECT * FROM advisors WHERE active = 1 ORDER BY id ASC');
    const board = [];
    for (const a of advisors) {
      const { serving, waiting, avgServiceMinutes } = await advisorSummary(a.id);
      board.push({
        advisor_id: a.id,
        advisor_name: a.name,
        serving,
        nextUp: waiting.slice(0, 3),
        avgServiceMinutes,
      });
    }
    res.json(board);
  })
);

ticketsRouter.get(
  '/:id/public',
  asyncHandler(async (req, res) => {
    const ticket = await ticketWithAdvisor(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });

    let position = null;
    let estimatedWaitMinutes = null;
    if (ticket.status === 'waiting') {
      const { waiting } = await advisorSummary(ticket.advisor_id);
      const idx = waiting.findIndex((t) => t.id === ticket.id);
      if (idx >= 0) {
        position = idx + 1;
        estimatedWaitMinutes = waiting[idx].estimated_wait_minutes;
      }
    }

    res.json({
      id: ticket.id,
      ticket_number: ticket.ticket_number,
      customer_name: ticket.customer_name,
      license_plate: ticket.license_plate,
      advisor_name: ticket.advisor_name,
      status: ticket.status,
      appointment_time: ticket.appointment_time,
      position,
      estimated_wait_minutes: estimatedWaitMinutes,
    });
  })
);

ticketsRouter.post(
  '/appointment',
  asyncHandler(async (req, res) => {
    const { customer_name, phone, license_plate, advisor_id, appointment_time, notes, service_type } =
      req.body;
    if (!customer_name || !customer_name.trim())
      return res.status(400).json({ error: 'Tên khách hàng là bắt buộc' });
    if (!advisor_id) return res.status(400).json({ error: 'Cần chọn cố vấn' });
    if (!appointment_time) return res.status(400).json({ error: 'Cần giờ hẹn' });

    const info = await db.run(
      `INSERT INTO tickets
        (customer_name, phone, license_plate, type, advisor_id, appointment_time, status, notes, created_at, service_type)
       VALUES (?, ?, ?, 'appointment', ?, ?, 'scheduled', ?, ?, ?)`,
      [
        customer_name.trim(),
        phone || null,
        license_plate || null,
        advisor_id,
        appointment_time,
        notes || null,
        nowIso(),
        service_type || null,
      ]
    );

    req.app.locals.emitChanged();
    res.status(201).json(await ticketWithAdvisor(info.lastInsertRowid));
  })
);

ticketsRouter.post(
  '/walkin',
  asyncHandler(async (req, res) => {
    const { customer_name, phone, license_plate, advisor_id, auto, notes, service_type } = req.body;
    if (!customer_name || !customer_name.trim())
      return res.status(400).json({ error: 'Tên khách hàng là bắt buộc' });

    const chosenAdvisorId = auto ? await pickAutoAdvisor() : advisor_id;
    if (!chosenAdvisorId) return res.status(400).json({ error: 'Không có cố vấn khả dụng' });

    const date = todayStr();
    const ticketNumber = await nextTicketNumber(date);
    const queueOrder = await endOfQueueOrder(chosenAdvisorId);

    const info = await db.run(
      `INSERT INTO tickets
        (ticket_number, ticket_date, customer_name, phone, license_plate, type, advisor_id, status, notes, queue_order, created_at, checked_in_at, service_type)
       VALUES (?, ?, ?, ?, ?, 'walkin', ?, 'waiting', ?, ?, ?, ?, ?)`,
      [
        ticketNumber,
        date,
        customer_name.trim(),
        phone || null,
        license_plate || null,
        chosenAdvisorId,
        notes || null,
        queueOrder,
        nowIso(),
        nowIso(),
        service_type || null,
      ]
    );

    req.app.locals.emitChanged();
    res.status(201).json(await ticketWithAdvisor(info.lastInsertRowid));
  })
);

ticketsRouter.post(
  '/:id/checkin',
  asyncHandler(async (req, res) => {
    const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
    if (ticket.status !== 'scheduled')
      return res.status(400).json({ error: 'Vé này đã check-in hoặc không ở trạng thái đã hẹn' });

    const date = todayStr();
    const queueOrder = await endOfQueueOrder(ticket.advisor_id);

    // Khách đặt hẹn không cần số thứ tự — chỉ khách vãng lai mới được đánh số (lúc tạo vé).
    await db.run(
      `UPDATE tickets SET ticket_date = ?, status = 'waiting', queue_order = ?, checked_in_at = ?
       WHERE id = ?`,
      [date, queueOrder, nowIso(), ticket.id]
    );

    req.app.locals.emitChanged();
    res.json(await ticketWithAdvisor(ticket.id));
  })
);

ticketsRouter.post(
  '/:id/call',
  asyncHandler(async (req, res) => {
    const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
    if (!['waiting', 'hold'].includes(ticket.status))
      return res.status(400).json({ error: 'Vé không ở trạng thái chờ hoặc giữ chỗ' });

    const alreadyServing = await db.get(
      `SELECT * FROM tickets WHERE advisor_id = ? AND status = 'serving'`,
      [ticket.advisor_id]
    );
    if (alreadyServing)
      return res.status(409).json({ error: 'Cố vấn đang phục vụ khách khác, chưa thể gọi tiếp' });

    await db.run(`UPDATE tickets SET status = 'serving', called_at = ? WHERE id = ?`, [
      nowIso(),
      ticket.id,
    ]);

    req.app.locals.emitChanged();
    res.json(await ticketWithAdvisor(ticket.id));
  })
);

ticketsRouter.post(
  '/call-next/:advisorId',
  asyncHandler(async (req, res) => {
    const advisorId = req.params.advisorId;
    const alreadyServing = await db.get(
      `SELECT * FROM tickets WHERE advisor_id = ? AND status = 'serving'`,
      [advisorId]
    );
    if (alreadyServing)
      return res.status(409).json({ error: 'Cố vấn đang phục vụ khách khác, chưa thể gọi tiếp' });

    const next = await db.get(
      `SELECT * FROM tickets WHERE advisor_id = ? AND status = 'waiting' ORDER BY queue_order ASC LIMIT 1`,
      [advisorId]
    );
    if (!next) return res.status(404).json({ error: 'Không có khách nào đang chờ' });

    await db.run(`UPDATE tickets SET status = 'serving', called_at = ? WHERE id = ?`, [
      nowIso(),
      next.id,
    ]);

    req.app.locals.emitChanged();
    res.json(await ticketWithAdvisor(next.id));
  })
);

ticketsRouter.post(
  '/:id/complete',
  asyncHandler(async (req, res) => {
    const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
    await db.run(`UPDATE tickets SET status = 'done', done_at = ? WHERE id = ?`, [
      nowIso(),
      ticket.id,
    ]);
    req.app.locals.emitChanged();
    res.json(await ticketWithAdvisor(ticket.id));
  })
);

ticketsRouter.post(
  '/:id/skip',
  asyncHandler(async (req, res) => {
    const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
    const newOrder = await endOfQueueOrder(ticket.advisor_id);
    await db.run(
      `UPDATE tickets SET status = 'waiting', queue_order = ?, skip_count = skip_count + 1 WHERE id = ?`,
      [newOrder, ticket.id]
    );
    req.app.locals.emitChanged();
    res.json(await ticketWithAdvisor(ticket.id));
  })
);

ticketsRouter.post(
  '/:id/hold',
  asyncHandler(async (req, res) => {
    const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
    await db.run(`UPDATE tickets SET status = 'hold', hold_count = hold_count + 1 WHERE id = ?`, [
      ticket.id,
    ]);
    req.app.locals.emitChanged();
    res.json(await ticketWithAdvisor(ticket.id));
  })
);

ticketsRouter.post(
  '/:id/resume',
  asyncHandler(async (req, res) => {
    const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
    const newOrder = await frontOfQueueOrder(ticket.advisor_id);
    await db.run(`UPDATE tickets SET status = 'waiting', queue_order = ? WHERE id = ?`, [
      newOrder,
      ticket.id,
    ]);
    req.app.locals.emitChanged();
    res.json(await ticketWithAdvisor(ticket.id));
  })
);

ticketsRouter.post(
  '/:id/reassign',
  asyncHandler(async (req, res) => {
    const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
    const { advisor_id } = req.body;
    if (!advisor_id) return res.status(400).json({ error: 'Cần chọn cố vấn' });

    let queueOrder = ticket.queue_order;
    if (ticket.status === 'waiting') {
      queueOrder = await endOfQueueOrder(advisor_id);
    }
    await db.run(`UPDATE tickets SET advisor_id = ?, queue_order = ? WHERE id = ?`, [
      advisor_id,
      queueOrder,
      ticket.id,
    ]);
    req.app.locals.emitChanged();
    res.json(await ticketWithAdvisor(ticket.id));
  })
);

ticketsRouter.post(
  '/:id/reorder',
  asyncHandler(async (req, res) => {
    const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
    if (ticket.status !== 'waiting')
      return res.status(400).json({ error: 'Chỉ sắp xếp lại được vé đang chờ' });

    const { direction } = req.body;
    const neighbor =
      direction === 'up'
        ? await db.get(
            `SELECT * FROM tickets WHERE advisor_id = ? AND status = 'waiting' AND queue_order < ?
             ORDER BY queue_order DESC LIMIT 1`,
            [ticket.advisor_id, ticket.queue_order]
          )
        : await db.get(
            `SELECT * FROM tickets WHERE advisor_id = ? AND status = 'waiting' AND queue_order > ?
             ORDER BY queue_order ASC LIMIT 1`,
            [ticket.advisor_id, ticket.queue_order]
          );

    if (!neighbor) return res.json(await ticketWithAdvisor(ticket.id));

    await transaction(async (t) => {
      await t.run('UPDATE tickets SET queue_order = ? WHERE id = ?', [
        neighbor.queue_order,
        ticket.id,
      ]);
      await t.run('UPDATE tickets SET queue_order = ? WHERE id = ?', [
        ticket.queue_order,
        neighbor.id,
      ]);
    });

    req.app.locals.emitChanged();
    res.json(await ticketWithAdvisor(ticket.id));
  })
);

ticketsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Không tìm thấy vé' });
    await db.run(`UPDATE tickets SET status = 'cancelled' WHERE id = ?`, [ticket.id]);
    req.app.locals.emitChanged();
    res.json(await ticketWithAdvisor(ticket.id));
  })
);

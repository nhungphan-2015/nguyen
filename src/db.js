import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('Thiếu biến môi trường DATABASE_URL (connection string Postgres/Neon)');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export const db = {
  async get(sql, params = []) {
    const { rows } = await pool.query(toPgSql(sql), params);
    return rows[0];
  },
  async all(sql, params = []) {
    const { rows } = await pool.query(toPgSql(sql), params);
    return rows;
  },
  async run(sql, params = []) {
    const isInsert = /^\s*insert/i.test(sql);
    const hasReturning = /returning/i.test(sql);
    const finalSql = isInsert && !hasReturning ? `${sql} RETURNING id` : sql;
    const { rows } = await pool.query(toPgSql(finalSql), params);
    return { lastInsertRowid: rows[0]?.id, changes: rows.length };
  },
};

export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scoped = {
      async get(sql, params = []) {
        const { rows } = await client.query(toPgSql(sql), params);
        return rows[0];
      },
      async all(sql, params = []) {
        const { rows } = await client.query(toPgSql(sql), params);
        return rows;
      },
      async run(sql, params = []) {
        const isInsert = /^\s*insert/i.test(sql);
        const hasReturning = /returning/i.test(sql);
        const finalSql = isInsert && !hasReturning ? `${sql} RETURNING id` : sql;
        const { rows } = await client.query(toPgSql(finalSql), params);
        return { lastInsertRowid: rows[0]?.id, changes: rows.length };
      },
    };
    await fn(scoped);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS advisors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      ticket_number INTEGER,
      ticket_date TEXT,
      customer_name TEXT NOT NULL,
      phone TEXT,
      license_plate TEXT,
      type TEXT NOT NULL CHECK(type IN ('appointment','walkin')),
      service_type TEXT,
      advisor_id INTEGER REFERENCES advisors(id),
      appointment_time TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled',
      notes TEXT,
      queue_order DOUBLE PRECISION,
      created_at TEXT NOT NULL,
      checked_in_at TEXT,
      called_at TEXT,
      done_at TEXT,
      skip_count INTEGER NOT NULL DEFAULT 0,
      hold_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM advisors');
  if (rows[0].n === 0) {
    for (const name of ['Nguyễn Văn A', 'Trần Thị B', 'Lê Văn C']) {
      await pool.query('INSERT INTO advisors (name, active) VALUES ($1, 1)', [name]);
    }
  }
}

export const ready = migrate();

export function todayStr() {
  const vnNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${vnNow.getUTCFullYear()}-${pad(vnNow.getUTCMonth() + 1)}-${pad(vnNow.getUTCDate())}`;
}

export function nowIso() {
  return new Date().toISOString();
}

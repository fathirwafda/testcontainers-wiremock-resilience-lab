import type { Pool } from 'pg';

interface Migration {
  id: string;
  sql: string;
}

/**
 * Migrations live in code so the compiled app and the tests apply exactly the same SQL,
 * with no file-copy step in the build. Append only; never edit a migration that has shipped.
 */
export const migrations: readonly Migration[] = [
  {
    id: '001_create_orders',
    sql: `
      CREATE TABLE orders (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        idempotency_key    text NOT NULL UNIQUE,
        request_hash       text NOT NULL,
        customer_id        text NOT NULL,
        status             text NOT NULL CHECK (status IN
                             ('PENDING_PAYMENT', 'PAID', 'PAYMENT_DECLINED', 'PAYMENT_UNAVAILABLE')),
        items              jsonb NOT NULL,
        subtotal_cents     integer NOT NULL CHECK (subtotal_cents >= 0),
        shipping_cents     integer NOT NULL CHECK (shipping_cents >= 0),
        shipping_source    text NOT NULL CHECK (shipping_source IN ('live', 'cache', 'default')),
        total_cents        integer GENERATED ALWAYS AS (subtotal_cents + shipping_cents) STORED,
        currency           char(3) NOT NULL,
        payment_id         text,
        failure_reason     text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX orders_customer_id_idx ON orders (customer_id);
    `,
  },
];

const LOCK_ID = 7_314_002; // arbitrary, constant: serializes concurrent migrators

export async function migrate(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const done = new Set(rows.map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        applied.push(m.id);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

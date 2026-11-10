import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';

export const POSTGRES_IMAGE = 'postgres:18.6-alpine';

export interface StartedPostgres {
  container: StartedPostgreSqlContainer;
  pool: pg.Pool;
  stop: () => Promise<void>;
}

/** A real, throwaway PostgreSQL with the app's migrations applied. One per test file. */
export async function startPostgres(): Promise<StartedPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 10 });
  await migrate(pool);
  return {
    container,
    pool,
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

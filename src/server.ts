import { createApp, createDeps } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';

const config = loadConfig();
const deps = createDeps(config, {
  onRetry: ({ attempt, delayMs, error }) =>
    console.log(
      JSON.stringify({
        level: 'warn',
        msg: 'retrying',
        dependency: error.dependency,
        attempt,
        delayMs,
        error: error.name,
      }),
    ),
});

const applied = await migrate(deps.pool);
if (applied.length > 0)
  console.log(JSON.stringify({ level: 'info', msg: 'migrations applied', applied }));

const server = createApp(deps).listen(config.port, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', port: config.port }));
});

const shutdown = (signal: string) => {
  console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
  server.close(() => {
    void deps.pool.end().then(() => process.exit(0));
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

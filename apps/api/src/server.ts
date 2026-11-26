import { app } from './app';
import { config } from './config';

const server = app.listen(config.PORT, () => {
  console.info(`Starvega API listening on port ${config.PORT}`);
});

function shutdown(): void {
  server.close(() => {
    console.info('HTTP server closed');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

import { buildApp } from './app';
import { env, warnAboutMissingConfig } from './config/env';
import { closePool, migrate } from './db/client';
import { logger } from './lib/logger';
import { seedIfEmpty } from './db/seed';

/**
 * Server entry point.
 *
 * Order matters: connect and migrate *before* binding the port, so an instance
 * never accepts a phone call it cannot persist. If the database is unreachable
 * we exit non-zero and let the platform restart us, rather than serving traffic
 * in a broken state.
 */
async function main(): Promise<void> {
  try {
    await migrate();
  } catch (error) {
    logger.fatal({ err: error }, 'Could not connect to the database — exiting');
    process.exit(1);
  }

  if (env.seedOnBoot) {
    try {
      await seedIfEmpty();
    } catch (error) {
      // Seeding is a convenience, not a precondition for serving traffic.
      logger.error({ err: error }, 'Seeding failed — continuing without demo data');
    }
  }

  warnAboutMissingConfig((message) => logger.warn(message));

  const app = await buildApp();

  try {
    await app.listen({ port: env.port, host: env.host });
    logger.info(
      {
        port: env.port,
        public_base_url: env.publicBaseUrl,
        webhook: `${env.publicBaseUrl}/voice/vapi`,
      },
      'Patient registration service listening',
    );
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to bind port — exiting');
    process.exit(1);
  }

  /** Drain in-flight requests and close pooled connections on redeploy. */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    try {
      await app.close();
      await closePool();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A crashed process mid-call is worse than a logged error, so never let an
  // unhandled rejection take the server down silently.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
}

void main();

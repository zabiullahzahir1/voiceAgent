import { buildApp } from './app';
import { env, warnAboutMissingConfig } from './config/env';
import { getDb } from './db/client';
import { logger } from './lib/logger';
import { seedIfEmpty } from './db/seed';

/**
 * Server entry point.
 *
 * Order matters: open and migrate the database *before* binding the port, so an
 * instance never accepts a phone call it cannot persist. If the database cannot
 * be opened we exit non-zero and let Render restart us, rather than serving
 * traffic in a broken state.
 */
async function main(): Promise<void> {
  try {
    getDb(); // opens the file, applies the schema
  } catch (error) {
    logger.fatal({ err: error, path: env.databasePath }, 'Could not open the database — exiting');
    process.exit(1);
  }

  if (env.seedOnBoot) seedIfEmpty();

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

  /** Drain in-flight requests on redeploy instead of dropping them. */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    try {
      await app.close();
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

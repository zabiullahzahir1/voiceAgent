import { closePool, migrate } from './client';
import { logger } from '../lib/logger';
import { countPatients } from '../domain/patient.repository';
import { createPatient } from '../domain/patient.service';

/**
 * Demo seed data.
 *
 * Two fictional patients so `GET /patients` is not empty on a fresh deploy and
 * so returning-caller detection can be demonstrated without making a call
 * first: dial in and give 415 555 0142 and the agent will recognise Jane Doe.
 *
 * These are obviously fake — 555 numbers are reserved for fiction, and the
 * assessment says not to store real patient data.
 */
const SEED_PATIENTS = [
  {
    first_name: 'Jane',
    last_name: 'Doe',
    date_of_birth: '03/05/1985',
    sex: 'Female',
    phone_number: '4155550142',
    email: 'jane.doe@example.com',
    address_line_1: '42 Oak Street',
    address_line_2: 'Apt 3B',
    city: 'San Francisco',
    state: 'CA',
    zip_code: '94107',
    insurance_provider: 'Blue Shield',
    insurance_member_id: 'BS4471902',
    preferred_language: 'English',
    emergency_contact_name: 'John Doe',
    emergency_contact_phone: '4155550188',
  },
  {
    first_name: 'Miguel',
    last_name: "O'Connor",
    date_of_birth: '11/22/1970',
    sex: 'Male',
    phone_number: '2125550119',
    address_line_1: '1200 Broadway',
    city: 'New York',
    state: 'NY',
    zip_code: '10001-4521',
    preferred_language: 'Spanish',
  },
];

/**
 * Insert the seed rows only when the table is empty.
 *
 * The emptiness check is what makes this safe to run on every boot: a redeploy
 * against a database that already holds real registrations is a no-op, so
 * seeding can never clobber data collected during a call.
 */
export async function seedIfEmpty(): Promise<void> {
  if ((await countPatients()) > 0) {
    logger.debug('Database already contains patients — skipping seed');
    return;
  }

  for (const patient of SEED_PATIENTS) {
    try {
      await createPatient(patient);
    } catch (error) {
      logger.error({ err: error, patient: patient.last_name }, 'Failed to insert seed patient');
    }
  }

  logger.info({ count: SEED_PATIENTS.length }, 'Seeded demo patients');
}

// Allow `npm run seed` to run this file directly.
if (require.main === module) {
  void (async () => {
    await migrate();
    await seedIfEmpty();
    await closePool();
  })();
}

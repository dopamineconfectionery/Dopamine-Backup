import { runBackup } from './backup.js';
import { validateEnvironment } from './config.js';

async function main(): Promise<void> {
  try {
    console.log('Starting dopamine database backup...');

    validateEnvironment();

    await runBackup();

    console.log('Backup completed successfully');
  } catch (error) {
    console.error('Backup failed:', error);

    process.exit(1);
  }
}

main();

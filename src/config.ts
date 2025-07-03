import 'dotenv/config';

export const BACKUP_DIR = process.env.BACKUP_DIR || 'backups';
export const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '15', 10);
export const DATABASE_URL = process.env.DATABASE_URL;
export const B2_APPLICATION_KEY_ID = process.env.B2_APPLICATION_KEY_ID;
export const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY;
export const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME;
export const B2_REGION = process.env.B2_REGION || 'us-east-005';
export const RESEND_API_KEY = process.env.RESEND_API_KEY;

export const MAX_RETRIES = 3;
export const RETRY_DELAY = 10000;

export function validateEnvironment(): void {
  const required = [
    'BACKUP_DIR',
    'RETENTION_DAYS',
    'DATABASE_URL',
    'B2_APPLICATION_KEY_ID',
    'B2_APPLICATION_KEY',
    'B2_BUCKET_NAME',
    'B2_REGION',
    'RESEND_API_KEY'
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }

  if (RETENTION_DAYS < 1) {
    throw new Error('RETENTION_DAYS must be positive');
  }

  if (!isValidUrl(DATABASE_URL!)) {
    throw new Error('DATABASE_URL must be a valid URL');
  }
}

export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function escapeShellArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

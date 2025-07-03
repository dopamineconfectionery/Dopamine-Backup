import { exec } from 'child_process';
import { createReadStream, createWriteStream } from 'fs';
import { access, mkdir, readFile, stat, unlink } from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { createGzip } from 'zlib';

import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { Resend } from 'resend';

import {
  B2_APPLICATION_KEY,
  B2_APPLICATION_KEY_ID,
  B2_BUCKET_NAME,
  B2_REGION,
  BACKUP_DIR,
  DATABASE_URL,
  escapeShellArg,
  MAX_RETRIES,
  RESEND_API_KEY,
  RETENTION_DAYS,
  RETRY_DELAY
} from './config.js';

const execAsync = promisify(exec);

export async function sendErrorEmail(
  error: Error,
  details: string = ''
): Promise<void> {
  try {
    const resend = new Resend(RESEND_API_KEY);

    const { error: emailError } = await resend.emails.send({
      from: 'Mohit from Dopamine <mohit@dopamine.com.np>',
      to: ['orderatdopamine@gmail.com'],
      subject: 'Backup Failed - Dopamine Confectionery',
      html: `
Database Backup Failed

Timestamp: ${new Date().toISOString()}

Error: ${error}

${details ? `Details:\n${details}` : ''}

Please investigate this backup failure immediately.
      `.trim()
    });

    if (emailError) {
      console.error('Error sending alert email:', emailError);
    } else {
      console.log('Error alert email sent successfully');
    }
  } catch (error) {
    console.error('Failed to send error email:', (error as Error).message);
  }
}

const b2Client = new S3Client({
  region: B2_REGION,
  endpoint: `https://s3.${B2_REGION}.backblazeb2.com`,
  credentials: {
    accessKeyId: B2_APPLICATION_KEY_ID!,
    secretAccessKey: B2_APPLICATION_KEY!
  },
  maxAttempts: 3
});

async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  delay: number = RETRY_DELAY
): Promise<T> {
  let lastError: Error;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      console.warn(
        `Attempt ${attempt}/${maxRetries} failed: ${lastError.message}`
      );

      if (attempt < maxRetries) {
        console.log(`Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}

async function uploadToB2(filePath: string): Promise<string> {
  const fileName = path.basename(filePath);
  const compressedFileName = `${fileName}.gz`;
  const compressedFilePath = filePath + '.gz';

  return withRetry(async () => {
    console.log(`Compressing and uploading ${fileName} to B2...`);

    try {
      const gzip = createGzip({ level: 6 });
      const source = createReadStream(filePath);
      const destination = createWriteStream(compressedFilePath);

      await pipeline(source, gzip, destination);

      const originalSize = (await stat(filePath)).size;
      const compressedSize = (await stat(compressedFilePath)).size;

      console.log(
        `Compression: ${originalSize} → ${compressedSize} bytes (${Math.round((1 - compressedSize / originalSize) * 100)}% reduction)`
      );

      const fileContent = await readFile(compressedFilePath);

      await b2Client.send(
        new PutObjectCommand({
          Bucket: B2_BUCKET_NAME,
          Key: `backups/${compressedFileName}`,
          Body: fileContent,
          ContentType: 'application/gzip',
          Metadata: {
            'upload-date': new Date().toISOString(),
            source: 'dopamine-backup-script',
            'original-size': originalSize.toString(),
            'compressed-size': compressedSize.toString()
          }
        })
      );

      await unlink(compressedFilePath);

      console.log(`Successfully uploaded ${compressedFileName} to B2`);

      return `backups/${compressedFileName}`;
    } catch (error) {
      try {
        await unlink(compressedFilePath);
      } catch (cleanupError) {}
      throw error;
    }
  });
}

async function cleanupB2Backups(): Promise<void> {
  console.log(`Cleaning up B2 backups older than ${RETENTION_DAYS} days...`);

  return withRetry(async () => {
    const listResponse = await b2Client.send(
      new ListObjectsV2Command({
        Bucket: B2_BUCKET_NAME,
        Prefix: 'backups/',
        MaxKeys: 1000
      })
    );

    if (!listResponse.Contents?.length) {
      console.log('No B2 backups found');
      return;
    }

    const cutoffDate = new Date(
      Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    );
    const objectsToDelete = listResponse.Contents.filter(
      (obj) => obj.LastModified && obj.LastModified < cutoffDate
    );

    if (!objectsToDelete.length) {
      console.log('No old B2 backups to clean up');
      return;
    }

    console.log(`Found ${objectsToDelete.length} old backups to delete`);

    const batchSize = 10;
    let deleted = 0;

    for (let i = 0; i < objectsToDelete.length; i += batchSize) {
      const batch = objectsToDelete.slice(i, i + batchSize);

      await Promise.allSettled(
        batch.map(async (obj) => {
          try {
            await b2Client.send(
              new DeleteObjectCommand({
                Bucket: B2_BUCKET_NAME,
                Key: obj.Key!
              })
            );
            console.log(`Deleted B2 backup: ${obj.Key}`);
            deleted++;
          } catch (error) {
            console.error(
              `Failed to delete ${obj.Key}: ${(error as Error).message}`
            );
          }
        })
      );

      if (i + batchSize < objectsToDelete.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log(
      `B2 cleanup completed: ${deleted}/${objectsToDelete.length} files deleted`
    );
  });
}

async function createBackup(): Promise<string> {
  console.log('Starting database backup...');

  await mkdir(BACKUP_DIR, { recursive: true });

  const timestamp = new Date().toISOString();

  const backupFile = path.resolve(BACKUP_DIR, `backup-${timestamp}.sql`);

  const command = `supabase db dump --db-url ${escapeShellArg(DATABASE_URL!)} -f ${escapeShellArg(backupFile)} --data-only`;

  return withRetry(async () => {
    try {
      await execAsync(command);

      await access(backupFile);

      const { size } = await stat(backupFile);

      if (size === 0) {
        throw new Error('Backup file is empty');
      }

      if (size < 1000) {
        console.warn(`Backup file is unusually small: ${size} bytes`);
      }

      console.log(`Backup created successfully: ${backupFile} (${size} bytes)`);

      return backupFile;
    } catch (error) {
      try {
        await unlink(backupFile);
      } catch {}
      throw error;
    }
  }, 2);
}

async function deleteLocalBackup(filePath: string): Promise<void> {
  try {
    await unlink(filePath);

    console.log(`Deleted local backup: ${path.basename(filePath)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `Failed to delete local backup ${filePath}: ${(error as Error).message}`
      );
    }
  }
}

async function healthCheck(): Promise<void> {
  try {
    await b2Client.send(
      new ListObjectsV2Command({
        Bucket: B2_BUCKET_NAME,
        MaxKeys: 1
      })
    );

    console.log('B2 connectivity check passed');
  } catch (error) {
    throw new Error(`B2 health check failed: ${(error as Error).message}`);
  }
}

export async function runBackup(): Promise<void> {
  const startTime = Date.now();

  console.log(
    `\n=== Backup Process Started at ${new Date().toISOString()} ===`
  );

  try {
    await healthCheck();

    const backupFile = await createBackup();

    await uploadToB2(backupFile);

    await deleteLocalBackup(backupFile);

    await cleanupB2Backups();

    const duration = Math.round((Date.now() - startTime) / 1000);

    console.log(
      `=== Backup Process Completed Successfully in ${duration}s ===\n`
    );
  } catch (error) {
    const duration = Math.round((Date.now() - startTime) / 1000);

    const errorMessage = `=== Backup Process Failed after ${duration}s ===`;

    console.error(errorMessage);

    console.error('Error:', (error as Error).message);

    await sendErrorEmail(error as Error, `Process duration: ${duration}s`);

    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    }
  }
}

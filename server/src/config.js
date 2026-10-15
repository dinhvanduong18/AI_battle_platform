import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
export const config = {
  port: Number(process.env.PORT || 8787),
  origin: process.env.PUBLIC_ORIGIN || 'http://localhost:8000',
  jwtSecret: process.env.JWT_SECRET || '',
  databaseUrl: process.env.DATABASE_URL || 'postgres://ott:ott@127.0.0.1:5432/ottv2',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  minEloGap: Number(process.env.QUEUE_MIN_ELO_GAP || 100),
  maxEloGap: Number(process.env.QUEUE_MAX_ELO_GAP || 400),
  expandEveryMs: Number(process.env.QUEUE_EXPAND_EVERY_MS || 10000),
  fideK: Number(process.env.FIDE_K_FACTOR || 20),
  replayBucket: process.env.S3_BUCKET || '',
  s3Endpoint: process.env.S3_ENDPOINT || '',
  s3Region: process.env.S3_REGION || 'auto',
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false'
};
if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');

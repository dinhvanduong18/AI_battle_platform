import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function createReplayStorage(config) {
  const enabled = Boolean(config.replayBucket && config.s3AccessKeyId && config.s3SecretAccessKey);
  const client = enabled ? new S3Client({
    endpoint: config.s3Endpoint || undefined,
    region: config.s3Region,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey }
  }) : null;
  return {
    enabled,
    async put(matchId, replay) {
      const body = Buffer.from(JSON.stringify(replay));
      const checksum = createHash('sha256').update(body).digest('hex');
      if (!enabled) return { key: null, checksum, json: replay };
      const key = `replays/${matchId}.json`;
      await client.send(new PutObjectCommand({ Bucket: config.replayBucket, Key: key, Body: body, ContentType: 'application/json' }));
      return { key, checksum, json: null };
    },
    async getUrl(key) {
      if (!enabled || !key) return null;
      return getSignedUrl(client, new GetObjectCommand({ Bucket: config.replayBucket, Key: key }), { expiresIn: 300 });
    }
  };
}

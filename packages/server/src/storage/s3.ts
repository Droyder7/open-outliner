import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

/**
 * S3/MinIO client wiring for the attachment blob plane (attachments.md).
 *
 * - PUT presigns (upload) expire in ~5 min; GET presigns (download) ~15 min.
 * - The `s3_key` is always server-assigned: `<documentId>/<attachmentId>` so a
 *   client can never overwrite another tenant's object.
 * - Server verifies size, MIME, and checksum against the stored object on
 *   finalization — client-supplied values are only used for the presign policy
 *   enforcing content-length-range; the persisted values are server-computed.
 */

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Force path-style addressing for MinIO compatibility. Default true. */
  forcePathStyle?: boolean;
}

export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/zip',
] as const;

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

export const PUT_PRESIGN_TTL_SEC = 5 * 60; // 5 minutes
export const GET_PRESIGN_TTL_SEC = 15 * 60; // 15 minutes

export interface S3Service {
  /** Presign a PUT URL for the given s3_key. */
  presignPut(s3Key: string, mime: string, maxBytes: number): Promise<string>;
  /** Presign a GET URL for the given s3_key. */
  presignGet(s3Key: string): Promise<string>;
  /**
   * Head the stored object to verify size. Returns null if the object does not
   * exist yet (upload not complete).
   */
  headObject(s3Key: string): Promise<{ size: number; etag: string } | null>;
  /** Delete a single object from S3. */
  deleteObject(s3Key: string): Promise<void>;
  /** Delete multiple objects in one batched call (max 1000 per AWS limit). */
  deleteObjects(s3Keys: string[]): Promise<void>;
  /** Derive the canonical s3_key for a given document + attachment id. */
  s3Key(documentId: string, attachmentId: string): string;
}

export function createS3Service(config: S3Config): S3Service {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle ?? true,
  });
  const bucket = config.bucket;

  return {
    s3Key(documentId, attachmentId) {
      return `${documentId}/${attachmentId}`;
    },

    async presignPut(s3Key, mime, maxBytes) {
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        ContentType: mime,
        ContentLength: maxBytes,
      });
      return getSignedUrl(client, cmd, { expiresIn: PUT_PRESIGN_TTL_SEC });
    },

    async presignGet(s3Key) {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: s3Key });
      return getSignedUrl(client, cmd, { expiresIn: GET_PRESIGN_TTL_SEC });
    },

    async headObject(s3Key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key }));
        if (res.ContentLength === undefined) return null;
        return {
          size: res.ContentLength,
          etag: res.ETag?.replace(/"/g, '') ?? '',
        };
      } catch (err: unknown) {
        if (
          typeof err === 'object' &&
          err !== null &&
          '$metadata' in err &&
          (err as { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode === 404
        ) {
          return null;
        }
        throw err;
      }
    },

    async deleteObject(s3Key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key }));
    },

    async deleteObjects(s3Keys) {
      if (s3Keys.length === 0) return;
      const objects: ObjectIdentifier[] = s3Keys.map((Key) => ({ Key }));
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    },
  };
}

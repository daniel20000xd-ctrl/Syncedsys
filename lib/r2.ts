import { S3Client } from '@aws-sdk/client-s3'

let _client: S3Client | null = null

export function getR2Client(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    })
  }
  return _client
}

export const R2_BUCKET = process.env.R2_BUCKET_NAME ?? 'syncedsys-storage'

export const STORAGE_LIMIT_BYTES = 2 * 1024 ** 3 // 2 GB per user

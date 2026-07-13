import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { config, requireEnv } from "@/lib/config";
import type { SegmentContentType } from "@/lib/db/schema";

/**
 * Cloudflare R2 (S3-compatible) upload helper.
 *
 * Audio object keys are deterministic from the segment id (`audio/<id>.mp3`
 * for news, `commentary/<id>.mp3` for long-form commentary).
 * Use an R2 API token scoped to just this bucket with Object Read & Write.
 */
let _client: S3Client | undefined;

function client(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: "auto",
      endpoint: `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return _client;
}

export function audioKey(segmentId: string, contentType: SegmentContentType = "news"): string {
  const prefix = contentType === "commentary" ? "commentary" : "audio";
  return `${prefix}/${segmentId}.mp3`;
}

export function publicUrl(key: string): string {
  return `${requireEnv("R2_PUBLIC_BASE_URL").replace(/\/+$/, "")}/${key}`;
}

export interface UploadResult {
  url: string;
  key: string;
  bytes: number;
}

export async function uploadAudio(
  segmentId: string,
  body: Buffer,
  contentType: SegmentContentType = "news",
): Promise<UploadResult> {
  const key = audioKey(segmentId, contentType);
  await client().send(
    new PutObjectCommand({
      Bucket: requireEnv("R2_BUCKET"),
      Key: key,
      Body: body,
      ContentType: "audio/mpeg",
    }),
  );
  return { url: publicUrl(key), key, bytes: body.length };
}

/** Bucket name (for logging). */
export function bucketName(): string {
  return config.R2_BUCKET;
}

/**
 * Shared helpers for the audio stage (trimmed copy of the private repo's
 * worker/pipeline/shared.ts — only the audio-relevant parts).
 */
import { requireEnv } from "@/lib/config";
import { listChineseVoices } from "@/lib/providers/tts";

export interface AudioSummary {
  pending: number;
  synthesized: number;
  failed: number;
  bytesUploaded: number;
}

/** DATABASE_URL is required to read pending segments + write results. */
export function requireDb() {
  requireEnv("DATABASE_URL");
}

/** The audio stage uploads MP3s to R2. */
export function requireR2() {
  requireEnv("R2_ACCOUNT_ID");
  requireEnv("R2_ACCESS_KEY_ID");
  requireEnv("R2_SECRET_ACCESS_KEY");
  requireEnv("R2_PUBLIC_BASE_URL");
}

/** Chinese voices the installed Kokoro build can serve (null if unavailable). */
export async function getAvailableVoices(): Promise<Set<string> | null> {
  try {
    return new Set(await listChineseVoices());
  } catch (err) {
    console.warn(
      `⚠️  Could not enumerate Kokoro voices (${(err as Error).message}). ` +
        "Skipping voice validation.",
    );
    return null;
  }
}

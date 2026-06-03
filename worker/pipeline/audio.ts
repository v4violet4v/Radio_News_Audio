/**
 * Audio stage: pick up segments with status='pending_audio', synthesize speech
 * with Kokoro (capturing per-sentence timing), upload the mp3 to R2, and mark
 * the segment 'ready'. Heavy (torch + Kokoro) — this is why it runs in this
 * public repo (unlimited free GitHub Actions minutes).
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { categories, segments } from "@/lib/db/schema";
import { getTtsProvider } from "@/lib/providers/tts";
import { uploadAudio, bucketName } from "@/lib/r2";
import { getAvailableVoices, requireDb, requireR2, type AudioSummary } from "./shared";

export async function runAudioStage(): Promise<AudioSummary> {
  requireDb();
  requireR2();

  const summary: AudioSummary = {
    pending: 0,
    synthesized: 0,
    failed: 0,
    bytesUploaded: 0,
  };

  console.log(`\n=== Audio stage (TTS=${config.TTS_PROVIDER}) ===`);

  // Oldest pending first, capped per run (Kokoro is slow).
  const pending = await db
    .select({
      id: segments.id,
      scriptText: segments.scriptText,
      voiceId: segments.voiceId,
      categoryId: segments.categoryId,
      headline: segments.headline,
    })
    .from(segments)
    .where(and(eq(segments.status, "pending_audio"), isNull(segments.audioUrl)))
    .orderBy(asc(segments.createdAt))
    .limit(config.MAX_AUDIO_PER_RUN);

  summary.pending = pending.length;
  console.log(
    `Pending audio segments: ${pending.length} (cap ${config.MAX_AUDIO_PER_RUN})`,
  );
  if (pending.length === 0) return summary;

  // Per-category TTS speed (defaults to 1.0).
  const cats = await db
    .select({ id: categories.id, speed: categories.speed })
    .from(categories);
  const speedByCat = new Map(cats.map((c) => [c.id, c.speed]));

  // Validate voices once (best-effort; null if Kokoro can't enumerate).
  const availableVoices = await getAvailableVoices();

  for (const seg of pending) {
    if (availableVoices && !availableVoices.has(seg.voiceId)) {
      console.warn(
        `  ⚠️  voice "${seg.voiceId}" not installed — marking failed: ${seg.headline.slice(0, 30)}`,
      );
      await db.update(segments).set({ status: "failed" }).where(eq(segments.id, seg.id));
      summary.failed++;
      continue;
    }

    try {
      const { mp3Buffer, durationSeconds, transcript } =
        await getTtsProvider().synthesize({
          text: seg.scriptText,
          voiceId: seg.voiceId,
          speed: speedByCat.get(seg.categoryId) ?? 1.0,
        });
      const upload = await uploadAudio(seg.id, mp3Buffer);
      summary.bytesUploaded += upload.bytes;

      await db
        .update(segments)
        .set({
          audioUrl: upload.url,
          durationSeconds,
          transcript: transcript.length > 0 ? transcript : null,
          status: "ready",
        })
        .where(eq(segments.id, seg.id));

      summary.synthesized++;
      console.log(`  ✓ ${seg.headline.slice(0, 40)} (${durationSeconds}s)`);
    } catch (err) {
      summary.failed++;
      console.error(
        `  ❌ TTS failed (${seg.headline.slice(0, 30)}): ${(err as Error).message}`,
      );
      await db
        .update(segments)
        .set({ status: "failed" })
        .where(eq(segments.id, seg.id))
        .catch(() => {});
    }
  }

  console.log("\n--- Audio stage summary ---");
  console.log(`  pending:      ${summary.pending}`);
  console.log(`  synthesized:  ${summary.synthesized}`);
  console.log(`  failed:       ${summary.failed}`);
  console.log(
    `  uploaded:     ${(summary.bytesUploaded / 1024 / 1024).toFixed(2)} MB → ${bucketName()}`,
  );
  return summary;
}

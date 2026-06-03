/**
 * Audio-generation stage entry point (npm run ingest:audio).
 *
 * Reads pending_audio segments from the shared Neon DB, synthesizes them with
 * Kokoro, uploads the mp3 to R2, and marks them ready (writing transcript +
 * duration back to the DB). Heavy (torch + Kokoro) — runs on this public repo's
 * free GitHub Actions minutes.
 */
import "dotenv/config";
import { runAudioStage } from "./pipeline/audio";

async function main() {
  const started = Date.now();
  await runAudioStage();
  console.log(`\n✅ Audio run done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Audio generation failed:", err);
    process.exit(1);
  });

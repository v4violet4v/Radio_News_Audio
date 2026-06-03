import { z } from "zod";

/**
 * Typed access to the environment variables the AUDIO worker needs.
 *
 * This is a trimmed copy of the private repo's lib/config.ts — only the vars
 * the audio stage uses. No LLM / auth / text-pipeline secrets live here.
 *
 * Fields are optional so `tsc` / imports don't crash when a secret is missing;
 * use `requireEnv()` at the point of use to assert presence at runtime.
 *
 * Note: KOKORO_REPO_ID and TTS_SENTENCE_GAP_SEC are read directly by the Python
 * worker (worker/tts_kokoro.py) from the process env, so they are not parsed here.
 */
const schema = z.object({
  // Shared Neon database (scoped audio_worker role).
  DATABASE_URL: z.string().optional(),

  // TTS (Kokoro via the local Python helper).
  TTS_PROVIDER: z.enum(["kokoro"]).default("kokoro"),
  PYTHON_BIN: z.string().default("python"),

  // Storage (Cloudflare R2, bucket-scoped token).
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("news-radio-audio"),
  R2_PUBLIC_BASE_URL: z.string().optional(),

  // Max segments the audio stage synthesizes per run (Kokoro is slow). Leftover
  // pending_audio segments are picked up by the next run.
  MAX_AUDIO_PER_RUN: z.coerce.number().int().positive().default(20),
});

export type AppConfig = z.infer<typeof schema>;

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const config: AppConfig = parsed.data;

/** Assert that an env var is present at runtime, returning its value. */
export function requireEnv<K extends keyof AppConfig>(key: K): NonNullable<AppConfig[K]> {
  const value = config[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `Missing required environment variable: ${String(key)}. ` +
        `Set it in .env (local) or GitHub Actions secrets (CI).`,
    );
  }
  return value as NonNullable<AppConfig[K]>;
}

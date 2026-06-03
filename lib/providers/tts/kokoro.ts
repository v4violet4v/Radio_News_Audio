import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "@/lib/config";
import type { TtsInput, TtsProvider, TtsResult } from "./types";

const PY_SCRIPT = fileURLToPath(
  new URL("../../../worker/tts_kokoro.py", import.meta.url),
);

interface KokoroSynthResult {
  ok: boolean;
  duration_seconds?: number;
  lines?: { start: number; end: number; text: string }[];
  error?: string;
}

/** Runs the Python Kokoro helper, sending `payload` as JSON on stdin. */
function runKokoro(args: string[], payload?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.PYTHON_BIN, [PY_SCRIPT, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) =>
      reject(
        new Error(
          `Failed to launch Kokoro (PYTHON_BIN="${config.PYTHON_BIN}"): ${err.message}`,
        ),
      ),
    );
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Kokoro helper exited with code ${code}.\n${stderr.trim()}`));
      } else {
        resolve(stdout.trim());
      }
    });

    if (payload !== undefined) {
      proc.stdin.write(JSON.stringify(payload));
    }
    proc.stdin.end();
  });
}

/** TtsProvider backed by a local Kokoro Python process (MVP). */
export class KokoroTtsProvider implements TtsProvider {
  async synthesize(input: TtsInput): Promise<TtsResult> {
    const text = input.text.trim();
    if (!text) throw new Error("[tts:kokoro] empty text");

    const dir = join(tmpdir(), "news-radio-tts");
    await mkdir(dir, { recursive: true });
    const outPath = join(dir, `${randomUUID()}.mp3`);

    try {
      const stdout = await runKokoro(["--synthesize"], {
        text,
        voice: input.voiceId,
        speed: input.speed ?? 1.0,
        out_path: outPath,
      });

      const result = JSON.parse(stdout) as KokoroSynthResult;
      if (!result.ok) {
        throw new Error(`[tts:kokoro] ${result.error ?? "unknown error"}`);
      }

      const mp3Buffer = await readFile(outPath);
      return {
        mp3Buffer,
        durationSeconds: Math.round(result.duration_seconds ?? 0),
        transcript: result.lines ?? [],
      };
    } finally {
      await unlink(outPath).catch(() => {});
    }
  }
}

/**
 * Enumerates the Chinese (zf_/zm_) Kokoro voices the installed build can serve.
 * Used by the startup voice-validation utility (do NOT hardcode voice ids).
 */
export async function listChineseVoices(): Promise<string[]> {
  const stdout = await runKokoro(["--list-voices"]);
  const parsed = JSON.parse(stdout) as { voices?: string[] };
  return parsed.voices ?? [];
}

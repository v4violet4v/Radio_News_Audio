import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "@/lib/config";
import type { TtsInput, TtsProvider, TtsResult } from "./types";

const PY_SCRIPT = fileURLToPath(
  new URL("../../../worker/tts_edge.py", import.meta.url),
);

interface EdgeSynthResult {
  ok: boolean;
  duration_seconds?: number;
  lines?: { start: number; end: number; text: string }[];
  error?: string;
}

/** Runs the Python edge-tts helper, sending `payload` as JSON on stdin. */
function runEdgeTts(args: string[], payload?: unknown): Promise<string> {
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
          `Failed to launch edge-tts (PYTHON_BIN="${config.PYTHON_BIN}"): ${err.message}`,
        ),
      ),
    );
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`edge-tts helper exited with code ${code}.\n${stderr.trim()}`));
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

/** TtsProvider backed by Microsoft edge-tts (handles Chinese-English mixed text). */
export class EdgeTtsProvider implements TtsProvider {
  async synthesize(input: TtsInput): Promise<TtsResult> {
    const text = input.text.trim();
    if (!text) throw new Error("[tts:edge] empty text");

    const dir = join(tmpdir(), "news-radio-tts");
    await mkdir(dir, { recursive: true });
    const outPath = join(dir, `${randomUUID()}.mp3`);

    try {
      const stdout = await runEdgeTts(["--synthesize"], {
        text,
        voice: input.voiceId,
        speed: input.speed ?? 1.0,
        out_path: outPath,
      });

      const result = JSON.parse(stdout) as EdgeSynthResult;
      if (!result.ok) {
        throw new Error(`[tts:edge] ${result.error ?? "unknown error"}`);
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
 * Lists zh-* Neural voices the edge-tts service can serve.
 * Used for voice validation at audio-stage startup.
 */
export async function listEdgeVoices(): Promise<string[]> {
  const stdout = await runEdgeTts(["--list-voices"]);
  const parsed = JSON.parse(stdout) as { voices?: string[] };
  return parsed.voices ?? [];
}

import { config } from "@/lib/config";
import type { TtsProvider } from "./types";
import { KokoroTtsProvider, listChineseVoices } from "./kokoro";
import { EdgeTtsProvider } from "./edge";

export type { TtsProvider, TtsInput, TtsResult, TtsLine } from "./types";
export { listChineseVoices };

// ── Provider singletons ────────────────────────────────────────────────────

let _kokoro: TtsProvider | undefined;
let _edge: TtsProvider | undefined;

function kokoroProvider(): TtsProvider {
  if (!_kokoro) _kokoro = new KokoroTtsProvider();
  return _kokoro;
}

function edgeProvider(): TtsProvider {
  if (!_edge) _edge = new EdgeTtsProvider();
  return _edge;
}

// ── Voice-ID based provider selection ─────────────────────────────────────

/**
 * Microsoft Neural voice IDs follow the pattern "zh-CN-XiaoxiaoNeural".
 * Kokoro IDs are "zm_yunxi" / "zf_xiaoxiao" (zm_/zf_ prefix, no hyphens).
 */
function isEdgeTtsVoice(voiceId: string): boolean {
  return /^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(voiceId);
}

/**
 * Returns the correct TTS provider for a given voiceId.
 * Kokoro is used for Chinese-only voices; edge-tts for Microsoft Neural voices.
 */
export function getProviderForVoice(voiceId: string): TtsProvider {
  return isEdgeTtsVoice(voiceId) ? edgeProvider() : kokoroProvider();
}

/**
 * Returns the default TtsProvider (from TTS_PROVIDER env var).
 * Prefer getProviderForVoice() in the audio stage for per-segment routing.
 */
export function getTtsProvider(): TtsProvider {
  switch (config.TTS_PROVIDER) {
    case "kokoro":
    default:
      return kokoroProvider();
  }
}

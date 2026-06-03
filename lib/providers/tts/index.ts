import { config } from "@/lib/config";
import type { TtsProvider } from "./types";
import { KokoroTtsProvider, listChineseVoices } from "./kokoro";

export type { TtsProvider, TtsInput, TtsResult, TtsLine } from "./types";
export { listChineseVoices };

let cached: TtsProvider | undefined;

/** Returns the TtsProvider chosen by the TTS_PROVIDER env var (memoized). */
export function getTtsProvider(): TtsProvider {
  if (cached) return cached;
  switch (config.TTS_PROVIDER) {
    case "kokoro":
    default:
      cached = new KokoroTtsProvider();
  }
  return cached;
}

export interface TtsInput {
  /** Plain-text Mandarin script to synthesize. */
  text: string;
  /** Kokoro Chinese voice id (zf_ or zm_ prefix). */
  voiceId: string;
  /** Playback speed multiplier (default 1.0). */
  speed?: number;
}

/** One read-along line: spoken sentence with its audio time range (seconds). */
export interface TtsLine {
  start: number;
  end: number;
  text: string;
}

export interface TtsResult {
  /** Encoded MP3 audio. */
  mp3Buffer: Buffer;
  /** Audio duration in seconds. */
  durationSeconds: number;
  /** Per-sentence timing for read-along highlighting (empty if unavailable). */
  transcript: TtsLine[];
}

/**
 * Synthesizes Mandarin speech. Implementations are selected by TTS_PROVIDER.
 * MVP: Kokoro running locally in the worker (shells out to a Python helper).
 */
export interface TtsProvider {
  synthesize(input: TtsInput): Promise<TtsResult>;
}

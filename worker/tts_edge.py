#!/usr/bin/env python3
"""Microsoft edge-tts synthesis helper (called by the Node worker via child_process).

Handles Chinese-English mixed text where Kokoro would drop English words.
Uses the same stdin/stdout JSON contract as tts_kokoro.py.

Modes:
  --synthesize    Read JSON {text, voice, speed, out_path} from stdin, synthesise
                  with edge-tts, write MP3 to out_path, print timing JSON.
  --list-voices   Print {"voices": [...]} — zh-* Neural voices available.

Pattern follows ListenBook/scripts/convert_pickle_to_listenbook.py
(synthesize_edge_tts_sentence + measure_mp3_duration).

Python deps: edge-tts>=7.0, mutagen>=1.47
"""

import asyncio
import io
import json
import os
import re
import sys
import traceback

# Sentence gap between audio clips (same config as Kokoro for consistency).
GAP_SEC = float(os.environ.get("TTS_SENTENCE_GAP_SEC", "0.28"))

# ── English-bracket stripping ─────────────────────────────────────────────────
# Remove parenthetical English glosses before TTS so they are not spoken.
# The caller (tts provider) uses the ORIGINAL sentence for transcript display.
# Example: "埃隆·马斯克 (Elon Musk) 旗下的 SpaceX" → "埃隆·马斯克  旗下的 SpaceX"
#          Edge-tts then speaks "SpaceX" in English naturally.
_ENGLISH_BRACKET_RE = re.compile(r"[（(][^）)]*[A-Za-z]{2,}[^）)]*[）)]")


def _strip_english_brackets(text: str) -> str:
    return _ENGLISH_BRACKET_RE.sub("", text)


# ── Sentence splitting ────────────────────────────────────────────────────────

def _split_sentences(text: str) -> list[str]:
    """Split on Chinese/standard sentence-enders, sub-split long clauses.

    Mirrors tts_kokoro.py's _split_sentences() logic with an extra step from
    ListenBook: long sentences (>80 chars) are sub-split on commas/colons to
    keep utterances natural for edge-tts prosody.
    """
    parts = re.split(r"([。！？!?]+[\s]*)", text)
    sentences: list[str] = []
    for i in range(0, len(parts) - 1, 2):
        sent = (parts[i] + parts[i + 1]).strip()
        if len(sent) >= 3:
            sentences.append(sent)
    if len(parts) % 2 == 1 and parts[-1].strip():
        sentences.append(parts[-1].strip())

    base = sentences or [text]

    # Sub-split long sentences at commas/colons (ListenBook pattern).
    result: list[str] = []
    for sent in base:
        if len(sent) <= 80:
            result.append(sent)
            continue
        sub_parts = re.split(r"(?<=[，,：:])", sent)
        current = ""
        for part in sub_parts:
            candidate = f"{current}{part}".strip()
            if current and len(candidate) > 80:
                result.append(current.strip())
                current = part
            else:
                current = candidate
        if current.strip():
            result.append(current.strip())

    return [s for s in result if s]


# ── Duration measurement ──────────────────────────────────────────────────────

def _measure_mp3_duration(audio_bytes: bytes) -> float | None:
    """Use mutagen to get accurate MP3 duration from raw bytes (fallback)."""
    try:
        from mutagen.mp3 import MP3  # type: ignore
        return float(MP3(io.BytesIO(audio_bytes)).info.length)
    except Exception:
        return None


def _speed_to_rate(speed: float) -> str:
    """Convert float speed (1.0=normal) to edge-tts rate string."""
    pct = int(round((speed - 1.0) * 100))
    return f"+{pct}%" if pct >= 0 else f"{pct}%"


# ── Per-sentence synthesis ────────────────────────────────────────────────────

async def _synthesize_sentence(
    sentence: str,
    voice: str,
    rate: str,
    retries: int = 2,
) -> tuple[bytes, float]:
    """Synthesise one sentence, return (mp3_bytes, duration_seconds).

    Follows ListenBook's synthesize_edge_tts_sentence() pattern:
    - Collect audio chunks from communicate.stream().
    - Track last WordBoundary end (offset+duration in 100-ns ticks → seconds).
    - Measure actual MP3 duration as primary fallback.
    - Retry up to `retries` times on NoAudioReceived.
    """
    import edge_tts
    from edge_tts.exceptions import NoAudioReceived

    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            audio_chunks: list[bytes] = []
            last_boundary_end = 0.0

            communicate = edge_tts.Communicate(text=sentence, voice=voice, rate=rate)
            async for chunk in communicate.stream():
                chunk_type = chunk.get("type")
                if chunk_type == "audio":
                    data = chunk.get("data", b"")
                    if data:
                        audio_chunks.append(data)
                elif chunk_type == "WordBoundary":
                    offset = float(chunk.get("offset", 0)) / 10_000_000
                    dur = float(chunk.get("duration", 0)) / 10_000_000
                    last_boundary_end = max(last_boundary_end, offset + dur)

            mp3_bytes = b"".join(audio_chunks)
            if not mp3_bytes:
                raise NoAudioReceived(
                    "No audio received — verify voice and text are valid."
                )

            measured = _measure_mp3_duration(mp3_bytes)
            duration = measured or last_boundary_end or max(len(sentence) / 5.0, 0.5)
            return mp3_bytes, round(duration, 3)

        except Exception as e:
            last_error = e
            if attempt < retries:
                print(
                    f"[edge-tts] attempt {attempt+1} failed for: {sentence[:50]!r} — {e}",
                    file=sys.stderr,
                )
                await asyncio.sleep(1.0 * (attempt + 1))

    raise last_error or RuntimeError("synthesis failed after retries")


# ── Main synthesis ────────────────────────────────────────────────────────────

async def synthesize() -> None:
    payload = json.loads(sys.stdin.read())
    text = (payload.get("text") or "").strip()
    voice = payload.get("voice", "zh-CN-XiaoxiaoNeural")
    speed = float(payload.get("speed") or 1.0)
    out_path = payload.get("out_path")

    if not text or not out_path:
        print(json.dumps({"ok": False, "error": "missing text or out_path"}))
        return

    rate = _speed_to_rate(speed)

    # Split original text into sentences first — original text is kept for
    # transcript display; bracket-stripped version is sent to edge-tts.
    original_sentences = _split_sentences(text)
    if not original_sentences:
        print(json.dumps({"ok": False, "error": "text produced no sentences"}))
        return

    print(
        f"[edge-tts] {len(text)} chars, {len(original_sentences)} sentences, "
        f"voice={voice}, rate={rate}",
        file=sys.stderr,
    )

    all_audio: list[bytes] = []
    lines: list[dict] = []
    cursor = 0.0

    for s_idx, sentence in enumerate(original_sentences):
        # Strip only English-containing brackets before sending to edge-tts.
        # Standalone English words (SpaceX, NASA…) are kept and spoken naturally.
        tts_text = _strip_english_brackets(sentence)
        if not tts_text.strip():
            continue

        try:
            mp3_bytes, duration = await _synthesize_sentence(tts_text, voice, rate)
        except Exception as e:
            print(f"[edge-tts] sentence {s_idx} failed: {e}", file=sys.stderr)
            continue

        # Transcript uses the ORIGINAL sentence (with brackets) for read-along display.
        lines.append({
            "start": round(cursor, 3),
            "end": round(cursor + duration, 3),
            "text": sentence,
        })
        all_audio.append(mp3_bytes)
        cursor += duration

        if s_idx < len(original_sentences) - 1:
            cursor += GAP_SEC  # inter-sentence gap (not added after the last sentence)

    if not all_audio:
        print(json.dumps({"ok": False, "error": "no audio produced"}))
        return

    # Write concatenated MP3 (raw concat of MP3 frames works for streaming playback).
    with open(out_path, "wb") as f:
        f.write(b"".join(all_audio))

    total_duration = cursor
    print(
        json.dumps(
            {"ok": True, "duration_seconds": total_duration, "lines": lines},
            ensure_ascii=False,
        )
    )


# ── List voices ───────────────────────────────────────────────────────────────

async def list_voices_async() -> None:
    import edge_tts
    all_voices = await edge_tts.list_voices()
    zh_voices = sorted(
        v["ShortName"]
        for v in all_voices
        if v.get("Locale", "").startswith("zh-")
    )
    print(json.dumps({"voices": zh_voices}))


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "--synthesize"
    if mode == "--list-voices":
        asyncio.run(list_voices_async())
    elif mode == "--synthesize":
        asyncio.run(synthesize())
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode: {mode}"}))
        sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"ok": False, "error": "unexpected error — see stderr"}))
        sys.exit(1)

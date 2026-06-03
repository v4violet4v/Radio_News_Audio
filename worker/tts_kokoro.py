#!/usr/bin/env python3
"""Kokoro Mandarin TTS helper (called by the Node worker via child_process).

Modes:
  --synthesize    Read JSON {text, voice, speed, out_path} from stdin, render
                  Mandarin speech with Kokoro's Chinese pipeline, write an MP3
                  to out_path, and print {"ok": true, "duration_seconds": N}.
  --list-voices   Print {"voices": [...]} — the Chinese (zf_/zm_) voice ids the
                  installed Kokoro build can serve (no model download needed).

Python deps (see worker/requirements-audio.txt):
  kokoro, misaki[zh], soundfile, numpy, huggingface_hub
System package:
  espeak-ng   (required by the Chinese G2P pipeline)
"""

import json
import os
import re
import sys
import traceback

SAMPLE_RATE = 24000
REPO_ID = os.environ.get("KOKORO_REPO_ID", "hexgrad/Kokoro-82M")
LANG_CODE = "z"  # Mandarin Chinese

# Safety-net mapping: the LLM prompt already asks it to avoid English, but
# if any slip through, replace them before sending to Kokoro's Chinese G2P
# (which silently skips ASCII letters, causing words to vanish from the audio).
_EN_TO_ZH = {
    "BBC": "英国广播公司",
    "CNN": "美国有线电视新闻网",
    "VOA": "美国之音",
    "RFI": "法国国际广播电台",
    "AP": "美联社",
    "AFP": "法新社",
    "Reuters": "路透社",
    "AI": "人工智能",
    "GDP": "国内生产总值",
    "CPI": "消费者价格指数",
    "WHO": "世界卫生组织",
    "UN": "联合国",
    "NATO": "北约",
    "NASA": "美国航天局",
    "IMF": "国际货币基金组织",
    "WTO": "世贸组织",
    "EU": "欧盟",
    "US": "美国",
    "UK": "英国",
    "iPhone": "苹果手机",
    "ChatGPT": "人工智能聊天工具",
    "Google": "谷歌",
    "Apple": "苹果公司",
    "Tesla": "特斯拉",
    "Microsoft": "微软",
    "Amazon": "亚马逊",
    "Meta": "元宇宙科技",
    "OpenAI": "人工智能公司",
}


_DIGITS_ZH = "零一二三四五六七八九"


def _int_to_zh(n: int) -> str:
    """Convert a non-negative integer to Chinese speech form.

    0-9   → digit name (零一二…九)
    10-99 → tens+ones (十, 二十, 二十三…)
    100+  → digit-by-digit (一二三四…), natural for large numbers in news
    """
    if n == 0:
        return "零"
    if n < 10:
        return _DIGITS_ZH[n]
    if n < 100:
        tens = n // 10
        ones = n % 10
        s = ("" if tens == 1 else _DIGITS_ZH[tens]) + "十"
        if ones:
            s += _DIGITS_ZH[ones]
        return s
    # 100 and above: read each digit individually (safe for any size).
    return "".join(_DIGITS_ZH[int(d)] for d in str(n))


def _num_to_zh(match: re.Match) -> str:
    """Convert a numeric token to Chinese speech form.

    Examples:
        5.9%   → 百分之五点九
        23.7%  → 百分之二十三点七
        17%    → 百分之十七
        5.9    → 五点九
        2026   → 二零二六   (year-like 4-digit numbers read digit by digit)
    """
    s = match.group(0)
    is_pct = s.endswith("%")
    num_str = s.rstrip("%")

    if "." in num_str:
        int_part, dec_part = num_str.split(".", 1)
        zh_int = _int_to_zh(int(int_part)) if int_part else "零"
        zh_dec = "".join(_DIGITS_ZH[int(d)] for d in dec_part if d.isdigit())
        zh_num = f"{zh_int}点{zh_dec}"
    else:
        n = int(num_str)
        # 4-digit numbers that look like years → read digit by digit
        if 1900 <= n <= 2099:
            zh_num = "".join(_DIGITS_ZH[int(d)] for d in str(n))
        else:
            zh_num = _int_to_zh(n)

    return f"百分之{zh_num}" if is_pct else zh_num


def _clean_for_tts(text: str) -> str:
    """Prepare text for Kokoro Chinese TTS.

    1. Convert numbers / percentages to Chinese words (decimals like 5.9%
       produce audio=None in espeak-ng's Mandarin pipeline).
    2. Remove punctuation that confuses espeak-ng Chinese G2P:
       - 「」 Traditional Chinese brackets → remove (espeak-ng skips them)
       - Hyphen between Chinese characters (e.g. 谷歌新闻-财经) → remove
    3. Replace known English terms with Chinese equivalents.
    4. Strip any remaining ASCII letters.
    """
    # Step 1: numeric conversions (order matters: longest pattern first).
    text = re.sub(r"\d+\.\d+%", _num_to_zh, text)   # 5.9%  → 百分之五点九
    text = re.sub(r"\d+%", _num_to_zh, text)          # 17%   → 百分之十七
    text = re.sub(r"\d+\.\d+", _num_to_zh, text)      # 5.9   → 五点九

    # Step 2: problematic punctuation.
    text = text.replace("「", "").replace("」", "")   # Traditional Chinese brackets
    text = text.replace("『", "").replace("』", "")   # Alternative brackets
    # Remove hyphens between Chinese characters (source name artifact, e.g. 谷歌新闻-财经).
    text = re.sub(r"([一-鿿])-+([一-鿿])", r"\1\2", text)

    # Step 3: replace known English terms.
    for en, zh in sorted(_EN_TO_ZH.items(), key=lambda x: -len(x[0])):
        pattern = rf"(?<![A-Za-z]){re.escape(en)}(?![A-Za-z])"
        text = re.sub(pattern, zh, text, flags=re.IGNORECASE)

    # Step 4: strip remaining ASCII letters.
    text = re.sub(r"[A-Za-z]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _split_sentences(text: str) -> list[str]:
    """Split text into individual sentences on Chinese/standard sentence-enders.

    Processing one sentence at a time prevents a single problematic sentence
    from causing Kokoro to silently drop entire following paragraphs.
    """
    # Split on sentence-ending punctuation, keeping the delimiter.
    parts = re.split(r"([。！？!?]+[\s]*)", text)
    sentences: list[str] = []
    for i in range(0, len(parts) - 1, 2):
        sent = (parts[i] + parts[i + 1]).strip()
        if len(sent) >= 3:          # skip fragments shorter than 3 chars
            sentences.append(sent)
    # Any trailing text without a sentence-ender.
    if len(parts) % 2 == 1 and parts[-1].strip():
        sentences.append(parts[-1].strip())
    return sentences or [text]      # fallback: treat whole text as one sentence


def _read_stdin_json():
    raw = sys.stdin.read()
    return json.loads(raw) if raw.strip() else {}


def _to_numpy(audio):
    import numpy as np

    if hasattr(audio, "detach"):  # torch tensor
        return audio.detach().cpu().numpy()
    return np.asarray(audio)


# Silence handling: each sentence is synthesized separately, and Kokoro adds
# leading/trailing silence to each. Concatenating then doubles the silence at
# sentence boundaries, producing an audible gap larger than the natural pause
# inside a sentence. Trim each sentence's edge silence and join with one small
# uniform gap so boundary pauses match intra-sentence pauses.
SILENCE_THRESHOLD = 0.01  # abs amplitude (float32 audio is ~[-1, 1])
EDGE_MARGIN_SEC = 0.04  # keep this much padding so consonants aren't clipped
# Uniform pause between sentences (seconds). Configurable so the cadence can be
# tuned without code changes — set TTS_SENTENCE_GAP_SEC (e.g. 0.35 for a slower,
# more natural pace; 0.15 for snappier).
GAP_SEC = float(os.environ.get("TTS_SENTENCE_GAP_SEC", "0.28"))


def _trim_silence(arr):
    """Trim leading/trailing near-silence from a sentence's audio (with margin)."""
    import numpy as np

    if arr.size == 0:
        return arr
    loud = np.flatnonzero(np.abs(arr) > SILENCE_THRESHOLD)
    if loud.size == 0:
        return arr[:0]  # entirely silent → drop
    margin = int(EDGE_MARGIN_SEC * SAMPLE_RATE)
    start = max(0, int(loud[0]) - margin)
    end = min(arr.size, int(loud[-1]) + 1 + margin)
    return arr[start:end]


def synthesize():
    import numpy as np
    import soundfile as sf
    from kokoro import KPipeline

    payload = _read_stdin_json()
    text = (payload.get("text") or "").strip()
    voice = payload.get("voice")
    speed = float(payload.get("speed") or 1.0)
    out_path = payload.get("out_path")

    if not text or not voice or not out_path:
        print(json.dumps({"ok": False, "error": "missing text/voice/out_path"}))
        return

    text = _clean_for_tts(text)
    if not text:
        print(json.dumps({"ok": False, "error": "text was empty after cleaning"}))
        return

    sentences = _split_sentences(text)
    print(
        f"[tts] {len(text)} chars split into {len(sentences)} sentences",
        file=sys.stderr,
    )

    pipeline = KPipeline(lang_code=LANG_CODE, repo_id=REPO_ID)

    gap = np.zeros(int(GAP_SEC * SAMPLE_RATE), dtype="float32")

    parts = []          # assembled audio pieces (sentence audio + gaps)
    lines = []          # per-sentence read-along timing: {start, end, text}
    cursor_samples = 0  # running sample offset across the assembled audio
    for s_idx, sentence in enumerate(sentences):
        print(f"[tts] sentence {s_idx}: {sentence[:60]}{'...' if len(sentence)>60 else ''}", file=sys.stderr)
        sentence_chunks = []
        try:
            for _g, _p, audio in pipeline(sentence, voice=voice, speed=speed):
                if audio is not None:
                    sentence_chunks.append(_to_numpy(audio))
        except Exception as e:
            print(f"[tts] sentence {s_idx} failed: {e}", file=sys.stderr)

        if not sentence_chunks:
            print(f"[tts] sentence {s_idx}: no audio produced (skipped)", file=sys.stderr)
            continue

        # Trim edge silence so the inter-sentence gap is uniform.
        sentence_audio = _trim_silence(
            np.concatenate(sentence_chunks).astype("float32")
        )
        if sentence_audio.size == 0:
            continue

        if parts:
            parts.append(gap)
            cursor_samples += gap.size

        start = cursor_samples / float(SAMPLE_RATE)
        parts.append(sentence_audio)
        cursor_samples += sentence_audio.size
        end = cursor_samples / float(SAMPLE_RATE)
        lines.append({"start": round(start, 3), "end": round(end, 3), "text": sentence})

    if not parts:
        print(json.dumps({"ok": False, "error": "no audio produced"}))
        return

    full = np.concatenate(parts).astype("float32")

    # Requires libsndfile >= 1.1 with MP3 support (bundled in recent pysoundfile
    # wheels and present on ubuntu-24.04). Falls back with a clear error if not.
    try:
        sf.write(out_path, full, SAMPLE_RATE, format="MP3")
    except Exception as e:  # noqa: BLE001
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"MP3 encoding failed ({e}). Ensure libsndfile has "
                    "MP3 support (libsndfile >= 1.1).",
                }
            )
        )
        return

    duration = len(full) / float(SAMPLE_RATE)
    print(
        json.dumps(
            {"ok": True, "duration_seconds": duration, "lines": lines},
            ensure_ascii=False,
        )
    )


def list_voices():
    """List Chinese voice ids available in the Kokoro repo (zf_*/zm_*)."""
    from huggingface_hub import list_repo_files

    files = list_repo_files(REPO_ID)
    voices = sorted(
        os.path.splitext(os.path.basename(f))[0]
        for f in files
        if f.startswith("voices/")
        and f.endswith(".pt")
        and (os.path.basename(f).startswith("zf_") or os.path.basename(f).startswith("zm_"))
    )
    print(json.dumps({"voices": voices}))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--synthesize"
    if mode == "--list-voices":
        list_voices()
    elif mode == "--synthesize":
        synthesize()
    else:
        print(json.dumps({"ok": False, "error": f"unknown mode {mode}"}))
        sys.exit(2)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)

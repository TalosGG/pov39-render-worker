"""
Offline transcription (port of the archived asr/tr4.py).

  sherpa-onnx Whisper-turbo int8 + Silero VAD, 16 kHz mono float32 PCM on stdin.

Silero VAD splits the stream into speech segments (min silence 0.2 s, max speech 6 s,
as in tr4.py) and each segment is decoded on its own. The start/end of every segment
are the VAD's own sample positions — this model setup has no word timing, so none is
produced. Language: the requested code, or "" to let Whisper detect it; the detected
language of each segment is reported when sherpa-onnx exposes it.

Output (stdout): one JSON object per line — {"segment": {...}} as decoding goes, then
{"done": {...}}. The worker reads it incrementally, so a long file streams through.

  ffmpeg -i in -ac 1 -ar 16000 -f f32le - | python3 transcribe.py MODEL_DIR VAD_MODEL LANG THREADS
"""
import json
import sys
from collections import Counter

import numpy as np
import sherpa_onnx

SR = 16000


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    model_dir, vad_model, language, threads = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    language = "" if language in ("", "auto") else language
    d = model_dir.rstrip("/") + "/"
    rec = sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=d + "turbo-encoder.int8.onnx", decoder=d + "turbo-decoder.int8.onnx",
        tokens=d + "turbo-tokens.txt", language=language, task="transcribe", num_threads=threads)

    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = vad_model
    cfg.silero_vad.min_silence_duration = 0.2
    cfg.silero_vad.max_speech_duration = 6
    cfg.sample_rate = SR
    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=120)

    langs = Counter()
    count = 0
    speech = 0.0

    def drain():
        nonlocal count, speech
        while not vad.empty():
            start, samples = vad.front.start, np.array(vad.front.samples, dtype=np.float32)
            vad.pop()
            stream = rec.create_stream()
            stream.accept_waveform(SR, samples)
            rec.decode_stream(stream)
            result = stream.result
            lang = (getattr(result, "lang", "") or "").strip("<|>") or None
            if lang:
                langs[lang] += 1
            text = (result.text or "").strip()
            seg = {"start": round(start / SR, 3), "end": round((start + len(samples)) / SR, 3), "text": text}
            if lang:
                seg["language"] = lang
            speech += len(samples) / SR
            count += 1
            if text:
                emit({"segment": seg})

    window = 512 * 4  # 2048 float32 samples per read: bounded, streaming
    read = sys.stdin.buffer
    total = 0
    tail = b""
    while True:
        chunk = read.read(window * 4)
        if not chunk:
            break
        chunk = tail + chunk
        usable = len(chunk) - len(chunk) % 4
        tail = chunk[usable:]
        a = np.frombuffer(chunk[:usable], dtype=np.float32)
        total += len(a)
        for i in range(0, len(a), 512):
            vad.accept_waveform(a[i:i + 512])
        drain()
    vad.flush()
    drain()

    detected = langs.most_common(1)[0][0] if langs else None
    emit({"done": {
        "language": language or detected,
        "language_source": "requested" if language else ("detected" if detected else "unknown"),
        "segments": count,
        "speech_seconds": round(speech, 3),
        "audio_seconds": round(total / SR, 3),
        "model": "sherpa-onnx whisper-turbo int8",
        "vad": "silero",
        "word_timestamps": False,
    }})


if __name__ == "__main__":
    main()

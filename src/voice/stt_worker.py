#!/usr/bin/env python3
"""
Speech-to-text worker: faster-whisper on the CPU (int8).

stt-handler.js starts one and keeps it while speech-to-text is in use, so the model
loads once and each recording costs only the transcription. Protocol, one JSON
object per line:

  first stdout line: {"ready": true, "version": "1.2.1"}
                  or {"ready": false, "error": str} (then the process exits)
  stdin  request:    {"id": int, "audio": "<file>", "model": "<model folder>",
                      "language": "en" or null (null: found by itself), "threads": int}
  stdout response:   {"id": int, "text": str, "language": str, "duration": float}
                  or {"id": int, "error": str}

The model is always a folder on disk, never a name, so faster-whisper never
downloads anything; HF_HUB_OFFLINE keeps it off the network too. The audio can be
any format PyAV reads (WAV, WebM/Opus, Ogg, MP3, M4A). decode() reads it here,
not faster-whisper's own decode_audio: that one calls av.open(...,
metadata_errors="ignore"), which newer PyAV no longer takes, so with the PyAV pip
installs today every real recording failed. No ffmpeg program is needed.

decode() can be imported on its own (the Docker build checks it on a real WAV):
the worker loop runs only when this file is run.
"""
import json
import sys

SAMPLE_RATE = 16000


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def decode(path, sample_rate=SAMPLE_RATE):
    """The recording at path as mono float32 samples at sample_rate, as faster-whisper takes them."""
    import av
    import numpy as np

    chunks = []
    resampler = av.AudioResampler(format="s16", layout="mono", rate=sample_rate)
    with av.open(path, mode="r") as container:
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            for out in resampler.resample(frame) or []:
                chunks.append(out.to_ndarray())
    for out in resampler.resample(None) or []:  # what the resampler still holds
        chunks.append(out.to_ndarray())
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks, axis=None).astype(np.float32) / 32768.0


def main():
    try:
        import faster_whisper
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001 - report anything at boot as not-ready
        emit({"ready": False, "error": (type(e).__name__ + ": " + str(e))[:300]})
        sys.exit(1)

    emit({"ready": True, "version": getattr(faster_whisper, "__version__", "unknown")})

    loaded_key = None
    model = None
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            key = (req["model"], int(req.get("threads") or 0))
            if key != loaded_key:
                model = None
                # A folder, so faster-whisper loads it as it is and never looks online.
                model = WhisperModel(key[0], device="cpu", compute_type="int8", cpu_threads=key[1])
                loaded_key = key
            kw = {"beam_size": 1, "best_of": 1, "vad_filter": True}
            if req.get("language"):
                kw["language"] = req["language"]
            segments, info = model.transcribe(decode(req["audio"]), **kw)
            text = " ".join(s.text.strip() for s in segments).strip()
            emit({"id": req.get("id"), "text": text, "language": info.language, "duration": round(info.duration, 1)})
        except Exception as e:  # noqa: BLE001 - a bad request must not kill the worker
            emit({"id": req.get("id"), "error": (type(e).__name__ + ": " + str(e))[:300]})


if __name__ == "__main__":
    main()

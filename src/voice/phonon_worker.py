#!/usr/bin/env python3
"""
Phonon TTS persistent worker (Gradium's Phonon 31M English model, ptts runtime, CPU, q8 weights).

phonon-engine.js starts one of these and keeps it warm, so the model loads once
and each request costs only inference time. Protocol, one JSON object per line:

  stdin  request:  {"text": str, "voice": str, "duration_delta": float, "out": "/tmp/x.wav"}
  stdout response: {"ok": true, "ms": int, "samples": int}
                or {"ok": false, "error": str}
  First stdout line: {"ready": true, "device": "cpu-q8_0", "boot_ms": int, "voices": [...]}
                  or {"ready": false, "error": str} (then the process exits)

Everything is local: the model folder and the voice catalog come from
PHONON_MODEL_DIR and PHONON_CATALOG (set up by phonon-install.js), and
HF_HUB_OFFLINE keeps the runtime off the network.
"""
import json
import os
import sys
import time

t0 = time.time()
try:
    import ptts

    MODEL_DIR = os.environ["PHONON_MODEL_DIR"]
    CATALOG = os.environ.get("PHONON_CATALOG") or None
    threads = int(os.environ.get("PHONON_THREADS") or 4)
    if threads > 0:
        # Sizes a global thread pool, so it must come before the model loads.
        ptts.set_num_threads(threads)
    tts = ptts.TTS(MODEL_DIR, lang="en", quant="q8", voice_catalog=CATALOG)
    _delta = 0.0
    # The first synthesis allocates the buffers: pay for it here, not on the first reply.
    tts.synth("Ready.")
    voices = [v["name"] for v in ptts.catalog_voices(CATALOG)] if CATALOG else list(tts.voices)
    print(json.dumps({"ready": True, "device": f"{tts.device}-{tts.quant}",
                      "boot_ms": int((time.time() - t0) * 1000), "voices": voices}), flush=True)
except Exception as e:  # noqa: BLE001 - report anything at boot as not-ready
    print(json.dumps({"ready": False, "error": str(e)[:300]}), flush=True)
    sys.exit(1)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        delta = float(req.get("duration_delta", 0.0))
        if delta != _delta:
            tts.set_conditions({"duration_delta": delta})
            _delta = delta
        t1 = time.time()
        voice = req.get("voice") or None
        seconds = tts.save(req["out"], req["text"], voice=voice)
        print(json.dumps({"ok": True, "ms": int((time.time() - t1) * 1000),
                          "samples": int(seconds * tts.sample_rate)}), flush=True)
    except Exception as e:  # noqa: BLE001 - a bad request must not kill the worker
        print(json.dumps({"ok": False, "error": str(e)[:300]}), flush=True)

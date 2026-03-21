#!/usr/bin/env python3
"""
Coqui TTS HTTP server for OpusClaw.

Wraps Coqui TTS into a simple HTTP API that the Node.js backend calls.
Runs as a subprocess managed by coqui-engine.js.

Usage:
    python3 coqui-server.py --port 5002 --model tts_models/multilingual/multi-dataset/xtts_v2
"""

import argparse
import io
import os
import sys
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Suppress TTS warnings
os.environ.setdefault("TTS_HOME", os.path.expanduser("~/.local/share/tts"))

tts_instance = None


def get_tts(model_name, models_dir):
    """Lazy-load the TTS model."""
    global tts_instance
    if tts_instance is not None:
        return tts_instance

    print(f"[coqui-server] loading model: {model_name}", file=sys.stderr)
    print(f"[coqui-server] models dir: {models_dir}", file=sys.stderr)

    try:
        from TTS.api import TTS

        # Set model download directory
        if models_dir:
            os.environ["TTS_HOME"] = models_dir

        tts_instance = TTS(model_name=model_name, gpu=False)
        print("[coqui-server] model loaded successfully", file=sys.stderr)
        return tts_instance
    except Exception as e:
        print(f"[coqui-server] failed to load model: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        raise


class TTSHandler(BaseHTTPRequestHandler):
    """HTTP request handler for TTS synthesis."""

    def log_message(self, format, *args):
        """Log to stderr (stdout is reserved for the Node.js parent)."""
        print(f"[coqui-server] {format % args}", file=sys.stderr)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/api/tts-ready":
            self._handle_ready()
        elif path == "/api/tts":
            self._handle_tts(params)
        elif path == "/api/voices":
            self._handle_voices()
        else:
            self.send_error(404, "Not found")

    def _handle_ready(self):
        """Health check — returns 200 if model is loaded."""
        try:
            tts = get_tts(self.server.model_name, self.server.models_dir)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true,"engine":"coqui","model":"' +
                             self.server.model_name.encode() + b'"}')
        except Exception as e:
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(f'{{"ok":false,"error":"{str(e)}"}}'.encode())

    def _handle_tts(self, params):
        """Synthesize text to speech."""
        text = params.get("text", [None])[0]
        if not text:
            self.send_error(400, "Missing 'text' parameter")
            return

        speaker_wav = params.get("speaker_wav", [None])[0]
        language = params.get("language", ["en"])[0]

        try:
            tts = get_tts(self.server.model_name, self.server.models_dir)

            # Synthesize to a WAV buffer
            wav_buffer = io.BytesIO()

            if speaker_wav and os.path.isfile(speaker_wav):
                # XTTS v2 with voice cloning
                tts.tts_to_file(
                    text=text,
                    speaker_wav=speaker_wav,
                    language=language,
                    file_path=wav_buffer,
                )
            else:
                # Default voice (no cloning)
                tts.tts_to_file(
                    text=text,
                    file_path=wav_buffer,
                )

            wav_data = wav_buffer.getvalue()

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav_data)))
            self.end_headers()
            self.wfile.write(wav_data)

        except Exception as e:
            self.log_message("TTS error: %s", str(e))
            traceback.print_exc(file=sys.stderr)
            self.send_error(500, f"TTS synthesis failed: {str(e)}")

    def _handle_voices(self):
        """List cloned voices from the voices directory."""
        import json
        voices = []
        voices_dir = self.server.voices_dir

        if os.path.isdir(voices_dir):
            for f in os.listdir(voices_dir):
                if f.endswith(".wav"):
                    voice_id = f[:-4]
                    voices.append({
                        "id": voice_id,
                        "name": voice_id,
                        "isClone": True,
                    })

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"voices": voices}).encode())


def main():
    parser = argparse.ArgumentParser(description="Coqui TTS HTTP server for OpusClaw")
    parser.add_argument("--port", type=int, default=5002)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--model", default="tts_models/multilingual/multi-dataset/xtts_v2")
    parser.add_argument("--models-dir", default="")
    parser.add_argument("--voices-dir", default="")
    args = parser.parse_args()

    # Pre-load the model
    print(f"[coqui-server] starting on {args.host}:{args.port}", file=sys.stderr)
    try:
        get_tts(args.model, args.models_dir)
    except Exception as e:
        print(f"[coqui-server] WARNING: model pre-load failed: {e}", file=sys.stderr)
        print("[coqui-server] will retry on first request", file=sys.stderr)

    server = HTTPServer((args.host, args.port), TTSHandler)
    server.model_name = args.model
    server.models_dir = args.models_dir
    server.voices_dir = args.voices_dir

    print("[coqui-server] ready", file=sys.stderr)
    # Also print to stdout so the Node.js parent detects readiness
    print("[coqui-server] ready", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[coqui-server] shutting down", file=sys.stderr)
        server.shutdown()


if __name__ == "__main__":
    main()

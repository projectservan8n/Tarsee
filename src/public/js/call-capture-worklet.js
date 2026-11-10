// A call's microphone (js/call.js): hands the page frames of the raw signal, about 43 ms each whatever the device's
// sample rate (2048 samples at 48 kHz, 8192 at 192 kHz). Voice detection and the utterance itself are built from them.
/* global sampleRate, registerProcessor, AudioWorkletProcessor -- the audio worklet's own scope */
class CallCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(Math.max(256, Math.round(sampleRate * 0.0427)));
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("call-capture", CallCapture);

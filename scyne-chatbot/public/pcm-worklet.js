// PCM capture worklet — forwards raw Float32 mono frames to the main thread.
// Sample-rate conversion to 16kHz happens in the main thread (the AudioContext
// sample rate is fixed at construction time and varies by device, so we let
// the main thread resample once it knows the actual rate).

class PcmWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;
    // Post a copy — the underlying buffer is reused by the audio thread.
    const out = new Float32Array(ch0.length);
    out.set(ch0);
    this.port.postMessage(out, [out.buffer]);
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);

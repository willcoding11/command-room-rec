// Export: renders the timeline frame by frame (exact, not realtime) and encodes it in the browser with WebCodecs,
// muxed by the vendored mp4-muxer / webm-muxer (no CDN). Audio is the same mix as the preview, rendered offline.
//   MP4  = H.264 + AAC (Chrome / Edge on Windows); where the browser has no AAC encoder, H.264 + Opus
//   WebM = VP9 (or VP8) + Opus
import * as Mp4 from '../vendor/mp4-muxer.mjs';
import * as Webm from '../vendor/webm-muxer.mjs';

const AVC = ['avc1.640033', 'avc1.64002A', 'avc1.640028', 'avc1.4D402A', 'avc1.42E02A', 'avc1.42001F'];
const VP = ['vp09.00.41.08', 'vp09.00.40.08', 'vp8'];

export async function exportCapabilities() {
  const out = { webcodecs: typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined', avc: null, vp: null, aac: false, opus: false };
  if (!out.webcodecs) return out;
  for (const c of AVC) { try { if ((await VideoEncoder.isConfigSupported({ codec: c, width: 1920, height: 1080, bitrate: 12e6, framerate: 60, avc: { format: 'avc' } })).supported) { out.avc = c; break; } } catch (e) { /* */ } }
  for (const c of VP) { try { if ((await VideoEncoder.isConfigSupported({ codec: c, width: 1920, height: 1080, bitrate: 12e6, framerate: 60 })).supported) { out.vp = c; break; } } catch (e) { /* */ } }
  try { out.aac = (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 })).supported; } catch (e) { /* */ }
  try { out.opus = (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 })).supported; } catch (e) { /* */ }
  return out;
}

// opts: { W, H, fps, format: 'mp4'|'webm', mbps, duration, renderFrame(i, t) -> Promise<canvas>, audio: AudioBuffer|null, onProgress(p, info), signal }
export async function exportVideo(opts) {
  const { W, H, fps, format, duration, renderFrame, audio, onProgress = () => {}, signal } = opts;
  const caps = await exportCapabilities();
  if (!caps.webcodecs) throw new Error('This browser has no WebCodecs encoder. Use Chrome or Edge.');
  const mp4 = format === 'mp4';
  let vcodec = mp4 ? caps.avc : caps.vp;
  if (!vcodec) throw new Error(mp4 ? 'No H.264 encoder in this browser. Try WebM.' : 'No VP9 / VP8 encoder in this browser. Try MP4.');
  // a level that fits the frame size and rate (720p60 needs 3.2, 1080p60 4.2)
  if (mp4) {
    for (const c of AVC) {
      try { if ((await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, bitrate: opts.mbps * 1e6, framerate: fps, avc: { format: 'avc' } })).supported) { vcodec = c; break; } } catch (e) { /* */ }
    }
  }
  const acodec = audio ? (mp4 ? (caps.aac ? 'aac' : caps.opus ? 'opus' : null) : (caps.opus ? 'opus' : null)) : null;
  const target = mp4 ? new Mp4.ArrayBufferTarget() : new Webm.ArrayBufferTarget();
  const muxer = mp4
    ? new Mp4.Muxer({ target, fastStart: 'in-memory', firstTimestampBehavior: 'offset', video: { codec: 'avc', width: W, height: H, frameRate: fps }, audio: acodec ? { codec: acodec, numberOfChannels: 2, sampleRate: 48000 } : undefined })
    : new Webm.Muxer({ target, firstTimestampBehavior: 'offset', video: { codec: vcodec.startsWith('vp8') ? 'V_VP8' : 'V_VP9', width: W, height: H, frameRate: fps }, audio: acodec ? { codec: 'A_OPUS', numberOfChannels: 2, sampleRate: 48000 } : undefined });
  let encErr = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
  venc.configure({ codec: vcodec, width: W, height: H, bitrate: Math.round(opts.mbps * 1e6), framerate: fps, latencyMode: 'quality', ...(mp4 ? { avc: { format: 'avc' } } : {}) });

  // ---- audio first (fast): the whole mix in 0.1 s AudioData chunks
  if (acodec) {
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { encErr = e; } });
    aenc.configure({ codec: acodec === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: acodec === 'aac' ? 192000 : 160000 });
    const L = audio.getChannelData(0), R = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
    const total = Math.min(audio.length, Math.round(duration * 48000)), step = 4800;
    for (let i = 0; i < total; i += step) {
      const n = Math.min(step, total - i), data = new Float32Array(n * 2);
      data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / 48000 * 1e6), data });
      aenc.encode(ad); ad.close();
    }
    await aenc.flush(); aenc.close();
  }

  // ---- video, frame by frame
  const N = Math.max(1, Math.round(duration * fps));
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    if (signal && signal.aborted) { try { venc.close(); } catch (e) { /* */ } throw new DOMException('Export cancelled', 'AbortError'); }
    if (encErr) throw encErr;
    const canvas = await renderFrame(i, i / fps);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    while (venc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2));
    if (i % 5 === 0 || i === N - 1) {
      const el = (performance.now() - t0) / 1000, rate = (i + 1) / el;
      onProgress((i + 1) / N, { frame: i + 1, frames: N, fps: rate, eta: (N - i - 1) / Math.max(rate, 0.01) });
    }
  }
  await venc.flush(); venc.close();
  if (encErr) throw encErr;
  muxer.finalize();
  const type = mp4 ? 'video/mp4' : 'video/webm';
  return { blob: new Blob([target.buffer], { type }), vcodec, acodec, type, ext: mp4 ? 'mp4' : 'webm', secs: (performance.now() - t0) / 1000 };
}

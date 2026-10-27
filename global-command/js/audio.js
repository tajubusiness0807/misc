// Tiny synthesised sound effects (no audio files).
WG.Audio = (function () {
  let ac = null, master = null;
  let muted = false;
  try { muted = localStorage.getItem('gc.muted') === '1'; } catch (e) { /* storage unavailable */ }

  function ensure() {
    if (ac) return ac;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = 0.35;
    master.connect(ac.destination);
    return ac;
  }
  function tone(freq, dur, type, vol, slideTo) {
    if (muted || !ensure()) return;
    const t = ac.currentTime;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(vol || 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, cutoff, slide) {
    if (muted || !ensure()) return;
    const t = ac.currentTime;
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff || 1200, t);
    if (slide) f.frequency.exponentialRampToValueAtTime(slide, t + dur);
    const g = ac.createGain();
    g.gain.value = vol || 0.5;
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t);
  }

  return {
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      try { localStorage.setItem('gc.muted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
      return muted;
    },
    unlock() { if (ensure() && ac.state === 'suspended') ac.resume(); },
    click() { tone(880, 0.05, 'square', 0.08); },
    select() { tone(660, 0.06, 'triangle', 0.15); tone(990, 0.08, 'triangle', 0.1); },
    move() { noise(0.18, 0.12, 500, 200); },
    shot() { noise(0.12, 0.35, 2500, 400); tone(180, 0.1, 'sawtooth', 0.12, 60); },
    boom() { noise(0.6, 0.6, 900, 80); tone(90, 0.5, 'sine', 0.4, 30); },
    bigBoom() { noise(1.8, 0.9, 1400, 40); tone(60, 1.5, 'sine', 0.6, 20); },
    launch() { noise(1.2, 0.25, 600, 3000); tone(120, 1.2, 'sawtooth', 0.08, 900); },
    capture() { tone(523, 0.12, 'triangle', 0.2); setTimeout(() => tone(659, 0.12, 'triangle', 0.2), 110); setTimeout(() => tone(784, 0.25, 'triangle', 0.2), 220); },
    build() { tone(440, 0.08, 'square', 0.08); setTimeout(() => tone(660, 0.1, 'square', 0.08), 70); },
    turn() { tone(392, 0.15, 'triangle', 0.15); setTimeout(() => tone(523, 0.25, 'triangle', 0.15), 140); },
    alarm() { tone(700, 0.18, 'square', 0.1, 500); setTimeout(() => tone(700, 0.18, 'square', 0.1, 500), 220); },
    error() { tone(160, 0.15, 'square', 0.1); },
  };
})();

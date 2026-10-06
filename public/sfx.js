// Sound effects. Files live in /sounds; gain evens out their very different loudness,
// offset skips the silence at the head of a recording so the sound lands on the click.
window.sfx = (() => {
  const SOUNDS = {
    stamp: { gain: .9 },                 // a ruling
    type: { gain: .45, offset: .09 },    // a vote is cast
    slide: { gain: 5, offset: .05 },     // a vote is retracted
    bell: { gain: .5 },                  // a song is submitted
    chime: { gain: 2.6, offset: .03 },   // a member joins
  };

  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('bc.muted') === '1'; } catch {}

  const files = {};     // name -> Promise<ArrayBuffer>, fetched up front
  const buffers = {};   // name -> AudioBuffer, decoded once audio is unlocked
  for (const name of Object.keys(SOUNDS)) {
    files[name] = fetch(`sounds/${name}.mp3`).then((r) => r.arrayBuffer()).catch(() => null);
  }

  // browsers only allow audio after a user gesture
  function unlock() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    for (const name of Object.keys(SOUNDS)) {
      files[name].then((data) => data && ctx.decodeAudioData(data)).then((buf) => { if (buf) buffers[name] = buf; }).catch(() => {});
    }
  }
  addEventListener('pointerdown', unlock, { capture: true });
  addEventListener('keydown', unlock, { capture: true });

  return {
    play(name) {
      const buf = buffers[name];
      if (muted || !buf || ctx.state !== 'running') return;
      const { gain = 1, offset = 0 } = SOUNDS[name];
      const src = ctx.createBufferSource();
      const vol = ctx.createGain();
      src.buffer = buf;
      vol.gain.value = gain;
      src.connect(vol).connect(ctx.destination);
      src.start(0, offset);
    },
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      try { localStorage.setItem('bc.muted', muted ? '1' : '0'); } catch {}
      if (!muted) this.play('type');
      return muted;
    },
  };
})();

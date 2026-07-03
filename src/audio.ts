// black bull - self-contained PROCEDURAL audio. everything is synthesized live
// with the web audio api (oscillators + filtered noise + a synthesized
// convolution reverb) - NO asset files, NO network, license-clear, tiny. it is
// a small adaptive music engine + a layered sfx kit:
//
//  - a lookahead step-sequencer drives layered music: chord-progression pads,
//    a sequenced bass, an arpeggiator, a generative lead, and synth drums.
//  - moods crossfade smoothly: a menu/stable theme, a calm roaming theme, and
//    an intense brawl theme.
//  - the mix is ADAPTIVE: intensity rises during world events and when other
//    bulls are close (a brewing fight), and falls in quiet moments.
//  - sfx are layered (transient + body + tail) and SPATIAL - remote impacts
//    pan + attenuate by direction/distance, so you hear fights around you.
//  - voice-capped + throttled for performance; persisted mute + volume control.
//
// safe to call before start (no-ops until a user gesture creates the context).

const LS_KEY = "blackbull.audio.v1";
const MAX_VOICES = 26; // hard cap on one-shot sources (perf); pads/drones are exempt
const LOW_VOICES = 16; // tighter cap in low-perf mode (fewer simultaneous notes)
const ROOT = 110; // A2 - tonal centre

type Stage = string;
type MusicState = "off" | "menu" | "world";

const semis = (root: number, n: number) => root * Math.pow(2, n / 12);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// chord progressions as root offsets (semitones from A). the world loop keeps
// the SAME roots while intensity morphs the colour (bright major <-> dark minor)
// so build and swarm crossfade musically instead of lurching key.
const WORLD_PROG = [0, 5, 7, -3]; // A - D - E - F#  (a hopeful vi-style loop)
const MENU_PROG = [0, 7, -3, 5]; // A - E - F# - D  (slower, airy)
// scales for the arp/lead - bright (calm) <-> tense (swarm, with a b5)
const BRIGHT_SCALE = [0, 2, 4, 7, 9, 12, 14, 16];
const TENSE_SCALE = [0, 3, 5, 6, 7, 10, 12, 15];

interface Layers {
  padBright: number;
  padDark: number;
  bass: number;
  arp: number;
  lead: number;
  drum: number;
  tension: number;
  horde: number;
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private comp!: DynamicsCompressorNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private reverb!: ConvolverNode;
  private reverbWet!: GainNode;
  private noise!: AudioBuffer;
  private started = false;
  // the earthquake's sustained rumble bed (created while the ground shakes)
  private rumbleBed: {
    o1: OscillatorNode; o2: OscillatorNode; lfo: OscillatorNode;
    gain: GainNode; lp: BiquadFilterNode; lfoGain: GainNode;
  } | null = null;
  // the charge wind-up bed (rises with charge01 while the mouse is held)
  private chargeBed: {
    o: OscillatorNode; n: AudioBufferSourceNode; gain: GainNode; lp: BiquadFilterNode;
  } | null = null;

  private muted = false;
  private volume = 0.7;
  private playing = false;
  private stage: Stage = "landing";

  // adaptive state
  private musicState: MusicState = "off";
  private phaseBase = 0; // base intensity from the active world event
  private threat = 0; // 0..1 nearby-bull pressure (a brewing fight)
  private health = 1; // 0..1 (kept for the mix curve; 1 unless staggered)
  private intensity = 0; // eased 0 calm .. 1 brawl

  // music layer gains
  private padBrightGain!: GainNode;
  private padDarkGain!: GainNode;
  private bassGain!: GainNode;
  private arpGain!: GainNode;
  private leadGain!: GainNode;
  private drumGain!: GainNode;
  private tensionGain!: GainNode;
  private hordeGain!: GainNode;
  private layer: Layers = { padBright: 0, padDark: 0, bass: 0, arp: 0, lead: 0, drum: 0, tension: 0, horde: 0 };

  // sequencer
  private step16 = 0;
  private nextStepTime = 0;
  private schedTimer = 0;
  private lastChordBar = -1;
  private arpIdx = 0;

  private voices = 0;
  private last: Record<string, number> = {};
  private maxVoices = MAX_VOICES;
  private lowPerf = false;
  // a fixed ring of spatial channels, REUSED per spatial sfx so a swarm of enemy
  // events never creates (and leaks) a StereoPanner + gain per hit/death/shot.
  private spatialPool: { g: GainNode; p: StereoPannerNode; s: GainNode }[] = [];
  private spatialIdx = 0;

  private ui?: HTMLElement;
  private iconBtn?: HTMLElement;

  constructor() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const p = JSON.parse(raw) as { muted?: boolean; volume?: number };
        if (typeof p.muted === "boolean") this.muted = p.muted;
        if (typeof p.volume === "number") this.volume = Math.min(1, Math.max(0, p.volume));
      }
    } catch {
      /* defaults */
    }
    if (typeof document !== "undefined") {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => this.buildUI());
      else this.buildUI();
      const boot = () => this.resume();
      window.addEventListener("pointerdown", boot);
      window.addEventListener("keydown", boot);
    }
  }

  // ---- lifecycle ----
  resume() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    } catch {
      this.ctx = null;
      return;
    }
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 2);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;
    this.master = ctx.createGain();
    this.master.connect(this.comp).connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.ambBus = ctx.createGain();
    this.musicBus.gain.value = 0.0; // raised by music state
    this.sfxBus.gain.value = 0.9;
    this.ambBus.gain.value = 0.0;
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.ambBus.connect(this.master);

    // synthesized convolution reverb (a decaying filtered-noise impulse) for a
    // produced sense of space - music + select sfx send a wet level.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(1.1, 2.8); // shorter impulse = cheaper convolution
    this.reverbWet = ctx.createGain();
    this.reverbWet.gain.value = 0.9;
    this.reverb.connect(this.reverbWet).connect(this.master);

    // pre-build the spatial channel ring (reused; never created per event)
    for (let i = 0; i < 12; i++) {
      const g = ctx.createGain();
      const p = ctx.createStereoPanner();
      const s = ctx.createGain();
      s.gain.value = 0;
      g.connect(p).connect(this.sfxBus);
      p.connect(s).connect(this.reverb);
      this.spatialPool.push({ g, p, s });
    }

    this.buildMusic();
    this.buildAmbient();
    this.started = true;
    this.applyVolume();
    this.applyStage();
    // lookahead scheduler: tight note timing without per-note timers
    this.nextStepTime = ctx.currentTime + 0.06;
    this.step16 = 0;
    this.schedTimer = window.setInterval(() => this.schedule(), 25);
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const n = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
        lp += (n - lp) * 0.35; // gentle lowpass so the tail is smooth, not fizzy
        data[i] = lp;
      }
    }
    return buf;
  }

  private applyVolume() {
    if (!this.started) return;
    const g = this.muted ? 0 : this.volume;
    this.master.gain.setTargetAtTime(g, this.ctx!.currentTime, 0.02);
  }

  // ---- public game hooks ----
  setStage(stage: Stage) {
    this.stage = stage;
    this.playing = stage === "playing";
    this.syncCtlVisible();
    if (this.started) this.applyStage();
  }
  private syncCtlVisible() {
    this.ui?.classList.toggle("ac-show", this.stage === "lobby" || this.stage === "playing");
  }
  private applyStage() {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    // landing = silent; lobby/charselect = menu theme; world = adaptive score
    const st: MusicState = this.playing ? "world" : this.stage === "landing" ? "off" : "menu";
    this.musicState = st;
    this.musicBus.gain.setTargetAtTime(st === "off" ? 0.0 : st === "menu" ? 0.42 : 0.5, t, 0.7);
    this.ambBus.gain.setTargetAtTime(this.playing ? 0.5 : st === "menu" ? 0.12 : 0.0, t, 0.9);
    if (!this.playing) {
      this.phaseBase = 0;
      this.threat = 0;
      this.health = 1;
    }
    this.applyLayers();
  }

  // a world event raises the score's floor; quiet play settles back down
  setEventMood(active: boolean) {
    this.phaseBase = active ? 0.7 : 0.16;
  }

  // adaptive inputs from the game (smoothed into the score)
  setThreat(level: number) {
    this.threat = clamp01(level);
  }
  setHealth(hp01: number) {
    this.health = clamp01(hp01);
  }
  // adaptive performance: when fps sags, simplify the graph (fewer voices, no
  // reverb sends, a thinner sequencer); restore it when fps recovers.
  setPerfMode(low: boolean) {
    if (low === this.lowPerf) return;
    this.lowPerf = low;
    this.maxVoices = low ? LOW_VOICES : MAX_VOICES;
    if (this.started) this.reverbWet.gain.setTargetAtTime(low ? 0.3 : 0.9, this.ctx!.currentTime, 0.5);
  }

  // recompute the eased intensity + push every layer gain to its target
  private applyLayers() {
    if (!this.started) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const L = this.layer;
    const I = this.intensity;
    if (this.musicState === "menu") {
      L.padBright = 0.2; L.padDark = 0; L.bass = 0.12; L.arp = 0.11; L.lead = 0.07; L.drum = 0; L.tension = 0; L.horde = 0;
    } else if (this.musicState === "world") {
      const lowHp = 1 - this.health;
      L.padBright = lerp(0.17, 0.05, I);
      L.padDark = lerp(0.02, 0.2, I);
      L.bass = lerp(0.1, 0.32, I);
      L.arp = lerp(0.08, 0.17, I);
      L.lead = lerp(0.05, 0.13, I);
      L.drum = clamp01((I - 0.14) / 0.86) * 0.55;
      L.tension = Math.max(clamp01((I - 0.55) / 0.45) * 0.18, clamp01((lowHp - 0.5) / 0.5) * 0.22);
      L.horde = I * 0.5;
    } else {
      L.padBright = L.padDark = L.bass = L.arp = L.lead = L.drum = L.tension = L.horde = 0;
    }
    const set = (g: GainNode, v: number, tc = 0.4) => g.gain.setTargetAtTime(v, t, tc);
    set(this.padBrightGain, L.padBright, 0.8);
    set(this.padDarkGain, L.padDark, 0.8);
    set(this.bassGain, L.bass);
    set(this.arpGain, L.arp);
    set(this.leadGain, L.lead);
    set(this.drumGain, L.drum, 0.3);
    set(this.tensionGain, L.tension, 0.9);
    set(this.hordeGain, L.horde, 0.8);
  }

  toggleMute() {
    this.muted = !this.muted;
    this.persist();
    this.applyVolume();
    this.syncUI();
  }
  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.volume > 0 && this.muted) this.muted = false;
    this.persist();
    this.applyVolume();
    this.syncUI();
  }
  private persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ muted: this.muted, volume: this.volume }));
    } catch {
      /* ignore */
    }
  }

  // ---- music graph ----
  private buildMusic() {
    const ctx = this.ctx!;
    const mk = (v: number, dest: AudioNode = this.musicBus) => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(dest);
      return g;
    };
    this.padBrightGain = mk(0);
    this.padDarkGain = mk(0);
    this.bassGain = mk(0);
    this.arpGain = mk(0);
    this.leadGain = mk(0);
    this.drumGain = mk(0);
    this.tensionGain = mk(0);
    this.hordeGain = mk(0, this.ambBus);
    // arp + lead get a healthy reverb send; pads a touch
    const send = (from: GainNode, amt: number) => {
      const s = ctx.createGain();
      s.gain.value = amt;
      from.connect(s).connect(this.reverb);
    };
    send(this.padBrightGain, 0.5);
    send(this.padDarkGain, 0.4);
    send(this.arpGain, 0.5);
    send(this.leadGain, 0.6);

    // tension drone: a low detuned sub that swells with danger
    const drone = ctx.createOscillator();
    drone.type = "sawtooth";
    drone.frequency.value = semis(ROOT, -12);
    const drone2 = ctx.createOscillator();
    drone2.type = "sine";
    drone2.frequency.value = semis(ROOT, -12) * 1.005;
    const dlp = ctx.createBiquadFilter();
    dlp.type = "lowpass";
    dlp.frequency.value = 220;
    const wob = ctx.createOscillator();
    wob.frequency.value = 5.5;
    const wobG = ctx.createGain();
    wobG.gain.value = 6;
    wob.connect(wobG).connect(drone.detune);
    drone.connect(dlp);
    drone2.connect(dlp);
    dlp.connect(this.tensionGain);
    drone.start();
    drone2.start();
    wob.start();

    // approaching-horde growl on the ambient bus (swells with intensity/threat)
    const ns = ctx.createBufferSource();
    ns.buffer = this.noise;
    ns.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 130;
    bp.Q.value = 0.7;
    const glfo = ctx.createOscillator();
    glfo.frequency.value = 0.16;
    const glfoG = ctx.createGain();
    glfoG.gain.value = 42;
    glfo.connect(glfoG).connect(bp.frequency);
    ns.connect(bp).connect(this.hordeGain);
    ns.start();
    glfo.start();
  }

  // ---- the sequencer ----
  private currentBpm(): number {
    if (this.musicState === "menu") return 64;
    return lerp(82, 122, this.intensity); // world: build -> swarm
  }
  private schedule() {
    if (!this.started) return;
    const ctx = this.ctx!;
    // ease intensity toward the adaptive target every tick
    const target = this.playing ? clamp01(this.phaseBase + this.threat * 0.5) : 0;
    this.intensity += (target - this.intensity) * 0.06;
    if (Math.abs(target - this.intensity) < 0.003) this.intensity = target;
    this.applyLayers();
    if (this.musicState === "off") {
      this.nextStepTime = ctx.currentTime + 0.1;
      return;
    }
    const look = ctx.currentTime + 0.12;
    let guard = 0;
    while (this.nextStepTime < look && guard++ < 16) {
      this.scheduleStep(this.step16, this.nextStepTime);
      this.nextStepTime += 60 / this.currentBpm() / 4;
      this.step16++;
    }
  }

  private scheduleStep(step: number, time: number) {
    const menu = this.musicState === "menu";
    const prog = menu ? MENU_PROG : WORLD_PROG;
    const barsPerChord = menu ? 2 : 1;
    const bar = Math.floor(step / 16);
    const six = step % 16; // 0..15 within the bar
    const beat = Math.floor(six / 4);
    const chordRoot = prog[Math.floor(bar / barsPerChord) % prog.length];
    const L = this.layer;

    // pad: re-voice on each chord change (bright + dark layers crossfade by gain)
    if (step % (16 * barsPerChord) === 0 && bar !== this.lastChordBar) {
      this.lastChordBar = bar;
      this.padChord(time, chordRoot, barsPerChord * (60 / this.currentBpm()) * 4);
      this.arpIdx = 0;
    }

    // bass: root-driven, denser with intensity
    if (L.bass > 0.001) {
      const playBass = menu ? six === 0 : this.intensity < 0.45 ? six % 8 === 0 || six === 6 : six % 2 === 0;
      if (playBass) {
        const oct = six === 0 ? -24 : -12;
        const n = (six % 8 === 4 && this.intensity > 0.5) ? chordRoot + 7 : chordRoot;
        this.bassNote(time, semis(ROOT, n + oct), this.intensity > 0.5 ? 0.18 : 0.34);
      }
    }

    // arp: cycle chord tones, faster with intensity (sparser under load)
    if (L.arp > 0.001) {
      const rate = this.lowPerf ? 4 : menu ? 2 : this.intensity > 0.55 ? 1 : 2; // 16th vs 8th
      if (six % rate === 0) {
        const tones = this.chordTones(chordRoot, this.intensity);
        const n = tones[this.arpIdx % tones.length];
        this.arpIdx++;
        this.arpNote(time, semis(ROOT, n + 12), this.intensity);
      }
    }

    // lead: a generative melody, sparser/brighter when calm, busier when intense
    // (dropped entirely under load - the busiest, least-essential layer)
    if (L.lead > 0.001 && !this.lowPerf) {
      const strong = six === 0 || six === 8;
      const p = menu ? (strong ? 0.5 : 0.12) : lerp(0.16, 0.42, this.intensity) * (strong ? 1.6 : 1);
      if (Math.random() < p) {
        const scale = this.intensity > 0.55 ? TENSE_SCALE : BRIGHT_SCALE;
        const deg = strong
          ? this.chordTones(chordRoot, this.intensity)[(Math.random() * 3) | 0]
          : chordRoot + scale[(Math.random() * scale.length) | 0];
        this.leadNote(time, semis(ROOT, deg + 24), this.intensity);
      }
    }

    // drums: gate in with intensity (none in the menu / low intensity)
    if (L.drum > 0.001) {
      const v = L.drum / 0.55; // 0..1 drum presence
      if (six === 0 || six === 8 || (this.intensity > 0.6 && six === 10)) this.kick(time, 0.9 * v);
      if (beat === 1 || beat === 3) this.snare(time, 0.7 * v);
      const hatRate = this.lowPerf ? 4 : this.intensity > 0.6 ? 1 : 2;
      if (six % hatRate === 0) this.hat(time, (six % 4 === 0 ? 0.32 : 0.2) * v, !this.lowPerf && this.intensity > 0.75 && six % 8 === 6);
    }
  }

  // chord tones (semitone offsets) - bright major triad <-> dark minor7 by intensity
  private chordTones(root: number, intensity: number): number[] {
    if (intensity > 0.5) return [root, root + 3, root + 7, root + 10]; // min7 colour
    return [root, root + 4, root + 7, root + 11]; // maj7 colour
  }

  // ---- music voices ----
  private padChord(time: number, root: number, dur: number) {
    const ctx = this.ctx!;
    const bright = [root, root + 7, root + 12, root + 16];
    const dark = [root - 12, root, root + 3, root + 10];
    const voice = (offsets: number[], gain: GainNode, type: OscillatorType, cutoff: number) => {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = cutoff;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.5, time + 0.9); // slow swell
      g.gain.setValueAtTime(0.5, time + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, time + dur + 1.4); // overlap the next chord
      lp.connect(g).connect(gain);
      offsets.forEach((n, i) => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = semis(ROOT, n);
        o.detune.value = (i - 1.5) * 4; // a little spread for width
        o.connect(lp);
        o.start(time);
        o.stop(time + dur + 1.6);
      });
    };
    voice(bright, this.padBrightGain, "triangle", 1100);
    voice(dark, this.padDarkGain, "sawtooth", 560);
  }

  private bassNote(time: number, freq: number, dur: number) {
    if (!this.canVoice()) return;
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = freq;
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = freq * 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, time);
    lp.frequency.exponentialRampToValueAtTime(180, time + dur);
    const g = ctx.createGain();
    this.adsr(g, time, 0.34, 0.008, 0.06, 0.7, dur, 0.08);
    o.connect(lp);
    sub.connect(lp);
    lp.connect(g).connect(this.bassGain);
    o.start(time); sub.start(time);
    o.stop(time + dur + 0.1); sub.stop(time + dur + 0.1);
    this.track(o);
  }
  private arpNote(time: number, freq: number, intensity: number) {
    if (!this.canVoice()) return;
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = intensity > 0.55 ? "square" : "triangle";
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(intensity > 0.55 ? 3200 : 4200, time);
    lp.frequency.exponentialRampToValueAtTime(700, time + 0.35);
    const g = ctx.createGain();
    this.env(g, time, intensity > 0.55 ? 0.16 : 0.12, 0.005, 0.32);
    o.connect(lp).connect(g).connect(this.arpGain);
    o.start(time);
    o.stop(time + 0.5);
    this.track(o);
  }
  private leadNote(time: number, freq: number, intensity: number) {
    if (!this.canVoice()) return;
    const ctx = this.ctx!;
    // bell-ish: two detuned sines + a soft attack transient
    const dur = lerp(0.5, 0.26, intensity);
    [1, 2.01].forEach((mult, i) => {
      const o = ctx.createOscillator();
      o.type = i === 0 ? "triangle" : "sine";
      o.frequency.value = freq * mult;
      const g = ctx.createGain();
      this.env(g, time, i === 0 ? 0.16 : 0.06, 0.006, dur);
      o.connect(g).connect(this.leadGain);
      o.start(time);
      o.stop(time + dur + 0.1);
      if (i === 0) this.track(o);
    });
  }
  // synth drums
  private kick(time: number, gain: number) {
    if (!this.canVoice()) return;
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(150, time);
    o.frequency.exponentialRampToValueAtTime(45, time + 0.12);
    const g = ctx.createGain();
    this.env(g, time, gain, 0.004, 0.18);
    o.connect(g).connect(this.drumGain);
    o.start(time);
    o.stop(time + 0.24);
    this.track(o);
  }
  private snare(time: number, gain: number) {
    if (!this.canVoice()) return;
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1900;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    this.env(g, time, gain, 0.002, 0.16);
    s.connect(bp).connect(g).connect(this.drumGain);
    // a little tonal body
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(330, time);
    o.frequency.exponentialRampToValueAtTime(180, time + 0.08);
    const og = ctx.createGain();
    this.env(og, time, gain * 0.4, 0.002, 0.09);
    o.connect(og).connect(this.drumGain);
    s.start(time); s.stop(time + 0.2);
    o.start(time); o.stop(time + 0.12);
    this.track(s);
  }
  private hat(time: number, gain: number, open: boolean) {
    if (!this.canVoice()) return;
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7500;
    const g = ctx.createGain();
    this.env(g, time, gain, 0.001, open ? 0.18 : 0.05);
    s.connect(hp).connect(g).connect(this.drumGain);
    s.start(time);
    s.stop(time + (open ? 0.22 : 0.08));
    this.track(s);
  }

  // ---- ambient bed (wind + water) ----
  private buildAmbient() {
    const ctx = this.ctx!;
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = "bandpass";
    wf.frequency.value = 420;
    wf.Q.value = 0.6;
    const wg = ctx.createGain();
    wg.gain.value = 0.22;
    const wlfo = ctx.createOscillator();
    wlfo.frequency.value = 0.07;
    const wlfoG = ctx.createGain();
    wlfoG.gain.value = 0.12;
    wlfo.connect(wlfoG).connect(wg.gain);
    wind.connect(wf).connect(wg).connect(this.ambBus);
    wind.start();
    wlfo.start();
    const water = ctx.createBufferSource();
    water.buffer = this.noise;
    water.loop = true;
    const wtf = ctx.createBiquadFilter();
    wtf.type = "highpass";
    wtf.frequency.value = 5000;
    const wtg = ctx.createGain();
    wtg.gain.value = 0.05;
    const tlfo = ctx.createOscillator();
    tlfo.frequency.value = 0.5;
    const tlfoG = ctx.createGain();
    tlfoG.gain.value = 0.03;
    tlfo.connect(tlfoG).connect(wtg.gain);
    water.connect(wtf).connect(wtg).connect(this.ambBus);
    water.start();
    tlfo.start();
  }

  // ====================================================================
  // one-shot sfx - each LAYERED (transient + body + tail) for weight, and
  // optionally SPATIAL (pan -1..1 left/right, gain attenuation by distance).
  // ====================================================================

  // one hoof-beat of the gallop; alternate `heavy` for the four-beat feel.
  // called by main on the gallop cadence, louder with speed + momentum.
  gallopStep(gain = 1, heavy = false) {
    if (!this.ready("hoof", 60)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.note(t, "sine", heavy ? 95 : 120, 40, 0.09, 0.3 * gain, this.sfxBus);
    this.noiseBurst(t, 0.03, 0.14 * gain, "lowpass", 700, 250, 0.8, this.sfxBus);
  }

  // the charge wind-up: a rising tension bed while the mouse is held.
  // chargeSet drives pitch/level from charge01; chargeOff tears it down.
  chargeSet(v: number) {
    if (!this.ctx || !this.started) return;
    const ctx = this.ctx;
    if (!this.chargeBed) {
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      gain.connect(this.sfxBus);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 300;
      lp.connect(gain);
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = 46;
      o.connect(lp);
      const n = ctx.createBufferSource();
      n.buffer = this.noise;
      n.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 240;
      bp.Q.value = 1.2;
      n.connect(bp).connect(lp);
      o.start();
      n.start();
      this.chargeBed = { o, n, gain, lp };
    }
    const t = this.ctx.currentTime;
    this.chargeBed.gain.gain.setTargetAtTime(0.05 + v * 0.2, t, 0.06);
    this.chargeBed.o.frequency.setTargetAtTime(46 + v * 40, t, 0.08);
    this.chargeBed.lp.frequency.setTargetAtTime(300 + v * 900, t, 0.08);
  }
  chargeOff() {
    if (!this.ctx || !this.chargeBed) return;
    const b = this.chargeBed;
    this.chargeBed = null;
    const t = this.ctx.currentTime;
    b.gain.gain.cancelScheduledValues(t);
    b.gain.gain.setTargetAtTime(0.0001, t, 0.05);
    b.o.stop(t + 0.3);
    b.n.stop(t + 0.3);
  }

  // the release: a heavy launch - snort + hoof slam + a rushing body
  launch(charge01: number) {
    if (!this.ready("launch", 120)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const p = 0.5 + charge01 * 0.8;
    this.noiseBurst(t, 0.05, 0.5 * p, "bandpass", 900, 300, 1.4, this.sfxBus); // snort
    this.note(t, "sine", 110, 42, 0.2, 0.5 * p, this.sfxBus); // hoof slam
    this.noiseBurst(t + 0.03, 0.4 + charge01 * 0.25, 0.3 * p, "lowpass", 1400, 320, 0.7, this.sfxBus); // the rush
    if (charge01 > 0.8) this.note(t + 0.02, "sawtooth", 60, 38, 0.5, 0.3, this.reverb); // stampede weight
  }

  // a landed ram - the money sound. power 0..1; spatial for remote hits.
  impact(power = 1, pan = 0, gain = 1) {
    if (!this.ready("impact", 45)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const dest = this.spatial(pan, gain, 0.28);
    this.noiseBurst(t, 0.04, 0.7 * power + 0.2, "highpass", 2400, undefined, 1, dest); // crack
    this.note(t, "sine", 130, 30, 0.28, 0.55 * power + 0.15, dest); // deep body slam
    this.noiseBurst(t + 0.01, 0.2, 0.5 * power, "lowpass", 1300, 200, 0.9, dest); // dust whump
    if (power > 0.6) {
      this.note(t + 0.02, "sine", 62, 40, 0.5, 0.4, this.reverb); // stampede-grade sub tail
      this.noiseBurst(t + 0.05, 0.5, 0.2, "lowpass", 900, 160, 0.5, this.reverb);
    }
  }

  // running into a wall / a bounce off terrain
  wallThud(speed01 = 0.5) {
    if (!this.ready("wall", 90)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.note(t, "sine", 100, 34, 0.18, 0.5 * speed01 + 0.1, this.sfxBus);
    this.noiseBurst(t, 0.08, 0.3 * speed01, "lowpass", 800, 220, 0.8, this.sfxBus);
  }

  // a bull roar: a formant-ish bellow. deep=true is the unlockable big one.
  roar(pan = 0, gain = 1, deep = false) {
    if (!this.ready("roar", 350)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const dest = this.spatial(pan, gain, 0.3);
    const f0 = deep ? 70 : 95;
    this.note(t, "sawtooth", f0, f0 * 0.6, deep ? 1.1 : 0.7, 0.4, dest);
    this.note(t + 0.04, "sawtooth", f0 * 2.02, f0 * 1.1, deep ? 0.9 : 0.55, 0.2, dest);
    this.noiseBurst(t, deep ? 0.9 : 0.55, 0.22, "bandpass", 420, 180, 1.6, dest); // breath/rasp
    this.note(t + 0.02, "sine", f0 * 0.5, f0 * 0.35, deep ? 1.2 : 0.8, 0.32, this.reverb);
  }
  // a short snort (whiff recovery, idle)
  snort() {
    if (!this.ready("snort", 200)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.noiseBurst(t, 0.12, 0.3, "bandpass", 760, 260, 1.6, this.sfxBus);
    this.noiseBurst(t + 0.14, 0.08, 0.2, "bandpass", 700, 300, 1.6, this.sfxBus);
  }

  // you got wiped out - a downward collapse
  wipeout() {
    if (!this.ready("wipe", 300)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.note(t, "sawtooth", 220, 40, 0.7, 0.4, this.sfxBus);
    this.note(t, "sine", 110, 30, 0.9, 0.5, this.sfxBus);
    this.noiseBurst(t, 0.4, 0.4, "lowpass", 1400, 180, 0.8, this.sfxBus);
    this.note(t + 0.1, "sine", 60, 36, 0.8, 0.25, this.reverb);
  }

  // event incoming - urgent horn-like warning
  eventWarn() {
    if (!this.ready("ewarn", 800)) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const t = t0 + i * 0.34;
      this.note(t, "sawtooth", 174, 174, 0.28, 0.3, this.sfxBus, 6);
      this.note(t, "sawtooth", 174, 174, 0.28, 0.3, this.sfxBus, -6);
      this.note(t, "sine", 87, 87, 0.3, 0.25, this.sfxBus);
    }
    this.note(t0 + 0.7, "sawtooth", 174, 232, 0.5, 0.3, this.reverb);
  }

  // thunder: dist in world units attenuates + delays the crack naturally
  thunder(dist: number) {
    if (!this.ready("thunder", 250)) return;
    const ctx = this.ctx!;
    const g = Math.max(0.1, 1 - dist / 260);
    const t = ctx.currentTime + Math.min(0.5, dist * 0.002);
    this.noiseBurst(t, 0.06, 0.8 * g, "highpass", 3000, undefined, 1, this.sfxBus); // crack
    this.noiseBurst(t + 0.04, 0.9, 0.5 * g, "lowpass", 900, 90, 0.6, this.sfxBus); // roll
    this.note(t + 0.02, "sine", 55, 30, 1.1, 0.4 * g, this.reverb);
  }
  // a meteor impact heard across the map
  meteorBoom(dist: number) {
    if (!this.ready("meteor", 140)) return;
    const ctx = this.ctx!;
    const g = Math.max(0.08, 1 - dist / 300);
    const t = ctx.currentTime;
    this.note(t, "sine", 90, 24, 0.7, 0.55 * g, this.sfxBus);
    this.noiseBurst(t, 0.3, 0.5 * g, "lowpass", 1100, 140, 0.8, this.sfxBus);
    this.noiseBurst(t + 0.05, 0.8, 0.25 * g, "lowpass", 700, 100, 0.5, this.reverb);
  }

  // the earthquake's sustained rumble bed
  rumble(on: boolean) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (on) {
      if (this.rumbleBed) return;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 1.2);
      gain.connect(this.ambBus);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 160;
      lp.Q.value = 3;
      lp.connect(gain);
      const o1 = ctx.createOscillator(); o1.type = "sawtooth"; o1.frequency.value = 34; o1.connect(lp);
      const o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = 47; o2.connect(lp);
      const lfo = ctx.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 1.6;
      const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.09;
      lfo.connect(lfoGain); lfoGain.connect(gain.gain);
      o1.start(); o2.start(); lfo.start();
      this.rumbleBed = { o1, o2, lfo, gain, lp, lfoGain };
    } else if (this.rumbleBed) {
      const b = this.rumbleBed;
      this.rumbleBed = null;
      const t = ctx.currentTime;
      b.gain.gain.cancelScheduledValues(t);
      b.gain.gain.linearRampToValueAtTime(0.0001, t + 0.8);
      b.o1.stop(t + 0.9); b.o2.stop(t + 0.9); b.lfo.stop(t + 0.9);
    }
  }

  // a golden bull claimed - bright rising sparkle
  golden() {
    if (!this.ready("golden", 200)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.note(t, "triangle", 880, 1320, 0.12, 0.2, this.sfxBus);
    this.note(t + 0.06, "sine", 1320, 1980, 0.16, 0.16, this.sfxBus);
    this.note(t + 0.1, "sine", 1760, 2640, 0.3, 0.14, this.reverb);
    this.note(t, "sine", 440, 660, 0.3, 0.12, this.sfxBus);
  }
  // a cosmetic unlocked - an ascending fanfare
  unlock() {
    if (!this.ready("unlock", 400)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const notes = [392, 523, 659, 880, 1047];
    notes.forEach((f, i) => this.note(t + i * 0.07, "triangle", f, f, 0.22, 0.22, this.sfxBus));
    this.note(t + 0.34, "sine", 1047, 2093, 0.6, 0.18, this.reverb);
    this.note(t, "sine", 196, 392, 0.7, 0.13, this.sfxBus);
  }
  // momentum tier up - a short rising motif
  tierUp() {
    if (!this.ready("tier", 400)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const notes = [523, 659, 784];
    notes.forEach((f, i) => this.note(t + i * 0.08, "triangle", f, f, 0.18, 0.2, this.sfxBus));
    this.note(t, "sine", 262, 392, 0.5, 0.12, this.sfxBus);
  }

  // a soft ui blip
  blip(up = true) {
    if (!this.ready("blip", 50)) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.note(t, "triangle", up ? 660 : 520, up ? 990 : 390, 0.08, 0.16, this.sfxBus);
  }

  // ---- low-level voices ----
  // a tone with a glide + filter-free env to any destination
  private note(t: number, type: OscillatorType, f0: number, f1: number, dur: number, peak: number, dest: AudioNode, detune = 0) {
    if (!this.canVoice()) return;
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.detune.value = detune;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, peak, Math.min(0.01, dur * 0.25), dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    this.track(o);
  }
  private noiseBurst(t: number, dur: number, peak: number, type: BiquadFilterType, f0: number, f1: number | undefined, q: number, dest: AudioNode) {
    if (!this.canVoice()) return;
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t);
    if (f1) filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, peak, Math.min(0.008, dur * 0.2), dur);
    s.connect(filt).connect(g).connect(dest);
    s.start(t);
    s.stop(t + dur + 0.05);
    this.track(s);
  }
  // a spatial destination from the reused pool: set this channel's pan + distance
  // gain + reverb send and hand back its input. no per-event node creation, so a
  // dense swarm of enemy events stays flat-cost and never leaks panners.
  private spatial(pan: number, gain: number, reverbSend = 0): AudioNode {
    if (!this.spatialPool.length) return this.sfxBus;
    const slot = this.spatialPool[this.spatialIdx];
    this.spatialIdx = (this.spatialIdx + 1) % this.spatialPool.length;
    const t = this.ctx!.currentTime;
    slot.g.gain.setValueAtTime(Math.max(0.05, Math.min(1, gain)), t);
    slot.p.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), t);
    slot.s.gain.setValueAtTime(this.lowPerf ? 0 : reverbSend, t); // drop reverb sends under load
    return slot.g;
  }
  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  private adsr(g: GainNode, t: number, peak: number, a: number, d: number, s: number, dur: number, r: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * s), t + a + d);
    g.gain.setValueAtTime(Math.max(0.0002, peak * s), t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + r);
  }
  private track(node: AudioScheduledSourceNode) {
    this.voices++;
    node.onended = () => {
      this.voices = Math.max(0, this.voices - 1);
    };
  }
  private canVoice() {
    return this.started && this.voices < this.maxVoices;
  }
  private ready(key: string, minMs: number) {
    if (!this.started || this.muted) return false;
    const now = performance.now();
    if (now - (this.last[key] ?? 0) < minMs) return false;
    this.last[key] = now;
    return true;
  }

  // ---- mute / volume ui (built imperatively, scoped style) ----
  private buildUI() {
    if (this.ui || typeof document === "undefined") return;
    if (!document.getElementById("blackbull-audio-style")) {
      const st = document.createElement("style");
      st.id = "blackbull-audio-style";
      st.textContent = `
#audio-ctl{position:fixed;top:14px;right:14px;z-index:16;display:none;align-items:center;gap:8px;
  padding:6px 10px;border-radius:11px;background:var(--hud-bg,rgba(14,17,22,.74));
  border:1px solid rgba(87,226,255,.22);box-shadow:0 7px 22px -9px rgba(0,0,0,.6);
  backdrop-filter:blur(8px);font-family:var(--mono,monospace);user-select:none}
#audio-ctl.ac-show{display:flex}
#audio-ctl button{background:none;border:none;cursor:pointer;color:var(--bio,#57e2ff);
  display:grid;place-items:center;padding:2px;line-height:0}
#audio-ctl button svg{width:18px;height:18px;display:block}
#audio-ctl.muted button{color:var(--muted,#8b97a8)}
#audio-vol{-webkit-appearance:none;appearance:none;width:74px;height:4px;border-radius:3px;
  background:rgba(231,235,242,.18);outline:none;cursor:pointer}
#audio-vol::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;
  background:var(--bio,#57e2ff);cursor:pointer;box-shadow:0 0 7px rgba(87,226,255,.7)}
#audio-vol::-moz-range-thumb{width:12px;height:12px;border:none;border-radius:50%;background:var(--bio,#57e2ff)}`;
      document.head.appendChild(st);
    }
    const wrap = document.createElement("div");
    wrap.id = "audio-ctl";
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "mute");
    btn.title = "mute / unmute audio";
    const slider = document.createElement("input");
    slider.id = "audio-vol";
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(this.volume * 100));
    slider.title = "volume";
    btn.addEventListener("click", () => {
      this.resume();
      this.toggleMute();
    });
    slider.addEventListener("input", () => {
      this.resume();
      this.setVolume(Number(slider.value) / 100);
    });
    wrap.appendChild(btn);
    wrap.appendChild(slider);
    (document.body ?? document.documentElement).appendChild(wrap);
    this.ui = wrap;
    this.iconBtn = btn;
    this.syncCtlVisible();
    this.syncUI();
  }
  private syncUI() {
    if (!this.ui || !this.iconBtn) return;
    const on = !this.muted && this.volume > 0;
    this.ui.classList.toggle("muted", !on);
    this.iconBtn.innerHTML = on
      ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8a4 4 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M18.5 5.5a7 7 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`;
    const slider = this.ui.querySelector("#audio-vol") as HTMLInputElement | null;
    if (slider) slider.value = String(Math.round(this.volume * 100));
  }
}

export const audio = new AudioEngine();

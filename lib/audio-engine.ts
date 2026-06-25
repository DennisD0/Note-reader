import * as Tone from "tone";
import { DEFAULT_BPM, type ScorePart } from "./musicxml-parts";

const SALAMANDER_BASE_URL = "https://tonejs.github.io/audio/salamander/";

/** Standard Salamander grand piano sample map used by Tone.js examples. */
const PIANO_SAMPLE_URLS: Record<string, string> = {
  A0: "A0.mp3",
  C1: "C1.mp3",
  "D#1": "Ds1.mp3",
  "F#1": "Fs1.mp3",
  A1: "A1.mp3",
  C2: "C2.mp3",
  "D#2": "Ds2.mp3",
  "F#2": "Fs2.mp3",
  A2: "A2.mp3",
  C3: "C3.mp3",
  "D#3": "Ds3.mp3",
  "F#3": "Fs3.mp3",
  A3: "A3.mp3",
  C4: "C4.mp3",
  "D#4": "Ds4.mp3",
  "F#4": "Fs4.mp3",
  A4: "A4.mp3",
  C5: "C5.mp3",
  "D#5": "Ds5.mp3",
  "F#5": "Fs5.mp3",
  A5: "A5.mp3",
  C6: "C6.mp3",
  "D#6": "Ds6.mp3",
  "F#6": "Fs6.mp3",
  A6: "A6.mp3",
  C7: "C7.mp3",
  "D#7": "Ds7.mp3",
  "F#7": "Fs7.mp3",
  A7: "A7.mp3",
  C8: "C8.mp3",
};

interface PartEvent {
  time: string; // Tone.js tick notation e.g. "192i" — plain numbers are seconds, not ticks
  onsetTicks: number; // numeric onset, for duration math (time is a string)
  pitch: string;
  durationTicks: number;
}

interface EngineEntry {
  sampler: Tone.Sampler;
  channel: Tone.Channel;
  part: Tone.Part<PartEvent>;
  events: PartEvent[];
}

/**
 * Owns one Tone.Sampler (piano) + Tone.Channel (mute/solo/volume) +
 * Tone.Part (scheduled notes) per score part, all routed to the
 * destination. Note onsets are scheduled in Transport ticks, so changing
 * the Transport bpm re-paces playback without re-scheduling anything.
 */
export class AudioEngine {
  private entries = new Map<string, EngineEntry>();
  /** Live semitone transpose applied to every scheduled note (12 = +1 octave). */
  private transpose = 0;

  /**
   * (Re)builds the playback graph for the given parts. Resolves once all
   * piano samples have loaded.
   */
  async build(
    scoreParts: ScorePart[],
    onLoadProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    this.dispose();

    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel();
    transport.bpm.value = DEFAULT_BPM;

    let loaded = 0;
    const total = scoreParts.length;
    onLoadProgress?.(0, total);

    for (const part of scoreParts) {
      const channel = new Tone.Channel().toDestination();
      const sampler = new Tone.Sampler({
        urls: PIANO_SAMPLE_URLS,
        baseUrl: SALAMANDER_BASE_URL,
        release: 1,
        // onload feeds the progress bar, but is NOT what we wait on: several
        // samplers share the same (often cached) sample URLs, and one sampler's
        // onload can fail to fire on a cache hit after a dispose — which used to
        // hang song-switching at "n-1/n". We wait on Tone.loaded() instead.
        onload: () => {
          loaded += 1;
          onLoadProgress?.(loaded, total);
        },
      }).connect(channel);

      const events: PartEvent[] = part.notes.map((note) => ({
        time: `${note.onsetTicks}i`,
        onsetTicks: note.onsetTicks,
        pitch: note.pitch,
        durationTicks: note.durationTicks,
      }));

      const tonePart = new Tone.Part<PartEvent>((time, value) => {
        const durationSec = Tone.Ticks(value.durationTicks).toSeconds();
        // Read transpose live so the octave control takes effect mid-play
        // without re-scheduling the part.
        const pitch =
          this.transpose === 0
            ? value.pitch
            : Tone.Frequency(value.pitch).transpose(this.transpose).toNote();
        sampler.triggerAttackRelease(pitch, durationSec, time);
      }, events);
      tonePart.start(0);

      this.entries.set(part.id, { sampler, channel, part: tonePart, events });
    }

    // Resolve when every sample buffer has loaded, with a safety timeout so a
    // stuck/duplicate load can never hang the player indefinitely.
    await Promise.race([
      Tone.loaded(),
      new Promise<void>((resolve) => setTimeout(resolve, 20000)),
    ]);
    onLoadProgress?.(total, total);
  }

  /** Shift every note by `semitones` (e.g. 12 = up one octave). Live. */
  setTranspose(semitones: number): void {
    this.transpose = semitones;
  }

  getTranspose(): number {
    return this.transpose;
  }

  setMute(id: string, mute: boolean): void {
    const entry = this.entries.get(id);
    if (entry) entry.channel.mute = mute;
  }

  setSolo(id: string, solo: boolean): void {
    const entry = this.entries.get(id);
    if (entry) entry.channel.solo = solo;
  }

  /** Set a part's volume in decibels (0 = unity, negative = quieter). */
  setVolume(id: string, volumeDb: number): void {
    const entry = this.entries.get(id);
    if (entry) entry.channel.volume.value = volumeDb;
  }

  setBpm(bpm: number): void {
    Tone.getTransport().bpm.value = bpm;
  }

  getBpm(): number {
    return Tone.getTransport().bpm.value;
  }

  async play(): Promise<void> {
    await Tone.start();
    Tone.getTransport().start();
  }

  pause(): void {
    Tone.getTransport().pause();
  }

  stop(): void {
    const transport = Tone.getTransport();
    transport.stop();
    transport.position = 0;
  }

  get isPlaying(): boolean {
    return Tone.getTransport().state === "started";
  }

  /** Total length of the loaded score, in Transport ticks (bpm-independent). */
  getDurationTicks(): number {
    let maxTicks = 0;
    for (const entry of this.entries.values()) {
      for (const event of entry.events) {
        maxTicks = Math.max(maxTicks, event.onsetTicks + event.durationTicks);
      }
    }
    return maxTicks;
  }

  /** Total duration of the loaded score in seconds, at the current bpm. */
  getDurationSeconds(): number {
    return Tone.Ticks(this.getDurationTicks()).toSeconds();
  }

  getPositionSeconds(): number {
    return Tone.getTransport().seconds;
  }

  /** Current playback position in Transport ticks (for cursor sync). */
  getPositionTicks(): number {
    return Tone.getTransport().ticks;
  }

  /** Jump to a position in seconds (clamped to the score length). */
  seek(seconds: number): void {
    const clamped = Math.max(0, Math.min(seconds, this.getDurationSeconds()));
    Tone.getTransport().seconds = clamped;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.part.dispose();
      entry.sampler.dispose();
      entry.channel.dispose();
    }
    this.entries.clear();
  }
}

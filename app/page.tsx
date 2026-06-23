"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_BPM,
  TICKS_PER_WHOLE_NOTE,
  type PartRole,
  type ScorePart,
} from "@/lib/musicxml-parts";
import type { AudioEngine } from "@/lib/audio-engine";
import type { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

type Stage = "idle" | "uploading" | "processing" | "loading" | "ready" | "error";
type VoiceFilter = "all" | "choir" | "piano" | "soprano" | "alto" | "tenor" | "bass";

const VOCAL_ROLES: PartRole[] = ["soprano", "alto", "tenor", "bass"];

/** Pre-processed demo score so the app can be tried instantly, no OMR wait. */
const DEMO_URL = "/presets/remember-me.mxl";
const DEMO_NAME = "기억하라 (Remember Me) — demo";

function shouldMute(role: PartRole, filter: VoiceFilter): boolean {
  if (filter === "all") return false;
  if (filter === "choir") return role === "piano" || role === "other";
  if (filter === "piano") return role !== "piano";
  return (role as string) !== (filter as string);
}

const FILTER_LABELS: Record<VoiceFilter, string> = {
  all: "All",
  choir: "Choir",
  piano: "Piano",
  soprano: "Soprano",
  alto: "Alto",
  tenor: "Tenor",
  bass: "Bass",
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const [parts, setParts] = useState<ScorePart[]>([]);
  const [voiceFilter, setVoiceFilter] = useState<VoiceFilter>("all");
  const [octave, setOctave] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(DEFAULT_BPM);
  const [positionSec, setPositionSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const engineRef = useRef<AudioEngine | null>(null);

  const stepOnsetsRef = useRef<number[]>([]);
  const stepIndexRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const cancelLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelLoop();
      engineRef.current?.dispose();
    };
  }, [cancelLoop]);

  const syncCursor = useCallback((posTicks: number) => {
    const osmd = osmdRef.current;
    const onsets = stepOnsetsRef.current;
    if (!osmd || onsets.length === 0) return;

    let target = 0;
    while (target + 1 < onsets.length && onsets[target + 1] <= posTicks) {
      target += 1;
    }
    if (posTicks < onsets[0]) target = 0;

    if (target < stepIndexRef.current) {
      osmd.cursor.reset();
      stepIndexRef.current = 0;
    }
    while (stepIndexRef.current < target) {
      osmd.cursor.next();
      stepIndexRef.current += 1;
    }
    osmd.cursor.update();
  }, []);

  const tick = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const posSec = engine.getPositionSeconds();
    const dur = engine.getDurationSeconds();
    setPositionSec(posSec);
    syncCursor(engine.getPositionTicks());

    if (posSec >= dur && dur > 0) {
      engine.stop();
      setIsPlaying(false);
      setPositionSec(0);
      stepIndexRef.current = 0;
      osmdRef.current?.cursor.reset();
      osmdRef.current?.cursor.update();
      cancelLoop();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  }, [syncCursor, cancelLoop]);

  const loadScore = useCallback(async (musicXmlUrl: string) => {
    setStage("loading");
    setStatusMsg("Rendering score...");
    setError(null);

    try {
      const [{ OpenSheetMusicDisplay }, { extractParts }, { AudioEngine }] =
        await Promise.all([
          import("opensheetmusicdisplay"),
          import("@/lib/musicxml-parts"),
          import("@/lib/audio-engine"),
        ]);

      if (!containerRef.current) throw new Error("Score container not ready");

      osmdRef.current?.cursor?.hide();
      const osmd = new OpenSheetMusicDisplay(containerRef.current, {
        autoResize: true,
        backend: "svg",
        drawTitle: true,
        followCursor: true,
        // Red box highlight around the current notes (type 0 = note box).
        cursorsOptions: [{ type: 0, color: "#ef4444", alpha: 0.4, follow: true }],
      });
      osmdRef.current = osmd;

      const blob = await fetch(musicXmlUrl).then((r) => r.blob());
      await osmd.load(blob);
      osmd.render();

      osmd.cursor.reset();
      const onsets: number[] = [];
      let guard = 0;
      while (!osmd.cursor.Iterator.EndReached && guard < 100000) {
        onsets.push(
          osmd.cursor.Iterator.currentTimeStamp.RealValue * TICKS_PER_WHOLE_NOTE
        );
        osmd.cursor.next();
        guard += 1;
      }
      osmd.cursor.reset();
      osmd.cursor.show();
      stepOnsetsRef.current = onsets;
      stepIndexRef.current = 0;

      const scoreParts = extractParts(osmd.Sheet);
      if (scoreParts.length === 0) {
        throw new Error("No playable notes were found in the recognized score.");
      }

      // Honor the tempo printed on the score (e.g. ♩ = 76) when present and
      // sane; otherwise fall back to the default.
      const scoreTempo = Math.round(osmd.Sheet?.DefaultStartTempoInBpm ?? 0);
      const startBpm =
        scoreTempo >= 20 && scoreTempo <= 400 ? scoreTempo : DEFAULT_BPM;

      const engine = new AudioEngine();
      setStatusMsg("Loading piano samples...");
      await engine.build(scoreParts, (loaded, total) => {
        setStatusMsg(`Loading piano samples (${loaded}/${total})...`);
      });
      engineRef.current = engine;
      engine.setBpm(startBpm);
      engine.setTranspose(0);

      setParts(scoreParts);
      setVoiceFilter("all");
      setOctave(0);
      setBpm(startBpm);
      setPositionSec(0);
      setDurationSec(engine.getDurationSeconds());
      setIsPlaying(false);
      setResultUrl(musicXmlUrl);
      setStage("ready");
      setStatusMsg("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }, []);

  const pollStatus = useCallback(
    async (jobId: string) => {
      try {
        const res = await fetch(`/api/omr/status/${jobId}`);
        const data = await res.json();

        if (data.status === "error") {
          setError(data.error || "OMR failed");
          setStage("error");
          return;
        }
        if (data.status === "done") {
          await loadScore(`/api/omr/result/${jobId}`);
          return;
        }
        setStatusMsg(data.message || "Recognizing notes...");
        setTimeout(() => pollStatus(jobId), 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStage("error");
      }
    },
    [loadScore]
  );

  /** Reset transport/engine state before loading anything new. */
  const resetForLoad = useCallback(
    (name: string) => {
      cancelLoop();
      engineRef.current?.dispose();
      engineRef.current = null;
      setParts([]);
      setVoiceFilter("all");
      setIsPlaying(false);
      setPositionSec(0);
      setDurationSec(0);
      if (resultUrl?.startsWith("blob:")) URL.revokeObjectURL(resultUrl);
      setResultUrl(null);
      setError(null);
      setFileName(name);
    },
    [cancelLoop, resultUrl]
  );

  const handleDemo = useCallback(async () => {
    resetForLoad(DEMO_NAME);
    await loadScore(DEMO_URL);
  }, [resetForLoad, loadScore]);

  const handleFile = useCallback(
    async (file: File) => {
      resetForLoad(file.name);

      // Direct MusicXML load — skip OMR entirely.
      if (/\.(mxl|xml|musicxml)$/i.test(file.name)) {
        const url = URL.createObjectURL(file);
        await loadScore(url);
        return;
      }

      setStage("uploading");
      setStatusMsg("Uploading...");

      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/omr/process", {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Upload failed (${res.status})`);
        }
        const { jobId } = await res.json();
        setStage("processing");
        setStatusMsg("Recognizing notes (this can take a minute or two)...");
        pollStatus(jobId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStage("error");
      }
    },
    [pollStatus, loadScore, resetForLoad]
  );

  const handlePlay = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    await engine.play();
    setIsPlaying(true);
    cancelLoop();
    rafRef.current = requestAnimationFrame(tick);
  }, [tick, cancelLoop]);

  const handlePause = useCallback(() => {
    engineRef.current?.pause();
    setIsPlaying(false);
    cancelLoop();
  }, [cancelLoop]);

  const handleStop = useCallback(() => {
    engineRef.current?.stop();
    setIsPlaying(false);
    setPositionSec(0);
    stepIndexRef.current = 0;
    osmdRef.current?.cursor.reset();
    osmdRef.current?.cursor.update();
    cancelLoop();
  }, [cancelLoop]);

  const handleSeek = useCallback(
    (sec: number) => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.seek(sec);
      setPositionSec(sec);
      syncCursor(engine.getPositionTicks());
    },
    [syncCursor]
  );

  const handleBpm = useCallback((value: number) => {
    engineRef.current?.setBpm(value);
    setBpm(value);
    setDurationSec(engineRef.current?.getDurationSeconds() ?? 0);
  }, []);

  const handleOctave = useCallback((next: number) => {
    const clamped = Math.max(-2, Math.min(2, next));
    engineRef.current?.setTranspose(clamped * 12);
    setOctave(clamped);
  }, []);

  const handleFilterChange = useCallback(
    (filter: VoiceFilter) => {
      setVoiceFilter(filter);
      const engine = engineRef.current;
      if (!engine) return;
      parts.forEach((p) => engine.setMute(p.id, shouldMute(p.role, filter)));
    },
    [parts]
  );

  useEffect(() => {
    if (stage !== "ready") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA");
      if (e.code === "Space" && !typing) {
        e.preventDefault();
        if (isPlaying) handlePause();
        else handlePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, isPlaying, handlePlay, handlePause]);

  const availableFilters = useMemo((): VoiceFilter[] => {
    const roles = new Set(parts.map((p) => p.role));
    const hasVocals = VOCAL_ROLES.some((r) => roles.has(r));
    const hasPiano = roles.has("piano");
    const filters: VoiceFilter[] = ["all"];
    if (hasPiano) filters.push("piano");
    if (hasVocals && hasPiano) filters.push("choir");
    for (const role of VOCAL_ROLES) {
      if (roles.has(role)) filters.push(role);
    }
    return filters;
  }, [parts]);

  const busy =
    stage === "uploading" || stage === "processing" || stage === "loading";

  return (
    <div className="min-h-full flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-stone-100 sticky top-0 z-20 shadow-sm">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-900 text-white">
            {/* music note */}
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" />
            </svg>
          </div>
          <div className="min-w-0">
            <h1 className="font-black text-blue-900 text-base leading-tight tracking-tight">
              Choire Reader Player
            </h1>
            <p className="text-stone-400 text-xs mt-0.5 truncate">
              Upload sheet music → hear it sung, voice by voice
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-6 flex flex-col gap-5">
        {/* Upload */}
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <label
              className={`inline-flex cursor-pointer items-center gap-2 rounded-full bg-blue-900 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-800 active:bg-blue-950 ${
                busy ? "pointer-events-none opacity-50" : ""
              }`}
            >
              {fileName ? "Choose another file" : "Upload sheet music"}
              <input
                type="file"
                accept="image/*,.pdf,.mxl,.xml,.musicxml"
                className="hidden"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              onClick={handleDemo}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white px-5 py-2.5 text-sm font-bold text-blue-900 transition-colors hover:bg-blue-50 disabled:pointer-events-none disabled:opacity-50"
            >
              Try the demo
            </button>
          </div>
          {fileName ? (
            <span className="text-sm text-stone-500 truncate">{fileName}</span>
          ) : (
            <p className="text-xs text-stone-400">
              Accepts an image, PDF, or MusicXML (.mxl / .xml). Or tap{" "}
              <span className="font-semibold text-blue-900">Try the demo</span>{" "}
              for an instant example.
            </p>
          )}
        </section>

        {/* Status / errors */}
        {busy && (
          <div className="flex items-center gap-3 rounded-2xl border border-stone-100 bg-white px-4 py-3 text-sm text-stone-600 shadow-sm">
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-blue-200 border-t-blue-900" />
            {statusMsg}
          </div>
        )}
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-500">
            {error}
          </div>
        )}

        {/* Playback + voice controls */}
        {stage === "ready" && (
          <section className="rounded-2xl border border-stone-100 bg-white p-4 sm:p-5 shadow-sm flex flex-col gap-5">
            {/* Transport row */}
            <div className="flex flex-wrap items-center gap-3">
              {isPlaying ? (
                <button
                  onClick={handlePause}
                  className="rounded-full bg-blue-900 px-6 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-800 active:bg-blue-950"
                >
                  Pause
                </button>
              ) : (
                <button
                  onClick={handlePlay}
                  className="rounded-full bg-blue-900 px-6 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-800 active:bg-blue-950"
                >
                  ▶ Play
                </button>
              )}
              <button
                onClick={handleStop}
                className="rounded-full bg-stone-100 px-5 py-2.5 text-sm font-bold text-stone-700 transition-colors hover:bg-stone-200"
              >
                Stop
              </button>

              <span className="tabular-nums text-sm font-medium text-stone-400">
                {formatTime(positionSec)} / {formatTime(durationSec)}
              </span>
            </div>

            {/* Seek bar */}
            <input
              type="range"
              min={0}
              max={durationSec || 0}
              step={0.05}
              value={Math.min(positionSec, durationSec)}
              onChange={(e) => handleSeek(Number(e.target.value))}
              className="w-full accent-blue-900"
              aria-label="Seek"
            />

            {/* Tempo */}
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold uppercase tracking-wide text-stone-400">
                Tempo
              </span>
              <input
                type="range"
                min={40}
                max={200}
                value={bpm}
                onChange={(e) => handleBpm(Number(e.target.value))}
                className="flex-1 accent-blue-900"
                aria-label="Tempo"
              />
              <span className="w-20 text-right text-sm font-bold tabular-nums text-blue-900">
                {bpm} BPM
              </span>
            </div>

            {/* Voice selector */}
            <div className="flex flex-col gap-2">
              <span className="text-xs font-bold uppercase tracking-wide text-stone-400">
                Voice
              </span>
              <div className="flex flex-wrap gap-2">
                {availableFilters.map((filter) => (
                  <button
                    key={filter}
                    onClick={() => handleFilterChange(filter)}
                    className={`rounded-full border px-4 py-2 text-sm font-bold transition-all duration-150 ${
                      voiceFilter === filter
                        ? "border-blue-900 bg-blue-900 text-white"
                        : "border-stone-200 bg-white text-stone-500 hover:border-blue-300 hover:text-blue-900"
                    }`}
                  >
                    {FILTER_LABELS[filter]}
                  </button>
                ))}
              </div>
            </div>

            {resultUrl && (
              <div className="flex justify-end border-t border-stone-100 pt-3">
                <a
                  href={resultUrl}
                  download="score.mxl"
                  className="rounded-full px-3 py-1.5 text-xs font-bold text-stone-400 transition-colors hover:bg-stone-100 hover:text-blue-900"
                >
                  Download MusicXML ↓
                </a>
              </div>
            )}
          </section>
        )}

        {/* Score */}
        <section
          className={`rounded-2xl border border-stone-100 bg-white p-3 sm:p-4 shadow-sm ${
            stage === "ready" ? "" : "min-h-[200px]"
          }`}
        >
          {stage === "idle" && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <p className="text-sm font-medium text-stone-400">
                No score loaded yet.
              </p>
              <p className="text-xs text-stone-400">
                Upload a photo, PDF, or MusicXML file — or try the demo — to
                begin.
              </p>
            </div>
          )}
          <div
            ref={containerRef}
            className="max-h-[70vh] overflow-auto rounded-lg bg-white"
          />
        </section>
      </main>
    </div>
  );
}

import { useState, useRef, useEffect, useCallback } from "react";

// ---- Token system ----
// Color: deep warm charcoal body, brass/amber needle, three response zones
const COLORS = {
  bg: "#151310",
  panel: "#1d1a15",
  panelEdge: "#2b2620",
  brass: "#c9a15a",
  brassDim: "#8a7248",
  cream: "#ece4d3",
  creamDim: "#8f887a",
  quiet: "#5b8c6b",
  moderate: "#d3a24a",
  loud: "#c1543f",
  needle: "#e8d9b8",
};

// dBFS range we display on the arc
const MIN_DB = -60;
const MAX_DB = 0;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function zoneFor(db) {
  if (db < -30) return { name: "quiet", color: COLORS.quiet };
  if (db < -12) return { name: "moderate", color: COLORS.moderate };
  return { name: "loud", color: COLORS.loud };
}

// Map a dB value to an angle in degrees, sweeping -120deg (min) to 120deg (max)
function dbToAngle(db) {
  const t = (clamp(db, MIN_DB, MAX_DB) - MIN_DB) / (MAX_DB - MIN_DB);
  return -120 + t * 240;
}

function polar(cx, cy, r, angleDeg) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx, cy, r, startAngle, endAngle) {
  const start = polar(cx, cy, r, startAngle);
  const end = polar(cx, cy, r, endAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export default function DecibelMeter() {
  const [status, setStatus] = useState("idle"); // idle | requesting | listening | denied | unsupported
  const [db, setDb] = useState(MIN_DB);
  const [peakDb, setPeakDb] = useState(MIN_DB);
  const [errorMsg, setErrorMsg] = useState("");

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const smoothedRef = useRef(MIN_DB);
  const peakDecayRef = useRef(MIN_DB);
  const lastPeakHitRef = useRef(0);

  const stopListening = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  const startListening = useCallback(async () => {
    setErrorMsg("");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("unsupported");
      return;
    }
    setStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContextClass();
      if (audioCtx.state === "suspended") await audioCtx.resume();
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      analyserRef.current = analyser;

      smoothedRef.current = MIN_DB;
      peakDecayRef.current = MIN_DB;
      setPeakDb(MIN_DB);
      setStatus("listening");

      const data = new Float32Array(analyser.fftSize);

      const tick = () => {
        analyser.getFloatTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
        const rms = Math.sqrt(sumSquares / data.length);
        const raw = rms > 0 ? 20 * Math.log10(rms) : MIN_DB;
        const clamped = clamp(raw, MIN_DB, MAX_DB);

        // Smooth the needle so it doesn't jitter frame to frame
        const smoothing = clamped > smoothedRef.current ? 0.5 : 0.15;
        smoothedRef.current += (clamped - smoothedRef.current) * smoothing;
        setDb(smoothedRef.current);

        // Peak hold with slow decay
        const now = performance.now();
        if (smoothedRef.current >= peakDecayRef.current) {
          peakDecayRef.current = smoothedRef.current;
          lastPeakHitRef.current = now;
        } else if (now - lastPeakHitRef.current > 1200) {
          peakDecayRef.current -= 0.25;
        }
        setPeakDb(clamp(peakDecayRef.current, MIN_DB, MAX_DB));

        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      stopListening();
      setStatus("denied");
      setErrorMsg(
        err && err.name === "NotAllowedError"
          ? "Microphone access was denied."
          : "Couldn't access the microphone."
      );
    }
  }, [stopListening]);

  useEffect(() => stopListening, [stopListening]);

  const handleResetPeak = () => {
    peakDecayRef.current = smoothedRef.current;
    setPeakDb(smoothedRef.current);
  };

  const zone = zoneFor(db);
  const needleAngle = dbToAngle(db);
  const peakAngle = dbToAngle(peakDb);

  const cx = 150;
  const cy = 160;
  const r = 118;

  const ticks = [];
  for (let d = MIN_DB; d <= MAX_DB; d += 6) {
    const angle = dbToAngle(d);
    const outer = polar(cx, cy, r, angle);
    const inner = polar(cx, cy, r - (d % 12 === 0 ? 14 : 8), angle);
    ticks.push(
      <line
        key={d}
        x1={inner.x}
        y1={inner.y}
        x2={outer.x}
        y2={outer.y}
        stroke={COLORS.brassDim}
        strokeWidth={d % 12 === 0 ? 2 : 1}
      />
    );
    if (d % 12 === 0) {
      const label = polar(cx, cy, r - 30, angle);
      ticks.push(
        <text
          key={`l-${d}`}
          x={label.x}
          y={label.y}
          fill={COLORS.creamDim}
          fontSize="9"
          fontFamily="'Courier New', monospace"
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {d}
        </text>
      );
    }
  }

  const needleTip = polar(cx, cy, r - 22, needleAngle);
  const peakTick = polar(cx, cy, r, peakAngle);
  const peakTickInner = polar(cx, cy, r - 14, peakAngle);

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        background: `radial-gradient(circle at 50% 20%, ${COLORS.panel}, ${COLORS.bg} 70%)`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 16px",
        fontFamily: "'Georgia', serif",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 380,
          background: COLORS.panel,
          border: `1px solid ${COLORS.panelEdge}`,
          borderRadius: 18,
          padding: "24px 24px 20px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.03)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 4,
          }}
        >
          <span
            style={{
              fontFamily: "'Courier New', monospace",
              fontSize: 11,
              letterSpacing: "0.2em",
              color: COLORS.brassDim,
              textTransform: "uppercase",
            }}
          >
            Level Meter
          </span>
          <span
            style={{
              fontFamily: "'Courier New', monospace",
              fontSize: 11,
              color:
                status === "listening" ? COLORS.quiet : COLORS.creamDim,
            }}
          >
            {status === "listening" ? "● live" : "○ idle"}
          </span>
        </div>

        <svg viewBox="0 0 300 210" width="100%" style={{ display: "block" }}>
          {/* Zone arcs */}
          <path
            d={arcPath(cx, cy, r, dbToAngle(MIN_DB), dbToAngle(-30))}
            fill="none"
            stroke={COLORS.quiet}
            strokeWidth={3}
            opacity={0.55}
          />
          <path
            d={arcPath(cx, cy, r, dbToAngle(-30), dbToAngle(-12))}
            fill="none"
            stroke={COLORS.moderate}
            strokeWidth={3}
            opacity={0.55}
          />
          <path
            d={arcPath(cx, cy, r, dbToAngle(-12), dbToAngle(MAX_DB))}
            fill="none"
            stroke={COLORS.loud}
            strokeWidth={3}
            opacity={0.55}
          />

          {ticks}

          {/* Peak marker */}
          <line
            x1={peakTickInner.x}
            y1={peakTickInner.y}
            x2={peakTick.x}
            y2={peakTick.y}
            stroke={COLORS.loud}
            strokeWidth={2}
          />

          {/* Needle */}
          <line
            x1={cx}
            y1={cy}
            x2={needleTip.x}
            y2={needleTip.y}
            stroke={COLORS.needle}
            strokeWidth={2.5}
            strokeLinecap="round"
            style={{ transition: "none" }}
          />
          <circle cx={cx} cy={cy} r={6} fill={COLORS.brass} />
          <circle cx={cx} cy={cy} r={2.5} fill={COLORS.bg} />
        </svg>

        <div style={{ textAlign: "center", marginTop: -8 }}>
          <div
            style={{
              fontFamily: "'Courier New', monospace",
              fontSize: 44,
              fontWeight: 700,
              color: zone.color,
              lineHeight: 1,
              transition: "color 0.3s ease",
            }}
          >
            {status === "listening" ? db.toFixed(1) : "—"}
          </div>
          <div
            style={{
              fontFamily: "'Courier New', monospace",
              fontSize: 11,
              color: COLORS.creamDim,
              letterSpacing: "0.15em",
              marginTop: 2,
              textTransform: "uppercase",
            }}
          >
            dBFS &middot; {status === "listening" ? zone.name : "not running"}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 18,
            paddingTop: 14,
            borderTop: `1px solid ${COLORS.panelEdge}`,
            fontFamily: "'Courier New', monospace",
            fontSize: 12,
            color: COLORS.creamDim,
          }}
        >
          <span>
            Peak{" "}
            <strong style={{ color: COLORS.cream }}>
              {status === "listening" ? peakDb.toFixed(1) : "—"}
            </strong>
          </span>
          <button
            onClick={handleResetPeak}
            disabled={status !== "listening"}
            style={{
              background: "none",
              border: `1px solid ${COLORS.brassDim}`,
              color: status === "listening" ? COLORS.brass : COLORS.brassDim,
              borderRadius: 6,
              padding: "3px 10px",
              fontSize: 11,
              cursor: status === "listening" ? "pointer" : "default",
              fontFamily: "inherit",
            }}
          >
            reset peak
          </button>
        </div>

        <div style={{ marginTop: 18 }}>
          {status !== "listening" ? (
            <button
              onClick={startListening}
              style={{
                width: "100%",
                background: COLORS.brass,
                color: COLORS.bg,
                border: "none",
                borderRadius: 10,
                padding: "12px 0",
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: "0.03em",
                cursor: "pointer",
                fontFamily: "'Georgia', serif",
              }}
            >
              {status === "requesting" ? "Requesting mic…" : "Start meter"}
            </button>
          ) : (
            <button
              onClick={() => {
                stopListening();
                setStatus("idle");
              }}
              style={{
                width: "100%",
                background: "transparent",
                color: COLORS.loud,
                border: `1px solid ${COLORS.loud}`,
                borderRadius: 10,
                padding: "12px 0",
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: "0.03em",
                cursor: "pointer",
                fontFamily: "'Georgia', serif",
              }}
            >
              Stop
            </button>
          )}
        </div>

        {(status === "denied" || status === "unsupported") && (
          <div
            style={{
              marginTop: 12,
              fontSize: 12,
              color: COLORS.loud,
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            {status === "unsupported"
              ? "This browser doesn't support microphone access."
              : errorMsg}
          </div>
        )}

        <div
          style={{
            marginTop: 14,
            fontSize: 10.5,
            color: COLORS.creamDim,
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          Reads relative level from your mic (dBFS), not a calibrated SPL
          reading. Good for comparing loud vs. quiet, not for precise limits.
        </div>
      </div>
    </div>
  );
}

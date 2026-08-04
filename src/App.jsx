import { useState, useRef, useEffect, useCallback } from "react";

// ---- Token system ----
const COLORS = {
  bg: "#eef1f5",
  card: "#ffffff",
  border: "#e3e7ee",
  textPrimary: "#232838",
  textSecondary: "#9399a8",
  track: "#e4e8ee",
  needle: "#ff5a52",
  quiet: "#3ec28f",
  moderate: "#f4b942",
  loud: "#ff8a3d",
  veryLoud: "#ff5a52",
  chartFillFrom: "#5cc9e0",
  chartFillTo: "#7c8bff",
  chartLine: "#3fa9c9",
  accent: "#5b6bff",
};

const DISPLAY_MIN = 0;
const DISPLAY_MAX = 100;
const DEFAULT_OFFSET = 100; // rough starting offset until the person calibrates
const STORAGE_KEY = "decibel-meter-calibration";

// localStorage isn't available inside Claude's artifact preview, but works
// fine once this is deployed to a real page (e.g. GitHub Pages) — so every
// call is wrapped defensively.
function loadSavedCalibration() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.offset === "number" && Number.isFinite(parsed.offset)) {
      return parsed.offset;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCalibration(offset) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ offset }));
  } catch {
    // Storage unavailable (e.g. private browsing, artifact preview) — ignore
  }
}

function clearSavedCalibration() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Standard IEC 61672-1 A-weighting curve (dB adjustment per frequency)
function aWeightDb(freq) {
  if (freq <= 0) return -100;
  const f2 = freq * freq;
  const num = Math.pow(12194, 2) * Math.pow(f2, 2);
  const den =
    (f2 + Math.pow(20.6, 2)) *
    Math.sqrt((f2 + Math.pow(107.7, 2)) * (f2 + Math.pow(737.9, 2))) *
    (f2 + Math.pow(12194, 2));
  const ra = num / den;
  return 20 * Math.log10(ra) + 2.0;
}

function zoneFor(display) {
  if (display < 35) return { name: "Quiet room", color: COLORS.quiet };
  if (display < 55) return { name: "Conversation", color: COLORS.moderate };
  if (display < 70) return { name: "Office", color: COLORS.moderate };
  if (display < 85) return { name: "Restaurant", color: COLORS.loud };
  return { name: "Loud / traffic", color: COLORS.veryLoud };
}

function valueToAngle(v) {
  const t = (clamp(v, DISPLAY_MIN, DISPLAY_MAX) - DISPLAY_MIN) / (DISPLAY_MAX - DISPLAY_MIN);
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

const HISTORY_WINDOW_MS = 30000;
const SAMPLE_INTERVAL_MS = 150;

export default function DecibelMeter() {
  const [status, setStatus] = useState("idle"); // idle | requesting | listening | denied | unsupported
  const [display, setDisplay] = useState(DISPLAY_MIN);
  const [minV, setMinV] = useState(null);
  const [maxV, setMaxV] = useState(null);
  const [avgV, setAvgV] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [history, setHistory] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [isCalibrated, setIsCalibrated] = useState(() => loadSavedCalibration() !== null);
  const [showCalibrate, setShowCalibrate] = useState(false);
  const [refInput, setRefInput] = useState("");

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const smoothedRef = useRef(DISPLAY_MIN);
  const rawUncalibratedRef = useRef(-40); // latest raw A-weighted dBFS, pre-offset
  const savedOffset = useRef(loadSavedCalibration()).current;
  const offsetRef = useRef(savedOffset !== null ? savedOffset : DEFAULT_OFFSET);
  const weightTableRef = useRef(null);
  const startTimeRef = useRef(0);
  const lastSampleRef = useRef(0);
  const sumRef = useRef(0);
  const countRef = useRef(0);
  const minRef = useRef(null);
  const maxRef = useRef(null);

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
      analyser.smoothingTimeConstant = 0.2;
      analyser.minDecibels = -100;
      analyser.maxDecibels = 0;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Precompute the A-weighting curve for each FFT frequency bin
      const binCount = analyser.frequencyBinCount;
      const sampleRate = audioCtx.sampleRate;
      const weights = new Float32Array(binCount);
      for (let i = 0; i < binCount; i++) {
        const freq = (i * sampleRate) / analyser.fftSize;
        weights[i] = aWeightDb(freq);
      }
      weightTableRef.current = weights;

      smoothedRef.current = DISPLAY_MIN;
      sumRef.current = 0;
      countRef.current = 0;
      minRef.current = null;
      maxRef.current = null;
      startTimeRef.current = performance.now();
      lastSampleRef.current = 0;
      setMinV(null);
      setMaxV(null);
      setAvgV(null);
      setHistory([]);
      setElapsed(0);
      setStatus("listening");

      const freqData = new Float32Array(binCount);

      const tick = () => {
        analyser.getFloatFrequencyData(freqData);
        const w = weightTableRef.current;

        let sumPower = 0;
        for (let i = 0; i < freqData.length; i++) {
          const db = freqData[i];
          if (!isFinite(db)) continue;
          const weightedDb = db + w[i];
          sumPower += Math.pow(10, weightedDb / 10);
        }
        const rawADb = sumPower > 0 ? 10 * Math.log10(sumPower) : -100;
        rawUncalibratedRef.current = rawADb;

        const calibratedDb = rawADb + offsetRef.current;
        const targetDisplay = clamp(calibratedDb, DISPLAY_MIN, DISPLAY_MAX);

        const smoothing = targetDisplay > smoothedRef.current ? 0.45 : 0.15;
        smoothedRef.current += (targetDisplay - smoothedRef.current) * smoothing;
        const v = smoothedRef.current;
        setDisplay(v);

        sumRef.current += v;
        countRef.current += 1;
        setAvgV(sumRef.current / countRef.current);

        if (minRef.current === null || v < minRef.current) {
          minRef.current = v;
          setMinV(v);
        }
        if (maxRef.current === null || v > maxRef.current) {
          maxRef.current = v;
          setMaxV(v);
        }

        const now = performance.now();
        setElapsed((now - startTimeRef.current) / 1000);

        if (now - lastSampleRef.current >= SAMPLE_INTERVAL_MS) {
          lastSampleRef.current = now;
          setHistory((prev) => {
            const cutoff = now - HISTORY_WINDOW_MS;
            const next = [...prev, { t: now, v }].filter((p) => p.t >= cutoff);
            return next;
          });
        }

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

  const handleReset = () => {
    sumRef.current = display;
    countRef.current = 1;
    minRef.current = display;
    maxRef.current = display;
    startTimeRef.current = performance.now();
    setMinV(display);
    setMaxV(display);
    setAvgV(display);
    setElapsed(0);
    setHistory([]);
  };

  const applyCalibration = () => {
    const refValue = parseFloat(refInput);
    if (Number.isFinite(refValue)) {
      const newOffset = refValue - rawUncalibratedRef.current;
      offsetRef.current = newOffset;
      saveCalibration(newOffset);
      setIsCalibrated(true);
    }
    setShowCalibrate(false);
    setRefInput("");
  };

  const clearCalibration = () => {
    offsetRef.current = DEFAULT_OFFSET;
    clearSavedCalibration();
    setIsCalibrated(false);
  };

  const zone = zoneFor(display);
  const needleAngle = valueToAngle(display);

  const cx = 150;
  const cy = 155;
  const r = 115;

  const ticks = [];
  for (let d = 0; d <= 100; d += 10) {
    const angle = valueToAngle(d);
    const isMajor = d % 20 === 0;
    const outer = polar(cx, cy, r, angle);
    const inner = polar(cx, cy, r - (isMajor ? 12 : 7), angle);
    ticks.push(
      <line
        key={d}
        x1={inner.x}
        y1={inner.y}
        x2={outer.x}
        y2={outer.y}
        stroke={COLORS.textSecondary}
        strokeWidth={isMajor ? 2 : 1}
        opacity={isMajor ? 0.7 : 0.4}
      />
    );
    if (isMajor) {
      const label = polar(cx, cy, r - 27, angle);
      ticks.push(
        <text
          key={`l-${d}`}
          x={label.x}
          y={label.y}
          fill={COLORS.textSecondary}
          fontSize="10"
          fontFamily="system-ui, sans-serif"
          fontWeight="600"
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {d}
        </text>
      );
    }
  }

  const needleTip = polar(cx, cy, r - 20, needleAngle);

  const chartW = 300;
  const chartH = 110;
  const chartPadL = 30;
  const chartPadR = 8;
  const chartPadT = 10;
  const chartPadB = 18;
  const plotW = chartW - chartPadL - chartPadR;
  const plotH = chartH - chartPadT - chartPadB;
  const now = history.length ? history[history.length - 1].t : performance.now();

  const points = history.map((p) => {
    const x = chartPadL + plotW * (1 - (now - p.t) / HISTORY_WINDOW_MS);
    const y = chartPadT + plotH * (1 - p.v / 100);
    return { x, y };
  });

  const linePath =
    points.length > 1
      ? "M " + points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")
      : "";
  const areaPath =
    points.length > 1
      ? `${linePath} L ${points[points.length - 1].x.toFixed(1)},${(chartPadT + plotH).toFixed(1)} L ${points[0].x.toFixed(1)},${(chartPadT + plotH).toFixed(1)} Z`
      : "";

  const fmtElapsed = (s) => {
    const mm = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  };

  const isLive = status === "listening";

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        background: COLORS.bg,
        display: "flex",
        justifyContent: "center",
        padding: "24px 14px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        boxSizing: "border-box",
      }}
    >
      <div style={{ width: "100%", maxWidth: 380 }}>
        {/* Top bar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <button
            onClick={handleReset}
            disabled={!isLive}
            title="Reset stats"
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              border: `1px solid ${COLORS.border}`,
              background: COLORS.card,
              color: isLive ? COLORS.textPrimary : COLORS.textSecondary,
              fontSize: 16,
              cursor: isLive ? "pointer" : "default",
            }}
          >
            ↺
          </button>
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: COLORS.textPrimary,
            }}
          >
            SOUND METER
          </span>
          <button
            onClick={() => setShowCalibrate((s) => !s)}
            disabled={!isLive}
            title="Calibrate"
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              border: `1px solid ${isCalibrated ? COLORS.accent : COLORS.border}`,
              background: COLORS.card,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 15,
              cursor: isLive ? "pointer" : "default",
              color: isCalibrated ? COLORS.accent : COLORS.textSecondary,
            }}
          >
            ⚙
          </button>
        </div>

        {showCalibrate && (
          <div
            style={{
              background: COLORS.card,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 16,
              padding: "14px 16px",
              marginBottom: 12,
              boxShadow: "0 8px 24px rgba(35,40,56,0.06)",
            }}
          >
            <div style={{ fontSize: 12.5, color: COLORS.textPrimary, marginBottom: 8, lineHeight: 1.4 }}>
              Hold this next to a reference meter reading the same sound, then
              enter its dB value to calibrate.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="number"
                inputMode="decimal"
                placeholder="e.g. 62"
                value={refInput}
                onChange={(e) => setRefInput(e.target.value)}
                style={{
                  flex: 1,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 10,
                  padding: "8px 10px",
                  fontSize: 14,
                  color: COLORS.textPrimary,
                }}
              />
              <button
                onClick={applyCalibration}
                style={{
                  background: COLORS.accent,
                  color: "#fff",
                  border: "none",
                  borderRadius: 10,
                  padding: "8px 14px",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Set
              </button>
            </div>
            {isCalibrated && (
              <button
                onClick={clearCalibration}
                style={{
                  marginTop: 8,
                  background: "none",
                  border: "none",
                  color: COLORS.textSecondary,
                  fontSize: 11.5,
                  textDecoration: "underline",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                Clear calibration
              </button>
            )}
          </div>
        )}

        {/* Gauge card */}
        <div
          style={{
            background: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 20,
            padding: "18px 16px 8px",
            boxShadow: "0 8px 24px rgba(35,40,56,0.06)",
          }}
        >
          <svg viewBox="0 0 300 190" width="100%" style={{ display: "block" }}>
            <path
              d={arcPath(cx, cy, r, valueToAngle(0), valueToAngle(100))}
              fill="none"
              stroke={COLORS.track}
              strokeWidth={10}
              strokeLinecap="round"
            />
            <path
              d={arcPath(cx, cy, r, valueToAngle(0), needleAngle)}
              fill="none"
              stroke={zone.color}
              strokeWidth={10}
              strokeLinecap="round"
              style={{ transition: "stroke 0.3s ease" }}
            />

            {ticks}

            <line
              x1={cx}
              y1={cy}
              x2={needleTip.x}
              y2={needleTip.y}
              stroke={COLORS.needle}
              strokeWidth={3}
              strokeLinecap="round"
            />
            <circle cx={cx} cy={cy} r={7} fill={COLORS.needle} />
            <circle cx={cx} cy={cy} r={3} fill="#fff" />
          </svg>

          <div style={{ textAlign: "center", marginTop: -18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  fontSize: 48,
                  fontWeight: 800,
                  color: COLORS.textPrimary,
                  lineHeight: 1,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {isLive || history.length ? display.toFixed(1) : "—"}
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: COLORS.textSecondary,
                  marginTop: 6,
                }}
              >
                dBA
                <br />
                {isLive ? fmtElapsed(elapsed) : "--:--"}
              </span>
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 13,
                fontWeight: 600,
                color: zone.color,
              }}
            >
              {isLive
                ? `${Math.round(display)} dB: ${zone.name}`
                : "Not running"}
            </div>
            <div
              style={{
                marginTop: 2,
                fontSize: 10.5,
                fontWeight: 600,
                color: isCalibrated ? COLORS.accent : COLORS.textSecondary,
              }}
            >
              {isCalibrated ? "Calibrated" : "Estimated (not calibrated)"}
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              marginTop: 12,
              paddingTop: 12,
              borderTop: `1px solid ${COLORS.border}`,
              textAlign: "center",
            }}
          >
            {[
              { label: "MIN", v: minV, color: COLORS.quiet },
              { label: "AVG", v: avgV, color: COLORS.textPrimary },
              { label: "MAX", v: maxV, color: COLORS.veryLoud },
            ].map((s) => (
              <div key={s.label}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: COLORS.textSecondary,
                    letterSpacing: "0.05em",
                  }}
                >
                  {s.label}
                </div>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: s.v === null ? COLORS.textSecondary : s.color,
                    marginTop: 2,
                  }}
                >
                  {s.v === null ? "—" : `${s.v.toFixed(1)}`}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* History chart */}
        <div
          style={{
            background: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 20,
            padding: "14px 12px 10px",
            marginTop: 12,
            boxShadow: "0 8px 24px rgba(35,40,56,0.06)",
          }}
        >
          <svg viewBox={`0 0 ${chartW} ${chartH}`} width="100%" style={{ display: "block" }}>
            <defs>
              <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.chartFillFrom} stopOpacity="0.45" />
                <stop offset="100%" stopColor={COLORS.chartFillTo} stopOpacity="0.04" />
              </linearGradient>
            </defs>

            {[0, 20, 40, 60, 80, 100].map((g) => {
              const y = chartPadT + plotH * (1 - g / 100);
              return (
                <g key={g}>
                  <line
                    x1={chartPadL}
                    y1={y}
                    x2={chartW - chartPadR}
                    y2={y}
                    stroke={COLORS.border}
                    strokeWidth={1}
                  />
                  <text
                    x={chartPadL - 6}
                    y={y}
                    fontSize="8"
                    fill={COLORS.textSecondary}
                    textAnchor="end"
                    dominantBaseline="middle"
                  >
                    {g}
                  </text>
                </g>
              );
            })}

            {areaPath && <path d={areaPath} fill="url(#chartFill)" stroke="none" />}
            {linePath && (
              <path d={linePath} fill="none" stroke={COLORS.chartLine} strokeWidth={1.75} />
            )}

            <text x={chartPadL} y={9} fontSize="8" fill={COLORS.textSecondary} fontWeight="700">
              dB
            </text>
            <text
              x={chartW - chartPadR}
              y={chartH - 3}
              fontSize="8"
              fill={COLORS.textSecondary}
              textAnchor="end"
              fontWeight="700"
            >
              sec
            </text>
          </svg>
        </div>

        <div style={{ marginTop: 14 }}>
          {!isLive ? (
            <button
              onClick={startListening}
              style={{
                width: "100%",
                background: COLORS.chartLine,
                color: "#fff",
                border: "none",
                borderRadius: 14,
                padding: "13px 0",
                fontSize: 15,
                fontWeight: 700,
                cursor: "pointer",
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
                color: COLORS.veryLoud,
                border: `1.5px solid ${COLORS.veryLoud}`,
                borderRadius: 14,
                padding: "13px 0",
                fontSize: 15,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Stop
            </button>
          )}
        </div>

        {(status === "denied" || status === "unsupported") && (
          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              color: COLORS.veryLoud,
              textAlign: "center",
            }}
          >
            {status === "unsupported"
              ? "This browser doesn't support microphone access."
              : errorMsg}
          </div>
        )}

        <div
          style={{
            marginTop: 12,
            fontSize: 10.5,
            color: COLORS.textSecondary,
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          Uses A-weighting (dBA) to match human hearing. Calibrate against a
          reference meter for a closer real-world estimate — your
          calibration is saved on this device and stays put between visits.
        </div>
      </div>
    </div>
  );
}

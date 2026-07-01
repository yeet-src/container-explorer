// Pure presentation helpers — strings and colors, no signals or graph calls.
import { idx } from "yeet:tui";

export const pad = (s, n) => (String(s) + " ".repeat(n)).slice(0, n);
export const lpad = (s, n) => (" ".repeat(n) + String(s)).slice(-n);

// Truncate to at most `n` columns, marking a cut with a trailing "…" so an
// over-long value reads as clipped rather than silently sliced. Unlike
// `pad`, short strings come back unpadded — callers that need a fixed-width
// cell wrap this in `pad(ellipsize(s, w), w + 1)`, where the extra column
// guarantees a gap before the next cell so columns never butt together.
export const ellipsize = (s, n) => {
  s = String(s ?? "");
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, Math.max(0, n));
  return s.slice(0, n - 1) + "…";
};

// A container name is often "/foo" — strip the leading slash for display.
export const cleanName = (n) => (n && n[0] === "/" ? n.slice(1) : n || "");

// Short id (first 12 hex chars, docker convention).
export const shortId = (id) => (id ? id.slice(0, 12) : "");

// Bytes → human string (1.2K, 340M, 2.1G).
export const fmtBytes = (b) => {
  if (b == null) return "-";
  const n = Number(b);
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}M`;
  return `${(n / 1024 ** 3).toFixed(2)}G`;
};

// Percent to string with fixed width.
export const fmtPct = (f) => `${(f * 100).toFixed(1)}%`;

// Seconds since epoch → "1h23m" / "3d4h" / "42s" ago-ish uptime.
export const fmtAge = (createdSec, nowSec = Math.floor(Date.now() / 1000)) => {
  if (!createdSec) return "-";
  let s = Math.max(0, nowSec - createdSec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
};

// ISO 8601 timestamp string (as returned by state_full.started_at) → the
// same short "up N" form. `Date.parse` yields NaN for malformed inputs;
// we surface a `-` then rather than propagate a nonsense age.
export const fmtUptimeISO = (isoStr) => {
  if (!isoStr) return null;
  const ms = Date.parse(isoStr);
  if (Number.isNaN(ms)) return null;
  return fmtAge(Math.floor(ms / 1000));
};

// Unicode 1/8-block sparkline glyphs, ordered lightest → densest.
const SPARK = "▁▂▃▄▅▆▇█";

// Render `values` as a sparkline string of length `width`. Values older
// than `width` are dropped from the head; when there are fewer samples
// than the width, the string is left-padded with spaces so the newest
// sample always sits on the right (i.e. time flows left → right).
//
// `peak` is the value that maps to a full block. Pass a fixed number
// when the axis is bounded (0..1 for a percentage), or let it default to
// the running max so a rate sparkline auto-scales to its own window.
export const sparkline = (values, width, peak) => {
  if (!values || values.length === 0) return " ".repeat(width);
  const slice = values.slice(-width);
  const p = peak ?? Math.max(1e-9, ...slice);
  let out = "";
  for (const v of slice) {
    const t = Math.max(0, Math.min(1, v / p));
    out += SPARK[Math.min(SPARK.length - 1, Math.floor(t * (SPARK.length - 0.001)))];
  }
  // Right-align by padding on the left so the newest column is flush right.
  return " ".repeat(Math.max(0, width - out.length)) + out;
};

// Successive-difference of a monotonic counter series (e.g. rx_bytes)
// so `sparkline()` can plot a rate rather than an ever-growing total.
// The first sample has no predecessor and is dropped.
export const deltas = (values) => {
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    out.push(d < 0 ? 0 : d);            // counter reset → clamp to 0
  }
  return out;
};

// State enum → face color. The graph returns UPPER_SNAKE_CASE.
export const stateColor = (state) => {
  switch (state) {
    case "RUNNING": return idx(2);   // green
    case "PAUSED":  return idx(3);   // yellow
    case "RESTARTING": return idx(3);
    case "CREATED": return idx(4);   // blue
    case "EXITED":  return idx(8);   // dim grey
    case "DEAD":    return idx(1);   // red
    case "REMOVING": return idx(1);
    default: return idx(244);
  }
};

// Color for the free-text status line (e.g. "Up 3 hours (healthy)",
// "Exited (137) 2 minutes ago"). Health and exit code carry more signal
// than the coarse state enum, so we read them off the string first and
// only fall back to `stateColor` when there's nothing more specific.
export const statusColor = (c) => {
  const s = (c?.status ?? "").toLowerCase();
  if (s.includes("unhealthy")) return idx(1);          // red
  if (s.includes("health: starting")) return idx(3);   // yellow — still warming up
  if (s.includes("healthy")) return idx(2);            // green
  if (c?.state === "EXITED") {
    // "Exited (N) …" — code 0 is a clean stop, anything else is a failure.
    const m = s.match(/exited \((\d+)\)/);
    return m && m[1] !== "0" ? idx(1) : idx(8);        // red vs dim grey
  }
  return stateColor(c?.state);
};

// Compact state glyph next to a color badge.
export const stateGlyph = (state) => {
  switch (state) {
    case "RUNNING": return "●";
    case "PAUSED":  return "‖";
    case "RESTARTING": return "↻";
    case "EXITED":  return "○";
    case "DEAD":    return "✗";
    case "CREATED": return "◌";
    default: return "?";
  }
};

// components/detail.jsx — per-container drill-down. Reads a `detailFor(name)`
// signal directly in render thunks; because `from()` starts producing when
// first watched and stops when unwatched, the polling lifecycle is tied to
// this subtree being mounted — nothing to tear down by hand.
//
// The layout deliberately avoids user-defined components that take JSX
// children (Section/KV etc.) — the yeet:tui runtime happily passes props
// through but nesting arbitrary JSX children under a function component
// was flaky in practice, so every row here is written as a bare `<Text>`
// with per-span nested `<Text>`s for color runs.
import { Box, Text, idx } from "yeet:tui";
import { detailFor, cpuFraction, logsFor } from "@/probes/containers.js";
import { cleanName, deltas, fmtBytes, fmtPct, fmtUptimeISO, shortId, sparkline, stateColor, stateGlyph } from "@/lib/format.js";

const LABEL = idx(244);
const HEAD = idx(250);
const RULE = idx(238);
const ACCENT = idx(4);

// Two-column key/value row. Labels are left-aligned in a fixed column so
// values line up down the section; the fg is dim to demote them and let
// the value carry the eye.
const KV_LABEL_W = 10;
const kv = (k, v, vFg) => (
  <Text height="1">
    <Text fg={LABEL}>{"  " + k.padEnd(KV_LABEL_W)}</Text>
    <Text fg={vFg}>{v == null || v === "" ? "-" : v}</Text>
  </Text>
);

// Section header + separator. When `hovered` is true the pane is under
// the mouse pointer, so we brighten the title and paint the rule in the
// accent colour — the visual "this is clickable" cue. A trailing hint
// nudges first-time users toward the click affordance.
const title = (t, hovered) => [
  <Text height="1" bold fg={hovered ? ACCENT : HEAD}>
    <Text>{t}</Text>
    {hovered ? <Text fg={LABEL}>{"   ◂ click to zoom"}</Text> : null}
  </Text>,
  <Text height="1" fg={hovered ? ACCENT : RULE}>{(hovered ? "━" : "─").repeat(200)}</Text>,
];

const gap = () => <Text height="1">{" "}</Text>;

// Colour a 0..1 fraction with the same three-band split we use elsewhere:
// green under 60 %, amber 60–85 %, red past 85 %.
const heat = (f) => (f > 0.85 ? idx(1) : f > 0.6 ? idx(3) : idx(2));

// One sparkline row: fixed-width label + fixed-width current value + a
// fixed-width bar of the last ~SPARK_W samples. ~40 samples at the 1.5 s
// poll cadence is a rolling 60 s window, which is long enough to see a
// workload rise and settle without the bar dominating the column.
const SPARK_W = 32;
const sparkRow = (label, valueText, series, peak, faceFg) => (
  <Text height="1">
    <Text fg={LABEL}>{"  " + label.padEnd(KV_LABEL_W)}</Text>
    <Text fg={faceFg} bold>{valueText.padEnd(10)}</Text>
    <Text fg={faceFg}>{sparkline(series, SPARK_W, peak)}</Text>
  </Text>
);

// The OVERVIEW pane is deliberately just the live metrics. The container's
// identity (name, image, state, uptime) now lives in the Detail title bar
// where it's always visible even while scrolled; the id, image digest,
// storage driver, platform and started-at strings weren't survivable in a
// glance-worthy layout and moved to `zoom overview` where there's room.
function overview(c, hovered) {
  const busy = c._cpuFraction ?? cpuFraction(c.stats);
  const mem = c.stats?.memory_stats;
  const memUse = Number(mem?.usage ?? 0);
  const memLim = Number(mem?.limit ?? 0);
  const memFrac = memLim > 0 ? memUse / memLim : 0;

  // Sparklines read the history array the probe accumulates per tick.
  // CPU and mem are already fractions so pass `peak=1`; network counters
  // are cumulative, so `deltas()` turns them into per-tick rate samples
  // and `sparkline()` auto-scales to the running max of that window.
  const h = c._history ?? [];
  const cpuHist = h.map((s) => s.cpu);
  const memHist = h.map((s) => s.mem);
  const rxHist  = deltas(h.map((s) => s.rx));
  const txHist  = deltas(h.map((s) => s.tx));
  const rxPeak  = Math.max(1, ...rxHist);
  const txPeak  = Math.max(1, ...txHist);
  const rxLast  = rxHist.length ? rxHist[rxHist.length - 1] : 0;
  const txLast  = txHist.length ? txHist[txHist.length - 1] : 0;
  const dt      = 1.5;                    // seconds per sample, matches the poll cadence

  const out = [
    ...title("OVERVIEW", hovered),
    sparkRow("cpu", fmtPct(busy),                 cpuHist, 1,      heat(busy)),
    sparkRow("mem", fmtPct(memFrac),              memHist, 1,      heat(memFrac)),
    sparkRow("rx",  `${fmtBytes(rxLast / dt)}/s`, rxHist,  rxPeak, idx(2)),
    sparkRow("tx",  `${fmtBytes(txLast / dt)}/s`, txHist,  txPeak, idx(4)),
    gap(),
    // Only show the memory limit when it looks like a real cap (i.e.
    // materially less than host memory). Docker defaults `limit` to the
    // whole host, which then reads as noise — the sparkline already
    // shows the fraction anyway.
    kv("memory", memLim > 0 && memLim < 1024 ** 4 && memFrac > 0.001
      ? `${fmtBytes(memUse)} / ${fmtBytes(memLim)}`
      : fmtBytes(memUse)),
    kv("pids", c.stats?.pids_stats
      ? `${c.stats.pids_stats.current ?? "-"} running`
      : "-"),
  ];

  // Extra identity fields only when zoomed (i.e. there's space) or when
  // the value is non-default worth surfacing.
  const extras = [];
  if ((c.restart_count ?? 0) > 0) extras.push(kv("restarts", String(c.restart_count)));
  if (hovered) {
    // In hover state we're still small; keep extras minimal.
  }
  out.push(...extras);
  out.push(gap());
  return out;
}

// The verbose OVERVIEW body is available when the user zooms the pane —
// there's room for the full snapshot then. Called from the zoom dispatch.
function overviewZoomed(c) {
  const base = overview(c, false);
  // Append the id/image/driver/etc fields the compact view drops.
  base.pop();                                // trailing gap
  base.push(
    kv("id", shortId(c.id)),
    kv("image", c.image),
    kv("image id", shortId(c.image_id ?? "")),
    kv("platform", c.platform),
    kv("driver", c.driver),
    kv("restarts", String(c.restart_count ?? 0)),
    kv("started", c.state_full?.started_at),
    gap(),
  );
  return base;
}

function networking(c, hovered) {
  const ns = c.network_settings;
  const nets = ns?.networks ?? [];
  const bindings = ns?.ports ?? [];
  const iface = c.stats?.networks ?? [];
  const out = [...title("NETWORKING", hovered)];

  // One compact block per attached network. Empty fields are hidden —
  // shipping "aliases: -" for every container was noise; when there's
  // real data it still shows.
  if (nets.length === 0) {
    out.push(<Text height="1" fg={LABEL}>{"  (no networks attached)"}</Text>);
  } else {
    for (const n of nets) {
      const cidr = n.ip_address?.addr ? `${n.ip_address.addr}/${n.ip_prefix_len ?? ""}` : null;
      out.push(
        <Text height="1">
          <Text fg={ACCENT} bold>{`  ● ${n.name}`.padEnd(16)}</Text>
          <Text>{cidr ?? "-"}</Text>
          {n.gateway?.addr && <Text fg={LABEL}>{`   via ${n.gateway.addr}`}</Text>}
        </Text>,
      );
      if (n.mac_address) {
        out.push(<Text height="1" fg={LABEL}>{`  ${" ".repeat(14)}${n.mac_address}`}</Text>);
      }
      const aliases = (n.aliases ?? []).filter(Boolean);
      if (aliases.length) {
        out.push(<Text height="1" fg={LABEL}>{`  ${" ".repeat(14)}${aliases.join(", ")}`}</Text>);
      }
    }
  }

  // Host↔container port mappings — the most-clicked "where do I reach it"
  // detail, so painted with a distinct arrow.
  if (bindings.length > 0) {
    out.push(gap());
    for (const p of bindings) {
      out.push(
        <Text height="1">
          <Text fg={LABEL}>{"  port  "}</Text>
          <Text bold>{`${p.name ?? ""}`.padEnd(10)}</Text>
          <Text fg={ACCENT}>{"→ "}</Text>
          <Text>{`${p.host_ip?.addr ?? "*"}:${p.host_port ?? "-"}`}</Text>
        </Text>,
      );
    }
  }

  // Live rx/tx counters per interface (the aggregate is on the OVERVIEW
  // sparklines; this breaks it out per device).
  if (iface.length > 0) {
    out.push(gap());
    for (const n of iface) {
      out.push(
        <Text height="1">
          <Text fg={LABEL}>{`  ${(n.interface_name ?? "?").padEnd(8)}`}</Text>
          <Text fg={idx(2)}>{`↓ ${fmtBytes(n.rx_bytes).padEnd(8)}`}</Text>
          <Text fg={idx(4)}>{`↑ ${fmtBytes(n.tx_bytes)}`}</Text>
        </Text>,
      );
    }
  }

  out.push(gap());
  return out;
}

// One line per mount: type badge + rw/ro + host path → container path.
// The driver / propagation / mode noise was low-signal on-screen and
// only surfaces now via `zoom volumes`.
function volumes(c, hovered) {
  const m = c.mounts ?? [];
  const out = [...title("MOUNTS", hovered)];
  if (m.length === 0) {
    out.push(<Text height="1" fg={LABEL}>{"  (no mounts)"}</Text>);
  } else {
    for (const mp of m) {
      const typ = (mp.typ ?? "?").toString().toLowerCase();
      out.push(
        <Text height="1" overflow="ellipsis">
          <Text fg={ACCENT} bold>{`  ${typ.padEnd(7)}`}</Text>
          <Text fg={mp.rw ? idx(2) : idx(3)}>{`${mp.rw ? "rw" : "ro"}  `}</Text>
          <Text>{`${mp.source ?? ""}`}</Text>
          <Text fg={ACCENT}>{" → "}</Text>
          <Text>{`${mp.destination ?? ""}`}</Text>
        </Text>,
      );
    }
  }
  out.push(gap());
  return out;
}

function ports(c, hovered) {
  const p = c.ports ?? [];
  if (p.length === 0) return [];
  const out = [...title("EXPOSED PORTS", hovered)];
  for (const port of p) {
    out.push(
      <Text height="1">
        <Text bold>{`  ${(port.typ ?? "").toString().padEnd(5)}`}</Text>
        <Text>{`${port.ip ?? "*"}:${port.public_port ?? "-"}  →  container ${port.private_port}`}</Text>
      </Text>,
    );
  }
  out.push(gap());
  return out;
}

// Colour a process state char the way `top` does — R green, D/T amber,
// Z red, everything else dim.
const procStateColor = (s) =>
  s === "R" ? idx(2) : s === "Z" ? idx(1) : (s === "D" || s === "T") ? idx(3) : LABEL;

// Case-insensitive contains for a filter substring. Empty filter is
// truthy for every row (short-circuits — no per-row lowercasing when
// there's nothing to match).
const passesFilter = (filter, ...fields) => {
  if (!filter) return true;
  const f = filter.toLowerCase();
  for (const s of fields) if (s && String(s).toLowerCase().includes(f)) return true;
  return false;
};

function processes(c, filter, limitOverride, hovered) {
  const all = c._procs ?? [];
  const rows = filter
    ? all.filter((p) => passesFilter(filter, p.stat?.comm, (p.cmdline ?? []).join(" "), String(p.pid ?? "")))
    : all;
  const label = filter
    ? `PROCESSES  (${rows.length} of ${all.length}, filter="${filter}")`
    : `PROCESSES  (${rows.length})`;
  const out = [...title(label, hovered)];
  // The `procs` query rides along with inspect and is the most likely thing
  // to fail on a busy host — if it did, say so instead of implying the
  // container has no processes.
  if (c._procsError) {
    out.push(<Text height="1" fg={idx(1)}>{"  ✗ process query failed:"}</Text>);
    out.push(<Text height="1" fg={LABEL} break="anywhere">{`    ${c._procsError}`}</Text>);
    out.push(gap());
    return out;
  }
  if (rows.length === 0) {
    out.push(<Text height="1" fg={LABEL}>{filter
      ? "  (no processes match the filter)"
      : "  (none — container has no running processes)"}</Text>);
    out.push(gap());
    return out;
  }
  // Trimmed to the columns that read at a glance: pid, state, rss, comm,
  // cmdline. PPID and thread count moved to the id-heavy view of `top`;
  // we're a container explorer, not a full process debugger.
  out.push(
    <Text height="1" fg={LABEL} bold>
      <Text>{"  "}</Text>
      <Text>{"PID".padEnd(8)}</Text>
      <Text>{"S".padEnd(3)}</Text>
      <Text>{"RSS".padEnd(9)}</Text>
      <Text>{"COMM".padEnd(16)}</Text>
      <Text>{"CMDLINE"}</Text>
    </Text>,
  );
  const MAX = limitOverride ?? 20;
  for (const p of rows.slice(0, MAX)) {
    const st = p.stat ?? {};
    const cmd = (p.cmdline ?? []).join(" ") || `[${st.comm ?? "?"}]`;
    out.push(
      <Text height="1" overflow="ellipsis">
        <Text>{"  "}</Text>
        <Text>{String(p.pid ?? "").padEnd(8)}</Text>
        <Text fg={procStateColor(st.state)} bold>{(st.state ?? "?").padEnd(3)}</Text>
        <Text>{fmtBytes(st.rss_bytes ?? 0).padEnd(9)}</Text>
        <Text bold>{(st.comm ?? "").padEnd(16)}</Text>
        <Text fg={LABEL}>{cmd}</Text>
      </Text>,
    );
  }
  if (rows.length > MAX) {
    out.push(<Text height="1" fg={LABEL}>{`  … ${rows.length - MAX} more`}</Text>);
  }
  out.push(gap());
  return out;
}

// Colour by stream: stdout dim white, stderr red, console default, stdin cyan.
const logColor = (stream) => {
  switch (stream) {
    case "stderr":  return idx(1);
    case "stdout":  return idx(252);
    case "console": return idx(250);
    case "stdin":   return idx(6);
    default: return LABEL;
  }
};

// Render the tail of the logs signal. Capped at TAIL rows so the section
// occupies a predictable slice of the scrollable body; the full backlog
// lives in the signal for anyone who wants a wider view later.
function logs(logRows, filter, tailOverride, hovered) {
  const TAIL = tailOverride ?? 30;
  const matched = filter
    ? (logRows ?? []).filter((r) => passesFilter(filter, r.text))
    : (logRows ?? []);
  const label = filter
    ? `LOGS  (last ${TAIL}, filter="${filter}", ${matched.length} match${matched.length === 1 ? "" : "es"})`
    : `LOGS  (last ${TAIL})`;
  const out = [...title(label, hovered)];
  if (matched.length === 0) {
    out.push(<Text height="1" fg={LABEL}>{filter
      ? "  (no lines match the filter)"
      : "  (waiting for output…)"}</Text>);
    out.push(gap());
    return out;
  }
  const slice = matched.slice(-TAIL);
  for (const { stream, text } of slice) {
    const isErr = stream === "stderr";
    out.push(
      <Text height="1" overflow="ellipsis">
        <Text fg={isErr ? idx(1) : LABEL} bold={isErr}>{isErr ? "  ! " : "    "}</Text>
        <Text fg={logColor(stream)}>{text}</Text>
      </Text>,
    );
  }
  out.push(gap());
  return out;
}

// One line: the full argv joined together. `path` and `args` split was
// a Docker artefact; on-screen it reads as one command.
function command(c, hovered) {
  const a = c.args ?? [];
  if (a.length === 0 && !c.path) return [];
  const full = [c.path, ...a].filter(Boolean).join(" ");
  return [
    ...title("COMMAND", hovered),
    <Text height="1" overflow="ellipsis"><Text>{"  "}</Text><Text>{full}</Text></Text>,
    gap(),
  ];
}

// Fixed chrome around the scrollable body: title row + rule at the top,
// footer at the bottom (owned by Root), plus one scroll-status line above
// and below the body. `available = size.rows - CHROME` is the scroll
// window's height.
const CHROME = 2 /* title + rule */ + 1 /* top scroll bar */ + 1 /* bottom scroll bar */ + 1 /* Root footer */;

// Assemble every section into one flat row array. Broken out because the
// bottom scroll-indicator needs the same total row count as the body, and
// duplicating the composition risked drift.
//
// Two layouts, selected by terminal width:
//
//   narrow  (cols < WIDE)  — everything stacked in one column, in reading
//                            order: metadata → processes → logs → command.
//   wide    (cols ≥ WIDE)  — metadata (overview / networking / volumes /
//                            ports / command) on the left, and processes +
//                            logs stacked on the right. Rows from the two
//                            columns are zipped, so a single scroll offset
//                            walks both sides in lockstep — one shorter
//                            side just runs out of content sooner and its
//                            rows fill with blanks.
//
// A wide terminal wastes a lot of horizontal space in the narrow layout
// (metadata rows are short key/value pairs), so this reclaims it for the
// two content-heavy sections that actually benefit from the width.
const WIDE = 140;

const blank = () => <Text height="1">{" "}</Text>;

// Merge one row from each side into a single `direction="row"` block. The
// two Box halves are `1fr` so they always share the row equally; `hidden`
// overflow keeps a too-wide log line from bleeding into the left column.
const pairRow = (l, r) => (
  <Box height="1" width="1fr" direction="row">
    <Box width="1fr" overflow="hidden">{l ?? blank()}</Box>
    <Text width="2" fg={RULE}>{" │"}</Text>
    <Box width="1fr" overflow="hidden">{r ?? blank()}</Box>
  </Box>
);

// Dispatch a pane name to its row-producing function. Keeps the zoom
// path from having to duplicate the composition below. `hovered` flows
// through so a pane under the mouse pointer picks up the highlighted
// title/rule when it renders.
const paneRows = (pane, c, logRows, filter, opts = {}, hovered = false) => {
  switch (pane) {
    // Zoomed overview shows the extended identity fields that the compact
    // overview drops — we finally have the vertical space for them.
    case "overview":   return opts.zoomed ? overviewZoomed(c) : overview(c, hovered);
    case "networking": return networking(c, hovered);
    case "volumes":    return volumes(c, hovered);
    case "ports":      return ports(c, hovered);
    case "processes":  return processes(c, filter, opts.processLimit, hovered);
    case "logs":       return logs(logRows, filter, opts.logTail, hovered);
    case "command":    return command(c, hovered);
    default: return [];
  }
};

// Turn a list of [pane, rowsArray] into a flat rows array + a set of
// { pane, start, end } spans so a click at flat-row index `i` can be
// mapped back to the pane that owns it.
const flattenWithSpans = (sections) => {
  const rows = [];
  const spans = [];
  for (const [pane, r] of sections) {
    const start = rows.length;
    for (const row of r) rows.push(row);
    spans.push({ pane, start, end: rows.length });
  }
  return { rows, spans };
};

// One-stop layout computation: returns the flat rows to render *and* the
// pane-span metadata the mouse handler needs. Duplicating those two paths
// was risky — they must agree exactly on which flat index belongs to what
// pane, so they share a single function.
const buildLayout = (c, logRows, cols, filter, zoom, hoveredPane) => {
  const isHovered = (p) => hoveredPane === p;
  if (zoom) {
    const rows = paneRows(zoom, c, logRows, filter, { processLimit: 500, logTail: 500, zoomed: true });
    // Zoomed → the entire body is that one pane; clicking anywhere in
    // it unzooms (the main.jsx handler treats a click while zoomed as
    // toggle-off, so we don't need per-span data here).
    return { rows, panesLeft: [{ pane: zoom, start: 0, end: rows.length }], panesRight: [], wide: false };
  }

  const metaSections = [
    ["overview",   overview(c, isHovered("overview"))],
    ["networking", networking(c, isHovered("networking"))],
    ["volumes",    volumes(c, isHovered("volumes"))],
    ["ports",      ports(c, isHovered("ports"))],
    ["command",    command(c, isHovered("command"))],
  ];
  const streamSections = [
    ["processes", processes(c, filter, undefined, isHovered("processes"))],
    ["logs",      logs(logRows, filter, undefined, isHovered("logs"))],
  ];
  const meta   = flattenWithSpans(metaSections);
  const stream = flattenWithSpans(streamSections);
  const wide = (cols ?? 0) >= WIDE;

  if (!wide) {
    // Narrow → stack. Shift the stream spans by meta.length so their
    // flat indices sit after the meta rows.
    const shifted = stream.spans.map((s) => ({ pane: s.pane, start: s.start + meta.rows.length, end: s.end + meta.rows.length }));
    return {
      rows: [...meta.rows, ...stream.rows],
      panesLeft: [...meta.spans, ...shifted],
      panesRight: [],
      wide: false,
    };
  }

  // Wide → zip rows so left/right walk in lockstep, but keep their
  // spans distinct so the mouse handler can pick a side by clientX.
  const n = Math.max(meta.rows.length, stream.rows.length);
  const rows = new Array(n);
  for (let i = 0; i < n; i++) rows[i] = pairRow(meta.rows[i], stream.rows[i]);
  return { rows, panesLeft: meta.spans, panesRight: stream.spans, wide: true };
};

// Back-compat wrapper for the few callers that only need the rows.
const buildRows = (c, logRows, cols, filter, zoom, hoveredPane) =>
  buildLayout(c, logRows, cols, filter, zoom, hoveredPane).rows;

// Live layout snapshot the parent's mousedown handler reads. Populated on
// every Detail render (properties on a plain object — not a signal write,
// so it's safe from render context). The `paneOfPoint` closure is rebuilt
// each frame with the latest scroll offset and section spans baked in.
export const detailHit = {
  paneOfPoint: () => null,
};

// One `detailFor()` + `logsFor()` signal pair per detail mount. Both are
// `from()` producers, so their kernel-facing work (poll timer, docker
// logs subscription) starts on first read and stops when this subtree
// unmounts. Nothing to tear down by hand at the caller.
export default function Detail({ name, scroll, size, zoom, filter, filterEditing, hoveredPane }) {
  const data = detailFor(name);
  const logsSig = logsFor(name);
  return (
    <Box height="1fr" overflow="hidden">
      {/* Title row — the container's identity is here so it's always in
          view even when scrolled deep into logs. State glyph is coloured
          so the running-vs-crashed status jumps at you from a distance.
          Zoom / filter badges append on the right when active. */}
      <Box height="1" width="1fr" direction="row">
        <Text bold fg={HEAD}>{`  ${name}`}</Text>
        {/* Identity/status — one thunk that reads `data` and paints the
            image, state glyph, and human status with correct colours. */}
        {() => {
          const c = data.get();
          if (!c) return <Text fg={LABEL}>{"  loading…"}</Text>;
          if (c._error) return <Text fg={idx(1)} bold>{"  ✗ inspect failed"}</Text>;
          const s = (c.state_full?.status ?? c.state ?? "").toString().toUpperCase();
          // `inspect_container.status` is usually null — the list view is
          // where the human "Up 3 hours" string lives. We synthesise it
          // from state_full.started_at, which is present on inspect.
          const up = fmtUptimeISO(c.state_full?.started_at);
          return (
            <Text>
              <Text fg={LABEL}>{"  ·  "}</Text>
              <Text fg={LABEL}>{c.config?.image ?? c.image ?? ""}</Text>
              <Text fg={LABEL}>{"  ·  "}</Text>
              <Text fg={stateColor(s)} bold>{`${stateGlyph(s)} ${s || "?"}`}</Text>
              {up && <Text fg={LABEL}>{`  up ${up}`}</Text>}
            </Text>
          );
        }}
        {/* Right-side badges: zoom / filter, only when active. */}
        <Text fg={ACCENT}>{() => {
          const z = zoom.get();
          const f = filter.get();
          const editing = filterEditing.get();
          const parts = [];
          if (z)         parts.push(`◆ ${z.toUpperCase()} zoomed`);
          if (editing)   parts.push(`/${f}▏`);
          else if (f)    parts.push(`filter: "${f}"`);
          return parts.length ? "     " + parts.join("   ") : "";
        }}</Text>
      </Box>
      <Text height="1" fg={RULE}>{"─".repeat(200)}</Text>

      {/* Scroll indicator above the body — how many rows are hidden up. */}
      <Text height="1" fg={LABEL}>{() => {
        const s = scroll.get();
        return s > 0 ? `  ▲ ${s} more above` : "";
      }}</Text>

      <Box height="1fr" overflow="hidden">
        {() => {
          const c = data.get();
          if (!c) return <Text fg={LABEL}>loading…</Text>;
          // Nothing usable came back from inspect — show the actual reason
          // instead of an eternal "loading…". This is what makes an ECS /
          // non-standard-daemon failure diagnosable rather than a blank page.
          if (c._error) {
            return [
              <Text height="1" fg={idx(1)} bold>{`  ✗ could not inspect "${c._name ?? name}"`}</Text>,
              <Text height="1">{" "}</Text>,
              <Text height="1" fg={LABEL} break="anywhere">{`  ${c._error}`}</Text>,
              <Text height="1">{" "}</Text>,
              <Text height="1" fg={LABEL}>{"  the list still refreshes — esc to go back"}</Text>,
            ];
          }
          const { rows: term = 24, cols = 80 } = size.get();
          const layout = buildLayout(c, logsSig.get(), cols, filter.get(), zoom.get(), hoveredPane.get());
          const visible = Math.max(1, term - CHROME);
          // Clamp the scroll signal against the actual content length —
          // one authoritative place. `scroll.set()` inside a render is
          // illegal, so defer to a microtask.
          const max = Math.max(0, layout.rows.length - visible);
          const cur = scroll.get();
          const clamped = Math.min(cur, max);
          if (clamped !== cur) Promise.resolve().then(() => scroll.set(clamped));

          // Publish a fresh hit-test closure for the parent's mouse
          // handler. It closes over the current spans + scroll + split
          // column, so a click routes to whatever's under the pointer
          // right now — even in the middle of a live log burst.
          const halfCol = Math.floor(cols / 2);
          const chromeAbove = 1 /* TitleBar */ + 1 /* detail title */ + 1 /* rule */ + 1 /* top scroll indicator */;
          detailHit.paneOfPoint = (x, y) => {
            const bodyY = y - chromeAbove;
            if (bodyY < 0 || bodyY >= visible) return null;
            const flat = clamped + bodyY;
            const spans = layout.wide
              ? (x < halfCol ? layout.panesLeft : layout.panesRight)
              : layout.panesLeft;
            for (const s of spans) if (flat >= s.start && flat < s.end) return s.pane;
            return null;
          };

          return layout.rows.slice(clamped, clamped + visible);
        }}
      </Box>

      {/* Scroll indicator below the body — how many rows are hidden down. */}
      <Text height="1" fg={LABEL}>{() => {
        const c = data.get();
        if (!c || c._error) return "";
        const { rows: term = 24, cols = 80 } = size.get();
        const total = buildRows(c, logsSig.get(), cols, filter.get(), zoom.get(), hoveredPane.get()).length;
        const visible = Math.max(1, term - CHROME);
        const below = Math.max(0, total - scroll.get() - visible);
        return below > 0 ? `  ▼ ${below} more below` : "";
      }}</Text>
    </Box>
  );
}

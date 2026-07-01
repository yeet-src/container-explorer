// container-explorer — interactive TUI for browsing running containers.
//
//   list view   : one row per container with summary stats
//                 ↑/↓ to move, enter to drill in
//   detail view : full inspect for the selected container — state,
//                 networking, mounts, ports, live cpu/mem/net counters
//                 esc/backspace to return to the list
//
// Layout: probes/ (graph-aware) → components/ (pure UI) → main.jsx (routing).
// The view signal drives which subtree is mounted, and swapping it is what
// starts/stops the per-container detail poll (via `from()` in the probe).
import { Box, mount, signal } from "yeet:tui";
import { containers, status } from "@/probes/containers.js";
import List from "@/components/list.jsx";
import Detail, { detailHit } from "@/components/detail.jsx";
import { TitleBar, Footer } from "@/components/chrome.jsx";
import { cleanName } from "@/lib/format.js";

// UI state — all reactivity flows from these signals.
const view = signal("list");     // "list" | "detail"
const selected = signal(0);      // row index into containers.get()
const focused = signal(null);    // container name active in detail view
const detailScroll = signal(0);  // first visible row of the detail body

// Which pane is fullscreened inside the detail view (null = normal split).
// Values line up with the number keys 1–7 below and with the render
// dispatcher in `components/detail.jsx`.
const zoom = signal(null);       // null | "overview"|"networking"|"volumes"|"ports"|"processes"|"logs"|"command"

// Filter substring applied to the PROCESSES and LOGS panes. Editing state
// is a separate signal so the key handler can capture typing while the
// buffer is being built up.
const filter = signal("");
const filterEditing = signal(false);

// Which pane the mouse is currently over, so Detail can highlight it as
// clickable. Motion tracking (1003) is opt-in per handler registration,
// and the runtime enables it automatically once we attach `mousemove`.
const hoveredPane = signal(null);

// Key-to-pane map — one lookup shared by the digit binding and the title-bar
// legend. Order picks the natural reading of the page top-to-bottom.
const PANES = ["overview", "networking", "volumes", "ports", "processes", "logs", "command"];

const rowCount = () => (containers.get() ?? []).length;

const clampSelection = () => {
  const n = rowCount();
  if (n === 0) selected.set(0);
  else if (selected.get() >= n) selected.set(n - 1);
};

const move = (d) => {
  const n = rowCount();
  if (n === 0) return;
  selected.set(Math.max(0, Math.min(n - 1, selected.get() + d)));
};

const open = () => {
  const rows = containers.get() ?? [];
  const c = rows[selected.get()];
  if (!c) return;
  focused.set(cleanName(c.name ?? c.names?.[0]));
  detailScroll.set(0);           // fresh drill-in → top of the page
  zoom.set(null);                // and the normal split layout
  filter.set("");
  filterEditing.set(false);
  hoveredPane.set(null);
  view.set("detail");
};

const back = () => { hoveredPane.set(null); view.set("list"); };

// Toggle a pane between zoomed-fullscreen and normal. Same digit twice
// unzooms — matches the way tiling window managers do "maximise this".
const toggleZoom = (pane) => {
  if (zoom.get() === pane) { zoom.set(null); return; }
  zoom.set(pane);
  detailScroll.set(0);           // fresh viewport when we change what's shown
};

// While zoomed, step to the adjacent pane (wrapping) without leaving zoom —
// left/right walks the same PANES order the digit keys use. No-op when not
// zoomed, so the caller can gate on that to keep ←/→ meaning "back" otherwise.
const cycleZoom = (d) => {
  const cur = zoom.get();
  if (!cur) return;
  const i = PANES.indexOf(cur);
  zoom.set(PANES[(i + d + PANES.length) % PANES.length]);
  detailScroll.set(0);           // fresh viewport for the newly-shown pane
};

// Detail view scrolling — the Detail component clamps against its actual
// content height, so we just accept unbounded deltas here and let it pin.
const scrollBy = (d) => detailScroll.set(Math.max(0, detailScroll.get() + d));

tty.on("keydown", (e) => {
  const code = e.code;
  const k = (e.key ?? "").toLowerCase();

  // Filter-edit mode is a modal input: capture almost everything so the
  // usual bindings don't fire while the user is typing a filter.
  if (view.get() === "detail" && filterEditing.get()) {
    if (code === "Enter")     { filterEditing.set(false); return; }
    if (code === "Escape")    { filter.set(""); filterEditing.set(false); return; }
    if (code === "Backspace") { filter.set(filter.get().slice(0, -1)); return; }
    // Accept any single printable character. `e.key` is the "logical" key
    // in most terminals, so Shift-a arrives as "A" without extra work.
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey) {
      filter.set(filter.get() + e.key);
      return;
    }
    return;                     // swallow the rest
  }

  if (k === "q" || (e.ctrlKey && k === "c")) return yeet.exit();

  if (view.get() === "list") {
    if (code === "ArrowUp"   || k === "k") return move(-1);
    if (code === "ArrowDown" || k === "j") return move(1);
    if (code === "PageUp")   return move(-10);
    if (code === "PageDown") return move(10);
    if (code === "Home") return selected.set(0);
    if (code === "End")  return selected.set(Math.max(0, rowCount() - 1));
    if (code === "Enter" || code === "ArrowRight" || k === "l") return open();
  } else {
    // Escape drills out one level at a time: zoom → filter → list.
    if (code === "Escape") {
      if (zoom.get())       return zoom.set(null);
      if (filter.get())     return filter.set("");
      return back();
    }
    // While zoomed, ←/→ (and vim h/l) walk between panes instead of backing
    // out — cycleZoom is a no-op when not zoomed, so the back() fallthrough
    // below still handles ←/h in the normal split layout.
    if (zoom.get()) {
      if (code === "ArrowLeft"  || k === "h") return cycleZoom(-1);
      if (code === "ArrowRight" || k === "l") return cycleZoom(1);
    }
    if (code === "Backspace" || code === "ArrowLeft" || k === "h") return back();

    // Digit → zoom that pane. `1`…`7` map to PANES in order; pressing
    // the same digit again unzooms. `0` is an explicit "unzoom".
    if (e.key && e.key >= "1" && e.key <= String(PANES.length)) {
      return toggleZoom(PANES[Number(e.key) - 1]);
    }
    if (e.key === "0") return zoom.set(null);

    // Enter filter mode (`/`). `c` clears an existing filter without
    // re-entering the edit loop — handy when you just want to reset.
    if (e.key === "/") { filterEditing.set(true); return; }
    if (k === "c" && !e.ctrlKey) { filter.set(""); return; }

    // Scrolling — unchanged from before.
    if (code === "ArrowUp"   || k === "k") return scrollBy(-1);
    if (code === "ArrowDown" || k === "j") return scrollBy(1);
    if (code === "PageUp")               return scrollBy(-10);
    if (code === "PageDown" || k === " ") return scrollBy(10);
    // Case of `e.key` distinguishes `g`/`G` here — cheaper than trusting
    // `e.shiftKey`, which isn't always set for a bare capital letter.
    if (code === "Home" || e.key === "g") return detailScroll.set(0);
    if (code === "End"  || e.key === "G") return detailScroll.set(1e9);
  }
});

// Mouse:
//   list view    — click a row to select, click the same row again to open
//   detail view  — click any pane to zoom / unzoom it (the pane hit-test
//                  closure is published each frame by Detail via `detailHit`,
//                  and the current zoom state doubles as "any click while
//                  zoomed backs out")
tty.on?.("mousedown", (e) => {
  if (e.button !== 0) return;
  if (view.get() === "list") {
    const row = e.clientY - 3;   // title + header + rule
    if (row < 0 || row >= rowCount()) return;
    if (row === selected.get()) return open();
    selected.set(row);
    return;
  }
  if (view.get() === "detail") {
    if (filterEditing.get()) return;    // mid-typing → ignore clicks
    if (zoom.get()) { zoom.set(null); return; }
    const pane = detailHit.paneOfPoint?.(e.clientX, e.clientY);
    if (pane) toggleZoom(pane);
  }
});

tty.on?.("wheel", (e) => {
  if (view.get() === "detail") scrollBy(e.deltaY > 0 ? 3 : -3);
});

// Registering a `mousemove` handler flips the runtime into any-motion (1003)
// tracking. Motion reports fire per cell crossed, so we compare and only
// publish when the hovered pane actually changes — otherwise the signal
// would edge on every wiggle and re-render the whole tree for nothing.
tty.on?.("mousemove", (e) => {
  if (view.get() !== "detail" || zoom.get() || filterEditing.get()) {
    if (hoveredPane.get()) hoveredPane.set(null);
    return;
  }
  const p = detailHit.paneOfPoint?.(e.clientX, e.clientY) ?? null;
  if (p !== hoveredPane.get()) hoveredPane.set(p);
});

// Keep selection in-bounds as the list mutates under us (containers can
// appear or disappear between polls). Deferred out of any render path.
setInterval(clampSelection, 500);

// `size` is the terminal's reactive size signal — reading it inside the
// body thunk reflows the whole tree on resize, and lets Detail size its
// visible window from the actual terminal height.
const Root = (size) => (
  <Box>
    <TitleBar containers={containers} />
    <Box height="1fr" overflow="hidden">
      {() => (view.get() === "list"
        ? <List containers={containers} selected={selected} status={status} />
        : <Detail
            name={focused.get()}
            scroll={detailScroll}
            size={size}
            zoom={zoom}
            filter={filter}
            filterEditing={filterEditing}
            hoveredPane={hoveredPane}
          />)}
    </Box>
    <Footer view={view} filterEditing={filterEditing} zoom={zoom} />
  </Box>
);

mount(Root);
await new Promise(() => {});

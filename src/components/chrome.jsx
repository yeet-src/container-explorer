// components/chrome.jsx — the two 1-row bars that frame the app.
//
// The bars deliberately show only what a first-time viewer needs at
// a glance: the app's identity, one live count, and a compact hint of
// what keys work in the current mode. Everything else (status prose,
// view-name badges, verbose key legends) turned out to be noise on
// screen and has been removed.
import { Box, Text, idx } from "yeet:tui";

const ACCENT = idx(4);
const DIM = idx(244);
const BG = idx(236);

export function TitleBar({ containers }) {
  // The emoji occupies two terminal cells but ANSI cursor math treats it
  // as one, so we bake a trailing space into the title span (rather than
  // relying on a sibling Text that would land in the wrong column).
  return (
    <Box height="1" direction="row" bg={BG}>
      <Text bold fg={ACCENT}>{"  🐳  container-explorer   "}</Text>
      <Text fg={DIM}>{() => {
        const n = (containers.get() ?? []).length;
        return `${n} container${n === 1 ? "" : "s"} running`;
      }}</Text>
    </Box>
  );
}

export function Footer({ view, filterEditing, zoom }) {
  return (
    <Box height="1" direction="row" bg={BG}>
      <Text fg={DIM}>{() => {
        if (view.get() === "list") return " ↑↓ move   enter open   q quit";
        if (filterEditing?.get()) return " typing filter…   enter accept   esc cancel";
        if (zoom?.get()) return " ↑↓ scroll   ←→ switch pane   1-7 jump   esc unzoom   q quit";
        return " ↑↓ scroll   click/1-7 zoom   / filter   esc back   q quit";
      }}</Text>
    </Box>
  );
}

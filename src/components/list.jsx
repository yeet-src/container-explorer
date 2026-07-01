// components/list.jsx — the top-level table. Deliberately spare: one
// state glyph, the container name, its image, its age, and a live
// status. The container id, port count and mount count all live in the
// detail view; showing them here just competed for attention with the
// two fields most viewers actually need (name and state).
import { Box, Text, idx } from "yeet:tui";
import { cleanName, ellipsize, fmtAge, pad, stateColor, statusColor, stateGlyph } from "@/lib/format.js";

const HEADER = idx(250);
const DIM = idx(244);
const SEL_BG = idx(238);

// Fixed widths sum on-purpose to ≲ 80 cols; STATUS is a flex slot
// ("1fr") so it absorbs everything past AGE and grows into a wide
// terminal instead of leaving empty gutter. Yoga in a row container
// would otherwise shrink every fixed cell proportionally and eat the
// padding — which manifests as columns visually butting together, hence
// the explicit `pad()` in each cell.
const COLS = {
  glyph: 2,
  name: 28,
  image: 30,
  age: 8,
};

function Header() {
  return (
    <Box height="1" width="1fr" direction="row">
      <Text width="1" fg={HEADER} bold>{" "}</Text>
      <Text width={`${COLS.glyph + 1}`} fg={HEADER} bold>{" "}</Text>
      <Text width={`${COLS.name + 1}`} fg={HEADER} bold>{pad("NAME", COLS.name + 1)}</Text>
      <Text width={`${COLS.image + 1}`} fg={HEADER} bold>{pad("IMAGE", COLS.image + 1)}</Text>
      <Text width={`${COLS.age + 1}`} fg={HEADER} bold>{pad("UP", COLS.age + 1)}</Text>
      <Text width="1fr" fg={HEADER} bold>{"STATUS"}</Text>
    </Box>
  );
}

// One row. The selected row wears a bg tint on the whole rect; per-cell
// fg colours still show through because bg is a rect-level property.
function Row({ c, selected }) {
  const name = cleanName(c.name ?? c.names?.[0]);
  const glyph = stateGlyph(c.state);
  const scolor = stateColor(c.state);
  const bg = selected ? SEL_BG : undefined;
  return (
    <Box height="1" width="1fr" direction="row" bg={bg}>
      <Text width="1" fg={scolor} bold>{selected ? "▶" : " "}</Text>
      <Text width={`${COLS.glyph + 1}`} fg={scolor} bold>{pad(glyph, COLS.glyph + 1)}</Text>
      <Text width={`${COLS.name + 1}`} bold>{pad(ellipsize(name, COLS.name), COLS.name + 1)}</Text>
      <Text width={`${COLS.image + 1}`} fg={DIM}>{pad(ellipsize(c.image ?? "", COLS.image), COLS.image + 1)}</Text>
      <Text width={`${COLS.age + 1}`}>{pad(fmtAge(c.created), COLS.age + 1)}</Text>
      <Text width="1fr" fg={statusColor(c)} overflow="ellipsis">{c.status ?? ""}</Text>
    </Box>
  );
}

export default function List({ containers, selected, status }) {
  return (
    <Box height="1fr" overflow="hidden">
      <Header />
      <Text height="1" fg={DIM}>{"─".repeat(200)}</Text>
      <Box height="1fr" overflow="hidden">
        {() => {
          const rows = containers.get() ?? [];
          if (rows.length === 0) {
            return (
              <Box padding={1}>
                <Text fg={DIM}>{() => `no containers — ${status.get()}`}</Text>
              </Box>
            );
          }
          const cur = selected.get();
          return rows.map((c, i) => <Row c={c} selected={i === cur} />);
        }}
      </Box>
    </Box>
  );
}

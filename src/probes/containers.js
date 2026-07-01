// probes/containers.js — poll the docker graph for a container list, plus a
// per-container detail probe that only runs while the detail panel is up.
//
//   containers : signal<[Container]>       — refreshed every LIST_MS
//   status     : signal<string>            — human-readable probe health
//   detailFor(name) : signal<Container|null> — full inspect + stats, tied to
//                                              its own polling lifecycle via
//                                              `from()` (starts on first
//                                              watch, stops on unwatch).
//
// Fields kept in sync with sys_graph SDL — see `yeet graph dump`.
import { from, signal } from "yeet:tui";
import { subscribe } from "yeet:graph";

const LIST_MS = 2000;   // list refresh cadence
const DETAIL_MS = 1500; // per-container detail refresh cadence

// The list query is deliberately lean: only what the summary table shows.
// `stats` on the list summary is null in practice, so we omit it and pull
// live counters through inspect_container on the detail view instead.
const LIST_QUERY = `{
  docker {
    list_containers {
      id
      name
      names
      image
      command
      created
      state
      status
      ports { private_port public_port typ ip }
      mounts { typ source destination rw }
    }
  }
}`;

// One heavy query, but only while the detail panel is on screen.
// `inspect_container` yields the full network_settings + stats snapshot;
// the top-level `procs` come along in the same round-trip so the detail
// view can filter to the ones whose cgroup path names this container
// (see `procsInContainer` below).
//
// yeet.graph.query only takes a query string (no variables), so we
// build one per name with an inline literal — safe because the name
// comes from `list_containers`, not user input.
const buildDetailQuery = (name) => `{
  procs {
    pid
    cmdline
    stat { comm state ppid rss_bytes utime stime num_threads }
    cgroups { pathname }
  }
  docker {
    inspect_container(container_name: ${JSON.stringify(name)}) {
      id
      name
      image
      image_id
      # config.image is the human tag (e.g. nginx:alpine); the top-level
      # image on an inspect payload is the digest. UI prefers the tag.
      config { image }
      command
      created_str
      state
      status
      restart_count
      driver
      platform
      path
      args
      ports { private_port public_port typ ip }
      mounts {
        typ source destination driver mode rw propagation
      }
      state_full {
        status running paused restarting oom_killed dead
        pid exit_code error started_at finished_at
      }
      network_settings {
        bridge sandbox_id
        ports { name host_ip { addr } host_port }
        networks {
          name ip_address { addr } ip_prefix_len gateway { addr } mac_address
          network_id aliases
        }
      }
      stats {
        read
        cpu_stats  { cpu_usage { total_usage } system_cpu_usage online_cpus }
        precpu_stats { cpu_usage { total_usage } system_cpu_usage }
        memory_stats { usage limit }
        pids_stats { current limit }
        networks { interface_name rx_bytes tx_bytes rx_packets tx_packets rx_errors tx_errors }
      }
    }
  }
}`;


export const status = signal("starting…");

export const containers = from((state) => {
  const tick = async () => {
    try {
      const { data, errors } = await yeet.graph.query(LIST_QUERY);
      if (errors?.length) {
        status.set(`graph: ${errors[0].message}`);
        return;
      }
      const list = data?.docker?.list_containers ?? [];
      state.set(list);
      status.set(list.length ? `tracking ${list.length}` : "no containers");
    } catch (e) {
      status.set(`error: ${e.message ?? e}`);
    }
  };
  const h = setInterval(tick, LIST_MS);
  tick();
  return () => clearInterval(h);
}, []);

// Returns a fresh signal that polls one container's inspect on a timer.
// Wrapped in `from()` so the polling lifecycle is tied to whoever is
// reading the signal — the detail view mounts/unmounts and the timer
// starts/stops with it, no manual cleanup at the caller.
export function detailFor(name) {
  return from((state) => {
    const q = buildDetailQuery(name);
    // Bounded ring of per-tick samples. Kept alongside the polling
    // closure (rather than on the container object) because the same
    // history has to survive across ticks, while the container payload
    // is replaced wholesale each time.
    //
    // The graph's `inspect_container` returns `precpu_stats` empty —
    // that field is only populated by Docker's streaming stats socket,
    // not the inspect snapshot. So we compute CPU deltas ourselves by
    // remembering the previous sample's raw cpu/system totals and
    // diffing at the next tick. Same formula Docker uses; see
    // https://docs.docker.com/reference/api/engine/version/v1.44/#tag/Container/operation/ContainerStats
    const HIST_MAX = 60;      // ~90 s at 1.5 s cadence
    const history = [];
    let prev = null;          // { cpuTotal, sysTotal, onlineCpus } from last tick
    const sumNet = (nets) => {
      let rx = 0, tx = 0;
      for (const n of nets ?? []) { rx += Number(n.rx_bytes ?? 0); tx += Number(n.tx_bytes ?? 0); }
      return { rx, tx };
    };
    const tick = async () => {
      try {
        const { data, errors } = await yeet.graph.query(q);
        const c = data?.docker?.inspect_container ?? null;
        // GraphQL returns partial `data` *alongside* `errors` — e.g. the
        // system-wide `procs` query timing out on a busy host still leaves
        // a good `inspect_container`. Only give up when there's genuinely
        // no container payload; otherwise render what we got and remember
        // the error so the affected pane can note it (rather than blanking
        // the whole page, which is what discarding on `errors?.length` did).
        if (!c) {
          const msg = errors?.[0]?.message ?? "inspect_container returned null (no such container?)";
          state.set({ _error: msg, _name: name });
          return;
        }
        c._procsError = errors?.length ? (errors[0].message ?? String(errors[0])) : null;
        c._procs = procsForContainer(data?.procs ?? [], c.id);
        // Snap the two totals we need for the next tick's delta.
        const cur = {
          cpuTotal:   Number(c.stats?.cpu_stats?.cpu_usage?.total_usage ?? 0),
          sysTotal:   Number(c.stats?.cpu_stats?.system_cpu_usage ?? 0),
          onlineCpus: Number(c.stats?.cpu_stats?.online_cpus ?? 1) || 1,
        };
        let cpuFrac = 0;
        if (prev) {
          const cpuDelta = cur.cpuTotal - prev.cpuTotal;
          const sysDelta = cur.sysTotal - prev.sysTotal;
          if (sysDelta > 0 && cpuDelta >= 0) {
            cpuFrac = (cpuDelta / sysDelta) * cur.onlineCpus;
          }
        }
        c._cpuFraction = cpuFrac;    // so the render side doesn't have to redo the math
        prev = cur;
        // Sample metrics that make sense to trend: cpu fraction, memory
        // fraction, and cumulative rx/tx (rates come from successive
        // diffs at render time via `deltas()`). Sampling here — inside
        // the poll — lines up with the poll cadence, so the sparkline
        // x-axis is the poll clock.
        const mem = c.stats?.memory_stats;
        const memUse = Number(mem?.usage ?? 0);
        const memLim = Number(mem?.limit ?? 0);
        const net = sumNet(c.stats?.networks);
        history.push({
          cpu: cpuFrac,
          mem: memLim > 0 ? memUse / memLim : 0,
          rx: net.rx,
          tx: net.tx,
        });
        while (history.length > HIST_MAX) history.shift();
        c._history = history.slice();
        state.set(c);
      } catch (e) {
        // Transient error: keep the last-good snapshot if we have one, but
        // don't leave the very first load stuck on "loading…" — surface it.
        const prevVal = state.get();
        if (!prevVal || prevVal._error) {
          state.set({ _error: e.message ?? String(e), _name: name });
        }
      }
    };
    const h = setInterval(tick, DETAIL_MS);
    tick();
    return () => clearInterval(h);
  }, null);
}

// Filter the system-wide `procs` list to just the ones whose cgroup
// path names this container id — that's how the daemon groups docker
// processes on cgroups v2 (`/system.slice/docker-<id>.scope/…`) and
// under `docker` on v1. We match on any substring of the full id so
// nested cgroups (e.g. an exec into the container) come along too.
export function procsForContainer(procs, containerId) {
  if (!containerId) return [];
  const needle = containerId.slice(0, 32);   // enough to be unique
  const out = [];
  for (const p of procs) {
    for (const cg of (p.cgroups ?? [])) {
      if ((cg.pathname ?? "").includes(needle)) { out.push(p); break; }
    }
  }
  // Sort by rss desc so the "biggest" workers surface first; init/pid1
  // still stays visible because we cap the row count in the component.
  out.sort((a, b) => (b.stat?.rss_bytes ?? 0) - (a.stat?.rss_bytes ?? 0));
  return out;
}

// Tail one container's logs into a bounded ring-array signal. `from()`
// starts the GraphQL subscription when the signal is first watched and
// tears it down (via GraphSubscription.unsubscribe) when unwatched — so
// the daemon-side stream only exists while the detail panel is mounted.
//
// Each event is a union member (`stdout | stderr | console | stdin`);
// we tag each captured line with its stream so the UI can colour stderr.
export function logsFor(name, capacity = 500) {
  return from((state) => {
    const rows = [];           // {stream, text}, newest at end
    const push = (stream, msg) => {
      // Docker log messages often end with "\n"; split on newlines so a
      // multi-line burst turns into distinct rows rather than one blob.
      const s = (msg ?? "").replace(/\n+$/, "");
      if (!s) return;
      for (const line of s.split("\n")) rows.push({ stream, text: line });
      while (rows.length > capacity) rows.shift();
    };
    // A signal write per line on a chatty container would stall the
    // render loop. Coalesce into a snapshot on a fixed cadence — one
    // repaint per window, no matter how many lines arrived.
    const h = setInterval(() => state.set(rows.slice()), 250);
    let subP = subscribe(
      `subscription {
        docker_logs(
          container_name: ${JSON.stringify(name)},
          opts: { follow: true, stdout: true, stderr: true, tail: "200" }
        ) {
          __typename
          ... on stdout  { message }
          ... on stderr  { message }
          ... on console { message }
          ... on stdin   { message }
        }
      }`,
      (event) => {
        const ev = event?.data?.docker_logs ?? event?.docker_logs ?? event;
        if (!ev) return;
        push(ev.__typename ?? "stdout", ev.message);
      },
      (err) => push("stderr", `[logs error: ${err?.message ?? err}]`),
    );
    return () => {
      clearInterval(h);
      subP.then((s) => s.unsubscribe()).catch(() => {});
    };
  }, []);
}

// Compute the CPU busy fraction from two consecutive stats snapshots.
// This is the docker canonical formula — see `docker stats` source.
export function cpuFraction(stats) {
  if (!stats?.cpu_stats || !stats?.precpu_stats) return 0;
  const cur = stats.cpu_stats;
  const pre = stats.precpu_stats;
  const cpuDelta = Number(cur.cpu_usage?.total_usage ?? 0)
                 - Number(pre.cpu_usage?.total_usage ?? 0);
  const sysDelta = Number(cur.system_cpu_usage ?? 0)
                 - Number(pre.system_cpu_usage ?? 0);
  const online = Number(cur.online_cpus ?? 1) || 1;
  if (sysDelta <= 0 || cpuDelta < 0) return 0;
  return (cpuDelta / sysDelta) * online;
}

// (self-test removed — bundling collapses modules, so `import.meta.main`
// would fire from the entry bundle. Run the query with `yeet graph query`
// directly if you need to eyeball the shape.)

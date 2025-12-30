// jazz_egonet_explorer_netlify_hybrid.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";

type NodeDatum = {
  id: string;
  name: string;
  instruments?: string; // e.g., "trumpet(12); flugelhorn(3)"
};

type EdgeDatum = {
  id: string;
  source: string;
  target: string;
  w_instr: number;
  w_credit: number;
};

type EvidenceMode = "instr" | "credit" | "both";
type ViewMode = "egonet" | "path";

type SimNode = d3.SimulationNodeDatum & NodeDatum;
type SimLink = d3.SimulationLinkDatum<SimNode> & {
  id: string;
  source: SimNode | string;
  target: SimNode | string;
  w_instr: number;
  w_credit: number;
};

function safeNum(x: any): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function parseGraphML(xmlText: string): { nodes: NodeDatum[]; edges: EdgeDatum[] } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const parserError = doc.getElementsByTagName("parsererror")[0];
  if (parserError) throw new Error("GraphML parse error: invalid XML.");

  const keyEls = Array.from(doc.getElementsByTagName("key"));
  const keyMap = new Map<string, string>();
  for (const k of keyEls) {
    const id = k.getAttribute("id") || "";
    const name = k.getAttribute("attr.name") || "";
    if (id && name) keyMap.set(id, name);
  }

  function getDataMap(el: Element): Record<string, string> {
    const out: Record<string, string> = {};
    const dataEls = Array.from(el.getElementsByTagName("data"));
    for (const d of dataEls) {
      const key = d.getAttribute("key") || "";
      const attrName = keyMap.get(key) || key;
      out[attrName] = (d.textContent || "").trim();
    }
    return out;
  }

  const nodeEls = Array.from(doc.getElementsByTagName("node"));
  const nodes: NodeDatum[] = nodeEls.map((n) => {
    const id = (n.getAttribute("id") || "").trim();
    const data = getDataMap(n);
    const name = (data["name"] || data["label"] || data["Name"] || id).trim();
    const instruments = (data["instruments"] || data["instrument"] || data["Instruments"] || "").trim();
    return { id, name, instruments };
  });

  const edgeEls = Array.from(doc.getElementsByTagName("edge"));
  const edges: EdgeDatum[] = edgeEls.map((e, idx) => {
    const source = (e.getAttribute("source") || "").trim();
    const target = (e.getAttribute("target") || "").trim();
    const data = getDataMap(e);
    const w_instr = safeNum(data["w_instr"] ?? data["wInstr"] ?? data["instr"] ?? 0);
    const w_credit = safeNum(data["w_credit"] ?? data["wCredit"] ?? data["credit"] ?? 0);
    const id = `${source}__${target}__${idx}`;
    return { id, source, target, w_instr, w_credit };
  });

  if (!nodes.length) throw new Error("No nodes found in GraphML.");
  return { nodes, edges };
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function topMatches(nodes: NodeDatum[], q: string, limit = 12): NodeDatum[] {
  const t = normalize(q);
  if (!t) return [];
  const starts: NodeDatum[] = [];
  const contains: NodeDatum[] = [];
  for (const n of nodes) {
    const nm = normalize(n.name);
    if (nm.startsWith(t)) starts.push(n);
    else if (nm.includes(t)) contains.push(n);
  }
  return [...starts, ...contains].slice(0, limit);
}

function displayStrength(e: Pick<EdgeDatum, "w_instr" | "w_credit">, mode: EvidenceMode): number {
  if (mode === "instr") return e.w_instr;
  if (mode === "credit") return e.w_credit;
  return e.w_instr + e.w_credit;
}

// Used ONLY for shortest-path weighting (favor performer links when both are allowed)
function costStrength(e: Pick<EdgeDatum, "w_instr" | "w_credit">, mode: EvidenceMode): number {
  if (mode === "instr") return e.w_instr;
  if (mode === "credit") return e.w_credit;
  return e.w_instr * 2 + e.w_credit;
}

function edgeAllowed(e: EdgeDatum, mode: EvidenceMode, minWeight: number): boolean {
  return displayStrength(e, mode) >= minWeight;
}

class MinHeap<T extends { key: number }> {
  private a: T[] = [];
  get size() {
    return this.a.length;
  }
  push(x: T) {
    this.a.push(x);
    this.bubbleUp(this.a.length - 1);
  }
  pop(): T | undefined {
    if (!this.a.length) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (this.a.length) {
      this.a[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }
  private bubbleUp(i: number) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].key <= this.a[i].key) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  private bubbleDown(i: number) {
    const n = this.a.length;
    while (true) {
      let m = i;
      const l = i * 2 + 1;
      const r = l + 1;
      if (l < n && this.a[l].key < this.a[m].key) m = l;
      if (r < n && this.a[r].key < this.a[m].key) m = r;
      if (m === i) break;
      [this.a[m], this.a[i]] = [this.a[i], this.a[m]];
      i = m;
    }
  }
}

function shortestPath(
  nodes: NodeDatum[],
  edges: EdgeDatum[],
  startId: string,
  endId: string,
  mode: EvidenceMode,
  minWeight: number,
  hopPenalty = 0.25
): string[] {
  const nodeSet = new Set(nodes.map((n) => n.id));
  if (!nodeSet.has(startId) || !nodeSet.has(endId)) return [];
  if (startId === endId) return [startId];

  const adj = new Map<string, Array<{ to: string; cost: number }>>();
  for (const n of nodes) adj.set(n.id, []);

  for (const e of edges) {
    if (!edgeAllowed(e, mode, minWeight)) continue;
    const s = costStrength(e, mode);
    const cost = 1 / (s + 1) + hopPenalty;
    adj.get(e.source)?.push({ to: e.target, cost });
    adj.get(e.target)?.push({ to: e.source, cost });
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  for (const n of nodes) {
    dist.set(n.id, Number.POSITIVE_INFINITY);
    prev.set(n.id, null);
  }
  dist.set(startId, 0);

  const heap = new MinHeap<{ id: string; key: number }>();
  heap.push({ id: startId, key: 0 });

  const visited = new Set<string>();

  while (heap.size) {
    const cur = heap.pop()!;
    if (visited.has(cur.id)) continue;
    visited.add(cur.id);

    if (cur.id === endId) break;

    const curDist = dist.get(cur.id) ?? Infinity;
    const nbrs = adj.get(cur.id) || [];
    for (const { to, cost } of nbrs) {
      if (visited.has(to)) continue;
      const nd = curDist + cost;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, cur.id);
        heap.push({ id: to, key: nd });
      }
    }
  }

  if (!Number.isFinite(dist.get(endId) ?? Infinity)) return [];

  const path: string[] = [];
  let cur: string | null = endId;
  while (cur) {
    path.push(cur);
    cur = prev.get(cur) || null;
  }
  path.reverse();
  return path[0] === startId ? path : [];
}

function buildEgonet(allNodes: NodeDatum[], allEdges: EdgeDatum[], focusId: string, mode: EvidenceMode, minWeight: number) {
  const neigh = new Set<string>([focusId]);
  for (const e of allEdges) {
    if (!edgeAllowed(e, mode, minWeight)) continue;
    if (e.source === focusId) neigh.add(e.target);
    if (e.target === focusId) neigh.add(e.source);
  }
  const nodes = allNodes.filter((n) => neigh.has(n.id));
  const neighSet = new Set(nodes.map((n) => n.id));
  const edges = allEdges.filter((e) => neighSet.has(e.source) && neighSet.has(e.target) && edgeAllowed(e, mode, minWeight));
  return { nodes, edges };
}

function buildPathSubgraph(allNodes: NodeDatum[], allEdges: EdgeDatum[], path: string[], mode: EvidenceMode, minWeight: number) {
  const set = new Set(path);
  const nodes = allNodes.filter((n) => set.has(n.id));

  const hopSet = new Set<string>();
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    hopSet.add(`${a}__${b}`);
    hopSet.add(`${b}__${a}`);
  }

  const edges = allEdges.filter((e) => edgeAllowed(e, mode, minWeight) && hopSet.has(`${e.source}__${e.target}`));
  return { nodes, edges };
}

export default function JazzNetworkExplorer() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverEdgeRef = useRef<EdgeDatum | null>(null);

  const [hoverEdgeBox, setHoverEdgeBoxState] = useState<EdgeDatum | null>(null);
  useEffect(() => {
    const fn = () => setHoverEdgeBoxState(hoverEdgeRef.current);
    window.addEventListener("hoveredgechange", fn);
    return () => window.removeEventListener("hoveredgechange", fn);
  }, []);

  function showTooltip(x: number, y: number, text: string) {
    const el = tooltipRef.current;
    if (!el) return;
    el.style.display = "block";
    el.style.left = `${x + 12}px`;
    el.style.top = `${y + 12}px`;
    el.textContent = text;
  }
  function moveTooltip(x: number, y: number) {
    const el = tooltipRef.current;
    if (!el) return;
    el.style.left = `${x + 12}px`;
    el.style.top = `${y + 12}px`;
  }
  function hideTooltip() {
    const el = tooltipRef.current;
    if (!el) return;
    el.style.display = "none";
    el.textContent = "";
  }
  function setHoverEdgeBox(edge: EdgeDatum | null) {
    hoverEdgeRef.current = edge;
    window.dispatchEvent(new Event("hoveredgechange"));
  }

  const [allNodes, setAllNodes] = useState<NodeDatum[]>([]);
  const [allEdges, setAllEdges] = useState<EdgeDatum[]>([]);
  const [loadError, setLoadError] = useState<string>("");

  const [viewMode, setViewMode] = useState<ViewMode>("egonet");
  const [evidenceMode, setEvidenceMode] = useState<EvidenceMode>("both");
  const [minWeight, setMinWeight] = useState<number>(1);

  const [focusId, setFocusId] = useState<string>("");
  const [startId, setStartId] = useState<string>("");
  const [endId, setEndId] = useState<string>("");

  const [egonetQuery, setEgonetQuery] = useState<string>("");
  const [startQuery, setStartQuery] = useState<string>("");
  const [endQuery, setEndQuery] = useState<string>("");

  const nodesSorted = useMemo(() => {
    const arr = [...allNodes];
    arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [allNodes]);

  const egonetMatches = useMemo(() => topMatches(nodesSorted, egonetQuery, 12), [nodesSorted, egonetQuery]);
  const startMatches = useMemo(() => topMatches(nodesSorted, startQuery, 12), [nodesSorted, startQuery]);
  const endMatches = useMemo(() => topMatches(nodesSorted, endQuery, 12), [nodesSorted, endQuery]);

  // Auto-load default GraphML from public/network_dual.graphml on startup
  useEffect(() => {
    if (allNodes.length > 0) return;

    fetch("/network_dual.graphml")
      .then((r) => {
        if (!r.ok) throw new Error(`Default GraphML fetch failed: HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        const { nodes, edges } = parseGraphML(text);
        setAllNodes(nodes);
        setAllEdges(edges);

        const byName = new Map(nodes.map((n) => [normalize(n.name), n.id]));
        const miles = byName.get("miles davis");
        const trane = byName.get("john coltrane");
        const fallback = nodes[0]?.id || "";

        setFocusId(miles || fallback);
        setStartId(miles || fallback);
        setEndId(trane || fallback);
      })
      .catch((err) => {
        console.warn("Default GraphML load failed:", err);
        setLoadError(String(err?.message || err));
      });
  }, [allNodes.length]);

  useEffect(() => {
    if (!allNodes.length) return;
    if (!focusId) setFocusId(allNodes[0].id);
    if (!startId) setStartId(allNodes[0].id);
    if (!endId) setEndId(allNodes[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNodes]);

  const active = useMemo(() => {
    if (!allNodes.length) {
      return {
        nodes: [] as NodeDatum[],
        edges: [] as EdgeDatum[],
        path: [] as string[],
      };
    }

    if (viewMode === "egonet") {
      const fid = focusId || allNodes[0]?.id;
      const ego = buildEgonet(allNodes, allEdges, fid, evidenceMode, minWeight);
      return { ...ego, path: [] as string[] };
    } else {
      const s = startId || allNodes[0]?.id;
      const t = endId || allNodes[0]?.id;
      const path = shortestPath(allNodes, allEdges, s, t, evidenceMode, minWeight, 0.25);
      const sub = buildPathSubgraph(allNodes, allEdges, path, evidenceMode, minWeight);
      return { ...sub, path };
    }
  }, [allNodes, allEdges, viewMode, focusId, startId, endId, evidenceMode, minWeight]);

  const currentPathNames = useMemo(() => {
    if (viewMode !== "path") return "";
    const idToName = new Map(allNodes.map((n) => [n.id, n.name]));
    const p = active.path;
    if (!p.length) return "(no path found under current filters)";
    return p.map((id) => idToName.get(id) || id).join(" → ");
  }, [viewMode, active.path, allNodes]);

  // D3 render
  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container) return;

    const width = container.clientWidth || 1100;
    const height = container.clientHeight || 720;

    const sel = d3.select(svg);
    sel.attr("viewBox", `0 0 ${width} ${height}`);
    sel.selectAll("*").remove();

    const zoomG = sel.append("g").attr("class", "zoom-layer");

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 6])
      .on("zoom", (event) => {
        zoomG.attr("transform", event.transform.toString());
      });

    sel.call(zoom as any);
    sel.on("dblclick.zoom", null);
    sel.on("dblclick", () => {
      sel.transition().duration(200).call((zoom as any).transform, d3.zoomIdentity);
    });

    const nodeById = new Map<string, SimNode>();
    const simNodes: SimNode[] = active.nodes.map((n) => {
      const sn: SimNode = { ...n };
      nodeById.set(n.id, sn);
      return sn;
    });

    const simLinks: SimLink[] = active.edges
      .map((e) => {
        const s = nodeById.get(e.source);
        const t = nodeById.get(e.target);
        if (!s || !t) return null;
        return { id: e.id, source: s, target: t, w_instr: e.w_instr, w_credit: e.w_credit } as SimLink;
      })
      .filter(Boolean) as SimLink[];

    const chargeStrength = simNodes.length < 60 ? -220 : -120;

    const sim = d3
      .forceSimulation<SimNode>(simNodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance((l) => {
            const ds = displayStrength(l, evidenceMode);
            const base = 95;
            return Math.max(26, base - Math.min(65, ds * 4));
          })
          .strength(0.22)
      )
      .force("charge", d3.forceManyBody().strength(chargeStrength))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide(18));

    const gLinks = zoomG.append("g").attr("class", "links");
    const gNodes = zoomG.append("g").attr("class", "nodes");

    const link = gLinks
      .selectAll("line")
      .data(simLinks)
      .enter()
      .append("line")
      .attr("stroke", "currentColor")
      .attr("stroke-opacity", 0.25)
      .attr("stroke-width", (d) => {
        const ds = displayStrength(d, evidenceMode);
        return Math.max(1.2, Math.min(6, 1.2 + ds * 0.15));
      })
      .on("mouseenter", (event, d) => {
        const edge: EdgeDatum = {
          id: d.id,
          source: (d.source as SimNode).id,
          target: (d.target as SimNode).id,
          w_instr: d.w_instr,
          w_credit: d.w_credit,
        };
        setHoverEdgeBox(edge);

        const ds = displayStrength(d, evidenceMode);
        const text =
          evidenceMode === "instr"
            ? `w_instr: ${d.w_instr}`
            : evidenceMode === "credit"
            ? `w_credit: ${d.w_credit}`
            : `w_instr: ${d.w_instr} • w_credit: ${d.w_credit} • strength: ${ds}`;

        showTooltip(event.clientX, event.clientY, text);
      })
      .on("mousemove", (event) => moveTooltip(event.clientX, event.clientY))
      .on("mouseleave", () => {
        setHoverEdgeBox(null);
        hideTooltip();
      });

    const focus = viewMode === "egonet" ? focusId : startId;

    const node = gNodes
      .selectAll("circle")
      .data(simNodes)
      .enter()
      .append("circle")
      .attr("r", (d) => (d.id === focus ? 13 : 10))
      .attr("fill", (d) => (d.id === focus ? "#0b5" : "currentColor"))
      .attr("fill-opacity", (d) => (d.id === focus ? 0.95 : 0.85));

    const label = gNodes
      .selectAll("text")
      .data(simNodes)
      .enter()
      .append("text")
      .text((d) => d.name)
      .attr("font-size", 11)
      .attr("dominant-baseline", "middle")
      .attr("text-anchor", "start")
      .attr("dx", (d) => (d.id === focus ? 16 : 14))
      .attr("fill", (d) => (d.id === focus ? "#0b5" : "currentColor"))
      .attr("fill-opacity", 0.9);

    node
      .on("mouseenter", (event, d) => {
        const inst = (d.instruments || "").trim();
        const text = inst ? `${d.name}\n${inst}` : d.name;
        showTooltip(event.clientX, event.clientY, text);
      })
      .on("mousemove", (event) => moveTooltip(event.clientX, event.clientY))
      .on("mouseleave", () => {
        if (!hoverEdgeRef.current) hideTooltip();
      });

    const drag = d3
      .drag<SVGCircleElement, SimNode>()
      .on("start", (event, d) => {
        (event.sourceEvent as any)?.stopPropagation?.();
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        (event.sourceEvent as any)?.stopPropagation?.();
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        (event.sourceEvent as any)?.stopPropagation?.();
        if (!event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    node.call(drag);

    sim.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as SimNode).x ?? 0)
        .attr("y1", (d) => (d.source as SimNode).y ?? 0)
        .attr("x2", (d) => (d.target as SimNode).x ?? 0)
        .attr("y2", (d) => (d.target as SimNode).y ?? 0);

      node.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0);
      label.attr("x", (d) => d.x ?? 0).attr("y", (d) => d.y ?? 0);
    });

    return () => sim.stop();
  }, [active.nodes, active.edges, evidenceMode, viewMode, focusId, startId]);

  return (
    <div style={{ padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ minWidth: 340, flex: "0 0 380px" }}>
          <h2 style={{ margin: "0 0 8px 0" }}>Jazz Network Explorer</h2>

          {loadError ? <div style={{ color: "crimson", marginBottom: 10 }}>{loadError}</div> : null}

          <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>View</div>
              <label style={{ display: "block" }}>
                <input type="radio" name="viewmode" checked={viewMode === "egonet"} onChange={() => setViewMode("egonet")} /> Egonet
              </label>
              <label style={{ display: "block" }}>
                <input type="radio" name="viewmode" checked={viewMode === "path"} onChange={() => setViewMode("path")} /> Shortest path
              </label>
            </div>

            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Evidence</div>
              <label style={{ display: "block" }}>
                <input type="radio" name="evidence" checked={evidenceMode === "instr"} onChange={() => setEvidenceMode("instr")} /> Instrument only
              </label>
              <label style={{ display: "block" }}>
                <input type="radio" name="evidence" checked={evidenceMode === "credit"} onChange={() => setEvidenceMode("credit")} /> Credit only
              </label>
              <label style={{ display: "block" }}>
                <input type="radio" name="evidence" checked={evidenceMode === "both"} onChange={() => setEvidenceMode("both")} /> Both
              </label>
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Minimum link weight</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input
                type="range"
                min={1}
                max={10}
                value={minWeight}
                onChange={(e) => setMinWeight(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <input
                type="number"
                min={1}
                max={999}
                value={minWeight}
                onChange={(e) => setMinWeight(Math.max(1, Number(e.target.value) || 1))}
                style={{ width: 70, padding: "4px 6px" }}
              />
            </div>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>Increase to keep only stronger links.</div>
          </div>

          {allNodes.length ? (
            <>
              {viewMode === "egonet" ? (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>Find & set focus</div>
                    <input
                      value={egonetQuery}
                      onChange={(e) => setEgonetQuery(e.target.value)}
                      placeholder="Type a name (e.g., Coltrane)…"
                      style={{ width: "100%", padding: "6px 8px" }}
                    />
                    {egonetMatches.length ? (
                      <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {egonetMatches.map((n) => (
                          <button
                            key={n.id}
                            onClick={() => {
                              setFocusId(n.id);
                              setEgonetQuery("");
                            }}
                            style={{
                              fontSize: 12,
                              padding: "4px 8px",
                              borderRadius: 999,
                              border: "1px solid rgba(0,0,0,0.18)",
                              background: "white",
                              cursor: "pointer",
                            }}
                          >
                            {n.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>Focus artist (dropdown)</div>
                    <select value={focusId} onChange={(e) => setFocusId(e.target.value)} style={{ width: "100%", padding: "6px 8px" }}>
                      {nodesSorted.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>Choose start / end</div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>Start (type to search)</div>
                        <input
                          value={startQuery}
                          onChange={(e) => setStartQuery(e.target.value)}
                          placeholder="Type a name…"
                          style={{ width: "100%", padding: "6px 8px", marginBottom: 6 }}
                        />
                        {startMatches.length ? (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {startMatches.map((n) => (
                              <button
                                key={n.id}
                                onClick={() => {
                                  setStartId(n.id);
                                  setStartQuery("");
                                }}
                                style={{
                                  fontSize: 12,
                                  padding: "4px 8px",
                                  borderRadius: 999,
                                  border: "1px solid rgba(0,0,0,0.18)",
                                  background: "white",
                                  cursor: "pointer",
                                }}
                              >
                                {n.name}
                              </button>
                            ))}
                          </div>
                        ) : null}

                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>Start (dropdown)</div>
                          <select value={startId} onChange={(e) => setStartId(e.target.value)} style={{ width: "100%", padding: "6px 8px" }}>
                            {nodesSorted.map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div>
                        <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>End (type to search)</div>
                        <input
                          value={endQuery}
                          onChange={(e) => setEndQuery(e.target.value)}
                          placeholder="Type a name…"
                          style={{ width: "100%", padding: "6px 8px", marginBottom: 6 }}
                        />
                        {endMatches.length ? (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {endMatches.map((n) => (
                              <button
                                key={n.id}
                                onClick={() => {
                                  setEndId(n.id);
                                  setEndQuery("");
                                }}
                                style={{
                                  fontSize: 12,
                                  padding: "4px 8px",
                                  borderRadius: 999,
                                  border: "1px solid rgba(0,0,0,0.18)",
                                  background: "white",
                                  cursor: "pointer",
                                }}
                              >
                                {n.name}
                              </button>
                            ))}
                          </div>
                        ) : null}

                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>End (dropdown)</div>
                          <select value={endId} onChange={(e) => setEndId(e.target.value)} style={{ width: "100%", padding: "6px 8px" }}>
                            {nodesSorted.map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>

                    <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.35, opacity: 0.95 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>Path</div>
                      <div style={{ whiteSpace: "pre-wrap" }}>{currentPathNames}</div>
                    </div>
                  </div>
                </>
              )}
            </>
          ) : (
            <div style={{ fontSize: 13, opacity: 0.85 }}>Loading default dataset…</div>
          )}
        </div>

        <div
          ref={containerRef}
          style={{
            flex: "1 1 720px",
            minWidth: 520,
            height: 740,
            border: "1px solid rgba(0,0,0,0.12)",
            borderRadius: 10,
            position: "relative",
            overflow: "hidden",
          }}
        >
          <svg ref={svgRef} width="100%" height="100%" style={{ display: "block", color: "#111", background: "#fff" }} />

          <div
            ref={tooltipRef}
            style={{
              position: "fixed",
              display: "none",
              left: 0,
              top: 0,
              background: "rgba(0,0,0,0.85)",
              color: "white",
              padding: "8px 10px",
              borderRadius: 8,
              fontSize: 12,
              maxWidth: 380,
              whiteSpace: "pre-wrap",
              pointerEvents: "none",
              zIndex: 9999,
            }}
          />

          {hoverEdgeBox ? (
            <div
              style={{
                position: "absolute",
                left: 10,
                bottom: 10,
                fontSize: 12,
                background: "rgba(255,255,255,0.9)",
                border: "1px solid rgba(0,0,0,0.12)",
                borderRadius: 8,
                padding: "6px 8px",
              }}
            >
              <span style={{ fontWeight: 600 }}>Edge:</span> w_instr {hoverEdgeBox.w_instr} • w_credit {hoverEdgeBox.w_credit}
            </div>
          ) : null}
        </div>
      </div>

      {/* Bottom-left contact footer */}
      <div
        style={{
          position: "fixed",
          left: 16,
          bottom: 12,
          fontSize: 12,
          opacity: 0.85,
          background: "rgba(255,255,255,0.8)",
          border: "1px solid rgba(0,0,0,0.10)",
          borderRadius: 10,
          padding: "6px 10px",
        }}
      >
        Contact: Michael Frishkopf, michaelf@ualberta.ca
      </div>
    </div>
  );
}

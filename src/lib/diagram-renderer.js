/**
 * Diagram renderer — turns a node/edge spec into a self-contained HTML page
 * that renders as a clickable flowchart inside a canvas iframe.
 *
 * Clicking a node posts a message to the parent window so chat.js can
 * synthesize a follow-up question about that node.
 */

const KIND_STYLES = {
  trigger:    { bg: "#3a3935", border: "#5a5855", fg: "#ececec", label: "Trigger / storage" },
  processing: { bg: "#4a3d7a", border: "#6c5aa8", fg: "#ffffff", label: "Processing" },
  decision:   { bg: "#a87a2e", border: "#d1a44a", fg: "#1a1a1a", label: "Decision" },
  output:     { bg: "#2d6b5f", border: "#48a392", fg: "#ffffff", label: "Output" },
  note:       { bg: "transparent", border: "transparent", fg: "#a8a8a0", label: "Note" },
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function layout(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    outgoing.get(e.from).push(e.to);
    incoming.get(e.to).push(e.from);
  }

  const depth = new Map();
  const visit = (id, d = 0, stack = new Set()) => {
    if (stack.has(id)) return;
    depth.set(id, Math.max(depth.get(id) ?? 0, d));
    stack.add(id);
    for (const next of outgoing.get(id) || []) visit(next, d + 1, stack);
    stack.delete(id);
  };
  for (const n of nodes) if ((incoming.get(n.id) || []).length === 0) visit(n.id, 0);
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

  const rows = new Map();
  for (const n of nodes) {
    const d = depth.get(n.id);
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d).push(n);
  }

  const NODE_W = 260;
  const NODE_H = 80;
  const ROW_GAP = 60;
  const COL_GAP = 40;
  const CENTER_X = 400;

  const positions = new Map();
  const sortedDepths = [...rows.keys()].sort((a, b) => a - b);
  for (const d of sortedDepths) {
    const row = rows.get(d);
    const totalW = row.length * NODE_W + (row.length - 1) * COL_GAP;
    const startX = CENTER_X - totalW / 2;
    row.forEach((n, i) => {
      positions.set(n.id, {
        x: n.x ?? startX + i * (NODE_W + COL_GAP),
        y: n.y ?? 40 + d * (NODE_H + ROW_GAP),
        w: NODE_W,
        h: n.kind === "note" ? 50 : NODE_H,
      });
    });
  }
  return positions;
}

function renderNode(node, pos) {
  const style = KIND_STYLES[node.kind] || KIND_STYLES.processing;
  const label = esc(node.label || "");
  const sub = node.sublabel ? `<div class="sub">${esc(node.sublabel)}</div>` : "";
  const noteClass = node.kind === "note" ? " is-note" : "";
  return `<div class="node${noteClass}" data-node-id="${esc(node.id)}" data-label="${label}" data-sublabel="${esc(node.sublabel || "")}" style="left:${pos.x}px;top:${pos.y}px;width:${pos.w}px;height:${pos.h}px;background:${style.bg};border-color:${style.border};color:${style.fg}"><div class="label">${label}</div>${sub}</div>`;
}

function renderEdges(edges, positions) {
  const lines = [];
  for (const e of edges) {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const mx = (x1 + x2) / 2;
    const path = `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
    const label = e.label ? `<text x="${mx + 8}" y="${(y1 + y2) / 2}" fill="#a8a8a0" font-size="12" font-family="Poppins,sans-serif">${esc(e.label)}</text>` : "";
    lines.push(`<path d="${path}" stroke="#5a5855" stroke-width="2" fill="none" marker-end="url(#arrow)"/>${label}`);
  }
  return lines.join("");
}

function renderLegend(legend) {
  if (!legend || !legend.length) return "";
  const pills = legend.map((l) => {
    const s = KIND_STYLES[l.kind] || KIND_STYLES.processing;
    return `<div class="pill" style="background:${s.bg};border-color:${s.border};color:${s.fg}">${esc(l.label || s.label)}</div>`;
  }).join("");
  return `<div class="legend">${pills}</div>`;
}

/**
 * @param {object} spec
 * @param {string} spec.title
 * @param {Array<{id:string,label:string,sublabel?:string,kind:string,x?:number,y?:number,question?:string}>} spec.nodes
 * @param {Array<{from:string,to:string,label?:string}>} spec.edges
 * @param {Array<{kind:string,label?:string}>} [spec.legend]
 * @param {string} [spec.diagramId]
 */
export function renderDiagramHtml(spec) {
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const edges = Array.isArray(spec.edges) ? spec.edges : [];
  const positions = layout(nodes, edges);

  let maxX = 800, maxY = 400;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x + p.w + 40);
    maxY = Math.max(maxY, p.y + p.h + 40);
  }

  const nodesHtml = nodes.map((n) => renderNode(n, positions.get(n.id))).join("");
  const edgesSvg = renderEdges(edges, positions);
  const legendHtml = renderLegend(spec.legend);
  const questionMap = JSON.stringify(
    Object.fromEntries(nodes.filter((n) => n.question).map((n) => [n.id, n.question]))
  );

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(spec.title || "Diagram")}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #1a1a1a; color: #ececec; font-family: Poppins, -apple-system, sans-serif; padding: 20px; }
  .title { font-size: 18px; font-weight: 600; color: #f5a623; margin-bottom: 16px; }
  .stage { position: relative; width: ${maxX}px; height: ${maxY}px; margin: 0 auto; }
  svg.edges { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
  .node { position: absolute; border: 1.5px solid; border-radius: 10px; padding: 14px 18px; cursor: pointer; transition: transform .12s, box-shadow .12s; display: flex; flex-direction: column; justify-content: center; font-size: 14px; }
  .node:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(245,166,35,.25); border-color: #f5a623 !important; }
  .node .label { font-weight: 600; }
  .node .sub { font-size: 12px; opacity: .8; margin-top: 4px; font-weight: 400; }
  .node.is-note { border-style: dashed; cursor: default; font-style: italic; }
  .node.is-note:hover { transform: none; box-shadow: none; border-color: inherit !important; }
  .legend { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 20px; justify-content: center; }
  .pill { padding: 6px 12px; border-radius: 6px; font-size: 12px; border: 1.5px solid; }
</style>
</head>
<body>
<div class="title">${esc(spec.title || "Diagram")}</div>
<div class="stage">
  <svg class="edges" viewBox="0 0 ${maxX} ${maxY}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#5a5855"/>
      </marker>
    </defs>
    ${edgesSvg}
  </svg>
  ${nodesHtml}
</div>
${legendHtml}
<script>
(function() {
  const questions = ${questionMap};
  const diagramId = ${JSON.stringify(spec.diagramId || spec.title || "diagram")};
  document.querySelectorAll('.node:not(.is-note)').forEach((el) => {
    el.addEventListener('click', () => {
      const nodeId = el.dataset.nodeId;
      const label = el.dataset.label;
      const sublabel = el.dataset.sublabel;
      const question = questions[nodeId];
      try {
        window.parent.postMessage({
          type: 'tarsee:diagram-click',
          diagramId, nodeId, label, sublabel, question,
        }, '*');
      } catch (e) { /* sandboxed */ }
    });
  });
})();
</script>
</body>
</html>`;
}

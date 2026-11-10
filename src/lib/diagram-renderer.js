/**
 * Diagram renderer: turns a diagram's data (nodes, edges, legend) into the page that shows it as a clickable
 * flowchart. The server draws that page itself, on every request to /diagram/<id>/ (lib/canvas.js), from the data
 * create_diagram kept (lib/tools.js). The data never becomes code: every word in it is escaped text, positions are
 * numbers only, and the page's one script (DIAGRAM_SCRIPT) is the same for every diagram, with nothing from the data
 * in it. So the server's CSP can name that script by its hash and let nothing else run on the page, and a diagram's
 * clicks can be trusted (js/chat.js _initDiagramListener) even though the AI chose its words.
 *
 * A person's click on a node (or Enter or Space on it) posts one message to the chat:
 *   { type: "tarsee:diagram-click", diagramId, nodeId, label, sublabel, question?, click }
 * question is there only when the node has one (a string), and click counts that page's clicks from 1. The chat puts
 * the node's question in the message box and sends nothing: the AI chose those words, so the owner reads them and
 * sends them. Each node shows them before any click (its tooltip and its accessible name).
 */

// The rule for how a diagram's words show (ChatCore.oneLine): the dashboard's own file, so the chat folds what a click
// puts in the box exactly as the page here shows it. It is a plain script with no page in it: loaded, it sets
// globalThis.ChatCore.
import "../public/js/chat-core.js";

const { oneLine } = globalThis.ChatCore;

const KIND_STYLES = {
  trigger:    { bg: "#3a3935", border: "#5a5855", fg: "#ececec", label: "Trigger / storage" },
  processing: { bg: "#4a3d7a", border: "#6c5aa8", fg: "#ffffff", label: "Processing" },
  decision:   { bg: "#a87a2e", border: "#d1a44a", fg: "#1a1a1a", label: "Decision" },
  output:     { bg: "#2d6b5f", border: "#48a392", fg: "#ffffff", label: "Output" },
  note:       { bg: "transparent", border: "transparent", fg: "#a8a8a0", label: "Note" },
};

/** A kind Tarsee knows, else "processing". Own keys only: "constructor" or "__proto__" is not a kind. */
const kindOf = (kind) => (typeof kind === "string" && Object.hasOwn(KIND_STYLES, kind) ? kind : "processing");

const MAX_TEXT = 200;
const MAX_QUESTION = 500;
const MAX_POSITION = 10_000;

/** A string (a number as its digits), cut to `max`; anything else is "". */
function textOf(value, max = MAX_TEXT) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.slice(0, max) : "";
}

/**
 * Words (textOf) as they show: on one line (oneLine), so nothing in front of them (a run of blank lines, hundreds of
 * spaces or of characters that look blank) pushes them out of sight in the message box or makes it look empty, and no
 * marks stacked up over them. Folded before they are cut to `max`, with no space left at the cut. js/chat.js
 * _initDiagramListener folds what a click puts in the box with the same rule.
 */
function wordsOf(value, max = MAX_TEXT) {
  return typeof value === "string" ? oneLine(value, max) : textOf(value, max);
}

/** A position: a finite number, kept on the page; anything else is none (the layout places the node). */
function positionOf(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), MAX_POSITION) : undefined;
}

/**
 * A diagram's data as the renderer uses it, whatever it was given: what create_diagram keeps, and what the page is
 * drawn from, so a data file changed by hand is drawn the same safe way.
 *   { title, nodes: [{ id, label, sublabel, kind, x?, y?, question? }], edges: [{ from, to, label? }],
 *     legend: [{ kind, label? }] }
 * A node needs an id, and the first node with an id is the one kept. A question is kept only when it is a string
 * with words in it, so a node whose question is anything else asks about its label instead. Every word shown (the
 * title, labels, sublabels, questions) is folded to one line (wordsOf): what a click puts in the message box is all
 * in view, and the node's tooltip shows it as the box will. Ids are kept as written. An edge is kept only between two
 * nodes that are there.
 */
export function normalizeDiagramSpec(spec) {
  const s = spec && typeof spec === "object" ? spec : {};
  const ids = new Set();
  const nodes = [];
  for (const n of Array.isArray(s.nodes) ? s.nodes : []) {
    if (!n || typeof n !== "object") continue;
    const id = textOf(n.id);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    const node = { id, label: wordsOf(n.label), sublabel: wordsOf(n.sublabel), kind: kindOf(n.kind) };
    const x = positionOf(n.x);
    const y = positionOf(n.y);
    if (x !== undefined) node.x = x;
    if (y !== undefined) node.y = y;
    const question = typeof n.question === "string" ? wordsOf(n.question, MAX_QUESTION) : "";
    if (question) node.question = question;
    nodes.push(node);
  }
  const edges = [];
  for (const e of Array.isArray(s.edges) ? s.edges : []) {
    if (!e || typeof e !== "object") continue;
    const from = textOf(e.from);
    const to = textOf(e.to);
    if (!ids.has(from) || !ids.has(to)) continue;
    const label = wordsOf(e.label);
    edges.push(label ? { from, to, label } : { from, to });
  }
  const legend = [];
  for (const l of Array.isArray(s.legend) ? s.legend : []) {
    if (!l || typeof l !== "object") continue;
    const label = wordsOf(l.label);
    legend.push(label ? { kind: kindOf(l.kind), label } : { kind: kindOf(l.kind) });
  }
  return { title: wordsOf(s.title), nodes, edges, legend };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function layout(nodes, edges) {
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
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

/**
 * What a click on the node puts in the message box, as js/chat.js _initDiagramListener words it: its question, else
 * "Tell me more about: <label>" (and its sublabel). A note is not clicked, and a node with neither a label nor a
 * question asks nothing: "".
 */
function askOf(node) {
  if (node.kind === "note") return "";
  if (node.question) return node.question;
  if (!node.label) return "";
  return node.sublabel ? `Tell me more about: ${node.label}. ${node.sublabel}` : `Tell me more about: ${node.label}`;
}

function renderNode(node, pos) {
  const style = KIND_STYLES[node.kind];
  const label = esc(node.label);
  const sub = node.sublabel ? `<div class="sub">${esc(node.sublabel)}</div>` : "";
  const noteClass = node.kind === "note" ? " is-note" : "";
  const question = node.question ? ` data-question="${esc(node.question)}"` : "";
  // A node that asks something is a button that says what it puts in the box: as its tooltip, and as its name for a
  // screen reader (its label and sublabel first).
  const ask = askOf(node);
  const named = [node.label, node.sublabel].filter(Boolean).join(". ");
  const button = ask
    ? ` role="button" tabindex="0" title="${esc(`Adds to your message: ${ask}`)}" aria-label="${esc(`${named ? `${named}. ` : ""}Adds to your message: ${ask}`)}"`
    : "";
  return `<div class="node${noteClass}" data-node-id="${esc(node.id)}" data-label="${label}" data-sublabel="${esc(node.sublabel)}"${question}${button} style="left:${pos.x}px;top:${pos.y}px;width:${pos.w}px;height:${pos.h}px;background:${style.bg};border-color:${style.border};color:${style.fg}"><div class="label">${label}</div>${sub}</div>`;
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
  if (!legend.length) return "";
  const pills = legend.map((l) => {
    const s = KIND_STYLES[l.kind];
    return `<div class="pill" style="background:${s.bg};border-color:${s.border};color:${s.fg}">${esc(l.label || s.label)}</div>`;
  }).join("");
  return `<div class="legend">${pills}</div>`;
}

/**
 * The page's one script, the same for every diagram (the server's CSP names it by its hash, lib/canvas.js). It reads
 * what to send from the page (the body's data-diagram-id, each node's data-* attributes), so nothing from a diagram's
 * data is ever in it. It sends only for a person's click (not one a script made), one message per click: the second
 * click of a double-click is not another question. A node is a button, so Enter or Space on it is a click too: once
 * per press, when the key comes up after going down on that node. Not when it goes down: the chat then moves the focus
 * to the message box, and a key still held there would repeat into it (an Enter that sends the words). And a key
 * pressed twice quickly on a node (a double tap, a key's chatter) is one press, as a double-click is one click.
 */
export const DIAGRAM_SCRIPT = `
(function () {
  "use strict";
  var diagramId = document.body.getAttribute("data-diagram-id") || "";
  var clicks = 0;
  var pressed = null;
  var lastPress = { node: null, at: 0 };
  function isPress(event) {
    return event.isTrusted && (event.key === "Enter" || event.key === " ");
  }
  function onClick(event) {
    if (!event.isTrusted || event.detail > 1) return;
    tell(event.currentTarget);
  }
  function onKeyDown(event) {
    if (!isPress(event)) return;
    event.preventDefault();
    if (!event.repeat) pressed = { node: event.currentTarget, key: event.key };
  }
  function onKeyUp(event) {
    if (!isPress(event)) return;
    event.preventDefault();
    var press = pressed;
    pressed = null;
    if (!press || press.node !== event.currentTarget || press.key !== event.key) return;
    var at = Date.now();
    var again = lastPress.node === event.currentTarget && at - lastPress.at < 600;
    lastPress = { node: event.currentTarget, at: at };
    if (!again) tell(event.currentTarget);
  }
  function onBlur() {
    pressed = null;
  }
  function tell(node) {
    clicks += 1;
    var message = {
      type: "tarsee:diagram-click",
      diagramId: diagramId,
      nodeId: node.getAttribute("data-node-id") || "",
      label: node.getAttribute("data-label") || "",
      sublabel: node.getAttribute("data-sublabel") || "",
      click: clicks
    };
    if (node.hasAttribute("data-question")) message.question = node.getAttribute("data-question");
    try { window.parent.postMessage(message, "*"); } catch (err) { /* no window to tell */ }
  }
  Array.prototype.forEach.call(document.querySelectorAll(".node[role=button]"), function (node) {
    node.addEventListener("click", onClick);
    node.addEventListener("keydown", onKeyDown);
    node.addEventListener("keyup", onKeyUp);
    node.addEventListener("blur", onBlur);
  });
})();
`;

/**
 * The diagram's page.
 * @param {object} spec  a diagram's data (normalizeDiagramSpec says what is kept), plus diagramId: the id the page is
 *                       served at, which its clicks name
 */
export function renderDiagramHtml(spec) {
  const { title, nodes, edges, legend } = normalizeDiagramSpec(spec);
  const diagramId = typeof spec?.diagramId === "string" ? spec.diagramId : "";
  const positions = layout(nodes, edges);

  let maxX = 800, maxY = 400;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x + p.w + 40);
    maxY = Math.max(maxY, p.y + p.h + 40);
  }

  const nodesHtml = nodes.map((n) => renderNode(n, positions.get(n.id))).join("");
  const edgesSvg = renderEdges(edges, positions);
  const legendHtml = renderLegend(legend);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title || "Diagram")}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #1a1a1a; color: #ececec; font-family: Poppins, -apple-system, sans-serif; padding: 20px; }
  .title { font-size: 18px; font-weight: 600; color: #f5a623; margin-bottom: 16px; }
  .stage { position: relative; width: ${maxX}px; height: ${maxY}px; margin: 0 auto; }
  svg.edges { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
  .node { position: absolute; border: 1.5px solid; border-radius: 10px; padding: 14px 18px; cursor: pointer; transition: transform .12s, box-shadow .12s; display: flex; flex-direction: column; justify-content: center; font-size: 14px; }
  .node:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(245,166,35,.25); border-color: #f5a623 !important; }
  .node:focus-visible { outline: 2px solid #f5a623; outline-offset: 2px; }
  .node:not([role=button]) { cursor: default; }
  .node .label { font-weight: 600; }
  .node .sub { font-size: 12px; opacity: .8; margin-top: 4px; font-weight: 400; }
  .node.is-note { border-style: dashed; cursor: default; font-style: italic; }
  .node.is-note:hover { transform: none; box-shadow: none; border-color: inherit !important; }
  .legend { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 20px; justify-content: center; }
  .pill { padding: 6px 12px; border-radius: 6px; font-size: 12px; border: 1.5px solid; }
</style>
</head>
<body data-diagram-id="${esc(diagramId)}">
<div class="title">${esc(title || "Diagram")}</div>
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
<script>${DIAGRAM_SCRIPT}</script>
</body>
</html>`;
}

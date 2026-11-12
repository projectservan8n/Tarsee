//! Port of `src/lib/diagram-renderer.js`: turns a node/edge spec into a self-contained HTML page that renders as a
//! clickable flowchart inside a canvas iframe.
//!
//! Clicking a node posts a message to the parent window so the chat page can synthesize a follow-up question about
//! that node.
//!
//! The page is the browser's, so it must come out exactly as the JS made it, character for character. The spec is
//! the JSON the model wrote; where the JS let a JavaScript value through as it was (a node's `x` given as text is
//! joined, not added: `"100" + 130` is `"100130"`), [`JsVal`] does what JavaScript did.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::lib::workspace_files::jstext::js_string;
use crate::util::js::{number_to_string, truthy};

struct KindStyle {
    bg: &'static str,
    border: &'static str,
    fg: &'static str,
    label: &'static str,
}

const PROCESSING: KindStyle = KindStyle {
    bg: "#4a3d7a",
    border: "#6c5aa8",
    fg: "#ffffff",
    label: "Processing",
};

/// What `KIND_STYLES[kind]` found for an inherited name ("toString", "constructor", ...): a function or an object,
/// truthy, with none of the fields.
const INHERITED: KindStyle = KindStyle {
    bg: "undefined",
    border: "undefined",
    fg: "undefined",
    label: "undefined",
};

/// `KIND_STYLES[kind] || KIND_STYLES.processing`, the kind used as a property name.
fn kind_style(kind: Option<&Value>) -> &'static KindStyle {
    const TRIGGER: KindStyle = KindStyle {
        bg: "#3a3935",
        border: "#5a5855",
        fg: "#ececec",
        label: "Trigger / storage",
    };
    const DECISION: KindStyle = KindStyle {
        bg: "#a87a2e",
        border: "#d1a44a",
        fg: "#1a1a1a",
        label: "Decision",
    };
    const OUTPUT: KindStyle = KindStyle {
        bg: "#2d6b5f",
        border: "#48a392",
        fg: "#ffffff",
        label: "Output",
    };
    const NOTE: KindStyle = KindStyle {
        bg: "transparent",
        border: "transparent",
        fg: "#a8a8a0",
        label: "Note",
    };
    match js_string(kind).as_str() {
        "trigger" => &TRIGGER,
        "processing" => &PROCESSING,
        "decision" => &DECISION,
        "output" => &OUTPUT,
        "note" => &NOTE,
        "constructor" | "__defineGetter__" | "__defineSetter__" | "hasOwnProperty" | "__lookupGetter__"
        | "__lookupSetter__" | "isPrototypeOf" | "propertyIsEnumerable" | "toString" | "valueOf" | "__proto__"
        | "toLocaleString" => &INHERITED,
        _ => &PROCESSING,
    }
}

/// `String(s ?? "")` escaped for HTML text and attributes.
fn esc(s: Option<&Value>) -> String {
    let text = match s {
        None | Some(Value::Null) => String::new(),
        other => js_string(other),
    };
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// A JavaScript value as far as the layout's arithmetic sees one: `+` joins when either side is text.
#[derive(Debug, Clone, PartialEq)]
pub enum JsVal {
    Num(f64),
    Bool(bool),
    /// Text, or an object or array as the text it turns into.
    Str(String),
}

impl JsVal {
    fn from_value(value: &Value) -> JsVal {
        match value {
            Value::Number(n) => JsVal::Num(n.as_f64().unwrap_or(f64::NAN)),
            Value::Bool(b) => JsVal::Bool(*b),
            Value::String(s) => JsVal::Str(s.clone()),
            Value::Null => JsVal::Num(0.0),
            other => JsVal::Str(js_string(Some(other))),
        }
    }

    fn to_number(&self) -> f64 {
        match self {
            JsVal::Num(n) => *n,
            JsVal::Bool(b) => f64::from(u8::from(*b)),
            JsVal::Str(s) => string_to_number(s),
        }
    }

    fn add(&self, other: &JsVal) -> JsVal {
        match (self, other) {
            (JsVal::Str(_), _) | (_, JsVal::Str(_)) => JsVal::Str(format!("{self}{other}")),
            _ => JsVal::Num(self.to_number() + other.to_number()),
        }
    }
}

impl std::fmt::Display for JsVal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JsVal::Num(n) => f.write_str(&number_to_string(*n)),
            JsVal::Bool(b) => write!(f, "{b}"),
            JsVal::Str(s) => f.write_str(s),
        }
    }
}

/// `Number(text)`: blank is 0, otherwise the whole trimmed text must be a number.
fn string_to_number(s: &str) -> f64 {
    let t = crate::lib::workspace_files::jstext::js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |prefix: &str, radix: u32| {
        t.strip_prefix(prefix)
            .or_else(|| t.strip_prefix(&prefix.to_uppercase()))
            .map(|digits| {
                if digits.is_empty() {
                    f64::NAN
                } else {
                    u64::from_str_radix(digits, radix).map_or(f64::NAN, |v| v as f64)
                }
            })
    };
    if let Some(v) = radix("0x", 16).or_else(|| radix("0o", 8)).or_else(|| radix("0b", 2)) {
        return v;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let valid = t
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
        && t.chars().any(|c| c.is_ascii_digit());
    if !valid {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Math.max(a, b)`: NaN when either is NaN.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// A node's id as a Map key (`undefined` when the node has none).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key(Option<String>);

fn key_of(value: Option<&Value>) -> Key {
    // Map keys compare by value for text and numbers, as JSON ids are. The JSON text keeps 1 and "1" apart.
    Key(value.map(|v| v.to_string()))
}

struct Pos {
    x: JsVal,
    y: JsVal,
    w: f64,
    h: f64,
}

fn field<'a>(item: &'a Value, name: &str) -> Option<&'a Value> {
    item.as_object().and_then(|o| o.get(name))
}

/// `n.x ?? fallback`.
fn coordinate(item: &Value, name: &str, fallback: f64) -> JsVal {
    match field(item, name) {
        None | Some(Value::Null) => JsVal::Num(fallback),
        Some(v) => JsVal::from_value(v),
    }
}

fn layout(nodes: &[Value], edges: &[Value]) -> HashMap<Key, Pos> {
    let ids: HashSet<Key> = nodes.iter().map(|n| key_of(field(n, "id"))).collect();
    let mut incoming: HashMap<Key, Vec<Key>> = ids.iter().map(|k| (k.clone(), Vec::new())).collect();
    let mut outgoing: HashMap<Key, Vec<Key>> = ids.iter().map(|k| (k.clone(), Vec::new())).collect();
    for e in edges {
        let (from, to) = (key_of(field(e, "from")), key_of(field(e, "to")));
        if !ids.contains(&from) || !ids.contains(&to) {
            continue;
        }
        if let Some(list) = outgoing.get_mut(&from) {
            list.push(to.clone());
        }
        if let Some(list) = incoming.get_mut(&to) {
            list.push(from);
        }
    }

    fn visit(
        id: &Key,
        d: usize,
        stack: &mut HashSet<Key>,
        depth: &mut HashMap<Key, usize>,
        outgoing: &HashMap<Key, Vec<Key>>,
    ) {
        if stack.contains(id) {
            return;
        }
        let deepest = depth.get(id).copied().unwrap_or(0).max(d);
        depth.insert(id.clone(), deepest);
        stack.insert(id.clone());
        for next in outgoing.get(id).into_iter().flatten() {
            visit(next, d + 1, stack, depth, outgoing);
        }
        stack.remove(id);
    }

    let mut depth: HashMap<Key, usize> = HashMap::new();
    for n in nodes {
        let id = key_of(field(n, "id"));
        if incoming.get(&id).is_none_or(Vec::is_empty) {
            visit(&id, 0, &mut HashSet::new(), &mut depth, &outgoing);
        }
    }
    for n in nodes {
        depth.entry(key_of(field(n, "id"))).or_insert(0);
    }

    let mut rows: Vec<(usize, Vec<&Value>)> = Vec::new();
    for n in nodes {
        let d = depth[&key_of(field(n, "id"))];
        match rows.iter_mut().find(|(row_depth, _)| *row_depth == d) {
            Some((_, row)) => row.push(n),
            None => rows.push((d, vec![n])),
        }
    }

    const NODE_W: f64 = 260.0;
    const NODE_H: f64 = 80.0;
    const ROW_GAP: f64 = 60.0;
    const COL_GAP: f64 = 40.0;
    const CENTER_X: f64 = 400.0;

    let mut positions = HashMap::new();
    rows.sort_by_key(|(d, _)| *d);
    for (d, row) in rows {
        let total_w = row.len() as f64 * NODE_W + (row.len() as f64 - 1.0) * COL_GAP;
        let start_x = CENTER_X - total_w / 2.0;
        for (i, n) in row.into_iter().enumerate() {
            let is_note = field(n, "kind").and_then(Value::as_str) == Some("note");
            positions.insert(
                key_of(field(n, "id")),
                Pos {
                    x: coordinate(n, "x", start_x + i as f64 * (NODE_W + COL_GAP)),
                    y: coordinate(n, "y", 40.0 + d as f64 * (NODE_H + ROW_GAP)),
                    w: NODE_W,
                    h: if is_note { 50.0 } else { NODE_H },
                },
            );
        }
    }
    positions
}

fn render_node(node: &Value, pos: &Pos) -> String {
    let style = kind_style(field(node, "kind"));
    let label = esc(Some(field(node, "label").filter(|v| truthy(v)).unwrap_or(&Value::Null)));
    let sublabel = field(node, "sublabel").filter(|v| truthy(v));
    let sub = match sublabel {
        Some(s) => format!("<div class=\"sub\">{}</div>", esc(Some(s))),
        None => String::new(),
    };
    let note_class = if field(node, "kind").and_then(Value::as_str) == Some("note") {
        " is-note"
    } else {
        ""
    };
    format!(
        "<div class=\"node{note_class}\" data-node-id=\"{}\" data-label=\"{label}\" data-sublabel=\"{}\" style=\"left:{}px;top:{}px;width:{}px;height:{}px;background:{};border-color:{};color:{}\"><div class=\"label\">{label}</div>{sub}</div>",
        esc(field(node, "id")),
        esc(sublabel),
        pos.x,
        pos.y,
        number_to_string(pos.w),
        number_to_string(pos.h),
        style.bg,
        style.border,
        style.fg,
    )
}

fn render_edges(edges: &[Value], positions: &HashMap<Key, Pos>) -> String {
    let mut lines = String::new();
    for e in edges {
        let (Some(a), Some(b)) = (
            positions.get(&key_of(field(e, "from"))),
            positions.get(&key_of(field(e, "to"))),
        ) else {
            continue;
        };
        let x1 = a.x.add(&JsVal::Num(a.w / 2.0));
        let y1 = a.y.add(&JsVal::Num(a.h));
        let x2 = b.x.add(&JsVal::Num(b.w / 2.0));
        let y2 = b.y.clone();
        let mx = x1.add(&x2).to_number() / 2.0;
        let mid_y = number_to_string(y1.add(&y2).to_number() / 2.0);
        let path = format!("M {x1} {y1} C {x1} {mid_y}, {x2} {mid_y}, {x2} {y2}");
        let label = match field(e, "label").filter(|v| truthy(v)) {
            Some(text) => format!(
                "<text x=\"{}\" y=\"{mid_y}\" fill=\"#a8a8a0\" font-size=\"12\" font-family=\"Poppins,sans-serif\">{}</text>",
                number_to_string(mx + 8.0),
                esc(Some(text))
            ),
            None => String::new(),
        };
        lines.push_str(&format!(
            "<path d=\"{path}\" stroke=\"#5a5855\" stroke-width=\"2\" fill=\"none\" marker-end=\"url(#arrow)\"/>{label}"
        ));
    }
    lines
}

fn render_legend(legend: Option<&Value>) -> Result<String, String> {
    // `if (!legend || !legend.length) return ""`, then `legend.map(...)`.
    let items = match legend {
        Some(Value::Array(items)) if !items.is_empty() => items,
        Some(Value::String(s)) if !s.is_empty() => return Err("legend.map is not a function".into()),
        Some(Value::Object(o)) if o.get("length").is_some_and(truthy) => {
            return Err("legend.map is not a function".into());
        }
        _ => return Ok(String::new()),
    };
    let mut pills = String::new();
    for l in items {
        if l.is_null() {
            return Err("Cannot read properties of null (reading 'kind')".into());
        }
        let s = kind_style(field(l, "kind"));
        let text = match field(l, "label").filter(|v| truthy(v)) {
            Some(label) => esc(Some(label)),
            None => esc(Some(&Value::String(s.label.to_string()))),
        };
        pills.push_str(&format!(
            "<div class=\"pill\" style=\"background:{};border-color:{};color:{}\">{text}</div>",
            s.bg, s.border, s.fg
        ));
    }
    Ok(format!("<div class=\"legend\">{pills}</div>"))
}

/// Whether a property name is an array index, which JavaScript objects keep first, in number order.
fn is_array_index(key: &str) -> bool {
    !key.is_empty()
        && key.chars().all(|c| c.is_ascii_digit())
        && (key == "0" || !key.starts_with('0'))
        && key.parse::<u64>().is_ok_and(|n| n < u64::from(u32::MAX))
}

/// An object's keys in JavaScript's property order: array indexes ascending, then the rest as inserted.
fn js_key_order(object: &Map<String, Value>) -> Vec<&String> {
    let mut indexes: Vec<&String> = object.keys().filter(|k| is_array_index(k)).collect();
    indexes.sort_by_key(|k| k.parse::<u64>().unwrap_or(0));
    indexes.extend(object.keys().filter(|k| !is_array_index(k)));
    indexes
}

/// `JSON.stringify(value)`: numbers as JavaScript prints them, object keys in JavaScript's order.
fn js_json(value: &Value) -> String {
    match value {
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f.is_finite() { number_to_string(f) } else { "null".into() }
        }
        Value::Array(items) => format!("[{}]", items.iter().map(js_json).collect::<Vec<_>>().join(",")),
        Value::Object(object) => format!(
            "{{{}}}",
            js_key_order(object)
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), js_json(&object[k])))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

/// Safe to embed inside a <script> tag: `</`, line separators and paragraph separators escaped, so user-influenced
/// strings can't break out of the script context.
fn script_safe(value: &Value) -> String {
    js_json(value)
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Renders a diagram spec as a whole HTML page.
///
/// The spec: `{ title, nodes: [{ id, label, sublabel?, kind, x?, y?, question? }], edges: [{ from, to, label? }],
/// legend?: [{ kind, label? }], diagramId? }`.
///
/// An error is the message of what the JS threw on a malformed spec (a `null` node, edge or legend entry, or a
/// legend that is not a list), which the tool reported as `create_diagram error: <message>`.
pub fn render_diagram_html(spec: &Value) -> Result<String, String> {
    let empty = Vec::new();
    let nodes = field(spec, "nodes").and_then(Value::as_array).unwrap_or(&empty);
    let edges = field(spec, "edges").and_then(Value::as_array).unwrap_or(&empty);
    if nodes.iter().any(Value::is_null) {
        return Err("Cannot read properties of null (reading 'id')".into());
    }
    if edges.iter().any(Value::is_null) {
        return Err("Cannot read properties of null (reading 'from')".into());
    }
    let positions = layout(nodes, edges);

    let mut max_x = 800.0_f64;
    let mut max_y = 400.0_f64;
    // Every node has a position, and Math.max goes over them in the Map's order; only NaN cares about the order,
    // and NaN wins either way.
    for p in positions.values() {
        max_x = js_max(max_x, p.x.add(&JsVal::Num(p.w)).add(&JsVal::Num(40.0)).to_number());
        max_y = js_max(max_y, p.y.add(&JsVal::Num(p.h)).add(&JsVal::Num(40.0)).to_number());
    }
    let (max_x, max_y) = (number_to_string(max_x), number_to_string(max_y));

    let nodes_html: String = nodes
        .iter()
        .filter_map(|n| positions.get(&key_of(field(n, "id"))).map(|pos| render_node(n, pos)))
        .collect();
    let edges_svg = render_edges(edges, &positions);
    let legend_html = render_legend(field(spec, "legend"))?;

    // Object.fromEntries: the id as a property name, a later node's question replacing an earlier one in place.
    let mut questions = Map::new();
    for n in nodes {
        if let Some(question) = field(n, "question").filter(|v| truthy(v)) {
            questions.insert(js_string(field(n, "id")), question.clone());
        }
    }
    let question_map = script_safe(&Value::Object(questions));
    let diagram_id = [field(spec, "diagramId"), field(spec, "title")]
        .into_iter()
        .flatten()
        .find(|v| truthy(v))
        .cloned()
        .unwrap_or_else(|| Value::String("diagram".into()));
    let diagram_id_js = script_safe(&diagram_id);
    let title = esc(Some(
        field(spec, "title")
            .filter(|v| truthy(v))
            .unwrap_or(&Value::String("Diagram".into())),
    ));

    let mut out = String::with_capacity(4096 + nodes_html.len() + edges_svg.len());
    out.push_str("<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<title>");
    out.push_str(&title);
    out.push_str(
        "</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #1a1a1a; color: #ececec; font-family: Poppins, -apple-system, sans-serif; padding: 20px; }
  .title { font-size: 18px; font-weight: 600; color: #f5a623; margin-bottom: 16px; }
  .stage { position: relative; width: ",
    );
    out.push_str(&max_x);
    out.push_str("px; height: ");
    out.push_str(&max_y);
    out.push_str(
        "px; margin: 0 auto; }
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
<div class=\"title\">",
    );
    out.push_str(&title);
    out.push_str("</div>\n<div class=\"stage\">\n  <svg class=\"edges\" viewBox=\"0 0 ");
    out.push_str(&max_x);
    out.push(' ');
    out.push_str(&max_y);
    out.push_str(
        "\" xmlns=\"http://www.w3.org/2000/svg\">
    <defs>
      <marker id=\"arrow\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"6\" markerHeight=\"6\" orient=\"auto-start-reverse\">
        <path d=\"M 0 0 L 10 5 L 0 10 z\" fill=\"#5a5855\"/>
      </marker>
    </defs>
    ",
    );
    out.push_str(&edges_svg);
    out.push_str("\n  </svg>\n  ");
    out.push_str(&nodes_html);
    out.push_str("\n</div>\n");
    out.push_str(&legend_html);
    out.push_str("\n<script>\n(function() {\n  const questions = ");
    out.push_str(&question_map);
    out.push_str(";\n  const diagramId = ");
    out.push_str(&diagram_id_js);
    out.push_str(
        ";
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
</html>",
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    /// The specs in tests/fixtures/diagram/specs.json, each rendered by the Node code into
    /// tests/fixtures/diagram/<n>.html (see the README there).
    #[test]
    fn every_spec_renders_exactly_as_the_node_code_rendered_it() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/diagram");
        let specs: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(dir.join("specs.json")).unwrap()).unwrap();
        assert!(specs.len() >= 8);
        for (i, spec) in specs.iter().enumerate() {
            let expected = std::fs::read_to_string(dir.join(format!("{i}.html"))).unwrap();
            let got = render_diagram_html(spec).unwrap();
            if got != expected {
                let at = got
                    .chars()
                    .zip(expected.chars())
                    .position(|(a, b)| a != b)
                    .unwrap_or(got.len().min(expected.len()));
                let around = |s: &str| s.chars().skip(at.saturating_sub(60)).take(160).collect::<String>();
                panic!(
                    "spec {i} differs at character {at}:\n  rust: {:?}\n  node: {:?}",
                    around(&got),
                    around(&expected)
                );
            }
        }
    }

    #[test]
    fn nodes_without_edges_sit_in_one_centred_row() {
        let html = render_diagram_html(&json!({"title": "T", "nodes": [{"id": "a"}, {"id": "b"}], "edges": []})).unwrap();
        assert!(html.contains("style=\"left:120px;top:40px;width:260px;height:80px;background:#4a3d7a"));
        assert!(html.contains("style=\"left:420px;top:40px;"));
        assert!(html.contains(".stage { position: relative; width: 800px; height: 400px;"));
    }

    #[test]
    fn a_malformed_spec_fails_with_what_the_js_threw() {
        let with = |extra: Value| {
            let mut spec = json!({"nodes": [{"id": "a"}], "edges": []});
            for (k, v) in extra.as_object().unwrap() {
                spec[k] = v.clone();
            }
            render_diagram_html(&spec)
        };
        // Checked against Node.
        assert_eq!(with(json!({"legend": "x"})).unwrap_err(), "legend.map is not a function");
        assert_eq!(with(json!({"legend": {"length": 1}})).unwrap_err(), "legend.map is not a function");
        assert!(with(json!({"legend": 5})).is_ok());
        assert!(with(json!({"legend": ""})).is_ok());
        assert_eq!(
            with(json!({"nodes": [null]})).unwrap_err(),
            "Cannot read properties of null (reading 'id')"
        );
        assert_eq!(
            with(json!({"edges": [null]})).unwrap_err(),
            "Cannot read properties of null (reading 'from')"
        );
        assert_eq!(
            with(json!({"legend": [null]})).unwrap_err(),
            "Cannot read properties of null (reading 'kind')"
        );
    }

    #[test]
    fn script_values_cannot_break_out_of_the_script() {
        assert_eq!(
            script_safe(&json!({"2": "</script>", "1": "\u{2028}x", "b": 1.0, "a": [true, null]})),
            "{\"1\":\"\\u2028x\",\"2\":\"\\u003c/script>\",\"b\":1,\"a\":[true,null]}"
        );
    }

    #[test]
    fn text_coordinates_are_joined_as_javascript_joined_them() {
        assert_eq!(JsVal::Str("100".into()).add(&JsVal::Num(130.0)), JsVal::Str("100130".into()));
        assert_eq!(JsVal::Bool(true).add(&JsVal::Num(1.0)), JsVal::Num(2.0));
        assert_eq!(string_to_number(" 12.5 "), 12.5);
        assert!(string_to_number("12px").is_nan());
        assert_eq!(string_to_number("0x10"), 16.0);
        assert_eq!(string_to_number(""), 0.0);
    }
}

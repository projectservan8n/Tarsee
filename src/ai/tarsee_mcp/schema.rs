//! What `zod` did for the Node MCP server: the shape of a tool's input, the JSON Schema the model is shown for it,
//! and the check of a call's arguments against it.
//!
//! The Node tools were declared with zod (`z.string().optional().describe("...")`), and the MCP SDK did two things
//! with each shape: it converted it to JSON Schema for `tools/list`, and it parsed a call's arguments with it
//! before the tool ran. Both are part of what the model sees (the schema is in its prompt; a refused call's text
//! comes back to it), so both are reproduced here exactly, and checked against what the Node server answered
//! (`node-tools-list-*.json`, `../mcp_http/node-endpoint.json`, and `docs/rust-port/reports/S4-probe-zod.mjs.txt`
//! for the shapes no tool uses today).
//!
//! A shape is written the way the Node file wrote it:
//!
//! ```ignore
//! use schema as z;
//! z::object([
//!     ("channel", z::enumeration(["telegram", "discord"]).describe("Channel to send to")),
//!     ("message", z::string().describe("Message text")),
//!     ("channel_id", z::string().optional().describe("Specific chat/channel ID")),
//! ])
//! ```
//!
//! What zod does that a reader of JSON Schema would not guess, all kept:
//!  - a key the shape does not name is dropped from what the tool gets, not refused;
//!  - what the tool gets has its keys in the shape's order, whatever order they came in;
//!  - an optional value may be left out but not be `null`;
//!  - every problem is reported, not only the first, in the shape's order;
//!  - `.describe()` after `.optional()` writes the description before the type in the JSON Schema, and on the type
//!    itself writes it after (so the order of those two calls is kept as the Node file had it).

use serde_json::{Map, Value, json};

/// What to do with a key an object's shape does not name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UnknownKeys {
    /// `z.object()`: left out of the result.
    Strip,
    /// `z.looseObject()`: kept, after the named keys.
    Keep,
    /// `z.object().strict()`: a problem.
    Refuse,
}

#[derive(Debug, Clone)]
enum Kind {
    String,
    Number,
    /// `z.number().int()`: a whole number JavaScript holds exactly.
    Int,
    Boolean,
    Enum(Vec<String>),
    Literal(String),
    Array(Box<Schema>),
    Object {
        fields: Vec<(String, Schema)>,
        unknown: UnknownKeys,
    },
    Union(Vec<Schema>),
    /// `z.record(z.string(), value)`.
    Record(Box<Schema>),
    /// `z.any()` and `z.unknown()`.
    Any,
    /// The SDK's `AssertObjectSchema`: any object or array.
    AssertObject,
    Intersection(Box<Schema>, Box<Schema>),
}

/// One zod schema: a type, whether it may be left out, and its description.
#[derive(Debug, Clone)]
pub struct Schema {
    kind: Kind,
    optional: bool,
    /// `.describe()` on the type itself: written after the type's own keys.
    description: Option<String>,
    /// `.describe()` after `.optional()`: written before the type's own keys, and it replaces the other.
    outer_description: Option<String>,
}

fn of(kind: Kind) -> Schema {
    Schema {
        kind,
        optional: false,
        description: None,
        outer_description: None,
    }
}

/// `z.string()`.
pub fn string() -> Schema {
    of(Kind::String)
}

/// `z.number()`.
pub fn number() -> Schema {
    of(Kind::Number)
}

/// `z.number().int()`.
pub fn int() -> Schema {
    of(Kind::Int)
}

/// `z.boolean()`.
pub fn boolean() -> Schema {
    of(Kind::Boolean)
}

/// `z.enum([...])`.
pub fn enumeration<S: Into<String>>(values: impl IntoIterator<Item = S>) -> Schema {
    of(Kind::Enum(values.into_iter().map(Into::into).collect()))
}

/// `z.literal("text")`.
pub fn literal(value: impl Into<String>) -> Schema {
    of(Kind::Literal(value.into()))
}

/// `z.array(item)`.
pub fn array(item: Schema) -> Schema {
    of(Kind::Array(Box::new(item)))
}

fn object_of<K: Into<String>>(fields: impl IntoIterator<Item = (K, Schema)>, unknown: UnknownKeys) -> Schema {
    of(Kind::Object {
        fields: fields.into_iter().map(|(key, field)| (key.into(), field)).collect(),
        unknown,
    })
}

/// `z.object({...})`: keys it does not name are dropped.
pub fn object<K: Into<String>>(fields: impl IntoIterator<Item = (K, Schema)>) -> Schema {
    object_of(fields, UnknownKeys::Strip)
}

/// `z.looseObject({...})`: keys it does not name are kept.
pub fn loose_object<K: Into<String>>(fields: impl IntoIterator<Item = (K, Schema)>) -> Schema {
    object_of(fields, UnknownKeys::Keep)
}

/// `z.object({...}).strict()`: a key it does not name is a problem.
pub fn strict_object<K: Into<String>>(fields: impl IntoIterator<Item = (K, Schema)>) -> Schema {
    object_of(fields, UnknownKeys::Refuse)
}

/// `z.union([...])`.
pub fn union(options: impl IntoIterator<Item = Schema>) -> Schema {
    of(Kind::Union(options.into_iter().collect()))
}

/// `z.record(z.string(), value)`.
pub fn record(value: Schema) -> Schema {
    of(Kind::Record(Box::new(value)))
}

/// `z.any()` (and `z.unknown()`, which checks the same).
pub fn any() -> Schema {
    of(Kind::Any)
}

/// The SDK's `AssertObjectSchema`: any object or array.
pub fn assert_object() -> Schema {
    of(Kind::AssertObject)
}

/// `z.intersection(left, right)`.
pub fn intersection(left: Schema, right: Schema) -> Schema {
    of(Kind::Intersection(Box::new(left), Box::new(right)))
}

/// A list of problems, each as zod writes an issue (`error.issues`).
pub type Issues = Vec<Value>;

/// `JSON.stringify(issues, null, 2)`: a `ZodError`'s message.
pub fn issues_text(issues: &[Value]) -> String {
    serde_json::to_string_pretty(issues).unwrap_or_else(|_| "[]".into())
}

/// The same problems, found under `prefix` (a request's `params`).
pub fn under(prefix: &str, issues: Issues) -> Issues {
    issues
        .into_iter()
        .map(|mut issue| {
            if let Some(Value::Array(path)) = issue.get_mut("path") {
                path.insert(0, Value::String(prefix.to_string()));
            }
            issue
        })
        .collect()
}

/// What zod calls the type of a value in "received ...": `undefined` for one that is not there.
fn received(input: Option<&Value>) -> &'static str {
    match input {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// The largest whole number JavaScript holds exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The number as a whole number JavaScript holds exactly, if it is one (`1.0` is; `2^53` is not).
pub fn safe_integer(number: &serde_json::Number) -> Option<i64> {
    if let Some(whole) = number.as_i64() {
        return (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&whole).then_some(whole);
    }
    if number.is_u64() {
        // Past i64: far past what JavaScript holds exactly.
        return None;
    }
    let float = number.as_f64()?;
    (float.fract() == 0.0 && float.abs() <= MAX_SAFE_INTEGER as f64).then_some(float as i64)
}

impl Schema {
    /// `.optional()`: the value may be left out.
    pub fn optional(mut self) -> Self {
        self.optional = true;
        self
    }

    /// `.describe(text)`. After `.optional()` it is the wrapper that is described, which the JSON Schema shows by
    /// writing the description first; before it, the type is, and the description comes last.
    pub fn describe(mut self, text: impl Into<String>) -> Self {
        if self.optional {
            self.outer_description = Some(text.into());
        } else {
            self.description = Some(text.into());
        }
        self
    }

    /// Whether the value may be left out.
    pub fn is_optional(&self) -> bool {
        self.optional
    }

    // --- JSON Schema ---------------------------------------------------------------------------------------------

    /// The JSON Schema of a tool's input, as the MCP SDK made it from the zod shape (draft 7, the input side).
    pub fn input_schema(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "$schema".into(),
            Value::String("http://json-schema.org/draft-07/schema#".into()),
        );
        self.write_json_schema(&mut out);
        Value::Object(out)
    }

    /// This schema as a JSON Schema (without `$schema`).
    pub fn json_schema(&self) -> Value {
        let mut out = Map::new();
        self.write_json_schema(&mut out);
        Value::Object(out)
    }

    fn write_json_schema(&self, out: &mut Map<String, Value>) {
        if let Some(text) = &self.outer_description {
            out.insert("description".into(), Value::String(text.clone()));
        }
        match &self.kind {
            Kind::String => {
                out.insert("type".into(), json!("string"));
            }
            Kind::Number => {
                out.insert("type".into(), json!("number"));
            }
            Kind::Int => {
                out.insert("type".into(), json!("integer"));
            }
            Kind::Boolean => {
                out.insert("type".into(), json!("boolean"));
            }
            Kind::Enum(values) => {
                out.insert("type".into(), json!("string"));
                out.insert("enum".into(), json!(values));
            }
            Kind::Literal(value) => {
                out.insert("type".into(), json!("string"));
                out.insert("const".into(), json!(value));
            }
            Kind::Array(item) => {
                out.insert("type".into(), json!("array"));
                out.insert("items".into(), item.json_schema());
            }
            Kind::Object { fields, .. } => {
                out.insert("type".into(), json!("object"));
                let mut properties = Map::new();
                let mut required = Vec::new();
                for (key, field) in fields {
                    properties.insert(key.clone(), field.json_schema());
                    if !field.optional {
                        required.push(Value::String(key.clone()));
                    }
                }
                out.insert("properties".into(), Value::Object(properties));
                if !required.is_empty() {
                    out.insert("required".into(), Value::Array(required));
                }
            }
            Kind::Union(options) => {
                let any_of: Vec<Value> = options.iter().map(Schema::json_schema).collect();
                out.insert("anyOf".into(), Value::Array(any_of));
            }
            Kind::Record(value) => {
                out.insert("type".into(), json!("object"));
                out.insert("propertyNames".into(), json!({"type": "string"}));
                out.insert("additionalProperties".into(), value.json_schema());
            }
            Kind::Any | Kind::AssertObject => {}
            Kind::Intersection(left, right) => {
                out.insert("allOf".into(), json!([left.json_schema(), right.json_schema()]));
            }
        }
        if self.outer_description.is_none()
            && let Some(text) = &self.description
        {
            out.insert("description".into(), Value::String(text.clone()));
        }
    }

    // --- Checking a value ----------------------------------------------------------------------------------------

    /// `schema.safeParse(input)`: the value as the tool gets it (`None`: left out, where that is allowed), or every
    /// problem with it. `input` is `None` for a value that is not there (JavaScript's `undefined`).
    pub fn parse(&self, input: Option<&Value>) -> Result<Option<Value>, Issues> {
        let mut issues = Vec::new();
        let output = self.check(input, &mut Vec::new(), &mut issues);
        if issues.is_empty() { Ok(output) } else { Err(issues) }
    }

    /// Whether the value passes (`schema.safeParse(input).success`).
    pub fn accepts(&self, input: Option<&Value>) -> bool {
        self.parse(input).is_ok()
    }

    fn check(&self, input: Option<&Value>, path: &mut Vec<Value>, issues: &mut Issues) -> Option<Value> {
        if input.is_none() && self.optional {
            return None;
        }
        let wrong_type = |expected: &str, path: &[Value], issues: &mut Issues| {
            issues.push(json!({
                "expected": expected,
                "code": "invalid_type",
                "path": path,
                "message": format!("Invalid input: expected {expected}, received {}", received(input)),
            }));
            None
        };
        match &self.kind {
            Kind::String => match input {
                Some(Value::String(_)) => input.cloned(),
                _ => wrong_type("string", path, issues),
            },
            Kind::Number => match input {
                Some(Value::Number(_)) => input.cloned(),
                _ => wrong_type("number", path, issues),
            },
            Kind::Int => match input {
                Some(Value::Number(number)) => match safe_integer(number) {
                    Some(whole) => Some(Value::from(whole)),
                    None => {
                        issues.push(json!({
                            "expected": "int",
                            "format": "safeint",
                            "code": "invalid_type",
                            "path": path,
                            "message": "Invalid input: expected int, received number",
                        }));
                        None
                    }
                },
                _ => wrong_type("number", path, issues),
            },
            Kind::Boolean => match input {
                Some(Value::Bool(_)) => input.cloned(),
                _ => wrong_type("boolean", path, issues),
            },
            Kind::Enum(values) => match input {
                Some(Value::String(text)) if values.contains(text) => input.cloned(),
                _ => {
                    issues.push(not_one_of(values, path));
                    None
                }
            },
            Kind::Literal(value) => match input {
                Some(Value::String(text)) if text == value => input.cloned(),
                _ => {
                    issues.push(not_one_of(std::slice::from_ref(value), path));
                    None
                }
            },
            Kind::Array(item) => match input {
                Some(Value::Array(items)) => {
                    let mut output = Vec::with_capacity(items.len());
                    for (index, value) in items.iter().enumerate() {
                        path.push(Value::from(index));
                        if let Some(checked) = item.check(Some(value), path, issues) {
                            output.push(checked);
                        }
                        path.pop();
                    }
                    Some(Value::Array(output))
                }
                _ => wrong_type("array", path, issues),
            },
            Kind::Object { fields, unknown } => match input {
                Some(Value::Object(given)) => {
                    let mut output = Map::new();
                    for (key, field) in fields {
                        path.push(Value::String(key.clone()));
                        if let Some(checked) = field.check(given.get(key), path, issues) {
                            output.insert(key.clone(), checked);
                        }
                        path.pop();
                    }
                    let extra = || {
                        given
                            .iter()
                            .filter(|(key, _)| !fields.iter().any(|(named, _)| named == *key))
                    };
                    match unknown {
                        UnknownKeys::Strip => {}
                        UnknownKeys::Keep => {
                            for (key, value) in extra() {
                                output.insert(key.clone(), value.clone());
                            }
                        }
                        UnknownKeys::Refuse => {
                            let keys: Vec<&String> = extra().map(|(key, _)| key).collect();
                            if !keys.is_empty() {
                                let quoted: Vec<String> = keys.iter().map(|key| json!(key).to_string()).collect();
                                issues.push(json!({
                                    "code": "unrecognized_keys",
                                    "keys": keys,
                                    "path": path,
                                    "message": format!(
                                        "Unrecognized key{}: {}",
                                        if keys.len() > 1 { "s" } else { "" },
                                        quoted.join(", ")
                                    ),
                                }));
                            }
                        }
                    }
                    Some(Value::Object(output))
                }
                _ => wrong_type("object", path, issues),
            },
            Kind::Union(options) => {
                // Each option is tried on its own; the problems of each are listed from the value itself, not from
                // where the value sits.
                let mut errors = Vec::with_capacity(options.len());
                for option in options {
                    match option.parse(input) {
                        Ok(output) => return output,
                        Err(found) => errors.push(Value::Array(found)),
                    }
                }
                issues.push(json!({
                    "code": "invalid_union",
                    "errors": errors,
                    "path": path,
                    "message": "Invalid input",
                }));
                None
            }
            Kind::Record(value) => match input {
                Some(Value::Object(given)) => {
                    let mut output = Map::new();
                    for (key, member) in given {
                        // (zod steps over this one name, so a record can never set an object's prototype.)
                        if key == "__proto__" {
                            continue;
                        }
                        path.push(Value::String(key.clone()));
                        if let Some(checked) = value.check(Some(member), path, issues) {
                            output.insert(key.clone(), checked);
                        }
                        path.pop();
                    }
                    Some(Value::Object(output))
                }
                _ => wrong_type("record", path, issues),
            },
            Kind::Any => match input {
                Some(value) => Some(value.clone()),
                None => {
                    issues.push(json!({
                        "code": "invalid_type",
                        "expected": "nonoptional",
                        "path": path,
                        "message": "Invalid input: expected nonoptional, received undefined",
                    }));
                    None
                }
            },
            Kind::AssertObject => match input {
                Some(Value::Object(_) | Value::Array(_)) => input.cloned(),
                _ => {
                    issues.push(json!({ "code": "custom", "path": path, "message": "Invalid input" }));
                    None
                }
            },
            Kind::Intersection(left, right) => {
                let output = left.check(input, path, issues);
                right.check(input, path, issues);
                output
            }
        }
    }
}

/// zod's problem for a value that is none of an enum's (or not a literal).
fn not_one_of(values: &[String], path: &[Value]) -> Value {
    let quoted: Vec<String> = values.iter().map(|value| json!(value).to_string()).collect();
    let message = match quoted.as_slice() {
        [only] => format!("Invalid input: expected {only}"),
        _ => format!("Invalid option: expected one of {}", quoted.join("|")),
    };
    json!({
        "code": "invalid_value",
        "values": values,
        "path": path,
        "message": message,
    })
}

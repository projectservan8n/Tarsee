//! What the MCP SDK's server did for the Node version: reading a JSON-RPC message, and answering a request.
//!
//! The Node server was the SDK's `McpServer`; the transport (`ai/mcp_http.rs`) handed it each message of a POST and
//! sent back what it answered. Two engines' own MCP clients talk to this (Claude Code's and Codex's), and both were
//! written against the SDK's behaviour, so what is here answers as the SDK answered, down to the order of the keys:
//! every case in `../mcp_http/node-endpoint.json` was sent to the Node endpoint and is replayed against this one.
//!
//!  - A message is a request (`id` and `method`), a notification (`method` only), or a response; anything else is
//!    no message at all ([`parse_message`]).
//!  - `initialize` answers with the protocol version (the one asked for when it is one the server knows, else the
//!    newest), the server's capabilities (tools) and its name.
//!  - `ping` answers `{}`. `tools/list` answers the tools. `tools/call` runs one.
//!  - A method the server does not have answers the error -32601 "Method not found" (both clients ask for
//!    `resources/list` and the like, and go on when they are told there is none).
//!  - Parameters that don't fit a request's shape answer the error -32603 with zod's list of what is wrong.

use std::sync::LazyLock;

use serde_json::{Map, Value, json};

use super::schema::{self as z, Schema};
use super::{SERVER_NAME, SERVER_VERSION, TarseeMcp};
use crate::app::App;

/// The newest protocol version the server speaks.
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";

/// The protocol versions the server speaks, newest first.
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] = [
    LATEST_PROTOCOL_VERSION,
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

/// JSON-RPC's own error numbers, as the SDK used them.
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INTERNAL_ERROR: i64 = -32603;

/// A request: a message with an `id` that wants an answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    /// A string or a whole number, as it is sent back.
    pub id: Value,
    pub method: String,
    /// The `params` object, when the request had one.
    pub params: Option<Value>,
}

/// One JSON-RPC message (`JSONRPCMessageSchema`).
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Request(Request),
    /// A message with a `method` and no `id`: nothing is answered.
    Notification {
        method: String,
        params: Option<Value>,
    },
    /// A result or an error for a request the server never made: taken and dropped.
    Response,
}

/// `_meta` of a request or a notification: anything, but a progress token is text or a whole number, and a related
/// task names its id.
fn meta() -> Schema {
    z::loose_object([
        ("progressToken", z::union([z::string(), z::int()]).optional()),
        (
            "io.modelcontextprotocol/related-task",
            z::object([("taskId", z::string())]).optional(),
        ),
    ])
}

/// What a client says it can do. The server uses none of it, but a client that says it wrongly is refused, as by
/// the SDK.
fn client_capabilities() -> Schema {
    let form = z::intersection(
        z::object([("applyDefaults", z::boolean().optional())]),
        z::record(z::any()),
    );
    z::object([
        ("experimental", z::record(z::assert_object()).optional()),
        (
            "sampling",
            z::object([
                ("context", z::assert_object().optional()),
                ("tools", z::assert_object().optional()),
            ])
            .optional(),
        ),
        (
            "elicitation",
            z::intersection(
                z::object([("form", form.optional()), ("url", z::assert_object().optional())]),
                z::record(z::any()).optional(),
            )
            .optional(),
        ),
        (
            "roots",
            z::object([("listChanged", z::boolean().optional())]).optional(),
        ),
        (
            "tasks",
            z::loose_object([
                ("list", z::assert_object().optional()),
                ("cancel", z::assert_object().optional()),
                (
                    "requests",
                    z::loose_object([
                        (
                            "sampling",
                            z::loose_object([("createMessage", z::assert_object().optional())]).optional(),
                        ),
                        (
                            "elicitation",
                            z::loose_object([("create", z::assert_object().optional())]).optional(),
                        ),
                    ])
                    .optional(),
                ),
            ])
            .optional(),
        ),
        ("extensions", z::record(z::assert_object()).optional()),
    ])
}

/// A client's or a server's name and version.
fn implementation() -> Schema {
    z::object([
        ("name", z::string()),
        ("title", z::string().optional()),
        (
            "icons",
            z::array(z::object([
                ("src", z::string()),
                ("mimeType", z::string().optional()),
                ("sizes", z::array(z::string()).optional()),
                ("theme", z::enumeration(["light", "dark"]).optional()),
            ]))
            .optional(),
        ),
        ("version", z::string()),
        ("websiteUrl", z::string().optional()),
        ("description", z::string().optional()),
    ])
}

/// The shapes of what the server reads.
struct Shapes {
    /// `params` of any request or notification as the transport takes it: an object whose `_meta`, if any, is one.
    any_params: Schema,
    /// `params` that ask for a task to be made of the request (`isTaskAugmentedRequestParams`).
    task_params: Schema,
    initialize: Schema,
    list_tools: Schema,
    call_tool: Schema,
    /// The `error` of an error response.
    error: Schema,
    /// The `result` of a result response.
    result: Schema,
}

static SHAPES: LazyLock<Shapes> = LazyLock::new(|| {
    let task = || z::object([("ttl", z::number().optional())]);
    Shapes {
        any_params: z::loose_object([("_meta", meta().optional())]),
        task_params: z::object([("_meta", meta().optional()), ("task", task().optional())]),
        initialize: z::object([
            ("_meta", meta().optional()),
            ("protocolVersion", z::string()),
            ("capabilities", client_capabilities()),
            ("clientInfo", implementation()),
        ]),
        list_tools: z::object([("_meta", meta().optional()), ("cursor", z::string().optional())]).optional(),
        call_tool: z::object([
            ("_meta", meta().optional()),
            ("task", task().optional()),
            ("name", z::string()),
            ("arguments", z::record(z::any()).optional()),
        ]),
        error: z::object([
            ("code", z::int()),
            ("message", z::string()),
            ("data", z::any().optional()),
        ]),
        result: z::loose_object([("_meta", meta().optional())]),
    }
});

/// A request's id: text, or a whole number JavaScript holds exactly. `1.0` is sent back as `1`, as the SDK did.
fn request_id(value: Option<&Value>) -> Option<Value> {
    normal_id(value?)
}

/// An id as a request may carry it and its answer carries it back: text as it is, a whole number without its
/// decimal point. `None` for anything else.
pub fn normal_id(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => Some(Value::String(text.clone())),
        Value::Number(number) => z::safe_integer(number).map(Value::from),
        _ => None,
    }
}

/// The methods the server answers; any other is "Method not found".
const METHODS: [&str; 4] = ["ping", "initialize", "tools/list", "tools/call"];

/// Whether the server has this method.
pub fn has_method(method: &str) -> bool {
    METHODS.contains(&method)
}

/// `JSONRPCMessageSchema.parse(value)`: the message, or `None` where the SDK's transport answered
/// "Parse error: Invalid JSON-RPC message". Each kind takes its own keys and no other.
pub fn parse_message(value: &Value) -> Option<Message> {
    let object = value.as_object()?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return None;
    }
    let only = |allowed: &[&str]| object.keys().all(|key| allowed.contains(&key.as_str()));
    // `params` may be left out, but not be null, an array or anything else that is not an object.
    let params = || -> Option<Option<Value>> {
        match object.get("params") {
            None => Some(None),
            Some(params) => SHAPES.any_params.accepts(Some(params)).then(|| Some(params.clone())),
        }
    };
    let method = object.get("method").and_then(Value::as_str);

    // A request.
    if only(&["jsonrpc", "id", "method", "params"])
        && let Some(method) = method
        && let Some(id) = request_id(object.get("id"))
        && let Some(params) = params()
    {
        return Some(Message::Request(Request {
            id,
            method: method.to_string(),
            params,
        }));
    }
    // A notification.
    if only(&["jsonrpc", "method", "params"])
        && let Some(method) = method
        && let Some(params) = params()
    {
        return Some(Message::Notification {
            method: method.to_string(),
            params,
        });
    }
    // A result.
    if only(&["jsonrpc", "id", "result"])
        && request_id(object.get("id")).is_some()
        && SHAPES.result.accepts(object.get("result"))
    {
        return Some(Message::Response);
    }
    // An error (its id may be left out).
    if only(&["jsonrpc", "id", "error"])
        && (!object.contains_key("id") || request_id(object.get("id")).is_some())
        && SHAPES.error.accepts(object.get("error"))
    {
        return Some(Message::Response);
    }
    None
}

/// Whether the message is an initialization (`isInitializeRequest`): its method is "initialize" and its parameters
/// fit. The SDK asked this of the message whether or not it had an id, and so does this.
pub fn is_initialize_message(message: &Message) -> bool {
    let (method, params) = match message {
        Message::Request(request) => (&request.method, &request.params),
        Message::Notification { method, params } => (method, params),
        Message::Response => return false,
    };
    method == "initialize" && SHAPES.initialize.accepts(params.as_ref())
}

/// `{ result, jsonrpc: "2.0", id }`: a request's answer, with the keys in the SDK's order.
pub fn result_response(id: &Value, result: Value) -> Value {
    json!({ "result": result, "jsonrpc": "2.0", "id": id })
}

/// `{ jsonrpc: "2.0", id, error: { code, message } }`: a request's failure, with the keys in the SDK's order.
pub fn error_response(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// What answering a request takes.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// The answer, there at once: the whole response message.
    Answer(Value),
    /// A tool has to run first ([`TarseeMcp::call_tool`]); its result goes into [`result_response`].
    Call { name: String, arguments: Option<Value> },
}

impl TarseeMcp {
    /// Takes a request as far as it goes without running a tool: every answer but a `tools/call`'s is there at
    /// once.
    pub fn begin(&self, request: &Request) -> Step {
        let id = &request.id;
        let params = request.params.as_ref();
        if !has_method(&request.method) {
            return Step::Answer(error_response(id, METHOD_NOT_FOUND, "Method not found"));
        }
        // A request that asks for a task to be made of it (`params.task`): this server makes none.
        let asks_for_a_task = params.is_some_and(|params| {
            SHAPES.task_params.accepts(Some(params)) && params.get("task").is_some_and(Value::is_object)
        });
        if asks_for_a_task {
            return Step::Answer(error_response(
                id,
                INTERNAL_ERROR,
                format!(
                    "Server does not support task creation (required for {})",
                    request.method
                ),
            ));
        }
        // Parameters that don't fit: zod's list of what is wrong, each path starting at "params".
        let unfit = |issues: z::Issues| {
            Step::Answer(error_response(
                id,
                INTERNAL_ERROR,
                z::issues_text(&z::under("params", issues)),
            ))
        };
        match request.method.as_str() {
            "ping" => Step::Answer(result_response(id, json!({}))),
            "initialize" => match SHAPES.initialize.parse(params) {
                Err(issues) => unfit(issues),
                Ok(parsed) => {
                    let asked = parsed
                        .as_ref()
                        .and_then(|params| params.get("protocolVersion"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&asked) {
                        asked
                    } else {
                        LATEST_PROTOCOL_VERSION
                    };
                    Step::Answer(result_response(
                        id,
                        json!({
                            "protocolVersion": version,
                            "capabilities": { "tools": { "listChanged": true } },
                            "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
                        }),
                    ))
                }
            },
            "tools/list" => match SHAPES.list_tools.parse(params) {
                Err(issues) => unfit(issues),
                Ok(_) => Step::Answer(result_response(id, self.list_tools())),
            },
            _ => match SHAPES.call_tool.parse(params) {
                Err(issues) => unfit(issues),
                Ok(parsed) => {
                    let mut parsed = match parsed {
                        Some(Value::Object(parsed)) => parsed,
                        _ => Map::new(),
                    };
                    let name = match parsed.remove("name") {
                        Some(Value::String(name)) => name,
                        _ => String::new(),
                    };
                    Step::Call {
                        name,
                        arguments: parsed.remove("arguments"),
                    }
                }
            },
        }
    }

    /// Answers one request: the whole response message (`{ result, jsonrpc, id }` or `{ jsonrpc, id, error }`).
    pub async fn handle_request(&self, app: &App, request: &Request) -> Value {
        match self.begin(request) {
            Step::Answer(response) => response,
            Step::Call { name, arguments } => {
                let result = self.call_tool(app, &name, arguments.as_ref()).await;
                result_response(&request.id, result)
            }
        }
    }
}

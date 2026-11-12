// test/railway-admin.test.js: Railway projects, variable names, set_variable and redeploy, done by Tarsee with a
// token it reads from the vault, so a secret never goes through a command or the model's context. Railway is never
// reached: the app's HTTP client is a stand-in that answers like Railway's GraphQL API, and the vault is a stand-in
// or a temporary one.

use std::sync::Arc;

use parking_lot::Mutex;

use super::*;
use crate::testkit::{Answer, FetchCall, TestApp, test_app, test_app_with_env};

const TOKEN: &str = "owner-tok-SECRET-11111111-2222-3333";
const GO: &str = "the owner in chat: put the alerts webhook on the watchdog and deploy";

/// A Discord webhook URL (built from parts, so it does not read as a real one).
fn hook() -> String {
    format!(
        "https://discord.com/api/{}/1564447804183547987/wh-SECRET-abcdefghij_KLMNOP-0123456789xyz",
        "webhooks"
    )
}

fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn p_acme() -> String {
    id(1)
}
fn p_twin1() -> String {
    id(2)
}
fn p_twin2() -> String {
    id(3)
}
fn p_tarsee() -> String {
    id(5)
}
fn p_other() -> String {
    id(9)
}
fn e_prod() -> String {
    id(11)
}
fn e_stage() -> String {
    id(12)
}
fn s_watch() -> String {
    id(21)
}
fn s_web() -> String {
    id(22)
}
fn s_w1() -> String {
    id(23)
}
fn s_w2() -> String {
    id(24)
}
fn d_last() -> String {
    id(31)
}
fn d_new() -> String {
    id(32)
}
fn e_tarsee() -> String {
    id(43)
}
fn s_tarsee() -> String {
    id(44)
}
fn d_tarsee() -> String {
    id(45)
}

/// Where Tarsee runs, as Railway tells a service.
fn on_railway() -> Env {
    Env::from_pairs([
        ("RAILWAY_PROJECT_ID", p_tarsee()),
        ("RAILWAY_ENVIRONMENT_ID", e_tarsee()),
        ("RAILWAY_SERVICE_ID", s_tarsee()),
    ])
}

/// What the token can see, with its variables and deployments.
fn railway_data() -> Value {
    json!({
        TOKEN: {
            "projects": [
                {"id": p_acme(), "name": "Acme", "deletedAt": null,
                 "environments": [{"id": e_prod(), "name": "production"}, {"id": e_stage(), "name": "Staging"}, {"id": id(13), "name": "pr-12", "deletedAt": "2026-10-01T00:00:00Z"}],
                 "services": [{"id": s_watch(), "name": "watchdog"}, {"id": s_web(), "name": "web"}, {"id": s_w1(), "name": "worker"}, {"id": s_w2(), "name": "Worker"}]},
                {"id": p_twin1(), "name": "Twin", "deletedAt": null, "environments": [{"id": id(41), "name": "production"}], "services": []},
                {"id": p_twin2(), "name": "twin", "deletedAt": null, "environments": [{"id": id(42), "name": "production"}], "services": []},
                {"id": id(4), "name": "Old Thing", "deletedAt": "2026-09-01T00:00:00Z", "environments": [], "services": []},
                {"id": p_tarsee(), "name": "Tarsee", "deletedAt": null, "environments": [{"id": e_tarsee(), "name": "production"}], "services": [{"id": s_tarsee(), "name": "tarsee"}]},
            ],
            "variables": {
                e_prod(): [
                    {"name": "DATABASE_URL", "serviceId": s_watch(), "isSealed": true, "value": "postgres://u:pw-SECRET@db/x"},
                    {"name": "LOG_LEVEL", "serviceId": s_watch(), "isSealed": false, "value": "info"},
                    {"name": "PORT", "serviceId": s_web(), "isSealed": false, "value": "8080"},
                    {"name": "SHARED_REGION", "serviceId": null, "isSealed": false, "value": "sin"},
                ],
                e_stage(): [],
                e_tarsee(): [{"name": "SETUP_PASSWORD", "serviceId": s_tarsee(), "isSealed": false, "value": "1234"}],
            },
            "deployments": {
                format!("{}/{}", e_prod(), s_watch()): [{"id": d_last(), "status": "SUCCESS", "createdAt": "2026-10-26T10:00:00Z"}],
                format!("{}/{}", e_tarsee(), s_tarsee()): [{"id": d_tarsee(), "status": "SUCCESS", "createdAt": "2026-10-27T08:00:00Z"}],
            },
        }
    })
}

/// One operation (or every one, "*") failing in a chosen way.
#[derive(Clone, Default)]
struct Fail {
    op: &'static str,
    network: Option<&'static str>,
    hang: bool,
    raw: Option<&'static str>,
    status: Option<u16>,
    errors: Option<Vec<String>>,
}

/// A stand-in for Railway's GraphQL endpoint: answers by operation name, for the token in the Authorization header.
/// The app's HTTP client records every call.
#[derive(Clone)]
struct Railway {
    data: Arc<Mutex<Value>>,
    fail: Option<Fail>,
}

fn railway() -> Railway {
    Railway {
        data: Arc::new(Mutex::new(railway_data())),
        fail: None,
    }
}

fn failing(fail: Fail) -> Railway {
    Railway {
        fail: Some(fail),
        ..railway()
    }
}

static OP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:query|mutation) ([A-Za-z0-9_]+)").unwrap());

fn op_of(query: &str) -> String {
    OP.captures(query).map(|c| c[1].to_string()).unwrap_or_default()
}

fn edges(list: Vec<Value>) -> Value {
    json!({"edges": list.into_iter().map(|node| json!({"node": node})).collect::<Vec<_>>()})
}

impl Railway {
    fn answer(&self, request: &FetchRequest) -> Answer {
        let body: Value = serde_json::from_str(&request.body_text()).unwrap();
        let query = body["query"].as_str().unwrap_or_default().to_string();
        let op = op_of(&query);
        if let Some(fail) = &self.fail
            && (fail.op == op || fail.op == "*")
        {
            if let Some(code) = fail.network {
                return Answer::connect_error(code);
            }
            if fail.hang {
                return Answer::Hang;
            }
            if let Some(raw) = fail.raw {
                return Answer::text(fail.status.unwrap_or(200), raw);
            }
            let errors: Vec<Value> = fail
                .errors
                .clone()
                .unwrap_or_else(|| vec!["boom".into()])
                .into_iter()
                .map(|message| json!({"message": message}))
                .collect();
            return Answer::json(fail.status.unwrap_or(200), json!({"errors": errors, "data": null}));
        }
        let token = request
            .header_value("authorization")
            .and_then(|h| h.strip_prefix("Bearer "))
            .unwrap_or_default()
            .to_string();
        let mut data = self.data.lock();
        let Some(acct) = data.get_mut(&token) else {
            return Answer::json(401, json!({"errors": [{"message": "Not Authorized"}]}));
        };
        let v = &body["variables"];
        match op.as_str() {
            "TarseeProjects" => {
                let list = acct["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| json!({"id": p["id"], "name": p["name"], "deletedAt": p["deletedAt"]}))
                    .collect();
                Answer::json(200, json!({"data": {"projects": edges(list)}}))
            }
            "TarseeProject" => {
                let Some(p) = acct["projects"].as_array().unwrap().iter().find(|p| p["id"] == v["id"]) else {
                    return Answer::json(200, json!({"errors": [{"message": "Project not found"}], "data": null}));
                };
                let envs = p["environments"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| {
                        let mut e = e.clone();
                        if e.get("deletedAt").is_none() {
                            e["deletedAt"] = Value::Null;
                        }
                        e
                    })
                    .collect();
                let services = p["services"].as_array().unwrap().clone();
                Answer::json(
                    200,
                    json!({"data": {"project": {"id": p["id"], "name": p["name"], "deletedAt": p["deletedAt"],
                        "environments": edges(envs), "services": edges(services)}}}),
                )
            }
            "TarseeVariableNames" => {
                let Some(list) = v["environmentId"].as_str().and_then(|e| acct["variables"].get(e)) else {
                    return Answer::json(
                        200,
                        json!({"errors": [{"message": "Environment not found"}], "data": null}),
                    );
                };
                // Only what the document asks for: names, never values.
                let wants_value = Regex::new(r"\bvalue\b").unwrap().is_match(&query);
                let list = list
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| {
                        if wants_value {
                            x.clone()
                        } else {
                            json!({"name": x["name"], "serviceId": x["serviceId"], "isSealed": x["isSealed"]})
                        }
                    })
                    .collect();
                Answer::json(200, json!({"data": {"environment": {"variables": edges(list)}}}))
            }
            "TarseeVariableUpsert" => {
                let env = v["environmentId"].as_str().unwrap().to_string();
                let list = acct["variables"]
                    .as_object_mut()
                    .unwrap()
                    .entry(env)
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
                    .unwrap();
                for (name, value) in v["variables"].as_object().unwrap() {
                    match list
                        .iter_mut()
                        .find(|x| x["name"] == *name && x["serviceId"] == v["serviceId"])
                    {
                        Some(had) => had["value"] = value.clone(),
                        None => list.push(
                            json!({"name": name, "serviceId": v["serviceId"], "isSealed": false, "value": value}),
                        ),
                    }
                }
                Answer::json(200, json!({"data": {"variableCollectionUpsert": true}}))
            }
            "TarseeLatestDeployment" => {
                let key = format!(
                    "{}/{}",
                    v["input"]["environmentId"].as_str().unwrap_or_default(),
                    v["input"]["serviceId"].as_str().unwrap_or_default()
                );
                let list = acct["deployments"]
                    .get(&key)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                Answer::json(200, json!({"data": {"deployments": edges(list)}}))
            }
            "TarseeRedeploy" => Answer::json(200, json!({"data": {"deploymentRedeploy": {"id": d_new()}}})),
            _ => Answer::json(
                400,
                json!({"errors": [{"message": format!("Cannot query: unknown operation {op}")}]}),
            ),
        }
    }

    fn install(&self, t: &TestApp) {
        let rw = self.clone();
        t.fetch.respond_with(API_URL, move |request| rw.answer(request));
    }

    /// The value Railway now holds for a variable.
    fn value_of(&self, env: &str, name: &str) -> Option<String> {
        self.data.lock()[TOKEN]["variables"][env]
            .as_array()?
            .iter()
            .find(|x| x["name"] == name)
            .and_then(|x| x["value"].as_str().map(str::to_string))
    }
}

/// A vault stand-in: its keys and values, in order.
struct FakeVault {
    keys: Vec<(String, String)>,
}

fn fake_vault() -> FakeVault {
    vault_of(&[("RAILWAY_API_TOKEN", TOKEN), ("ALERTS_WEBHOOK", &hook())])
}

fn vault_of(entries: &[(&str, &str)]) -> FakeVault {
    FakeVault {
        keys: entries.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    }
}

impl RailwayVault for FakeVault {
    fn get_key(&self, name: &str) -> anyhow::Result<Option<String>> {
        Ok(self.keys.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()))
    }

    fn get_all_keys_decrypted(&self) -> Option<anyhow::Result<KeyValues>> {
        Some(Ok(self
            .keys
            .iter()
            .map(|(k, v)| (k.clone(), Some(v.clone())))
            .collect()))
    }
}

/// A vault that cannot be read (and cannot list its keys).
struct BrokenVault;

impl RailwayVault for BrokenVault {
    fn get_key(&self, _name: &str) -> anyhow::Result<Option<String>> {
        anyhow::bail!("bad decrypt")
    }
}

/// A call the app's HTTP client made, read as a GraphQL request.
struct Sent {
    url: String,
    method: String,
    authorization: Option<String>,
    content_type: Option<String>,
    query: String,
    variables: Value,
    op: String,
}

fn sent(call: &FetchCall) -> Sent {
    let body = call.json();
    let query = body["query"].as_str().unwrap_or_default().to_string();
    Sent {
        url: call.url.clone(),
        method: call.method.clone(),
        authorization: call.header("authorization").map(str::to_string),
        content_type: call.header("content-type").map(str::to_string),
        op: op_of(&query),
        variables: body["variables"].clone(),
        query,
    }
}

struct Ran {
    out: String,
    lines: Vec<String>,
    calls: Vec<Sent>,
    rw: Railway,
    /// The answer and the log lines together.
    text: String,
}

impl Ran {
    fn ops(&self) -> Vec<String> {
        self.calls.iter().map(|c| c.op.clone()).collect()
    }

    fn writes(&self) -> Vec<&Sent> {
        self.calls.iter().filter(|c| c.query.starts_with("mutation")).collect()
    }

    fn tokens_sent(&self) -> Vec<String> {
        let mut seen: Vec<String> = Vec::new();
        for c in &self.calls {
            let a = c.authorization.clone().unwrap_or_default();
            if !seen.contains(&a) {
                seen.push(a);
            }
        }
        seen
    }
}

#[derive(Default)]
struct With<'a> {
    rw: Option<Railway>,
    vault: Option<&'a dyn RailwayVault>,
    env: Option<Env>,
    timeout: Option<Duration>,
}

/// Runs the tool with its log lines kept, so a test can check they carry no secret. Off Railway unless `env` says
/// so.
async fn run_with(t: &TestApp, args: Value, with: With<'_>) -> Ran {
    t.fetch.reset();
    let rw = with.rw.unwrap_or_else(railway);
    rw.install(t);
    let default_vault = fake_vault();
    let env = with.env.unwrap_or_default();
    let lines = Mutex::new(Vec::new());
    let log = |line: &str| lines.lock().push(line.to_string());
    let out = railway_admin(
        &t.app,
        &args,
        RailwayDeps {
            vault: Some(with.vault.unwrap_or(&default_vault)),
            env: Some(&env),
            log: Some(&log),
            timeout: with.timeout,
        },
    )
    .await;
    let lines = lines.into_inner();
    let text = format!("{out}\n{}", lines.join("\n"));
    Ran {
        out,
        lines,
        calls: t.fetch.calls().iter().map(sent).collect(),
        rw,
        text,
    }
}

async fn run(t: &TestApp, args: Value) -> Ran {
    run_with(t, args, With::default()).await
}

#[track_caller]
fn assert_match(text: &str, pattern: &str) {
    let re = Regex::new(pattern).expect("a test pattern");
    assert!(re.is_match(text), "/{pattern}/ does not match:\n{text}");
}

fn merged(base: &Value, extra: Value) -> Value {
    let mut args = base.clone();
    args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    args
}

// ---------------------------------------------------------------- list_projects

#[tokio::test]
async fn every_project_the_token_can_see_by_name_with_its_id_deleted_ones_left_out_no_go_needed() {
    let t = test_app();
    let ran = run(&t, json!({"action": "list_projects"})).await;
    assert_match(&ran.out, r"^Railway projects in the owner's Railway account \(4\):");
    assert!(ran.out.contains(&format!("- Acme (id {})", p_acme())));
    assert!(ran.out.contains(&format!("- Tarsee (id {})\n", p_tarsee())));
    assert!(!ran.out.contains("Old Thing"), "a deleted project is not listed");
    assert!(!ran.out.contains("Tarsee runs here"), "off Railway nothing is marked");
    assert_eq!(ran.calls.len(), 1);
    assert_eq!(ran.calls[0].url, API_URL);
    assert_eq!(ran.calls[0].method, "POST");
    assert_eq!(ran.calls[0].query, DOCS.projects);
    assert_eq!(ran.calls[0].content_type.as_deref(), Some("application/json"));
    assert_eq!(ran.calls[0].variables, json!({}));
    assert_eq!(ran.tokens_sent(), [format!("Bearer {TOKEN}")]);
    assert_eq!(ran.lines.len(), 1);
    assert_eq!(ran.lines[0], "[railway] list_projects project=- env=- service=- ok");
    // Node's answer, in localeCompare's order ("twin" before "Twin").
    assert_eq!(
        ran.out,
        [
            "Railway projects in the owner's Railway account (4):".to_string(),
            format!("- Acme (id {})", p_acme()),
            format!("- Tarsee (id {})", p_tarsee()),
            format!("- twin (id {})", p_twin2()),
            format!("- Twin (id {})", p_twin1()),
            "Pass project (a name or an id) to see its environments and services.".to_string(),
        ]
        .join("\n")
    );
}

#[tokio::test]
async fn with_project_its_environments_and_services_with_ids_deleted_environments_left_out() {
    let t = test_app();
    let ran = run(&t, json!({"action": "list_projects", "project": "ACME"})).await;
    assert_match(
        &ran.out,
        &format!(r#"^Project "Acme" \(id {}\) in the owner's Railway account:"#, p_acme()),
    );
    assert_match(
        &ran.out,
        r"Environments \(2\):\n- production \(id [0-9a-f-]+\)\n- Staging",
    );
    assert!(ran.out.contains(&format!("- watchdog (id {})", s_watch())));
    assert!(!ran.out.contains("pr-12"));
    assert_eq!(ran.ops(), ["TarseeProjects", "TarseeProject"]);
    let by_id = run(&t, json!({"action": "list_projects", "project": p_acme()})).await;
    assert_eq!(by_id.ops(), ["TarseeProject"], "an id goes straight to the project");
    assert_eq!(by_id.out, ran.out);
    // Node's answer.
    assert_eq!(
        ran.out,
        format!(
            "Project \"Acme\" (id {}) in the owner's Railway account:\nEnvironments (2):\n- production (id {})\n- Staging (id {})\nServices (4):\n- watchdog (id {})\n- web (id {})\n- worker (id {})\n- Worker (id {})",
            p_acme(),
            e_prod(),
            e_stage(),
            s_watch(),
            s_web(),
            s_w1(),
            s_w2()
        )
    );
}

// ---------------------------------------------------------------- the token

#[tokio::test]
async fn the_vault_key_comes_first_even_with_one_in_the_environment() {
    let t = test_app();
    let ran = run_with(
        &t,
        json!({"action": "list_projects"}),
        With {
            env: Some(Env::from_pairs([("RAILWAY_API_TOKEN", "env-tok-SECRET-000000000")])),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(ran.tokens_sent(), [format!("Bearer {TOKEN}")]);
    assert_eq!(TOKEN_KEY, "RAILWAY_API_TOKEN");
}

#[tokio::test]
async fn with_none_in_the_vault_the_environment_variable_is_used() {
    let t = test_app();
    let empty = vault_of(&[]);
    let ran = run_with(
        &t,
        json!({"action": "list_projects"}),
        With {
            vault: Some(&empty),
            env: Some(Env::from_pairs([("RAILWAY_API_TOKEN", format!(" {TOKEN} "))])),
            ..Default::default()
        },
    )
    .await;
    assert_match(&ran.out, r"^Railway projects in the owner's Railway account \(4\):");
    assert_eq!(ran.tokens_sent(), [format!("Bearer {TOKEN}")]);
}

#[tokio::test]
async fn with_neither_it_says_where_to_get_one_and_how_to_save_it_and_nothing_is_sent() {
    let t = test_app();
    let blank = vault_of(&[("RAILWAY_API_TOKEN", "  ")]);
    let none = run_with(
        &t,
        json!({"action": "list_projects"}),
        With {
            vault: Some(&blank),
            ..Default::default()
        },
    )
    .await;
    assert_match(
        &none.out,
        r"^railway list_projects error: There is no Railway token: the vault has no RAILWAY_API_TOKEN and neither does the environment\. Ask the owner for a Railway account or workspace token .*a project token will not do.* save it with tarsee_set_key as RAILWAY_API_TOKEN\. Nothing was done\.$",
    );
    assert!(none.calls.is_empty());
}

#[tokio::test]
async fn a_vault_that_cannot_be_read_says_so() {
    let t = test_app();
    let ran = run_with(
        &t,
        json!({"action": "list_projects"}),
        With {
            vault: Some(&BrokenVault),
            ..Default::default()
        },
    )
    .await;
    assert!(
        ran.out
            .contains("The vault key RAILWAY_API_TOKEN could not be read (bad decrypt)")
    );
    assert!(ran.calls.is_empty());
}

// ---------------------------------------------------------------- on Railway

#[test]
fn reads_where_it_runs_from_railways_variables_ids_only() {
    assert_eq!(
        here_of(&on_railway()),
        Here {
            project_id: Some(p_tarsee()),
            environment_id: Some(e_tarsee()),
            service_id: Some(s_tarsee()),
        }
    );
    assert_eq!(
        here_of(&Env::from_pairs([("RAILWAY_PROJECT_ID", "not-an-id")])),
        Here::default()
    );
    assert_eq!(here_of(&Env::new()), Here::default());
}

#[tokio::test]
async fn list_projects_marks_tarsees_own_project_environment_and_service() {
    let t = test_app();
    let all = run_with(
        &t,
        json!({"action": "list_projects"}),
        With {
            env: Some(on_railway()),
            ..Default::default()
        },
    )
    .await;
    assert!(
        all.out
            .contains(&format!("- Tarsee (id {}) (Tarsee runs here)", p_tarsee()))
    );
    let one = run_with(
        &t,
        json!({"action": "list_projects", "project": "tarsee"}),
        With {
            env: Some(on_railway()),
            ..Default::default()
        },
    )
    .await;
    assert_match(&one.out, r"- production \(id [^)]+\) \(Tarsee runs here\)");
    assert_match(&one.out, r"- tarsee \(id [^)]+\) \(Tarsee itself\)");
}

#[tokio::test]
async fn with_no_project_list_variables_is_about_tarsees_own_service() {
    let t = test_app();
    let ran = run_with(
        &t,
        json!({"action": "list_variables"}),
        With {
            env: Some(on_railway()),
            ..Default::default()
        },
    )
    .await;
    assert_match(
        &ran.out,
        &format!(
            r#"^Variables on tarsee \(service id {}\) in production \(environment id {}\), project "Tarsee""#,
            s_tarsee(),
            e_tarsee()
        ),
    );
    assert!(ran.out.contains("- SETUP_PASSWORD\n"));
    assert!(!ran.out.contains("1234"));
    assert_eq!(ran.ops(), ["TarseeProject", "TarseeVariableNames"]);
}

#[tokio::test]
async fn another_project_named_is_not_given_tarsees_environment_or_service() {
    let t = test_app();
    let ran = run_with(
        &t,
        json!({"action": "list_variables", "project": "Acme"}),
        With {
            env: Some(on_railway()),
            ..Default::default()
        },
    )
    .await;
    assert!(
        ran.out
            .contains("service is required: the service's name or id in the project \"Acme\"")
    );
}

#[tokio::test]
async fn redeploying_tarsee_itself_or_setting_a_variable_on_it_with_a_deploy_says_it_restarts_tarsee() {
    let t = test_app();
    let here = || With {
        env: Some(on_railway()),
        ..Default::default()
    };
    let re = run_with(&t, json!({"action": "redeploy", "approved_by": GO}), here()).await;
    assert_match(
        &re.out,
        &format!(r"^Asked Railway to redeploy tarsee \(service id {}\)", s_tarsee()),
    );
    assert_eq!(re.calls.last().unwrap().variables, json!({"id": d_tarsee()}));
    assert!(
        re.out.contains(
            "This is Tarsee's own service: the deploy restarts Tarsee, which ends the turn that asked for it."
        )
    );
    let set = run_with(
        &t,
        json!({"action": "set_variable", "name": "LOG_LEVEL", "value": "debug", "approved_by": GO}),
        here(),
    )
    .await;
    assert!(set.out.contains("restarts Tarsee"));
    let quiet = run_with(
        &t,
        json!({"action": "set_variable", "name": "LOG_LEVEL", "value": "debug", "deploy": false, "approved_by": GO}),
        here(),
    )
    .await;
    assert!(!quiet.out.contains("restarts Tarsee"), "no deploy, no restart");
    let other = run_with(
        &t,
        json!({"action": "redeploy", "project": "Acme", "service": "watchdog", "approved_by": GO}),
        here(),
    )
    .await;
    assert!(!other.out.contains("restarts Tarsee"), "another service is not Tarsee");
}

// ---------------------------------------------------------------- names to ids

#[tokio::test]
async fn a_project_name_that_matches_nothing_lists_the_projects_and_the_near_ones_and_nothing_is_changed() {
    let t = test_app();
    let ran = run(
        &t,
        json!({"action": "set_variable", "project": "acme-prod", "service": "watchdog", "name": "X_FLAG", "value": "on", "approved_by": GO}),
    )
    .await;
    assert_match(
        &ran.out,
        r#"There is no project "acme-prod" in the owner's Railway account\. Did you mean "Acme" \(id 0+-0000-4000-8000-0+1\)\?"#,
    );
    assert_match(&ran.out, r"The projects there: .*Tarsee \(id ");
    assert_match(&ran.out, r"Nothing was changed\.$");
    assert!(ran.writes().is_empty());
}

#[tokio::test]
async fn two_projects_with_the_same_name_in_any_case_are_refused_with_both_ids_to_pick_from() {
    let t = test_app();
    let ran = run(
        &t,
        json!({"action": "set_variable", "project": "twin", "service": "x", "name": "X_FLAG", "value": "on", "approved_by": GO}),
    )
    .await;
    assert!(ran.out.contains(&format!(
        "More than one project in the owner's Railway account is named \"twin\": Twin (id {}), twin (id {}). Pass the id instead.",
        p_twin1(),
        p_twin2()
    )));
    assert!(ran.writes().is_empty());
}

#[tokio::test]
async fn an_id_the_token_cannot_see_says_so_plainly() {
    let t = test_app();
    let ran = run(&t, json!({"action": "list_projects", "project": p_other()})).await;
    assert!(ran.out.contains(&format!(
        "the owner's Railway account cannot see a project with id {} (Railway said: \"Project not found\"). list_projects shows the ones it can.",
        p_other()
    )));
}

#[tokio::test]
async fn the_environment_is_production_unless_named_a_name_in_any_case_or_an_id_works_a_missing_one_lists_the_choices()
{
    let t = test_app();
    let prod = run(
        &t,
        json!({"action": "list_variables", "project": "Acme", "service": "watchdog"}),
    )
    .await;
    assert_eq!(prod.calls.last().unwrap().variables["environmentId"], json!(e_prod()));
    let stage = run(
        &t,
        json!({"action": "list_variables", "project": "Acme", "environment": "staging", "service": "watchdog"}),
    )
    .await;
    assert_eq!(stage.calls.last().unwrap().variables["environmentId"], json!(e_stage()));
    let by_id = run(
        &t,
        json!({"action": "list_variables", "project": "Acme", "environment": e_stage(), "service": s_watch()}),
    )
    .await;
    assert_eq!(by_id.calls.last().unwrap().variables["environmentId"], json!(e_stage()));
    let missing = run(
        &t,
        json!({"action": "list_variables", "project": "Acme", "environment": "prod", "service": "web"}),
    )
    .await;
    assert_match(
        &missing.out,
        r#"There is no environment "prod" in the project "Acme"\. Did you mean "production" \(id [^)]+\)\? The environments there: production \(id [^)]+\), Staging \(id [^)]+\)\."#,
    );
    let deleted = run(
        &t,
        json!({"action": "list_variables", "project": "Acme", "environment": "pr-12", "service": "web"}),
    )
    .await;
    assert!(
        deleted.out.contains("There is no environment \"pr-12\""),
        "a deleted environment is not picked"
    );
}

#[tokio::test]
async fn a_service_by_name_or_id_missing_doubled_or_not_given_each_say_so_with_the_services_listed() {
    let t = test_app();
    let missing = run(
        &t,
        json!({"action": "redeploy", "project": "Acme", "service": "watchdog-x", "approved_by": GO}),
    )
    .await;
    assert_match(
        &missing.out,
        r#"There is no service "watchdog-x" in the project "Acme"\. Did you mean "watchdog" \(id [^)]+\)\? The services there: watchdog \(id [^)]+\), web"#,
    );
    let doubled = run(
        &t,
        json!({"action": "redeploy", "project": "Acme", "service": "WORKER", "approved_by": GO}),
    )
    .await;
    assert!(doubled.out.contains(&format!(
        "More than one service in the project \"Acme\" is named \"WORKER\": worker (id {}), Worker (id {}). Pass the id instead.",
        s_w1(),
        s_w2()
    )));
    let by_id = run(
        &t,
        json!({"action": "redeploy", "project": "Acme", "service": s_w2(), "approved_by": GO}),
    )
    .await;
    assert!(by_id.out.contains("Worker has no deployment in production yet"));
    let none = run(&t, json!({"action": "list_variables", "project": "Acme"})).await;
    assert!(
        none.out.contains(
            "service is required: the service's name or id in the project \"Acme\". Services there: watchdog"
        )
    );
    for r in [&missing, &doubled, &by_id] {
        assert!(r.writes().is_empty());
    }
}

#[tokio::test]
async fn no_project_at_all_and_not_on_railway_is_refused() {
    let t = test_app();
    let ran = run(&t, json!({"action": "list_variables", "service": "web"})).await;
    assert!(ran.out.contains("project is required"));
    assert!(ran.calls.is_empty());
}

// ---------------------------------------------------------------- list_variables

#[tokio::test]
async fn the_services_names_sealed_marked_and_the_environments_shared_names_values_are_not_even_asked_for() {
    let t = test_app();
    let ran = run(
        &t,
        json!({"action": "list_variables", "project": "Acme", "service": "watchdog"}),
    )
    .await;
    assert_eq!(
        ran.out,
        format!(
            "Variables on watchdog (service id {}) in production (environment id {}), project \"Acme\" (id {}): 2 names. Values are never shown.\n- DATABASE_URL (sealed)\n- LOG_LEVEL\nShared variables in production (any service can reference them):\n- SHARED_REGION",
            s_watch(),
            e_prod(),
            p_acme()
        )
    );
    assert!(!ran.out.contains("PORT"), "another service's variable is not listed");
    for secretish in ["pw-SECRET", "info", "sin\n", "postgres://"] {
        assert!(!ran.out.contains(secretish));
    }
    let q = &ran.calls.last().unwrap().query;
    assert_eq!(q, DOCS.variable_names);
    assert!(
        !Regex::new(r"\bvalue\b").unwrap().is_match(q),
        "the names query asks for no value"
    );
}

#[tokio::test]
async fn an_environment_with_none_says_so() {
    let t = test_app();
    let ran = run(
        &t,
        json!({"action": "list_variables", "project": "Acme", "environment": "Staging", "service": "web"}),
    )
    .await;
    assert_match(
        &ran.out,
        r": 0 names\. Values are never shown\.\n {2}none\nShared variables in Staging: none$",
    );
}

// ---------------------------------------------------------------- set_variable with from_key

#[tokio::test]
async fn railway_gets_the_vault_value_the_result_says_what_was_set_with_a_masked_value_the_log_line_has_neither() {
    let t = test_app();
    let ran = run(
        &t,
        json!({"action": "set_variable", "project": "Acme", "service": "watchdog", "name": "ALERTS_WEBHOOK_URL", "from_key": "ALERTS_WEBHOOK", "approved_by": GO}),
    )
    .await;
    let writes = ran.writes();
    let w = writes[0];
    assert_eq!(w.query, DOCS.upsert);
    assert_eq!(
        w.variables,
        json!({"projectId": p_acme(), "environmentId": e_prod(), "serviceId": s_watch(), "variables": {"ALERTS_WEBHOOK_URL": hook()}, "skipDeploys": false})
    );
    assert_eq!(w.authorization.as_deref(), Some(format!("Bearer {TOKEN}").as_str()));
    assert_eq!(
        ran.rw.value_of(&e_prod(), "ALERTS_WEBHOOK_URL"),
        Some(hook()),
        "it reached Railway"
    );
    assert_eq!(
        ran.out,
        [
            format!(
                "Set ALERTS_WEBHOOK_URL on watchdog (service id {}) in production (environment id {}), project \"Acme\" (id {}).",
                s_watch(),
                e_prod(),
                p_acme()
            ),
            format!(
                "value: from the vault key ALERTS_WEBHOOK (masked: {}). The value was not shown anywhere.",
                mask_value(&hook())
            ),
            "ALERTS_WEBHOOK_URL is a new variable on watchdog.".to_string(),
            "deploy: yes. Railway redeploys watchdog in production with it, as it does on any variable change.".to_string(),
        ]
        .join("\n")
    );
    assert_eq!(mask_value(&hook()), "http...9xyz");
    for secret in [hook().as_str(), "wh-SECRET", TOKEN] {
        assert!(
            !ran.text.contains(secret),
            "no {} in the result or the log",
            &secret[..12]
        );
    }
    assert_eq!(ran.lines.len(), 1);
    assert_eq!(
        ran.lines[0],
        format!(
            "[railway] set_variable project=\"Acme\" ({}) env=\"production\" ({}) service=\"watchdog\" ({}) go=\"{GO}\" name=ALERTS_WEBHOOK_URL from_key=ALERTS_WEBHOOK deploy=yes ok",
            p_acme(),
            e_prod(),
            s_watch()
        )
    );
}

#[tokio::test]
async fn deploy_false_sets_it_with_skip_deploys_and_says_it_takes_effect_on_the_next_deploy() {
    let t = test_app();
    let ran = run(
        &t,
        json!({"action": "set_variable", "project": "Acme", "service": "watchdog", "name": "ALERTS_WEBHOOK_URL", "from_key": "ALERTS_WEBHOOK", "deploy": false, "approved_by": GO}),
    )
    .await;
    assert_eq!(ran.writes()[0].variables["skipDeploys"], json!(true));
    assert_match(
        &ran.out,
        r"deploy: no \(deploy: false\)\. watchdog keeps the old value until its next deploy; redeploy starts one\.$",
    );
}

#[tokio::test]
async fn a_variable_that_is_already_there_is_replaced_and_the_result_says_so_sealed_noted() {
    let t = test_app();
    let ran = run(
        &t,
        json!({"action": "set_variable", "project": "Acme", "service": "watchdog", "name": "DATABASE_URL", "from_key": "ALERTS_WEBHOOK", "approved_by": GO}),
    )
    .await;
    assert!(
        ran.out
            .contains("It replaced the value DATABASE_URL had (it was sealed).")
    );
}

#[tokio::test]
async fn when_railways_error_repeats_the_value_as_is_or_json_escaped_the_error_and_the_log_show_stars_instead() {
    let t = test_app();
    let quoted = "p\"a\\ss-SECRET-word-0987";
    let echo_quoted = {
        let json = serde_json::to_string(quoted).unwrap();
        json[1..json.len() - 1].to_string()
    };
    for (key, val, echo) in [
        ("ALERTS_WEBHOOK", hook(), hook()),
        ("ODD_KEY", quoted.to_string(), echo_quoted.clone()),
    ] {
        let target = if key == "ODD_KEY" { "X" } else { "ALERTS_WEBHOOK_URL" };
        let rw = failing(Fail {
            op: "TarseeVariableUpsert",
            errors: Some(vec![format!("Invalid value \"{echo}\" for {target}")]),
            ..Default::default()
        });
        let vault = vault_of(&[("RAILWAY_API_TOKEN", TOKEN), (key, &val)]);
        let ran = run_with(
            &t,
            json!({"action": "set_variable", "project": "Acme", "service": "watchdog", "name": "ALERTS_WEBHOOK_URL", "from_key": key, "approved_by": GO}),
            With {
                rw: Some(rw),
                vault: Some(&vault),
                ..Default::default()
            },
        )
        .await;
        assert_match(
            &ran.out,
            r#"^railway set_variable error: Railway said: "Invalid value "\*\*\*\*" for "#,
        );
        assert_match(&ran.out, r"Nothing was changed\.$");
        assert!(
            !ran.text.contains(&val) && !ran.text.contains(&echo) && !ran.text.contains("SECRET"),
            "no trace of the value: {}",
            ran.text
        );
    }
}

#[tokio::test]
async fn an_error_that_repeats_the_token_is_scrubbed_too_the_environments_token_included() {
    let t = test_app();
    let rw = failing(Fail {
        op: "TarseeProjects",
        status: Some(401),
        errors: Some(vec![format!("bad token {TOKEN}")]),
        ..Default::default()
    });
    let ran = run_with(
        &t,
        json!({"action": "list_projects"}),
        With {
            rw: Some(rw),
            ..Default::default()
        },
    )
    .await;
    assert!(ran.out.contains(
        "Railway did not accept this with the token for the owner's Railway account (Railway said: \"bad token ****\")"
    ));
    assert!(
        ran.out
            .contains("it may be a project token (this needs an account or workspace token)")
    );
    assert!(!ran.text.contains(TOKEN));
    let empty = vault_of(&[]);
    let via_env = run_with(
        &t,
        json!({"action": "list_projects"}),
        With {
            rw: Some(failing(Fail {
                op: "*",
                status: Some(401),
                errors: Some(vec![format!("bad token {TOKEN}")]),
                ..Default::default()
            })),
            vault: Some(&empty),
            env: Some(Env::from_pairs([("RAILWAY_API_TOKEN", TOKEN)])),
            ..Default::default()
        },
    )
    .await;
    assert!(!via_env.text.contains(TOKEN));
}

#[tokio::test]
async fn a_vault_key_that_is_not_there_or_is_empty_is_refused_before_anything_is_sent() {
    let t = test_app();
    let missing = run(
        &t,
        json!({"action": "set_variable", "project": "Acme", "service": "web", "name": "A_B", "from_key": "NOPE_KEY", "approved_by": GO}),
    )
    .await;
    assert_match(
        &missing.out,
        r"The vault has no key named NOPE_KEY\. tarsee_list_keys lists the names\. Nothing was changed\.$",
    );
    assert!(missing.calls.is_empty());
    let vault = vault_of(&[("RAILWAY_API_TOKEN", TOKEN), ("EMPTY_KEY", "")]);
    let empty = run_with(
        &t,
        json!({"action": "set_variable", "project": "Acme", "service": "web", "name": "A_B", "from_key": "EMPTY_KEY", "approved_by": GO}),
        With {
            vault: Some(&vault),
            ..Default::default()
        },
    )
    .await;
    assert!(empty.out.contains("The vault key EMPTY_KEY is empty"));
    assert!(empty.calls.is_empty());
}

#[tokio::test]
async fn a_lower_case_key_name_finds_the_key_saved_in_capitals() {
    let t = test_app();
    let ran = run(
        &t,
        json!({"action": "set_variable", "project": "Acme", "service": "watchdog", "name": "ALERTS_WEBHOOK_URL", "from_key": "alerts_webhook", "approved_by": GO}),
    )
    .await;
    assert_match(&ran.out, r"^Set ALERTS_WEBHOOK_URL on watchdog");
    assert_eq!(
        ran.writes()[0].variables["variables"]["ALERTS_WEBHOOK_URL"],
        json!(hook())
    );
}

#[tokio::test]
async fn if_railway_stops_answering_during_the_write_it_says_the_outcome_is_unknown_and_to_check_first() {
    let t = test_app();
    let ran = run_with(
        &t,
        json!({"action": "set_variable", "project": "Acme", "service": "watchdog", "name": "ALERTS_WEBHOOK_URL", "from_key": "ALERTS_WEBHOOK", "approved_by": GO}),
        With {
            rw: Some(failing(Fail {
                op: "TarseeVariableUpsert",
                network: Some("ECONNRESET"),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
    .await;
    assert_match(
        &ran.out,
        r"stopped answering while the variable was being set \(ECONNRESET\), so it is not known whether ALERTS_WEBHOOK_URL was set\. Check with list_variables before trying again\.$",
    );
    assert!(!ran.out.contains("Nothing was changed"));
}

// ---------------------------------------------------------------- set_variable: from_key or value

fn base() -> Value {
    json!({"action": "set_variable", "project": "Acme", "service": "web", "name": "FEATURE_FLAG", "approved_by": GO})
}

#[tokio::test]
async fn both_or_neither_is_refused_before_anything_is_sent() {
    let t = test_app();
    let both = run(
        &t,
        merged(&base(), json!({"from_key": "ALERTS_WEBHOOK", "value": "on"})),
    )
    .await;
    assert_match(
        &both.out,
        r"Pass the value one way only: from_key .* or value .*, not both\. Nothing was changed\.$",
    );
    let neither = run(&t, base()).await;
    assert!(neither.out.contains(
        "Pass the value: from_key (the vault key that holds it, for anything secret) or value (plain, non-secret text only)."
    ));
    for r in [&both, &neither] {
        assert!(r.calls.is_empty());
    }
}

#[tokio::test]
async fn a_plain_value_is_set_as_given_and_shown_with_railways_usual_deploy() {
    let t = test_app();
    let ran = run(&t, merged(&base(), json!({"value": "on"}))).await;
    assert_eq!(ran.writes()[0].variables["variables"], json!({"FEATURE_FLAG": "on"}));
    assert_match(
        &ran.out,
        r#"^Set FEATURE_FLAG on web .*\nvalue: "on" \(plain value\)\nFEATURE_FLAG is a new variable on web\.\ndeploy: yes\."#,
    );
    assert_match(&ran.lines[0], r"name=FEATURE_FLAG value=plain deploy=yes ok$");
    assert!(
        !ran.lines[0].contains("\"on\""),
        "even a plain value stays out of the log"
    );
}

#[tokio::test]
async fn a_value_that_is_a_vault_keys_value_is_refused_and_pointed_at_from_key() {
    let t = test_app();
    let ran = run(&t, merged(&base(), json!({"value": hook()}))).await;
    assert!(
        ran.out
            .contains("That value is the vault key ALERTS_WEBHOOK. Pass from_key: \"ALERTS_WEBHOOK\" instead")
    );
    assert!(!ran.out.contains(&hook()));
    assert!(ran.calls.is_empty());
}

#[tokio::test]
async fn a_value_shaped_like_a_secret_is_refused() {
    let t = test_app();
    let key = format!("sk-{}-api03-abcdefghijklmnop", "ant");
    for (value, what) in [
        (
            format!("https://discord.com/api/{}/123456789012345678/abcDEF-ghi", "webhooks"),
            "a Discord webhook URL",
        ),
        (
            "postgres://app:hunter2@db.example.com:5432/app".to_string(),
            "a URL with a password in it",
        ),
        (key, "an API key or token"),
        ("-----BEGIN RSA PRIVATE KEY-----\nabc".to_string(), "a private key"),
    ] {
        let ran = run(&t, merged(&base(), json!({"value": value}))).await;
        assert!(
            ran.out.contains(&format!(
                "value looks like a secret ({what}). Save it in the vault with tarsee_set_key and pass from_key"
            )),
            "{value}: {}",
            ran.out
        );
        assert!(ran.calls.is_empty());
    }
}

#[tokio::test]
async fn a_bad_variable_name_is_refused() {
    let t = test_app();
    for name in ["", "1ST", "has space", "dash-ed"] {
        let ran = run(&t, merged(&base(), json!({"name": name, "value": "x"}))).await;
        let want = if name.is_empty() {
            "name is required"
        } else {
            "is not a usable variable name"
        };
        assert!(ran.out.contains(want), "{name}: {}", ran.out);
        assert!(ran.calls.is_empty());
    }
}

// ---------------------------------------------------------------- approved_by

async fn without_a_go_it_does_nothing(action: &str) {
    let t = test_app();
    for approved_by in [None, Some(""), Some("   ")] {
        let mut args = json!({"action": action, "project": "Acme", "service": "watchdog", "name": "X_Y", "from_key": "ALERTS_WEBHOOK"});
        if let Some(go) = approved_by {
            args["approved_by"] = json!(go);
        }
        let ran = run(&t, args).await;
        assert_match(
            &ran.out,
            &format!(
                "^railway {action} error: {action} changes a Railway service, so it needs approved_by: who gave the go and for what"
            ),
        );
        assert_match(
            &ran.out,
            r"Who can give it: the owner, or whoever your instructions \(AGENTS\.md, USER\.md\) say may\. If nobody has said go for this exact change, ask first\. Nothing was done\.$",
        );
        assert!(ran.calls.is_empty());
        assert_match(&ran.lines[0], &format!(r"^\[railway\] {action} project=- .* failed: "));
    }
}

#[tokio::test]
async fn set_variable_without_it_or_with_only_spaces_does_nothing_and_says_to_ask() {
    without_a_go_it_does_nothing("set_variable").await;
}

#[tokio::test]
async fn redeploy_without_it_or_with_only_spaces_does_nothing_and_says_to_ask() {
    without_a_go_it_does_nothing("redeploy").await;
}

#[tokio::test]
async fn the_reads_need_no_go() {
    let t = test_app();
    for action in ["list_projects", "list_variables"] {
        let ran = run(&t, json!({"action": action, "project": "Acme", "service": "web"})).await;
        assert!(!ran.out.split('\n').next().unwrap().contains("error"), "{}", ran.out);
    }
}

// ---------------------------------------------------------------- redeploy

#[tokio::test]
async fn redeploys_the_services_latest_deployment_in_the_environment_and_gives_the_new_deployments_id() {
    let t = test_app();
    let ran = run(
        &t,
        json!({"action": "redeploy", "project": "Acme", "service": "watchdog", "approved_by": GO}),
    )
    .await;
    assert_eq!(
        ran.ops(),
        [
            "TarseeProjects",
            "TarseeProject",
            "TarseeLatestDeployment",
            "TarseeRedeploy"
        ]
    );
    assert_eq!(
        ran.calls[2].variables,
        json!({"input": {"environmentId": e_prod(), "serviceId": s_watch()}})
    );
    assert_eq!(ran.calls[3].variables, json!({"id": d_last()}));
    assert_eq!(
        ran.out,
        format!(
            "Asked Railway to redeploy watchdog (service id {}) in production (environment id {}), project \"Acme\" (id {}).\nIt redeploys the latest deployment {} (success, made 2026-10-26T10:00:00Z), with the service's current variables.\nnew deployment id: {}",
            s_watch(),
            e_prod(),
            p_acme(),
            d_last(),
            d_new()
        )
    );
    assert_match(&ran.lines[0], &format!("from_deployment={} ok$", d_last()));
}

#[tokio::test]
async fn a_service_with_no_deployment_says_so_and_asks_for_nothing() {
    let t = test_app();
    let ran = run(
        &t,
        json!({"action": "redeploy", "project": "Acme", "service": "web", "approved_by": GO}),
    )
    .await;
    assert!(
        ran.out
            .contains("web has no deployment in production yet, so there is nothing to redeploy.")
    );
    assert!(ran.writes().is_empty());
}

#[tokio::test]
async fn if_railway_stops_answering_during_the_redeploy_the_outcome_is_unknown_and_it_says_to_check() {
    let t = test_app();
    let ran = run_with(
        &t,
        json!({"action": "redeploy", "project": "Acme", "service": "watchdog", "approved_by": GO}),
        With {
            rw: Some(failing(Fail {
                op: "TarseeRedeploy",
                network: Some("ETIMEDOUT"),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
    .await;
    assert_match(
        &ran.out,
        r"it is not known whether one started\. Check the service's deployments in Railway before trying again\.$",
    );
}

// ---------------------------------------------------------------- Railway's refusals in plain English

async fn refused(fail: Fail, want: &str) {
    let t = test_app();
    let ran = run_with(
        &t,
        json!({"action": "list_projects"}),
        With {
            rw: Some(failing(Fail { op: "*", ..fail })),
            ..Default::default()
        },
    )
    .await;
    assert_match(&ran.out, r"^railway list_projects error: ");
    assert_match(&ran.out, want);
}

#[tokio::test]
async fn refusal_401_not_authorized() {
    refused(
        Fail {
            status: Some(401),
            errors: Some(vec!["Not Authorized".into()]),
            ..Default::default()
        },
        r#"Railway did not accept this with the token for the owner's Railway account \(Railway said: "Not Authorized"\)\. The token may have been revoked or replaced, .* list_projects shows what it can see; if that fails too, ask the owner for a new token, saved in the vault as RAILWAY_API_TOKEN\."#,
    )
    .await;
}

#[tokio::test]
async fn refusal_200_not_authorized() {
    refused(
        Fail {
            status: Some(200),
            errors: Some(vec!["Not Authorized".into()]),
            ..Default::default()
        },
        r"Railway did not accept this with the token",
    )
    .await;
}

#[tokio::test]
async fn refusal_429_too_many_requests() {
    refused(
        Fail {
            status: Some(429),
            errors: Some(vec!["Too many requests".into()]),
            ..Default::default()
        },
        r"Railway is limiting how often it is called right now \(too many requests\)\. Wait a minute and try again\.",
    )
    .await;
}

#[tokio::test]
async fn refusal_503_html_service_unavailable() {
    refused(
        Fail {
            status: Some(503),
            raw: Some("<html>Service Unavailable</html>"),
            ..Default::default()
        },
        r"Railway's API had a problem on its side \(HTTP 503\)\. Try again in a minute\.",
    )
    .await;
}

#[tokio::test]
async fn refusal_enotfound() {
    refused(
        Fail {
            network: Some("ENOTFOUND"),
            ..Default::default()
        },
        r"Railway's API could not be reached \(ENOTFOUND\)\. Check the internet connection and try again\.",
    )
    .await;
}

#[tokio::test]
async fn refusal_200_html_login() {
    refused(
        Fail {
            status: Some(200),
            raw: Some("<html>login</html>"),
            ..Default::default()
        },
        r"Railway's API sent back something that is not an answer \(HTTP 200\)",
    )
    .await;
}

#[tokio::test]
async fn refusal_400_cannot_query_field() {
    refused(
        Fail {
            status: Some(400),
            errors: Some(vec!["Cannot query field \"foo\" on type \"Query\".".into()]),
            ..Default::default()
        },
        r#"Railway said: "Cannot query field "foo" on type "Query"\."\."#,
    )
    .await;
}

#[tokio::test]
async fn no_answer_in_time_is_a_plain_timeout() {
    let t = test_app();
    let ran = run_with(
        &t,
        json!({"action": "list_projects"}),
        With {
            rw: Some(failing(Fail {
                op: "*",
                hang: true,
                ..Default::default()
            })),
            timeout: Some(Duration::from_millis(30)),
            ..Default::default()
        },
    )
    .await;
    assert!(
        ran.out
            .contains("Railway's API could not be reached (no answer within 0 seconds)"),
        "{}",
        ran.out
    );
}

#[tokio::test]
async fn a_write_that_railway_refuses_ends_with_nothing_was_changed() {
    let t = test_app();
    let ran = run_with(
        &t,
        json!({"action": "set_variable", "project": "Acme", "service": "web", "name": "A_B", "value": "1", "approved_by": GO}),
        With {
            rw: Some(failing(Fail {
                op: "TarseeVariableUpsert",
                errors: Some(vec!["Service instance not found".into()]),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
    .await;
    assert_eq!(
        ran.out,
        "railway set_variable error: Railway said: \"Service instance not found\". Nothing was changed."
    );
}

// ---------------------------------------------------------------- unknown actions and no delete paths

#[tokio::test]
async fn anything_not_in_the_list_is_refused_deletes_by_name_included_and_nothing_is_sent() {
    let t = test_app();
    for action in [
        Some("delete_variable"),
        Some("variable_delete"),
        Some("delete_service"),
        Some("delete_project"),
        Some(""),
        None,
        Some("set_variables"),
    ] {
        let mut args = json!({"project": "Acme", "service": "web", "name": "PORT", "approved_by": GO});
        if let Some(action) = action {
            args["action"] = json!(action);
        }
        let ran = run(&t, args).await;
        assert_match(
            &ran.out,
            r#"Unknown action ".*"\. This tool does: list_projects, list_variables, set_variable, redeploy\. It never deletes anything"#,
        );
        assert!(ran.calls.is_empty());
    }
}

#[test]
fn the_actions_are_the_four_none_a_delete_the_documents_delete_nothing_and_never_replace_the_whole_set() {
    assert_eq!(ACTIONS, ["list_projects", "list_variables", "set_variable", "redeploy"]);
    let deleting = Regex::new(r"(?i)[a-z]Delete\b|Remove\b|\breplace\b|destroy").unwrap();
    for doc in DOCS.all() {
        assert!(!deleting.is_match(doc), "{doc}");
    }
    let code = include_str!("../railway_admin.rs");
    assert!(
        !Regex::new(r"(?i)variableDelete|serviceDelete|projectDelete|environmentDelete|deploymentRemove|replace:")
            .unwrap()
            .is_match(code),
        "no delete or replace anywhere in the module"
    );
}

#[tokio::test]
async fn every_action_run_end_to_end_sends_only_the_tools_own_documents() {
    let t = test_app();
    let rw = railway();
    rw.install(&t);
    let vault = fake_vault();
    let env = Env::new();
    for args in [
        json!({"action": "list_projects"}),
        json!({"action": "list_projects", "project": "Acme"}),
        json!({"action": "list_variables", "project": "Acme", "service": "web"}),
        json!({"action": "set_variable", "project": "Acme", "service": "web", "name": "A_B", "value": "1", "approved_by": GO}),
        json!({"action": "set_variable", "project": "Acme", "service": "watchdog", "name": "HOOK_URL", "from_key": "ALERTS_WEBHOOK", "deploy": false, "approved_by": GO}),
        json!({"action": "redeploy", "project": "Acme", "service": "watchdog", "approved_by": GO}),
    ] {
        let quiet = |_: &str| {};
        railway_admin(
            &t.app,
            &args,
            RailwayDeps {
                vault: Some(&vault),
                env: Some(&env),
                log: Some(&quiet),
                timeout: None,
            },
        )
        .await;
    }
    let calls: Vec<Sent> = t.fetch.calls().iter().map(sent).collect();
    assert!(calls.len() >= 12);
    let known = DOCS.all();
    for c in &calls {
        assert!(known.contains(&c.query.as_str()), "{}", c.query);
    }
    let writes: Vec<&str> = calls
        .iter()
        .filter(|c| c.query.starts_with("mutation"))
        .map(|c| c.op.as_str())
        .collect();
    assert_eq!(
        writes,
        ["TarseeVariableUpsert", "TarseeVariableUpsert", "TarseeRedeploy"]
    );
}

// ---------------------------------------------------------------- wording

#[test]
fn no_long_dash_in_the_module() {
    assert!(!include_str!("../railway_admin.rs").contains('\u{2014}'));
}

#[test]
fn the_default_tools_md_has_a_railway_section() {
    let tools = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("workspace-defaults")
            .join("TOOLS.md"),
    )
    .unwrap()
    .replace("\r\n", "\n");
    assert!(tools.contains(
        "## Railway (projects, variables, redeploys)\n- List projects, services and variable names, set a variable or redeploy with tarsee_railway."
    ));
    assert!(tools.contains("pass set_variable from_key (the vault key name)"));
    assert!(tools.contains("approved_by"));
    assert!(tools.contains("Redeploying Tarsee's own service restarts it"));
    let section = &tools[tools.find("## Railway").unwrap()..];
    assert!(!section.contains('\u{2014}'));
}

// ---------------------------------------------------------------- the real vault (a temporary one)

#[tokio::test]
async fn with_no_vault_given_the_token_and_the_from_key_value_come_from_the_key_vault_encrypted_at_rest() {
    let t = test_app_with_env([("ENCRYPTION_KEY", "railway-admin-test-encryption-key-0123456789")]);
    key_vault::set_key(&t.app, "RAILWAY_API_TOKEN", TOKEN, Some("test token")).unwrap();
    key_vault::set_key(&t.app, "ALERTS_WEBHOOK", &hook(), Some("test webhook")).unwrap();
    let rw = railway();
    rw.install(&t);
    let env = Env::new();
    let quiet = |_: &str| {};
    let out = railway_admin(
        &t.app,
        &json!({"action": "set_variable", "project": "Acme", "service": "watchdog", "name": "ALERTS_WEBHOOK_URL", "from_key": "ALERTS_WEBHOOK", "approved_by": GO}),
        RailwayDeps {
            env: Some(&env),
            log: Some(&quiet),
            ..Default::default()
        },
    )
    .await;
    assert_match(&out, r"^Set ALERTS_WEBHOOK_URL on watchdog");
    assert_eq!(rw.value_of(&e_prod(), "ALERTS_WEBHOOK_URL"), Some(hook()));
    assert!(!out.contains(&hook()));
    let file = t.path().join("data").join("vault.json");
    assert!(file.exists(), "the temporary vault file");
    assert!(
        !std::fs::read_to_string(&file).unwrap().contains("wh-SECRET"),
        "encrypted on disk"
    );
    // And a plain value that is a key's value is recognised in the real vault too.
    let ran = railway_admin(
        &t.app,
        &json!({"action": "set_variable", "project": "Acme", "service": "web", "name": "X", "value": hook(), "approved_by": GO}),
        RailwayDeps {
            env: Some(&env),
            log: Some(&quiet),
            ..Default::default()
        },
    )
    .await;
    assert!(ran.contains("That value is the vault key ALERTS_WEBHOOK."), "{ran}");
}

// ---------------------------------------------------------------- what the Node tests left out

#[test]
fn names_sort_as_local_compare_sorts_them() {
    // Node's own order for these (`[...].sort((a, b) => a.localeCompare(b))`).
    let mut names = vec![
        "web",
        "Web",
        "WEB",
        "web-2",
        "web_2",
        "web 2",
        "web2",
        "Worker",
        "worker",
        "A_B",
        "AB",
        "A-B",
        "a_b",
        "Ab",
        "ab",
        "_x",
        "x",
        "X_Y",
        "x_y",
        "Z",
        "é",
        "e",
        "E",
        "ä",
        "b",
        "DATABASE_URL",
        "LOG_LEVEL",
        "SHARED_REGION",
        "PORT",
        "api",
        "Api",
        "APIs",
        "API_KEY",
        "APIKEY",
        "api-key",
    ];
    names.sort_by(|a, b| locale_compare(a, b));
    assert_eq!(
        names,
        [
            "_x",
            "ä",
            "a_b",
            "A_B",
            "A-B",
            "ab",
            "Ab",
            "AB",
            "api",
            "Api",
            "API_KEY",
            "api-key",
            "APIKEY",
            "APIs",
            "b",
            "DATABASE_URL",
            "e",
            "E",
            "é",
            "LOG_LEVEL",
            "PORT",
            "SHARED_REGION",
            "web",
            "Web",
            "WEB",
            "web 2",
            "web_2",
            "web-2",
            "web2",
            "worker",
            "Worker",
            "x",
            "x_y",
            "X_Y",
            "Z",
        ]
    );
    assert_eq!(locale_compare("Twin", "twin"), Ordering::Greater);
    assert_eq!(locale_compare("a\u{0}b", "ab"), Ordering::Equal);
}

#[test]
fn masks_and_encodings() {
    assert_eq!(mask_value("short"), "****");
    assert_eq!(mask_value("12345678901"), "****");
    assert_eq!(mask_value("123456789012"), "1234...9012");
    assert_eq!(mask_value("🐒🐒🐒🐒🐒🐒"), "🐒🐒...🐒🐒");
    assert_eq!(encode_uri_component("a b/ü!*'()~-_."), "a%20b%2F%C3%BC!*'()~-_.");
    let note = Note {
        secrets: vec!["p\"a ss/word-0987".into(), "tiny".into()],
        ..Default::default()
    };
    assert_eq!(
        note.scrub("x p\"a ss/word-0987 y p\\\"a ss/word-0987 z p%22a%20ss%2Fword-0987 tiny"),
        "x **** y **** z **** tiny"
    );
}

#[test]
fn where_tarsee_runs_ignores_spaces_around_an_id_and_anything_not_an_id() {
    let env = Env::from_pairs([
        ("RAILWAY_PROJECT_ID", format!(" {} ", p_acme().to_uppercase())),
        ("RAILWAY_ENVIRONMENT_ID", "".to_string()),
        ("RAILWAY_SERVICE_ID", format!("{}x", s_web())),
    ]);
    assert_eq!(
        here_of(&env),
        Here {
            project_id: Some(p_acme().to_uppercase()),
            environment_id: None,
            service_id: None,
        }
    );
}

#[tokio::test]
async fn by_default_the_line_is_logged_and_the_apps_environment_gives_the_token() {
    let t = test_app_with_env([("RAILWAY_API_TOKEN", TOKEN)]);
    let rw = railway();
    rw.install(&t);
    let empty = vault_of(&[]);
    let logs = crate::testkit::CapturedLogs::start();
    let out = railway_admin(
        &t.app,
        &json!({"action": "list_projects"}),
        RailwayDeps {
            vault: Some(&empty),
            ..Default::default()
        },
    )
    .await;
    assert!(
        out.starts_with("Railway projects in the owner's Railway account (4):"),
        "{out}"
    );
    assert_eq!(logs.infos(), ["[railway] list_projects project=- env=- service=- ok"]);
    // Input that is not an object is no action.
    let out = railway_admin(&t.app, &json!("list_projects"), RailwayDeps::default()).await;
    assert!(out.starts_with("railway error: Unknown action \"\"."), "{out}");
}

#[tokio::test]
async fn a_read_that_railway_refuses_does_not_say_nothing_was_changed() {
    let t = test_app();
    let ran = run_with(
        &t,
        json!({"action": "list_projects"}),
        With {
            rw: Some(failing(Fail {
                op: "*",
                status: Some(401),
                errors: Some(vec!["Not Authorized".into()]),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
    .await;
    // Node's answer.
    assert_eq!(
        ran.out,
        "railway list_projects error: Railway did not accept this with the token for the owner's Railway account (Railway said: \"Not Authorized\"). The token may have been revoked or replaced, it may be a project token (this needs an account or workspace token), or the project may be in a workspace it cannot reach. list_projects shows what it can see; if that fails too, ask the owner for a new token, saved in the vault as RAILWAY_API_TOKEN."
    );
}

#[tokio::test]
async fn tarsees_own_service_in_another_environment_is_not_tarsee() {
    let t = test_app();
    // Tarsee runs in an environment of its project that is not the one asked for.
    let env = Env::from_pairs([
        ("RAILWAY_PROJECT_ID", p_tarsee()),
        ("RAILWAY_ENVIRONMENT_ID", id(99)),
        ("RAILWAY_SERVICE_ID", s_tarsee()),
    ]);
    let ran = run_with(
        &t,
        json!({"action": "redeploy", "environment": "production", "approved_by": GO}),
        With {
            env: Some(env),
            ..Default::default()
        },
    )
    .await;
    assert!(ran.out.starts_with("Asked Railway to redeploy tarsee"), "{}", ran.out);
    assert!(!ran.out.contains("restarts Tarsee"), "{}", ran.out);
}

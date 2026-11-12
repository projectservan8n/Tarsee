//! Port of `src/lib/skills-engine.js`: the skills. A skill is a folder holding a SKILL.md; the ones that ship with
//! Tarsee are copied into the workspace to install them, and only installed skills are active (listed in the system
//! prompt).
//!
//! The JS kept its 30 second scan cache in module variables; here it is a service in the [`App`].

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::app::App;
use crate::lib::workspace_files::jstext::{js_collapse_spaces, js_trim, read_dir_sorted};
use crate::util::js::utf16_len;

const CACHE_TTL: Duration = Duration::from_secs(30);

/// One skill found on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skill {
    /// The name its SKILL.md gives, else its folder's name.
    pub name: String,
    pub description: String,
    /// "installed" (the workspace) or "built-in" (shipped with Tarsee).
    pub source: String,
    pub folder: String,
    pub path: PathBuf,
}

/// A shipped skill and whether it is installed (`getAllSkillsWithStatus`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillStatus {
    pub name: String,
    pub description: String,
    pub source: String,
    pub installed: bool,
}

/// An installed skill, briefly (`getSkillsList`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillSummary {
    pub name: String,
    pub description: String,
    pub source: String,
}

/// An installed skill's whole SKILL.md (`getSkillContent`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkillContent {
    pub name: String,
    pub description: String,
    pub source: String,
    /// The text after the frontmatter.
    pub content: String,
    pub frontmatter: Map<String, Value>,
}

/// A SKILL.md split into its frontmatter and its body.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSkill {
    /// Every `key: value` line of the frontmatter, values as strings.
    pub frontmatter: Map<String, Value>,
    pub body: String,
}

/// Why a skill could not be installed.
#[derive(Debug, thiserror::Error)]
pub enum SkillError {
    #[error("Skill \"{0}\" not found")]
    NotFound(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

#[derive(Default)]
struct SkillsCache {
    scanned: Mutex<Option<(Vec<Skill>, Instant)>>,
}

static FRONTMATTER: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?s)\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\z").expect("the frontmatter pattern")
});

/// Parses the simple YAML frontmatter of a SKILL.md (`key: value` lines; name and description are the ones used).
/// Without frontmatter the first `# ` heading names the skill.
pub fn parse_frontmatter(content: &str) -> ParsedSkill {
    let Some(caps) = FRONTMATTER.captures(content) else {
        // No frontmatter: use the first heading as name, no description.
        let heading = content.split('\n').find(|l| l.starts_with("# "));
        let name = match heading {
            Some(h) => {
                let rest = h[1..].trim_start_matches(crate::lib::workspace_files::jstext::is_js_space);
                js_collapse_spaces(&js_trim(rest).to_lowercase(), "-")
            }
            None => "unnamed".to_string(),
        };
        let mut frontmatter = Map::new();
        frontmatter.insert("name".into(), Value::String(name));
        frontmatter.insert("description".into(), Value::String(String::new()));
        return ParsedSkill {
            frontmatter,
            body: content.to_string(),
        };
    };

    let yaml = caps.get(1).map_or("", |m| m.as_str());
    let body = caps.get(2).map_or("", |m| m.as_str()).to_string();
    let mut frontmatter = Map::new();
    for line in yaml.split('\n') {
        let Some(colon) = line.find(':') else { continue };
        let key = js_trim(&line[..colon]);
        let mut val = js_trim(&line[colon + 1..]);
        // `.replace(/^["']|["']$/g, "")`: one quote off each end.
        if let Some(rest) = val.strip_prefix(['"', '\'']) {
            val = rest;
        }
        if let Some(rest) = val.strip_suffix(['"', '\'']) {
            val = rest;
        }
        if !key.is_empty() {
            frontmatter.insert(key.to_string(), Value::String(val.to_string()));
        }
    }
    ParsedSkill { frontmatter, body }
}

/// The skills that ship with Tarsee.
pub fn get_built_in_skills_dir(app: &App) -> PathBuf {
    app.config().bundled_skills_dir()
}

/// The installed skills: the workspace's `skills` folder, which persists on the volume.
pub fn get_custom_skills_dir(app: &App) -> PathBuf {
    app.config().skills_dir()
}

fn frontmatter_text(frontmatter: &Map<String, Value>, key: &str) -> String {
    match frontmatter.get(key) {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// The skill folders (folders holding a SKILL.md) in `dir`. A folder that cannot be read is skipped.
fn scan_directory(dir: &Path, source: &str) -> Vec<Skill> {
    let mut skills = Vec::new();
    // A missing or unreadable folder has no skills.
    let Ok(entries) = read_dir_sorted(dir) else {
        return skills;
    };
    for entry in entries {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let folder = entry.file_name().to_string_lossy().into_owned();
        let skill_md = dir.join(&folder).join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        // Skip corrupted skill files.
        let Ok(bytes) = fs::read(&skill_md) else { continue };
        let ParsedSkill { frontmatter, .. } = parse_frontmatter(&String::from_utf8_lossy(&bytes));
        let name = frontmatter_text(&frontmatter, "name");
        skills.push(Skill {
            name: if name.is_empty() { folder.clone() } else { name },
            description: frontmatter_text(&frontmatter, "description"),
            source: source.to_string(),
            folder,
            path: skill_md,
        });
    }
    skills
}

/// The INSTALLED skills (the workspace folder), through a 30 second cache. Only installed skills are active and
/// injected into the system prompt.
pub fn scan_skills(app: &App) -> Vec<Skill> {
    let cache = app.get_or_init(SkillsCache::default);
    if let Some((skills, at)) = cache.scanned.lock().as_ref()
        && at.elapsed() < CACHE_TTL
    {
        return skills.clone();
    }
    let skills = scan_directory(&get_custom_skills_dir(app), "installed");
    *cache.scanned.lock() = Some((skills.clone(), Instant::now()));
    skills
}

/// Every shipped skill, with whether it is installed (by name).
pub fn get_all_skills_with_status(app: &App) -> Vec<SkillStatus> {
    let built_in = scan_directory(&get_built_in_skills_dir(app), "built-in");
    let installed = scan_directory(&get_custom_skills_dir(app), "installed");
    built_in
        .into_iter()
        .map(|s| SkillStatus {
            installed: installed.iter().any(|i| i.name == s.name),
            name: s.name,
            description: s.description,
            source: s.source,
        })
        .collect()
}

/// Installs a skill: copies its shipped folder into the workspace, every file, recursively.
pub fn install_skill(app: &App, name: &str) -> Result<(), SkillError> {
    let src_dir = get_built_in_skills_dir(app).join(name);
    let dest_dir = get_custom_skills_dir(app).join(name);
    if !src_dir.exists() {
        return Err(SkillError::NotFound(name.to_string()));
    }
    fs::create_dir_all(&dest_dir)?;
    copy_dir(&src_dir, &dest_dir)?;
    invalidate_cache(app);
    Ok(())
}

fn copy_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    for entry in read_dir_sorted(src)? {
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            fs::create_dir_all(&dest_path)?;
            copy_dir(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

/// Uninstalls a skill: removes its folder from the workspace.
pub fn uninstall_skill(app: &App, name: &str) -> std::io::Result<()> {
    let dest_dir = get_custom_skills_dir(app).join(name);
    let removed = if dest_dir.exists() {
        fs::remove_dir_all(&dest_dir)
    } else {
        Ok(())
    };
    invalidate_cache(app);
    removed
}

/// The installed skills, briefly (for prompt injection).
pub fn get_skills_list(app: &App) -> Vec<SkillSummary> {
    scan_skills(app)
        .into_iter()
        .map(|s| SkillSummary {
            name: s.name,
            description: s.description,
            source: s.source,
        })
        .collect()
}

/// The whole SKILL.md of an installed skill, by name.
pub fn get_skill_content(app: &App, name: &str) -> Option<SkillContent> {
    let skill = scan_skills(app).into_iter().find(|s| s.name == name)?;
    let bytes = fs::read(&skill.path).ok()?;
    let ParsedSkill { frontmatter, body } = parse_frontmatter(&String::from_utf8_lossy(&bytes));
    Some(SkillContent {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        content: body,
        frontmatter,
    })
}

/// The skills section of the system prompt, or "" when no skill is installed. Kept brief to minimise token usage.
pub fn get_skills_prompt_context(app: &App) -> String {
    let skills = scan_skills(app);
    if skills.is_empty() {
        return String::new();
    }

    // Names plus a short description: the full description is in each SKILL.md, which is read before using a skill
    // anyway. At full length 68 skills took 18.5KB, which pushed the end of the list past the 50KB prompt budget (the
    // last skills were cut off) and cost about 4.6k tokens a call. A skill's folder is named in the list when it is
    // not the skill's name (a SKILL.md can name itself), so the cat below finds it.
    let lines: Vec<String> = skills
        .iter()
        .map(|s| {
            let folder = if !s.folder.is_empty() && s.folder != s.name {
                format!(" (folder `{}`)", s.folder)
            } else {
                String::new()
            };
            format!(
                "- **{}**{folder}: {}",
                s.name,
                short_skill_description(&s.description, SKILL_PROMPT_DESC_MAX)
            )
        })
        .collect();

    format!(
        "\n\n## Skills\n\
         You have these specialized skills available. Each skill has a SKILL.md file with detailed instructions, credentials, tokens, and configuration. **IMPORTANT: When a task matches a skill, ALWAYS read its SKILL.md first** — skills often contain API keys, tokens, CLI configs, and setup instructions you need.\n\
         \n\
         Read a skill with: `cat \"{}/{{folder}}/SKILL.md\" 2>/dev/null || cat \"{}/{{folder}}/SKILL.md\"` ({{folder}} is the skill's name unless the list gives its folder)\n\
         \n\
         Available skills:\n\
         {}",
        get_custom_skills_dir(app).display(),
        get_built_in_skills_dir(app).display(),
        lines.join("\n")
    )
}

/// Forgets the scanned skills (call after creating, changing or removing one).
pub fn invalidate_cache(app: &App) {
    if let Some(cache) = app.get::<SkillsCache>() {
        *cache.scanned.lock() = None;
    }
}

/// How long a skill's description may be in the system prompt's list.
pub const SKILL_PROMPT_DESC_MAX: usize = 140;

/// The first sentence of a skill description, at most `max` characters (UTF-16 units, as the JS counted).
pub fn short_skill_description(desc: &str, max: usize) -> String {
    let collapsed = js_collapse_spaces(desc, " ");
    let flat = js_trim(&collapsed);
    // /^(.+?[.!?])(\s|$)/: the first sentence end after at least one character, followed by a space or the end.
    // (No line ends are left in `flat`, so `.` is any character.)
    let mut first = flat;
    let chars: Vec<(usize, char)> = flat.char_indices().collect();
    for (k, &(i, c)) in chars.iter().enumerate() {
        if k == 0 || !matches!(c, '.' | '!' | '?') {
            continue;
        }
        let next = chars.get(k + 1).map(|&(_, n)| n);
        if next.is_none() || next == Some(' ') {
            let sentence = &flat[..i + c.len_utf8()];
            if utf16_len(sentence) >= 25 {
                first = sentence;
            }
            break;
        }
    }
    if utf16_len(first) <= max {
        return first.to_string();
    }
    let units: Vec<u16> = first.encode_utf16().collect();
    let cut = &units[..max];
    let space = cut.iter().rposition(|&u| u == u16::from(b' '));
    let kept = match space {
        Some(sp) if sp as f64 > max as f64 * 0.6 => &cut[..sp],
        _ => cut,
    };
    // A cut through an emoji leaves half of it in JavaScript, which becomes U+FFFD when sent as UTF-8: the same here.
    let mut text = String::from_utf16_lossy(kept);
    if text.ends_with([',', ';', ':']) {
        text.pop();
    }
    text.push('…');
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{TestApp, test_app};
    use serde_json::json;

    fn skill(t: &TestApp, folder: &str, text: &str) {
        let dir = get_custom_skills_dir(t).join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), text).unwrap();
    }

    /// The two skills test/prompt-audit.test.js installs.
    fn prompt_audit_app() -> TestApp {
        let t = test_app();
        skill(
            &t,
            "canvas-db",
            "---\nname: canvas-db\ndescription: Every canvas has its own SQLite database. It survives redeploys.\n---\nbody\n",
        );
        skill(
            &t,
            "gmail-helper",
            "---\nname: Gmail Helper\ndescription: Read and send Gmail with the stored app password.\n---\nbody\n",
        );
        t
    }

    // --- test/prompt-audit.test.js: the skills list ---

    #[test]
    fn names_the_skill_folders_where_they_are_each_with_a_short_description() {
        let t = prompt_audit_app();
        let s = get_skills_prompt_context(&t);
        assert!(
            s.contains(&format!(
                "cat \"{}/{{folder}}/SKILL.md\"",
                get_custom_skills_dir(&t).display()
            )) && s.contains(&format!(
                "cat \"{}/{{folder}}/SKILL.md\"",
                get_built_in_skills_dir(&t).display()
            ))
        );
        assert!(s.contains("- **canvas-db**: Every canvas has its own SQLite database."));
        assert!(!s.contains("It survives redeploys."), "the first sentence only");
    }

    #[test]
    fn a_skill_that_names_itself_differently_from_its_folder_shows_the_folder() {
        let t = prompt_audit_app();
        assert!(get_skills_prompt_context(&t).contains(
            "- **Gmail Helper** (folder `gmail-helper`): Read and send Gmail with the stored app password."
        ));
    }

    // --- the rest of the module ---

    #[test]
    fn the_whole_prompt_section_reads_as_the_js_wrote_it() {
        let t = test_app();
        assert_eq!(get_skills_prompt_context(&t), "", "no skill installed, no section");
        invalidate_cache(&t);
        skill(&t, "one", "---\nname: one\ndescription: Does one thing well, every single time.\n---\n");
        let custom = get_custom_skills_dir(&t).display().to_string();
        let built = get_built_in_skills_dir(&t).display().to_string();
        assert_eq!(
            get_skills_prompt_context(&t),
            format!(
                "\n\n## Skills\nYou have these specialized skills available. Each skill has a SKILL.md file with detailed instructions, credentials, tokens, and configuration. **IMPORTANT: When a task matches a skill, ALWAYS read its SKILL.md first** — skills often contain API keys, tokens, CLI configs, and setup instructions you need.\n\nRead a skill with: `cat \"{custom}/{{folder}}/SKILL.md\" 2>/dev/null || cat \"{built}/{{folder}}/SKILL.md\"` ({{folder}} is the skill's name unless the list gives its folder)\n\nAvailable skills:\n- **one**: Does one thing well, every single time."
            )
        );
    }

    #[test]
    fn frontmatter_is_read_line_by_line_with_quotes_taken_off() {
        let parsed = parse_frontmatter("---\r\nname: \"quoted\"\r\ndescription: 'It: works'\r\nno colon\r\n: empty key\r\nname2:x\r\n---\r\nThe body\nhere");
        assert_eq!(
            Value::Object(parsed.frontmatter),
            json!({"name": "quoted", "description": "It: works", "name2": "x"})
        );
        assert_eq!(parsed.body, "The body\nhere");
        let empty_body = parse_frontmatter("---\nname: a\n---");
        assert_eq!(empty_body.frontmatter["name"], "a");
        assert_eq!(empty_body.body, "");
    }

    #[test]
    fn without_frontmatter_the_first_heading_names_the_skill() {
        let parsed = parse_frontmatter("Intro\n# My  Great\tSkill \r\nText");
        assert_eq!(
            Value::Object(parsed.frontmatter),
            json!({"name": "my-great-skill", "description": ""})
        );
        assert_eq!(parsed.body, "Intro\n# My  Great\tSkill \r\nText");
        assert_eq!(
            parse_frontmatter("no heading")
                .frontmatter
                .get("name")
                .cloned(),
            Some(json!("unnamed"))
        );
    }

    #[test]
    fn skills_are_scanned_in_name_order_and_cached() {
        let t = test_app();
        skill(&t, "b-skill", "---\nname: \ndescription: B\n---\n");
        skill(&t, "a-skill", "# Alpha\n");
        fs::create_dir_all(get_custom_skills_dir(&t).join("no-skill-md")).unwrap();
        fs::write(get_custom_skills_dir(&t).join("loose.md"), "x").unwrap();
        let found = scan_skills(&t);
        assert_eq!(
            found
                .iter()
                .map(|s| (s.name.as_str(), s.folder.as_str(), s.description.as_str()))
                .collect::<Vec<_>>(),
            [("alpha", "a-skill", ""), ("b-skill", "b-skill", "B")]
        );
        assert_eq!(found[0].source, "installed");
        assert_eq!(found[0].path, get_custom_skills_dir(&t).join("a-skill").join("SKILL.md"));
        skill(&t, "c-skill", "# C\n");
        assert_eq!(scan_skills(&t).len(), 2, "cached");
        invalidate_cache(&t);
        assert_eq!(scan_skills(&t).len(), 3);
        assert_eq!(
            serde_json::to_value(get_skills_list(&t)).unwrap()[0],
            json!({"name": "alpha", "description": "", "source": "installed"})
        );
    }

    #[test]
    fn a_shipped_skill_installs_and_uninstalls() {
        let t = test_app();
        let all = get_all_skills_with_status(&t);
        let diagram = all.iter().find(|s| s.name == "diagram").expect("the diagram skill ships");
        assert!(!diagram.installed);
        assert_eq!(diagram.source, "built-in");
        install_skill(&t, "diagram").unwrap();
        assert!(get_custom_skills_dir(&t).join("diagram").join("SKILL.md").is_file());
        assert!(get_all_skills_with_status(&t).iter().any(|s| s.name == "diagram" && s.installed));
        let content = get_skill_content(&t, "diagram").unwrap();
        assert_eq!(content.source, "installed");
        assert_eq!(content.frontmatter["name"], "diagram");
        assert!(!content.content.starts_with("---"));
        uninstall_skill(&t, "diagram").unwrap();
        assert!(!get_custom_skills_dir(&t).join("diagram").exists());
        assert!(get_skill_content(&t, "diagram").is_none());
        uninstall_skill(&t, "diagram").unwrap();
        assert_eq!(
            install_skill(&t, "no-such-skill").unwrap_err().to_string(),
            "Skill \"no-such-skill\" not found"
        );
    }

    #[test]
    fn a_short_description_is_the_first_sentence_within_the_limit() {
        // The cases of test/token-diet.test.js (package G3), here too.
        assert_eq!(
            short_skill_description(
                "Render videos from HTML pages. Use for launch films and reels.",
                SKILL_PROMPT_DESC_MAX
            ),
            "Render videos from HTML pages."
        );
        let long = short_skill_description(
            &format!(
                "Admin access to the whole estate: {}",
                "container apps, databases, ".repeat(20)
            ),
            SKILL_PROMPT_DESC_MAX,
        );
        assert!(utf16_len(&long) <= SKILL_PROMPT_DESC_MAX + 1 && long.ends_with('…'), "{long}");
        // Checked against Node.
        assert_eq!(
            long,
            "Admin access to the whole estate: container apps, databases, container apps, databases, container apps, databases, container apps…"
        );
        assert_eq!(short_skill_description("", SKILL_PROMPT_DESC_MAX), "");
        // A first sentence under 25 characters is not enough: the whole text stays.
        assert_eq!(
            short_skill_description("Short one. Then a longer sentence.", 140),
            "Short one. Then a longer sentence."
        );
        assert_eq!(short_skill_description("  Many\n\n  spaces.  ", 140), "Many spaces.");
        assert_eq!(short_skill_description("abcdefghij, klmnop", 12), "abcdefghij…");
        assert_eq!(short_skill_description("abcdefghijklmnop", 12), "abcdefghijkl…");
        assert_eq!(short_skill_description("e.g. this is not the end of it", 140), "e.g. this is not the end of it");
    }
}

//! Port of `src/lib/chat-target.js`: which chat an outbound message or file goes to, when the agent names a channel
//! but not a chat.
//!
//! Every channel keeps a setting per chat, channel_conv.<key> = <conversation id>, where the key is:
//!   telegram:<chat id>                  telegram:<chat id>:topic:<topic id>   (a forum topic)
//!   discord:<channel id>                discord:<parent id>:thread:<thread id>
//!   whatsapp:<chat id>
//!   slack:<channel id>:thread:<thread ts>   (every Slack conversation is a thread; slack:<channel id> for none)
//!
//! Order of choice:
//!   1. the chat id the agent gave
//!   2. the chat this turn is in (its conversation is the value of one of those settings), so a file asked for on
//!      Telegram goes back to that same Telegram chat
//!   3. the chat of that channel with the latest message; a chat whose setting was cleared (null) is skipped
//!
//! The old rule took the first setting in key order, which is whichever chat id sorts lowest: often a group nobody
//! uses any more.

use serde_json::Value;

use crate::db::Db;
use crate::db::settings::Settings;

/// A chat a channel key points at: the chat (or channel) id, and the forum topic or thread inside it, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatTarget {
    pub chat_id: String,
    pub thread_id: Option<String>,
}

/// How [`resolve_chat_target`] chose the chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetHow {
    /// The chat id the agent gave.
    Given,
    /// The chat this turn is in.
    ThisChat,
    /// The chat of the channel with the latest message.
    Latest,
}

impl TargetHow {
    /// The Node value: "given", "this chat" or "latest".
    pub fn as_str(self) -> &'static str {
        match self {
            TargetHow::Given => "given",
            TargetHow::ThisChat => "this chat",
            TargetHow::Latest => "latest",
        }
    }
}

/// The chat to send to, and how it was chosen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedChatTarget {
    pub chat_id: String,
    pub thread_id: Option<String>,
    pub how: TargetHow,
}

impl ResolvedChatTarget {
    /// The chat without how it was chosen.
    pub fn target(&self) -> ChatTarget {
        ChatTarget {
            chat_id: self.chat_id.clone(),
            thread_id: self.thread_id.clone(),
        }
    }
}

/// The chat a channel key points at, or `None` when it is not one of `channel`'s. The key may carry its
/// `channel_conv.` prefix.
pub fn chat_target_of(channel: &str, channel_key: &str) -> Option<ChatTarget> {
    let key = channel_key.strip_prefix("channel_conv.").unwrap_or(channel_key);
    let parts: Vec<&str> = key.split(':').collect();
    let part = |i: usize| parts.get(i).copied().filter(|p| !p.is_empty());
    if parts[0] != channel {
        return None;
    }
    let first = part(1)?;
    let target = match channel {
        "telegram" => ChatTarget {
            chat_id: first.to_string(),
            thread_id: if part(2) == Some("topic") {
                part(3).map(str::to_string)
            } else {
                None
            },
        },
        // A Discord thread is a channel of its own: messages go to the thread's id.
        "discord" => ChatTarget {
            chat_id: if part(2) == Some("thread") {
                part(3).unwrap_or(first)
            } else {
                first
            }
            .to_string(),
            thread_id: None,
        },
        // A Slack thread is not a channel of its own: messages go to the channel, in the thread named by its ts.
        "slack" => ChatTarget {
            chat_id: first.to_string(),
            thread_id: if part(2) == Some("thread") {
                part(3).map(str::to_string)
            } else {
                None
            },
        },
        _ => ChatTarget {
            chat_id: parts[1..].join(":"),
            thread_id: None,
        },
    };
    Some(target)
}

/// A chat of the channel and the conversation it belongs to.
struct Chat {
    target: ChatTarget,
    conversation_id: String,
}

fn chats_of(channel: &str, settings: &dyn Settings) -> Vec<Chat> {
    let mut out = Vec::new();
    for (key, value) in settings.get_by_prefix(&format!("channel_conv.{channel}:")) {
        // a chat whose conversation was cleared
        let Value::String(conversation_id) = value else {
            continue;
        };
        if conversation_id.is_empty() {
            continue;
        }
        if let Some(target) = chat_target_of(channel, &key) {
            out.push(Chat {
                target,
                conversation_id,
            });
        }
    }
    out
}

/// What [`resolve_chat_target`] chooses from.
#[derive(Clone, Copy, Default)]
pub struct ResolveChatTarget<'a> {
    /// The channel ("telegram", "discord", "slack", "whatsapp", ...).
    pub channel: &'a str,
    /// The chat id the agent gave ("" for none).
    pub channel_id: &'a str,
    /// The conversation this turn is in.
    pub conversation_id: Option<&'a str>,
    pub settings: Option<&'a dyn Settings>,
    /// For the time of each chat's latest message.
    pub db: Option<&'a Db>,
}

/// The time of the conversation's latest message ("" when it has none or there is no messages table).
fn latest_message_at(db: Option<&Db>, conversation_id: &str) -> String {
    let Some(db) = db.filter(|db| db.is_open()) else {
        return String::new();
    };
    db.with(|conn| {
        conn.query_row(
            "SELECT MAX(created_at) AS at FROM messages WHERE conversation_id = ?",
            [conversation_id],
            |row| row.get::<_, Option<String>>(0),
        )
    })
    // no messages table: any chat will do
    .ok()
    .flatten()
    .unwrap_or_default()
}

/// The chat to send to, or `None` when the channel has never had a chat.
pub fn resolve_chat_target(args: ResolveChatTarget<'_>) -> Option<ResolvedChatTarget> {
    let conversation_id = args.conversation_id.filter(|c| !c.is_empty());
    if !args.channel_id.is_empty() {
        let given = crate::util::js::trim(args.channel_id).to_string();
        // The current chat's own id given back: keep its forum topic.
        let here = match (args.settings, conversation_id) {
            (Some(settings), Some(conv)) => chats_of(args.channel, settings)
                .into_iter()
                .find(|c| c.conversation_id == conv && c.target.chat_id == given),
            _ => None,
        };
        return Some(ResolvedChatTarget {
            chat_id: given,
            thread_id: here.and_then(|c| c.target.thread_id),
            how: TargetHow::Given,
        });
    }
    let settings = args.settings?;
    let chats = chats_of(args.channel, settings);
    if chats.is_empty() {
        return None;
    }
    if let Some(conv) = conversation_id
        && let Some(here) = chats.iter().find(|c| c.conversation_id == conv)
    {
        return Some(ResolvedChatTarget {
            chat_id: here.target.chat_id.clone(),
            thread_id: here.target.thread_id.clone(),
            how: TargetHow::ThisChat,
        });
    }
    let mut best: Option<&Chat> = None;
    let mut best_at = String::new();
    for c in &chats {
        let at = latest_message_at(args.db, &c.conversation_id);
        if best.is_none() || at > best_at {
            best = Some(c);
            best_at = at;
        }
    }
    // On Slack every chat is a thread: a message from elsewhere goes to the latest one's channel, not into that thread.
    best.map(|b| ResolvedChatTarget {
        chat_id: b.target.chat_id.clone(),
        thread_id: if args.channel == "slack" {
            None
        } else {
            b.target.thread_id.clone()
        },
        how: TargetHow::Latest,
    })
}

/// The conversation of the chat a message or file went to, or `None` when that chat has none.
pub fn conversation_of_chat(channel: &str, target: &ChatTarget, settings: Option<&dyn Settings>) -> Option<String> {
    let settings = settings?;
    if target.chat_id.is_empty() {
        return None;
    }
    // Exactly that chat: a group's own chat is not one of its forum topics.
    let want_thread = target.thread_id.as_deref().filter(|t| !t.is_empty());
    chats_of(channel, settings)
        .into_iter()
        .find(|c| c.target.chat_id == target.chat_id && c.target.thread_id.as_deref() == want_thread)
        .map(|c| c.conversation_id)
}

#[cfg(test)]
mod tests {
    //! No Node test file covers this module; the expected values were printed by the Node code
    //! (`src/lib/chat-target.js`) for the same settings and messages.
    use serde_json::json;

    use super::*;
    use crate::testkit::{MemorySettings, test_app};

    fn target(chat: &str, thread: Option<&str>) -> Option<ChatTarget> {
        Some(ChatTarget {
            chat_id: chat.into(),
            thread_id: thread.map(str::to_string),
        })
    }

    fn resolved(chat: &str, thread: Option<&str>, how: TargetHow) -> Option<ResolvedChatTarget> {
        Some(ResolvedChatTarget {
            chat_id: chat.into(),
            thread_id: thread.map(str::to_string),
            how,
        })
    }

    #[test]
    fn a_channel_key_names_its_chat_and_thread() {
        assert_eq!(
            chat_target_of("telegram", "channel_conv.telegram:-100:topic:7"),
            target("-100", Some("7"))
        );
        assert_eq!(chat_target_of("telegram", "telegram:-100:topic:"), target("-100", None));
        assert_eq!(
            chat_target_of("telegram", "telegram:-100:thread:7"),
            target("-100", None)
        );
        assert_eq!(chat_target_of("discord", "discord:1:thread:2"), target("2", None));
        assert_eq!(chat_target_of("discord", "discord:1:thread"), target("1", None));
        assert_eq!(
            chat_target_of("slack", "slack:C1:thread:171.5"),
            target("C1", Some("171.5"))
        );
        assert_eq!(chat_target_of("slack", "slack:C1"), target("C1", None));
        assert_eq!(
            chat_target_of("whatsapp", "whatsapp:123@c.us:x:y"),
            target("123@c.us:x:y", None)
        );
        assert_eq!(chat_target_of("whatsapp", "whatsapp:a::"), target("a::", None));
        assert_eq!(chat_target_of("slack", "telegram:1"), None);
        assert_eq!(chat_target_of("slack", "slack:"), None);
        assert_eq!(chat_target_of("slack", "slack"), None);
        assert_eq!(chat_target_of("slack", ""), None);
        assert_eq!(chat_target_of("", ""), None);
        assert_eq!(chat_target_of("x", "channel_conv.channel_conv.x:1"), None);
    }

    fn settings() -> MemorySettings {
        MemorySettings::from_pairs([
            ("channel_conv.telegram:100", json!("conv-a")),
            ("channel_conv.telegram:200:topic:5", json!("conv-b")),
            ("channel_conv.telegram:300", Value::Null),
            ("channel_conv.telegram:400", json!("")),
            ("channel_conv.telegram:500", json!(42)),
            ("channel_conv.slack:C1:thread:1.1", json!("conv-s1")),
            ("channel_conv.slack:C2:thread:2.2", json!("conv-s2")),
            ("channel_conv.discord:9:thread:10", json!("conv-d")),
        ])
    }

    #[test]
    fn a_given_chat_id_wins_and_keeps_this_chats_topic() {
        let s = settings();
        let args = |channel_id, conv| ResolveChatTarget {
            channel: "telegram",
            channel_id,
            conversation_id: conv,
            settings: Some(&s),
            db: None,
        };
        assert_eq!(
            resolve_chat_target(args(" 200 ", Some("conv-b"))),
            resolved("200", Some("5"), TargetHow::Given)
        );
        assert_eq!(
            resolve_chat_target(args("200", Some("conv-a"))),
            resolved("200", None, TargetHow::Given)
        );
        assert_eq!(
            resolve_chat_target(args("777", None)),
            resolved("777", None, TargetHow::Given)
        );
        assert_eq!(
            resolve_chat_target(args("   ", None)),
            resolved("", None, TargetHow::Given)
        );
        assert_eq!(
            resolve_chat_target(ResolveChatTarget {
                channel: "telegram",
                channel_id: "5",
                ..Default::default()
            }),
            resolved("5", None, TargetHow::Given)
        );
    }

    #[test]
    fn this_chat_then_the_latest_chat_then_none() {
        let s = settings();
        let t = test_app();
        t.db()
            .with(|c| {
                c.execute_batch(
                    "INSERT INTO conversations (id) VALUES ('conv-a'), ('conv-b'), ('conv-s1'), ('conv-s2');
                     INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES
                       ('m1', 'conv-a', 'user', 'x', '2026-11-01 10:00:00'),
                       ('m2', 'conv-b', 'user', 'x', '2026-11-02 10:00:00'),
                       ('m3', 'conv-s1', 'user', 'x', '2026-11-03 10:00:00'),
                       ('m4', 'conv-s2', 'user', 'x', '2026-11-01 09:00:00');",
                )
            })
            .unwrap();
        let args = |channel, conv, db| ResolveChatTarget {
            channel,
            channel_id: "",
            conversation_id: conv,
            settings: Some(&s),
            db,
        };
        assert_eq!(
            resolve_chat_target(args("telegram", Some("conv-a"), Some(t.db()))),
            resolved("100", None, TargetHow::ThisChat)
        );
        assert_eq!(
            resolve_chat_target(args("telegram", Some("other"), Some(t.db()))),
            resolved("200", Some("5"), TargetHow::Latest)
        );
        // On Slack the latest chat's channel, not its thread.
        assert_eq!(
            resolve_chat_target(args("slack", None, Some(t.db()))),
            resolved("C1", None, TargetHow::Latest)
        );
        // No database: the first chat in key order.
        assert_eq!(
            resolve_chat_target(args("telegram", None, None)),
            resolved("100", None, TargetHow::Latest)
        );
        assert_eq!(
            resolve_chat_target(args("discord", None, None)),
            resolved("10", None, TargetHow::Latest)
        );
        assert_eq!(resolve_chat_target(args("whatsapp", None, Some(t.db()))), None);
        assert_eq!(
            resolve_chat_target(ResolveChatTarget {
                channel: "telegram",
                ..Default::default()
            }),
            None
        );
    }

    #[test]
    fn the_conversation_of_exactly_that_chat() {
        let s = settings();
        let of = |channel, chat: &str, thread: Option<&str>| {
            conversation_of_chat(channel, &target(chat, thread).unwrap(), Some(&s))
        };
        assert_eq!(of("telegram", "200", Some("5")).as_deref(), Some("conv-b"));
        assert_eq!(of("telegram", "200", None), None);
        assert_eq!(of("telegram", "200", Some("")), None);
        assert_eq!(of("telegram", "100", Some("")).as_deref(), Some("conv-a"));
        assert_eq!(of("telegram", "300", None), None);
        assert_eq!(of("slack", "C2", Some("2.2")).as_deref(), Some("conv-s2"));
        assert_eq!(of("discord", "10", None).as_deref(), Some("conv-d"));
        assert_eq!(of("telegram", "", None), None);
        assert_eq!(
            conversation_of_chat("telegram", &target("100", None).unwrap(), None),
            None
        );
    }

    #[test]
    fn how_reads_as_the_node_words() {
        assert_eq!(TargetHow::Given.as_str(), "given");
        assert_eq!(TargetHow::ThisChat.as_str(), "this chat");
        assert_eq!(TargetHow::Latest.as_str(), "latest");
    }
}

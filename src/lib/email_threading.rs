//! Port of `src/lib/email-threading.js`: email threading helpers — reply headers + subject dedup + References-chain
//! management.
//!
//! Used when Tarsee replies to an inbound email or starts a new thread via the tarsee_send_email_thread MCP tool.
//! Pure functions; no I/O.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::lib::discord_format::js_text::re;
use crate::util::js::trim;

/// Cap to keep outbound headers reasonable.
const MAX_REFERENCES: usize = 10;

/// The outbound reply headers [`build_reply_headers`] makes, both `None` when there was nothing to reply to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplyHeaders {
    /// In-Reply-To: the Message-ID being replied to, exactly as given.
    pub in_reply_to: Option<String>,
    /// References: space-separated `<msg-id>`s.
    pub references: Option<String>,
}

/// Build outbound reply headers for a reply to an inbound email.
///
///   In-Reply-To: <incomingMessageId>
///   References:  <existingRefs...> <incomingMessageId>  (dedup, cap MAX_REFERENCES)
///
/// `incoming_message_id` is the Message-ID of what we're replying to; `references` the existing References chain
/// from the inbound email. The values are formatted for the mail's In-Reply-To and References headers (both take
/// space-separated `<msg-id>` strings).
pub fn build_reply_headers(incoming_message_id: Option<&str>, references: &[String]) -> ReplyHeaders {
    let Some(incoming) = incoming_message_id.filter(|id| !id.is_empty()) else {
        return ReplyHeaders::default();
    };
    let mut chain: Vec<&str> = references.iter().map(String::as_str).collect();
    // Append the incoming message ID if not already present.
    if !chain.contains(&incoming) {
        chain.push(incoming);
    }
    // Dedup while preserving order.
    let mut deduped: Vec<&str> = Vec::new();
    let mut seen = HashSet::new();
    for r in chain {
        let trimmed = trim(r);
        if trimmed.is_empty() || !seen.insert(trimmed) {
            continue;
        }
        deduped.push(trimmed);
    }
    // Cap: keep the first entry (root) + the last (MAX_REFERENCES - 1) — this preserves thread grouping without
    // header bloat on long threads.
    let capped: Vec<&str> = if deduped.len() <= MAX_REFERENCES {
        deduped
    } else {
        let tail = &deduped[deduped.len() - (MAX_REFERENCES - 1)..];
        std::iter::once(deduped[0]).chain(tail.iter().copied()).collect()
    };
    ReplyHeaders {
        in_reply_to: Some(incoming.to_string()),
        references: Some(capped.join(" ")),
    }
}

static RE_CHAIN: LazyLock<Regex> = LazyLock::new(|| re(r"^(\s*(?i-u:re)\s*:\s*)+"));

/// Dedupe "Re: Re: Re: ..." chains on an outbound reply subject. Gmail and Apple Mail already tolerate multi-Re, but
/// we keep it clean.
///
/// Examples:
///   "Re: Re: status update"         →  "Re: status update"
///   "RE: re: Fwd: status"           →  "Re: Fwd: status"
///   "status update"                 →  "Re: status update"
///   ""                              →  "Re: (no subject)"
pub fn normalize_reply_subject(subject: &str) -> String {
    let s = trim(subject);
    if s.is_empty() {
        return "Re: (no subject)".into();
    }
    // Strip leading "Re:" / "RE:" chains (with optional whitespace between).
    let stripped = RE_CHAIN.replace(s, "");
    let stripped = trim(&stripped);
    format!("Re: {}", if stripped.is_empty() { "(no subject)" } else { stripped })
}

/// One mailbox of a parsed mail (the parser's `{ address, name }`); only the address is read here.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MailAddress {
    pub address: Option<String>,
}

impl MailAddress {
    pub fn new(address: impl Into<String>) -> Self {
        MailAddress {
            address: Some(address.into()),
        }
    }
}

/// The addresses of a parsed inbound mail, as [`resolve_recipients`] reads them. Package H3 fills it from the parsed
/// mail: `from` and `reply_to` are the first mailbox of the From and Reply-To headers, `to` and `cc` every mailbox of
/// To and Cc.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IncomingMail {
    pub from: Option<MailAddress>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    /// Reply-To header if present.
    pub reply_to: Option<MailAddress>,
}

/// Who an outbound reply goes to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Recipients {
    pub to: Vec<String>,
    pub cc: Vec<String>,
}

/// The address in lower case without surrounding whitespace (`a?.address?.toLowerCase().trim()`), or `None`.
fn normalized(mailbox: Option<&MailAddress>) -> Option<String> {
    let address = mailbox?.address.as_deref()?;
    Some(trim(&address.to_lowercase()).to_string())
}

/// Resolve who to send an outbound reply to based on policy + incoming headers. Default is reply-to-sender-only.
/// Reply-all only when explicitly opted in AND we're actually part of the original conversation (sender + anyone in
/// To/Cc except us). `self_address` is Tarsee's own inbox address — always excluded.
pub fn resolve_recipients(incoming: &IncomingMail, reply_all: bool, self_address: &str) -> Recipients {
    let me = trim(&self_address.to_lowercase()).to_string();
    let from_addr = normalized(incoming.from.as_ref());
    // Honor Reply-To header if it's a single address. Multi-address Reply-To is discarded (rare, malformed). Reply-To
    // always takes precedence over From for the primary recipient when present.
    let primary_reply_to = normalized(incoming.reply_to.as_ref());
    let Some(primary) = primary_reply_to
        .filter(|a| !a.is_empty())
        .or(from_addr)
        .filter(|a| !a.is_empty())
    else {
        return Recipients::default();
    };

    if !reply_all {
        return Recipients {
            to: vec![primary],
            cc: Vec::new(),
        };
    }

    // Reply-all: primary + everyone in To + Cc who isn't us or the primary.
    let mut cc: Vec<String> = Vec::new();
    for address in incoming
        .to
        .iter()
        .chain(&incoming.cc)
        .filter_map(|a| normalized(Some(a)))
    {
        // Dedup the cc list.
        if !address.is_empty() && address != me && address != primary && !cc.contains(&address) {
            cc.push(address);
        }
    }
    Recipients { to: vec![primary], cc }
}

#[cfg(test)]
mod tests {
    //! Port of the `src/lib/email-threading.js` half of `test/email-parser.test.js`, then cases whose expected values
    //! were printed by the Node code for the same input (generated, not typed).
    use super::*;

    fn refs(list: &[&str]) -> Vec<String> {
        list.iter().map(|r| r.to_string()).collect()
    }

    fn boxes(list: &[&str]) -> Vec<MailAddress> {
        list.iter().map(|a| MailAddress::new(*a)).collect()
    }

    // buildReplyHeaders

    #[test]
    fn build_reply_headers_appends_current_message_id_to_references() {
        let r = build_reply_headers(
            Some("<msg3@example.com>"),
            &refs(&["<root@example.com>", "<msg2@example.com>"]),
        );
        assert_eq!(r.in_reply_to.as_deref(), Some("<msg3@example.com>"));
        assert_eq!(
            r.references.as_deref(),
            Some("<root@example.com> <msg2@example.com> <msg3@example.com>")
        );
    }

    #[test]
    fn build_reply_headers_de_dupes_if_already_in_chain() {
        let r = build_reply_headers(
            Some("<msg2@example.com>"),
            &refs(&["<root@example.com>", "<msg2@example.com>"]),
        );
        assert_eq!(r.references.as_deref(), Some("<root@example.com> <msg2@example.com>"));
    }

    #[test]
    fn build_reply_headers_caps_long_chains_at_max_references_keeping_root_and_tail() {
        let chain: Vec<String> = (0..20).map(|i| format!("<m{i}@x.com>")).collect();
        let r = build_reply_headers(Some("<new@x.com>"), &chain);
        let joined = r.references.unwrap();
        let parts: Vec<&str> = joined.split(' ').collect();
        assert_eq!(parts.len(), 10, "should cap at 10");
        assert_eq!(parts[0], "<m0@x.com>", "root preserved");
        assert_eq!(parts[parts.len() - 1], "<new@x.com>", "latest is the incoming id");
    }

    #[test]
    fn build_reply_headers_no_incoming_message_id_returns_undefineds() {
        let r = build_reply_headers(None, &refs(&["<x@y>"]));
        assert_eq!(r.in_reply_to, None);
        assert_eq!(r.references, None);
    }

    // normalizeReplySubject

    #[test]
    fn normalize_reply_subject_dedupes_re_chains() {
        assert_eq!(normalize_reply_subject("Re: Re: Re: status"), "Re: status");
        assert_eq!(normalize_reply_subject("RE: re: RE: Fwd: status"), "Re: Fwd: status");
        assert_eq!(normalize_reply_subject("status"), "Re: status");
        assert_eq!(normalize_reply_subject(""), "Re: (no subject)");
        assert_eq!(normalize_reply_subject("   "), "Re: (no subject)");
    }

    // resolveRecipients

    #[test]
    fn resolve_recipients_default_reply_to_sender_only() {
        let incoming = IncomingMail {
            from: Some(MailAddress::new("alice@example.com")),
            to: boxes(&["tarsee@example.com"]),
            cc: boxes(&["bob@example.com"]),
            ..Default::default()
        };
        let r = resolve_recipients(&incoming, false, "tarsee@example.com");
        assert_eq!(
            r,
            Recipients {
                to: vec!["alice@example.com".into()],
                cc: vec![]
            }
        );
    }

    #[test]
    fn resolve_recipients_reply_all_includes_to_and_cc_excludes_self_and_primary() {
        let incoming = IncomingMail {
            from: Some(MailAddress::new("alice@example.com")),
            to: boxes(&["tarsee@example.com", "carol@example.com"]),
            cc: boxes(&["bob@example.com", "alice@example.com"]),
            ..Default::default()
        };
        let r = resolve_recipients(&incoming, true, "tarsee@example.com");
        assert_eq!(r.to, vec!["alice@example.com"]);
        // carol and bob should be CC'd; alice (primary) excluded from cc; tarsee (self) excluded.
        let mut cc = r.cc.clone();
        cc.sort();
        assert_eq!(cc, vec!["bob@example.com", "carol@example.com"]);
    }

    #[test]
    fn resolve_recipients_reply_to_header_takes_precedence_over_from() {
        let incoming = IncomingMail {
            from: Some(MailAddress::new("noreply@example.com")),
            reply_to: Some(MailAddress::new("alice@example.com")),
            to: boxes(&["tarsee@example.com"]),
            ..Default::default()
        };
        let r = resolve_recipients(&incoming, false, "tarsee@example.com");
        assert_eq!(
            r,
            Recipients {
                to: vec!["alice@example.com".into()],
                cc: vec![]
            }
        );
    }

    #[test]
    fn resolve_recipients_empty_headers_is_safe() {
        let r = resolve_recipients(&IncomingMail::default(), false, "tarsee@example.com");
        assert_eq!(r, Recipients::default());
    }

    // Awkward input, against what the Node code printed.

    #[test]
    fn normalize_reply_subject_matches_the_node_output() {
        for (subject, expected) in NODE_SUBJECT {
            assert_eq!(normalize_reply_subject(subject), *expected, "{subject:?}");
        }
    }

    #[test]
    fn build_reply_headers_matches_the_node_output() {
        for (id, chain, in_reply_to, references) in NODE_REPLY_HEADERS {
            let r = build_reply_headers(*id, &refs(chain));
            assert_eq!(r.in_reply_to.as_deref(), *in_reply_to, "{id:?} {chain:?}");
            assert_eq!(r.references.as_deref(), *references, "{id:?} {chain:?}");
        }
    }

    #[test]
    fn resolve_recipients_matches_the_node_output() {
        let mailbox = |m: &Mailbox| {
            m.map(|a| MailAddress {
                address: a.map(str::to_string),
            })
        };
        let list = |l: &[Option<&str>]| {
            l.iter()
                .map(|a| MailAddress {
                    address: a.map(str::to_string),
                })
                .collect::<Vec<_>>()
        };
        for (from, reply_to, to, cc, all, me, want_to, want_cc) in NODE_RECIPIENTS {
            let incoming = IncomingMail {
                from: mailbox(from),
                reply_to: mailbox(reply_to),
                to: list(to),
                cc: list(cc),
            };
            let r = resolve_recipients(&incoming, *all, me);
            assert_eq!(r.to, *want_to, "{incoming:?}");
            assert_eq!(r.cc, *want_cc, "{incoming:?}");
        }
    }

    /// Subjects and what `normalizeReplySubject` printed, in the Node code.
    const NODE_SUBJECT: &[(&str, &str)] = &[
        ("", "Re: (no subject)"),
        ("  ", "Re: (no subject)"),
        ("Re:", "Re: (no subject)"),
        ("re : re:", "Re: (no subject)"),
        ("RE:Re: x", "Re: x"),
        ("Re: Re: Fwd: Re: x", "Re: Fwd: Re: x"),
        ("Rex: y", "Re: Rex: y"),
        ("re:  ", "Re: (no subject)"),
        ("Ré: x", "Re: Ré: x"),
        ("\u{a0}re: x\u{a0}", "Re: x"),
        ("Re Re: x", "Re: Re Re: x"),
        ("Fwd: Re: x", "Re: Fwd: Re: x"),
        ("Re: x", "Re: x"),
    ];

    /// Incoming Message-ID, References, then `buildReplyHeaders`'s inReplyTo and references, in the Node code.
    type ReplyHeadersCase = (
        Option<&'static str>,
        &'static [&'static str],
        Option<&'static str>,
        Option<&'static str>,
    );
    const NODE_REPLY_HEADERS: &[ReplyHeadersCase] = &[
        (None, &["<a>"], None, None),
        (Some(""), &["<a>"], None, None),
        (Some("<m>"), &[], Some("<m>"), Some("<m>")),
        (Some(" <m> "), &["<m>", " <m> "], Some(" <m> "), Some("<m>")),
        (
            Some("<m>"),
            &["", "  ", "<r>", "<r>", " <r>"],
            Some("<m>"),
            Some("<r> <m>"),
        ),
        (
            Some("<n>"),
            &[
                "<m0>", "<m1>", "<m2>", "<m3>", "<m4>", "<m5>", "<m6>", "<m7>", "<m8>", "<m9>", "<m10>", "<m11>",
            ],
            Some("<n>"),
            Some("<m0> <m4> <m5> <m6> <m7> <m8> <m9> <m10> <m11> <n>"),
        ),
        (
            Some("<m5>"),
            &[
                "<m0>", "<m1>", "<m2>", "<m3>", "<m4>", "<m5>", "<m6>", "<m7>", "<m8>", "<m9>", "<m10>", "<m11>",
            ],
            Some("<m5>"),
            Some("<m0> <m3> <m4> <m5> <m6> <m7> <m8> <m9> <m10> <m11>"),
        ),
    ];

    /// Incoming addresses (from, reply-to, to, cc; None for a mailbox without an address), reply-all, self, and
    /// what `resolveRecipients` printed (to, cc), in the Node code.
    type Mailbox = Option<Option<&'static str>>;
    type RecipientsCase = (
        Mailbox,
        Mailbox,
        &'static [Option<&'static str>],
        &'static [Option<&'static str>],
        bool,
        &'static str,
        &'static [&'static str],
        &'static [&'static str],
    );
    const NODE_RECIPIENTS: &[RecipientsCase] = &[
        (
            Some(Some(" Alice@Example.COM ")),
            None,
            &[],
            &[],
            false,
            "me@x",
            &["alice@example.com"],
            &[],
        ),
        (
            Some(Some("")),
            Some(Some("r@x")),
            &[],
            &[],
            false,
            "me@x",
            &["r@x"],
            &[],
        ),
        (
            Some(Some("f@x")),
            Some(Some("  ")),
            &[],
            &[],
            false,
            "me@x",
            &["f@x"],
            &[],
        ),
        (Some(Some("f@x")), Some(None), &[], &[], true, "ME@X", &["f@x"], &[]),
        (
            Some(Some("f@x")),
            None,
            &[Some("Me@X"), Some("B@x"), None, Some("")],
            &[Some("b@x "), Some("F@X"), Some("c@x")],
            true,
            " me@x ",
            &["f@x"],
            &["b@x", "c@x"],
        ),
        (Some(None), None, &[], &[], true, "me@x", &[], &[]),
        (Some(Some("İ@x")), None, &[Some("i̇@x")], &[], true, "", &["i̇@x"], &[]),
    ];
}

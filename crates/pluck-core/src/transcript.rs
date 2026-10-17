//! Turning the loose lines read from a chat window into messages with
//! speakers, so the model knows who said what.
//!
//! Slack (and most chat apps) show a sender name, a time, then one or more
//! lines of text; follow-up messages from the same person repeat neither.
//! Accessibility gives Plucky those as separate lines, plus noise: date
//! dividers, reaction counts, badges. [`structure`] groups them back into
//! `Speaker: text` messages and remembers which input lines each came from.

/// One message: who sent it (when known) and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub speaker: Option<String>,
    pub text: String,
    /// Indexes of the input lines this message was built from.
    pub lines: Vec<usize>,
}

impl Message {
    /// `Speaker: text`, or just the text.
    pub fn render(&self) -> String {
        match &self.speaker {
            Some(s) => format!("{s}: {}", self.text),
            None => self.text.clone(),
        }
    }
}

/// "1:49 PM", "13:05", "Yesterday at 4:12 PM", "Today at 9:00 AM".
pub fn is_time(line: &str) -> bool {
    let l = line.trim().to_lowercase();
    let l = l
        .strip_prefix("today at ")
        .or_else(|| l.strip_prefix("yesterday at "))
        .unwrap_or(&l);
    let l = l
        .trim_end_matches(" am")
        .trim_end_matches(" pm")
        .trim_end_matches("am")
        .trim_end_matches("pm")
        .trim();
    let Some((h, m)) = l.split_once(':') else {
        return false;
    };
    let ok_h = !h.is_empty() && h.len() <= 2 && h.chars().all(|c| c.is_ascii_digit());
    let ok_m = m.len() == 2 && m.chars().all(|c| c.is_ascii_digit());
    ok_h && ok_m
}

const WEEKDAYS: &[&str] = &[
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

/// Lines that carry no message: date dividers, reaction counts, badges,
/// "(edited)" and the like.
pub fn is_noise(line: &str) -> bool {
    let l = line.trim().to_lowercase();
    if l.is_empty() || l.chars().all(|c| c.is_ascii_digit() || c.is_whitespace()) {
        return true;
    }
    if matches!(
        l.as_str(),
        "today"
            | "yesterday"
            | "(edited)"
            | "edited"
            | "new"
            | "new messages"
            | "vip"
            | "app"
            | "bot"
            | "external"
            | "reply"
            | "replies"
            | "view thread"
            | "show more"
            | "show less"
    ) {
        return true;
    }
    // "12 replies", "Last reply 3 days ago".
    if l.ends_with(" replies") || l.ends_with(" reply") || l.starts_with("last reply") {
        return true;
    }
    // "Thursday, October 15th" / "Friday" date dividers.
    WEEKDAYS
        .iter()
        .any(|d| l == *d || (l.starts_with(d) && l[d.len()..].starts_with(',') && l.len() < 32))
}

/// Could this line be a person's name shown above their message?
fn looks_like_name(line: &str) -> bool {
    let l = line.trim();
    let words = l.split_whitespace().count();
    (1..=5).contains(&words)
        && l.chars().count() <= 40
        && l.chars()
            .next()
            .is_some_and(|c| c.is_alphabetic() && !c.is_lowercase())
        && !l.contains(['.', '?', '!', ':', '—', '(', ')', '@', '/'])
        && !is_noise(l)
        && !is_time(l)
}

/// Group lines into messages. A name followed (within two lines, skipping
/// badges) by a time starts a new speaker; their text follows until the
/// next speaker. Text before any speaker has `speaker: None`.
pub fn structure(lines: &[String]) -> Vec<Message> {
    let mut out: Vec<Message> = Vec::new();
    let mut speaker: Option<String> = None;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();
        if looks_like_name(line) {
            // Find the time within the next two lines (a badge may sit between).
            let time_at = (i + 1..lines.len().min(i + 3)).find(|&j| is_time(&lines[j]));
            let only_noise_between = time_at.is_some_and(|t| {
                (i + 1..t).all(|j| is_noise(&lines[j]) || lines[j].trim().chars().count() <= 8)
            });
            if let (Some(t), true) = (time_at, only_noise_between) {
                speaker = Some(line.to_string());
                // A new block always starts a new message.
                out.push(Message {
                    speaker: speaker.clone(),
                    text: String::new(),
                    lines: vec![i],
                });
                i = t + 1;
                continue;
            }
        }
        if is_time(line) || is_noise(line) {
            i += 1;
            continue;
        }
        match out.last_mut() {
            Some(m) if m.speaker == speaker => {
                if !m.text.is_empty() {
                    m.text.push('\n');
                }
                m.text.push_str(line);
                m.lines.push(i);
            }
            _ => out.push(Message {
                speaker: speaker.clone(),
                text: line.to_string(),
                lines: vec![i],
            }),
        }
        i += 1;
    }
    out.retain(|m| !m.text.is_empty());
    out
}

/// The user's names as typed in a setting. Separated by commas — or, when a
/// name itself has a comma ("Rivera, Sam"), by semicolons.
pub fn split_names(raw: &str) -> Vec<String> {
    let parts: Vec<&str> = if raw.contains(';') || raw.contains('\n') {
        raw.split([';', '\n']).collect()
    } else {
        raw.split(',').collect()
    };
    parts
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty() && p.chars().count() <= 80)
        .take(6)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn times_and_noise() {
        assert!(is_time("1:49 PM"));
        assert!(is_time("13:05"));
        assert!(is_time("Yesterday at 4:12 PM"));
        assert!(!is_time("Ratio 1:4 is fine"));
        assert!(is_noise("Thursday, October 15th"));
        assert!(is_noise("Today"));
        assert!(is_noise("1"));
        assert!(is_noise("12 replies"));
        assert!(!is_noise("Thursday works for me"));
    }

    #[test]
    fn groups_a_slack_conversation() {
        let input = lines(&[
            "Thursday, October 15th",
            "Maya Chen",
            "VIP",
            "1:49 PM",
            "Hi Sam — as you start on the agent upgrade, we need a way to benchmark accuracy.",
            "Please also loop in Lena Ortiz.",
            "Thanks.",
            "Sam Rivera",
            "1:53 PM",
            "Sounds good, I'll set up time with everyone early next week",
            "1",
            "1",
        ]);
        let msgs = structure(&input);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].speaker.as_deref(), Some("Maya Chen"));
        assert!(msgs[0].text.contains("loop in Lena Ortiz"));
        assert_eq!(msgs[1].speaker.as_deref(), Some("Sam Rivera"));
        assert_eq!(
            msgs[1].render(),
            "Sam Rivera: Sounds good, I'll set up time with everyone early next week"
        );
        assert!(msgs[1].lines.contains(&9));
    }

    #[test]
    fn follow_ups_stay_with_their_speaker() {
        let input = lines(&[
            "Jordan Lee",
            "9:02 AM",
            "morning!",
            "can you send the notes?",
        ]);
        let msgs = structure(&input);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].text, "morning!\ncan you send the notes?");
    }

    #[test]
    fn text_without_a_speaker() {
        let msgs = structure(&lines(&[
            "From: Finance",
            "Please submit expenses by Oct 25.",
        ]));
        assert!(msgs.iter().all(|m| m.speaker.is_none()));
    }

    #[test]
    fn names() {
        assert_eq!(split_names("Sam Rivera, Sam"), vec!["Sam Rivera", "Sam"]);
        assert_eq!(
            split_names("Rivera, Sam; srivera@example.com"),
            vec!["Rivera, Sam", "srivera@example.com"]
        );
        assert!(split_names("  ").is_empty());
    }
}

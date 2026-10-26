//! Repeating tasks.
//!
//! A repeating task is an ordinary task with a `recurrence` rule. Completing
//! it creates the next occurrence (see `Store::update`). The next due day is
//! always after *today*, so finishing an overdue daily task late doesn't
//! leave a trail of overdue copies behind it.

use chrono::{Datelike, Duration, NaiveDate, Weekday};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    Daily,
    Weekdays,
    Weekly,
    Biweekly,
    Monthly,
    Yearly,
}

impl Rule {
    pub const ALL: [Rule; 6] = [
        Rule::Daily,
        Rule::Weekdays,
        Rule::Weekly,
        Rule::Biweekly,
        Rule::Monthly,
        Rule::Yearly,
    ];

    pub fn parse(s: &str) -> Option<Rule> {
        Rule::ALL.into_iter().find(|r| r.as_str() == s)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Rule::Daily => "daily",
            Rule::Weekdays => "weekdays",
            Rule::Weekly => "weekly",
            Rule::Biweekly => "biweekly",
            Rule::Monthly => "monthly",
            Rule::Yearly => "yearly",
        }
    }

    /// One step forward from `d`.
    fn step(self, d: NaiveDate, anchor_day: u32) -> NaiveDate {
        match self {
            Rule::Daily => d + Duration::days(1),
            Rule::Weekdays => {
                let mut n = d + Duration::days(1);
                while matches!(n.weekday(), Weekday::Sat | Weekday::Sun) {
                    n += Duration::days(1);
                }
                n
            }
            Rule::Weekly => d + Duration::days(7),
            Rule::Biweekly => d + Duration::days(14),
            Rule::Monthly => add_months(d, 1, anchor_day),
            Rule::Yearly => add_months(d, 12, anchor_day),
        }
    }
}

/// `d` plus `n` months, on `anchor_day` or the month's last day if shorter
/// (Jan 31 → Feb 28 → Mar 31).
fn add_months(d: NaiveDate, n: u32, anchor_day: u32) -> NaiveDate {
    let total = d.year() * 12 + d.month0() as i32 + n as i32;
    let (y, m0) = (total.div_euclid(12), total.rem_euclid(12) as u32);
    let mut day = anchor_day;
    loop {
        if let Some(nd) = NaiveDate::from_ymd_opt(y, m0 + 1, day) {
            return nd;
        }
        day -= 1;
    }
}

/// The next due day for a repeating task due on `due` (or undated), strictly
/// after `today` and after `due`.
pub fn next_due(rule: Rule, due: Option<NaiveDate>, today: NaiveDate) -> NaiveDate {
    let start = due.unwrap_or(today);
    // Monthly/yearly keep the original day of the month where possible.
    let anchor = start.day();
    let mut d = rule.step(start, anchor);
    // Bounded: daily over decades is still only a few thousand steps.
    for _ in 0..20_000 {
        if d > today {
            break;
        }
        d = rule.step(d, anchor);
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn parses_every_rule() {
        for r in Rule::ALL {
            assert_eq!(Rule::parse(r.as_str()), Some(r));
        }
        assert_eq!(Rule::parse("hourly"), None);
    }

    #[test]
    fn steps_forward_from_the_due_day() {
        let today = d("2026-10-14"); // Wednesday
        assert_eq!(next_due(Rule::Daily, Some(today), today), d("2026-10-15"));
        assert_eq!(next_due(Rule::Weekly, Some(today), today), d("2026-10-21"));
        assert_eq!(
            next_due(Rule::Biweekly, Some(today), today),
            d("2026-10-28")
        );
        assert_eq!(next_due(Rule::Monthly, Some(today), today), d("2026-11-14"));
        assert_eq!(next_due(Rule::Yearly, Some(today), today), d("2027-10-14"));
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        let fri = d("2026-10-16");
        assert_eq!(next_due(Rule::Weekdays, Some(fri), fri), d("2026-10-19"));
    }

    #[test]
    fn late_completion_lands_after_today() {
        // Weekly on Mondays, completed on Wednesday nine days late.
        assert_eq!(
            next_due(Rule::Weekly, Some(d("2026-10-05")), d("2026-10-14")),
            d("2026-10-19")
        );
        assert_eq!(
            next_due(Rule::Daily, Some(d("2026-01-01")), d("2026-10-14")),
            d("2026-10-15")
        );
    }

    #[test]
    fn early_completion_moves_one_step() {
        // Due next Monday, done today: next is the Monday after.
        assert_eq!(
            next_due(Rule::Weekly, Some(d("2026-10-19")), d("2026-10-14")),
            d("2026-10-26")
        );
    }

    #[test]
    fn month_end_is_clamped() {
        let jan31 = d("2027-01-31");
        assert_eq!(next_due(Rule::Monthly, Some(jan31), jan31), d("2027-02-28"));
        assert_eq!(
            next_due(Rule::Yearly, Some(d("2028-02-29")), d("2028-02-29")),
            d("2029-02-28")
        );
    }

    #[test]
    fn undated_starts_from_today() {
        let today = d("2026-10-14");
        assert_eq!(next_due(Rule::Daily, None, today), d("2026-10-15"));
    }
}

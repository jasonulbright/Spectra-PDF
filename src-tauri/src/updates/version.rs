//! Release numbers: `YYYY.MDD.N`, three decimal fields, each below 65536,
//! with no sign, no leading zero and nothing after the third field.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version([u16; 3]);

impl Version {
    pub fn parse(text: &str) -> Option<Self> {
        let mut fields = [0u16; 3];
        let mut parts = text.split('.');
        for field in fields.iter_mut() {
            *field = parse_field(parts.next()?)?;
        }
        if parts.next().is_some() {
            return None;
        }
        Some(Version(fields))
    }

    /// The version this binary was built as.
    pub fn running() -> Self {
        Version::parse(env!("CARGO_PKG_VERSION"))
            .expect("the package version is a release number")
    }
}

fn parse_field(text: &str) -> Option<u16> {
    if text.is_empty() || text.len() > 5 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if text.len() > 1 && text.starts_with('0') {
        return None;
    }
    let value: u32 = text.parse().ok()?;
    u16::try_from(value).ok()
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.0[0], self.0[1], self.0[2])
    }
}

#[cfg(test)]
mod tests {
    use super::Version;

    #[test]
    fn release_numbers_parse_and_print_in_one_spelling() {
        for text in ["2026.1014.156", "2026.930.150", "2027.131.200", "0.0.0", "65535.65535.65535"] {
            assert_eq!(Version::parse(text).unwrap().to_string(), text);
        }
    }

    #[test]
    fn malformed_numbers_are_refused() {
        for text in [
            "", "2026", "2026.1014", "2026.1014.156.1", "2026.01014.156", "02026.1014.156",
            "2026.1014.0156", "v2026.1014.156", "2026.1014.156-beta", "2026.1014.156+x",
            "2026.1014.65536", "2026..156", ".1014.156", "2026.1014.", " 2026.1014.156",
            "2026.1014.156 ", "2026.10a4.156", "-1.1014.156", "+2026.1014.156",
            "2026.1014.１５６", "99999999999999999999.1.1",
        ] {
            assert!(Version::parse(text).is_none(), "{text:?} parsed");
        }
    }

    #[test]
    fn fields_compare_numerically_across_days_months_and_years() {
        let v = |t| Version::parse(t).unwrap();
        assert!(v("2026.1004.151") > v("2026.930.150"));
        assert!(v("2027.131.200") > v("2026.1231.199"));
        assert!(v("2026.1014.157") > v("2026.1014.156"));
        assert!(v("2026.1014.156") == v("2026.1014.156"));
        assert!(v("2026.999.156") < v("2026.1001.155"));
    }

    #[test]
    fn the_running_version_is_a_release_number() {
        assert_eq!(Version::running().to_string(), env!("CARGO_PKG_VERSION"));
    }
}

//! Where updates come from. Every address is built here from compiled-in
//! parts and the release number; the manifest contributes the number and
//! the signature, never an address.

use super::version::Version;
use crate::net::ReleaseOrigins;

pub const MANIFEST_URL: &str =
    "https://github.com/jasonulbright/Spectra-PDF/releases/latest/download/latest.json";

pub const RELEASE_BASE: &str = "https://github.com/jasonulbright/Spectra-PDF/releases/download";

/// The release signing key: base64 of the minisign public key file. Equal to
/// `plugins.updater.pubkey` in tauri.conf.json, which the bundler signs
/// against.
pub const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJEQzlDNjNDODZBNkY2MEMKUldRTTlxYUdQTWJKdmJ6ck1IYytzQms1RjY3QW5lYjJRck52R0Q1emxIaGNFdVlOWllOdHc4N1gK";

const RELEASE_ORIGINS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Artifact {
    Installer,
    Portable,
}

const INSTALLER_SIGNED_PREFIX: &str = "Spectra PDF_";
const INSTALLER_SIGNED_SUFFIX: &str = "_x64-setup.exe";
const PORTABLE_PREFIX: &str = "spectrapdf-";
const PORTABLE_SUFFIX: &str = "-portable.zip";

impl Artifact {
    /// The `platforms` key of latest.json whose `signature` signs this artifact.
    pub fn manifest_key(self) -> &'static str {
        match self {
            Artifact::Installer => "windows-x86_64",
            Artifact::Portable => "windows-x86_64-portable",
        }
    }

    /// The release asset name. The release host replaces the space of the
    /// bundler's installer name with a dot.
    pub fn asset_name(self, version: Version) -> String {
        match self {
            Artifact::Installer => format!("Spectra.PDF_{version}{INSTALLER_SIGNED_SUFFIX}"),
            Artifact::Portable => format!("{PORTABLE_PREFIX}{version}{PORTABLE_SUFFIX}"),
        }
    }

    /// The file name the signer recorded in the trusted comment.
    pub fn signed_name(self, version: Version) -> String {
        match self {
            Artifact::Installer => {
                format!("{INSTALLER_SIGNED_PREFIX}{version}{INSTALLER_SIGNED_SUFFIX}")
            }
            Artifact::Portable => self.asset_name(version),
        }
    }

    /// The version a signed file name names, when it is this artifact's name
    /// for exactly that version.
    pub fn version_of_signed_name(self, name: &str) -> Option<Version> {
        let (prefix, suffix) = match self {
            Artifact::Installer => (INSTALLER_SIGNED_PREFIX, INSTALLER_SIGNED_SUFFIX),
            Artifact::Portable => (PORTABLE_PREFIX, PORTABLE_SUFFIX),
        };
        let version = Version::parse(name.strip_prefix(prefix)?.strip_suffix(suffix)?)?;
        (self.signed_name(version) == name).then_some(version)
    }

    /// The largest download accepted for this artifact.
    pub fn cap(self) -> u64 {
        match self {
            Artifact::Installer => 2 * 1024 * 1024 * 1024,
            Artifact::Portable => 4 * 1024 * 1024 * 1024,
        }
    }
}

/// The resolved source: the manifest address, the asset base, the public key
/// and the origins a request may reach.
#[derive(Debug, Clone)]
pub struct Source {
    pub manifest_url: String,
    pub base: String,
    pub public_key: String,
    pub origins: ReleaseOrigins,
}

impl Source {
    pub fn asset_url(&self, artifact: Artifact, version: Version) -> String {
        format!("{}/v{version}/{}", self.base, artifact.asset_name(version))
    }
}

pub fn github_origins() -> ReleaseOrigins {
    ReleaseOrigins {
        origins: RELEASE_ORIGINS
            .iter()
            .map(|host| ("https".to_string(), host.to_string()))
            .collect(),
        allow_private: false,
    }
}

#[cfg(not(feature = "update-test-source"))]
pub fn source() -> Result<Source, String> {
    Ok(Source {
        manifest_url: MANIFEST_URL.to_string(),
        base: RELEASE_BASE.to_string(),
        public_key: PUBLIC_KEY.to_string(),
        origins: github_origins(),
    })
}

/// The local update test: `SPECTRA_UPDATE_TEST_BASE` serves `latest.json` and
/// `v<version>/<asset>`; `SPECTRA_UPDATE_TEST_PUBKEY` is the test key in the
/// same encoding as [`PUBLIC_KEY`]. The SYSTEM apply task reads them from the
/// machine environment.
#[cfg(feature = "update-test-source")]
pub fn source() -> Result<Source, String> {
    let base = std::env::var("SPECTRA_UPDATE_TEST_BASE")
        .map_err(|_| "SPECTRA_UPDATE_TEST_BASE is not set".to_string())?;
    let base = base.trim_end_matches('/').to_string();
    let public_key = std::env::var("SPECTRA_UPDATE_TEST_PUBKEY")
        .map_err(|_| "SPECTRA_UPDATE_TEST_PUBKEY is not set".to_string())?;
    let (_, scheme, authority) = crate::net::validate_http_url(&base)?;
    Ok(Source {
        manifest_url: format!("{base}/latest.json"),
        base,
        public_key,
        origins: ReleaseOrigins {
            origins: vec![(scheme, authority)],
            allow_private: true,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn asset_addresses_are_built_from_the_compiled_in_base() {
        let source = Source {
            manifest_url: MANIFEST_URL.to_string(),
            base: RELEASE_BASE.to_string(),
            public_key: PUBLIC_KEY.to_string(),
            origins: github_origins(),
        };
        assert_eq!(
            source.asset_url(Artifact::Installer, v("2026.1014.156")),
            "https://github.com/jasonulbright/Spectra-PDF/releases/download/v2026.1014.156/Spectra.PDF_2026.1014.156_x64-setup.exe"
        );
        assert_eq!(
            source.asset_url(Artifact::Portable, v("2026.1101.160")),
            "https://github.com/jasonulbright/Spectra-PDF/releases/download/v2026.1101.160/spectrapdf-2026.1101.160-portable.zip"
        );
    }

    #[test]
    fn signed_names_match_what_the_signer_records() {
        assert_eq!(
            Artifact::Installer.signed_name(v("2026.1014.156")),
            "Spectra PDF_2026.1014.156_x64-setup.exe"
        );
        assert_eq!(
            Artifact::Portable.signed_name(v("2026.1014.156")),
            "spectrapdf-2026.1014.156-portable.zip"
        );
    }

    #[test]
    fn a_signed_name_gives_back_its_version_only_in_the_exact_spelling() {
        assert_eq!(
            Artifact::Installer.version_of_signed_name("Spectra PDF_2026.1014.156_x64-setup.exe"),
            Some(v("2026.1014.156"))
        );
        assert_eq!(
            Artifact::Portable.version_of_signed_name("spectrapdf-2026.1014.156-portable.zip"),
            Some(v("2026.1014.156"))
        );
        for name in [
            "Spectra.PDF_2026.1014.156_x64-setup.exe",
            "Spectra PDF_2026.01014.156_x64-setup.exe",
            "Spectra PDF_2026.1014.156_x64-setup.exe.sig",
            "Spectra PDF_2026.1014.156_arm64-setup.exe",
            "spectrapdf-2026.1014.156-portable.zip",
        ] {
            assert_eq!(Artifact::Installer.version_of_signed_name(name), None, "{name}");
        }
        assert_eq!(
            Artifact::Portable.version_of_signed_name("Spectra PDF_2026.1014.156_x64-setup.exe"),
            None
        );
    }

    #[test]
    fn the_compiled_in_key_is_the_key_the_bundler_signs_against() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(config["plugins"]["updater"]["pubkey"].as_str(), Some(PUBLIC_KEY));
    }

    #[test]
    fn release_requests_reach_only_the_release_host_and_its_asset_hosts() {
        let origins = github_origins();
        assert!(!origins.allow_private);
        let hosts: Vec<&str> = origins.origins.iter().map(|(_, h)| h.as_str()).collect();
        assert_eq!(hosts, RELEASE_ORIGINS);
        assert!(origins.origins.iter().all(|(scheme, _)| scheme == "https"));
    }
}

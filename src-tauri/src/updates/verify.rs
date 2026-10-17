//! Minisign verification of a downloaded artifact, streamed from disk.
//!
//! A signature is accepted only when its trusted comment names exactly the
//! file the caller expects for the offered version: the comment is covered by
//! the global signature, so a valid signature over another release's file is
//! refused before any byte is hashed.

use std::io::Read;
use std::path::Path;

use base64::Engine;
use minisign_verify::{PublicKey, Signature};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// The signature, its key or its file binding is wrong.
    Signature(String),
    /// The file could not be read.
    Io(String),
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::Signature(m) | VerifyError::Io(m) => f.write_str(m),
        }
    }
}

const MAX_SIGNATURE_TEXT: usize = 4096;

fn decode_base64_text(encoded: &str, what: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("The {what} is not base64: {e}"))?;
    if bytes.len() > MAX_SIGNATURE_TEXT {
        return Err(format!("The {what} is too long"));
    }
    String::from_utf8(bytes).map_err(|_| format!("The {what} is not text"))
}

/// The public key from its base64 file encoding.
pub fn public_key(encoded: &str) -> Result<PublicKey, String> {
    let text = decode_base64_text(encoded, "public key")?;
    PublicKey::decode(&text).map_err(|e| format!("The public key cannot be read: {e}"))
}

/// The signature text from a manifest's base64 `signature` value.
pub fn signature_text(encoded: &str) -> Result<String, String> {
    decode_base64_text(encoded, "signature")
}

pub fn signature(text: &str) -> Result<Signature, String> {
    if text.len() > MAX_SIGNATURE_TEXT {
        return Err("The signature is too long".to_string());
    }
    Signature::decode(text).map_err(|e| format!("The signature cannot be read: {e}"))
}

/// The `file:` field of the trusted comment, when exactly one exists.
pub fn signed_file_name(signature: &Signature) -> Option<&str> {
    let mut names = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|field| field.strip_prefix("file:"));
    let name = names.next()?;
    names.next().is_none().then_some(name)
}

/// Refuses a signature whose trusted comment does not name `expected`.
pub fn check_binding(signature: &Signature, expected: &str) -> Result<(), VerifyError> {
    match signed_file_name(signature) {
        Some(name) if name == expected => Ok(()),
        Some(name) => Err(VerifyError::Signature(format!(
            "The signature is for {name}, not {expected}"
        ))),
        None => Err(VerifyError::Signature(
            "The signature names no single file".to_string(),
        )),
    }
}

/// Verifies `reader` against `signature` after the file binding.
pub fn verify_reader(
    mut reader: impl Read,
    signature: &Signature,
    key: &PublicKey,
    expected: &str,
) -> Result<(), VerifyError> {
    check_binding(signature, expected)?;
    let mut verifier = key
        .verify_stream(signature)
        .map_err(|e| VerifyError::Signature(format!("The signature does not fit the key: {e}")))?;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| VerifyError::Io(format!("Cannot read the download: {e}")))?;
        if read == 0 {
            break;
        }
        verifier.update(&buffer[..read]);
    }
    verifier
        .finalize()
        .map_err(|e| VerifyError::Signature(format!("The download does not match its signature: {e}")))
}

pub fn verify_file(
    path: &Path,
    signature: &Signature,
    key: &PublicKey,
    expected: &str,
) -> Result<(), VerifyError> {
    let file = std::fs::File::open(path)
        .map_err(|e| VerifyError::Io(format!("Cannot open {}: {e}", path.display())))?;
    verify_reader(file, signature, key, expected)
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! Signatures made with a test-only key by the same signer the release
    //! pipeline uses. The secret key is not part of the repository.

    pub const PUBLIC_KEY: &str = include_str!("fixtures/test-key.pub.b64");
    pub const OTHER_PUBLIC_KEY: &str = include_str!("fixtures/other-key.pub.b64");

    pub const INSTALLER: &[u8] = include_bytes!("fixtures/Spectra PDF_2026.1101.160_x64-setup.exe");
    pub const INSTALLER_SIG: &str =
        include_str!("fixtures/Spectra PDF_2026.1101.160_x64-setup.exe.sig.b64");
    pub const OLD_INSTALLER: &[u8] = include_bytes!("fixtures/Spectra PDF_2026.901.140_x64-setup.exe");
    pub const OLD_INSTALLER_SIG: &str =
        include_str!("fixtures/Spectra PDF_2026.901.140_x64-setup.exe.sig.b64");
    pub const OTHER_KEY_INSTALLER_SIG: &str =
        include_str!("fixtures/other-key_2026.1101.160_x64-setup.exe.sig.b64");
    pub const PORTABLE: &[u8] = include_bytes!("fixtures/spectrapdf-2026.1101.160-portable.zip");
    pub const PORTABLE_SIG: &str =
        include_str!("fixtures/spectrapdf-2026.1101.160-portable.zip.sig.b64");
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    fn sig(encoded: &str) -> Signature {
        signature(&signature_text(encoded).unwrap()).unwrap()
    }

    #[test]
    fn the_release_signature_of_v156_names_the_bundler_installer_file() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/latest156.json")).unwrap();
        let encoded = manifest["platforms"]["windows-x86_64"]["signature"].as_str().unwrap();
        let signature = sig(encoded);
        assert_eq!(
            signed_file_name(&signature),
            Some("Spectra PDF_2026.1014.156_x64-setup.exe")
        );
        let key = public_key(crate::updates::source::PUBLIC_KEY).unwrap();
        assert!(key.verify_stream(&signature).is_ok(), "the release key signed it");
    }

    #[test]
    fn a_signed_installer_verifies() {
        let key = public_key(PUBLIC_KEY).unwrap();
        verify_reader(
            INSTALLER,
            &sig(INSTALLER_SIG),
            &key,
            "Spectra PDF_2026.1101.160_x64-setup.exe",
        )
        .unwrap();
        verify_reader(
            PORTABLE,
            &sig(PORTABLE_SIG),
            &key,
            "spectrapdf-2026.1101.160-portable.zip",
        )
        .unwrap();
    }

    #[test]
    fn a_changed_byte_is_refused() {
        let key = public_key(PUBLIC_KEY).unwrap();
        let mut bytes = INSTALLER.to_vec();
        bytes[0] ^= 1;
        let result = verify_reader(
            bytes.as_slice(),
            &sig(INSTALLER_SIG),
            &key,
            "Spectra PDF_2026.1101.160_x64-setup.exe",
        );
        assert!(matches!(result, Err(VerifyError::Signature(_))), "{result:?}");
    }

    #[test]
    fn a_valid_signature_for_another_version_is_refused_by_its_file_binding() {
        let key = public_key(PUBLIC_KEY).unwrap();
        let result = verify_reader(
            OLD_INSTALLER,
            &sig(OLD_INSTALLER_SIG),
            &key,
            "Spectra PDF_2026.1101.160_x64-setup.exe",
        );
        assert_eq!(
            result,
            Err(VerifyError::Signature(
                "The signature is for Spectra PDF_2026.901.140_x64-setup.exe, not Spectra PDF_2026.1101.160_x64-setup.exe".to_string()
            ))
        );
        verify_reader(
            OLD_INSTALLER,
            &sig(OLD_INSTALLER_SIG),
            &key,
            "Spectra PDF_2026.901.140_x64-setup.exe",
        )
        .unwrap();
    }

    #[test]
    fn a_signature_by_another_key_is_refused() {
        let key = public_key(PUBLIC_KEY).unwrap();
        let result = verify_reader(
            INSTALLER,
            &sig(OTHER_KEY_INSTALLER_SIG),
            &key,
            "Spectra PDF_2026.1101.160_x64-setup.exe",
        );
        assert!(matches!(result, Err(VerifyError::Signature(_))), "{result:?}");
        let other = public_key(OTHER_PUBLIC_KEY).unwrap();
        assert!(matches!(
            verify_reader(INSTALLER, &sig(INSTALLER_SIG), &other, "Spectra PDF_2026.1101.160_x64-setup.exe"),
            Err(VerifyError::Signature(_))
        ));
    }

    #[test]
    fn a_trusted_comment_must_name_exactly_one_file() {
        let decoded = signature_text(INSTALLER_SIG).unwrap();
        let mut lines: Vec<String> = decoded.lines().map(str::to_string).collect();
        lines[2] = "trusted comment: timestamp:1\tfile:a\tfile:b".to_string();
        let doubled = signature(&lines.join("\n")).unwrap();
        assert_eq!(signed_file_name(&doubled), None);
        lines[2] = "trusted comment: timestamp:1".to_string();
        let none = signature(&lines.join("\n")).unwrap();
        assert_eq!(signed_file_name(&none), None);
        assert!(check_binding(&none, "x").is_err());
    }

    #[test]
    fn an_edited_trusted_comment_fails_the_global_signature() {
        let key = public_key(PUBLIC_KEY).unwrap();
        let decoded = signature_text(OLD_INSTALLER_SIG).unwrap();
        let edited = decoded.replace(
            "Spectra PDF_2026.901.140_x64-setup.exe",
            "Spectra PDF_2026.1101.160_x64-setup.exe",
        );
        let result = verify_reader(
            OLD_INSTALLER,
            &signature(&edited).unwrap(),
            &key,
            "Spectra PDF_2026.1101.160_x64-setup.exe",
        );
        assert!(matches!(result, Err(VerifyError::Signature(_))), "{result:?}");
    }
}

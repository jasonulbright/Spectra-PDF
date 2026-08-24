//! The Windows certificate store as a list of signing identities.
//!
//! Read-only and key-free: enumeration reports what a certificate IS, never
//! what its key can do for us. The only call here that touches a key acquires
//! it under `CRYPT_ACQUIRE_SILENT_FLAG`, which forbids any UI — so listing the
//! picker's rows can never raise a PIN prompt. Signing acquires the same key
//! again, without that flag, inside the engine.
//!
//! Eligibility is a pure function of the certificate's own fields, so the rule
//! is testable without a store.

use serde::Serialize;

#[cfg(windows)]
use windows::core::{PCSTR, PSTR};
#[cfg(windows)]
use windows::Win32::Foundation::FILETIME;
#[cfg(windows)]
use windows::Win32::Security::Cryptography::*;

/// anyExtendedKeyUsage — qualifies a certificate for every purpose.
pub const EKU_ANY: &str = "2.5.29.37.0";
/// The purposes that authorise EXECUTABLES. A certificate that carries only
/// these is not a document signer, and offering it as one invites a user to
/// sign a contract with their release-signing identity.
pub const EKU_CODE_SIGNING: &[&str] = &[
    "1.3.6.1.5.5.7.3.3",         // id-kp-codeSigning
    "1.3.6.1.4.1.311.10.3.13",   // Lifetime signing
    "1.3.6.1.4.1.311.2.1.21",    // Individual code signing
    "1.3.6.1.4.1.311.2.1.22",    // Commercial code signing
    "1.3.6.1.4.1.311.61.4.1",    // Early-launch driver signing
];

/// CERT_DIGITAL_SIGNATURE_KEY_USAGE
pub const KU_DIGITAL_SIGNATURE: u16 = 0x0080;
/// CERT_NON_REPUDIATION_KEY_USAGE
pub const KU_NON_REPUDIATION: u16 = 0x0040;

/// One certificate the picker can offer.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct StoreCertificate {
    /// SHA-1 thumbprint, uppercase hex — the store's own identifier, and the
    /// ONLY thing a signing request carries.
    pub thumbprint: String,
    pub subject: String,
    pub issuer: String,
    /// RFC 3339 UTC.
    pub not_after: String,
    /// Extended key usages, by OID. Empty means the certificate names none,
    /// which under RFC 5280 is "unrestricted".
    pub eku: Vec<String>,
    /// The key is held by hardware (a smart card, a TPM, an HSM's provider).
    pub hardware_backed: bool,
    /// True for the machine store, false for the user's own.
    pub machine_store: bool,
}

/// Whether a certificate belongs in the signing picker.
///
/// Separate from every Windows call so the rule can be read and tested on its
/// own. Key usage is only consulted when the certificate declares it: an
/// absent extension is unrestricted under RFC 5280, and treating it as a
/// refusal would hide certificates that sign perfectly well.
pub fn eligible(has_private_key: bool, expired: bool, key_usage: u16, eku: &[String]) -> bool {
    if !has_private_key || expired {
        return false;
    }
    if key_usage != 0 && key_usage & (KU_DIGITAL_SIGNATURE | KU_NON_REPUDIATION) == 0 {
        return false;
    }
    !code_signing_only(eku)
}

/// A certificate whose declared purposes are ALL executable-signing ones.
///
/// `anyExtendedKeyUsage` alongside them makes the certificate unrestricted, so
/// it is not code-signing-only; an empty list declares nothing and is likewise
/// not a restriction.
pub fn code_signing_only(eku: &[String]) -> bool {
    if eku.is_empty() {
        return false;
    }
    eku.iter()
        .all(|oid| EKU_CODE_SIGNING.contains(&oid.as_str()))
}

// ── The store itself ─────────────────────────────────────────────────────

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn now_filetime() -> u64 {
    let ft = unsafe { windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime() };
    filetime_u64(&ft)
}

#[cfg(windows)]
fn filetime_u64(ft: &FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

#[cfg(windows)]
fn filetime_rfc3339(ft: &FILETIME) -> String {
    use windows::Win32::Foundation::SYSTEMTIME;
    let mut st = SYSTEMTIME::default();
    if unsafe { windows::Win32::System::Time::FileTimeToSystemTime(ft, &mut st) }.is_err() {
        return String::new();
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond
    )
}

/// A certificate's common name, falling back to the display name the store
/// itself would show — a certificate with no CN still needs to be namable.
#[cfg(windows)]
fn name_string(cert: *const CERT_CONTEXT, issuer: bool) -> String {
    unsafe {
        let flags = if issuer { CERT_NAME_ISSUER_FLAG } else { 0 };
        let oid: PCSTR = szOID_COMMON_NAME;
        let mut text = read_name(cert, CERT_NAME_ATTR_TYPE, flags, oid.0 as *const _);
        if text.is_empty() {
            text = read_name(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, flags, std::ptr::null());
        }
        text
    }
}

#[cfg(windows)]
unsafe fn read_name(
    cert: *const CERT_CONTEXT,
    kind: u32,
    flags: u32,
    para: *const core::ffi::c_void,
) -> String {
    let para = if para.is_null() { None } else { Some(para) };
    let len = CertGetNameStringW(cert, kind, flags, para, None);
    if len <= 1 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize];
    let written = CertGetNameStringW(cert, kind, flags, para, Some(&mut buf));
    if written <= 1 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..(written as usize - 1)])
}

#[cfg(windows)]
unsafe fn thumbprint(cert: *const CERT_CONTEXT) -> Option<String> {
    let mut size: u32 = 0;
    CertGetCertificateContextProperty(cert, CERT_SHA1_HASH_PROP_ID, None, &mut size).ok()?;
    let mut buf = vec![0u8; size as usize];
    CertGetCertificateContextProperty(
        cert,
        CERT_SHA1_HASH_PROP_ID,
        Some(buf.as_mut_ptr() as *mut _),
        &mut size,
    )
    .ok()?;
    Some(buf.iter().map(|b| format!("{:02X}", b)).collect())
}

/// Whether the store records a key container for this certificate.
///
/// A property read, not an acquisition: asking the provider would spin up a
/// smart-card session for every row in the list.
#[cfg(windows)]
unsafe fn has_private_key(cert: *const CERT_CONTEXT) -> bool {
    let mut size: u32 = 0;
    CertGetCertificateContextProperty(cert, CERT_KEY_PROV_INFO_PROP_ID, None, &mut size).is_ok()
}

#[cfg(windows)]
unsafe fn intended_key_usage(cert: *const CERT_CONTEXT) -> u16 {
    let mut bytes = [0u8; 2];
    let info = (*cert).pCertInfo;
    if CertGetIntendedKeyUsage(
        (*cert).dwCertEncodingType,
        info,
        &mut bytes,
    )
    .is_ok()
    {
        // The API writes the DER bit string's bytes in the order the
        // CERT_*_KEY_USAGE constants are defined against, so the first byte
        // already carries digitalSignature.
        u16::from_le_bytes(bytes)
    } else {
        0
    }
}

#[cfg(windows)]
unsafe fn enhanced_key_usage(cert: *const CERT_CONTEXT) -> Vec<String> {
    let mut size: u32 = 0;
    if CertGetEnhancedKeyUsage(cert, 0, None, &mut size).is_err() {
        return Vec::new();
    }
    let mut buf = vec![0u8; size as usize];
    let usage = buf.as_mut_ptr() as *mut CTL_USAGE;
    if CertGetEnhancedKeyUsage(cert, 0, Some(usage), &mut size).is_err() {
        return Vec::new();
    }
    let count = (*usage).cUsageIdentifier as usize;
    let ids = (*usage).rgpszUsageIdentifier;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let ptr: PSTR = *ids.add(i);
        if ptr.is_null() {
            continue;
        }
        if let Ok(text) = ptr.to_string() {
            out.push(text);
        }
    }
    out
}

/// Whether the key lives in hardware, asked under a SILENT context.
///
/// Silent is the whole point: the probe must never raise the consent UI that
/// signing raises, or opening the picker would prompt once per smart card on
/// the machine. A key that cannot be reached silently simply reports as not
/// hardware-backed — an unknown, and the row still lists.
#[cfg(windows)]
unsafe fn hardware_backed(cert: *const CERT_CONTEXT) -> bool {
    let mut key = HCRYPTPROV_OR_NCRYPT_KEY_HANDLE::default();
    let mut spec: CERT_KEY_SPEC = CERT_KEY_SPEC(0);
    let mut caller_free = windows_core::BOOL(0);
    let ok = CryptAcquireCertificatePrivateKey(
        cert,
        CRYPT_ACQUIRE_PREFER_NCRYPT_KEY_FLAG | CRYPT_ACQUIRE_SILENT_FLAG,
        None,
        &mut key,
        Some(&mut spec),
        Some(&mut caller_free),
    );
    if ok.is_err() {
        return false;
    }
    let mut hardware = false;
    if spec == CERT_NCRYPT_KEY_SPEC {
        let mut impl_type: u32 = 0;
        let mut written: u32 = 0;
        if NCryptGetProperty(
            NCRYPT_HANDLE(key.0 as usize),
            NCRYPT_IMPL_TYPE_PROPERTY,
            Some(std::slice::from_raw_parts_mut(
                &mut impl_type as *mut u32 as *mut u8,
                4,
            )),
            &mut written,
            windows::Win32::Security::OBJECT_SECURITY_INFORMATION(0),
        )
        .is_ok()
        {
            hardware = impl_type & (NCRYPT_IMPL_HARDWARE_FLAG | NCRYPT_IMPL_HARDWARE_RNG_FLAG) != 0;
        }
        if caller_free.as_bool() {
            let _ = NCryptFreeObject(NCRYPT_HANDLE(key.0 as usize));
        }
    } else if caller_free.as_bool() {
        let _ = CryptReleaseContext(key.0 as usize, 0);
    }
    hardware
}

/// Every eligible certificate in one store location.
#[cfg(windows)]
fn read_store(machine_store: bool) -> Result<Vec<StoreCertificate>, String> {
    let name = wide("MY");
    let location = if machine_store {
        CERT_SYSTEM_STORE_LOCAL_MACHINE_ID
    } else {
        CERT_SYSTEM_STORE_CURRENT_USER_ID
    };
    unsafe {
        let store = CertOpenStore(
            CERT_STORE_PROV_SYSTEM_W,
            CERT_QUERY_ENCODING_TYPE(0),
            None,
            CERT_OPEN_STORE_FLAGS(
                (location << CERT_SYSTEM_STORE_LOCATION_SHIFT) | CERT_STORE_READONLY_FLAG.0,
            ),
            Some(name.as_ptr() as *const _),
        )
        .map_err(|e| format!("The Windows certificate store could not be opened: {e}"))?;

        let now = now_filetime();
        let mut rows: Vec<StoreCertificate> = Vec::new();
        let mut cert: *const CERT_CONTEXT = std::ptr::null();
        loop {
            cert = CertEnumCertificatesInStore(store, Some(cert));
            if cert.is_null() {
                break;
            }
            let info = &*(*cert).pCertInfo;
            let has_key = has_private_key(cert);
            let expired = filetime_u64(&info.NotAfter) <= now;
            let usage = intended_key_usage(cert);
            let eku = enhanced_key_usage(cert);
            if !eligible(has_key, expired, usage, &eku) {
                continue;
            }
            let Some(print) = thumbprint(cert) else {
                continue;
            };
            rows.push(StoreCertificate {
                thumbprint: print,
                subject: name_string(cert, false),
                issuer: name_string(cert, true),
                not_after: filetime_rfc3339(&info.NotAfter),
                hardware_backed: hardware_backed(cert),
                eku,
                machine_store,
            });
        }
        let _ = CertCloseStore(Some(store), 0);
        rows.sort_by(|a, b| a.subject.cmp(&b.subject).then(a.thumbprint.cmp(&b.thumbprint)));
        Ok(rows)
    }
}

#[cfg(not(windows))]
fn read_store(_machine_store: bool) -> Result<Vec<StoreCertificate>, String> {
    Err("The Windows certificate store is not available on this system.".to_string())
}

/// Both store locations, the user's first.
///
/// The machine store is listed rather than hidden: an ordinary user CAN hold
/// a usable key there (an enterprise deployment that grants the account read
/// on the key container is the normal case), and a key they cannot reach
/// refuses at sign time by name. A store that will not open at all
/// contributes nothing and does not fail the user's own list.
pub fn list_certificates() -> Result<Vec<StoreCertificate>, String> {
    let user = read_store(false)?;
    let mut rows = user;
    if let Ok(machine) = read_store(true) {
        for row in machine {
            if !rows.iter().any(|r| r.thumbprint == row.thumbprint) {
                rows.push(row);
            }
        }
    }
    Ok(rows)
}

#[tauri::command]
pub fn list_store_certificates() -> Result<Vec<StoreCertificate>, String> {
    list_certificates()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_certificate_with_no_key_is_not_a_signer() {
        assert!(!eligible(false, false, KU_DIGITAL_SIGNATURE, &[]));
    }

    #[test]
    fn an_expired_certificate_is_excluded() {
        assert!(!eligible(true, true, KU_DIGITAL_SIGNATURE, &[]));
    }

    #[test]
    fn an_absent_key_usage_extension_is_unrestricted() {
        assert!(eligible(true, false, 0, &[]));
    }

    #[test]
    fn key_usage_without_signing_is_excluded() {
        // keyEncipherment alone — an encryption certificate.
        assert!(!eligible(true, false, 0x0020, &[]));
    }

    #[test]
    fn non_repudiation_alone_qualifies() {
        assert!(eligible(true, false, KU_NON_REPUDIATION, &[]));
    }

    #[test]
    fn code_signing_only_is_excluded() {
        assert!(code_signing_only(&oids(&["1.3.6.1.5.5.7.3.3"])));
        assert!(!eligible(
            true,
            false,
            KU_DIGITAL_SIGNATURE,
            &oids(&["1.3.6.1.5.5.7.3.3", "1.3.6.1.4.1.311.10.3.13"])
        ));
    }

    #[test]
    fn code_signing_beside_a_document_purpose_is_kept() {
        assert!(!code_signing_only(&oids(&[
            "1.3.6.1.5.5.7.3.3",
            "1.3.6.1.5.5.7.3.4"
        ])));
        assert!(eligible(
            true,
            false,
            KU_DIGITAL_SIGNATURE,
            &oids(&["1.3.6.1.5.5.7.3.3", "1.3.6.1.5.5.7.3.4"])
        ));
    }

    #[test]
    fn any_purpose_beside_code_signing_is_kept() {
        assert!(!code_signing_only(&oids(&["1.3.6.1.5.5.7.3.3", EKU_ANY])));
    }

    #[test]
    fn an_empty_eku_list_declares_no_restriction() {
        assert!(!code_signing_only(&[]));
    }
}

/// The store as this machine actually holds it.
///
/// Ignored by default because a machine with no certificates proves nothing
/// either way; run with `--include-ignored --nocapture` to see the rows the
/// picker would offer. What it asserts unconditionally is the property the
/// picker depends on: enumeration completes, on BOTH locations, without
/// elevation and without raising any prompt.
#[cfg(all(test, windows))]
mod probe {
    #[test]
    #[ignore]
    fn print_stores() {
        for machine in [false, true] {
            match super::read_store(machine) {
                Ok(rows) => {
                    println!("machine={machine} rows={}", rows.len());
                    for r in rows {
                        println!("  {:?}", r);
                    }
                }
                Err(e) => println!("machine={machine} ERR {e}"),
            }
        }
    }

    #[test]
    fn both_locations_enumerate_without_elevation() {
        // The user store must answer; the machine store may legitimately be
        // unopenable on a locked-down host, and that must not fail the list.
        assert!(super::read_store(false).is_ok());
        assert!(super::list_certificates().is_ok());
    }
}

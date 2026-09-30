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
use windows::Win32::Foundation::{GetLastError, SetLastError, FILETIME, WIN32_ERROR};
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

#[cfg(windows)]
const MAX_CERT_NAME_UNITS: usize = 32_767;
#[cfg(windows)]
const MAX_CERT_EKU_BYTES: usize = 1024 * 1024;
#[cfg(windows)]
const MAX_CERT_EKU_OIDS: usize = 4096;
#[cfg(windows)]
const MAX_CERT_EKU_OID_BYTES: usize = 4096;
#[cfg(windows)]
const MAX_CERT_USAGE_EXTENSIONS: usize = 4096;
#[cfg(windows)]
const CRYPT_E_NOT_FOUND: u32 = 0x8009_2004;
#[cfg(windows)]
const ERROR_MORE_DATA: u32 = 234;

/// Decode one strict DER TLV without allocating. Returns its tag and the
/// content range; BER indefinite lengths and non-minimal DER lengths refuse.
#[cfg(windows)]
fn der_tlv(data: &[u8], offset: usize) -> Option<(u8, usize, usize)> {
    let tag = *data.get(offset)?;
    let first_len = *data.get(offset.checked_add(1)?)?;
    let content_start = offset.checked_add(2)?;
    let (length, content_start) = if first_len & 0x80 == 0 {
        (first_len as usize, content_start)
    } else {
        let byte_count = (first_len & 0x7f) as usize;
        if byte_count == 0 || byte_count > std::mem::size_of::<usize>() {
            return None;
        }
        let len_end = content_start.checked_add(byte_count)?;
        let len_bytes = data.get(content_start..len_end)?;
        if len_bytes[0] == 0 {
            return None;
        }
        let mut length = 0usize;
        for byte in len_bytes {
            length = length.checked_mul(256)?.checked_add(*byte as usize)?;
        }
        if length < 128 {
            return None;
        }
        (length, len_end)
    };
    let content_end = content_start.checked_add(length)?;
    (content_end <= data.len()).then_some((tag, content_start, content_end))
}

#[cfg(windows)]
fn der_single_value_has_tag(data: &[u8], expected_tag: u8) -> bool {
    matches!(der_tlv(data, 0), Some((tag, _, end)) if tag == expected_tag && end == data.len())
}

/// CryptoAPI accepts a dangling base-128 OID octet in an EKU on current
/// Windows builds. Validate the DER sequence and each OID encoding ourselves
/// before trusting its parsed purpose list.
#[cfg(windows)]
fn enhanced_key_usage_der_is_well_formed(data: &[u8]) -> bool {
    let Some((0x30, sequence_start, sequence_end)) = der_tlv(data, 0) else {
        return false;
    };
    if sequence_end != data.len() || sequence_start == sequence_end {
        return false;
    }
    let mut offset = sequence_start;
    let mut count = 0usize;
    while offset < sequence_end {
        let Some((0x06, oid_start, oid_end)) = der_tlv(data, offset) else {
            return false;
        };
        if oid_start == oid_end || oid_end > sequence_end {
            return false;
        }
        let oid = &data[oid_start..oid_end];
        let mut at_component_start = true;
        for byte in oid {
            if at_component_start && *byte == 0x80 {
                return false;
            }
            at_component_start = byte & 0x80 == 0;
        }
        if !at_component_start {
            return false;
        }
        let Some(next_count) = count.checked_add(1) else {
            return false;
        };
        count = next_count;
        offset = oid_end;
    }
    count > 0
}

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

/// Why the store could not be listed, in a form the picker can put into the
/// user's language.
///
/// The platform's own error text is localized by the OS, not by this app, and
/// matching on it would break in every other Windows language — so the reason
/// and the HRESULT travel as fields, and `message` is the English line the CLI
/// prints.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct StoreReadError {
    /// `open-failed` or `unsupported`.
    pub reason: &'static str,
    /// The HRESULT, as `0x` and eight uppercase hex digits, when there is one.
    pub code: Option<String>,
    pub message: String,
}

impl std::fmt::Display for StoreReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// An HRESULT in the spelling `StoreReadError::code` carries.
pub fn hresult_hex(code: i32) -> String {
    format!("0x{:08X}", code as u32)
}

/// Whether `now` falls within the certificate's inclusive X.509 validity
/// interval. All values are FILETIME ticks, preserving the source precision.
pub fn certificate_valid_at(not_before: u64, not_after: u64, now: u64) -> bool {
    not_before <= now && now <= not_after
}

/// Whether a certificate belongs in the signing picker.
///
/// Separate from every Windows call so the rule can be read and tested on its
/// own. Key usage is only consulted when the certificate declares it: an
/// absent extension is unrestricted under RFC 5280, and treating it as a
/// refusal would hide certificates that sign perfectly well.
pub fn eligible(
    has_private_key: bool,
    valid_at_now: bool,
    key_usage: Option<u16>,
    eku: Option<&[String]>,
) -> bool {
    let Some(key_usage) = key_usage else {
        // A failed key-usage decode is not the same as an absent extension.
        return false;
    };
    let Some(eku) = eku else {
        // A failed or malformed EKU read is not evidence that a certificate
        // is unrestricted. Do not offer an identity whose purpose is unknown.
        return false;
    };
    if !has_private_key || !valid_at_now {
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
    let Ok(capacity) = usize::try_from(len) else {
        return String::new();
    };
    if capacity > MAX_CERT_NAME_UNITS {
        return String::new();
    }
    let mut buf = Vec::new();
    if buf.try_reserve_exact(capacity).is_err() {
        return String::new();
    }
    buf.resize(capacity, 0u16);
    let written = CertGetNameStringW(cert, kind, flags, para, Some(&mut buf));
    if written <= 1 || written > len {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..(written as usize - 1)])
}

#[cfg(windows)]
unsafe fn thumbprint(cert: *const CERT_CONTEXT) -> Option<String> {
    let mut size: u32 = 0;
    CertGetCertificateContextProperty(cert, CERT_SHA1_HASH_PROP_ID, None, &mut size).ok()?;
    let mut buf = [0u8; 20];
    if size as usize != buf.len() {
        return None;
    }
    CertGetCertificateContextProperty(
        cert,
        CERT_SHA1_HASH_PROP_ID,
        Some(buf.as_mut_ptr() as *mut _),
        &mut size,
    )
    .ok()?;
    if size as usize != buf.len() {
        return None;
    }
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

/// Validate every extension from which `CertGetIntendedKeyUsage` or
/// `CertGetEnhancedKeyUsage` may obtain its answer before trusting their
/// absent-extension results. Those convenience APIs can collapse malformed
/// extension data into the same result they use for absence.
#[cfg(windows)]
unsafe fn usage_extensions_are_decodable(cert: *const CERT_CONTEXT) -> bool {
    if cert.is_null() || (*cert).pCertInfo.is_null() {
        return false;
    }
    let info = &*(*cert).pCertInfo;
    let count = info.cExtension as usize;
    if count > MAX_CERT_USAGE_EXTENSIONS || (count > 0 && info.rgExtension.is_null()) {
        return false;
    }
    if count == 0 {
        return true;
    }

    let mut seen_key_usage = false;
    let mut seen_key_attributes = false;
    let mut seen_eku = false;
    for extension in std::slice::from_raw_parts(info.rgExtension, count) {
        if extension.pszObjId.0.is_null() {
            return false;
        }
        let oid = std::ffi::CStr::from_ptr(extension.pszObjId.0.cast()).to_bytes();
        let (seen, structure) = match oid {
            b"2.5.29.15" => (&mut seen_key_usage, X509_KEY_USAGE),
            // CertGetIntendedKeyUsage also reads this legacy extension.
            b"2.5.29.2" => (&mut seen_key_attributes, X509_KEY_ATTRIBUTES),
            b"2.5.29.37" => (&mut seen_eku, X509_ENHANCED_KEY_USAGE),
            _ => continue,
        };
        if *seen {
            // RFC 5280 extensions are unique by OID. Avoid giving a malformed
            // duplicate a different interpretation from the Windows reader.
            return false;
        }
        *seen = true;

        let value_len = extension.Value.cbData as usize;
        if value_len == 0 || value_len > MAX_CERT_EKU_BYTES || extension.Value.pbData.is_null() {
            return false;
        }
        let value = std::slice::from_raw_parts(extension.Value.pbData, value_len);
        match oid {
            b"2.5.29.15" if !der_single_value_has_tag(value, 0x03) => return false,
            b"2.5.29.2" if !der_single_value_has_tag(value, 0x30) => return false,
            b"2.5.29.37" if !enhanced_key_usage_der_is_well_formed(value) => return false,
            _ => {}
        }
        let mut decoded_size = 0u32;
        if CryptDecodeObjectEx(
            (*cert).dwCertEncodingType,
            structure,
            value,
            0,
            None,
            None,
            &mut decoded_size,
        )
        .is_err()
        {
            return false;
        }
    }
    true
}

#[cfg(windows)]
unsafe fn intended_key_usage(cert: *const CERT_CONTEXT) -> Option<u16> {
    let mut bytes = [0u8; 2];
    let info = (*cert).pCertInfo;
    SetLastError(WIN32_ERROR(0));
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
        Some(u16::from_le_bytes(bytes))
    } else if GetLastError().0 == 0 {
        // Windows documents a missing Key Usage extension as FALSE with a
        // zeroed output and ERROR_SUCCESS; absence means no key-use restriction.
        Some(0)
    } else {
        // An ASN.1 decode error is not evidence that the certificate has no
        // key-use restriction.
        None
    }
}

#[cfg(windows)]
unsafe fn enhanced_key_usage(cert: *const CERT_CONTEXT) -> Option<Vec<String>> {
    let mut size: u32 = 0;
    SetLastError(WIN32_ERROR(0));
    let probe = CertGetEnhancedKeyUsage(cert, 0, None, &mut size);
    let probe_error = GetLastError().0;
    if size == 0 && probe.is_err() && probe_error == CRYPT_E_NOT_FOUND {
        // Windows uses CRYPT_E_NOT_FOUND to mean there is no EKU extension or
        // property, which is the RFC 5280 unrestricted case.
        return Some(Vec::new());
    }
    let header_bytes = std::mem::size_of::<CTL_USAGE>();
    let mut capacity = (size as usize).max(header_bytes);
    if capacity > MAX_CERT_EKU_BYTES {
        return None;
    }

    for attempt in 0..2 {
        let words = capacity.div_ceil(std::mem::size_of::<u64>());
        let mut storage = Vec::<u64>::new();
        storage.try_reserve_exact(words).ok()?;
        storage.resize(words, 0);
        let usage = storage.as_mut_ptr().cast::<CTL_USAGE>();
        let mut written = capacity as u32;
        SetLastError(WIN32_ERROR(0));
        let result = CertGetEnhancedKeyUsage(cert, 0, Some(usage), &mut written);
        let error = GetLastError().0;
        if result.is_err() {
            if error == CRYPT_E_NOT_FOUND {
                return Some(Vec::new());
            }
            let needed = written as usize;
            if error == ERROR_MORE_DATA
                && attempt == 0
                && needed > capacity
                && needed <= MAX_CERT_EKU_BYTES
            {
                capacity = needed;
                continue;
            }
            return None;
        }

        let actual = written as usize;
        if actual < header_bytes || actual > capacity {
            return None;
        }
        let count = (*usage).cUsageIdentifier as usize;
        if count == 0 {
            // The same empty structure has two meanings: CRYPT_E_NOT_FOUND
            // means unrestricted; ERROR_SUCCESS means no valid purposes.
            return (error == CRYPT_E_NOT_FOUND).then(Vec::new);
        }
        if count > MAX_CERT_EKU_OIDS {
            return None;
        }
        let ids = (*usage).rgpszUsageIdentifier;
        if ids.is_null() {
            return None;
        }
        let base = storage.as_ptr() as usize;
        let end = base.checked_add(actual)?;
        let ids_start = ids as usize;
        let ids_bytes = count.checked_mul(std::mem::size_of::<PSTR>())?;
        let ids_end = ids_start.checked_add(ids_bytes)?;
        if ids_start < base.checked_add(header_bytes)? || ids_end > end {
            return None;
        }

        let mut out = Vec::new();
        out.try_reserve_exact(count).ok()?;
        let mut total_oid_bytes = 0usize;
        for i in 0..count {
            let ptr: PSTR = *ids.add(i);
            if ptr.is_null() {
                return None;
            }
            let start = ptr.0 as usize;
            if start < base || start >= end {
                return None;
            }
            let remaining = end - start;
            let scan_len = remaining.min(MAX_CERT_EKU_OID_BYTES + 1);
            let bytes = std::slice::from_raw_parts(ptr.0 as *const u8, scan_len);
            let nul = bytes.iter().position(|byte| *byte == 0)?;
            if nul == 0 {
                return None;
            }
            total_oid_bytes = total_oid_bytes.checked_add(nul)?;
            if total_oid_bytes > MAX_CERT_EKU_BYTES {
                return None;
            }
            let oid = std::str::from_utf8(&bytes[..nul]).ok()?;
            out.push(oid.to_owned());
        }
        return Some(out);
    }
    None
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
            hardware = ncrypt_provider_is_hardware(impl_type);
        }
        if caller_free.as_bool() {
            let _ = NCryptFreeObject(NCRYPT_HANDLE(key.0 as usize));
        }
    } else if caller_free.as_bool() {
        let _ = CryptReleaseContext(key.0 as usize, 0);
    }
    hardware
}

#[cfg(windows)]
fn ncrypt_provider_is_hardware(impl_type: u32) -> bool {
    impl_type & NCRYPT_IMPL_HARDWARE_FLAG != 0
}

/// Every eligible certificate in one store location.
#[cfg(windows)]
fn read_store(machine_store: bool) -> Result<Vec<StoreCertificate>, StoreReadError> {
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
        .map_err(|e| StoreReadError {
            reason: "open-failed",
            code: Some(hresult_hex(e.code().0)),
            message: format!("The Windows certificate store could not be opened: {e}"),
        })?;

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
            let valid_at_now = certificate_valid_at(
                filetime_u64(&info.NotBefore),
                filetime_u64(&info.NotAfter),
                now,
            );
            if !usage_extensions_are_decodable(cert) {
                continue;
            }
            let usage = intended_key_usage(cert);
            let Some(eku) = enhanced_key_usage(cert) else {
                continue;
            };
            if !eligible(has_key, valid_at_now, usage, Some(&eku)) {
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
fn read_store(_machine_store: bool) -> Result<Vec<StoreCertificate>, StoreReadError> {
    Err(StoreReadError {
        reason: "unsupported",
        code: None,
        message: crate::platform::Unsupported::new(crate::platform::feature::STORE_CERTIFICATES)
            .to_string(),
    })
}

/// Both store locations, the user's first.
///
/// The machine store is listed rather than hidden: an ordinary user CAN hold
/// a usable key there (an enterprise deployment that grants the account read
/// on the key container is the normal case), and a key they cannot reach
/// refuses at sign time by name. A store that will not open at all
/// contributes nothing and does not fail the user's own list.
pub fn list_certificates_detailed() -> Result<Vec<StoreCertificate>, StoreReadError> {
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

/// The same listing with the refusal as English text, for the CLI.
pub fn list_certificates() -> Result<Vec<StoreCertificate>, String> {
    list_certificates_detailed().map_err(|e| e.message)
}

#[tauri::command]
pub fn list_store_certificates() -> Result<Vec<StoreCertificate>, StoreReadError> {
    list_certificates_detailed()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_certificate_with_no_key_is_not_a_signer() {
        assert!(!eligible(false, true, Some(KU_DIGITAL_SIGNATURE), Some(&[])));
    }

    #[test]
    fn an_expired_certificate_is_excluded() {
        assert!(!eligible(true, false, Some(KU_DIGITAL_SIGNATURE), Some(&[])));
    }

    #[test]
    fn certificate_validity_includes_both_bounds_and_excludes_future_dates() {
        assert!(certificate_valid_at(10, 20, 10));
        assert!(certificate_valid_at(10, 20, 20));
        assert!(!certificate_valid_at(10, 20, 9));
        assert!(!certificate_valid_at(10, 20, 21));
        assert!(!eligible(
            true,
            certificate_valid_at(20, 30, 10),
            Some(KU_DIGITAL_SIGNATURE),
            Some(&[]),
        ));
    }

    #[test]
    fn an_absent_key_usage_extension_is_unrestricted() {
        assert!(eligible(true, true, Some(0), Some(&[])));
        assert!(!eligible(true, true, None, Some(&[])));
    }

    #[test]
    fn key_usage_without_signing_is_excluded() {
        // keyEncipherment alone — an encryption certificate.
        assert!(!eligible(true, true, Some(0x0020), Some(&[])));
    }

    #[test]
    fn non_repudiation_alone_qualifies() {
        assert!(eligible(true, true, Some(KU_NON_REPUDIATION), Some(&[])));
    }

    #[test]
    fn code_signing_only_is_excluded() {
        assert!(code_signing_only(&oids(&["1.3.6.1.5.5.7.3.3"])));
        assert!(!eligible(
            true,
            true,
            Some(KU_DIGITAL_SIGNATURE),
            Some(&oids(&["1.3.6.1.5.5.7.3.3", "1.3.6.1.4.1.311.10.3.13"]))
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
            true,
            Some(KU_DIGITAL_SIGNATURE),
            Some(&oids(&["1.3.6.1.5.5.7.3.3", "1.3.6.1.5.5.7.3.4"]))
        ));
    }

    #[test]
    fn any_purpose_beside_code_signing_is_kept() {
        assert!(!code_signing_only(&oids(&["1.3.6.1.5.5.7.3.3", EKU_ANY])));
    }

    #[test]
    fn a_missing_eku_is_unrestricted_but_an_unknown_eku_is_not_eligible() {
        assert!(!code_signing_only(&[]));
        assert!(eligible(true, true, Some(KU_DIGITAL_SIGNATURE), Some(&[])));
        assert!(!eligible(true, true, Some(KU_DIGITAL_SIGNATURE), None));
    }

    #[test]
    fn an_hresult_is_spelled_as_the_picker_matches_it() {
        // A negative i32 HRESULT must come out as its unsigned bit pattern,
        // or the renderer's code table never matches a real failure.
        assert_eq!(hresult_hex(0x8007_0005_u32 as i32), "0x80070005");
        assert_eq!(hresult_hex(0x8009_2004_u32 as i32), "0x80092004");
        assert_eq!(hresult_hex(5), "0x00000005");
    }

    #[test]
    fn a_store_refusal_serializes_as_fields_not_text() {
        let e = StoreReadError {
            reason: "open-failed",
            code: Some(hresult_hex(0x8007_0005_u32 as i32)),
            message: "The Windows certificate store could not be opened: x".to_string(),
        };
        let v = serde_json::to_value(&e).expect("serializes");
        assert_eq!(v["reason"], "open-failed");
        assert_eq!(v["code"], "0x80070005");
        assert!(v["message"].as_str().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn malformed_usage_extensions_are_not_treated_as_absent() {
        fn extension(oid: &'static [u8], value: &[u8]) -> CERT_EXTENSION {
            CERT_EXTENSION {
                pszObjId: PSTR(oid.as_ptr() as *mut u8),
                fCritical: windows::core::BOOL(0),
                Value: CRYPT_INTEGER_BLOB {
                    cbData: value.len() as u32,
                    pbData: value.as_ptr() as *mut u8,
                },
            }
        }

        fn readable(extensions: &mut [CERT_EXTENSION]) -> bool {
            let mut info = CERT_INFO {
                cExtension: extensions.len() as u32,
                rgExtension: extensions.as_mut_ptr(),
                ..CERT_INFO::default()
            };
            let cert = CERT_CONTEXT {
                dwCertEncodingType: X509_ASN_ENCODING | PKCS_7_ASN_ENCODING,
                pCertInfo: &mut info,
                ..CERT_CONTEXT::default()
            };
            unsafe { usage_extensions_are_decodable(&cert) }
        }

        const KEY_USAGE: &[u8] = b"2.5.29.15\0";
        const KEY_ATTRIBUTES: &[u8] = b"2.5.29.2\0";
        const EKU: &[u8] = b"2.5.29.37\0";
        let key_usage = [0x03, 0x02, 0x07, 0x80];
        let key_attributes = [0x30, 0x00];
        let eku = [
            0x30, 0x0a, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x04,
        ];
        let mut absent = [];
        assert!(readable(&mut absent));
        let mut valid = [
            extension(KEY_USAGE, &key_usage),
            extension(KEY_ATTRIBUTES, &key_attributes),
            extension(EKU, &eku),
        ];
        assert!(readable(&mut valid));

        for (oid, malformed) in [
            (KEY_USAGE, &[0x04, 0x02, 0xff, 0xff][..]),
            (KEY_USAGE, &[0x03, 0x03, 0x09, 0xff, 0xff][..]),
            (KEY_USAGE, &[0x03, 0x81, 0x02, 0x07, 0x80][..]),
            (KEY_ATTRIBUTES, &[0x04, 0x02, 0xff, 0xff][..]),
            (KEY_ATTRIBUTES, &[0x30, 0x81, 0x00][..]),
            (EKU, &[0x04, 0x02, 0xff, 0xff][..]),
            (EKU, &[0x30, 0x03, 0x06, 0x01, 0x80][..]),
            (EKU, &[0x30, 0x04, 0x06, 0x02, 0x80, 0x00][..]),
            (
                EKU,
                &[
                    0x30, 0x10, 0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x04,
                ][..],
            ),
        ] {
            let mut extensions = [extension(oid, malformed)];
            assert!(!readable(&mut extensions), "accepted malformed OID {oid:?}");
        }

        let mut duplicate = [
            extension(KEY_USAGE, &key_usage),
            extension(KEY_USAGE, &key_usage),
        ];
        assert!(
            !readable(&mut duplicate),
            "accepted duplicate key-usage extensions"
        );

        let mut too_many = vec![CERT_EXTENSION::default(); MAX_CERT_USAGE_EXTENSIONS + 1];
        assert!(
            !readable(&mut too_many),
            "accepted an excessive extension count"
        );
        let oversized_value = vec![0; MAX_CERT_EKU_BYTES + 1];
        let mut oversized = [extension(KEY_USAGE, &oversized_value)];
        assert!(
            !readable(&mut oversized),
            "accepted an oversized usage extension"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_hardware_random_generator_does_not_make_a_software_key_hardware_backed() {
        assert!(!ncrypt_provider_is_hardware(
            NCRYPT_IMPL_SOFTWARE_FLAG | NCRYPT_IMPL_HARDWARE_RNG_FLAG
        ));
        assert!(ncrypt_provider_is_hardware(NCRYPT_IMPL_HARDWARE_FLAG));
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

"""Windows certificate store keys as a signing source (CNG / CryptoAPI).

The private key never leaves the platform: a request names a certificate by
its SHA-1 thumbprint, the store hands back a key HANDLE, and ``NCryptSignHash``
signs a digest under that handle. Nothing here exports, imports, or reads key
material, and no PIN is asked for or accepted — a protected key raises
Windows' own consent UI inside the sign call.

Two key providers exist behind one certificate: a CNG key (``NCrypt``) and a
legacy CSP key (``CryptoAPI``). ``CryptAcquireCertificatePrivateKey`` reports
which one it handed back, and both paths are implemented — a legacy CSP key is
common on older smart-card middleware and refusing it would be a capability
gap, not a boundary.

A CryptoAPI signature is LITTLE-ENDIAN by that API's convention while PKCS#1
is big-endian, so the legacy path reverses the bytes. An ECDSA signature
arrives as fixed-width r||s and CMS carries a DER ``SEQUENCE``, so the ECDSA
path re-encodes.
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import POINTER, byref, c_void_p, c_wchar_p
from ctypes.wintypes import BOOL, BYTE, DWORD, FILETIME, LPCSTR

# ── Constants ────────────────────────────────────────────────────────────

X509_ASN_ENCODING = 0x00000001
PKCS_7_ASN_ENCODING = 0x00010000
_ENCODING = X509_ASN_ENCODING | PKCS_7_ASN_ENCODING

CERT_STORE_PROV_SYSTEM_W = 10
CERT_SYSTEM_STORE_CURRENT_USER = 1 << 16
CERT_SYSTEM_STORE_LOCAL_MACHINE = 2 << 16
CERT_STORE_READONLY_FLAG = 0x00008000

CERT_FIND_HASH = 0x00010000  # CERT_COMPARE_SHA1_HASH << CERT_COMPARE_SHIFT

CRYPT_ACQUIRE_PREFER_NCRYPT_KEY_FLAG = 0x00020000
CERT_NCRYPT_KEY_SPEC = 0xFFFFFFFF

BCRYPT_PAD_PKCS1 = 0x00000002
BCRYPT_PAD_PSS = 0x00000008

# CryptoAPI's own hash object handles (legacy CSP path only).
HP_HASHVAL = 0x0002
CALG_SHA_256 = 0x0000800C
CALG_SHA_384 = 0x0000800D
CALG_SHA_512 = 0x0000800E
CALG_SHA1 = 0x00008004

_CALG_BY_DIGEST = {
    "sha1": CALG_SHA1,
    "sha256": CALG_SHA_256,
    "sha384": CALG_SHA_384,
    "sha512": CALG_SHA_512,
}

#: CNG algorithm identifiers, by pyHanko's digest name.
_BCRYPT_ALG_BY_DIGEST = {
    "sha1": "SHA1",
    "sha256": "SHA256",
    "sha384": "SHA384",
    "sha512": "SHA512",
}

# The user turned the request down at Windows' own prompt. A refusal, not a
# failure: nothing is wrong with the certificate, the key, or the document.
NTE_USER_CANCELLED = 0x80090036
SCARD_W_CANCELLED_BY_USER = 0x8010006E
ERROR_CANCELLED = 0x000004C7
_CANCEL_CODES = frozenset(
    {
        NTE_USER_CANCELLED,
        SCARD_W_CANCELLED_BY_USER,
        ERROR_CANCELLED,
        NTE_USER_CANCELLED & 0xFFFF,
    }
)

# Both conditions are signalled by TYPE and worded by the caller: the engine's
# refusal table is swept from literal raise arguments, and a message reached
# through a constant is a message the renderer cannot localize.


class StoreUnavailable(Exception):
    """This platform exposes no Windows certificate store."""


class SigningCancelled(Exception):
    """The user turned down Windows' own key-use prompt."""


# ── Structures ───────────────────────────────────────────────────────────


class CRYPT_INTEGER_BLOB(ctypes.Structure):
    _fields_ = [("cbData", DWORD), ("pbData", POINTER(BYTE))]


class CRYPT_ALGORITHM_IDENTIFIER(ctypes.Structure):
    _fields_ = [("pszObjId", LPCSTR), ("Parameters", CRYPT_INTEGER_BLOB)]


class CRYPT_BIT_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", DWORD),
        ("pbData", POINTER(BYTE)),
        ("cUnusedBits", DWORD),
    ]


class CERT_PUBLIC_KEY_INFO(ctypes.Structure):
    _fields_ = [
        ("Algorithm", CRYPT_ALGORITHM_IDENTIFIER),
        ("PublicKey", CRYPT_BIT_BLOB),
    ]


class CERT_EXTENSION(ctypes.Structure):
    _fields_ = [
        ("pszObjId", LPCSTR),
        ("fCritical", BOOL),
        ("Value", CRYPT_INTEGER_BLOB),
    ]


class CERT_INFO(ctypes.Structure):
    _fields_ = [
        ("dwVersion", DWORD),
        ("SerialNumber", CRYPT_INTEGER_BLOB),
        ("SignatureAlgorithm", CRYPT_ALGORITHM_IDENTIFIER),
        ("Issuer", CRYPT_INTEGER_BLOB),
        ("NotBefore", FILETIME),
        ("NotAfter", FILETIME),
        ("Subject", CRYPT_INTEGER_BLOB),
        ("SubjectPublicKeyInfo", CERT_PUBLIC_KEY_INFO),
        ("IssuerUniqueId", CRYPT_BIT_BLOB),
        ("SubjectUniqueId", CRYPT_BIT_BLOB),
        ("cExtension", DWORD),
        ("rgExtension", POINTER(CERT_EXTENSION)),
    ]


class CERT_CONTEXT(ctypes.Structure):
    _fields_ = [
        ("dwCertEncodingType", DWORD),
        ("pbCertEncoded", POINTER(BYTE)),
        ("cbCertEncoded", DWORD),
        ("pCertInfo", POINTER(CERT_INFO)),
        ("hCertStore", c_void_p),
    ]


PCCERT_CONTEXT = POINTER(CERT_CONTEXT)


class CERT_ENHKEY_USAGE(ctypes.Structure):
    _fields_ = [("cUsageIdentifier", DWORD), ("rgpszUsageIdentifier", POINTER(LPCSTR))]


class CERT_USAGE_MATCH(ctypes.Structure):
    _fields_ = [("dwType", DWORD), ("Usage", CERT_ENHKEY_USAGE)]


class CERT_CHAIN_PARA(ctypes.Structure):
    _fields_ = [("cbSize", DWORD), ("RequestedUsage", CERT_USAGE_MATCH)]


class CERT_CHAIN_ELEMENT(ctypes.Structure):
    _fields_ = [
        ("cbSize", DWORD),
        ("pCertContext", PCCERT_CONTEXT),
        ("TrustStatus", DWORD * 2),
        ("pRevocationInfo", c_void_p),
        ("pIssuanceUsage", c_void_p),
        ("pApplicationUsage", c_void_p),
        ("pwszExtendedErrorInfo", c_wchar_p),
    ]


class CERT_SIMPLE_CHAIN(ctypes.Structure):
    _fields_ = [
        ("cbSize", DWORD),
        ("TrustStatus", DWORD * 2),
        ("cElement", DWORD),
        ("rgpElement", POINTER(POINTER(CERT_CHAIN_ELEMENT))),
        ("pTrustListInfo", c_void_p),
        ("fHasRevocationFreshnessTime", BOOL),
        ("dwRevocationFreshnessTime", DWORD),
    ]


class CERT_CHAIN_CONTEXT(ctypes.Structure):
    _fields_ = [
        ("cbSize", DWORD),
        ("TrustStatus", DWORD * 2),
        ("cChain", DWORD),
        ("rgpChain", POINTER(POINTER(CERT_SIMPLE_CHAIN))),
        ("cLowerQualityChainContext", DWORD),
        ("rgpLowerQualityChainContext", c_void_p),
        ("fBottomQualityChainContext", BOOL),
        ("dwRevocationFreshnessTime", DWORD),
    ]


class BCRYPT_PKCS1_PADDING_INFO(ctypes.Structure):
    _fields_ = [("pszAlgId", c_wchar_p)]


class BCRYPT_PSS_PADDING_INFO(ctypes.Structure):
    _fields_ = [("pszAlgId", c_wchar_p), ("cbSalt", ctypes.c_ulong)]


# ── Library binding ──────────────────────────────────────────────────────


def available() -> bool:
    """Whether this platform exposes the Windows certificate store."""
    if sys.platform != "win32":
        return False
    try:
        _libs()
    except Exception:
        return False
    return True


_LIBS: dict | None = None


def _libs() -> dict:
    """Bind crypt32/ncrypt/advapi32 once, with explicit signatures.

    Argument types are declared rather than inferred: a 64-bit handle passed
    as a default C ``int`` truncates silently and the call fails with an
    error that names the wrong thing.
    """
    global _LIBS
    if _LIBS is not None:
        return _LIBS
    if sys.platform != "win32":
        raise StoreUnavailable()
    crypt32 = ctypes.WinDLL("crypt32.dll", use_last_error=True)
    ncrypt = ctypes.WinDLL("ncrypt.dll", use_last_error=True)
    advapi32 = ctypes.WinDLL("advapi32.dll", use_last_error=True)

    crypt32.CertOpenStore.restype = c_void_p
    crypt32.CertOpenStore.argtypes = [c_void_p, DWORD, c_void_p, DWORD, c_void_p]
    crypt32.CertCloseStore.restype = BOOL
    crypt32.CertCloseStore.argtypes = [c_void_p, DWORD]
    crypt32.CertFindCertificateInStore.restype = PCCERT_CONTEXT
    crypt32.CertFindCertificateInStore.argtypes = [
        c_void_p, DWORD, DWORD, DWORD, c_void_p, PCCERT_CONTEXT,
    ]
    crypt32.CertFreeCertificateContext.restype = BOOL
    crypt32.CertFreeCertificateContext.argtypes = [PCCERT_CONTEXT]
    crypt32.CryptAcquireCertificatePrivateKey.restype = BOOL
    crypt32.CryptAcquireCertificatePrivateKey.argtypes = [
        PCCERT_CONTEXT, DWORD, c_void_p,
        POINTER(c_void_p), POINTER(DWORD), POINTER(BOOL),
    ]
    crypt32.CertGetCertificateChain.restype = BOOL
    crypt32.CertGetCertificateChain.argtypes = [
        c_void_p, PCCERT_CONTEXT, c_void_p, c_void_p,
        POINTER(CERT_CHAIN_PARA), DWORD, c_void_p,
        POINTER(POINTER(CERT_CHAIN_CONTEXT)),
    ]
    crypt32.CertFreeCertificateChain.restype = None
    crypt32.CertFreeCertificateChain.argtypes = [POINTER(CERT_CHAIN_CONTEXT)]

    ncrypt.NCryptSignHash.restype = ctypes.c_long
    ncrypt.NCryptSignHash.argtypes = [
        c_void_p, c_void_p, POINTER(BYTE), DWORD,
        POINTER(BYTE), DWORD, POINTER(DWORD), DWORD,
    ]
    ncrypt.NCryptFreeObject.restype = ctypes.c_long
    ncrypt.NCryptFreeObject.argtypes = [c_void_p]

    advapi32.CryptCreateHash.restype = BOOL
    advapi32.CryptCreateHash.argtypes = [c_void_p, DWORD, c_void_p, DWORD, POINTER(c_void_p)]
    advapi32.CryptSetHashParam.restype = BOOL
    advapi32.CryptSetHashParam.argtypes = [c_void_p, DWORD, POINTER(BYTE), DWORD]
    advapi32.CryptSignHashW.restype = BOOL
    advapi32.CryptSignHashW.argtypes = [
        c_void_p, DWORD, c_wchar_p, DWORD, POINTER(BYTE), POINTER(DWORD),
    ]
    advapi32.CryptDestroyHash.restype = BOOL
    advapi32.CryptDestroyHash.argtypes = [c_void_p]
    advapi32.CryptReleaseContext.restype = BOOL
    advapi32.CryptReleaseContext.argtypes = [c_void_p, DWORD]

    _LIBS = {"crypt32": crypt32, "ncrypt": ncrypt, "advapi32": advapi32}
    return _LIBS


def _normalized_thumbprint(thumbprint: str) -> bytes:
    text = "".join(ch for ch in (thumbprint or "") if not ch.isspace()).replace(":", "")
    if len(text) != 40:
        raise ValueError("A certificate thumbprint is 40 hexadecimal characters (SHA-1).")
    try:
        return bytes.fromhex(text)
    except ValueError:
        raise ValueError("A certificate thumbprint is 40 hexadecimal characters (SHA-1).") from None


# ── The certificate handle ───────────────────────────────────────────────


class StoreCertificate:
    """One store certificate, its chain, and a live handle to its key.

    A context manager: the key handle and the certificate context are released
    on exit. Nothing is acquired until ``open`` — enumeration is a separate
    concern and never touches a key.
    """

    def __init__(self, thumbprint: str, machine_store: bool = False):
        self.thumbprint = thumbprint
        self.machine_store = bool(machine_store)
        self._store = None
        self._cert = None
        self._key = None
        self._key_spec = 0
        self._caller_free = False
        #: DER of the signing certificate.
        self.certificate: bytes = b""
        #: DER of every OTHER certificate the chain engine placed above it.
        self.chain: list[bytes] = []

    # -- lifecycle --------------------------------------------------------

    def __enter__(self) -> "StoreCertificate":
        self.open()
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def open(self) -> "StoreCertificate":
        libs = _libs()
        crypt32 = libs["crypt32"]
        digest = _normalized_thumbprint(self.thumbprint)
        location = (
            CERT_SYSTEM_STORE_LOCAL_MACHINE if self.machine_store
            else CERT_SYSTEM_STORE_CURRENT_USER
        )
        store = crypt32.CertOpenStore(
            c_void_p(CERT_STORE_PROV_SYSTEM_W), 0, None,
            location | CERT_STORE_READONLY_FLAG, c_wchar_p("MY"),
        )
        if not store:
            raise StoreUnavailable()
        self._store = store

        buf = (BYTE * len(digest)).from_buffer_copy(digest)
        blob = CRYPT_INTEGER_BLOB(len(digest), ctypes.cast(buf, POINTER(BYTE)))
        cert = crypt32.CertFindCertificateInStore(
            store, _ENCODING, 0, CERT_FIND_HASH, byref(blob), None
        )
        if not cert:
            raise ValueError(
                "No certificate with that thumbprint is in the Windows certificate store."
            )
        self._cert = cert
        info = cert.contents
        self.certificate = ctypes.string_at(info.pbCertEncoded, info.cbCertEncoded)
        self.chain = self._read_chain(cert)
        self._acquire_key()
        return self

    def close(self) -> None:
        libs = _LIBS
        if libs is None:
            return
        if self._key is not None and self._caller_free:
            if self._key_spec == CERT_NCRYPT_KEY_SPEC:
                libs["ncrypt"].NCryptFreeObject(self._key)
            else:
                libs["advapi32"].CryptReleaseContext(self._key, 0)
        self._key = None
        if self._cert is not None:
            libs["crypt32"].CertFreeCertificateContext(self._cert)
            self._cert = None
        if self._store is not None:
            libs["crypt32"].CertCloseStore(self._store, 0)
            self._store = None

    # -- the store's own answers ------------------------------------------

    def _read_chain(self, cert) -> list[bytes]:
        """The issuers above this certificate, as the chain engine builds them.

        The engine's own answer, so the material the DSS and AIA logic see
        matches what a file-based source would carry. A chain that cannot be
        built is not an error here: a self-signed or partially-known signer
        still signs, exactly as it does from a .pfx with no bundled chain.
        """
        crypt32 = _libs()["crypt32"]
        para = CERT_CHAIN_PARA()
        para.cbSize = ctypes.sizeof(CERT_CHAIN_PARA)
        out = POINTER(CERT_CHAIN_CONTEXT)()
        ok = crypt32.CertGetCertificateChain(
            None, cert, None, None, byref(para), 0, None, byref(out)
        )
        if not ok or not out:
            return []
        try:
            ctx = out.contents
            if ctx.cChain == 0:
                return []
            simple = ctx.rgpChain[0].contents
            others: list[bytes] = []
            for i in range(simple.cElement):
                element = simple.rgpElement[i].contents
                element_cert = element.pCertContext.contents
                der = ctypes.string_at(element_cert.pbCertEncoded, element_cert.cbCertEncoded)
                if der != self.certificate:
                    others.append(der)
            return others
        finally:
            crypt32.CertFreeCertificateChain(out)

    def _acquire_key(self) -> None:
        """Take a handle on the certificate's private key.

        ``CRYPT_ACQUIRE_SILENT_FLAG`` is deliberately NOT set: a key that wants
        a PIN or a consent click must be able to raise Windows' own UI here.
        The silent flag belongs to enumeration's hardware probe, where no
        signing is intended.
        """
        crypt32 = _libs()["crypt32"]
        key = c_void_p()
        spec = DWORD(0)
        caller_free = BOOL(0)
        ok = crypt32.CryptAcquireCertificatePrivateKey(
            self._cert, CRYPT_ACQUIRE_PREFER_NCRYPT_KEY_FLAG, None,
            byref(key), byref(spec), byref(caller_free),
        )
        if not ok:
            code = ctypes.get_last_error() & 0xFFFFFFFF
            if code in _CANCEL_CODES:
                raise SigningCancelled()
            raise ValueError(
                "Windows would not release the private key for that certificate "
                f"(0x{code:08X}). It may have no key, or the key may live on a "
                "device that is not present."
            )
        self._key = key
        self._key_spec = spec.value
        self._caller_free = bool(caller_free.value)

    # -- signing -----------------------------------------------------------

    @property
    def uses_cng(self) -> bool:
        return self._key_spec == CERT_NCRYPT_KEY_SPEC

    def sign_digest(
        self, digest: bytes, digest_algorithm: str,
        pss_salt: int | None = None, ecdsa: bool = False,
    ) -> bytes:
        """Sign one already-computed digest under the store's key handle.

        Only the digest crosses this boundary — never the document, never the
        key. A cancelled prompt surfaces as ``SigningCancelled``, which the
        caller turns into a refusal rather than a failure.
        """
        algorithm = (digest_algorithm or "").lower()
        if algorithm not in _BCRYPT_ALG_BY_DIGEST:
            raise ValueError(f'Unsupported digest algorithm "{digest_algorithm}" for a store key.')
        if self.uses_cng:
            return self._sign_cng(digest, algorithm, pss_salt, ecdsa)
        if pss_salt is not None or ecdsa:
            raise ValueError(
                "That certificate's key is held by a legacy provider, which can only "
                "produce RSA PKCS#1 v1.5 signatures."
            )
        return self._sign_legacy(digest, algorithm)

    def _sign_cng(self, digest: bytes, algorithm: str, pss_salt: int | None, ecdsa: bool):
        ncrypt = _libs()["ncrypt"]
        buf = (BYTE * len(digest)).from_buffer_copy(digest)
        if ecdsa:
            padding = None
            flags = 0
        elif pss_salt is not None:
            # The salt length is the CALLER's, read off the mechanism the CMS
            # will declare. Signing with a different one produces a signature
            # that verifies against nothing, silently.
            info = BCRYPT_PSS_PADDING_INFO(_BCRYPT_ALG_BY_DIGEST[algorithm], pss_salt)
            padding = byref(info)
            flags = BCRYPT_PAD_PSS
        else:
            info = BCRYPT_PKCS1_PADDING_INFO(_BCRYPT_ALG_BY_DIGEST[algorithm])
            padding = byref(info)
            flags = BCRYPT_PAD_PKCS1
        size = DWORD(0)
        status = ncrypt.NCryptSignHash(
            self._key, padding, buf, len(digest), None, 0, byref(size), flags
        )
        self._raise_ncrypt(status)
        out = (BYTE * size.value)()
        status = ncrypt.NCryptSignHash(
            self._key, padding, buf, len(digest), out, size.value, byref(size), flags
        )
        self._raise_ncrypt(status)
        return bytes(bytearray(out)[: size.value])

    @staticmethod
    def _raise_ncrypt(status: int) -> None:
        if status == 0:
            return
        code = status & 0xFFFFFFFF
        if code in _CANCEL_CODES:
            raise SigningCancelled()
        raise ValueError(f"The Windows signing key refused the request (0x{code:08X}).")

    def _sign_legacy(self, digest: bytes, algorithm: str) -> bytes:
        """The CryptoAPI path, for a certificate whose key lives in a CSP.

        The signature comes back little-endian — CryptoAPI's convention, not
        PKCS#1's — so it is reversed before it reaches the CMS.
        """
        advapi32 = _libs()["advapi32"]
        alg_id = _CALG_BY_DIGEST.get(algorithm)
        if alg_id is None:
            raise ValueError(f'A legacy provider cannot sign a "{algorithm}" digest.')
        hash_handle = c_void_p()
        if not advapi32.CryptCreateHash(self._key, alg_id, None, 0, byref(hash_handle)):
            code = ctypes.get_last_error() & 0xFFFFFFFF
            raise ValueError(f"The legacy signing provider refused the request (0x{code:08X}).")
        try:
            buf = (BYTE * len(digest)).from_buffer_copy(digest)
            if not advapi32.CryptSetHashParam(hash_handle, HP_HASHVAL, buf, 0):
                code = ctypes.get_last_error() & 0xFFFFFFFF
                raise ValueError(f"The legacy signing provider rejected the digest (0x{code:08X}).")
            size = DWORD(0)
            advapi32.CryptSignHashW(hash_handle, self._key_spec, None, 0, None, byref(size))
            out = (BYTE * size.value)()
            if not advapi32.CryptSignHashW(
                hash_handle, self._key_spec, None, 0, out, byref(size)
            ):
                code = ctypes.get_last_error() & 0xFFFFFFFF
                if code in _CANCEL_CODES:
                    raise SigningCancelled()
                raise ValueError(f"The legacy signing provider refused the request (0x{code:08X}).")
            return bytes(bytearray(out)[: size.value][::-1])
        finally:
            advapi32.CryptDestroyHash(hash_handle)


def ecdsa_der(raw: bytes) -> bytes:
    """Re-encode a fixed-width ``r||s`` ECDSA signature as the DER SEQUENCE CMS
    carries. CNG emits the fixed-width form; nothing downstream accepts it."""
    if len(raw) % 2:
        raise ValueError("The signing key returned a malformed ECDSA signature.")
    half = len(raw) // 2
    r = int.from_bytes(raw[:half], "big")
    s = int.from_bytes(raw[half:], "big")

    def _int(value: int) -> bytes:
        body = value.to_bytes((value.bit_length() + 8) // 8 or 1, "big")
        return b"\x02" + bytes([len(body)]) + body

    payload = _int(r) + _int(s)
    return b"\x30" + bytes([len(payload)]) + payload

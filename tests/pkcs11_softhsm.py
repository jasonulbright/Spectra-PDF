"""SoftHSM test-story helpers: token init (ctypes) + key/cert import.

python-pkcs11 deliberately omits C_InitToken, and SoftHSM's own
softhsm2-util in the portable Windows build fails to load its module
(missing dependent DLLs — probe-caught), so BOTH provisioning steps run
in-process here: ``init_token`` binds the PKCS#11 C ABI directly for
C_InitToken/C_InitPIN, and ``provision_identity`` stores a
cryptography-generated RSA key + self-signed cert through python-pkcs11.
The engine's PKCS#11 SIGNING never initializes tokens (a real HSM arrives
provisioned) — this module exists so pytest can exercise the signing op
against a genuine PKCS#11 stack. Lives in tests/ (never ships).
"""

import ctypes
import datetime
from ctypes import POINTER, byref, c_ubyte, c_ulong, c_void_p

CKF_SERIAL_SESSION = 0x0004
CKF_RW_SESSION = 0x0002
CKU_SO = 0
CKR_OK = 0


def _padded(label: str) -> bytes:
    b = label.encode("utf-8")[:32]
    return b + b" " * (32 - len(b))


class _FunctionList(ctypes.Structure):
    # CK_FUNCTION_LIST: a version field then 68 ordered function pointers
    # (PKCS#11 v2.x layout). Names must match the spec ORDER — only the
    # handful used here are called. Windows cryptoki.h mandates
    # #pragma pack(1); without _pack_ the default 8-byte alignment pads
    # after the 2-byte version and every pointer reads garbage
    # (probe-caught access violation).
    _pack_ = 1
    _fields_ = [("version", ctypes.c_ushort)] + [
        (name, c_void_p)
        for name in (
            "C_Initialize", "C_Finalize", "C_GetInfo", "C_GetFunctionList",
            "C_GetSlotList", "C_GetSlotInfo", "C_GetTokenInfo",
            "C_GetMechanismList", "C_GetMechanismInfo", "C_InitToken",
            "C_InitPIN", "C_SetPIN", "C_OpenSession", "C_CloseSession",
            "C_CloseAllSessions", "C_GetSessionInfo", "C_GetOperationState",
            "C_SetOperationState", "C_Login", "C_Logout",
        )
    ]


def _fn(flist, name, restype=c_ulong, argtypes=()):
    proto = ctypes.CFUNCTYPE(restype, *argtypes)
    return proto(getattr(flist, name))


def init_token(module_path: str, so_pin: str, user_pin: str, label: str) -> None:
    """Initialize the first uninitialized slot's token and set its user PIN."""
    dll = ctypes.CDLL(str(module_path))
    get_fl = dll.C_GetFunctionList
    get_fl.restype = c_ulong
    get_fl.argtypes = [POINTER(POINTER(_FunctionList))]
    flp = POINTER(_FunctionList)()
    rv = get_fl(byref(flp))
    if rv != CKR_OK:
        raise RuntimeError(f"C_GetFunctionList failed: 0x{rv:08x}")
    fl = flp.contents

    c_initialize = _fn(fl, "C_Initialize", argtypes=[c_void_p])
    c_finalize = _fn(fl, "C_Finalize", argtypes=[c_void_p])
    c_get_slot_list = _fn(
        fl, "C_GetSlotList", argtypes=[c_ubyte, POINTER(c_ulong), POINTER(c_ulong)]
    )
    c_init_token = _fn(
        fl, "C_InitToken",
        argtypes=[c_ulong, POINTER(c_ubyte), c_ulong, POINTER(c_ubyte)],
    )
    c_open_session = _fn(
        fl, "C_OpenSession",
        argtypes=[c_ulong, c_ulong, c_void_p, c_void_p, POINTER(c_ulong)],
    )
    c_close_session = _fn(fl, "C_CloseSession", argtypes=[c_ulong])
    c_login = _fn(
        fl, "C_Login", argtypes=[c_ulong, c_ulong, POINTER(c_ubyte), c_ulong]
    )
    c_init_pin = _fn(fl, "C_InitPIN", argtypes=[c_ulong, POINTER(c_ubyte), c_ulong])

    rv = c_initialize(None)
    if rv != CKR_OK and rv != 0x191:  # CKR_CRYPTOKI_ALREADY_INITIALIZED
        raise RuntimeError(f"C_Initialize failed: 0x{rv:08x}")
    try:
        count = c_ulong(0)
        rv = c_get_slot_list(0, None, byref(count))
        if rv != CKR_OK or count.value == 0:
            raise RuntimeError("No PKCS#11 slots available.")
        slots = (c_ulong * count.value)()
        rv = c_get_slot_list(0, slots, byref(count))
        if rv != CKR_OK:
            raise RuntimeError(f"C_GetSlotList failed: 0x{rv:08x}")
        slot = slots[0]

        so = so_pin.encode()
        so_buf = (c_ubyte * len(so)).from_buffer_copy(so)
        label_buf = (c_ubyte * 32).from_buffer_copy(_padded(label))
        rv = c_init_token(slot, so_buf, len(so), label_buf)
        if rv != CKR_OK:
            raise RuntimeError(f"C_InitToken failed: 0x{rv:08x}")

        # SoftHSM moves the fresh token to a new slot id; re-list and use the
        # LAST slot (the uninitialized-slot placeholder stays at the end in
        # some builds — find the one whose token label matches via a session
        # login attempt instead of trusting position: simplest reliable form
        # is re-listing and initializing the PIN on the slot whose InitToken
        # we just ran; SoftHSM keeps that slot id valid for the session).
        count2 = c_ulong(0)
        c_get_slot_list(0, None, byref(count2))
        slots2 = (c_ulong * count2.value)()
        c_get_slot_list(0, slots2, byref(count2))
        target = slots2[0] if count2.value == 1 else slot

        session = c_ulong(0)
        rv = c_open_session(
            target, CKF_SERIAL_SESSION | CKF_RW_SESSION, None, None, byref(session)
        )
        if rv != CKR_OK:
            raise RuntimeError(f"C_OpenSession failed: 0x{rv:08x}")
        try:
            rv = c_login(session.value, CKU_SO, so_buf, len(so))
            if rv != CKR_OK:
                raise RuntimeError(f"C_Login(SO) failed: 0x{rv:08x}")
            up = user_pin.encode()
            up_buf = (c_ubyte * len(up)).from_buffer_copy(up)
            rv = c_init_pin(session.value, up_buf, len(up))
            if rv != CKR_OK:
                raise RuntimeError(f"C_InitPIN failed: 0x{rv:08x}")
        finally:
            c_close_session(session.value)
    finally:
        c_finalize(None)


def provision_identity(
    module_path: str,
    token_label: str,
    user_pin: str,
    *,
    key_label: str = "spectra-key",
    cert_label: str = "spectra-cert",
    cn: str = "Spectra HSM Test Signer",
):
    """Store an RSA-2048 key + matching self-signed cert on the token via
    python-pkcs11 (create_object with key components — the util-free import).
    Returns the certificate (cryptography object) for assertions."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    import pkcs11
    from pkcs11 import Attribute, CertificateType, KeyType, ObjectClass

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, cn)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=36500))
        .sign(key, hashes.SHA256())
    )

    nums = key.private_numbers()
    pub = key.public_key().public_numbers()

    def be(n: int) -> bytes:
        return n.to_bytes((n.bit_length() + 7) // 8, "big")

    lib = pkcs11.lib(str(module_path))
    token = lib.get_token(token_label=token_label)
    obj_id = b"\x0a\x0b"
    with token.open(rw=True, user_pin=user_pin) as session:
        session.create_object({
            Attribute.CLASS: ObjectClass.PRIVATE_KEY,
            Attribute.KEY_TYPE: KeyType.RSA,
            Attribute.TOKEN: True,
            Attribute.PRIVATE: True,
            Attribute.SENSITIVE: True,
            Attribute.EXTRACTABLE: False,
            Attribute.SIGN: True,
            Attribute.DECRYPT: True,
            Attribute.LABEL: key_label,
            Attribute.ID: obj_id,
            Attribute.MODULUS: be(pub.n),
            Attribute.PUBLIC_EXPONENT: be(pub.e),
            Attribute.PRIVATE_EXPONENT: be(nums.d),
            Attribute.PRIME_1: be(nums.p),
            Attribute.PRIME_2: be(nums.q),
            Attribute.EXPONENT_1: be(nums.dmp1),
            Attribute.EXPONENT_2: be(nums.dmq1),
            Attribute.COEFFICIENT: be(nums.iqmp),
        })
        session.create_object({
            Attribute.CLASS: ObjectClass.CERTIFICATE,
            Attribute.CERTIFICATE_TYPE: CertificateType.X_509,
            Attribute.VALUE: cert.public_bytes(serialization.Encoding.DER),
            # SoftHSM requires CKA_SUBJECT on X.509 cert objects
            # (TemplateIncomplete otherwise — probe-caught).
            Attribute.SUBJECT: cert.subject.public_bytes(),
            Attribute.LABEL: cert_label,
            Attribute.ID: obj_id,
            Attribute.TOKEN: True,
        })
    return cert

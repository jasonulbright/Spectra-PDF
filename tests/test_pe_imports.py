"""The PE import/export reader the vendored-wheel gates run."""

import importlib.util
import struct
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("pe_imports", REPO / "scripts" / "pe_imports.py")
pe_imports = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pe_imports)

PYTHON_DLL = REPO / "resources" / "python" / "python314.dll"
HEIF_WHEEL = REPO / "vendor" / "wheels" / "pillow_heif-1.8.0+decode.2-cp314-cp314-win_amd64.whl"


@pytest.mark.skipif(not PYTHON_DLL.is_file(), reason="the embedded runtime is not provisioned")
def test_it_reads_the_runtime_dll_tables():
    exports = pe_imports.exports(PYTHON_DLL)
    assert "Py_Initialize" in exports
    assert "PyErr_SetString" in exports
    imports = {name.lower(): symbols for name, symbols in pe_imports.imports(PYTHON_DLL).items()}
    assert "GetProcAddress" in imports["kernel32.dll"]
    assert "vcruntime140.dll" in imports


@pytest.fixture(scope="module")
def heif_binaries(tmp_path_factory):
    out = tmp_path_factory.mktemp("heif-wheel")
    with zipfile.ZipFile(HEIF_WHEEL) as zf:
        zf.extractall(out)
    return {p.name: p for p in pe_imports.binaries([str(out)])}


def test_it_reads_the_heif_wheel_import_graph(heif_binaries):
    by_prefix = {name.split("-")[0].split(".")[0]: path for name, path in heif_binaries.items()}
    assert set(by_prefix) == {"_pillow_heif", "heif", "libde265"}

    pyd = pe_imports.imports(by_prefix["_pillow_heif"])
    heif_dll = by_prefix["heif"].name
    assert "PyInit__pillow_heif" in pe_imports.exports(by_prefix["_pillow_heif"])
    assert "python314.dll" in pyd
    assert "heif_context_alloc" in pyd[heif_dll]

    heif = pe_imports.imports(by_prefix["heif"])
    assert by_prefix["libde265"].name in heif
    assert "heif_context_alloc" in pe_imports.exports(by_prefix["heif"])
    assert "de265_new_decoder" in pe_imports.exports(by_prefix["libde265"])

    for path in heif_binaries.values():
        linked = list(pe_imports.imports(path)) + list(pe_imports.delay_imports(path))
        assert not [dll for dll in linked if "x265" in dll.lower()]


def test_a_file_that_is_not_an_image_refuses(tmp_path):
    bogus = tmp_path / "not.dll"
    bogus.write_bytes(b"MZ" + b"\0" * 100)
    with pytest.raises(pe_imports.NotPE):
        pe_imports.imports(bogus)


def _block(key: str, value: bytes = b"", wtype: int = 0, children: bytes = b"") -> bytes:
    """One VS_VERSIONINFO-shaped block: header, key, padded value, children."""
    body = key.encode("utf-16-le") + b"\0\0"
    head_len = 6 + len(body)
    pad1 = (-head_len) % 4
    pad2 = (-(head_len + pad1 + len(value))) % 4 if children else 0
    length = head_len + pad1 + len(value) + pad2 + len(children)
    value_len = len(value) // 2 if wtype == 1 else len(value)
    return struct.pack("<HHH", length, value_len, wtype) + body + b"\0" * pad1 + value + b"\0" * pad2 + children


def _text(key: str, text: str) -> bytes:
    block = _block(key, (text + "\0").encode("utf-16-le"), 1)
    return block + b"\0" * ((-len(block)) % 4)


def _version_resource(file_ms: int, file_ls: int, prod_ms: int, prod_ls: int, strings: dict[str, str]) -> bytes:
    fixed = struct.pack("<13I", 0xFEEF04BD, 0x10000, file_ms, file_ls, prod_ms, prod_ls, 0x3F, 0, 4, 2, 0, 0, 0)
    table = _block("040904b0", wtype=1, children=b"".join(_text(k, v) for k, v in strings.items()))
    sfi = _block("StringFileInfo", wtype=1, children=table + b"\0" * ((-len(table)) % 4))
    return _block("VS_VERSION_INFO", fixed, 0, sfi)


def _pe_with_resource(blob: bytes) -> bytes:
    """A minimal PE32+ image whose only section is a .rsrc carrying `blob` as RT_VERSION."""
    rsrc_rva, raw_ptr = 0x1000, 0x200
    tree = bytearray()
    tree += struct.pack("<IIHHHH", 0, 0, 0, 0, 0, 1) + struct.pack("<II", 16, 0x80000000 | 0x18)
    tree += struct.pack("<IIHHHH", 0, 0, 0, 0, 0, 1) + struct.pack("<II", 1, 0x80000000 | 0x30)
    tree += struct.pack("<IIHHHH", 0, 0, 0, 0, 0, 1) + struct.pack("<II", 0x409, 0x48)
    tree += struct.pack("<IIII", rsrc_rva + 0x58, len(blob), 0, 0)
    tree += b"\0" * (0x58 - len(tree)) + blob
    section = bytes(tree) + b"\0" * ((-len(tree)) % 0x200)

    pe = 0x40
    opt_size = 0xF0
    image = bytearray(raw_ptr)
    image[:2] = b"MZ"
    struct.pack_into("<I", image, 0x3C, pe)
    image[pe : pe + 4] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", image, pe + 4, 0x8664, 1, 0, 0, 0, opt_size, 0x2022)
    opt = pe + 24
    struct.pack_into("<H", image, opt, 0x20B)
    struct.pack_into("<I", image, opt + 108, 16)
    struct.pack_into("<II", image, opt + 112 + 8 * 2, rsrc_rva, len(tree))
    sec = opt + opt_size
    image[sec : sec + 8] = b".rsrc\0\0\0"
    struct.pack_into("<IIII", image, sec + 8, len(tree), rsrc_rva, len(section), raw_ptr)
    return bytes(image) + section


def test_it_reads_the_fixed_block_and_the_string_table(tmp_path):
    blob = _version_resource((2 << 16) | 13, (2 << 16) | 0, (2 << 16) | 13, (2 << 16) | 7,
                             {"ProductName": "FreeType", "ProductVersion": "2.13.2", "FileVersion": "2.13.2"})
    dll = tmp_path / "fake.dll"
    dll.write_bytes(_pe_with_resource(blob))
    info = pe_imports.version_info(dll)
    assert info["FileVersion#"] == "2.13.2.0"
    assert info["ProductVersion#"] == "2.13.2.7"
    assert info["ProductName"] == "FreeType"
    assert info["ProductVersion"] == "2.13.2"


def test_an_image_without_resources_has_no_version(tmp_path):
    image = bytearray(_pe_with_resource(_version_resource(0, 0, 0, 0, {})))
    struct.pack_into("<II", image, 0x40 + 24 + 112 + 16, 0, 0)
    dll = tmp_path / "bare.dll"
    dll.write_bytes(bytes(image))
    assert pe_imports.version_info(dll) is None


@pytest.mark.skipif(not PYTHON_DLL.is_file(), reason="the embedded runtime is not provisioned")
def test_it_reads_the_runtime_dll_version_resource():
    info = pe_imports.version_info(PYTHON_DLL)
    assert info["ProductName"] == "Python"
    assert info["ProductVersion"].startswith("3.")
    assert info["FileVersion#"].startswith("3.")


TESSERACT = REPO / "resources" / "tesseract"


@pytest.mark.skipif(not (TESSERACT / "tesseract.exe").is_file(), reason="the OCR runtime is not provisioned")
def test_the_ocr_tree_ships_only_the_import_closure_of_the_recognizer():
    assert pe_imports.unreached(TESSERACT, ["tesseract.exe"]) == []
    live = pe_imports.reached(TESSERACT, ["tesseract.exe"])
    assert {"libtesseract-5.dll", "libleptonica-6.dll", "libpng16-16.dll"} <= live


def test_a_missing_root_refuses(tmp_path):
    with pytest.raises(FileNotFoundError):
        pe_imports.reached(tmp_path, ["absent.exe"])

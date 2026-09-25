"""The PE import/export reader the vendored-wheel gates run."""

import importlib.util
import zipfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("pe_imports", REPO / "scripts" / "pe_imports.py")
pe_imports = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pe_imports)

PYTHON_DLL = REPO / "resources" / "python" / "python314.dll"
HEIF_WHEEL = REPO / "vendor" / "wheels" / "pillow_heif-1.8.0+decode.1-cp314-cp314-win_amd64.whl"


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

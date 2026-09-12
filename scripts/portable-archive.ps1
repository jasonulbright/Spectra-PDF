# The portable ZIP writer and verifier, dot-sourced by build-portable-zip.ps1.
#
# Entry names are computed here, from the installer manifest's relative paths,
# and handed to System.IO.Compression.ZipArchive verbatim. The archive module
# that ships with a given PowerShell decides its own separator and skips hidden
# files; the framework class stores exactly the name it is given, so the
# archive's identity depends on nothing installed on the machine that writes it.
#
# ZIP APPNOTE 4.4.17.1: the stored name uses forward slashes, carries no drive
# or leading slash, and is relative to the archive root. Both header copies of
# every entry (local file header and central directory record) are read back
# and compared field by field, because an extractor may trust either one, and
# the decoded bytes are checked against the declared CRC-32 and size, because
# the framework reader returns bytes without checking either.
#
# Supported forms are the ones the writer and the standard readers produce:
# methods 0 (stored) and 8 (deflate); sizes and CRC in the local header, or a
# data descriptor after the data when flag bit 3 is set; ZIP64 sizes and
# offsets through the 0x0001 extra field in either header and through the
# ZIP64 end records. Anything else refuses by name rather than being parsed.

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# CRC-32 (IEEE, reflected, polynomial 0xEDB88320) over the decoded bytes. A
# PowerShell loop per byte cannot cover a release-sized payload; this compiles
# once per process from a source that needs nothing beyond mscorlib.
if (-not ('SpectraPortable.Crc32' -as [type])) {
    Add-Type -TypeDefinition @'
namespace SpectraPortable {
    public sealed class Crc32 {
        static readonly uint[] Table = MakeTable();
        static uint[] MakeTable() {
            var table = new uint[256];
            for (uint i = 0; i < 256; i++) {
                uint c = i;
                for (int k = 0; k < 8; k++) { c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1; }
                table[i] = c;
            }
            return table;
        }
        uint crc = 0xFFFFFFFFu;
        public void Update(byte[] buffer, int count) {
            for (int i = 0; i < count; i++) { crc = Table[(crc ^ buffer[i]) & 0xFF] ^ (crc >> 8); }
        }
        public long Value { get { return (long)(crc ^ 0xFFFFFFFFu); } }
    }
}
'@
}

$script:PortableSentinel32 = [uint32]::MaxValue
$script:PortableSentinel16 = [uint16]::MaxValue

# Canonical archive name for a manifest destination, or a throw naming it.
# Segments that Windows would strip or reject on extraction (trailing dots or
# spaces, reserved characters) cannot name a file unambiguously and are refused.
function ConvertTo-PortableEntryName {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Relative)
    if ([string]::IsNullOrWhiteSpace($Relative)) { throw "unsafe payload destination: $Relative" }
    $segments = $Relative -split '[\\/]'
    foreach ($segment in $segments) {
        if ($segment -eq '' -or $segment -eq '.' -or $segment -eq '..' -or
            $segment -match '[<>:"|?*\x00-\x1F]' -or $segment -match '[. ]$') {
            throw "unsafe payload destination: $Relative"
        }
    }
    # Reached only with legal characters: the framework check throws on others.
    if ([IO.Path]::IsPathRooted($Relative)) { throw "unsafe payload destination: $Relative" }
    return ($segments -join '/')
}

# SHA-256 (hex), CRC-32 and length of a stream in one pass.
function Get-PortableStreamDigest([IO.Stream]$Stream) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $buffer = [byte[]]::new(81920)
        $crc = [SpectraPortable.Crc32]::new()
        $length = [long]0
        while (($count = $Stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $crc.Update($buffer, $count)
            [void]$sha.TransformBlock($buffer, 0, $count, $null, 0)
            $length += $count
        }
        [void]$sha.TransformFinalBlock($buffer, 0, 0)
        return [pscustomobject]@{
            sha256 = [BitConverter]::ToString($sha.Hash).Replace('-', '')
            crc32  = $crc.Value
            length = $length
        }
    } finally {
        $sha.Dispose()
    }
}

# The ZIP64 extra field (APPNOTE 4.5.3) inside an extra-field block: only the
# values whose 32-bit slots hold the sentinel are present, in fixed order.
# Returns the resolved values; throws by name on a block that overruns its
# declared length or a ZIP64 field shorter than the values it must carry.
function Resolve-PortableZip64Field {
    param([byte[]]$Extra, [long]$Uncompressed, [long]$Compressed, [long]$Offset, [long]$Disk, [string]$Where)
    $needed = 0
    if ($Uncompressed -eq $script:PortableSentinel32) { $needed += 8 }
    if ($Compressed -eq $script:PortableSentinel32) { $needed += 8 }
    if ($Offset -eq $script:PortableSentinel32) { $needed += 8 }
    if ($Disk -eq $script:PortableSentinel16) { $needed += 4 }
    $p = 0
    while ($p + 4 -le $Extra.Length) {
        $id = [BitConverter]::ToUInt16($Extra, $p)
        $size = [int][BitConverter]::ToUInt16($Extra, $p + 2)
        $p += 4
        if ($p + $size -gt $Extra.Length) { throw "$Where extra field 0x$($id.ToString('X4')) overruns its declared length" }
        if ($id -eq 1) {
            if ($size -lt $needed) { throw "$Where ZIP64 field is shorter than the values it must carry" }
            $q = $p
            if ($Uncompressed -eq $script:PortableSentinel32) { $Uncompressed = [long][BitConverter]::ToUInt64($Extra, $q); $q += 8 }
            if ($Compressed -eq $script:PortableSentinel32) { $Compressed = [long][BitConverter]::ToUInt64($Extra, $q); $q += 8 }
            if ($Offset -eq $script:PortableSentinel32) { $Offset = [long][BitConverter]::ToUInt64($Extra, $q); $q += 8 }
            if ($Disk -eq $script:PortableSentinel16) { $Disk = [long][BitConverter]::ToUInt32($Extra, $q) }
            return [pscustomobject]@{ uncompressed = $Uncompressed; compressed = $Compressed; offset = $Offset; disk = $Disk }
        }
        $p += $size
    }
    throw "$Where needs a ZIP64 field it does not carry"
}

# Reads the end-of-central-directory record, every central directory record,
# every local file header and every data descriptor without decompressing
# anything. Structural faults throw by name; per-entry disagreements are
# recorded for the verifier to list.
function Read-PortableArchiveDirectory {
    param([Parameter(Mandatory)][string]$Path)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $reader = [IO.BinaryReader]::new($stream)
        $length = $stream.Length
        if ($length -lt 22) { throw 'too small to carry an end-of-central-directory record' }
        $scanStart = [Math]::Max(0, $length - 22 - 65535)
        $stream.Position = $scanStart
        $window = $reader.ReadBytes([int]($length - $scanStart))
        $eocd = -1
        for ($i = $window.Length - 22; $i -ge 0; $i--) {
            if ($window[$i] -eq 0x50 -and $window[$i + 1] -eq 0x4B -and $window[$i + 2] -eq 0x05 -and $window[$i + 3] -eq 0x06) {
                $commentLength = [BitConverter]::ToUInt16($window, $i + 20)
                # The record must close the file: trailing bytes after the
                # comment mean a second archive or garbage was appended.
                if ($scanStart + $i + 22 + $commentLength -eq $length) { $eocd = $scanStart + $i; break }
            }
        }
        if ($eocd -lt 0) { throw 'no end-of-central-directory record closes the file' }
        $base = [int]($eocd - $scanStart)
        if ([BitConverter]::ToUInt16($window, $base + 4) -ne 0 -or [BitConverter]::ToUInt16($window, $base + 6) -ne 0) {
            throw 'multi-disk archive'
        }
        $entriesTotal16 = [BitConverter]::ToUInt16($window, $base + 10)
        $directorySize32 = [BitConverter]::ToUInt32($window, $base + 12)
        $directoryOffset32 = [BitConverter]::ToUInt32($window, $base + 16)
        $entriesTotal = [long]$entriesTotal16
        $directorySize = [long]$directorySize32
        $directoryOffset = [long]$directoryOffset32
        $zip64 = $false
        if ($entriesTotal16 -eq $script:PortableSentinel16 -or $directorySize32 -eq $script:PortableSentinel32 -or $directoryOffset32 -eq $script:PortableSentinel32) {
            if ($eocd -lt 20) { throw 'ZIP64 sentinel without a ZIP64 locator' }
            $stream.Position = $eocd - 20
            if ($reader.ReadUInt32() -ne [uint32]0x07064B50) { throw 'ZIP64 sentinel without a ZIP64 locator' }
            $null = $reader.ReadUInt32()
            $recordOffset = [long]$reader.ReadUInt64()
            if ($recordOffset -lt 0 -or $recordOffset -ge $eocd - 20) { throw 'ZIP64 locator points outside the file' }
            $stream.Position = $recordOffset
            if ($reader.ReadUInt32() -ne [uint32]0x06064B50) { throw 'ZIP64 locator points at no ZIP64 record' }
            $null = $reader.ReadUInt64()
            $null = $reader.ReadUInt16(); $null = $reader.ReadUInt16()
            if ($reader.ReadUInt32() -ne 0 -or $reader.ReadUInt32() -ne 0) { throw 'multi-disk archive' }
            $null = $reader.ReadUInt64()
            $entriesTotal = [long]$reader.ReadUInt64()
            $directorySize = [long]$reader.ReadUInt64()
            $directoryOffset = [long]$reader.ReadUInt64()
            $zip64 = $true
        }
        if ($directoryOffset -lt 0 -or $directorySize -lt 0 -or $directoryOffset + $directorySize -gt $eocd) { throw 'central directory lies outside the file' }

        $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
        $entries = [Collections.Generic.List[object]]::new()
        $stream.Position = $directoryOffset
        for ($n = 0; $n -lt $entriesTotal; $n++) {
            if ($reader.ReadUInt32() -ne [uint32]0x02014B50) { throw "central directory record $n carries no signature" }
            $null = $reader.ReadUInt16(); $null = $reader.ReadUInt16()
            $flags = $reader.ReadUInt16()
            $method = $reader.ReadUInt16()
            $null = $reader.ReadUInt32()
            $crc = $reader.ReadUInt32()
            $compressed = [long]$reader.ReadUInt32()
            $uncompressed = [long]$reader.ReadUInt32()
            $nameLength = $reader.ReadUInt16()
            $extraLength = $reader.ReadUInt16()
            $commentLength = $reader.ReadUInt16()
            $disk = [long]$reader.ReadUInt16()
            $null = $reader.ReadUInt16(); $null = $reader.ReadUInt32()
            $localOffset = [long]$reader.ReadUInt32()
            $nameBytes = $reader.ReadBytes($nameLength)
            $extra = $reader.ReadBytes($extraLength)
            $null = $reader.ReadBytes($commentLength)
            $centralZip64 = $false
            if ($uncompressed -eq $script:PortableSentinel32 -or $compressed -eq $script:PortableSentinel32 -or
                $localOffset -eq $script:PortableSentinel32 -or $disk -eq $script:PortableSentinel16) {
                $resolved = Resolve-PortableZip64Field -Extra $extra -Uncompressed $uncompressed -Compressed $compressed -Offset $localOffset -Disk $disk -Where "central directory record $n"
                $uncompressed = $resolved.uncompressed
                $compressed = $resolved.compressed
                $localOffset = $resolved.offset
                $disk = $resolved.disk
                $centralZip64 = $true
            }
            if ($disk -ne 0) { throw 'multi-disk archive' }
            $utf8 = ($flags -band 0x800) -ne 0
            $nonAscii = $false
            foreach ($b in $nameBytes) { if ($b -ge 0x80) { $nonAscii = $true; break } }
            $decodable = $true
            if ($utf8) {
                try { $name = $strictUtf8.GetString($nameBytes) } catch { $name = [Text.Encoding]::ASCII.GetString($nameBytes); $decodable = $false }
            } else {
                $name = [Text.Encoding]::ASCII.GetString($nameBytes)
            }
            $entries.Add([pscustomobject]@{
                index               = $n
                name                = $name
                nameBytes           = $nameBytes
                utf8Flag            = $utf8
                nonAsciiWithoutFlag = ($nonAscii -and -not $utf8)
                undecodable         = -not $decodable
                flags               = $flags
                method              = $method
                crc                 = $crc
                compressedSize      = $compressed
                uncompressedSize    = $uncompressed
                localOffset         = $localOffset
                centralZip64        = $centralZip64
                localZip64          = $false
                localNameMatches    = $false
                localFlags          = [uint16]0
                localMethod         = [uint16]0
                localCrc            = [uint32]0
                localCompressedSize = [long]0
                localUncompressedSize = [long]0
                descriptor          = $null
                dataOffset          = [long]0
                entryEnd            = [long]0
            })
        }
        if ($stream.Position -ne $directoryOffset + $directorySize) { throw 'central directory size disagrees with its records' }

        foreach ($entry in $entries) {
            if ($entry.localOffset -lt 0 -or $entry.localOffset + 30 -gt $directoryOffset) { throw "local header of $($entry.name) lies outside the file" }
            $stream.Position = $entry.localOffset
            if ($reader.ReadUInt32() -ne [uint32]0x04034B50) { throw "no local file header where the central directory places $($entry.name)" }
            $null = $reader.ReadUInt16()
            $entry.localFlags = $reader.ReadUInt16()
            $entry.localMethod = $reader.ReadUInt16()
            $null = $reader.ReadUInt32()
            $entry.localCrc = $reader.ReadUInt32()
            $localCompressed = [long]$reader.ReadUInt32()
            $localUncompressed = [long]$reader.ReadUInt32()
            $localNameLength = $reader.ReadUInt16()
            $localExtraLength = $reader.ReadUInt16()
            $localNameBytes = $reader.ReadBytes($localNameLength)
            $localExtra = $reader.ReadBytes($localExtraLength)
            $entry.localNameMatches = ([Convert]::ToBase64String($localNameBytes) -ceq [Convert]::ToBase64String($entry.nameBytes))
            if ($localUncompressed -eq $script:PortableSentinel32 -or $localCompressed -eq $script:PortableSentinel32) {
                $resolved = Resolve-PortableZip64Field -Extra $localExtra -Uncompressed $localUncompressed -Compressed $localCompressed -Offset 0 -Disk 0 -Where "local header of $($entry.name)"
                $localUncompressed = $resolved.uncompressed
                $localCompressed = $resolved.compressed
                $entry.localZip64 = $true
            }
            $entry.localCompressedSize = $localCompressed
            $entry.localUncompressedSize = $localUncompressed
            $entry.dataOffset = $stream.Position
            $end = $entry.dataOffset + $entry.compressedSize
            if ($end -gt $directoryOffset) { throw "data of $($entry.name) runs past the central directory" }
            if (($entry.localFlags -band 0x8) -ne 0) {
                # APPNOTE 4.3.9: CRC and sizes follow the data, with an optional
                # signature; 8-byte sizes when the local header used ZIP64.
                $stream.Position = $end
                $wide = $entry.localZip64
                $descriptorLength = if ($wide) { 20 } else { 12 }
                $signed = ($end + 4 -le $directoryOffset) -and ($reader.ReadUInt32() -eq [uint32]0x08074B50)
                if ($signed) { $descriptorLength += 4 } else { $stream.Position = $end }
                if ($end + $descriptorLength -gt $directoryOffset) { throw "data descriptor of $($entry.name) runs past the central directory" }
                $descriptorCrc = $reader.ReadUInt32()
                if ($wide) {
                    $descriptorCompressed = [long]$reader.ReadUInt64()
                    $descriptorUncompressed = [long]$reader.ReadUInt64()
                } else {
                    $descriptorCompressed = [long]$reader.ReadUInt32()
                    $descriptorUncompressed = [long]$reader.ReadUInt32()
                }
                $entry.descriptor = [pscustomobject]@{ crc = $descriptorCrc; compressed = $descriptorCompressed; uncompressed = $descriptorUncompressed }
                $end += $descriptorLength
            }
            $entry.entryEnd = $end
        }
        return [pscustomobject]@{
            path            = $Path
            length          = $length
            zip64           = $zip64
            entryCount      = $entriesTotal
            directoryOffset = $directoryOffset
            entries         = $entries
        }
    } finally {
        $stream.Dispose()
    }
}

# Every way the finished archive can disagree with the manifest or with itself,
# as a list of reasons; an empty list is the only pass. $Expected: objects with
# `name` (canonical) and `sha256` (hex).
function Test-PortableArchive {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Expected
    )
    $problems = [Collections.Generic.List[string]]::new()
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @("portable archive missing: $Path") }
    try {
        $directory = Read-PortableArchiveDirectory -Path $Path
    } catch {
        return @("portable archive structure: $($_.Exception.Message)")
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $folded = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $directory.entries) {
        $name = $entry.name
        if ($entry.undecodable) { $problems.Add("entry $($entry.index): name flagged UTF-8 is not valid UTF-8"); continue }
        if ($entry.nonAsciiWithoutFlag) { $problems.Add("entry $($entry.index): non-ASCII name stored without the UTF-8 flag: $name") }
        if (-not $entry.localNameMatches) { $problems.Add("local header name differs from the central directory: $name") }
        if ($entry.localFlags -ne $entry.flags) { $problems.Add("local header flags differ from the central directory: $name") }
        if ($entry.localMethod -ne $entry.method) { $problems.Add("local header compression method differs from the central directory: $name") }
        if ($entry.method -ne 0 -and $entry.method -ne 8) { $problems.Add("unsupported compression method $($entry.method): $name") }
        if ($null -ne $entry.descriptor) {
            if ($entry.localCrc -ne 0 -or $entry.localCompressedSize -ne 0 -or $entry.localUncompressedSize -ne 0) {
                $problems.Add("local header carries sizes despite its data-descriptor flag: $name")
            }
            if ($entry.descriptor.crc -ne $entry.crc -or $entry.descriptor.compressed -ne $entry.compressedSize -or $entry.descriptor.uncompressed -ne $entry.uncompressedSize) {
                $problems.Add("data descriptor differs from the central directory: $name")
            }
        } else {
            if ($entry.localCrc -ne $entry.crc) { $problems.Add("local header CRC differs from the central directory: $name") }
            if ($entry.localCompressedSize -ne $entry.compressedSize -or $entry.localUncompressedSize -ne $entry.uncompressedSize) {
                $problems.Add("local header sizes differ from the central directory: $name")
            }
        }
        if ($name.Contains('\')) { $problems.Add("backslash separator in entry name: $name") }
        if ($name.EndsWith('/')) {
            $problems.Add("directory entry: $name")
        } else {
            try {
                if ((ConvertTo-PortableEntryName $name) -cne $name) { $problems.Add("non-canonical entry name: $name") }
            } catch {
                $problems.Add("unsafe entry name: $name")
            }
        }
        if (-not $seen.Add($name)) {
            $problems.Add("duplicate entry: $name")
        } elseif (-not $folded.Add($name)) {
            $problems.Add("entries differ only by case: $name")
        }
    }
    # Entries tile the file from its first byte to the central directory: a
    # declared compressed size that leaves a gap or an overlap is wrong.
    $cursor = [long]0
    foreach ($entry in ($directory.entries | Sort-Object -Property localOffset, index)) {
        if ($entry.localOffset -ne $cursor) { $problems.Add("declared compressed size disagrees with the data layout before: $($entry.name)") }
        $cursor = $entry.entryEnd
    }
    if ($cursor -ne $directory.directoryOffset) { $problems.Add('declared compressed sizes do not reach the central directory') }

    $expectedNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($e in $Expected) { [void]$expectedNames.Add([string]$e.name) }
    foreach ($e in $Expected) {
        if (-not $seen.Contains([string]$e.name)) { $problems.Add("in the installer manifest but not in the archive: $($e.name)") }
    }
    foreach ($name in $seen) {
        if (-not $expectedNames.Contains($name)) { $problems.Add("in the archive but not in the installer manifest: $name") }
    }
    $declared = @{}
    foreach ($entry in $directory.entries) { $declared[$entry.name] = $entry }
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        if ($archive.Entries.Count -ne $directory.entryCount) {
            $problems.Add("the framework reader lists $($archive.Entries.Count) entries, the central directory $($directory.entryCount)")
        }
        foreach ($e in $Expected) {
            $name = [string]$e.name
            if (-not $seen.Contains($name)) { continue }
            $zipEntry = $archive.GetEntry($name)
            if ($null -eq $zipEntry) { $problems.Add("entry unreadable through the framework reader: $name"); continue }
            try {
                $content = $zipEntry.Open()
                try { $digest = Get-PortableStreamDigest $content } finally { $content.Dispose() }
                if ($digest.sha256 -ine [string]$e.sha256) { $problems.Add("archive bytes differ from installer payload source: $name") }
                $entry = $declared[$name]
                if ($digest.crc32 -ne [long]$entry.crc) { $problems.Add("decoded bytes do not match the declared CRC-32: $name") }
                if ($digest.length -ne $entry.uncompressedSize) { $problems.Add("decoded length does not match the declared size: $name") }
            } catch {
                $problems.Add("archive entry cannot be decompressed: $name ($($_.Exception.Message))")
            }
        }
    } finally {
        $archive.Dispose()
    }
    return $problems.ToArray()
}

# Writes $Entries (`name` canonical, `source` file, `sha256` of that file) to
# $Path. The archive is written under a name only this invocation owns,
# verified in full, and only then moved over $Path in one step: a file at
# $Path is always a verified archive, an earlier one survives a refused
# replacement, and no other invocation's partial file is ever touched.
function Write-PortableArchive {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Entries
    )
    $Path = [IO.Path]::GetFullPath($Path)
    if ($Entries.Count -lt 1) { throw 'portable archive would carry no entries' }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $folded = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($e in $Entries) {
        $name = [string]$e.name
        if ((ConvertTo-PortableEntryName $name) -cne $name) { throw "portable entry name is not canonical: $name" }
        if (-not $names.Add($name)) { throw "duplicate portable entry: $name" }
        if (-not $folded.Add($name)) { throw "portable entries differ only by case: $name" }
        if (-not (Test-Path -LiteralPath ([string]$e.source) -PathType Leaf)) { throw "portable entry source missing: $name <- $($e.source)" }
        if ([string]$e.sha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw "portable entry carries no SHA-256: $name" }
    }
    if (Test-Path -LiteralPath $Path -PathType Container) { throw "portable archive path is a directory: $Path" }
    $partial = "$Path.$([guid]::NewGuid().ToString('N')).partial"
    try {
        $stream = [IO.File]::Open($partial, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
            try {
                foreach ($e in $Entries) {
                    $entry = $archive.CreateEntry([string]$e.name, [IO.Compression.CompressionLevel]::Optimal)
                    $lastWrite = (Get-Item -LiteralPath ([string]$e.source) -Force).LastWriteTime
                    if ($lastWrite.Year -ge 1980 -and $lastWrite.Year -le 2107) { $entry.LastWriteTime = $lastWrite }
                    $input = [IO.File]::Open([string]$e.source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
                    try {
                        $output = $entry.Open()
                        try { $input.CopyTo($output) } finally { $output.Dispose() }
                    } finally {
                        $input.Dispose()
                    }
                }
            } finally {
                $archive.Dispose()
            }
        } finally {
            $stream.Dispose()
        }
        $problems = @(Test-PortableArchive -Path $partial -Expected $Entries)
        if ($problems.Count -gt 0) {
            throw ("portable archive refused before it was named:`n  " + ($problems -join "`n  "))
        }
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [IO.File]::Replace($partial, $Path, [NullString]::Value)
        } else {
            [IO.File]::Move($partial, $Path)
        }
    } catch {
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
        throw
    }
    return $Path
}

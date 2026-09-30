; Spectra PDF NSIS custom hooks for Tauri bundler
; - Explorer context menu entries for PDF files
; - Silent install: disable auto-update (enterprise MECM/Intune deployments)
; - Unattended install: require explicit acceptance of the Adobe profile EULA
; - /? switch dialog

!include "FileFunc.nsh"

; ── Install-directory key adoption ──────────────────────────────────────
; The template stores the install directory under Software\<publisher>\<product>
; and reads it back to pick the upgrade target and to pass `_?=<dir>` to the
; previous uninstaller. Builds without a configured publisher used the
; identifier segment `spectrapdf`. When that key is the only one present, an
; upgrade reads an empty directory: the previous uninstaller receives `_?=`
; with no path, and a /D= location is lost, which leaves a second copy on disk.
; SPECTRA_PRODUCT_KEY must equal Software\<bundle.publisher>\<productName>.
!define SPECTRA_PRODUCT_KEY "Software\Jason Ulbright\Spectra PDF"
!define SPECTRA_LEGACY_MANU_KEY "Software\spectrapdf"
!define SPECTRA_LEGACY_PRODUCT_KEY "${SPECTRA_LEGACY_MANU_KEY}\Spectra PDF"

!macro SPECTRA_ADOPT_LEGACY_INSTALL_DIR
  ReadRegStr $R8 SHCTX "${SPECTRA_PRODUCT_KEY}" ""
  ${If} $R8 == ""
    ReadRegStr $R8 SHCTX "${SPECTRA_LEGACY_PRODUCT_KEY}" ""
    ${If} $R8 != ""
      WriteRegStr SHCTX "${SPECTRA_PRODUCT_KEY}" "" $R8
      ; An explicit /D= outranks the recorded location.
      ${If} $INSTDIR == "$PROGRAMFILES64\Spectra PDF"
        StrCpy $INSTDIR $R8
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; The legacy key is removed only after a completed install; a cancelled
; upgrade leaves the previous installation's own record intact.
!macro SPECTRA_DROP_LEGACY_INSTALL_DIR
  DeleteRegKey SHCTX "${SPECTRA_LEGACY_PRODUCT_KEY}"
  DeleteRegKey /ifempty SHCTX "${SPECTRA_LEGACY_MANU_KEY}"
!macroend

; ── /? switch dialog ─────────────────────────────────────────────────────
; Show installer switches in a MessageBox when /? is passed.
; MUI_CUSTOMFUNCTION_GUIINIT tells MUI to call our function from its
; .onGUIInit — fires after .onInit, before any wizard pages are shown.
; The wizard window is visible behind the dialog. Quit closes both.

!define MUI_CUSTOMFUNCTION_GUIINIT SpectraPdfGuiInit

Function SpectraPdfGuiInit
  ${GetParameters} $0
  ${GetOptions} $0 "/?" $1
  IfErrors _noHelp
    MessageBox MB_OK|MB_ICONINFORMATION \
      "Spectra PDF Installer$\r$\n\
      $\r$\n\
      SWITCHES:$\r$\n\
      $\r$\n\
      /S$\tSilent install (no UI, no prompts)$\r$\n\
      /D=path$\tSet install directory$\r$\n\
      $\t(default: C:\Program Files\Spectra PDF)$\r$\n\
      /P$\tPassive mode (progress bar only, no prompts)$\r$\n\
      /acceptEULA$\tAccept the bundled Adobe color-profile EULA$\r$\n\
      $\t(required with /S or /P)$\r$\n\
      /?$\tShow this dialog$\r$\n\
      $\r$\n\
      SILENT INSTALL:$\r$\n\
      $\r$\n\
      $\"Spectra PDF_X.Y.Z_x64-setup.exe$\" /S /acceptEULA$\r$\n\
      $\"Spectra PDF_X.Y.Z_x64-setup.exe$\" /S /acceptEULA /D=C:\Apps\SpectraPDF$\r$\n\
      $\r$\n\
      Auto-update is disabled automatically during$\r$\n\
      silent install (HKLM\SOFTWARE\Spectra PDF).$\r$\n\
      Ghostscript is never downloaded or installed by /S or /P.$\r$\n\
      $\r$\n\
      SILENT UNINSTALL:$\r$\n\
      $\r$\n\
      $\"uninstall.exe$\" /S$\r$\n\
      $\t(keeps user data for redeployment)$\r$\n\
      $\"uninstall.exe$\" /S /removeuserdata$\r$\n\
      $\t(removes all user data)$\r$\n\
      $\r$\n\
      Press Ctrl+C to copy this text."
    Quit
  _noHelp:
  ; Runs after .onInit set the shell context and before the reinstall page
  ; reads the install-directory key.
  !insertmacro SPECTRA_ADOPT_LEGACY_INSTALL_DIR
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; /S shows no GUI, so the GUI-init adoption never ran.
  ${If} ${Silent}
    !insertmacro SPECTRA_ADOPT_LEGACY_INSTALL_DIR
    SetOutPath $INSTDIR
  ${EndIf}

  ; The interactive wizard's license page obtains acceptance before reaching
  ; this section. /S and /P skip that page, so unattended deployment must make
  ; the acceptance explicit. Refuse before the application or its ICC profiles
  ; are copied; exit code 2 makes a missing switch visible to deployment tools.
  StrCpy $0 0
  ${If} ${Silent}
    StrCpy $0 1
  ${ElseIf} $PassiveMode == 1
    StrCpy $0 1
  ${EndIf}

  ${If} $0 == 1
    ${GetParameters} $1
    ClearErrors
    ${GetOptions} $1 "/acceptEULA" $2
    ${If} ${Errors}
      DetailPrint "Unattended installation requires /acceptEULA."
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

; The install record is written whole under a staging name, flushed, and
; renamed over the record in one step. A record torn by an interrupted install
; still marks the copy as installed while it carries no acceptance, and the
; application offers no way to record one in that state.
!macro SPECTRA_WRITE_INSTALL_RECORD
  Delete "$INSTDIR\install-record.json.tmp"
  ClearErrors
  FileOpen $0 "$INSTDIR\install-record.json.tmp" w
  ${IfNot} ${Errors}
    FileWrite $0 '{$\r$\n'
    FileWrite $0 '  "installed": true,$\r$\n'
    FileWrite $0 '  "adobeIccEulaAccepted": true$\r$\n'
    FileWrite $0 '}$\r$\n'
    System::Call 'kernel32::FlushFileBuffers(p r0)'
    FileClose $0
    ; 9 = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
    System::Call 'kernel32::MoveFileExW(w "$INSTDIR\install-record.json.tmp", w "$INSTDIR\install-record.json", i 9) i .r1'
    ${If} $1 == 0
      Delete "$INSTDIR\install-record.json.tmp"
    ${EndIf}
  ${EndIf}
!macroend

; ── Installed Ghostscript detection ─────────────────────────────────────
; The same floor as the app's discovery (src-tauri/src/gs.rs MINIMUM_VERSION):
; 10.0 or newer. The installer never runs Ghostscript to learn its version;
; it reads version-named registry subkeys and the version resource of a
; gswin64c.exe or gswin32c.exe on PATH. A version subkey counts only while its
; GS_DLL file exists, because an uninstall can leave the key behind.
; NSIS converts "10.07.1" to 10 on IntOp, which is the major version.
!macro SPECTRA_GS_SCAN_KEY ROOT SUBKEY
  ${If} $R0 != 1
    StrCpy $R1 0
    ${Do}
      ClearErrors
      EnumRegKey $R2 ${ROOT} "${SUBKEY}" $R1
      ${IfThen} ${Errors} ${|} ${ExitDo} ${|}
      ${IfThen} $R2 == "" ${|} ${ExitDo} ${|}
      IntOp $R3 $R2 + 0
      ${If} $R3 >= 10
        ReadRegStr $R3 ${ROOT} "${SUBKEY}\$R2" "GS_DLL"
        ${If} $R3 != ""
        ${AndIf} ${FileExists} "$R3"
          StrCpy $R0 1
          ${ExitDo}
        ${EndIf}
      ${EndIf}
      IntOp $R1 $R1 + 1
    ${Loop}
  ${EndIf}
!macroend

!macro SPECTRA_GS_SCAN_PATH EXE
  ${If} $R0 != 1
    ClearErrors
    SearchPath $R2 "${EXE}"
    ${IfNot} ${Errors}
      ClearErrors
      GetDLLVersion "$R2" $R3 $R1
      ${IfNot} ${Errors}
        IntOp $R3 $R3 >> 16
        IntOp $R3 $R3 & 0xFFFF
        ${If} $R3 >= 10
          StrCpy $R0 1
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; Pushes 1 when Ghostscript 10.0 or newer is installed, else 0.
Function SpectraGhostscriptInstalled
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  StrCpy $R0 0
  !insertmacro SPECTRA_GS_SCAN_KEY HKLM64 "SOFTWARE\GPL Ghostscript"
  !insertmacro SPECTRA_GS_SCAN_KEY HKLM32 "SOFTWARE\GPL Ghostscript"
  !insertmacro SPECTRA_GS_SCAN_KEY HKLM64 "SOFTWARE\Artifex\GPL Ghostscript"
  !insertmacro SPECTRA_GS_SCAN_KEY HKLM32 "SOFTWARE\Artifex\GPL Ghostscript"
  !insertmacro SPECTRA_GS_SCAN_KEY HKCU64 "SOFTWARE\GPL Ghostscript"
  !insertmacro SPECTRA_GS_SCAN_KEY HKCU32 "SOFTWARE\GPL Ghostscript"
  !insertmacro SPECTRA_GS_SCAN_KEY HKCU64 "SOFTWARE\Artifex\GPL Ghostscript"
  !insertmacro SPECTRA_GS_SCAN_KEY HKCU32 "SOFTWARE\Artifex\GPL Ghostscript"
  !insertmacro SPECTRA_GS_SCAN_PATH "gswin64c.exe"
  !insertmacro SPECTRA_GS_SCAN_PATH "gswin32c.exe"
  StrCpy $R1 $R0
  Pop $R3
  Pop $R2
  Exch $R1
  Exch
  Pop $R0
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SPECTRA_DROP_LEGACY_INSTALL_DIR

  ; The install record. Its PRESENCE is how the application knows it was
  ; installed rather than unzipped -- the portable zip carries the same payload
  ; tree and cannot acquire this file, so the two containers are told apart
  ; structurally instead of by inspecting the install path (a zip extracted to
  ; Program Files and an installer redirected by /D= would both fool a path
  ; test, in opposite directions).
  ;
  ; It also carries the Adobe colour-profile EULA acceptance this installer has
  ; already obtained: interactively through the wizard's licence page, and
  ; unattended through /acceptEULA, which PREINSTALL above refuses to install
  ; without. So an installed application never presents the in-app licence
  ; dialog; the portable container, which has no record, presents it on first
  ; run and writes its own.
  !insertmacro SPECTRA_WRITE_INSTALL_RECORD

  ; Context menu: "Open with Spectra PDF"
  WriteRegStr HKCR "SystemFileAssociations\.pdf\shell\SpectraPDF.Open" "" "Open with Spectra PDF"
  WriteRegStr HKCR "SystemFileAssociations\.pdf\shell\SpectraPDF.Open" "Icon" "$INSTDIR\spectrapdf.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.pdf\shell\SpectraPDF.Open\command" "" '"$INSTDIR\spectrapdf.exe" "%1"'

  ; Context menu: "Merge with Spectra PDF"
  WriteRegStr HKCR "SystemFileAssociations\.pdf\shell\SpectraPDF.Merge" "" "Merge with Spectra PDF"
  WriteRegStr HKCR "SystemFileAssociations\.pdf\shell\SpectraPDF.Merge" "Icon" "$INSTDIR\spectrapdf.exe,0"
  WriteRegStr HKCR "SystemFileAssociations\.pdf\shell\SpectraPDF.Merge\command" "" '"$INSTDIR\spectrapdf.exe" "--merge" "%1"'

  ; Silent install (MECM/Intune/PDQ): disable auto-update so IT controls the update cycle
  IfSilent 0 +2
    WriteRegDWORD HKLM "SOFTWARE\Spectra PDF" "DisableAutoUpdate" 1

  ; Refresh shell icon cache
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, p 0, p 0)'

  ; Ghostscript is a separately licensed, user-installed prerequisite. Normal
  ; interactive installs may offer its official download page, where the user
  ; chooses a licence and runs Artifex's own installer, unless Ghostscript 10.0
  ; or newer is already installed. /S and /P remain fully unattended and never
  ; download, launch, or install Ghostscript.
  ${IfNot} ${Silent}
  ${AndIf} $PassiveMode != 1
    Call SpectraGhostscriptInstalled
    Pop $R9
    ${If} $R9 != 1
      MessageBox MB_YESNO|MB_ICONINFORMATION \
        "Ghostscript 10.0 or newer is optional and is not included with Spectra PDF.$\r$\n\
        $\r$\n\
        It enables scan/OCR rendering, visual comparison, printing, PostScript conversion, PDF/A and PDF/X conversion, CMYK conversion, compression, grayscale, MRC, repair tier 2, raster print-production tools, and page-image or slide rendering.$\r$\n\
        $\r$\n\
        Open the official Ghostscript download page now?$\r$\n\
        $\r$\n\
        Ghostscript is licensed separately by Artifex under the GNU AGPL or commercial terms." \
        IDNO _skipOptionalGhostscript
      ExecShell "open" "https://ghostscript.com/releases/gsdnld.html"
      _skipOptionalGhostscript:
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove context menu entries
  DeleteRegKey HKCR "SystemFileAssociations\.pdf\shell\SpectraPDF.Open"
  DeleteRegKey HKCR "SystemFileAssociations\.pdf\shell\SpectraPDF.Merge"

  ; Remove app registry key (includes DisableAutoUpdate)
  DeleteRegKey HKLM "SOFTWARE\Spectra PDF"

  ; The install record. Removed with the rest of the payload so a leftover
  ; file cannot make a later portable copy in the same folder believe it was
  ; installed -- and believe its colour-profile licence was accepted.
  Delete "$INSTDIR\install-record.json"
  Delete "$INSTDIR\install-record.json.tmp"

  ; Silent uninstall with /removeuserdata: set the checkbox state variable
  ; so Tauri's built-in post-uninstall logic handles the actual deletion.
  ; (Tauri template checks $DeleteAppDataCheckboxState and runs RMDir /r
  ; on both AppData dirs — we just need to flip the flag for silent mode.)
  IfSilent 0 _skipSilentCheck
    ${GetParameters} $0
    ${GetOptions} $0 "/removeuserdata" $1
    IfErrors +2 0
      StrCpy $DeleteAppDataCheckboxState 1
  _skipSilentCheck:

  ; Refresh shell icon cache
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, p 0, p 0)'
!macroend

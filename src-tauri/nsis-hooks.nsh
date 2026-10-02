; Spectra PDF NSIS custom hooks for Tauri bundler
; - Explorer context menu entries for PDF files, and the File Explorer commands
;   (Convert to PDF, Combine into one PDF) registered through spectrapdf.exe
; - Machine policy values survive an upgrade
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
!define SPECTRA_PUBLISHER_KEY "Software\Jason Ulbright"
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

; ── Machine policy ──────────────────────────────────────────────────────
; The application is 64-bit and reads HKLM\SOFTWARE\Spectra PDF through the
; 64-bit registry view. This installer is a 32-bit process, whose HKLM\SOFTWARE
; writes land in WOW6432Node unless the view is set, so every policy read and
; write here runs under SetRegView 64. Each such block ends with SetRegView
; lastused, never `default`: `default` is the 32-bit view, and after these
; hooks the template reads and writes its uninstall and install-directory
; keys in the view its SetContext chose.
;
; The reinstall page can run the previous uninstaller (see Version
; replacement). An uninstaller that predates the replacement signal deletes
; the policy key, so the values are read before that uninstaller runs and
; written back after the install when they are gone.
!define SPECTRA_POLICY_KEY "SOFTWARE\Spectra PDF"
Var SpectraPolicyAutoUpdate
Var SpectraPolicyFieldScripts
Var SpectraPolicyExplorerMenu

!macro SPECTRA_CAPTURE_POLICY NAME VAR
  ClearErrors
  ReadRegDWORD ${VAR} HKLM "${SPECTRA_POLICY_KEY}" "${NAME}"
  ${If} ${Errors}
    StrCpy ${VAR} ""
  ${EndIf}
!macroend

!macro SPECTRA_RESTORE_POLICY NAME VAR
  ${If} ${VAR} != ""
    ClearErrors
    ReadRegDWORD $R9 HKLM "${SPECTRA_POLICY_KEY}" "${NAME}"
    ${If} ${Errors}
      WriteRegDWORD HKLM "${SPECTRA_POLICY_KEY}" "${NAME}" ${VAR}
    ${EndIf}
  ${EndIf}
!macroend

; ── Running application ─────────────────────────────────────────────────
; The template's own running-app check comes after the hooks, and a cancel
; there would leave the File Explorer commands removed or their handler moved
; aside under an application that stays installed. This check runs first, with
; the template's messages and plugin, so a cancel aborts before anything is
; changed, and the template's check then finds nothing running. ID keeps the
; labels unique per insertion; EXE is the process image name.
!macro SPECTRA_REQUIRE_APP_CLOSED ID EXE
  nsis_tauri_utils::FindProcess "${EXE}"
  Pop $R0
  ${If} $R0 = 0
    nsis_tauri_utils::StrReplace "$(appRunning)" "{{product_name}}" "Spectra PDF"
    Pop $R1
    nsis_tauri_utils::StrReplace "$(appRunningOkKill)" "{{product_name}}" "Spectra PDF"
    Pop $R2
    nsis_tauri_utils::StrReplace "$(failedToKillApp)" "{{product_name}}" "Spectra PDF"
    Pop $R3
    IfSilent spectra_kill_${ID} 0
    ${IfThen} $PassiveMode != 1 ${|} MessageBox MB_OKCANCEL $R2 IDOK spectra_kill_${ID} IDCANCEL spectra_cancel_${ID} ${|}
    spectra_kill_${ID}:
      nsis_tauri_utils::KillProcess "${EXE}"
      Pop $R0
      Sleep 500
      ${If} $R0 = 0
      ${OrIf} $R0 = 2
        Goto spectra_closed_${ID}
      ${EndIf}
      Abort $R3
    spectra_cancel_${ID}:
      Abort $R1
  ${EndIf}
  spectra_closed_${ID}:
!macroend

; ── File Explorer command handler ───────────────────────────────────────
; Explorer (classic verbs) or dllhost.exe (the app package) can hold the
; handler DLL loaded. A loaded image can be renamed but not replaced, so the
; old file moves aside under a unique name and is deleted now or, while still
; loaded, at the next restart.
!macro SPECTRA_RETIRE_SHELL_DLL ARCH
  ${If} ${FileExists} "$INSTDIR\shell\${ARCH}\spectrapdf_shell.dll"
    System::Call 'ole32::CoCreateGuid(g .R7)'
    ClearErrors
    Rename "$INSTDIR\shell\${ARCH}\spectrapdf_shell.dll" "$INSTDIR\shell\${ARCH}\spectrapdf_shell.$R7.old"
    ${IfNot} ${Errors}
      Delete /REBOOTOK "$INSTDIR\shell\${ARCH}\spectrapdf_shell.$R7.old"
    ${EndIf}
  ${EndIf}
!macroend

; ── Virtual printer ─────────────────────────────────────────────────────
; retire-legacy: a queue on the loopback TCP port of earlier releases sends
; every job to whichever local account binds that port, and no current build
; listens there. remove-all: every account's printer and port. A failure is
; reported and never fails the run.
!macro SPECTRA_VIRTUAL_PRINTER ACTION
  ClearErrors
  ExecWait '"$INSTDIR\spectrapdf.exe" virtual-printer ${ACTION}' $R9
  ${If} ${Errors}
    DetailPrint "Virtual printer: spectrapdf.exe could not be started."
  ${ElseIf} $R9 != 0
    DetailPrint "Virtual printer: ${ACTION} failed (exit $R9)."
  ${EndIf}
!macroend

; remove-all deletes the printer's marker key, which lives in the 32-bit view
; under the product key's path. Those 32-bit parents go only when they hold
; nothing else; the installer's own keys are in the 64-bit view.
!macro SPECTRA_DROP_EMPTY_MARKER_PARENTS
  SetRegView 32
  DeleteRegKey /ifnosubkeys /ifnovalues HKLM "${SPECTRA_PRODUCT_KEY}"
  DeleteRegKey /ifnosubkeys /ifnovalues HKLM "${SPECTRA_PUBLISHER_KEY}"
  SetRegView lastused
!macroend

; ── Version replacement ─────────────────────────────────────────────────
; The template's reinstall page runs the previous uninstaller as
; `"<UninstallString>" [/P] _?=<dir>` and never with /UPDATE, so $UpdateMode
; cannot tell an install from a real uninstall. That page runs it in three
; cases: an interactive upgrade or downgrade ("Uninstall before installing"),
; a passive install of the same version (a passive run reads no radio button,
; which selects the same-version uninstall branch), and the maintenance
; page's Uninstall choice for the same version. Only the last is a real
; uninstall. A passive upgrade or downgrade, the same version's
; "Add/Reinstall" choice and a silent install run no uninstaller.
;
; The installer sets SPECTRA_INSTALLER_ENV to "installer <its version>" before
; any page can run that uninstaller, and the uninstaller inherits it from the
; installer process that starts it. The value is never a bare version. The
; uninstaller runs a real uninstall when the variable is absent (Apps,
; Control Panel, a script) or is exactly "installer <its own version>"
; without /P (the maintenance page); every other value is a replacement, so a
; later installer can always ask for one. The uninstaller of every installed
; release reads this name and value format, so they never change. The hooks
; are included before the template defines VERSION, so the installer reads
; its own version from its version resource (VIProductVersion).
!define SPECTRA_INSTALLER_ENV "SPECTRA_PDF_INSTALLER"
Var SpectraReplacing

!macro SPECTRA_MARK_REPLACEMENT
  ClearErrors
  GetDLLVersion "$EXEPATH" $R2 $R3
  ${If} ${Errors}
    StrCpy $R4 "unknown"
  ${Else}
    IntOp $R4 $R2 >> 16
    IntOp $R4 $R4 & 0xFFFF
    IntOp $R2 $R2 & 0xFFFF
    IntOp $R3 $R3 >> 16
    IntOp $R3 $R3 & 0xFFFF
    StrCpy $R4 "$R4.$R2.$R3"
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariable(t "${SPECTRA_INSTALLER_ENV}", t "installer $R4")'
!macroend

; Sets $SpectraReplacing to 1 when an installer replaces this copy, else 0.
; Inserted where VERSION names this uninstaller's own version and
; $PassiveMode holds its /P switch.
!macro SPECTRA_READ_REPLACEMENT
  StrCpy $SpectraReplacing 0
  ${If} $UpdateMode = 1
    StrCpy $SpectraReplacing 1
  ${EndIf}
  ClearErrors
  ReadEnvStr $R9 "${SPECTRA_INSTALLER_ENV}"
  ${IfNot} ${Errors}
  ${AndIf} $R9 != ""
    ${If} $R9 != "installer ${VERSION}"
    ${OrIf} $PassiveMode = 1
      StrCpy $SpectraReplacing 1
    ${EndIf}
  ${EndIf}
  ${If} $SpectraReplacing = 1
    DetailPrint "An installer replaces this copy: printers, held jobs, File Explorer commands and machine policy are kept."
  ${EndIf}
!macroend

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

  ; Before the reinstall page can run the previous uninstaller.
  !insertmacro SPECTRA_MARK_REPLACEMENT
  SetRegView 64
  !insertmacro SPECTRA_CAPTURE_POLICY "DisableAutoUpdate" $SpectraPolicyAutoUpdate
  !insertmacro SPECTRA_CAPTURE_POLICY "DisableFieldScripts" $SpectraPolicyFieldScripts
  !insertmacro SPECTRA_CAPTURE_POLICY "DisableExplorerMenu" $SpectraPolicyExplorerMenu
  SetRegView lastused
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

  !insertmacro SPECTRA_REQUIRE_APP_CLOSED "install" "spectrapdf.exe"
  !insertmacro SPECTRA_RETIRE_SHELL_DLL "x64"
  !insertmacro SPECTRA_RETIRE_SHELL_DLL "arm64"
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

  ; The per-file "Merge with Spectra PDF" verb of earlier versions started one
  ; process per selected file. Combine into one PDF replaces it.
  DeleteRegKey HKCR "SystemFileAssociations\.pdf\shell\SpectraPDF.Merge"

  ; The File Explorer commands for every user (elevated: the app package is
  ; staged and provisioned, or the classic verbs are written to HKLM), then
  ; for the installing user at once; provisioning reaches every other user at
  ; their next sign-in. A failure is reported and never fails the install.
  ClearErrors
  ExecWait '"$INSTDIR\spectrapdf.exe" shell-menu install-machine' $R9
  ${If} ${Errors}
    DetailPrint "File Explorer commands: spectrapdf.exe could not be started."
  ${ElseIf} $R9 == 3
    DetailPrint "File Explorer commands: the app package was refused; classic menu entries were registered."
  ${ElseIf} $R9 != 0
    DetailPrint "File Explorer commands: registration failed (exit $R9)."
  ${EndIf}
  ${IfNot} ${Silent}
    nsis_tauri_utils::RunAsUser "$INSTDIR\spectrapdf.exe" "shell-menu register-user"
  ${EndIf}

  ; Every install, updates included: an update is what moves a machine off
  ; the loopback queue.
  !insertmacro SPECTRA_VIRTUAL_PRINTER "retire-legacy"

  SetRegView 64
  ; Silent install (MECM/Intune/PDQ): disable auto-update so IT controls the update cycle
  ${If} ${Silent}
    WriteRegDWORD HKLM "${SPECTRA_POLICY_KEY}" "DisableAutoUpdate" 1
  ${EndIf}
  !insertmacro SPECTRA_RESTORE_POLICY "DisableAutoUpdate" $SpectraPolicyAutoUpdate
  !insertmacro SPECTRA_RESTORE_POLICY "DisableFieldScripts" $SpectraPolicyFieldScripts
  !insertmacro SPECTRA_RESTORE_POLICY "DisableExplorerMenu" $SpectraPolicyExplorerMenu
  SetRegView lastused

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
  !insertmacro SPECTRA_REQUIRE_APP_CLOSED "uninstall" "spectrapdf.exe"

  ; Remove context menu entries
  DeleteRegKey HKCR "SystemFileAssociations\.pdf\shell\SpectraPDF.Open"
  DeleteRegKey HKCR "SystemFileAssociations\.pdf\shell\SpectraPDF.Merge"

  ; A replacement (see Version replacement): an installer puts its copy in
  ; place of this one and keeps every account's printer and held jobs, the
  ; File Explorer commands and the machine policy. A real uninstall removes the
  ; printers and the commands for every user, moves the handler DLLs aside so
  ; the plain resource deletion that follows cannot leave a loaded one behind,
  ; and removes the policy key from both registry views (older silent installs
  ; wrote it to WOW6432Node).
  !insertmacro SPECTRA_READ_REPLACEMENT
  ${If} $SpectraReplacing <> 1
    ExecWait '"$INSTDIR\spectrapdf.exe" shell-menu uninstall-machine' $R9
    !insertmacro SPECTRA_VIRTUAL_PRINTER "remove-all"
    !insertmacro SPECTRA_DROP_EMPTY_MARKER_PARENTS
    !insertmacro SPECTRA_RETIRE_SHELL_DLL "x64"
    !insertmacro SPECTRA_RETIRE_SHELL_DLL "arm64"
    SetRegView 64
    DeleteRegKey HKLM "${SPECTRA_POLICY_KEY}"
    SetRegView lastused
    SetRegView 32
    DeleteRegKey HKLM "${SPECTRA_POLICY_KEY}"
    SetRegView lastused
  ${EndIf}

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

; Spectra PDF NSIS custom hooks for Tauri bundler
; - Explorer context menu entries for PDF files
; - Silent install: disable auto-update (enterprise MECM/Intune deployments)
; - Unattended install: require explicit acceptance of the Adobe profile EULA
; - /? switch dialog

!include "FileFunc.nsh"

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
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
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

!macro NSIS_HOOK_POSTINSTALL
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
  ; chooses a licence and runs Artifex's own installer. /S and /P remain fully
  ; unattended and never download, launch, or install Ghostscript.
  ${IfNot} ${Silent}
    ${If} $PassiveMode != 1
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

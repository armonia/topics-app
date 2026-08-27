; Topics NSIS installer hooks (bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; WHY THIS FILE EXISTS. Tauri's stock NSIS template looks for exactly ONE running
; process before it overwrites the install directory: CheckIfAppIsRunning, in the
; bundler's own utils.nsh, finds and kills "${MAINBINARYNAME}.exe" and nothing
; else. Every sidecar declared in bundle.externalBin (topics-server, pty-bridge,
; webrtc-bridge) keeps running: pty-bridge holds the terminals' named pipe open,
; so Windows keeps its image file locked, the template's `File /a` cannot
; overwrite it, and a SILENT install skips that one file and still exits 0.
;
; Measured on a real Windows machine on 2026-08-27, updating 2.2.173 to 2.2.176
; with the app open and a terminal running: app.exe, topics-server.exe and
; webrtc-bridge.exe were replaced, pty-bridge.exe was not, and both the registry
; and app.exe reported the new version. An update that lies about having landed
; is worse than one that fails: the next release that fixes the bridge would be
; announced as delivered to the very people who did not receive it. Card
; b13aa168-cf69-4878-8d32-3bbd6a236cb7.
;
; WHAT WE DO ABOUT IT. Two moves, and the second one is the one that matters:
;   1. PREINSTALL / PREUNINSTALL close the sidecars by image name, then wait for
;      the file locks to clear, so the copy can actually happen.
;   2. POSTINSTALL re-checks every sidecar file: if one is still locked, it was
;      skipped, and the install is declared FAILED (non-zero error level, plus a
;      line in the installer log) instead of exiting 0 on a half update.
; The shell checks the same thing from the other side at startup, on the bytes
; that actually landed: see sidecar_integrity.rs.
;
; Killing is done with nsis_tauri_utils (the plugin the template itself uses, so
; it is always present and hash-pinned by the bundler) rather than taskkill: a
; missing plugin is a build error discovered only at release tag time.

!include LogicLib.nsh

; Set by the post-install check to the first sidecar that did not land.
Var TopicsSkippedSidecar

; Every file that must be replaced by an install. Keep in sync with
; bundle.externalBin in tauri.conf.json (tests/unit/nsis-sidecar-hooks.test.ts
; fails when the two lists drift).
!define TOPICS_SIDECAR_1 "topics-server.exe"
!define TOPICS_SIDECAR_2 "pty-bridge.exe"
!define TOPICS_SIDECAR_3 "webrtc-bridge.exe"

; Close one sidecar and wait, up to 5 s, for its file to become writable again.
; The wait is not paranoia: the process dies asynchronously and its image handle
; is released by the kernel a moment later, which is exactly the moment `File`
; would hit.
!macro TopicsCloseSidecar NAME
  DetailPrint "Closing sidecar ${NAME}"
  nsis_tauri_utils::KillProcessCurrentUser "${NAME}"
  Pop $0
  StrCpy $1 0
  ${Do}
    ${IfNot} ${FileExists} "$INSTDIR\${NAME}"
      ${ExitDo}
    ${EndIf}
    ClearErrors
    FileOpen $0 "$INSTDIR\${NAME}" a
    ${IfNot} ${Errors}
      FileClose $0
      ${ExitDo}
    ${EndIf}
    IntOp $1 $1 + 1
    ${If} $1 >= 20
      DetailPrint "${NAME} is still locked after 5s"
      ${ExitDo}
    ${EndIf}
    Sleep 250
  ${Loop}
!macroend

; After the copy: a sidecar that is missing, or still locked, was NOT installed.
; Record it in $TopicsSkippedSidecar and fail the installer.
!macro TopicsVerifySidecar NAME
  ${If} ${FileExists} "$INSTDIR\${NAME}"
    ClearErrors
    FileOpen $0 "$INSTDIR\${NAME}" a
    ${If} ${Errors}
      DetailPrint "INSTALL FAILED: ${NAME} is still in use, so it was NOT replaced"
      StrCpy $TopicsSkippedSidecar "${NAME}"
    ${Else}
      FileClose $0
    ${EndIf}
  ${Else}
    DetailPrint "INSTALL FAILED: ${NAME} is missing after install"
    StrCpy $TopicsSkippedSidecar "${NAME}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro TopicsCloseSidecar "${TOPICS_SIDECAR_1}"
  !insertmacro TopicsCloseSidecar "${TOPICS_SIDECAR_2}"
  !insertmacro TopicsCloseSidecar "${TOPICS_SIDECAR_3}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  StrCpy $TopicsSkippedSidecar ""
  !insertmacro TopicsVerifySidecar "${TOPICS_SIDECAR_1}"
  !insertmacro TopicsVerifySidecar "${TOPICS_SIDECAR_2}"
  !insertmacro TopicsVerifySidecar "${TOPICS_SIDECAR_3}"
  ${If} $TopicsSkippedSidecar != ""
    ; 5 is ERROR_ACCESS_DENIED, which is what actually happened.
    SetErrorLevel 5
    IfSilent +2 0
    MessageBox MB_ICONEXCLAMATION "Topics was updated, but $TopicsSkippedSidecar could not be replaced because it was still running. Quit Topics completely and run the installer again."
  ${EndIf}
!macroend

; The update path runs the OLD uninstaller before installing (installer.nsi
; appends /UPDATE to the stored UninstallString), and Delete on a locked file
; fails just as silently as File does.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro TopicsCloseSidecar "${TOPICS_SIDECAR_1}"
  !insertmacro TopicsCloseSidecar "${TOPICS_SIDECAR_2}"
  !insertmacro TopicsCloseSidecar "${TOPICS_SIDECAR_3}"
!macroend

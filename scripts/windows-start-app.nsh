; Returns TOKEN_ELEVATION_TYPE in $0 (0 if it cannot be queried).
; Group membership alone cannot distinguish elevated tokens from accounts
; with UAC disabled, which have no linked token to switch to.
Function PortalGetTokenElevationType
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $0 0
  System::Call 'kernel32::GetCurrentProcess() p.r1'
  System::Call 'advapi32::OpenProcessToken(p r1, i 0x0008, *p .r2) i.r3'
  ${If} $3 != 0
    System::Call 'advapi32::GetTokenInformation(p r2, i 18, *i .r0, i 4, *i .r4) i.r3'
    ${If} $3 == 0
      StrCpy $0 0
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r2)'
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
FunctionEnd

!macro PortalStartAppForToken ELEVATION_TYPE
  ; Default (1) has no linked token; Limited (3) is already restricted.
  ; Launch directly in both cases so custom profiles survive the handoff.
  ; Full (2), or an unknown token, keeps builder's de-elevated shell launch.
  ${If} ${ELEVATION_TYPE} == 1
  ${OrIf} ${ELEVATION_TYPE} == 3
    Exec '"$appExe"'
  ${Else}
    ${StdUtils.ExecShellAsUser} $0 "$appExe" "open" ""
  ${EndIf}
!macroend

!macroundef StartApp
!macro StartApp
  Call PortalGetTokenElevationType
  !insertmacro PortalStartAppForToken $0
!macroend

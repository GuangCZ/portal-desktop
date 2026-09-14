; Called by the standard one-click finish flow. Per-user installs can launch
; directly, preserving an explicitly configured Portal profile/environment.
; If someone started Setup elevated, keep builder's de-elevated launch.
!macroundef StartApp
!macro StartApp
  ${If} ${UAC_IsAdmin}
    ${StdUtils.ExecShellAsUser} $0 "$appExe" "open" ""
  ${Else}
    Exec '"$appExe"'
  ${EndIf}
!macroend

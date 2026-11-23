!macro NSIS_HOOK_POSTINSTALL
  ; Older installs can retain a shortcut without an AppUserModelID during updates.
  ; Give the native shortcut its own identity so the legacy Electron shortcut
  ; cannot be selected as the notification sender.
  !define ECHO_INSTALL_BUNDLEID "${BUNDLEID}"
  !undef BUNDLEID
  !define BUNDLEID "${ECHO_INSTALL_BUNDLEID}.desktop"
  !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  Pop $R0
  ${If} $R0 == 1
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  ${Else}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $R0
    ${If} $R0 == 1
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${ElseIf} $NoShortcutMode != 1
    ${AndIfNot} ${FileExists} "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
      CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}
  !undef BUNDLEID
  !define BUNDLEID "${ECHO_INSTALL_BUNDLEID}"
  !undef ECHO_INSTALL_BUNDLEID
!macroend

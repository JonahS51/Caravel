; Caravel – zusätzliche Installer-Schritte
; Registriert Caravel als Webbrowser, damit er in „Standard-Apps“ von Windows auswählbar ist.

!define CARAVEL_CAPS "Software\Clients\StartMenuInternet\Caravel\Capabilities"

!macro customInstall
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Caravel" "" "Caravel"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Caravel\DefaultIcon" "" "$INSTDIR\Caravel.exe,0"
  WriteRegStr SHCTX "Software\Clients\StartMenuInternet\Caravel\shell\open\command" "" '"$INSTDIR\Caravel.exe"'

  WriteRegStr SHCTX "${CARAVEL_CAPS}" "ApplicationName" "Caravel"
  WriteRegStr SHCTX "${CARAVEL_CAPS}" "ApplicationIcon" "$INSTDIR\Caravel.exe,0"
  ; Beschreibung in der Sprache des Installers (1031 = Deutsch, sonst Englisch)
  StrCmp $LANGUAGE 1031 0 +3
    WriteRegStr SHCTX "${CARAVEL_CAPS}" "ApplicationDescription" "Caravel – Browser mit Claude-Integration, Werbeblocker und VPN."
    Goto +2
    WriteRegStr SHCTX "${CARAVEL_CAPS}" "ApplicationDescription" "Caravel – browser with Claude integration, ad blocker and VPN."
  WriteRegStr SHCTX "${CARAVEL_CAPS}\StartMenu" "StartMenuInternet" "Caravel"
  WriteRegStr SHCTX "${CARAVEL_CAPS}\URLAssociations" "http" "CaravelURL"
  WriteRegStr SHCTX "${CARAVEL_CAPS}\URLAssociations" "https" "CaravelURL"
  WriteRegStr SHCTX "${CARAVEL_CAPS}\FileAssociations" ".html" "CaravelHTML"
  WriteRegStr SHCTX "${CARAVEL_CAPS}\FileAssociations" ".htm" "CaravelHTML"
  WriteRegStr SHCTX "${CARAVEL_CAPS}\FileAssociations" ".pdf" "CaravelHTML"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Caravel" "${CARAVEL_CAPS}"

  WriteRegStr SHCTX "Software\Classes\CaravelURL" "" "Caravel URL"
  WriteRegStr SHCTX "Software\Classes\CaravelURL" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\CaravelURL\DefaultIcon" "" "$INSTDIR\Caravel.exe,0"
  WriteRegStr SHCTX "Software\Classes\CaravelURL\shell\open\command" "" '"$INSTDIR\Caravel.exe" "%1"'

  WriteRegStr SHCTX "Software\Classes\CaravelHTML" "" "Caravel-Dokument"
  WriteRegStr SHCTX "Software\Classes\CaravelHTML\DefaultIcon" "" "$INSTDIR\Caravel.exe,0"
  WriteRegStr SHCTX "Software\Classes\CaravelHTML\shell\open\command" "" '"$INSTDIR\Caravel.exe" "%1"'

  ; Explorer über die neue Registrierung informieren
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Clients\StartMenuInternet\Caravel"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Caravel"
  DeleteRegKey SHCTX "Software\Classes\CaravelURL"
  DeleteRegKey SHCTX "Software\Classes\CaravelHTML"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

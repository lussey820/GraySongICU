; 安装器自定义逻辑
; 1) 已安装过则提示，可覆盖升级或退出
; 2) 安装时提醒基础包不含离线补歌词，可选择首次启动时自动下载
!ifndef BUILD_UNINSTALLER
Var GSI_INSTALL_ASR

!macro customInit
  StrCpy $GSI_INSTALL_ASR "0"
  IfSilent gsi_init_done
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "DisplayVersion"
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "DisplayVersion"
  ${EndIf}
  ${If} $R0 != ""
    MessageBox MB_YESNO|MB_ICONINFORMATION "您已安装过啦（当前版本 $R0）。$\r$\n$\r$\n是否覆盖安装（升级或修复）？$\r$\n选择「是」继续安装，选择「否」退出安装。" IDYES gsi_installed_continue
    Quit
    gsi_installed_continue:
  ${EndIf}
  MessageBox MB_YESNO|MB_ICONINFORMATION "基础安装包不包含「离线补歌词」功能（Whisper 语音识别，约 150MB）。$\r$\n$\r$\n是否在首次启动时自动下载并安装？$\r$\n选择「是」自动安装，选择「否」跳过（以后也能在应用里安装）。$\r$\n$\r$\n说明：本安装包未做代码签名，Windows 若提示「未知发布者」，请点「更多信息 → 仍要运行」。" IDNO gsi_init_done
  StrCpy $GSI_INSTALL_ASR "1"
  gsi_init_done:
!macroend

!macro customInstall
  ${If} $GSI_INSTALL_ASR == "1"
    FileOpen $0 "$INSTDIR\.asr-request" w
    FileWrite $0 "1"
    FileClose $0
  ${Else}
    Delete "$INSTDIR\.asr-request"
  ${EndIf}
!macroend
!endif

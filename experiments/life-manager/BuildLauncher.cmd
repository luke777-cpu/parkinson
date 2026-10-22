@echo off
cd /d "%~dp0"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /reference:System.Windows.Forms.dll /out:ParkinsonLifeManager.exe Launcher.cs
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:Microsoft.CSharp.dll /out:Setup.exe Setup.cs
copy /y Setup.exe Uninstall.exe >nul
pause

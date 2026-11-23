@echo off
rem Mobilya Studyo, Windows launcher. ASCII only, CRLF, no parenthesized blocks.
rem The real work is in scripts\start-windows.ps1 and scripts\launcher.mjs.
setlocal
set "MGS_HOME=%~dp0"
chcp 65001 >nul
cd /d "%MGS_HOME%" || goto nofolder

rem A developer checkout is never run from: no lock, no .runtime, no download.
if exist "%MGS_HOME%.git" goto gitrepo

rem Started from inside the ZIP: Windows unpacks only this file, so the rest is missing.
if not exist "%MGS_HOME%scripts\start-windows.ps1" goto notextracted

set "MGS_ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "MGS_ARCH=%PROCESSOR_ARCHITEW6432%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%MGS_HOME%scripts\start-windows.ps1"
set "MGS_RC=%ERRORLEVEL%"
if "%MGS_RC%"=="0" goto done
if "%MGS_RC%"=="3" goto done
if "%MGS_RC%"=="-1073741510" goto done
echo.
echo Mobilya Studyo acilamadi (kod %MGS_RC%). Windows PowerShell calisiyor mu kontrol edin.
echo Kapatmak icin bir tusa basin.
pause >nul
goto done

:gitrepo
set "MGS_RC=3"
echo Bu klasor bir gelistirici kopyasi - git deposu. Mobilya Studyo buradan acilmaz.
echo GitHub sayfasindan ZIP olarak indirip ayri bir klasore acin.
echo Kapatmak icin bir tusa basin.
pause >nul
goto done

:notextracted
set "MGS_RC=3"
echo Uygulama ZIP dosyasinin icinden acilmis, bu sekilde calismaz.
echo Once ZIP dosyasina sag tiklayip "Tumunu ayikla" - Extract All - secenegini secin.
echo Sonra cikan klasorde Mobilya Studyo dosyasina cift tiklayin.
echo Kapatmak icin bir tusa basin.
pause >nul
goto done

:nofolder
set "MGS_RC=1"
echo Uygulama klasorune girilemedi. Klasoru ev klasorunuze tasiyip yeniden deneyin.
echo Kapatmak icin bir tusa basin.
pause >nul

:done
endlocal & exit /b %MGS_RC%

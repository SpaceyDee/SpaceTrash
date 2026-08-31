@echo off
setlocal
set DEST=%USERPROFILE%\Desktop\SpaceTrash-Portable.exe
echo Copying SpaceTrash to your Desktop...
if exist "%~d0\SpaceTrash-Portable-0.1.0.exe" (
  copy /y "%~d0\SpaceTrash-Portable-0.1.0.exe" "%DEST%"
) else if exist "%~d0\SPACETRA.EXE" (
  copy /y "%~d0\SPACETRA.EXE" "%DEST%"
)
if exist "%DEST%" (
  echo Copied to Desktop as SpaceTrash-Portable.exe
  echo Double-click that file. Do not run it from the CD.
  explorer /select,"%DEST%"
) else (
  echo Copy failed. Copy SpaceTrash-Portable-0.1.0.exe to the Desktop by hand.
  pause
)

@echo off
rem Builds out\ksf-spatial-bridge.exe (Visual Studio 2022 Build Tools, "Desktop development with C++").
call "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if not exist out mkdir out
cl /nologo /std:c++17 /O2 /EHsc /W4 /DUNICODE /D_UNICODE src\main.cpp /Fo:out\ /Fe:out\ksf-spatial-bridge.exe /link /SUBSYSTEM:WINDOWS ws2_32.lib ole32.lib shell32.lib user32.lib advapi32.lib mmdevapi.lib uuid.lib

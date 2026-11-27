' Launches a program with no window and no console.
'
' The node's long-lived processes (server loop, card jail, update task) must run
' forever and must not leave anything on the screen of whoever uses the PC.
'
' Why a VBScript and not a powershell option:
'   - "-WindowStyle Hidden" does not stop the task from allocating a console, and
'     on a PC with Windows Terminal as the default terminal that console is a real
'     window on the desktop;
'   - "conhost --headless" removes the window but BLOCKS the process inside it.
' wscript.exe allocates no console at all, so there is no window to hide and no
' console that can hang.
'
' The first argument is the program, the others are its parameters. Arguments
' that contain spaces are re-quoted: without that, "-File C:\Program Files\..."
' would arrive split in two.
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
    a = WScript.Arguments(i)
    If InStr(a, " ") > 0 And Left(a, 1) <> """" Then a = """" & a & """"
    If i > 0 Then cmd = cmd & " "
    cmd = cmd & a
Next
' 0 = hidden window, False = do not wait for the end (the process lives on its own).
sh.Run cmd, 0, False

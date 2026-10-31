//! A pseudo-terminal for the agent panel, on the system's own calls
//! (`openpty`, `setsid`, `ioctl`), so programs like Claude Code run exactly
//! as they do in Terminal: colours, full-screen UI, Ctrl-C, resizing.
//!
//! Unix only; elsewhere [`spawn`] says the panel is available on macOS.

use std::fs::File;
use std::io;
use std::path::Path;
use std::process::Child;

/// A program running in its own terminal.
pub struct Pty {
    /// Read the program's output from it, write keystrokes to it.
    pub master: File,
    pub child: Child,
}

#[cfg(unix)]
mod sys {
    use std::os::raw::{c_char, c_int, c_ulong, c_void};

    #[repr(C)]
    pub struct Winsize {
        pub ws_row: u16,
        pub ws_col: u16,
        pub ws_xpixel: u16,
        pub ws_ypixel: u16,
    }

    #[cfg(target_os = "macos")]
    pub const TIOCSWINSZ: c_ulong = 0x8008_7467;
    #[cfg(target_os = "macos")]
    pub const TIOCSCTTY: c_ulong = 0x2000_7461;
    #[cfg(not(target_os = "macos"))]
    pub const TIOCSWINSZ: c_ulong = 0x5414;
    #[cfg(not(target_os = "macos"))]
    pub const TIOCSCTTY: c_ulong = 0x540E;

    pub const F_SETFD: c_int = 2;
    pub const FD_CLOEXEC: c_int = 1;
    pub const SIGHUP: c_int = 1;

    #[cfg_attr(not(target_os = "macos"), link(name = "util"))]
    extern "C" {
        pub fn openpty(
            amaster: *mut c_int,
            aslave: *mut c_int,
            name: *mut c_char,
            termp: *const c_void,
            winp: *const Winsize,
        ) -> c_int;
    }

    extern "C" {
        pub fn ioctl(fd: c_int, request: c_ulong, ...) -> c_int;
        pub fn setsid() -> c_int;
        pub fn fcntl(fd: c_int, cmd: c_int, ...) -> c_int;
        pub fn kill(pid: c_int, sig: c_int) -> c_int;
    }
}

fn size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(20, 500), rows.clamp(5, 300))
}

/// Start `program` with `args` in a new terminal of `cols` × `rows`, in
/// `cwd`, with `env` added to TodoCity's own environment.
#[cfg(unix)]
pub fn spawn(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &[(String, String)],
    cols: u16,
    rows: u16,
) -> io::Result<Pty> {
    use std::os::unix::io::{AsRawFd, FromRawFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let (cols, rows) = size(cols, rows);
    let ws = sys::Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let mut master_fd = -1;
    let mut slave_fd = -1;
    // SAFETY: openpty writes two fds into the pointers; name and termios
    // may be null; the window size is read only.
    let ok = unsafe {
        sys::openpty(
            &mut master_fd,
            &mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null(),
            &ws,
        )
    };
    if ok != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: both fds were just opened by openpty and are owned here.
    let master = unsafe { File::from_raw_fd(master_fd) };
    let slave = unsafe { File::from_raw_fd(slave_fd) };
    // Other terminals' programs mustn't inherit these (a stray copy of the
    // other end keeps a terminal open after its program has ended).
    // SAFETY: plain fcntl on fds we own.
    unsafe {
        sys::fcntl(master.as_raw_fd(), sys::F_SETFD, sys::FD_CLOEXEC);
        sys::fcntl(slave.as_raw_fd(), sys::F_SETFD, sys::FD_CLOEXEC);
    }

    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave.try_clone()?));
    for (k, v) in env {
        cmd.env(k, v);
    }
    // SAFETY: runs in the child between fork and exec, after stdin/out/err
    // are the terminal; setsid and ioctl are async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            if sys::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            // Make the terminal (now stdin) this session's controlling one,
            // so Ctrl-C and resizing reach the program.
            if sys::ioctl(0, sys::TIOCSCTTY, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    // Only the program keeps the terminal's other end: when it exits,
    // reading the master ends.
    drop(slave);
    Ok(Pty { master, child })
}

#[cfg(not(unix))]
pub fn spawn(
    _program: &str,
    _args: &[String],
    _cwd: &Path,
    _env: &[(String, String)],
    _cols: u16,
    _rows: u16,
) -> io::Result<Pty> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "The agent panel is available on macOS.",
    ))
}

/// Tell the program its terminal is now `cols` × `rows`.
#[cfg(unix)]
pub fn resize(master: &File, cols: u16, rows: u16) -> io::Result<()> {
    use std::os::unix::io::AsRawFd;
    let (cols, rows) = size(cols, rows);
    let ws = sys::Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: TIOCSWINSZ reads a Winsize from the pointer.
    if unsafe {
        sys::ioctl(
            master.as_raw_fd(),
            sys::TIOCSWINSZ,
            &ws as *const sys::Winsize,
        )
    } == -1
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn resize(_master: &File, _cols: u16, _rows: u16) -> io::Result<()> {
    Ok(())
}

/// Hang up on a program and everything it started (its process group),
/// the way closing a Terminal window does.
#[cfg(unix)]
pub fn hang_up(pid: u32) {
    if let Ok(pid) = i32::try_from(pid) {
        if pid > 1 {
            // SAFETY: plain kill(2) on the program's own process group.
            unsafe {
                sys::kill(-pid, sys::SIGHUP);
            }
        }
    }
}

#[cfg(not(unix))]
pub fn hang_up(_pid: u32) {}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn runs_a_program_in_a_terminal() {
        let mut pty = spawn(
            "/bin/sh",
            &[
                "-c".into(),
                "test -t 0 && echo tty-ok; read x; echo got-$x".into(),
            ],
            Path::new("/"),
            &[("TERM".into(), "xterm-256color".into())],
            100,
            30,
        )
        .unwrap();
        resize(&pty.master, 120, 40).unwrap();
        pty.master.write_all(b"hello\n").unwrap();
        let mut out = Vec::new();
        let mut buf = [0u8; 1024];
        // Reading ends (EOF or EIO) once the program exits.
        while let Ok(n) = pty.master.read(&mut buf) {
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
        }
        let _ = pty.child.wait();
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("tty-ok"), "{text}");
        assert!(text.contains("got-hello"), "{text}");
    }
}

// One running app per user, without anything another account can get in the
// way of (unlike a fixed socket in /tmp, which any account can create first).
//
// Everything lives in the app's own data folder, which only this user can
// write to (`private_dir`: created 0700, refused if it is a symlink or someone
// else's, tightened to 0700 if it is ours but looser):
//
// - `instance.lock`: held with an OS file lock (flock) for as long as the app
//   runs. The OS drops the lock when the process ends, however it ends, so a
//   crash never leaves a stale lock behind.
// - `instance.sock`: a Unix socket the running app listens on. A second launch
//   connects, says "show", and quits; the first one opens its settings window.
//   Both sides check that the other end runs as the same user (getpeereid /
//   SO_PEERCRED) before they say or do anything.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const LOCK_FILE: &str = "instance.lock";
const SOCKET_FILE: &str = "instance.sock";
const SHOW: &[u8] = b"show\n";
const IO_TIMEOUT: Duration = Duration::from_secs(2);

/// The app's data folder: `~/Library/Application Support/<identifier>` on
/// macOS (where Tauri's `app_data_dir` is), `$XDG_DATA_HOME/<identifier>` or
/// `~/.local/share/<identifier>` elsewhere. The home folder comes from the user
/// database, not `$HOME`.
pub fn app_dir(identifier: &str) -> io::Result<PathBuf> {
    if identifier.is_empty() || identifier.contains('/') || identifier.starts_with('.') {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "bad app identifier"));
    }
    let home = crate::user::home().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home folder"))?;
    #[cfg(target_os = "macos")]
    let base = home.join("Library").join("Application Support");
    #[cfg(not(target_os = "macos"))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".local").join("share"));
    Ok(base.join(identifier))
}

fn refuse(path: &Path, why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, format!("{}: {why}", path.display()))
}

/// Makes sure `dir` is a folder only this user can write to: creates it (0700)
/// if it isn't there, refuses a symlink or another user's folder, and takes
/// group and other access away from one of ours.
pub fn private_dir(dir: &Path) -> io::Result<()> {
    match fs::DirBuilder::new().recursive(true).mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = fs::symlink_metadata(dir)?;
    if !meta.file_type().is_dir() {
        return Err(refuse(dir, "not a folder"));
    }
    if meta.uid() != crate::user::uid() {
        return Err(refuse(dir, "belongs to another user"));
    }
    if meta.mode() & 0o077 != 0 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// The user id at the other end of a connected Unix socket.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd"))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: the fd is open for the duration of the call; uid/gid are plain out-params.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `cred` and `len` describe a buffer of the right size for SO_PEERCRED.
    let rc = unsafe {
        libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len)
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(cred.uid)
}

fn same_user(stream: &UnixStream) -> bool {
    peer_uid(stream).is_ok_and(|uid| uid == crate::user::uid())
}

pub enum Instance {
    /// This is the only running instance; keep the guard for as long as the app runs.
    First(Guard),
    /// Another instance of this user's holds the lock.
    Running,
}

/// Holds the lock; dropping it (or the process ending) releases it.
pub struct Guard {
    _lock: File,
    dir: PathBuf,
}

/// Takes the per-user lock in `dir` (made private first).
pub fn acquire(dir: &Path) -> io::Result<Instance> {
    private_dir(dir)?;
    let path = dir.join(LOCK_FILE);
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        // Never follow a symlink planted in place of the lock file.
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)?;
    let meta = lock.metadata()?;
    if !meta.file_type().is_file() || meta.uid() != crate::user::uid() {
        return Err(refuse(&path, "not a lock file of ours"));
    }
    match lock.try_lock() {
        Ok(()) => Ok(Instance::First(Guard { _lock: lock, dir: dir.to_path_buf() })),
        Err(fs::TryLockError::WouldBlock) => Ok(Instance::Running),
        Err(fs::TryLockError::Error(e)) => Err(e),
    }
}

impl Guard {
    /// Listens for later launches and calls `on_show` when one asks. Only
    /// connections from this same user are listened to.
    pub fn listen(&self, on_show: impl Fn() + Send + 'static) -> io::Result<()> {
        let path = self.dir.join(SOCKET_FILE);
        // Whatever is there was left by an instance that has ended: we hold the
        // lock, and nobody else can write in this folder.
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let listener = UnixListener::bind(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        std::thread::Builder::new().name("single-instance".into()).spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                if !same_user(&stream) {
                    continue;
                }
                let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
                let mut buf = [0u8; SHOW.len()];
                if stream.read_exact(&mut buf).is_ok() && buf == SHOW {
                    on_show();
                }
            }
        })?;
        Ok(())
    }
}

/// Asks the running instance (whose folder is `dir`) to show its settings
/// window. Only talks to a listener running as this same user.
pub fn ask_running_to_show(dir: &Path) -> io::Result<()> {
    private_dir(dir)?;
    let mut stream = UnixStream::connect(dir.join(SOCKET_FILE))?;
    if !same_user(&stream) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "the listener isn't this user"));
    }
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    stream.write_all(SHOW)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    /// A fresh folder under the system temp dir, removed when dropped. Kept
    /// short: Unix socket paths are limited to about 100 bytes.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static N: AtomicUsize = AtomicUsize::new(0);
            let base = std::env::temp_dir().join(format!("sbsi{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
            fs::create_dir_all(&base).unwrap();
            TempDir(base)
        }
        fn app(&self) -> PathBuf {
            self.0.join("app")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn mode(p: &Path) -> u32 {
        fs::symlink_metadata(p).unwrap().mode() & 0o777
    }

    #[test]
    fn first_launch_gets_the_lock_and_a_second_one_does_not() {
        let t = TempDir::new();
        let first = acquire(&t.app()).unwrap();
        assert!(matches!(first, Instance::First(_)));
        assert!(matches!(acquire(&t.app()).unwrap(), Instance::Running));
        assert!(matches!(acquire(&t.app()).unwrap(), Instance::Running));
        // Once the first one is gone (quit or crashed), the next launch is first.
        drop(first);
        assert!(matches!(acquire(&t.app()).unwrap(), Instance::First(_)));
    }

    #[test]
    fn a_lock_file_left_behind_is_not_a_lock() {
        let t = TempDir::new();
        private_dir(&t.app()).unwrap();
        // What a crashed instance leaves: the file, but no lock on it.
        fs::write(t.app().join(LOCK_FILE), b"").unwrap();
        fs::set_permissions(t.app().join(LOCK_FILE), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(acquire(&t.app()).unwrap(), Instance::First(_)));
    }

    #[test]
    fn makes_the_folder_private() {
        let t = TempDir::new();
        let _g = acquire(&t.app()).unwrap();
        assert_eq!(mode(&t.app()), 0o700);
        assert_eq!(mode(&t.app().join(LOCK_FILE)), 0o600);

        // A folder of ours that others could write to is tightened.
        let loose = t.0.join("loose");
        fs::create_dir(&loose).unwrap();
        fs::set_permissions(&loose, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(matches!(acquire(&loose).unwrap(), Instance::First(_)));
        assert_eq!(mode(&loose), 0o700);
    }

    #[test]
    fn refuses_a_symlinked_folder_or_lock_file() {
        let t = TempDir::new();
        let real = t.0.join("real");
        fs::create_dir(&real).unwrap();
        let link = t.0.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(acquire(&link).is_err());

        let dir = t.app();
        private_dir(&dir).unwrap();
        std::os::unix::fs::symlink(t.0.join("elsewhere"), dir.join(LOCK_FILE)).unwrap();
        assert!(acquire(&dir).is_err());
        assert!(!t.0.join("elsewhere").exists());
    }

    #[test]
    fn refuses_a_file_where_the_folder_should_be() {
        let t = TempDir::new();
        fs::write(t.app(), b"").unwrap();
        assert!(acquire(&t.app()).is_err());
    }

    #[test]
    fn a_second_launch_asks_the_first_to_show_its_window() {
        let t = TempDir::new();
        let Instance::First(guard) = acquire(&t.app()).unwrap() else { panic!("not first") };
        let (tx, rx) = mpsc::channel();
        guard.listen(move || tx.send(()).unwrap()).unwrap();
        assert_eq!(mode(&t.app().join(SOCKET_FILE)), 0o600);

        assert!(matches!(acquire(&t.app()).unwrap(), Instance::Running));
        ask_running_to_show(&t.app()).unwrap();
        rx.recv_timeout(Duration::from_secs(5)).expect("the first instance was asked to show");

        // Anything else on the socket is ignored.
        let mut other = UnixStream::connect(t.app().join(SOCKET_FILE)).unwrap();
        other.write_all(b"quit\n").unwrap();
        drop(other);
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn a_socket_left_behind_by_a_crash_is_replaced() {
        let t = TempDir::new();
        private_dir(&t.app()).unwrap();
        // A socket file nobody listens on any more.
        drop(UnixListener::bind(t.app().join(SOCKET_FILE)).unwrap());
        assert!(ask_running_to_show(&t.app()).is_err());

        let Instance::First(guard) = acquire(&t.app()).unwrap() else { panic!("not first") };
        let (tx, rx) = mpsc::channel();
        guard.listen(move || tx.send(()).unwrap()).unwrap();
        ask_running_to_show(&t.app()).unwrap();
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
    }

    #[test]
    fn talks_only_to_the_same_user() {
        let t = TempDir::new();
        private_dir(&t.app()).unwrap();
        let listener = UnixListener::bind(t.app().join("peer.sock")).unwrap();
        let client = UnixStream::connect(t.app().join("peer.sock")).unwrap();
        let (server, _) = listener.accept().unwrap();
        assert_eq!(peer_uid(&client).unwrap(), crate::user::uid());
        assert_eq!(peer_uid(&server).unwrap(), crate::user::uid());
        assert!(same_user(&client));
    }

    #[test]
    fn app_dir_is_under_the_home_folder() {
        let dir = app_dir("com.smokebreak.desktop").unwrap();
        assert!(dir.starts_with(crate::user::home().unwrap()) || std::env::var_os("XDG_DATA_HOME").is_some());
        assert!(dir.ends_with("com.smokebreak.desktop"));
        assert!(app_dir("../x").is_err());
        assert!(app_dir("").is_err());
    }
}

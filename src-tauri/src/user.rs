// Who the app runs as, from the system rather than the environment: `$HOME`
// is whatever whoever started the process said it is.

#[cfg(unix)]
pub fn uid() -> u32 {
    // SAFETY: getuid can't fail and touches no memory of ours.
    unsafe { libc::getuid() }
}

/// The home folder of the user the app runs as, from the user database.
#[cfg(unix)]
pub fn home() -> Option<std::path::PathBuf> {
    use std::ffi::{CStr, OsStr};
    use std::os::unix::ffi::OsStrExt;

    let mut buf = vec![0u8; 4096];
    loop {
        // SAFETY: `pwd` and `buf` outlive the call, `result` is only read after
        // it returns, and the strings it points at live in `buf`.
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let rc = unsafe { libc::getpwuid_r(uid(), &mut pwd, buf.as_mut_ptr().cast(), buf.len(), &mut result) };
        if rc == libc::ERANGE && buf.len() < 1 << 20 {
            buf.resize(buf.len() * 2, 0);
            continue;
        }
        if rc != 0 || result.is_null() || pwd.pw_dir.is_null() {
            return None;
        }
        let dir = unsafe { CStr::from_ptr(pwd.pw_dir) };
        let path = std::path::PathBuf::from(OsStr::from_bytes(dir.to_bytes()));
        return path.is_absolute().then_some(path);
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    #[test]
    fn finds_the_home_folder_of_this_user() {
        let home = super::home().expect("a home folder");
        assert!(home.is_absolute());
        assert!(home.exists());
    }
}

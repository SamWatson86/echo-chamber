//! Atomic credential replacement. The current token (including the remote
//! helper's creation fence) is never truncated, removed, or replaced by a backup.
use rand::{rngs::OsRng, RngCore};
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

pub(super) fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_with(path, |file| file.write_all(bytes), platform::promote)
}

fn write_with<W, P>(path: &Path, write: W, promote: P) -> io::Result<()>
where
    W: FnOnce(&mut fs::File) -> io::Result<()>,
    P: FnOnce(&Path, &Path) -> io::Result<()>,
{
    let parent =
        fs::canonicalize(path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "token path has no parent")
        })?)?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "token path has no filename"))?;
    let target = parent.join(name);
    match fs::symlink_metadata(&target) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "token target is not a regular file",
            ));
        }
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => (),
    }
    let mut random = [0u8; 16];
    OsRng.fill_bytes(&mut random);
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let staging = parent.join(format!(".spotify-token-{suffix}.tmp"));
    // create_stage must establish permissions BEFORE any credentials are written.
    // Only clean up files this invocation successfully created.
    let mut file = platform::create_stage(&target, &staging)?;
    let result = write(&mut file).and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| promote(&staging, &target));
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        ffi::c_void,
        os::windows::{ffi::OsStrExt, io::FromRawHandle},
        ptr,
    };

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: *mut c_void,
        inherit_handle: i32,
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn GetFileSecurityW(
            path: *const u16,
            information: u32,
            descriptor: *mut c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
        fn SetSecurityDescriptorControl(descriptor: *mut c_void, interest: u16, value: u16) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            path: *const u16,
            access: u32,
            sharing: u32,
            security: *const SecurityAttributes,
            disposition: u32,
            attributes: u32,
            template: *mut c_void,
        ) -> *mut c_void;
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }

    fn wide(path: &Path) -> io::Result<Vec<u16>> {
        let mut encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
        if encoded.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "NUL in token path",
            ));
        }
        encoded.push(0);
        Ok(encoded)
    }

    fn target_security(path: &Path) -> io::Result<Option<Vec<u32>>> {
        const DACL_SECURITY_INFORMATION: u32 = 0x00000004;
        const SE_DACL_PROTECTED: u16 = 0x1000;
        let path = wide(path)?;
        let mut needed = 0;
        // SAFETY: valid NUL-terminated path and output pointer; the initial call
        // intentionally has no descriptor buffer to obtain its required size.
        let status = unsafe {
            GetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        if status == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(2) {
                return Ok(None);
            } // first token
            if error.raw_os_error() != Some(122) {
                return Err(error);
            } // insufficient buffer
        }
        if needed == 0 || needed > 1_048_576 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid token security descriptor size",
            ));
        }
        // Windows security descriptors require DWORD alignment.
        let mut descriptor = vec![0u32; (needed as usize).div_ceil(4)];
        // SAFETY: DWORD-aligned owned buffer of at least `needed` bytes, held
        // throughout both calls and the subsequent CreateFileW invocation.
        if unsafe {
            GetFileSecurityW(
                path.as_ptr(),
                DACL_SECURITY_INFORMATION,
                descriptor.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // Preserve the exact existing access policy: parent inheritance must not
        // add broader permissions while staging the next set of credentials.
        if unsafe {
            SetSecurityDescriptorControl(
                descriptor.as_mut_ptr().cast(),
                SE_DACL_PROTECTED,
                SE_DACL_PROTECTED,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(descriptor))
    }

    pub(super) fn create_stage(target: &Path, staging: &Path) -> io::Result<fs::File> {
        let mut descriptor = target_security(target)?;
        let security = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: descriptor
                .as_mut()
                .map_or(ptr::null_mut(), |data| data.as_mut_ptr().cast()),
            inherit_handle: 0,
        };
        let path = wide(staging)?;
        // SAFETY: all pointers remain valid through the call. CREATE_NEW prevents
        // collisions from opening any existing file. The returned handle is
        // transferred exactly once to File, which closes it on every path.
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                0x40000000,
                0,
                &security,
                1,
                0x80,
                ptr::null_mut(),
            )
        };
        if handle == -1isize as *mut c_void {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { fs::File::from_raw_handle(handle) })
    }

    pub(super) fn promote(staging: &Path, target: &Path) -> io::Result<()> {
        let staging = wide(staging)?;
        let target = wide(target)?;
        // Same-directory rename, no copy/delete fallback and no missing-primary
        // window. REPLACE_EXISTING | WRITE_THROUGH; a failure retains the target.
        if unsafe { MoveFileExW(staging.as_ptr(), target.as_ptr(), 0x1 | 0x8) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub(super) fn create_stage(target: &Path, staging: &Path) -> io::Result<fs::File> {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mode = match fs::metadata(target) {
            Ok(metadata) => metadata.permissions().mode(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0o600,
            Err(error) => return Err(error),
        };
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(staging)?;
        // Creation may apply umask. Restore the existing mode before writing
        // credentials; a newly created token remains owner-only (0600).
        if let Err(error) = file.set_permissions(fs::Permissions::from_mode(mode)) {
            drop(file);
            let _ = fs::remove_file(staging);
            return Err(error);
        }
        Ok(file)
    }

    pub(super) fn promote(staging: &Path, target: &Path) -> io::Result<()> {
        fs::rename(staging, target)
    }
}

#[cfg(test)]
#[path = "token_store_tests.rs"]
mod tests;

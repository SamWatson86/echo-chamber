fn main() {
    // CRITICAL: cargo's `cargo:rustc-link-arg` only propagates from the
    // CURRENT crate's bin targets. Putting /DELAYLOAD:nvcuda.dll in
    // webrtc-sys-local/build.rs (a library) silently dropped the flag —
    // v0.6.5 shipped with hard nvcuda imports despite the build script
    // claiming to set delay-load. Verified with `dumpbin -imports` showing
    // nvcuda.dll in the normal IMPORTS section, not DELAY IMPORTS. Bricked
    // Jeff's AMD machine after auto-update to v0.6.5.
    //
    // Fix: emit linker flags from THIS build script (the bin crate's), where
    // cargo actually propagates them to the final exe link command.
    // delayimp.lib provides the Windows SDK delay-load helper.
    //
    // cuda_context.cpp::load_cuda_modules() already does a runtime
    // LoadLibrary("nvcuda.dll") check before any cuda symbol is touched, so
    // on AMD machines: process launches → IsSupported() returns false →
    // factory not registered → cuda symbols never called → delay-loaded
    // nvcuda.dll never has to resolve → clean OpenH264 fallback.
    #[cfg(target_os = "windows")]
    {
        println!("cargo:rustc-link-lib=dylib=delayimp");
        println!("cargo:rustc-link-arg=/DELAYLOAD:nvcuda.dll");
        println!("cargo:rustc-link-arg=/DELAYLOAD:nvcuvid.dll");
    }

    tauri_build::build()
}

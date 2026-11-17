//! Optional GPU utilization for the NVIDIA adaptive capture trial.

use std::ffi::c_void;
use std::ptr::NonNull;

use windows::core::{s, w, Owned};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
};

type StatusFn = unsafe extern "C" fn() -> i32;
type DeviceCountFn = unsafe extern "C" fn(*mut u32) -> i32;
type DeviceByIndexFn = unsafe extern "C" fn(u32, *mut *mut c_void) -> i32;
type UtilizationFn = unsafe extern "C" fn(*mut c_void, *mut Utilization) -> i32;

#[repr(C)]
#[derive(Default)]
struct Utilization {
    gpu: u32,
    memory: u32,
}

struct Nvml {
    _library: Owned<HMODULE>,
    shutdown: StatusFn,
}

impl Drop for Nvml {
    fn drop(&mut self) {
        unsafe { (self.shutdown)() };
    }
}

pub(crate) struct NvidiaGpuLoad {
    _nvml: Nvml,
    device: NonNull<c_void>,
    read_utilization: UtilizationFn,
}

impl NvidiaGpuLoad {
    pub(crate) fn open() -> Option<Self> {
        // Load the installed driver library from the Windows system directory.
        unsafe {
            let module = LoadLibraryExW(w!("nvml.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
            let library = Owned::new(module);
            let initialize: StatusFn =
                std::mem::transmute(GetProcAddress(module, s!("nvmlInit_v2"))?);
            let shutdown: StatusFn =
                std::mem::transmute(GetProcAddress(module, s!("nvmlShutdown"))?);
            let device_count: DeviceCountFn =
                std::mem::transmute(GetProcAddress(module, s!("nvmlDeviceGetCount_v2"))?);
            let device_by_index: DeviceByIndexFn =
                std::mem::transmute(GetProcAddress(module, s!("nvmlDeviceGetHandleByIndex_v2"))?);
            let read_utilization: UtilizationFn =
                std::mem::transmute(GetProcAddress(module, s!("nvmlDeviceGetUtilizationRates"))?);
            if initialize() != 0 {
                return None;
            }
            let nvml = Nvml {
                _library: library,
                shutdown,
            };

            // NVML device order need not match DXGI. Use this signal only
            // when there is a single NVIDIA device to disambiguate.
            let mut count = 0;
            if device_count(&mut count) != 0 || count != 1 {
                return None;
            }
            let mut device = std::ptr::null_mut();
            if device_by_index(0, &mut device) != 0 {
                return None;
            }
            Some(Self {
                _nvml: nvml,
                device: NonNull::new(device)?,
                read_utilization,
            })
        }
    }

    pub(crate) fn busy_percent(&self) -> Option<u32> {
        let mut utilization = Utilization::default();
        let status = unsafe { (self.read_utilization)(self.device.as_ptr(), &mut utilization) };
        (status == 0 && utilization.gpu <= 100).then_some(utilization.gpu)
    }
}

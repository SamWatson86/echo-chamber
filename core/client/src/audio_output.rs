//! WASAPI audio output device enumeration and switching for Windows.
//!
//! Enumerates active render (output) devices via IMMDeviceEnumerator,
//! switches the system default audio endpoint via the undocumented
//! IPolicyConfig COM interface, and can restore the previous default
//! on app exit.

use serde::Serialize;
use std::sync::Mutex;

use windows::core::*;
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;

// --- Static storage for previous default device ---

static SAVED_DEFAULT: Mutex<Option<String>> = Mutex::new(None);

// --- Public types ---

#[derive(Serialize, Clone, Debug)]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
}

// --- PROPERTYKEY for device friendly name ---
// Normally from Win32_Devices_FunctionDiscovery / Win32_UI_Shell_PropertiesSystem,
// but we define it manually to avoid adding Cargo.toml features.

#[repr(C)]
#[derive(Clone, Copy)]
struct PROPERTYKEY {
    fmtid: GUID,
    pid: u32,
}

const PKEY_DEVICE_FRIENDLYNAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

// --- IPolicyConfig COM interface (undocumented but stable) ---
//
// Used by SoundSwitch, EarTrumpet, and Windows Sound settings.
// Interface GUID: {F8679F50-850A-41CF-9C72-430F290290C8}
// CLSID (CPolicyConfigClient): {870AF99C-171D-4F9E-AF0D-E63DF40C2BC9}
//
// SetDefaultEndpoint is at vtable index 13:
//   IUnknown (3 methods) + 10 unused methods + SetDefaultEndpoint

const IPOLICYCONFIG_IID: GUID = GUID::from_u128(0xF8679F50_850A_41CF_9C72_430F290290C8);
const CPOLICYCONFIG_CLSID: GUID = GUID::from_u128(0x870AF99C_171D_4F9E_AF0D_E63DF40C2BC9);

// --- IMMDevice vtable layout (manual, for OpenPropertyStore without feature flag) ---
//
// IMMDevice vtable:
//   [0] IUnknown::QueryInterface
//   [1] IUnknown::AddRef
//   [2] IUnknown::Release
//   [3] Activate
//   [4] OpenPropertyStore
//   [5] GetId
//   [6] GetState

// --- IPropertyStore vtable layout (manual) ---
//
// IPropertyStore vtable:
//   [0-2] IUnknown
//   [3] GetCount
//   [4] GetAt
//   [5] GetValue
//   [6] SetValue
//   [7] Commit

// --- Device enumeration ---

/// Returns a list of active audio output (render) devices.
/// The first entry is always "Default" with an empty id.
pub fn list_output_devices() -> Vec<OutputDevice> {
    let mut devices = vec![OutputDevice {
        id: String::new(),
        name: "Default".to_string(),
    }];

    unsafe {
        // COM init — may already be initialized on this thread, that's fine
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(err) => {
                    eprintln!(
                        "[audio-output] CoCreateInstance(MMDeviceEnumerator) failed: {}",
                        err
                    );
                    return devices;
                }
            };

        let collection = match enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) {
            Ok(c) => c,
            Err(err) => {
                eprintln!("[audio-output] EnumAudioEndpoints failed: {}", err);
                return devices;
            }
        };

        let count = match collection.GetCount() {
            Ok(c) => c,
            Err(err) => {
                eprintln!("[audio-output] GetCount failed: {}", err);
                return devices;
            }
        };

        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };

            // Get device ID
            let id_pwstr = match device.GetId() {
                Ok(id) => id,
                Err(_) => continue,
            };
            let id_str = id_pwstr.to_string().unwrap_or_default();
            CoTaskMemFree(Some(id_pwstr.0 as *const std::ffi::c_void));

            // Get friendly name via raw COM calls (no Win32_UI_Shell_PropertiesSystem feature)
            let name = get_device_friendly_name_raw(&device).unwrap_or_else(|| id_str.clone());

            devices.push(OutputDevice {
                id: id_str,
                name,
            });
        }
    }

    devices
}

/// Get the friendly name from a device's property store using raw COM vtable calls.
/// This avoids needing the Win32_UI_Shell_PropertiesSystem cargo feature.
fn get_device_friendly_name_raw(device: &IMMDevice) -> Option<String> {
    unsafe {
        let device_ptr = Interface::as_raw(device);

        // Get vtable pointer: *mut c_void -> *const *const usize (vtable)
        let vtable = *(device_ptr as *const *const usize);

        // OpenPropertyStore is at vtable slot 4 (IUnknown=3, Activate=3, OpenPropertyStore=4)
        let open_property_store: unsafe extern "system" fn(
            *mut std::ffi::c_void, // this
            i32,                   // STGM (STGM_READ = 0)
            *mut *mut std::ffi::c_void, // IPropertyStore**
        ) -> HRESULT = std::mem::transmute(*(vtable.add(4)));

        let mut prop_store: *mut std::ffi::c_void = std::ptr::null_mut();
        let hr = open_property_store(device_ptr as *mut _, 0 /* STGM_READ */, &mut prop_store);
        if hr.is_err() || prop_store.is_null() {
            return None;
        }

        // IPropertyStore::GetValue is at vtable slot 5
        let store_vtable = *(prop_store as *const *const usize);
        let get_value: unsafe extern "system" fn(
            *mut std::ffi::c_void, // this
            *const PROPERTYKEY,    // key
            *mut PROPVARIANT,      // value out (MaybeUninit<PROPVARIANT>)
        ) -> HRESULT = std::mem::transmute(*(store_vtable.add(5)));

        let mut value = std::mem::zeroed::<PROPVARIANT>();
        let hr = get_value(
            prop_store,
            &PKEY_DEVICE_FRIENDLYNAME,
            &mut value,
        );

        // Release IPropertyStore
        let release: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32 =
            std::mem::transmute(*(store_vtable.add(2)));
        release(prop_store);

        if hr.is_err() {
            return None;
        }

        // PROPVARIANT implements Display via PropVariantToBSTR
        let name = value.to_string();
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
    }
}

// --- Device switching ---

/// Get the current default audio output device ID.
fn get_current_default_id() -> Option<String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;

        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .ok()?;

        let id_pwstr = device.GetId().ok()?;
        let id_str = id_pwstr.to_string().unwrap_or_default();
        CoTaskMemFree(Some(id_pwstr.0 as *const std::ffi::c_void));

        Some(id_str)
    }
}

/// Switch the system default audio output device.
///
/// If `device_id` is empty, restores the previously saved default.
/// Otherwise, saves the current default and switches to the specified device.
pub fn set_output_device(device_id: &str) -> std::result::Result<(), String> {
    if device_id.is_empty() {
        restore_default_output();
        return Ok(());
    }

    // Save current default before switching
    if let Some(current) = get_current_default_id() {
        if let Ok(mut saved) = SAVED_DEFAULT.lock() {
            if saved.is_none() {
                eprintln!("[audio-output] saving previous default: {}", current);
                *saved = Some(current);
            }
        }
    }

    // Switch via IPolicyConfig for all roles
    set_default_endpoint(device_id, eConsole)?;
    set_default_endpoint(device_id, eMultimedia)?;
    set_default_endpoint(device_id, eCommunications)?;

    eprintln!("[audio-output] switched default output to: {}", device_id);
    Ok(())
}

/// Restore the saved previous default audio output device.
pub fn restore_default_output() {
    let saved_id = {
        let mut saved = match SAVED_DEFAULT.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        saved.take()
    };

    if let Some(id) = saved_id {
        eprintln!("[audio-output] restoring previous default: {}", id);
        let _ = set_default_endpoint(&id, eConsole);
        let _ = set_default_endpoint(&id, eMultimedia);
        let _ = set_default_endpoint(&id, eCommunications);
    }
}

/// Call IPolicyConfig::SetDefaultEndpoint via raw COM vtable.
fn set_default_endpoint(device_id: &str, role: ERole) -> std::result::Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        // CoCreateInstance for IPolicyConfig — since it's not a type known to
        // the windows crate, we create it as IUnknown and then QueryInterface.
        let unknown: IUnknown =
            CoCreateInstance(&CPOLICYCONFIG_CLSID, None, CLSCTX_ALL).map_err(|e| {
                format!("CoCreateInstance(CPolicyConfigClient) failed: {}", e)
            })?;

        // QueryInterface for IPolicyConfig
        let mut raw_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let hr = (Interface::vtable(&unknown).QueryInterface)(
            Interface::as_raw(&unknown) as *mut _,
            &IPOLICYCONFIG_IID,
            &mut raw_ptr,
        );
        if hr.is_err() || raw_ptr.is_null() {
            return Err(format!(
                "QueryInterface(IPolicyConfig) failed: 0x{:08X}",
                hr.0 as u32
            ));
        }

        // vtable layout:
        //   [0] QueryInterface
        //   [1] AddRef
        //   [2] Release
        //   [3..12] 10 unused IPolicyConfig methods
        //   [13] SetDefaultEndpoint(PCWSTR deviceId, ERole role)
        let vtable = *(raw_ptr as *const *const usize);

        let set_default_endpoint_fn: unsafe extern "system" fn(
            *mut std::ffi::c_void, // this
            PCWSTR,                // device ID
            u32,                   // ERole as u32
        ) -> HRESULT = std::mem::transmute(*(vtable.add(13)));

        // Convert device_id to wide string
        let wide: Vec<u16> = device_id
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let hr = set_default_endpoint_fn(raw_ptr, PCWSTR(wide.as_ptr()), role.0 as u32);

        // Release the IPolicyConfig COM object
        let release_fn: unsafe extern "system" fn(*mut std::ffi::c_void) -> u32 =
            std::mem::transmute(*(vtable.add(2)));
        release_fn(raw_ptr);

        if hr.is_err() {
            return Err(format!(
                "SetDefaultEndpoint failed: 0x{:08X}",
                hr.0 as u32
            ));
        }

        Ok(())
    }
}

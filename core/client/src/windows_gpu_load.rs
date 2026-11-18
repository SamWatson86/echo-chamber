//! Read the rendering engine load on the AMD adapter used by a shared game.

use std::collections::HashMap;
use std::mem::size_of;

use windows::core::{w, PCWSTR};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND,
};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_MORE_DATA,
};

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct AdapterLuid(u32, u32);

pub(crate) fn amd_adapter_luids() -> Vec<AdapterLuid> {
    adapter_luids(0x1002)
}

fn adapter_luids(vendor: u32) -> Vec<AdapterLuid> {
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return Vec::new();
    };
    let mut luids = Vec::new();
    for index in 0.. {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(_) => return Vec::new(),
        };
        if let Ok(desc) = unsafe { adapter.GetDesc1() } {
            if desc.VendorId == vendor && desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 == 0 {
                luids.push(AdapterLuid(
                    desc.AdapterLuid.HighPart as u32,
                    desc.AdapterLuid.LowPart,
                ));
            }
        }
    }
    luids
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Engine {
    adapter: AdapterLuid,
    physical_index: u32,
    engine_index: u32,
}

fn parse_engine(instance: &str) -> Option<(u32, Engine)> {
    let (identity, engine_type) = instance.split_once("_engtype_")?;
    let engine_class = engine_type.split('_').next()?;
    if !(engine_class.eq_ignore_ascii_case("3d") || engine_class.eq_ignore_ascii_case("compute")) {
        return None;
    }
    let (pid, rest) = identity.strip_prefix("pid_")?.split_once("_luid_")?;
    let (luid, rest) = rest.split_once("_phys_")?;
    let (high, low) = luid.split_once('_')?;
    let (physical, engine) = rest.split_once("_eng_")?;
    let parse_hex = |value: &str| u32::from_str_radix(value.strip_prefix("0x")?, 16).ok();
    Some((
        pid.parse().ok()?,
        Engine {
            adapter: AdapterLuid(parse_hex(high)?, parse_hex(low)?),
            physical_index: physical.parse().ok()?,
            engine_index: engine.parse().ok()?,
        },
    ))
}

#[derive(Default)]
struct EngineLoad {
    total: f64,
    game: f64,
}

fn game_adapter_busy(
    game_pid: u32,
    adapters: &[AdapterLuid],
    samples: impl IntoIterator<Item = (String, f64)>,
) -> Option<u32> {
    let mut engines = HashMap::<Engine, EngineLoad>::new();
    for (instance, busy) in samples {
        if !busy.is_finite() || !(0.0..=100.0).contains(&busy) {
            continue;
        }
        let Some((pid, engine)) = parse_engine(&instance) else {
            continue;
        };
        if !adapters.contains(&engine.adapter) {
            continue;
        }
        let load = engines.entry(engine).or_default();
        load.total += busy;
        if pid == game_pid {
            load.game += busy;
        }
    }
    let (&game_engine, _) = engines
        .iter()
        .filter(|(_, load)| load.game > 0.0)
        .max_by(|(_, left), (_, right)| left.game.total_cmp(&right.game))?;
    engines
        .iter()
        .filter(|(engine, _)| {
            engine.adapter == game_engine.adapter
                && engine.physical_index == game_engine.physical_index
        })
        .map(|(_, load)| load.total)
        .max_by(f64::total_cmp)
        .map(|busy| busy.clamp(0.0, 100.0).round() as u32)
}

pub(crate) struct WindowsGpuLoad {
    query: isize,
    counter: isize,
    game_pid: u32,
    adapters: Vec<AdapterLuid>,
    // PDH returns the item structs and their strings in the same suitably
    // aligned buffer. Keep the allocation between samples.
    buffer: Vec<u64>,
}

impl WindowsGpuLoad {
    pub(crate) fn open(game_pid: u32, adapters: Vec<AdapterLuid>) -> Option<Self> {
        let mut query = 0;
        if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) } != 0 {
            return None;
        }
        let mut sampler = Self {
            query,
            counter: 0,
            game_pid,
            adapters,
            buffer: Vec::new(),
        };
        let status = unsafe {
            PdhAddEnglishCounterW(
                query,
                w!(r"\GPU Engine(*)\Utilization Percentage"),
                0,
                &mut sampler.counter,
            )
        };
        if status != 0 || unsafe { PdhCollectQueryData(query) } != 0 {
            return None;
        }
        Some(sampler)
    }

    pub(crate) fn busy_percent(&mut self) -> Option<u32> {
        unsafe {
            if PdhCollectQueryData(self.query) != 0 {
                return None;
            }
            let mut bytes = (self.buffer.len() * size_of::<u64>()) as u32;
            let mut count = 0;
            let mut status = PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut bytes,
                &mut count,
                (!self.buffer.is_empty()).then(|| self.buffer.as_mut_ptr().cast()),
            );
            if status == PDH_MORE_DATA {
                if bytes == 0 || bytes > 1024 * 1024 {
                    return None;
                }
                self.buffer
                    .resize((bytes as usize).div_ceil(size_of::<u64>()), 0);
                status = PdhGetFormattedCounterArrayW(
                    self.counter,
                    PDH_FMT_DOUBLE,
                    &mut bytes,
                    &mut count,
                    Some(self.buffer.as_mut_ptr().cast()),
                );
            }
            if status != 0
                || count == 0
                || count as usize
                    > self.buffer.len() * size_of::<u64>()
                        / size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>()
            {
                return None;
            }
            let items = std::slice::from_raw_parts(
                self.buffer.as_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
                count as usize,
            );
            let samples = items.iter().filter_map(|item| {
                if item.szName.is_null()
                    || !matches!(
                        item.FmtValue.CStatus,
                        PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA
                    )
                {
                    return None;
                }
                Some((
                    item.szName.to_string().ok()?,
                    item.FmtValue.Anonymous.doubleValue,
                ))
            });
            game_adapter_busy(self.game_pid, &self.adapters, samples)
        }
    }
}

impl Drop for WindowsGpuLoad {
    fn drop(&mut self) {
        unsafe { PdhCloseQuery(self.query) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_load_per_engine_and_chooses_the_adapter_rendering_the_game() {
        let entries = [
            (
                "pid_42_luid_0x00000000_0x0000aabb_phys_0_eng_0_engtype_3D",
                62.0,
            ),
            (
                "pid_81_luid_0x00000000_0x0000aabb_phys_0_eng_0_engtype_3D",
                34.0,
            ),
            (
                "pid_42_luid_0x00000000_0x0000ccdd_phys_0_eng_0_engtype_3D",
                1.0,
            ),
            (
                "pid_81_luid_0x00000000_0x0000ccdd_phys_0_eng_0_engtype_3D",
                99.0,
            ),
            (
                "pid_42_luid_0x00000000_0x0000aabb_phys_0_eng_2_engtype_VideoEncode",
                100.0,
            ),
        ];
        let sample = || entries.map(|(name, value)| (name.to_owned(), value));
        let adapters = [AdapterLuid(0, 0xaabb), AdapterLuid(0, 0xccdd)];
        assert_eq!(game_adapter_busy(42, &adapters, sample()), Some(96));
        assert_eq!(game_adapter_busy(77, &adapters, sample()), None);
        assert_eq!(game_adapter_busy(42, &[AdapterLuid(0, 5)], sample()), None);
    }

    #[test]
    #[ignore = "requires a locally running GPU process using the named adapter"]
    fn reads_live_windows_gpu_engine_counters() {
        let pid: u32 = std::env::var("ECHO_TEST_GPU_PID").unwrap().parse().unwrap();
        let vendor =
            u32::from_str_radix(&std::env::var("ECHO_TEST_GPU_VENDOR").unwrap(), 16).unwrap();
        let adapters = adapter_luids(vendor);
        assert!(!adapters.is_empty());
        let mut sampler = WindowsGpuLoad::open(pid, adapters).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        let busy = sampler.busy_percent().expect("active 3D or compute engine");
        eprintln!("Windows GPU engine utilization: {busy}%");
    }
}

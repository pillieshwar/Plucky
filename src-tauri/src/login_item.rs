//! Open at login as the app itself (`SMAppService.mainApp`, macOS 13+).
//!
//! A launch agent is listed by macOS under the developer's name ("Software
//! from …"); the app registered as its own login item is listed — and
//! announced — as "Todo City", with its icon. Older macOS keeps using the
//! autostart plugin's launch agent.

#[cfg(target_os = "macos")]
mod imp {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}

    fn class() -> Option<&'static AnyClass> {
        AnyClass::get(c"SMAppService")
    }

    fn main_app() -> Option<*mut AnyObject> {
        let cls = class()?;
        let obj: *mut AnyObject = unsafe { msg_send![cls, mainAppService] };
        (!obj.is_null()).then_some(obj)
    }

    pub fn available() -> bool {
        class().is_some()
    }

    /// 0 not registered, 1 enabled, 2 needs the user's approval, 3 not found.
    pub fn status() -> isize {
        match main_app() {
            Some(s) => unsafe { msg_send![s, status] },
            None => 0,
        }
    }

    pub fn set(on: bool) -> Result<(), String> {
        let s = main_app().ok_or("Open at login needs macOS 13 or later.")?;
        let mut err: *mut AnyObject = std::ptr::null_mut();
        let ok: bool = unsafe {
            if on {
                msg_send![s, registerAndReturnError: &mut err]
            } else {
                msg_send![s, unregisterAndReturnError: &mut err]
            }
        };
        if ok {
            Ok(())
        } else {
            Err(if on {
                "macOS didn't let Todo City open at login. Check System Settings → General → Login Items.".into()
            } else {
                "macOS didn't let Todo City stop opening at login.".into()
            })
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn available() -> bool {
        false
    }
    pub fn status() -> isize {
        0
    }
    pub fn set(_on: bool) -> Result<(), String> {
        Err("Not available here.".into())
    }
}

/// True where the app can be its own login item (macOS 13+).
pub fn available() -> bool {
    imp::available()
}

/// On, as far as the user is concerned (registered and approved).
pub fn enabled() -> bool {
    imp::status() == 1
}

pub fn set(on: bool) -> Result<(), String> {
    imp::set(on)
}

/// The launch agents earlier versions wrote (`~/Library/LaunchAgents/*.plist`
/// named after the app: Pluck, Plucky, Todo City).
pub fn legacy_agents() -> Vec<std::path::PathBuf> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let dir = std::path::PathBuf::from(home).join("Library/LaunchAgents");
    ["Pluck.plist", "Plucky.plist", "Todo City.plist"]
        .iter()
        .map(|n| dir.join(n))
        .filter(|p| p.is_file())
        .collect()
}

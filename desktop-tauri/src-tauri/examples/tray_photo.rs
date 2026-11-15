//! Photo helper: shows the real quota strip as a menu-bar status item for a few
//! seconds, then exits. No window, no menu. Run by hand:
//! `cargo run --release --example tray_photo` (env TRAY_PHOTO_SECS, default 10).
//! Card c675633f.
#[path = "../src/tray_quota.rs"]
#[allow(dead_code)]
mod tray_quota;

use tauri::image::Image;
use tauri::Manager;
use tauri::tray::TrayIconBuilder;

fn main() {
    let secs: u64 = std::env::var("TRAY_PHOTO_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let cols = tray_quota::fetch_columns(&tray_quota::hub_base());
            let strip = tray_quota::render_strip(cols.as_deref());
            let icon = Image::new_owned(strip.rgba, strip.width, strip.height);
            let tray = TrayIconBuilder::new().icon(icon).icon_as_template(false).build(app)?;
            app.manage(tray);
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(secs));
                handle.exit(0);
            });
            Ok(())
        })
        .build(context)
        .expect("build");
    app.run(|_, _| {});
}

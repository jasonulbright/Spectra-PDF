// Prevents additional console window on Windows in release (GUI mode).
// CLI mode reattaches to the parent console for stdout/stderr.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::Parser;
use openpdfstudio_lib::cli::Cli;

fn main() {
    // Handle /? before anything else — show a GUI help dialog.
    // Clap doesn't recognize / switches, so we intercept early.
    if std::env::args().any(|a| a == "/?" || a == "-?") {
        show_help_dialog();
        std::process::exit(0);
    }

    // Attach to parent console BEFORE clap parses args, so that
    // --help and --version output is visible when invoked from a terminal.
    // (windows_subsystem = "windows" starts with no console attached.)
    attach_parent_console();

    let cli = Cli::parse();

    match cli.command {
        Some(command) => {
            let code = openpdfstudio_lib::cli::run(command);
            std::process::exit(code);
        }
        None if cli.minimized => {
            // --minimized flag without a subcommand — launch GUI minimized
            openpdfstudio_lib::run();
        }
        None => {
            // No subcommand — launch the GUI as normal
            openpdfstudio_lib::run();
        }
    }
}

/// Attach to the parent process's console and redirect std handles
/// so that Rust's println!/eprintln! output is visible when invoked
/// from cmd or PowerShell. Required because the exe uses
/// `windows_subsystem = "windows"` which starts with no console.
#[cfg(windows)]
fn attach_parent_console() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    extern "system" {
        fn AttachConsole(dw_process_id: u32) -> i32;
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: *const u8,
            dw_creation_disposition: u32,
            dw_flags_and_attributes: u32,
            h_template_file: *const u8,
        ) -> isize;
        fn SetStdHandle(n_std_handle: u32, h_handle: isize) -> i32;
    }

    const ATTACH_PARENT_PROCESS: u32 = 0xFFFFFFFF;
    const GENERIC_WRITE: u32 = 0x40000000;
    const FILE_SHARE_WRITE: u32 = 0x00000002;
    const OPEN_EXISTING: u32 = 3;
    const STD_OUTPUT_HANDLE: u32 = 0xFFFFFFF5u32; // -11 as u32
    const STD_ERROR_HANDLE: u32 = 0xFFFFFFF4u32; // -12 as u32
    const INVALID_HANDLE_VALUE: isize = -1;

    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return; // No parent console (e.g., double-clicked)
        }

        // Open the console output device
        let conout: Vec<u16> = OsStr::new("CONOUT$")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let handle = CreateFileW(
            conout.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_WRITE,
            ptr::null(),
            OPEN_EXISTING,
            0,
            ptr::null(),
        );

        if handle != INVALID_HANDLE_VALUE {
            SetStdHandle(STD_OUTPUT_HANDLE, handle);
            SetStdHandle(STD_ERROR_HANDLE, handle);
        }
    }
}

#[cfg(not(windows))]
fn attach_parent_console() {
    // No-op on non-Windows platforms
}

/// Show a Win32 MessageBox with CLI usage examples.
/// MessageBox natively supports Ctrl+C to copy full contents
/// but does not allow text selection or highlighting.
#[cfg(windows)]
fn show_help_dialog() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }

    const MB_OK: u32 = 0x00000000;
    const MB_ICONINFORMATION: u32 = 0x00000040;

    let version = env!("CARGO_PKG_VERSION");

    let text = format!(
        "Open PDF Studio v{version} - Command Line Usage\r\n\
         \r\n\
         When invoked without a subcommand, the GUI launches.\r\n\
         Use a subcommand to run headless from the command line.\r\n\
         \r\n\
         SUBCOMMANDS:\r\n\
         \r\n\
         openpdfstudio compress input.pdf -o out.pdf --quality ebook\r\n\
         openpdfstudio merge a.pdf b.pdf -o merged.pdf\r\n\
         openpdfstudio rotate input.pdf -o out.pdf --angle 90 --pages 1,3,5\r\n\
         openpdfstudio split input.pdf -o out_dir/ --ranges \"1-3,5-7\"\r\n\
         openpdfstudio encrypt input.pdf -o out.pdf --password secret\r\n\
         openpdfstudio decrypt input.pdf -o out.pdf --password secret\r\n\
         openpdfstudio pdfa input.pdf -o out.pdf --level 2b\r\n\
         openpdfstudio extract-text input.pdf --pages 1,2,3\r\n\
         openpdfstudio delete input.pdf -o out.pdf --pages 3,7\r\n\
         openpdfstudio metadata input.pdf --title \"Title\" -o out.pdf\r\n\
         openpdfstudio print input.pdf --printer \"Printer Name\" --pages 1-3\r\n\
         openpdfstudio printers\r\n\
         openpdfstudio batch input_dir/ -o out_dir/ compress --quality ebook\r\n\
         \r\n\
         FLAGS:\r\n\
         \r\n\
         --help          Show detailed help (requires terminal)\r\n\
         --version       Show version\r\n\
         --minimized     Start GUI minimized to system tray\r\n\
         /?              Show this dialog\r\n\
         \r\n\
         EXIT CODES:\r\n\
         \r\n\
         0  Success\r\n\
         1  Operation error\r\n\
         2  Invalid arguments\r\n\
         \r\n\
         Press Ctrl+C to copy this text."
    );

    let caption = format!("Open PDF Studio v{version}");

    let text_wide: Vec<u16> = OsStr::new(&text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let caption_wide: Vec<u16> = OsStr::new(&caption)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        MessageBoxW(
            0,
            text_wide.as_ptr(),
            caption_wide.as_ptr(),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}

#[cfg(not(windows))]
fn show_help_dialog() {
    // Fallback: print to stdout
    println!("Use --help for usage information.");
}

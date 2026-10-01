use super::*;
use std::sync::mpsc;

fn desc(index: Word, name: &str, kind: i32, unit: i32, constraint: Constraint) -> OptionDesc {
    OptionDesc {
        index,
        name: name.to_string(),
        title: String::new(),
        kind,
        unit,
        size: if kind == kind::STRING { 32 } else { 4 },
        cap: CAP_SOFT_SELECT,
        constraint,
    }
}

#[test]
fn every_named_status_maps_to_its_own_refusal() {
    let rows = [
        (status::DEVICE_BUSY, Phase::Open, "scan.deviceBusy"),
        (status::INVAL, Phase::Transfer, "scan.settingRejected"),
        (status::JAMMED, Phase::Transfer, "scan.paperJam"),
        (status::NO_DOCS, Phase::Transfer, "scan.feederEmpty"),
        (status::COVER_OPEN, Phase::Transfer, "scan.coverOpen"),
        (status::IO_ERROR, Phase::Open, "scan.deviceOffline"),
        (status::IO_ERROR, Phase::Transfer, "scan.deviceLost"),
        (status::ACCESS_DENIED, Phase::Open, "scan.accessDenied"),
        (status::CANCELLED, Phase::Transfer, "scan.cancelledAtDevice"),
    ];
    for (code, phase, key) in rows {
        assert_eq!(refusal_for(code, phase).key, key, "{}", status::name(code));
    }
    let unnamed = refusal_for(status::NO_MEM, Phase::Transfer);
    assert_eq!(unnamed.key, "scan.failed");
    assert_eq!(unnamed.code.as_deref(), Some("SANE_STATUS_NO_MEM"));
    assert_eq!(refusal_for(99, Phase::Open).code.as_deref(), Some("SANE_STATUS_UNKNOWN"));
}

#[test]
fn mode_values_are_read_by_meaning() {
    assert_eq!(color_mode_of("Color"), Some(ColorMode::Color));
    assert_eq!(color_mode_of("24bit Color[Fast]"), Some(ColorMode::Color));
    assert_eq!(color_mode_of("True Gray"), Some(ColorMode::Grayscale));
    assert_eq!(color_mode_of("Lineart"), Some(ColorMode::BlackAndWhite));
    assert_eq!(color_mode_of("Binary"), Some(ColorMode::BlackAndWhite));
    assert_eq!(color_mode_of("Halftone"), None);
    let modes = color_modes_of(&["Color".into(), "Halftone".into(), "Gray".into(), "Lineart".into()]);
    assert_eq!(
        modes,
        vec![
            (ColorMode::BlackAndWhite, "Lineart".to_string()),
            (ColorMode::Grayscale, "Gray".to_string()),
            (ColorMode::Color, "Color".to_string()),
        ]
    );
}

#[test]
fn source_values_are_read_by_meaning() {
    assert_eq!(source_category("Flatbed"), SourceCategory::Flatbed);
    assert_eq!(source_category("ADF"), SourceCategory::Feeder);
    assert_eq!(source_category("Automatic Document Feeder"), SourceCategory::Feeder);
    assert_eq!(source_category("ADF Duplex"), SourceCategory::Feeder);
    assert_eq!(source_category("ADF Front"), SourceCategory::FeederFront);
    assert_eq!(source_category("ADF Back"), SourceCategory::FeederBack);
    assert_eq!(source_category("Transparency Adapter"), SourceCategory::Film);
    assert!(is_duplex_source("ADF Duplex"));
    assert!(!is_duplex_source("ADF Front"));
}

#[test]
fn a_duplex_source_becomes_the_duplex_row() {
    let sources = vec![
        ("Flatbed".to_string(), SourceCategory::Flatbed, false),
        ("ADF".to_string(), SourceCategory::Feeder, false),
        ("ADF Duplex".to_string(), SourceCategory::Feeder, true),
    ];
    let (handling, rows) = plan_sources(&sources, None);
    let ids: Vec<_> = rows.iter().map(|r| (r.id, r.item_name.as_str(), r.document_handling, r.feeds)).collect();
    assert_eq!(
        ids,
        vec![
            (SourceOptionId::Flatbed, "Flatbed", None, false),
            (SourceOptionId::Feeder, "ADF", None, true),
            (SourceOptionId::Duplex, "ADF Duplex", None, true),
        ]
    );
    assert_eq!(handling.duplex_mode, DuplexMode::FrontBackItems);
    assert!(handling.flatbed && handling.feeder && handling.duplex);
}

#[test]
fn a_duplex_switch_writes_its_position_on_the_feeder_rows() {
    let sources = vec![
        ("Flatbed".to_string(), SourceCategory::Flatbed, false),
        ("ADF".to_string(), SourceCategory::Feeder, false),
    ];
    let (handling, rows) = plan_sources(&sources, Some(&DuplexSwitch::Boolean));
    assert_eq!(rows[1].document_handling, Some(DUPLEX_OFF));
    assert_eq!(rows[2].id, SourceOptionId::Duplex);
    assert_eq!(rows[2].item_name, "ADF");
    assert_eq!(rows[2].document_handling, Some(DUPLEX_ON));
    assert_eq!(handling.duplex_mode, DuplexMode::DuplexBit);
}

#[test]
fn a_flatbed_only_device_offers_no_feeder_or_duplex() {
    let sources = vec![("".to_string(), SourceCategory::Flatbed, false)];
    let (handling, rows) = plan_sources(&sources, None);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, SourceOptionId::Flatbed);
    assert!(!handling.feeder && !handling.duplex);
}

#[test]
fn an_adf_mode_list_is_a_duplex_switch() {
    let snapshot = Snapshot {
        options: vec![desc(
            3,
            "adf-mode",
            kind::STRING,
            0,
            Constraint::Strings(vec!["Simplex".into(), "Duplex".into()]),
        )],
        values: vec![],
    };
    assert_eq!(
        duplex_switch(&snapshot),
        Some(DuplexSwitch::Mode {
            on: "Duplex".into(),
            off: "Simplex".into()
        })
    );
}

#[test]
fn fixed_point_ranges_report_whole_units() {
    let contrast = desc(
        9,
        "contrast",
        kind::FIXED,
        0,
        Constraint::Range {
            min: to_fixed(-100.0),
            max: to_fixed(100.0),
            quant: 0,
        },
    );
    let report = report_of(&contrast, Some(12.4));
    assert_eq!(
        report.domain,
        PropertyDomain::Range {
            min: -100,
            max: 100,
            step: 1,
            nominal: None
        }
    );
    assert_eq!(report.current, Some(12));
    assert_eq!(
        control_model(Some(&report)),
        ControlModel::Span {
            min: -100,
            max: 100,
            step: 1,
            current: Some(12)
        }
    );
    let words = desc(3, "resolution", kind::INT, 4, Constraint::Words(vec![150, 300, 600]));
    assert_eq!(
        control_model(Some(&report_of(&words, Some(300.0)))),
        ControlModel::Choice {
            values: vec![150, 300, 600],
            current: Some(300)
        }
    );
}

fn area_snapshot(unit: i32, kind: i32, max_x: f64, max_y: f64) -> Snapshot {
    let range = |max: f64| {
        let raw = if kind == kind::FIXED { to_fixed(max) } else { max as Word };
        Constraint::Range { min: 0, max: raw, quant: 0 }
    };
    Snapshot {
        options: vec![
            desc(4, "tl-x", kind, unit, range(max_x)),
            desc(5, "tl-y", kind, unit, range(max_y)),
            desc(6, "br-x", kind, unit, range(max_x)),
            desc(7, "br-y", kind, unit, range(max_y)),
        ],
        values: vec![],
    }
}

#[test]
fn the_scan_area_is_the_paper_clamped_to_the_bed() {
    let mm = area_snapshot(unit::MM, kind::FIXED, 215.9, 297.0);
    let a4 = area_values(PaperSize::A4, 300.0, &mm).unwrap();
    assert_eq!(a4[0], ("tl-x", 0.0));
    assert!((a4[2].1 - 210.0).abs() < 1e-9);
    assert!((a4[3].1 - 297.0).abs() < 1e-9);
    let legal = area_values(PaperSize::Legal, 300.0, &mm).unwrap();
    assert!((legal[3].1 - 297.0).abs() < 1e-9, "a legal sheet on a letter bed is clamped");
    let auto = area_values(PaperSize::Auto, 300.0, &mm).unwrap();
    assert!((auto[2].1 - 215.9).abs() < 1e-4, "auto selects the whole bed");
    let px = area_snapshot(unit::PIXEL, kind::INT, 2550.0, 3508.0);
    let letter = area_values(PaperSize::Letter, 300.0, &px).unwrap();
    assert!((letter[2].1 - 2550.0).abs() < 1e-9);
    assert!((letter[3].1 - 3300.0).abs() < 1e-9);
}

#[test]
fn camera_rows_are_dropped_and_twins_are_told_apart() {
    let rows = vec![
        DeviceRow { name: "genesys:libusb:001:004".into(), vendor: "Canon".into(), model: "LiDE 220".into(), kind: "flatbed scanner".into() },
        DeviceRow { name: "airscan:e0:Canon LiDE 220".into(), vendor: "Canon".into(), model: "LiDE 220".into(), kind: "eSCL network scanner".into() },
        DeviceRow { name: "v4l:/dev/video0".into(), vendor: "Noname".into(), model: "Webcam".into(), kind: "video camera".into() },
    ];
    let devices = device_list(&rows);
    let names: Vec<_> = devices.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, vec!["Canon LiDE 220 (airscan)", "Canon LiDE 220 (genesys)"]);
    assert_eq!(DeviceId::parse(&format!("sane:{}", devices[1].id)).native, "genesys:libusb:001:004");
    assert_eq!(DeviceId::parse("genesys:libusb:001:004").stack, ScanStack::Sane);
}

#[test]
fn rows_convert_to_bmp_sample_order() {
    let rgb = RawParametersView { format: frame::RGB, depth: 8, pixels: 2 };
    assert_eq!(convert_row(&rgb, &[1, 2, 3, 4, 5, 6, 99]), vec![3, 2, 1, 6, 5, 4]);
    let grey16 = RawParametersView { format: frame::GRAY, depth: 16, pixels: 2 };
    let raw: Vec<u8> = [0x1234u16, 0xFF00].iter().flat_map(|v| v.to_ne_bytes()).collect();
    assert_eq!(convert_row(&grey16, &raw), vec![0x12, 0xFF]);
    let line = RawParametersView { format: frame::GRAY, depth: 1, pixels: 10 };
    assert_eq!(convert_row(&line, &[0b1010_0000, 0b0100_0000, 7]), vec![0b1010_0000, 0b0100_0000]);
    assert_eq!(row_bytes(&rgb), 6);
    assert_eq!(row_bytes(&line), 2);
}

#[test]
fn a_page_of_unknown_length_is_a_complete_bmp_once_finished() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("page.bmp");
    let mut writer = PageWriter::create(&path, 3, 24, 300.0).unwrap();
    for _ in 0..5 {
        writer.row(&[1, 2, 3, 4, 5, 6, 7, 8, 9]).unwrap();
    }
    let bytes = writer.finish().unwrap();
    let data = std::fs::read(&path).unwrap();
    assert_eq!(data.len() as u64, bytes);
    assert_eq!(&data[..2], b"BM");
    let height = i32::from_le_bytes(data[22..26].try_into().unwrap());
    assert_eq!(height, -5, "rows are stored top-down as they arrived");
    let ppm = i32::from_le_bytes(data[38..42].try_into().unwrap());
    assert_eq!(ppm, 11811);
    assert_eq!(page_integrity(&path), PageIntegrity::Complete);
}

// ── against a stand-in libsane ──────────────────────────────────────────────
//
// `tests/fixtures/fake_sane.c` is compiled into a shared library and loaded
// through the same dlopen path as the system's libsane, so enumeration, the
// option walk, the writes, multi-page feeding, jams and cancel all run
// through the real FFI. A machine without a C compiler skips this.

fn fake_library() -> Option<PathBuf> {
    static BUILT: OnceLock<Option<PathBuf>> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_sane.c");
            let out = std::env::temp_dir().join(format!("spectra-fake-sane-{}.so", std::process::id()));
            let built = std::process::Command::new("cc")
                .args(["-shared", "-fPIC", "-O1", "-o"])
                .arg(&out)
                .arg(&source)
                .status()
                .ok()?;
            built.success().then_some(out)
        })
        .clone()
}

fn set_jam(library: &Path, at: c_int) {
    let path = CString::new(library.to_string_lossy().into_owned()).unwrap();
    let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW | libc::RTLD_NOLOAD) };
    assert!(!handle.is_null(), "the fake is loaded");
    let name = CString::new("fake_sane_set_jam").unwrap();
    let f = unsafe { libc::dlsym(handle, name.as_ptr()) };
    assert!(!f.is_null());
    let f: unsafe extern "C" fn(c_int) = unsafe { std::mem::transmute(f) };
    unsafe { f(at) };
}

fn events() -> (EventSink, mpsc::Receiver<ScanEvent>) {
    let (send, receive) = mpsc::channel();
    let send = Mutex::new(send);
    (
        Box::new(move |event| {
            let _ = send.lock().unwrap().send(event);
        }),
        receive,
    )
}

fn header(path: &str) -> (i32, i32, u16) {
    let data = std::fs::read(path).unwrap();
    let width = i32::from_le_bytes(data[18..22].try_into().unwrap());
    let height = i32::from_le_bytes(data[22..26].try_into().unwrap());
    let bits = u16::from_le_bytes(data[28..30].try_into().unwrap());
    (width, height, bits)
}

#[test]
fn the_sane_path_enumerates_reports_and_acquires_through_the_ffi() {
    let Some(library) = fake_library() else {
        eprintln!("no C compiler; skipping");
        return;
    };
    TEST_LIBRARY.set(library.clone()).ok();
    if TEST_LIBRARY.get() != Some(&library) {
        eprintln!("another library was loaded first; skipping");
        return;
    }

    let devices = sane_enumerate().unwrap();
    assert_eq!(devices, vec![ScannerDevice { id: "fake:usb:001".into(), name: "Spectra Test Scanner".into() }]);

    let session = SaneSession::open("fake:usb:001".into()).unwrap();
    let caps = session.capabilities().unwrap();
    assert_eq!(caps.device_name, "Spectra Test Scanner");
    let rows: Vec<_> = caps.source_options.iter().map(|r| (r.id, r.item_name.clone())).collect();
    assert_eq!(
        rows,
        vec![
            (SourceOptionId::Flatbed, "Flatbed".to_string()),
            (SourceOptionId::Feeder, "ADF".to_string()),
            (SourceOptionId::Duplex, "ADF Duplex".to_string()),
        ]
    );
    let flatbed = &caps.sources[0];
    assert_eq!(flatbed.resolution, ControlModel::Span { min: 75, max: 600, step: 25, current: Some(150) });
    assert_eq!(flatbed.color_modes, vec![ColorMode::BlackAndWhite, ColorMode::Grayscale, ColorMode::Color]);
    assert_eq!(flatbed.pages, ControlModel::Absent);
    assert!(matches!(caps.sources[1].pages, ControlModel::Span { min: 0, .. }));
    assert!(matches!(flatbed.contrast, ControlModel::Span { min: -100, max: 100, .. }));

    // Flatbed, colour, A4, an off-grid resolution the device rounds.
    let dir = tempfile::tempdir().unwrap();
    let (sink, seen) = events();
    let result = session
        .acquire(
            ScanSettings {
                item_name: Some("Flatbed".into()),
                dpi: Some(110),
                color_mode: Some(ColorMode::Color),
                paper: Some(PaperSize::A4),
                brightness: Some(10),
                contrast: Some(-20),
                ..Default::default()
            },
            dir.path().to_path_buf(),
            sink,
        )
        .unwrap();
    assert_eq!(result.pages.len(), 1);
    assert!(!result.cancelled && result.interrupted.is_none());
    assert_eq!(result.dpi, 100);
    assert_eq!(
        result.adjusted,
        vec![PropertyAdjustment { property: "Scan resolution".into(), requested: 110, actual: Some(100) }]
    );
    let (w, h, bits) = header(&result.pages[0]);
    assert_eq!((w, bits), (826, 24));
    assert_eq!(h, -1169);
    assert_eq!(page_integrity(Path::new(&result.pages[0])), PageIntegrity::Complete);
    let kinds: Vec<_> = seen.try_iter().collect();
    assert!(kinds.iter().any(|e| matches!(e, ScanEvent::Progress { percent: 100, .. })));
    assert!(kinds.iter().any(|e| matches!(e, ScanEvent::PageFinished { index: 0, .. })));

    // The feeder until it empties, grey, pages of unknown length.
    let dir = tempfile::tempdir().unwrap();
    let (sink, _) = events();
    let result = session
        .acquire(
            ScanSettings {
                item_name: Some("ADF".into()),
                dpi: Some(75),
                color_mode: Some(ColorMode::Grayscale),
                paper: Some(PaperSize::Letter),
                pages: Some(0),
                ..Default::default()
            },
            dir.path().to_path_buf(),
            sink,
        )
        .unwrap();
    assert_eq!(result.pages.len(), 3);
    for page in &result.pages {
        assert_eq!(header(page), (637, -824, 8));
        assert_eq!(page_integrity(Path::new(page)), PageIntegrity::Complete);
    }

    // Duplex lineart with a page limit.
    let dir = tempfile::tempdir().unwrap();
    let (sink, _) = events();
    let result = session
        .acquire(
            ScanSettings {
                item_name: Some("ADF Duplex".into()),
                dpi: Some(150),
                color_mode: Some(ColorMode::BlackAndWhite),
                pages: Some(4),
                ..Default::default()
            },
            dir.path().to_path_buf(),
            sink,
        )
        .unwrap();
    assert_eq!(result.pages.len(), 4);
    assert_eq!(header(&result.pages[0]).2, 1);

    // A jam before the third sheet keeps the two that finished.
    set_jam(&library, 2);
    let dir = tempfile::tempdir().unwrap();
    let (sink, _) = events();
    let result = session
        .acquire(
            ScanSettings { item_name: Some("ADF".into()), pages: Some(0), ..Default::default() },
            dir.path().to_path_buf(),
            sink,
        )
        .unwrap();
    set_jam(&library, 0);
    assert_eq!(result.pages.len(), 2);
    assert_eq!(result.interrupted.as_ref().map(|r| r.key), Some("scan.paperJam"));

    // Stop after the first page keeps that page.
    let session = Arc::new(session);
    let dir = tempfile::tempdir().unwrap();
    let stopper = session.clone();
    let result = session
        .acquire(
            ScanSettings { item_name: Some("ADF".into()), pages: Some(0), ..Default::default() },
            dir.path().to_path_buf(),
            Box::new(move |event| {
                if let ScanEvent::PageFinished { index: 0, .. } = event {
                    stopper.cancel();
                }
            }),
        )
        .unwrap();
    assert!(result.cancelled, "Stop after the first page is a cancelled result");
    assert_eq!(result.pages.len(), 1);
}

#[test]
fn every_refusal_key_is_one_the_catalog_carries() {
    // The SANE half of the cross-language pin `scanner.rs` holds for WIA: a
    // key this layer can refuse with and the catalog lacks renders as its own
    // name. Every `"scan.<key>"` literal in the layer's sources is a refusal.
    let fixture = include_str!("../../tests/fixtures/scan-refusal-keys.json");
    let carried: Vec<String> = serde_json::from_str(fixture).expect("the fixture is JSON");
    let sources = [include_str!("scanner_sane.rs"), include_str!("scan_model.rs")];
    let mut produced = std::collections::BTreeSet::new();
    for source in sources {
        for (at, _) in source.match_indices("\"scan.") {
            let rest = &source[at + 1..];
            let key = &rest[..rest.find('"').expect("a closed literal")];
            produced.insert(key.to_string());
        }
    }
    assert!(produced.contains("scan.saneMissing") && produced.contains("scan.accessDenied"));
    for key in &produced {
        assert!(carried.contains(key), "{key} is refusable here and absent from the catalog fixture");
    }
}

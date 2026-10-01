use super::*;
use std::ffi::{c_int, c_void, CString};
use std::sync::mpsc;

const PDF: &[u8] = b"%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "spectra-ipp-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct Harness {
    printer: Arc<IppPrinter>,
    delivered: mpsc::Receiver<PathBuf>,
    errors: Arc<Mutex<Vec<String>>>,
    dir: PathBuf,
}

fn harness(user: &str, port: u16) -> Harness {
    let dir = scratch("jobs");
    let (send, delivered) = mpsc::channel();
    let send = Mutex::new(send);
    let errors = Arc::new(Mutex::new(Vec::new()));
    let sink = errors.clone();
    let printer = Arc::new(IppPrinter::new(
        port,
        user.to_string(),
        dir.clone(),
        Box::new(move |path| {
            let _ = send.lock().unwrap().send(path);
        }),
        Box::new(move |message| sink.lock().unwrap().push(message)),
    ));
    Harness {
        printer,
        delivered,
        errors,
        dir,
    }
}

fn request(code: u16, op_attrs: Vec<Attr>) -> Message {
    let mut attrs = vec![
        Attr::new("attributes-charset", vec![Value::Charset("utf-8".into())]),
        Attr::new("attributes-natural-language", vec![Value::Language("en".into())]),
        Attr::new("printer-uri", vec![Value::Uri(device_uri(9))]),
    ];
    attrs.extend(op_attrs);
    Message {
        version: (2, 0),
        code,
        request_id: 7,
        groups: vec![Group {
            tag: tag::OPERATION,
            attrs,
        }],
    }
}

fn user_attr(user: &str) -> Attr {
    Attr::new("requesting-user-name", vec![Value::Name(user.into())])
}

fn ask(printer: &IppPrinter, message: &Message, document: &[u8]) -> Message {
    let mut bytes = encode(message);
    bytes.extend_from_slice(document);
    let reply = printer.handle(&mut bytes.as_slice());
    decode(&mut reply.as_slice()).expect("the reply decodes")
}

fn job_attr(reply: &Message, name: &str) -> Option<Value> {
    reply.attr(tag::JOB, name).and_then(|a| a.values.first().cloned())
}

#[test]
fn identity_maps_to_a_fixed_port_queue_and_uri() {
    assert_eq!(port_for(1000), 11_000);
    assert_eq!(port_for(0), 10_000);
    assert!(port_for(u32::MAX) < 32_768);
    assert_eq!(queue_name("alice"), "Spectra-PDF-alice");
    assert_eq!(queue_name("DOMAIN\\ann marie"), "Spectra-PDF-DOMAIN_ann_marie");
    assert!(queue_name(&"x".repeat(400)).len() <= MAX_QUEUE_NAME);
    assert_eq!(device_uri(11_000), "ipp://127.0.0.1:11000/ipp/print");
    assert_eq!(queue_uri(11_000), "ipp://127.0.0.1:11000/ipp/print?contimeout=30");
}

#[test]
fn the_default_paper_follows_the_locale_territory() {
    assert_eq!(default_media_for_locale("en_US.UTF-8"), "na_letter_8.5x11in");
    assert_eq!(default_media_for_locale("fr_CA.UTF-8"), "na_letter_8.5x11in");
    assert_eq!(default_media_for_locale("de_DE.UTF-8@euro"), "iso_a4_210x297mm");
    assert_eq!(default_media_for_locale("C"), "iso_a4_210x297mm");
    assert_eq!(default_media_for_locale(""), "iso_a4_210x297mm");
}

#[test]
fn messages_round_trip_with_collections_and_additional_values() {
    let message = Message {
        version: (2, 0),
        code: op::GET_PRINTER_ATTRIBUTES,
        request_id: 42,
        groups: vec![
            Group {
                tag: tag::OPERATION,
                attrs: vec![Attr::new(
                    "requested-attributes",
                    vec![Value::Keyword("all".into()), Value::Keyword("media-col-database".into())],
                )],
            },
            Group {
                tag: tag::PRINTER,
                attrs: vec![
                    Attr::new("copies-supported", vec![Value::Range(1, 999)]),
                    Attr::new("printer-resolution-default", vec![Value::Resolution(300, 300, 3)]),
                    Attr::new(
                        "media-col",
                        vec![Value::Collection(vec![
                            Attr::new(
                                "media-size",
                                vec![Value::Collection(vec![
                                    Attr::new("x-dimension", vec![Value::Integer(21000)]),
                                    Attr::new("y-dimension", vec![Value::Range(100, 200)]),
                                ])],
                            ),
                            Attr::new("media-source", vec![Value::Keyword("auto".into()), Value::Keyword("tray-1".into())]),
                        ])],
                    ),
                    Attr::new("color-supported", vec![Value::Boolean(true)]),
                ],
            },
        ],
    };
    let bytes = encode(&message);
    let mut reader = bytes.as_slice();
    assert_eq!(decode(&mut reader).unwrap(), message);
    assert!(reader.is_empty(), "decoding stops at the end-of-attributes tag");
}

#[test]
fn a_value_with_language_reads_as_its_text() {
    let mut bytes = vec![2, 0, 0, 2, 0, 0, 0, 1, tag::OPERATION];
    let mut value = Vec::new();
    value.extend_from_slice(&2u16.to_be_bytes());
    value.extend_from_slice(b"en");
    value.extend_from_slice(&5u16.to_be_bytes());
    value.extend_from_slice(b"Hello");
    put_item(&mut bytes, tag::NAME_LANG, "job-name", &value);
    bytes.push(tag::END);
    let message = decode(&mut bytes.as_slice()).unwrap();
    assert_eq!(message.op_text("job-name"), Some("Hello"));
}

#[test]
fn an_oversized_attribute_section_is_refused_before_it_is_buffered() {
    let mut bytes = vec![2, 0, 0, 2, 0, 0, 0, 1, tag::OPERATION];
    for _ in 0..40 {
        put_item(&mut bytes, tag::TEXT, "x", &vec![b'a'; 30_000]);
    }
    bytes.push(tag::END);
    assert!(decode(&mut bytes.as_slice()).is_err());
}

#[test]
fn a_chunked_body_is_reassembled_and_trailers_are_consumed() {
    let raw = b"POST /ipp/print HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nExpect: 100-continue\r\n\r\n5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\nTrailer: y\r\n\r\nNEXT";
    let mut reader = BufReader::new(&raw[..]);
    let head = read_head(&mut reader).unwrap().unwrap();
    assert_eq!(head.method, "POST");
    assert_eq!(head.header("expect"), Some("100-continue"));
    let mut body = Body::new(&mut reader, &head).unwrap();
    let mut text = String::new();
    body.read_to_string(&mut text).unwrap();
    assert_eq!(text, "hello world");
    let mut rest = String::new();
    reader.read_to_string(&mut rest).unwrap();
    assert_eq!(rest, "NEXT");
}

#[test]
fn printer_attributes_carry_what_cups_needs_to_build_a_queue() {
    let h = harness("alice", 11_000);
    let reply = ask(&h.printer, &request(op::GET_PRINTER_ATTRIBUTES, vec![]), &[]);
    assert_eq!(reply.code, status::OK);
    for required in [
        "document-format-supported",
        "media-col-database",
        "media-col-default",
        "printer-make-and-model",
        "printer-uri-supported",
        "operations-supported",
        "printer-state",
    ] {
        assert!(reply.attr(tag::PRINTER, required).is_some(), "{required}");
    }
    let formats = reply.attr(tag::PRINTER, "document-format-supported").unwrap();
    assert_eq!(formats.values, vec![Value::Mime("application/pdf".into())]);
    let only = ask(
        &h.printer,
        &request(
            op::GET_PRINTER_ATTRIBUTES,
            vec![Attr::new("requested-attributes", vec![Value::Keyword("printer-state".into())])],
        ),
        &[],
    );
    assert_eq!(only.groups[1].attrs.len(), 1);
    std::fs::remove_dir_all(&h.dir).ok();
}

#[test]
fn a_job_from_another_user_is_refused_and_nothing_is_kept() {
    let h = harness("alice", 11_000);
    let reply = ask(&h.printer, &request(op::PRINT_JOB, vec![user_attr("mallory")]), PDF);
    assert_eq!(reply.code, status::NOT_AUTHORIZED);
    let missing = ask(&h.printer, &request(op::PRINT_JOB, vec![]), PDF);
    assert_eq!(missing.code, status::NOT_AUTHORIZED);
    assert!(h.delivered.try_recv().is_err());
    assert_eq!(std::fs::read_dir(&h.dir).unwrap().count(), 0);
    std::fs::remove_dir_all(&h.dir).ok();
}

#[test]
fn a_print_job_lands_as_a_pdf_and_completes() {
    let h = harness("alice", 11_000);
    let reply = ask(
        &h.printer,
        &request(
            op::PRINT_JOB,
            vec![
                user_attr("alice"),
                Attr::new("job-name", vec![Value::Name("Report".into())]),
                Attr::new("document-format", vec![Value::Mime("application/pdf".into())]),
            ],
        ),
        PDF,
    );
    assert_eq!(reply.code, status::OK);
    assert_eq!(job_attr(&reply, "job-state"), Some(Value::Enum(job_state::COMPLETED)));
    let path = h.delivered.try_recv().expect("the job was delivered");
    assert_eq!(std::fs::read(&path).unwrap(), PDF);
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("Printed ") && name.ends_with(".pdf"), "{name}");
    std::fs::remove_dir_all(&h.dir).ok();
}

#[test]
fn a_document_that_is_not_pdf_is_refused_and_its_reservation_released() {
    let h = harness("alice", 11_000);
    let reply = ask(
        &h.printer,
        &request(op::PRINT_JOB, vec![user_attr("alice")]),
        b"%!PS-Adobe-3.0\nshowpage\n",
    );
    assert_eq!(reply.code, status::FORMAT_ERROR);
    assert!(h.delivered.try_recv().is_err());
    assert_eq!(std::fs::read_dir(&h.dir).unwrap().count(), 0);
    assert_eq!(h.errors.lock().unwrap().len(), 1);
    let postscript = ask(
        &h.printer,
        &request(
            op::VALIDATE_JOB,
            vec![user_attr("alice"), Attr::new("document-format", vec![Value::Mime("application/postscript".into())])],
        ),
        &[],
    );
    assert_eq!(postscript.code, status::FORMAT_NOT_SUPPORTED);
    std::fs::remove_dir_all(&h.dir).ok();
}

#[test]
fn create_job_and_send_document_deliver_every_document() {
    let h = harness("alice", 11_000);
    let created = ask(&h.printer, &request(op::CREATE_JOB, vec![user_attr("alice")]), &[]);
    assert_eq!(created.code, status::OK);
    let Some(Value::Integer(id)) = job_attr(&created, "job-id") else {
        panic!("no job id");
    };
    let send = |last: bool| {
        request(
            op::SEND_DOCUMENT,
            vec![
                user_attr("alice"),
                Attr::new("job-id", vec![Value::Integer(id)]),
                Attr::new("last-document", vec![Value::Boolean(last)]),
            ],
        )
    };
    let first = ask(&h.printer, &send(false), PDF);
    assert_eq!(job_attr(&first, "job-state"), Some(Value::Enum(job_state::PENDING)));
    let second = ask(&h.printer, &send(true), PDF);
    assert_eq!(job_attr(&second, "job-state"), Some(Value::Enum(job_state::COMPLETED)));
    assert!(h.delivered.try_recv().is_ok());
    assert!(h.delivered.try_recv().is_ok());
    let late = ask(&h.printer, &send(true), PDF);
    assert_eq!(late.code, status::NOT_POSSIBLE);
    let listed = ask(
        &h.printer,
        &request(op::GET_JOBS, vec![Attr::new("which-jobs", vec![Value::Keyword("completed".into())])]),
        &[],
    );
    assert_eq!(listed.groups.iter().filter(|g| g.tag == tag::JOB).count(), 1);
    std::fs::remove_dir_all(&h.dir).ok();
}

#[test]
fn a_pending_job_can_be_cancelled_once() {
    let h = harness("alice", 11_000);
    let created = ask(&h.printer, &request(op::CREATE_JOB, vec![user_attr("alice")]), &[]);
    let Some(Value::Integer(id)) = job_attr(&created, "job-id") else {
        panic!("no job id");
    };
    let cancel = request(op::CANCEL_JOB, vec![user_attr("alice"), Attr::new("job-id", vec![Value::Integer(id)])]);
    assert_eq!(ask(&h.printer, &cancel, &[]).code, status::OK);
    assert_eq!(ask(&h.printer, &cancel, &[]).code, status::NOT_POSSIBLE);
    let unknown = request(op::GET_JOB_ATTRIBUTES, vec![Attr::new("job-id", vec![Value::Integer(999)])]);
    assert_eq!(ask(&h.printer, &unknown, &[]).code, status::NOT_FOUND);
    std::fs::remove_dir_all(&h.dir).ok();
}

#[test]
fn the_installer_commands_name_the_queue_uri_and_owner() {
    let args = install_args("Spectra-PDF-alice", "ipp://127.0.0.1:11000/ipp/print", "alice");
    let joined = args.join(" ");
    assert!(joined.contains("-p Spectra-PDF-alice"));
    assert!(joined.contains("-v ipp://127.0.0.1:11000/ipp/print"));
    assert!(joined.contains("-m everywhere"));
    assert!(joined.contains("-u allow:alice"));
    assert!(joined.contains("printer-is-shared=false"));
    assert!(joined.contains("-o printer-error-policy=abort-job"));
    assert_eq!(args.last().map(String::as_str), Some("-E"), "-E after -p enables the queue");
    assert_eq!(remove_args("Spectra-PDF-alice"), vec!["-x", "Spectra-PDF-alice"]);
    assert_eq!(
        shell_line(Path::new("/usr/sbin/lpadmin"), &["-D".into(), "Spectra PDF".into()]),
        "/usr/sbin/lpadmin -D 'Spectra PDF'"
    );
}

#[test]
fn elevation_outcomes_are_named() {
    assert!(refused_for_rights("lpadmin: Forbidden"));
    assert!(refused_for_rights("lpadmin: Unauthorized"));
    assert!(!refused_for_rights("lpadmin: Unable to connect to \"ipp://x\""));
    assert_eq!(pkexec_refusal(Some(0), "", "cmd"), None);
    assert!(pkexec_refusal(Some(126), "", "cmd").unwrap().contains("declined"));
    assert!(pkexec_refusal(Some(127), "", "lpadmin -x Q").unwrap().contains("lpadmin -x Q"));
    assert_eq!(pkexec_refusal(Some(1), "lpadmin: bad", "cmd").unwrap(), "lpadmin: bad");
}

#[test]
fn the_printed_folder_is_private_to_its_owner() {
    use std::os::unix::fs::PermissionsExt;
    let root = scratch("private");
    let dir = root.join("a").join("b");
    private_dir(&dir).unwrap();
    let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
    let link = root.join("link");
    std::os::unix::fs::symlink(&dir, &link).unwrap();
    assert!(private_dir(&link).is_err(), "a symbolic link is not the folder");
    std::fs::remove_dir_all(&root).ok();
}

/// Bind an ephemeral loopback port and serve the harness's printer on it.
fn serve_ephemeral(user: &str) -> (Harness, u16) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let h = harness(user, port);
    let printer = h.printer.clone();
    std::thread::spawn(move || serve(listener, printer));
    (h, port)
}

#[test]
fn a_chunked_print_job_over_http_is_answered_on_a_kept_alive_connection() {
    let (h, port) = serve_ephemeral("alice");
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut ipp = encode(&request(op::PRINT_JOB, vec![user_attr("alice")]));
    ipp.extend_from_slice(PDF);
    let mut wire = b"POST /ipp/print HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/ipp\r\nTransfer-Encoding: chunked\r\nExpect: 100-continue\r\n\r\n".to_vec();
    for chunk in ipp.chunks(37) {
        wire.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
        wire.extend_from_slice(chunk);
        wire.extend_from_slice(b"\r\n");
    }
    wire.extend_from_slice(b"0\r\n\r\n");
    stream.write_all(&wire).unwrap();
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.starts_with("HTTP/1.1 100"), "{line}");
    reader.read_line(&mut line).unwrap();
    let mut status_line = String::new();
    reader.read_line(&mut status_line).unwrap();
    assert!(status_line.starts_with("HTTP/1.1 200"), "{status_line}");
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).unwrap();
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some(v) = header.strip_prefix("Content-Length: ") {
            length = v.parse().unwrap();
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).unwrap();
    let reply = decode(&mut body.as_slice()).unwrap();
    assert_eq!(reply.code, status::OK);
    assert!(h.delivered.recv_timeout(Duration::from_secs(5)).is_ok());

    // The same connection carries a second request.
    let ipp = encode(&request(op::GET_PRINTER_ATTRIBUTES, vec![]));
    let head = format!(
        "POST /ipp/print HTTP/1.1\r\nHost: x\r\nContent-Type: application/ipp\r\nContent-Length: {}\r\n\r\n",
        ipp.len()
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(&ipp).unwrap();
    let mut second = String::new();
    reader.read_line(&mut second).unwrap();
    assert!(second.starts_with("HTTP/1.1 200"), "{second}");
    std::fs::remove_dir_all(&h.dir).ok();
}

// ── against the system's libcups ────────────────────────────────────────────
//
// These drive this printer with the CUPS client library itself: the same
// Get-Printer-Attributes and PPD generation `lpadmin -m everywhere` performs,
// the destination API the Print dialog's capability report uses, and the
// Create-Job / Send-Document sequence an IPP client submits with. A machine
// without libcups skips them.

type ConnectDest = unsafe extern "C" fn(
    *mut crate::cups_linux::CupsDest,
    u32,
    c_int,
    *mut c_int,
    *mut c_char,
    usize,
    *mut c_void,
    *mut c_void,
) -> *mut c_void;
type HttpClose = unsafe extern "C" fn(*mut c_void);
type IppNewRequest = unsafe extern "C" fn(c_int) -> *mut c_void;
type IppAddString =
    unsafe extern "C" fn(*mut c_void, c_int, c_int, *const c_char, *const c_char, *const c_char) -> *mut c_void;
type IppAddStrings = unsafe extern "C" fn(
    *mut c_void,
    c_int,
    c_int,
    *const c_char,
    c_int,
    *const c_char,
    *const *const c_char,
) -> *mut c_void;
type DoRequest = unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void;
type IppDelete = unsafe extern "C" fn(*mut c_void);
type PpdCreate = unsafe extern "C" fn(*mut c_char, usize, *mut c_void) -> *mut c_char;
type CreateDestJob = unsafe extern "C" fn(
    *mut c_void,
    *mut crate::cups_linux::CupsDest,
    *mut c_void,
    *mut c_int,
    *const c_char,
    c_int,
    *mut c_void,
) -> c_int;
type StartDestDocument = unsafe extern "C" fn(
    *mut c_void,
    *mut crate::cups_linux::CupsDest,
    *mut c_void,
    c_int,
    *const c_char,
    *const c_char,
    c_int,
    *mut c_void,
    c_int,
) -> c_int;
type WriteRequestData = unsafe extern "C" fn(*mut c_void, *const c_char, usize) -> c_int;
type FinishDestDocument =
    unsafe extern "C" fn(*mut c_void, *mut crate::cups_linux::CupsDest, *mut c_void) -> c_int;
type CopyDestInfo = unsafe extern "C" fn(*mut c_void, *mut crate::cups_linux::CupsDest) -> *mut c_void;
type FreeDestInfo = unsafe extern "C" fn(*mut c_void);

fn sym<T: Copy>(handle: *mut c_void, name: &str) -> T {
    let name = CString::new(name).unwrap();
    let found = unsafe { libc::dlsym(handle, name.as_ptr()) };
    assert!(!found.is_null(), "libcups has {name:?}");
    unsafe { std::mem::transmute_copy::<*mut c_void, T>(&found) }
}

/// The served printer, a URI destination for it, and a connection to it.
struct Live {
    h: Harness,
    uri: String,
    cups: &'static crate::cups_linux::Cups,
}

fn live() -> Option<Live> {
    let Ok(cups) = crate::cups_linux::cups() else {
        eprintln!("libcups is not installed; skipping");
        return None;
    };
    let user = current_user().expect("the test user has a passwd entry");
    let (h, port) = serve_ephemeral(&user);
    Some(Live {
        h,
        uri: device_uri(port),
        cups,
    })
}

fn connect(live: &Live, dest: &crate::cups_linux::CupsDest) -> *mut c_void {
    let connect: ConnectDest = sym(live.cups.handle(), "cupsConnectDest");
    let mut resource = [0 as c_char; 256];
    let http = unsafe {
        connect(
            dest as *const _ as *mut _,
            0x80,
            10_000,
            std::ptr::null_mut(),
            resource.as_mut_ptr(),
            resource.len(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    assert!(!http.is_null(), "cupsConnectDest reached the printer");
    http
}

#[test]
fn cups_generates_an_everywhere_ppd_from_this_printer() {
    let Some(live) = live() else { return };
    let handle = live.cups.handle();
    let dests = live.cups.destination_for_uri(&live.uri).unwrap();
    let dest = dests.iter().next().unwrap();
    let http = connect(&live, dest);
    let new_request: IppNewRequest = sym(handle, "ippNewRequest");
    let add_string: IppAddString = sym(handle, "ippAddString");
    let add_strings: IppAddStrings = sym(handle, "ippAddStrings");
    let do_request: DoRequest = sym(handle, "cupsDoRequest");
    let delete: IppDelete = sym(handle, "ippDelete");
    let create_ppd: PpdCreate = sym(handle, "_ppdCreateFromIPP");
    let close: HttpClose = sym(handle, "httpClose");
    let uri = CString::new(live.uri.clone()).unwrap();
    let printer_uri = CString::new("printer-uri").unwrap();
    let requested = CString::new("requested-attributes").unwrap();
    let all = CString::new("all").unwrap();
    let database = CString::new("media-col-database").unwrap();
    let names = [all.as_ptr(), database.as_ptr()];
    let resource = CString::new(RESOURCE).unwrap();
    let mut path = [0 as c_char; 1024];
    let ppd = unsafe {
        let request = new_request(op::GET_PRINTER_ATTRIBUTES as c_int);
        add_string(request, 1, 0x45, printer_uri.as_ptr(), std::ptr::null(), uri.as_ptr());
        add_strings(request, 1, 0x44, requested.as_ptr(), 2, std::ptr::null(), names.as_ptr());
        let response = do_request(http, request, resource.as_ptr());
        assert!(!response.is_null(), "{:?}", live.cups.last_error());
        let made = create_ppd(path.as_mut_ptr(), path.len(), response);
        delete(response);
        close(http);
        assert!(!made.is_null(), "CUPS built no PPD: {:?}", live.cups.last_error());
        let file = CStr::from_ptr(path.as_ptr()).to_string_lossy().into_owned();
        let text = std::fs::read_to_string(&file).unwrap();
        let _ = std::fs::remove_file(&file);
        text
    };
    assert!(ppd.contains("*cupsFilter2: \"application/vnd.cups-pdf application/pdf 10 -\""), "{ppd}");
    assert!(ppd.contains("*PageSize A4") && ppd.contains("*PageSize Letter"), "{ppd}");
    assert!(ppd.contains("*ColorDevice: True"));
    assert!(ppd.contains("*CustomPageSize True"));
    std::fs::remove_dir_all(&live.h.dir).ok();
}

#[test]
fn the_print_dialog_capability_report_reads_this_printer() {
    let Some(live) = live() else { return };
    let dests = live.cups.destination_for_uri(&live.uri).unwrap();
    let dest = dests.iter().next().unwrap();
    let http = connect(&live, dest);
    let caps = {
        let info = dests.info_over(http, dest).unwrap();
        crate::printers::capabilities_of(&info)
    };
    let close: HttpClose = sym(live.cups.handle(), "httpClose");
    unsafe { close(http) };
    let ids: Vec<&str> = caps.papers.iter().map(|p| p.id.as_str()).collect();
    assert!(ids.contains(&"iso_a4_210x297mm") && ids.contains(&"na_letter_8.5x11in"), "{ids:?}");
    let a4 = caps.papers.iter().find(|p| p.id == "iso_a4_210x297mm").unwrap();
    assert!((a4.width_pt - 595.28).abs() < 0.01 && (a4.height_pt - 841.89).abs() < 0.01);
    assert!(caps.default_paper.is_some());
    assert!(!caps.duplex);
    assert!(caps.color);
    assert_eq!(caps.max_copies, 999);
    std::fs::remove_dir_all(&live.h.dir).ok();
}

#[test]
fn an_ipp_client_job_submitted_through_libcups_opens_as_its_pdf() {
    let Some(live) = live() else { return };
    let handle = live.cups.handle();
    let dests = live.cups.destination_for_uri(&live.uri).unwrap();
    let dest = dests.iter().next().unwrap();
    let dest_ptr = dest as *const _ as *mut crate::cups_linux::CupsDest;
    let http = connect(&live, dest);
    let copy_info: CopyDestInfo = sym(handle, "cupsCopyDestInfo");
    let free_info: FreeDestInfo = sym(handle, "cupsFreeDestInfo");
    let create: CreateDestJob = sym(handle, "cupsCreateDestJob");
    let start: StartDestDocument = sym(handle, "cupsStartDestDocument");
    let write: WriteRequestData = sym(handle, "cupsWriteRequestData");
    let finish: FinishDestDocument = sym(handle, "cupsFinishDestDocument");
    let close: HttpClose = sym(handle, "httpClose");
    let title = CString::new("Quarterly report").unwrap();
    let format = CString::new("application/pdf").unwrap();
    unsafe {
        let info = copy_info(http, dest_ptr);
        assert!(!info.is_null(), "{:?}", live.cups.last_error());
        let mut job: c_int = 0;
        let created = create(http, dest_ptr, info, &mut job, title.as_ptr(), 0, std::ptr::null_mut());
        assert!(created <= 0xFF && job > 0, "create: {created:#x} {:?}", live.cups.last_error());
        let started = start(http, dest_ptr, info, job, title.as_ptr(), format.as_ptr(), 0, std::ptr::null_mut(), 1);
        assert_eq!(started, 100, "{:?}", live.cups.last_error());
        assert_eq!(write(http, PDF.as_ptr() as *const c_char, PDF.len()), 100);
        let finished = finish(http, dest_ptr, info);
        assert!(finished <= 0xFF, "finish: {finished:#x} {:?}", live.cups.last_error());
        free_info(info);
        close(http);
    }
    let path = live.h.delivered.recv_timeout(Duration::from_secs(10)).expect("delivered");
    assert_eq!(std::fs::read(&path).unwrap(), PDF);
    std::fs::remove_dir_all(&live.h.dir).ok();
}

/// A `/proc/net/tcp` endpoint for an address, as this host's kernel prints it.
fn endpoint(addr: [u8; 4], port: u16) -> String {
    format!("{:08X}:{port:04X}", u32::from_ne_bytes(addr))
}

fn tcp_table(rows: &[(String, String, &str, u32)]) -> String {
    let mut table = String::from(
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n",
    );
    for (i, (local, remote, state, uid)) in rows.iter().enumerate() {
        table.push_str(&format!(
            "{i:4}: {local} {remote} {state} 00000000:00000000 00:00000000 00000000  {uid:5}        0 {} 1 0000000000000000 20 4 30 10 -1\n",
            1000 + i
        ));
    }
    table
}

#[test]
fn the_client_socket_row_names_the_connecting_account() {
    let lo = [127, 0, 0, 1];
    let server = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 11_000);
    let client = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 45_678);
    let table = tcp_table(&[
        // The listener and this server's own end of the connection.
        (endpoint(lo, 11_000), endpoint([0, 0, 0, 0], 0), "0A", 1000),
        (endpoint(lo, 11_000), endpoint(lo, 45_678), "01", 1000),
        // The client's end, owned by another account.
        (endpoint(lo, 45_678), endpoint(lo, 11_000), "01", 1001),
    ]);
    assert_eq!(peer_uid_in(&table, client, server), Some(1001));
    let other = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 45_679);
    assert_eq!(peer_uid_in(&table, other, server), None);
}

#[test]
fn a_time_wait_row_never_reads_as_root() {
    let lo = [127, 0, 0, 1];
    let server = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 11_000);
    let client = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 45_678);
    let table = tcp_table(&[(endpoint(lo, 45_678), endpoint(lo, 11_000), "06", 0)]);
    assert_eq!(peer_uid_in(&table, client, server), None);
    let closing = tcp_table(&[(endpoint(lo, 45_678), endpoint(lo, 11_000), "05", 1001)]);
    assert_eq!(peer_uid_in(&closing, client, server), Some(1001));
}

#[cfg(target_endian = "little")]
#[test]
fn a_kernel_row_parses_as_printed() {
    let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   3: 0100007F:B26E 0100007F:2AF8 01 00000000:00000000 00:00000000 00000000   112        0 98765 1 0000000000000000 20 4 30 10 -1\n";
    let client = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0xB26E);
    let server = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0x2AF8);
    assert_eq!(peer_uid_in(table, client, server), Some(112));
}

#[test]
fn only_root_the_cups_account_and_the_owner_are_admitted() {
    assert_eq!(cups_user_name(None), "lp");
    assert_eq!(cups_user_name(Some("# User nobody\nGroup lp\nUser cupsys\n")), "cupsys");
    assert_eq!(cups_user_name(Some("Group lp\n")), "lp");
    let admitted = admitted_uids(1000, Some(7));
    assert_eq!(admitted, vec![0, 7, 1000]);
    let h = harness("alice", 11_000);
    let own = unsafe { libc::geteuid() };
    assert!(h.printer.admits(Some(own)));
    assert!(h.printer.admits(Some(0)));
    assert!(!h.printer.admits(None), "an unidentified client is refused");
    let stranger = (1..u32::MAX).find(|u| !h.printer.admitted.contains(u)).unwrap();
    assert!(!h.printer.admits(Some(stranger)));
    std::fs::remove_dir_all(&h.dir).ok();
}

#[test]
fn the_accept_loop_identifies_this_process_as_its_own_client() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (accepted, _) = listener.accept().unwrap();
    assert_eq!(peer_uid(&accepted), Some(unsafe { libc::geteuid() }));
    drop(client);
}

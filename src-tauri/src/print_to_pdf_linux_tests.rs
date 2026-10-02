use super::*;
use std::cell::{Cell, RefCell};
use std::ffi::{c_void, CString};
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};

const PDF: &[u8] = b"%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
const PS: &[u8] = b"%!PS\n/Helvetica findfont 24 scalefont setfont\n72 700 moveto (HELD) show\nshowpage\n";
const USER: &str = "alice";
const QUEUE: &str = "Spectra-PDF-alice";

// ── a scheduler that answers from a model ───────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fetch {
    Data,
    /// HTTP 403: libcups returns no response at all.
    Refused,
    /// The response says 'client-error-not-authorized'.
    NotAuthorized,
    /// The response says 'client-error-not-found'.
    Gone,
    Fail,
}

#[derive(Clone)]
struct FakeJob {
    id: i32,
    created: i32,
    state: i32,
    reasons: Vec<&'static str>,
    owner: String,
    /// Format and data of each document.
    docs: Vec<(String, Vec<u8>)>,
    fetch: Fetch,
    /// Fail only this document number.
    fail_document: Option<u32>,
    k_octets: Option<i32>,
}

fn job(id: i32, docs: Vec<(&str, &[u8])>) -> FakeJob {
    FakeJob {
        id,
        created: 1_700_000_000 + id,
        state: job_state::HELD,
        reasons: vec!["job-hold-until-specified"],
        owner: USER.to_string(),
        docs: docs
            .into_iter()
            .map(|(format, data)| (format.to_string(), data.to_vec()))
            .collect(),
        fetch: Fetch::Data,
        fail_document: None,
        k_octets: None,
    }
}

fn pdf_job(id: i32) -> FakeJob {
    job(id, vec![("application/pdf", PDF)])
}

fn held_facts(user: &str) -> QueueFacts {
    QueueFacts {
        device_uri: SINK_URI.to_string(),
        hold_default: "indefinite".to_string(),
        sheets: vec!["none".to_string(), "none".to_string()],
        error_policy: "stop-printer".to_string(),
        accepting: true,
        shared: false,
        op_policy: "authenticated".to_string(),
        state: 5,
        allowed: vec![user.to_string()],
        denied: Vec::new(),
    }
}

struct FakeCups {
    queue: RefCell<Option<QueueFacts>>,
    /// Other queue names CUPS-Get-Printers lists.
    others: RefCell<Vec<String>>,
    jobs: RefCell<Vec<FakeJob>>,
    fetched: RefCell<Vec<(i32, u32)>>,
    cancels: RefCell<Vec<i32>>,
    refuse_cancel: RefCell<HashSet<i32>>,
    down: RefCell<Option<String>>,
    listing_fails: Cell<bool>,
    /// List every job whatever `my-jobs` says.
    ignores_my_jobs: Cell<bool>,
    requests: RefCell<Vec<Message>>,
}

impl FakeCups {
    fn held() -> Self {
        Self::with_queue(Some(held_facts(USER)))
    }

    fn with_queue(queue: Option<QueueFacts>) -> Self {
        Self {
            queue: RefCell::new(queue),
            others: RefCell::new(Vec::new()),
            jobs: RefCell::new(Vec::new()),
            fetched: RefCell::new(Vec::new()),
            cancels: RefCell::new(Vec::new()),
            refuse_cancel: RefCell::new(HashSet::new()),
            down: RefCell::new(None),
            listing_fails: Cell::new(false),
            ignores_my_jobs: Cell::new(false),
            requests: RefCell::new(Vec::new()),
        }
    }

    fn add(&self, job: FakeJob) {
        self.jobs.borrow_mut().push(job);
    }

    fn left(&self) -> Vec<i32> {
        self.jobs.borrow().iter().map(|job| job.id).collect()
    }

    fn operations(&self) -> Vec<u16> {
        self.requests.borrow().iter().map(|r| r.code).collect()
    }

    fn reply(code: u16, groups: Vec<Group>) -> Vec<u8> {
        let mut all = vec![Group {
            tag: tag::OPERATION,
            attrs: vec![
                Attr::new("attributes-charset", vec![Value::Charset("utf-8".into())]),
                Attr::new("attributes-natural-language", vec![Value::Language("en".into())]),
            ],
        }];
        all.extend(groups);
        encode(&Message {
            version: (2, 0),
            code,
            request_id: REQUEST_ID,
            groups: all,
        })
    }

    fn answer(&self, request: &[u8], out: Option<&File>) -> Result<Vec<u8>, Refusal> {
        if let Some(e) = self.down.borrow().clone() {
            return Err(Refusal::Unavailable(e));
        }
        let message = decode(&mut &request[..]).expect("requests decode");
        let user = message.op_text("requesting-user-name").unwrap_or("").to_string();
        self.requests.borrow_mut().push(message.clone());
        let kw = |s: &str| Value::Keyword(s.to_string());
        match message.code {
            op::GET_PRINTER_ATTRIBUTES => {
                assert_eq!(message.op_text("printer-uri"), Some(printer_uri(QUEUE).as_str()));
                let Some(facts) = self.queue.borrow().clone() else {
                    return Ok(Self::reply(status::NOT_FOUND, Vec::new()));
                };
                let mut attrs = vec![
                    Attr::new("device-uri", vec![Value::Uri(facts.device_uri)]),
                    Attr::new("job-hold-until-default", vec![kw(&facts.hold_default)]),
                    Attr::new("printer-error-policy", vec![Value::Name(facts.error_policy)]),
                    Attr::new("printer-is-accepting-jobs", vec![Value::Boolean(facts.accepting)]),
                    Attr::new("printer-is-shared", vec![Value::Boolean(facts.shared)]),
                    Attr::new("printer-op-policy", vec![Value::Name(facts.op_policy)]),
                    Attr::new("printer-state", vec![Value::Enum(facts.state)]),
                ];
                if !facts.sheets.is_empty() {
                    attrs.push(Attr::new(
                        "job-sheets-default",
                        facts.sheets.into_iter().map(Value::Name).collect(),
                    ));
                }
                if !facts.allowed.is_empty() {
                    attrs.push(Attr::new(
                        "requesting-user-name-allowed",
                        facts.allowed.into_iter().map(Value::Name).collect(),
                    ));
                }
                if !facts.denied.is_empty() {
                    attrs.push(Attr::new(
                        "requesting-user-name-denied",
                        facts.denied.into_iter().map(Value::Name).collect(),
                    ));
                }
                Ok(Self::reply(status::OK, vec![Group { tag: tag::PRINTER, attrs }]))
            }
            op::GET_JOBS => {
                assert_eq!(message.op_text("which-jobs"), Some("not-completed"));
                assert_eq!(
                    message
                        .attr(tag::OPERATION, "my-jobs")
                        .and_then(|a| a.values.first())
                        .and_then(Value::boolean),
                    Some(true)
                );
                if self.listing_fails.get() {
                    return Ok(Self::reply(0x0500, Vec::new()));
                }
                let groups = self
                    .jobs
                    .borrow()
                    .iter()
                    .filter(|job| self.ignores_my_jobs.get() || job.owner == user)
                    .map(|job| {
                        let k_octets = job.k_octets.unwrap_or_else(|| {
                            job.docs.iter().map(|(_, d)| ((d.len() + 1023) / 1024) as i32).sum()
                        });
                        Group {
                            tag: tag::JOB,
                            attrs: vec![
                                Attr::new("job-id", vec![Value::Integer(job.id)]),
                                Attr::new("job-k-octets", vec![Value::Integer(k_octets)]),
                                Attr::new("job-originating-user-name", vec![Value::Name(job.owner.clone())]),
                                Attr::new("job-state", vec![Value::Enum(job.state)]),
                                Attr::new(
                                    "job-state-reasons",
                                    job.reasons.iter().map(|r| kw(r)).collect(),
                                ),
                                Attr::new(
                                    "number-of-documents",
                                    vec![Value::Integer(job.docs.len() as i32)],
                                ),
                                Attr::new("time-at-creation", vec![Value::Integer(job.created)]),
                            ],
                        }
                    })
                    .collect();
                Ok(Self::reply(status::OK, groups))
            }
            op::CUPS_GET_DOCUMENT => {
                let id = message.op_integer("job-id").expect("a job id");
                let document = message.op_integer("document-number").expect("a document number") as u32;
                self.fetched.borrow_mut().push((id, document));
                let jobs = self.jobs.borrow();
                let Some(job) = jobs.iter().find(|job| job.id == id) else {
                    return Ok(Self::reply(status::NOT_FOUND, Vec::new()));
                };
                let mode = if job.fail_document.is_none_or(|n| n == document) {
                    job.fetch
                } else {
                    Fetch::Data
                };
                match mode {
                    Fetch::Refused => return Err(Refusal::Denied("Forbidden".into())),
                    Fetch::Fail => return Err(Refusal::Failed("simulated failure".into())),
                    Fetch::Gone => return Ok(Self::reply(status::NOT_FOUND, Vec::new())),
                    Fetch::NotAuthorized => return Ok(Self::reply(status::NOT_AUTHORIZED, Vec::new())),
                    Fetch::Data => {}
                }
                let (format, data) = &job.docs[document as usize - 1];
                (&mut out.expect("a document sink")).write_all(data).unwrap();
                Ok(Self::reply(
                    status::OK,
                    vec![Group {
                        tag: tag::JOB,
                        attrs: vec![
                            Attr::new("document-format", vec![Value::Mime(format.clone())]),
                            Attr::new("document-number", vec![Value::Integer(document as i32)]),
                        ],
                    }],
                ))
            }
            op::CANCEL_JOB => {
                let id = message.op_integer("job-id").expect("a job id");
                assert_eq!(
                    message
                        .attr(tag::OPERATION, "purge-job")
                        .and_then(|a| a.values.first())
                        .and_then(Value::boolean),
                    Some(true),
                    "the cancel purges the job's files"
                );
                if self.refuse_cancel.borrow().contains(&id) {
                    return Ok(Self::reply(status::NOT_POSSIBLE, Vec::new()));
                }
                let before = self.jobs.borrow().len();
                self.jobs.borrow_mut().retain(|job| job.id != id);
                if self.jobs.borrow().len() == before {
                    return Ok(Self::reply(status::NOT_FOUND, Vec::new()));
                }
                self.cancels.borrow_mut().push(id);
                Ok(Self::reply(status::OK, Vec::new()))
            }
            op::CUPS_GET_PRINTERS => {
                let mut names = vec![QUEUE.to_string()];
                names.extend(self.others.borrow().iter().cloned());
                let groups = names
                    .into_iter()
                    .map(|name| Group {
                        tag: tag::PRINTER,
                        attrs: vec![Attr::new("printer-name", vec![Value::Name(name)])],
                    })
                    .collect();
                Ok(Self::reply(status::OK, groups))
            }
            other => panic!("unexpected operation {other:#06x}"),
        }
    }
}

impl Scheduler for FakeCups {
    fn exchange(&self, request: &[u8]) -> Result<Vec<u8>, Refusal> {
        self.answer(request, None)
    }

    fn exchange_document(&self, request: &[u8], out: &File) -> Result<Vec<u8>, Refusal> {
        self.answer(request, Some(out))
    }
}

/// Stands in for the gzip expander: a "compressed" document is the payload
/// behind the two gzip magic bytes.
fn strip_magic(from: &Path, to: &mut dyn Write, limit: u64) -> Result<u64, String> {
    let data = std::fs::read(from).map_err(|e| e.to_string())?;
    let payload = &data[2..];
    let take = (payload.len() as u64).min(limit + 1) as usize;
    to.write_all(&payload[..take]).map_err(|e| e.to_string())?;
    Ok(take as u64)
}

struct Folders {
    _dir: tempfile::TempDir,
    staging: PathBuf,
    ledger: PathBuf,
}

fn folders() -> Folders {
    let dir = tempfile::tempdir().unwrap();
    let staging = dir.path().join(STAGING_DIR);
    let ledger = dir.path().join(LEDGER_DIR);
    std::fs::create_dir(&staging).unwrap();
    std::fs::create_dir(&ledger).unwrap();
    Folders {
        _dir: dir,
        staging,
        ledger,
    }
}

fn run_pass(fake: &FakeCups, f: &Folders, taker: &mut Taker) -> (Result<QueueKind, String>, Vec<String>) {
    let errors = RefCell::new(Vec::new());
    let record = |e: String| errors.borrow_mut().push(e);
    let pass = Pass {
        scheduler: fake,
        user: USER,
        queue: QUEUE,
        staging: &f.staging,
        ledger: &f.ledger,
        record_error: &record,
        expand: &strip_magic,
    };
    let kind = take_jobs(&pass, taker);
    (kind, errors.into_inner())
}

fn pass_ok(fake: &FakeCups, f: &Folders, taker: &mut Taker) -> Vec<String> {
    let (kind, errors) = run_pass(fake, f, taker);
    assert_eq!(kind, Ok(QueueKind::Held));
    errors
}

fn names(dir: &Path) -> std::collections::BTreeSet<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect()
}

fn staged(f: &Folders) -> std::collections::BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(&f.staging)
        .unwrap()
        .flatten()
        .map(|entry| {
            (
                entry.file_name().into_string().unwrap(),
                std::fs::read(entry.path()).unwrap(),
            )
        })
        .collect()
}

fn key(id: i32) -> String {
    format!("Printed {}-{:010}", 1_700_000_000 + id, id)
}

fn taken(f: &Folders, id: i32) -> bool {
    f.ledger.join(format!("{}{TAKEN_SUFFIX}", key(id))).exists()
}

// ── taking jobs ─────────────────────────────────────────────────────────────

#[test]
fn two_jobs_printed_back_to_back_are_both_staged_and_neither_overwrites_the_other() {
    let f = folders();
    let fake = FakeCups::held();
    fake.add(job(7, vec![("application/pdf", b"%PDF-1.7 first")]));
    fake.add(job(8, vec![("application/pdf", b"%PDF-1.7 second")]));
    let errors = pass_ok(&fake, &f, &mut Taker::default());
    assert!(errors.is_empty(), "{errors:?}");
    let files = staged(&f);
    assert_eq!(files.len(), 2, "{files:?}");
    assert_eq!(files[&format!("{}001.pdf", key(7))], b"%PDF-1.7 first");
    assert_eq!(files[&format!("{}001.pdf", key(8))], b"%PDF-1.7 second");
    assert_eq!(*fake.cancels.borrow(), [7, 8]);
    assert!(taken(&f, 7) && taken(&f, 8));
    assert!(fake.left().is_empty());
}

#[test]
fn a_backlog_printed_while_the_app_was_closed_is_taken_whole_in_one_pass() {
    let f = folders();
    let fake = FakeCups::held();
    for id in 1..=5 {
        fake.add(pdf_job(id));
    }
    pass_ok(&fake, &f, &mut Taker::default());
    assert_eq!(staged(&f).len(), 5);
    assert_eq!(*fake.cancels.borrow(), [1, 2, 3, 4, 5]);
    assert_eq!(*fake.fetched.borrow(), [(1, 1), (2, 1), (3, 1), (4, 1), (5, 1)]);
}

#[test]
fn a_job_still_receiving_documents_is_left_until_its_last_one_arrived() {
    let f = folders();
    let fake = FakeCups::held();
    let mut incoming = pdf_job(3);
    incoming.reasons = vec!["job-incoming", "job-hold-until-specified"];
    fake.add(incoming);
    let mut taker = Taker::default();
    pass_ok(&fake, &f, &mut taker);
    assert!(fake.fetched.borrow().is_empty());
    assert_eq!(fake.left(), [3]);
    fake.jobs.borrow_mut()[0].reasons = vec!["job-hold-until-specified"];
    pass_ok(&fake, &f, &mut taker);
    assert_eq!(staged(&f).len(), 1);
    assert!(fake.left().is_empty());
}

#[test]
fn a_job_that_asked_for_no_hold_waits_pending_on_the_stopped_queue_and_is_taken() {
    let f = folders();
    let fake = FakeCups::held();
    let mut pending = pdf_job(4);
    pending.state = job_state::PENDING;
    pending.reasons = vec!["printer-stopped"];
    fake.add(pending);
    pass_ok(&fake, &f, &mut Taker::default());
    assert_eq!(staged(&f).len(), 1);
    assert_eq!(*fake.cancels.borrow(), [4]);
}

#[test]
fn a_job_with_several_documents_stages_each_and_is_cancelled_once() {
    let f = folders();
    let fake = FakeCups::held();
    fake.add(job(
        9,
        vec![
            ("application/pdf", b"%PDF-1.7 one"),
            ("application/postscript", b"%!PS two"),
            ("application/pdf", b"%PDF-1.7 three"),
        ],
    ));
    pass_ok(&fake, &f, &mut Taker::default());
    let files = staged(&f);
    assert_eq!(
        files.keys().cloned().collect::<Vec<_>>(),
        [
            format!("{}001.pdf", key(9)),
            format!("{}002.ps", key(9)),
            format!("{}003.pdf", key(9)),
        ]
    );
    assert_eq!(*fake.cancels.borrow(), [9]);
    assert_eq!(names(&f.ledger).len(), 1, "one entry per job");
}

#[test]
fn job_sheets_and_empty_documents_are_skipped() {
    let f = folders();
    let fake = FakeCups::held();
    fake.add(job(
        5,
        vec![
            ("application/vnd.cups-banner", b"#CUPS-BANNER\n"),
            ("application/pdf", b""),
            ("application/pdf", PDF),
            ("application/vnd.cups-banner", b"#CUPS-BANNER\n"),
        ],
    ));
    let errors = pass_ok(&fake, &f, &mut Taker::default());
    assert!(errors.is_empty(), "{errors:?}");
    assert_eq!(
        staged(&f).keys().cloned().collect::<Vec<_>>(),
        [format!("{}003.pdf", key(5))]
    );
    assert_eq!(*fake.cancels.borrow(), [5]);
}

#[test]
fn an_empty_job_is_removed_without_a_staged_file() {
    let f = folders();
    let fake = FakeCups::held();
    fake.add(job(6, Vec::new()));
    fake.add(job(7, vec![("application/pdf", b"")]));
    let errors = pass_ok(&fake, &f, &mut Taker::default());
    assert!(errors.is_empty(), "{errors:?}");
    assert!(staged(&f).is_empty());
    assert_eq!(*fake.cancels.borrow(), [6, 7]);
}

#[test]
fn a_document_in_another_format_is_refused_by_name_and_its_job_removed() {
    let f = folders();
    let fake = FakeCups::held();
    fake.add(job(
        11,
        vec![("text/plain", b"plain words"), ("application/pdf", PDF)],
    ));
    let errors = pass_ok(&fake, &f, &mut Taker::default());
    assert_eq!(
        errors,
        [format!(
            "a print job arrived as text/plain data, which Spectra PDF does not convert; it was removed from {QUEUE}"
        )]
    );
    assert_eq!(
        staged(&f).keys().cloned().collect::<Vec<_>>(),
        [format!("{}002.pdf", key(11))]
    );
    assert_eq!(*fake.cancels.borrow(), [11]);
}

#[test]
fn a_document_typed_pdf_that_is_not_pdf_is_refused() {
    let f = folders();
    let fake = FakeCups::held();
    fake.add(job(12, vec![("application/pdf", b"GIF89a not a pdf")]));
    let errors = pass_ok(&fake, &f, &mut Taker::default());
    assert_eq!(errors.len(), 1);
    assert!(errors[0].contains("does not begin as that format"), "{errors:?}");
    assert!(staged(&f).is_empty());
    assert_eq!(*fake.cancels.borrow(), [12]);
    assert!(taken(&f, 12));
}

#[test]
fn a_job_over_the_limit_is_removed_and_named_without_a_read() {
    let f = folders();
    let fake = FakeCups::held();
    let mut huge = pdf_job(13);
    huge.k_octets = Some((MAX_JOB_BYTES / 1024) as i32 + 64);
    fake.add(huge);
    let errors = pass_ok(&fake, &f, &mut Taker::default());
    assert_eq!(errors.len(), 1);
    assert!(errors[0].contains("over the"), "{errors:?}");
    assert!(fake.fetched.borrow().is_empty());
    assert_eq!(*fake.cancels.borrow(), [13]);
}

#[test]
fn a_job_whose_cancel_fails_is_named_once_and_never_read_again() {
    let f = folders();
    let fake = FakeCups::held();
    fake.add(pdf_job(14));
    fake.refuse_cancel.borrow_mut().insert(14);
    let mut taker = Taker::default();
    let first = pass_ok(&fake, &f, &mut taker);
    assert_eq!(first.len(), 1);
    assert!(first[0].contains("is not taken a second time"), "{first:?}");
    assert_eq!(staged(&f).len(), 1);
    let second = pass_ok(&fake, &f, &mut taker);
    assert!(second.is_empty(), "named once per process: {second:?}");
    assert_eq!(fake.fetched.borrow().len(), 1);
    // A restart: the ledger still keeps the job from a second read, and the
    // cancel is tried once more.
    let mut restarted = Taker::default();
    let third = pass_ok(&fake, &f, &mut restarted);
    assert_eq!(third.len(), 1);
    assert_eq!(fake.fetched.borrow().len(), 1);
    assert_eq!(staged(&f).len(), 1);
}

#[test]
fn the_ledger_forgets_a_job_once_its_queue_lists_it_no_more() {
    let f = folders();
    let fake = FakeCups::held();
    fake.add(pdf_job(15));
    fake.refuse_cancel.borrow_mut().insert(15);
    let mut taker = Taker::default();
    pass_ok(&fake, &f, &mut taker);
    assert!(taken(&f, 15));
    fake.jobs.borrow_mut().clear();
    pass_ok(&fake, &f, &mut taker);
    assert!(!taken(&f, 15));
}

#[test]
fn an_entry_of_another_existing_queue_stays_and_one_of_a_removed_queue_goes() {
    let f = folders();
    let fake = FakeCups::held();
    fake.others.borrow_mut().push("Spectra-PDF-renamed".to_string());
    std::fs::write(f.ledger.join("Printed 1-0000000001.taken"), b"Spectra-PDF-renamed").unwrap();
    std::fs::write(f.ledger.join("Printed 2-0000000002.taken"), b"Spectra-PDF-gone").unwrap();
    std::fs::write(f.ledger.join("Printed 3-0000000003.taken"), b"").unwrap();
    pass_ok(&fake, &f, &mut Taker::default());
    assert_eq!(names(&f.ledger), ["Printed 1-0000000001.taken".to_string()].into());
}

#[test]
fn a_listing_that_may_be_cut_short_drops_no_entry() {
    let f = folders();
    let fake = FakeCups::held();
    for id in 1..=MAX_JOBS_PER_PASS as i32 {
        let mut incoming = pdf_job(id + 100);
        incoming.reasons = vec!["job-incoming"];
        fake.add(incoming);
    }
    let entry = f.ledger.join(format!("{}{TAKEN_SUFFIX}", key(1)));
    std::fs::write(&entry, QUEUE).unwrap();
    pass_ok(&fake, &f, &mut Taker::default());
    assert!(entry.exists());
}

#[test]
fn a_queue_that_is_not_held_is_never_read() {
    let mut drifted = held_facts(USER);
    drifted.op_policy = "default".to_string();
    let mut legacy = held_facts(USER);
    legacy.device_uri = "ipp://127.0.0.1:11000/ipp/print?contimeout=30".to_string();
    let mut foreign = held_facts("bob");
    foreign.device_uri = SINK_URI.to_string();
    for (facts, kind) in [
        (None, QueueKind::Absent),
        (Some(drifted), QueueKind::Drifted),
        (Some(legacy), QueueKind::Legacy),
        (Some(foreign), QueueKind::Foreign(SINK_URI.to_string())),
    ] {
        let f = folders();
        let fake = FakeCups::with_queue(facts);
        fake.add(pdf_job(16));
        let entry = f.ledger.join("Printed 9-0000000009.taken");
        std::fs::write(&entry, QUEUE).unwrap();
        let (outcome, errors) = run_pass(&fake, &f, &mut Taker::default());
        assert_eq!(outcome, Ok(kind));
        assert!(errors.is_empty());
        assert_eq!(fake.operations(), [op::GET_PRINTER_ATTRIBUTES]);
        assert!(entry.exists(), "a pass that read no queue drops no entry");
        assert!(staged(&f).is_empty());
    }
}

#[test]
fn a_failed_listing_is_named_and_drops_no_entry() {
    let f = folders();
    let fake = FakeCups::held();
    fake.listing_fails.set(true);
    let entry = f.ledger.join("Printed 9-0000000009.taken");
    std::fs::write(&entry, QUEUE).unwrap();
    let errors = pass_ok(&fake, &f, &mut Taker::default());
    assert_eq!(errors.len(), 1);
    assert!(errors[0].starts_with(&format!("the jobs of {QUEUE} could not be listed")));
    assert!(entry.exists());
}

fn failing_entry(_path: &Path, _contents: &[u8]) -> io::Result<()> {
    Err(io::Error::other("simulated full disk"))
}

#[test]
fn an_entry_that_cannot_be_written_removes_its_staged_parts_and_the_job_is_read_again() {
    let f = folders();
    let fake = FakeCups::held();
    fake.add(job(17, vec![("application/pdf", PDF), ("application/pdf", PDF)]));
    let mut taker = Taker {
        write_entry: failing_entry,
        ..Taker::default()
    };
    let errors = pass_ok(&fake, &f, &mut taker);
    assert_eq!(errors.len(), 1);
    assert!(errors[0].contains("could not be recorded as taken"), "{errors:?}");
    assert!(staged(&f).is_empty(), "{:?}", staged(&f));
    assert!(fake.cancels.borrow().is_empty());
    taker.write_entry = write_entry_file;
    pass_ok(&fake, &f, &mut taker);
    assert_eq!(staged(&f).len(), 2);
    assert_eq!(*fake.cancels.borrow(), [17]);
}

#[test]
fn a_document_the_scheduler_refuses_is_named_once_and_stays_queued() {
    for refusal in [Fetch::Refused, Fetch::NotAuthorized] {
        let f = folders();
        let fake = FakeCups::held();
        let mut refused = pdf_job(18);
        refused.fetch = refusal;
        fake.add(refused);
        let mut taker = Taker::default();
        let errors = pass_ok(&fake, &f, &mut taker);
        assert_eq!(
            errors,
            [format!("a print job in {QUEUE} cannot be read by this account; it stays in the queue")]
        );
        let again = pass_ok(&fake, &f, &mut taker);
        assert!(again.is_empty());
        assert_eq!(fake.fetched.borrow().len(), 1);
        assert_eq!(fake.left(), [18]);
        assert!(names(&f.staging).is_empty());
        assert!(!taken(&f, 18));
    }
}

#[test]
fn a_job_that_leaves_the_spool_mid_read_is_named_and_leaves_no_file() {
    let f = folders();
    let fake = FakeCups::held();
    let mut gone = pdf_job(19);
    gone.fetch = Fetch::Gone;
    fake.add(gone);
    let errors = pass_ok(&fake, &f, &mut Taker::default());
    assert_eq!(errors, [format!("a print job was removed from {QUEUE} before it could be read")]);
    assert!(names(&f.staging).is_empty());
    assert!(names(&f.ledger).is_empty());
}

#[test]
fn a_failing_read_is_retried_named_once_and_then_left_alone() {
    let f = folders();
    let fake = FakeCups::held();
    let mut failing = pdf_job(20);
    failing.fetch = Fetch::Fail;
    fake.add(failing);
    let mut taker = Taker::default();
    let mut all = Vec::new();
    for _ in 0..5 {
        all.extend(pass_ok(&fake, &f, &mut taker));
    }
    assert_eq!(all.len(), 1, "{all:?}");
    assert!(all[0].contains("simulated failure"));
    assert_eq!(fake.fetched.borrow().len(), MAX_READ_ATTEMPTS as usize);
    assert!(names(&f.staging).is_empty());
}

#[test]
fn a_failure_on_a_later_document_stages_nothing_of_the_job() {
    let f = folders();
    let fake = FakeCups::held();
    let mut second_fails = job(21, vec![("application/pdf", PDF), ("application/pdf", PDF)]);
    second_fails.fetch = Fetch::Fail;
    second_fails.fail_document = Some(2);
    fake.add(second_fails);
    pass_ok(&fake, &f, &mut Taker::default());
    assert!(names(&f.staging).is_empty(), "{:?}", names(&f.staging));
    assert!(!taken(&f, 21));
    assert_eq!(fake.left(), [21]);
}

#[test]
fn another_accounts_job_is_never_fetched_or_cancelled() {
    let f = folders();
    let fake = FakeCups::held();
    fake.ignores_my_jobs.set(true);
    let mut foreign = pdf_job(22);
    foreign.owner = "mallory".to_string();
    fake.add(foreign);
    fake.add(pdf_job(23));
    pass_ok(&fake, &f, &mut Taker::default());
    assert_eq!(*fake.fetched.borrow(), [(23, 1)]);
    assert_eq!(fake.left(), [22]);
}

#[test]
fn a_compressed_document_is_expanded_before_it_is_staged() {
    let f = folders();
    let fake = FakeCups::held();
    let mut compressed = vec![0x1f, 0x8b];
    compressed.extend_from_slice(PDF);
    fake.add(job(24, vec![("application/pdf", &compressed)]));
    pass_ok(&fake, &f, &mut Taker::default());
    assert_eq!(staged(&f)[&format!("{}001.pdf", key(24))], PDF);
}

#[test]
fn a_stopped_print_system_is_an_error_never_an_empty_queue() {
    let f = folders();
    let fake = FakeCups::held();
    *fake.down.borrow_mut() = Some("Connection refused".to_string());
    let (outcome, _) = run_pass(&fake, &f, &mut Taker::default());
    assert_eq!(outcome, Err("Connection refused".to_string()));
}

#[test]
fn a_staged_copy_without_an_entry_is_recorded_and_its_job_cancelled_without_a_read() {
    let f = folders();
    let fake = FakeCups::held();
    fake.add(pdf_job(25));
    std::fs::write(f.staging.join(format!("{}001.pdf", key(25))), PDF).unwrap();
    pass_ok(&fake, &f, &mut Taker::default());
    assert!(fake.fetched.borrow().is_empty());
    assert!(taken(&f, 25));
    assert_eq!(std::fs::read_to_string(f.ledger.join(format!("{}{TAKEN_SUFFIX}", key(25)))).unwrap(), QUEUE);
    assert_eq!(*fake.cancels.borrow(), [25]);
}

#[test]
fn a_recorded_part_is_renamed_into_place_by_the_next_pass() {
    let f = folders();
    let fake = FakeCups::held();
    let staged_name = format!("{}001.pdf", key(26));
    std::fs::write(f.staging.join(format!("{staged_name}{PART_SUFFIX}")), PDF).unwrap();
    std::fs::write(f.ledger.join(format!("{}{TAKEN_SUFFIX}", key(26))), QUEUE).unwrap();
    pass_ok(&fake, &f, &mut Taker::default());
    assert_eq!(names(&f.staging), [staged_name].into());
}

#[test]
fn a_start_finishes_recorded_parts_and_removes_what_no_entry_covers() {
    let f = folders();
    let recorded = format!("{}001.pdf", key(1));
    let unrecorded = format!("{}001.ps", key(2));
    std::fs::write(f.ledger.join(format!("{}{TAKEN_SUFFIX}", key(1))), QUEUE).unwrap();
    for name in [
        format!("{recorded}{PART_SUFFIX}"),
        format!("{unrecorded}{PART_SUFFIX}"),
        format!("{}001{DOWNLOAD_SUFFIX}", key(3)),
        format!("{}001{EXPANDED_SUFFIX}", key(3)),
        "notes.txt".to_string(),
    ] {
        std::fs::write(f.staging.join(name), PDF).unwrap();
    }
    let delivered_without_staged = format!("{unrecorded}{DELIVERED_SUFFIX}");
    let delivered_with_staged = format!("{recorded}{DELIVERED_SUFFIX}");
    for name in [
        delivered_without_staged.as_str(),
        delivered_with_staged.as_str(),
        "Printed 4-0000000004.taken.new",
    ] {
        std::fs::write(f.ledger.join(name), b"Printed 4.pdf").unwrap();
    }
    assert_eq!(reclaim_staging(&f.staging, &f.ledger), 5);
    assert_eq!(names(&f.staging), [recorded.clone(), "notes.txt".to_string()].into());
    assert_eq!(
        names(&f.ledger),
        [format!("{}{TAKEN_SUFFIX}", key(1)), delivered_with_staged].into()
    );
}

// ── names, formats and queues ───────────────────────────────────────────────

#[test]
fn staged_names_round_trip_to_their_job_key_and_output_stem() {
    let facts = JobFacts {
        id: 42,
        state: job_state::HELD,
        reasons: Vec::new(),
        created: 1_700_000_123,
        documents: 2,
        k_octets: 1,
        owner: None,
    };
    let key = job_key(&facts);
    assert_eq!(key, "Printed 1700000123-0000000042");
    let name = staged_name(&key, 2, DocKind::PostScript);
    assert_eq!(name, "Printed 1700000123-0000000042002.ps");
    assert_eq!(key_of(&name).as_deref(), Some(key.as_str()));
    assert_eq!(stem_of(Path::new(&name)).as_deref(), Some("Printed 1700000123"));
    assert_eq!(stem_of(Path::new("Printed 1700000000-1.ps")).as_deref(), Some("Printed 1700000000"));
    for not_staged in [
        "Printed 1-0000000001001.pdf.part",
        "Printed 1-0000000001001.txt",
        "notes-0000000001001.pdf",
        "Printed 1-x.pdf",
    ] {
        assert!(stem_of(Path::new(not_staged)).is_none(), "{not_staged}");
    }
    assert!(key_of("Printed 1-1.ps").is_none(), "a short key has no document number");
    let negative = JobFacts { created: -5, ..facts };
    assert_eq!(job_key(&negative), "Printed 0-0000000042");
}

#[test]
fn content_is_judged_by_the_scheduler_format_and_the_first_bytes() {
    assert_eq!(content_of("application/pdf", PDF), Content::Kind(DocKind::Pdf));
    assert_eq!(content_of("application/PDF; charset=x", PDF), Content::Kind(DocKind::Pdf));
    assert_eq!(content_of("application/postscript", PS), Content::Kind(DocKind::PostScript));
    assert_eq!(
        content_of("application/vnd.cups-postscript", b"\x1b%-12345X@PJL ENTER LANGUAGE=POSTSCRIPT\n%!PS"),
        Content::Kind(DocKind::PostScript)
    );
    assert_eq!(content_of("application/octet-stream", PDF), Content::Kind(DocKind::Pdf));
    assert_eq!(content_of("application/vnd.cups-raw", PS), Content::Kind(DocKind::PostScript));
    assert_eq!(content_of("application/vnd.cups-banner", b"#CUPS-BANNER"), Content::Banner);
    let mut late_header = vec![b' '; 1000];
    late_header.extend_from_slice(PDF);
    assert_eq!(content_of("application/pdf", &late_header), Content::Kind(DocKind::Pdf));
    for (format, head) in [
        ("text/plain", &b"words"[..]),
        ("image/png", &b"\x89PNG"[..]),
        ("application/pdf", &b"%!PS"[..]),
        ("application/octet-stream", &b"PCL"[..]),
        ("", PDF),
    ] {
        assert!(matches!(content_of(format, head), Content::Unsupported(_)), "{format}");
    }
}

#[test]
fn queues_are_classified_by_sink_policy_hold_and_owner() {
    assert_eq!(classify(None, USER), QueueKind::Absent);
    let held = held_facts(USER);
    assert_eq!(classify(Some(&held), USER), QueueKind::Held);
    assert_eq!(classify(Some(&held), "ALICE"), QueueKind::Held, "CUPS compares user names without case");
    let mut spelled = held.clone();
    spelled.device_uri = "file:/dev/null".to_string();
    assert_eq!(classify(Some(&spelled), USER), QueueKind::Held);
    for change in [
        |q: &mut QueueFacts| q.op_policy = "default".into(),
        |q: &mut QueueFacts| q.hold_default = "no-hold".into(),
        |q: &mut QueueFacts| q.allowed.clear(),
    ] {
        let mut drifted = held.clone();
        change(&mut drifted);
        assert_eq!(classify(Some(&drifted), USER), QueueKind::Drifted);
    }
    let mut another = held.clone();
    another.allowed = vec!["bob".into()];
    assert_eq!(classify(Some(&another), USER), QueueKind::Foreign(SINK_URI.into()));
    let mut shared = held.clone();
    shared.allowed.push("bob".into());
    assert_eq!(classify(Some(&shared), USER), QueueKind::Foreign(SINK_URI.into()));
    let mut denied = held.clone();
    denied.allowed.clear();
    denied.denied = vec!["bob".into()];
    assert_eq!(classify(Some(&denied), USER), QueueKind::Foreign(SINK_URI.into()));
    let mut legacy = held.clone();
    legacy.device_uri = "ipp://127.0.0.1:11000/ipp/print?contimeout=30".into();
    assert_eq!(classify(Some(&legacy), USER), QueueKind::Legacy);
    let mut legacy_of_another = legacy.clone();
    legacy_of_another.allowed = vec!["bob".into()];
    assert!(matches!(classify(Some(&legacy_of_another), USER), QueueKind::Foreign(_)));
    let mut device = held.clone();
    device.device_uri = "ipp://printer.local/ipp/print".into();
    assert_eq!(
        classify(Some(&device), USER),
        QueueKind::Foreign("ipp://printer.local/ipp/print".into())
    );
}

#[test]
fn only_a_stopped_accepting_private_queue_counts_as_installed() {
    let held = held_facts(USER);
    assert!(fully_configured(&held));
    let mut no_banners_installed = held.clone();
    no_banners_installed.sheets.clear();
    assert!(fully_configured(&no_banners_installed));
    for change in [
        |q: &mut QueueFacts| q.state = 3,
        |q: &mut QueueFacts| q.accepting = false,
        |q: &mut QueueFacts| q.shared = true,
        |q: &mut QueueFacts| q.error_policy = "abort-job".into(),
        |q: &mut QueueFacts| q.sheets = vec!["standard".into(), "none".into()],
    ] {
        let mut changed = held.clone();
        change(&mut changed);
        assert!(!fully_configured(&changed));
    }
}

#[test]
fn legacy_loopback_queues_are_recognized_by_their_uri() {
    assert!(is_legacy_uri("ipp://127.0.0.1:11000/ipp/print?contimeout=30"));
    assert!(is_legacy_uri("ipp://127.0.0.1:10000/ipp/print"));
    for other in [
        "ipp://127.0.0.1/ipp/print",
        "ipp://127.0.0.1:631/printers/x",
        "ipps://127.0.0.1:11000/ipp/print",
        "ipp://localhost:11000/ipp/print",
        SINK_URI,
    ] {
        assert!(!is_legacy_uri(other), "{other}");
    }
}

#[test]
fn identity_maps_to_a_queue_name_and_scheduler_uri() {
    assert_eq!(queue_name("alice"), "Spectra-PDF-alice");
    assert_eq!(queue_name("DOMAIN\\ann marie"), "Spectra-PDF-DOMAIN_ann_marie");
    assert!(queue_name(&"x".repeat(400)).len() <= MAX_QUEUE_NAME);
    assert_eq!(printer_uri(QUEUE), "ipp://localhost/printers/Spectra-PDF-alice");
}

#[test]
fn the_location_is_plain_bounded_text() {
    assert_eq!(queue_location("Für Spectra PDF\u{0}\n"), "Für Spectra PDF");
    assert_eq!(queue_location("  \t "), DEFAULT_LOCATION);
    assert_eq!(queue_location(&"é".repeat(300)).chars().count(), MAX_LOCATION_CHARS);
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
fn the_ppd_offers_every_size_once_with_the_locale_default() {
    let a4 = queue_ppd("iso_a4_210x297mm");
    let letter = queue_ppd("na_letter_8.5x11in");
    assert!(a4.starts_with("*PPD-Adobe: \"4.3\"\n"));
    for keyword in ["PageSize", "PageRegion", "ImageableArea", "PaperDimension"] {
        assert!(a4.contains(&format!("*Default{keyword}: A4\n")), "{keyword}");
        assert!(letter.contains(&format!("*Default{keyword}: Letter\n")), "{keyword}");
        for (_, ppd, ..) in PAGES {
            assert_eq!(
                a4.lines().filter(|l| l.starts_with(&format!("*{keyword} {ppd}/"))).count(),
                1,
                "{keyword} {ppd}"
            );
        }
    }
    assert!(a4.contains("*PageSize A4/A4: \"<</PageSize[595.28 841.89]/ImagingBBox null>>setpagedevice\"\n"));
    assert!(a4.contains("*PaperDimension Letter/US Letter: \"612 792\"\n"));
    assert!(a4.contains("*cupsFilter2: \"application/vnd.cups-pdf application/pdf 10 -\"\n"));
    assert!(a4.contains("*ColorDevice: True\n"));
    for ignored in ["*OpenUI *ColorModel", "*OpenUI *Duplex", "*OpenUI *OutputBin"] {
        assert!(!a4.contains(ignored), "a held job ignores {ignored}");
    }
    assert!(a4.is_ascii());
}

#[test]
fn the_install_command_holds_every_job_for_this_user_alone() {
    let args = configure_args(QUEUE, USER, "Held here", Path::new("/run/user/1000/q.ppd"));
    let joined = args.join(" ");
    for expected in [
        "-p Spectra-PDF-alice",
        "-v file:///dev/null",
        "-P /run/user/1000/q.ppd",
        "-L Held here",
        "-o printer-op-policy=authenticated",
        "-o job-hold-until-default=indefinite",
        "-o printer-error-policy=stop-printer",
        "-o printer-is-shared=false",
        "-o job-sheets-default=none,none",
        "-o printer-is-accepting-jobs=true",
        "-o printer-state=5",
        "-u allow:alice",
    ] {
        assert!(joined.contains(expected), "{expected} in {joined}");
    }
    assert!(!args.iter().any(|a| a == "-E"), "-E would enable the queue");
    assert_eq!(remove_args(QUEUE), vec!["-x", QUEUE]);
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

// ── requests and responses (RFC 8010) ───────────────────────────────────────

/// One attribute item of RFC 8010 section 3.1.4: value tag, name length,
/// name, value length, value.
fn item(value_tag: u8, name: &str, value: &[u8]) -> Vec<u8> {
    let mut out = vec![value_tag];
    out.extend_from_slice(&(name.len() as u16).to_be_bytes());
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(&(value.len() as u16).to_be_bytes());
    out.extend_from_slice(value);
    out
}

fn request_head(operation: u16) -> Vec<u8> {
    let mut out = vec![2, 0];
    out.extend_from_slice(&operation.to_be_bytes());
    out.extend_from_slice(&1u32.to_be_bytes());
    out.push(0x01);
    out.extend(item(0x47, "attributes-charset", b"utf-8"));
    out.extend(item(0x48, "attributes-natural-language", b"en"));
    out.extend(item(0x45, "printer-uri", b"ipp://localhost/printers/Spectra-PDF-alice"));
    out
}

#[test]
fn the_get_document_and_cancel_requests_encode_byte_for_byte() {
    let mut document = request_head(0x4027);
    document.extend(item(0x21, "job-id", &42i32.to_be_bytes()));
    document.extend(item(0x42, "requesting-user-name", b"alice"));
    document.extend(item(0x21, "document-number", &2i32.to_be_bytes()));
    document.push(0x03);
    assert_eq!(encode(&get_document_request(QUEUE, USER, 42, 2)), document);

    let mut cancel = request_head(0x0008);
    cancel.extend(item(0x21, "job-id", &42i32.to_be_bytes()));
    cancel.extend(item(0x42, "requesting-user-name", b"alice"));
    cancel.extend(item(0x22, "purge-job", &[1]));
    cancel.push(0x03);
    assert_eq!(encode(&cancel_job_request(QUEUE, USER, 42)), cancel);
}

#[test]
fn every_request_starts_with_the_attributes_rfc_8011_requires() {
    for request in [
        printer_attributes_request(QUEUE, USER),
        get_jobs_request(QUEUE, USER),
        get_document_request(QUEUE, USER, 1, 1),
        cancel_job_request(QUEUE, USER, 1),
        get_printers_request(USER),
    ] {
        let attrs = &request.groups[0].attrs;
        assert_eq!(request.groups.len(), 1);
        assert_eq!(attrs[0].name, "attributes-charset");
        assert_eq!(attrs[1].name, "attributes-natural-language");
        assert_eq!(request.op_text("requesting-user-name"), Some(USER));
        let bytes = encode(&request);
        assert_eq!(decode(&mut bytes.as_slice()).unwrap(), request);
    }
    let jobs = get_jobs_request(QUEUE, USER);
    assert_eq!(jobs.op_integer("limit"), Some(MAX_JOBS_PER_PASS as i32));
    let requested = jobs.attr(tag::OPERATION, "requested-attributes").unwrap();
    for name in ["job-id", "job-state", "job-state-reasons", "number-of-documents", "time-at-creation"] {
        assert!(requested.values.contains(&Value::Keyword(name.into())), "{name}");
    }
}

#[test]
fn a_get_jobs_response_lists_each_job_group() {
    let response = Message {
        version: (2, 0),
        code: status::OK,
        request_id: 1,
        groups: vec![
            Group {
                tag: tag::OPERATION,
                attrs: vec![Attr::new("attributes-charset", vec![Value::Charset("utf-8".into())])],
            },
            Group {
                tag: tag::JOB,
                attrs: vec![
                    Attr::new("job-id", vec![Value::Integer(5)]),
                    Attr::new("job-state", vec![Value::Enum(4)]),
                    Attr::new(
                        "job-state-reasons",
                        vec![Value::Keyword("job-hold-until-specified".into())],
                    ),
                    Attr::new("number-of-documents", vec![Value::Integer(2)]),
                    Attr::new("time-at-creation", vec![Value::Integer(1_700_000_000)]),
                    Attr::new("job-k-octets", vec![Value::Integer(12)]),
                ],
            },
            Group {
                tag: tag::JOB,
                attrs: vec![Attr::new("job-state", vec![Value::Enum(4)])],
            },
            Group {
                tag: tag::JOB,
                attrs: vec![
                    Attr::new("job-id", vec![Value::Integer(6)]),
                    Attr::new("job-originating-user-name", vec![Value::Name("alice".into())]),
                ],
            },
        ],
    };
    let jobs = jobs_from(&response).unwrap();
    assert_eq!(jobs.len(), 2, "a group without a job id is skipped");
    assert_eq!(
        jobs[0],
        JobFacts {
            id: 5,
            state: 4,
            reasons: vec!["job-hold-until-specified".into()],
            created: 1_700_000_000,
            documents: 2,
            k_octets: 12,
            owner: None,
        }
    );
    assert_eq!(jobs[1].owner.as_deref(), Some("alice"));
    assert!(!job_is_complete(&jobs[1]), "a job without a state is not taken");
    let refused = Message {
        code: status::NOT_FOUND,
        ..response
    };
    assert!(jobs_from(&refused).is_err());
}

#[test]
fn the_queue_facts_read_every_held_setting() {
    let fake = FakeCups::held();
    assert_eq!(queue_facts(&fake, QUEUE, USER), Ok(Some(held_facts(USER))));
    let absent = FakeCups::with_queue(None);
    assert_eq!(queue_facts(&absent, QUEUE, USER), Ok(None));
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
    assert!(decode_limited(&mut bytes.as_slice(), 1024 * 1024).is_err());
}

// ── delivery ────────────────────────────────────────────────────────────────

struct Delivery {
    _dir: tempfile::TempDir,
    staging: PathBuf,
    ledger: PathBuf,
    printed: PathBuf,
}

fn delivery() -> Delivery {
    let dir = tempfile::tempdir().unwrap();
    let staging = dir.path().join("staging");
    let ledger = dir.path().join("ledger");
    let printed = dir.path().join("printed");
    for d in [&staging, &ledger, &printed] {
        std::fs::create_dir(d).unwrap();
    }
    Delivery {
        _dir: dir,
        staging,
        ledger,
        printed,
    }
}

#[test]
fn a_staged_pdf_opens_once_as_received_and_leaves_no_staged_file_or_record() {
    let d = delivery();
    let staged = d.staging.join("Printed 1700000000-0000000001001.pdf");
    std::fs::write(&staged, PDF).unwrap();
    let opened = RefCell::new(Vec::new());
    let printed = d.printed.clone();
    let convert = move |staged: &Path, stem: &str, before: &dyn Fn(&Path) -> Result<(), String>| {
        copy_staged_pdf(&printed, staged, stem, before)
    };
    let pdf = deliver_one(&d.ledger, &d.printed, &staged, "Printed 1700000000", &convert, &|p| {
        opened.borrow_mut().push(p.to_path_buf())
    })
    .unwrap();
    assert_eq!(pdf, d.printed.join("Printed 1700000000.pdf"));
    assert_eq!(std::fs::read(&pdf).unwrap(), PDF);
    assert_eq!(*opened.borrow(), [pdf.clone()]);
    assert!(!staged.exists());
    assert!(names(&d.ledger).is_empty());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&pdf).unwrap().permissions().mode() & 0o077, 0);
}

#[test]
fn a_stop_after_the_pdf_was_named_opens_that_pdf_instead_of_converting_again() {
    let d = delivery();
    let name = "Printed 1700000000-0000000001001.ps";
    let staged = d.staging.join(name);
    std::fs::write(&staged, PS).unwrap();
    std::fs::write(d.printed.join("Printed 1700000000.pdf"), PDF).unwrap();
    std::fs::write(d.ledger.join(format!("{name}{DELIVERED_SUFFIX}")), "Printed 1700000000.pdf").unwrap();
    let converted = Cell::new(false);
    let convert = |_: &Path, _: &str, _: &dyn Fn(&Path) -> Result<(), String>| -> Result<PathBuf, String> {
        converted.set(true);
        Err("must not run".into())
    };
    let pdf = deliver_one(&d.ledger, &d.printed, &staged, "Printed 1700000000", &convert, &|_| {}).unwrap();
    assert!(!converted.get());
    assert_eq!(pdf, d.printed.join("Printed 1700000000.pdf"));
    assert!(!staged.exists());
    assert!(names(&d.ledger).is_empty());
}

#[test]
fn a_failed_conversion_keeps_the_staged_document_and_names_the_retry() {
    let d = delivery();
    let staged = d.staging.join("Printed 1700000000-0000000001001.ps");
    std::fs::write(&staged, PS).unwrap();
    let convert = |_: &Path, _: &str, _: &dyn Fn(&Path) -> Result<(), String>| -> Result<PathBuf, String> {
        Err("the print job could not be converted: no Ghostscript".into())
    };
    let error = deliver_one(&d.ledger, &d.printed, &staged, "Printed 1700000000", &convert, &|_| {}).unwrap_err();
    assert!(error.contains("no Ghostscript"));
    assert!(error.contains("tried again the next time Spectra PDF starts"));
    assert!(staged.exists());
    assert!(names(&d.ledger).is_empty());
}

#[test]
fn a_pass_hands_each_staged_document_to_delivery_once() {
    let d = delivery();
    for name in [
        "Printed 1700000000-0000000001001.pdf",
        "Printed 1700000000-0000000001002.ps",
        "Printed 1700000000-0000000002001.pdf.part",
        "notes.pdf",
    ] {
        std::fs::write(d.staging.join(name), PDF).unwrap();
    }
    let attempted = Mutex::new(HashSet::new());
    let handed = RefCell::new(Vec::new());
    let deliver = |stem: String, path: PathBuf| {
        handed
            .borrow_mut()
            .push((stem, path.file_name().unwrap().to_string_lossy().into_owned()))
    };
    deliver_staged(&d.staging, &attempted, &|_| {}, &deliver);
    deliver_staged(&d.staging, &attempted, &|_| {}, &deliver);
    assert_eq!(
        *handed.borrow(),
        [
            ("Printed 1700000000".to_string(), "Printed 1700000000-0000000001001.pdf".to_string()),
            ("Printed 1700000000".to_string(), "Printed 1700000000-0000000001002.ps".to_string()),
        ]
    );
}

// ── folders ─────────────────────────────────────────────────────────────────

#[test]
fn the_receiver_keeps_every_file_in_one_private_folder() {
    let layout = Layout::under(Path::new("/home/a/.local/state"));
    let root = PathBuf::from("/home/a/.local/state/com.spectrapdf.app/virtual-printer");
    assert_eq!(layout.root, root);
    for path in [&layout.staging, &layout.ledger, &layout.lock] {
        assert_eq!(path.parent(), Some(root.as_path()), "{path:?}");
    }
    let dir = tempfile::tempdir().unwrap();
    let layout = Layout::under(dir.path());
    prepare(&layout).unwrap();
    use std::os::unix::fs::PermissionsExt;
    for path in [&layout.root, &layout.staging, &layout.ledger] {
        assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o700);
    }
}

#[test]
fn one_receiver_per_account_holds_the_claim() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join(LOCK_FILE);
    let first = claim_receiver(&lock).unwrap();
    assert!(matches!(claim_receiver(&lock), Err(ClaimFailure::HeldElsewhere)));
    drop(first);
    assert!(claim_receiver(&lock).is_ok());
}

#[test]
fn the_printed_folder_is_private_to_its_owner() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("a").join("b");
    private_dir(&dir).unwrap();
    let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
    let link = root.path().join("link");
    std::os::unix::fs::symlink(&dir, &link).unwrap();
    assert!(private_dir(&link).is_err(), "a symbolic link is not the folder");
}

// ── against the system's libcups ────────────────────────────────────────────
//
// These use the CUPS client library itself, and skip where it is absent.

fn sym<T: Copy>(handle: *mut c_void, name: &str) -> T {
    let name = CString::new(name).unwrap();
    let found = unsafe { libc::dlsym(handle, name.as_ptr()) };
    assert!(!found.is_null(), "libcups has {name:?}");
    unsafe { std::mem::transmute_copy::<*mut c_void, T>(&found) }
}

fn libcups() -> Option<&'static crate::cups_linux::Cups> {
    match crate::cups_linux::cups() {
        Ok(cups) => Some(cups),
        Err(_) => {
            eprintln!("libcups not available; skipping");
            None
        }
    }
}

type IppNew = unsafe extern "C" fn() -> *mut c_void;
type IppSetOperation = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type IppSetStatusCode = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type IppSetRequestId = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type IppAddString =
    unsafe extern "C" fn(*mut c_void, c_int, c_int, *const c_char, *const c_char, *const c_char) -> *mut c_void;
type IppAddInteger = unsafe extern "C" fn(*mut c_void, c_int, c_int, *const c_char, c_int) -> *mut c_void;
type IppAddBoolean = unsafe extern "C" fn(*mut c_void, c_int, *const c_char, c_char) -> *mut c_void;
type IppAddSeparator = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
type IppDelete = unsafe extern "C" fn(*mut c_void);
type IppWriteIo =
    unsafe extern "C" fn(*mut c_void, crate::cups_linux::IppIoCb, c_int, *mut c_void, *mut c_void) -> c_int;

unsafe extern "C" fn collect(context: *mut c_void, buffer: *mut u8, bytes: usize) -> isize {
    let sink = unsafe { &mut *(context as *mut Vec<u8>) };
    sink.extend_from_slice(unsafe { std::slice::from_raw_parts(buffer, bytes) });
    bytes as isize
}

/// An IPP message built attribute by attribute with libcups's own API and
/// written by its own writer.
struct Built {
    handle: *mut c_void,
    ipp: *mut c_void,
}

impl Built {
    fn request(cups: &crate::cups_linux::Cups, operation: u16) -> Self {
        let handle = cups.handle();
        let ipp = unsafe { sym::<IppNew>(handle, "ippNew")() };
        unsafe {
            sym::<IppSetOperation>(handle, "ippSetOperation")(ipp, operation as c_int);
            sym::<IppSetRequestId>(handle, "ippSetRequestId")(ipp, 1);
        }
        Self { handle, ipp }
    }

    fn response(cups: &crate::cups_linux::Cups, code: u16) -> Self {
        let handle = cups.handle();
        let ipp = unsafe { sym::<IppNew>(handle, "ippNew")() };
        unsafe {
            sym::<IppSetStatusCode>(handle, "ippSetStatusCode")(ipp, code as c_int);
            sym::<IppSetRequestId>(handle, "ippSetRequestId")(ipp, 1);
        }
        Self { handle, ipp }
    }

    fn string(&self, group: u8, value_tag: u8, name: &str, value: &str) -> &Self {
        let (name, value) = (CString::new(name).unwrap(), CString::new(value).unwrap());
        unsafe {
            sym::<IppAddString>(self.handle, "ippAddString")(
                self.ipp,
                group as c_int,
                value_tag as c_int,
                name.as_ptr(),
                std::ptr::null(),
                value.as_ptr(),
            )
        };
        self
    }

    fn integer(&self, group: u8, value_tag: u8, name: &str, value: i32) -> &Self {
        let name = CString::new(name).unwrap();
        unsafe {
            sym::<IppAddInteger>(self.handle, "ippAddInteger")(
                self.ipp,
                group as c_int,
                value_tag as c_int,
                name.as_ptr(),
                value,
            )
        };
        self
    }

    fn boolean(&self, group: u8, name: &str, value: bool) -> &Self {
        let name = CString::new(name).unwrap();
        unsafe {
            sym::<IppAddBoolean>(self.handle, "ippAddBoolean")(self.ipp, group as c_int, name.as_ptr(), value as c_char)
        };
        self
    }

    fn separator(&self) -> &Self {
        unsafe { sym::<IppAddSeparator>(self.handle, "ippAddSeparator")(self.ipp) };
        self
    }

    fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let state = unsafe {
            sym::<IppWriteIo>(self.handle, "ippWriteIO")(
                &mut out as *mut Vec<u8> as *mut c_void,
                collect,
                1,
                std::ptr::null_mut(),
                self.ipp,
            )
        };
        assert_eq!(state, crate::cups_linux::IPP_STATE_DATA);
        out
    }
}

impl Drop for Built {
    fn drop(&mut self) {
        unsafe { sym::<IppDelete>(self.handle, "ippDelete")(self.ipp) };
    }
}

#[test]
fn libcups_builds_the_same_get_document_and_cancel_requests() {
    let Some(cups) = libcups() else { return };
    let op_group = tag::OPERATION;
    let head = |built: &Built| {
        built
            .string(op_group, tag::CHARSET, "attributes-charset", "utf-8")
            .string(op_group, tag::LANGUAGE, "attributes-natural-language", "en")
            .string(op_group, tag::URI, "printer-uri", &printer_uri(QUEUE));
    };
    let document = Built::request(cups, op::CUPS_GET_DOCUMENT);
    head(&document);
    document
        .integer(op_group, tag::INTEGER, "job-id", 42)
        .string(op_group, tag::NAME, "requesting-user-name", USER)
        .integer(op_group, tag::INTEGER, "document-number", 2);
    assert_eq!(document.bytes(), encode(&get_document_request(QUEUE, USER, 42, 2)));

    let cancel = Built::request(cups, op::CANCEL_JOB);
    head(&cancel);
    cancel
        .integer(op_group, tag::INTEGER, "job-id", 42)
        .string(op_group, tag::NAME, "requesting-user-name", USER)
        .boolean(op_group, "purge-job", true);
    assert_eq!(cancel.bytes(), encode(&cancel_job_request(QUEUE, USER, 42)));
}

#[test]
fn libcups_reads_and_writes_every_request_unchanged() {
    let Some(cups) = libcups() else { return };
    for request in [
        printer_attributes_request(QUEUE, USER),
        get_jobs_request(QUEUE, USER),
        get_document_request(QUEUE, USER, 7, 1),
        cancel_job_request(QUEUE, USER, 7),
        get_printers_request(USER),
    ] {
        let bytes = encode(&request);
        assert_eq!(cups.reencode(&bytes).unwrap(), bytes, "{:#06x}", request.code);
    }
    assert!(cups.reencode(&[2, 0, 0]).is_err(), "a truncated message is refused");
}

#[test]
fn a_get_jobs_response_written_by_libcups_reads_as_its_jobs() {
    let Some(cups) = libcups() else { return };
    let response = Built::response(cups, status::OK);
    response
        .string(tag::OPERATION, tag::CHARSET, "attributes-charset", "utf-8")
        .string(tag::OPERATION, tag::LANGUAGE, "attributes-natural-language", "en");
    for (id, state, reason) in [(31, 4, "job-hold-until-specified"), (32, 3, "printer-stopped")] {
        response
            .integer(tag::JOB, tag::INTEGER, "job-id", id)
            .integer(tag::JOB, tag::ENUM, "job-state", state)
            .string(tag::JOB, tag::KEYWORD, "job-state-reasons", reason)
            .integer(tag::JOB, tag::INTEGER, "number-of-documents", 1)
            .integer(tag::JOB, tag::INTEGER, "time-at-creation", 1_700_000_000 + id)
            .string(tag::JOB, tag::NAME, "job-originating-user-name", USER)
            .separator();
    }
    let jobs = jobs_from(&decode(&mut response.bytes().as_slice()).unwrap()).unwrap();
    assert_eq!(jobs.iter().map(|j| j.id).collect::<Vec<_>>(), [31, 32]);
    assert!(jobs.iter().all(job_is_complete));
    assert_eq!(jobs[1].reasons, ["printer-stopped"]);
    assert_eq!(job_key(&jobs[0]), "Printed 1700000031-0000000031");
}

type FileOpen = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_void;
type FileWrite = unsafe extern "C" fn(*mut c_void, *const c_char, usize) -> isize;
type FileClose = unsafe extern "C" fn(*mut c_void) -> c_int;

#[test]
fn libcups_expands_a_gzip_document_and_passes_other_bytes_through() {
    let Some(cups) = libcups() else { return };
    let dir = tempfile::tempdir().unwrap();
    let compressed = dir.path().join("compressed");
    let path = CString::new(compressed.to_str().unwrap()).unwrap();
    let mode = CString::new("w9").unwrap();
    unsafe {
        let file = sym::<FileOpen>(cups.handle(), "cupsFileOpen")(path.as_ptr(), mode.as_ptr());
        assert!(!file.is_null());
        assert_eq!(
            sym::<FileWrite>(cups.handle(), "cupsFileWrite")(file, PDF.as_ptr() as *const c_char, PDF.len()),
            PDF.len() as isize
        );
        assert_eq!(sym::<FileClose>(cups.handle(), "cupsFileClose")(file), 0);
    }
    let raw = std::fs::read(&compressed).unwrap();
    assert!(raw.starts_with(&[0x1f, 0x8b]), "cupsFileOpen mode w9 writes gzip");
    let mut out = Vec::new();
    assert_eq!(cups.expand_into(&compressed, &mut out, MAX_JOB_BYTES).unwrap(), PDF.len() as u64);
    assert_eq!(out, PDF);
    let plain = dir.path().join("plain");
    std::fs::write(&plain, PS).unwrap();
    let mut out = Vec::new();
    cups.expand_into(&plain, &mut out, MAX_JOB_BYTES).unwrap();
    assert_eq!(out, PS);
    let mut out = Vec::new();
    assert_eq!(cups.expand_into(&compressed, &mut out, 9).unwrap(), 10, "the limit stops one byte past it");
    let mut damaged = raw.clone();
    let crc = damaged.len() - 8;
    damaged[crc] ^= 0xFF;
    let corrupt = dir.path().join("corrupt");
    std::fs::write(&corrupt, &damaged).unwrap();
    assert!(cups.expand_into(&corrupt, &mut Vec::new(), MAX_JOB_BYTES).is_err(), "a damaged stream is refused");
}

type PpdOpenFile = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type PpdClose = unsafe extern "C" fn(*mut c_void);
type PpdLastError = unsafe extern "C" fn(*mut c_int) -> c_int;
type PpdMarkDefaults = unsafe extern "C" fn(*mut c_void);
type PpdPageSize = unsafe extern "C" fn(*mut c_void, *const c_char) -> *const PpdSize;
type PpdFindAttr = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> *mut c_void;

/// `ppd_size_t` of `<cups/ppd.h>`.
#[repr(C)]
struct PpdSize {
    marked: c_int,
    name: [c_char; 41],
    width: f32,
    length: f32,
    left: f32,
    bottom: f32,
    right: f32,
    top: f32,
}

#[test]
fn libcups_opens_the_queue_ppd_with_the_locale_default_size() {
    let Some(cups) = libcups() else { return };
    let handle = cups.handle();
    let dir = tempfile::tempdir().unwrap();
    for (media, default, width, length) in [
        ("iso_a4_210x297mm", "A4", 595.28f32, 841.89f32),
        ("na_letter_8.5x11in", "Letter", 612.0, 792.0),
    ] {
        let path = dir.path().join(format!("{default}.ppd"));
        std::fs::write(&path, queue_ppd(media)).unwrap();
        let path = CString::new(path.to_str().unwrap()).unwrap();
        unsafe {
            let ppd = sym::<PpdOpenFile>(handle, "ppdOpenFile")(path.as_ptr());
            if ppd.is_null() {
                let mut line: c_int = 0;
                let status = sym::<PpdLastError>(handle, "ppdLastError")(&mut line);
                panic!("libcups refused the PPD: status {status} at line {line}");
            }
            sym::<PpdMarkDefaults>(handle, "ppdMarkDefaults")(ppd);
            let marked = &*sym::<PpdPageSize>(handle, "ppdPageSize")(ppd, std::ptr::null());
            assert_eq!(CStr::from_ptr(marked.name.as_ptr()).to_str().unwrap(), default);
            assert!((marked.width - width).abs() < 0.01 && (marked.length - length).abs() < 0.01);
            let tabloid = CString::new("Tabloid").unwrap();
            let size = &*sym::<PpdPageSize>(handle, "ppdPageSize")(ppd, tabloid.as_ptr());
            assert!((size.width - 792.0).abs() < 0.01 && (size.length - 1224.0).abs() < 0.01);
            let filter = CString::new("cupsFilter2").unwrap();
            assert!(!sym::<PpdFindAttr>(handle, "ppdFindAttr")(ppd, filter.as_ptr(), std::ptr::null()).is_null());
            sym::<PpdClose>(handle, "ppdClose")(ppd);
        }
    }
}

// The print dialog's capability report (`printers::capabilities_of`) read
// through the destination API from an IPP Everywhere printer: a minimal
// responder for Get-Printer-Attributes over HTTP/1.1.

fn media_col(x: Value, y: Value) -> Value {
    let size = Value::Collection(vec![
        Attr::new("x-dimension", vec![x]),
        Attr::new("y-dimension", vec![y]),
    ]);
    let mut members = vec![Attr::new("media-size", vec![size])];
    for margin in ["media-bottom-margin", "media-left-margin", "media-right-margin", "media-top-margin"] {
        members.push(Attr::new(margin, vec![Value::Integer(0)]));
    }
    Value::Collection(members)
}

fn everywhere_attributes(uri: &str) -> Vec<Attr> {
    let kw = |s: &str| Value::Keyword(s.to_string());
    let kws = |list: &[&str]| list.iter().map(|s| kw(s)).collect::<Vec<_>>();
    let mut database: Vec<Value> = PAGES
        .iter()
        .map(|(_, _, _, x, y)| media_col(Value::Integer(*x), Value::Integer(*y)))
        .collect();
    database.push(media_col(Value::Range(2540, 121_920), Value::Range(2540, 121_920)));
    vec![
        Attr::new("charset-configured", vec![Value::Charset("utf-8".into())]),
        Attr::new("charset-supported", vec![Value::Charset("utf-8".into())]),
        Attr::new("color-supported", vec![Value::Boolean(true)]),
        Attr::new("compression-supported", kws(&["none"])),
        Attr::new("copies-default", vec![Value::Integer(1)]),
        Attr::new("copies-supported", vec![Value::Range(1, 999)]),
        Attr::new("document-format-default", vec![Value::Mime("application/pdf".into())]),
        Attr::new("document-format-supported", vec![Value::Mime("application/pdf".into())]),
        Attr::new("generated-natural-language-supported", vec![Value::Language("en".into())]),
        Attr::new("ipp-versions-supported", kws(&["1.1", "2.0"])),
        Attr::new("media-col-database", database),
        Attr::new("media-col-default", vec![media_col(Value::Integer(21000), Value::Integer(29700))]),
        Attr::new("media-col-ready", vec![media_col(Value::Integer(21000), Value::Integer(29700))]),
        Attr::new(
            "media-col-supported",
            kws(&["media-bottom-margin", "media-left-margin", "media-right-margin", "media-size", "media-top-margin"]),
        ),
        Attr::new("media-default", vec![kw("iso_a4_210x297mm")]),
        Attr::new("media-ready", vec![kw("iso_a4_210x297mm")]),
        Attr::new(
            "media-size-supported",
            PAGES
                .iter()
                .map(|(_, _, _, x, y)| {
                    Value::Collection(vec![
                        Attr::new("x-dimension", vec![Value::Integer(*x)]),
                        Attr::new("y-dimension", vec![Value::Integer(*y)]),
                    ])
                })
                .collect(),
        ),
        Attr::new("media-supported", PAGES.iter().map(|(pwg, ..)| kw(pwg)).collect()),
        Attr::new(
            "multiple-document-handling-supported",
            kws(&["separate-documents-uncollated-copies", "separate-documents-collated-copies"]),
        ),
        Attr::new("natural-language-configured", vec![Value::Language("en".into())]),
        Attr::new(
            "operations-supported",
            [0x0002, 0x0004, 0x0005, 0x0006, 0x0008, 0x0009, 0x000A, 0x000B]
                .iter()
                .map(|o| Value::Enum(*o))
                .collect(),
        ),
        Attr::new("orientation-requested-supported", vec![Value::Enum(3), Value::Enum(4)]),
        Attr::new("print-color-mode-default", vec![kw("color")]),
        Attr::new("print-color-mode-supported", kws(&["auto", "color", "monochrome"])),
        Attr::new("print-quality-supported", vec![Value::Enum(4)]),
        Attr::new("printer-info", vec![Value::Text(DESCRIPTION.into())]),
        Attr::new("printer-is-accepting-jobs", vec![Value::Boolean(true)]),
        Attr::new("printer-make-and-model", vec![Value::Text(MAKE_AND_MODEL.into())]),
        Attr::new("printer-name", vec![Value::Name(DESCRIPTION.into())]),
        Attr::new("printer-resolution-default", vec![Value::Resolution(300, 300, 3)]),
        Attr::new("printer-resolution-supported", vec![Value::Resolution(300, 300, 3)]),
        Attr::new("printer-state", vec![Value::Enum(3)]),
        Attr::new("printer-state-reasons", kws(&["none"])),
        Attr::new("printer-up-time", vec![Value::Integer(1)]),
        Attr::new("printer-uri-supported", vec![Value::Uri(uri.to_string())]),
        Attr::new("sides-default", vec![kw("one-sided")]),
        Attr::new("sides-supported", kws(&["one-sided"])),
        Attr::new("uri-authentication-supported", kws(&["none"])),
        Attr::new("uri-security-supported", kws(&["none"])),
    ]
}

/// One HTTP/1.1 request body, by Content-Length or chunked coding. A client
/// that sends `Expect: 100-continue` gets the interim response first.
fn read_body(reader: &mut BufReader<TcpStream>, writer: &mut TcpStream) -> Option<Vec<u8>> {
    let mut length = None;
    let mut chunked = false;
    let mut expects = false;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        let lower = header.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            length = value.trim().parse::<usize>().ok();
        }
        if lower.starts_with("transfer-encoding:") && lower.contains("chunked") {
            chunked = true;
        }
        if lower.starts_with("expect:") && lower.contains("100-continue") {
            expects = true;
        }
    }
    if expects {
        writer.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").ok()?;
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            line.clear();
            reader.read_line(&mut line).ok()?;
            let size = usize::from_str_radix(line.trim().split(';').next()?, 16).ok()?;
            if size == 0 {
                line.clear();
                reader.read_line(&mut line).ok()?;
                break;
            }
            let mut chunk = vec![0u8; size];
            reader.read_exact(&mut chunk).ok()?;
            body.extend_from_slice(&chunk);
            line.clear();
            reader.read_line(&mut line).ok()?;
        }
    } else {
        body.resize(length.unwrap_or(0), 0);
        reader.read_exact(&mut body).ok()?;
    }
    Some(body)
}

fn serve_everywhere_printer(listener: TcpListener, uri: String) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let uri = uri.clone();
        std::thread::spawn(move || {
            let mut writer = stream.try_clone().unwrap();
            let mut reader = BufReader::new(stream);
            while let Some(body) = read_body(&mut reader, &mut writer) {
                let Ok(request) = decode(&mut body.as_slice()) else { return };
                let (code, groups) = if request.code == op::GET_PRINTER_ATTRIBUTES {
                    (
                        status::OK,
                        vec![Group {
                            tag: tag::PRINTER,
                            attrs: everywhere_attributes(&uri),
                        }],
                    )
                } else {
                    (status::OPERATION_NOT_SUPPORTED, Vec::new())
                };
                let mut all = vec![Group {
                    tag: tag::OPERATION,
                    attrs: vec![
                        Attr::new("attributes-charset", vec![Value::Charset("utf-8".into())]),
                        Attr::new("attributes-natural-language", vec![Value::Language("en".into())]),
                    ],
                }];
                all.extend(groups);
                let response = encode(&Message {
                    version: request.version,
                    code,
                    request_id: request.request_id,
                    groups: all,
                });
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/ipp\r\nContent-Length: {}\r\n\r\n",
                    response.len()
                );
                if writer.write_all(head.as_bytes()).and_then(|()| writer.write_all(&response)).is_err() {
                    return;
                }
            }
        });
    }
}

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

#[test]
fn the_print_dialog_capability_report_reads_an_ipp_everywhere_printer() {
    let Some(cups) = libcups() else { return };
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let uri = format!("ipp://127.0.0.1:{}/ipp/print", listener.local_addr().unwrap().port());
    let served = uri.clone();
    std::thread::spawn(move || serve_everywhere_printer(listener, served));
    let dests = cups.destination_for_uri(&uri).unwrap();
    let dest = dests.iter().next().unwrap();
    let connect: ConnectDest = sym(cups.handle(), "cupsConnectDest");
    let mut resource = [0 as c_char; 256];
    // CUPS_DEST_FLAGS_DEVICE: connect to the printer itself.
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
    let caps = {
        let info = dests.info_over(http, dest).unwrap();
        crate::printers::capabilities_of(&info)
    };
    let close: HttpClose = sym(cups.handle(), "httpClose");
    unsafe { close(http) };
    let ids: Vec<&str> = caps.papers.iter().map(|p| p.id.as_str()).collect();
    assert!(ids.contains(&"iso_a4_210x297mm") && ids.contains(&"na_letter_8.5x11in"), "{ids:?}");
    let a4 = caps.papers.iter().find(|p| p.id == "iso_a4_210x297mm").unwrap();
    assert!((a4.width_pt - 595.28).abs() < 0.01 && (a4.height_pt - 841.89).abs() < 0.01);
    assert!(caps.default_paper.is_some());
    assert!(!caps.duplex);
    assert!(caps.color);
    assert_eq!(caps.max_copies, 999);
}

// ── against a running scheduler ─────────────────────────────────────────────
//
// One run of the whole flow against the system's cupsd: the queue is created
// with the install command, jobs printed with `lp` wait in it, and a pass
// takes, stages and purges them. It creates and removes a queue of its own,
// so it runs only when SPECTRAPDF_LIVE_CUPS=1 and this account may
// administer printers.

/// Removes the check's queue however the test ends.
struct LiveQueue(String);

impl Drop for LiveQueue {
    fn drop(&mut self) {
        let _ = administer_direct(&remove_args(&self.0));
    }
}

fn lp(queue: &str, options: &[&str], paths: &[PathBuf]) {
    let out = Command::new("/usr/bin/lp")
        .args(["-d", queue, "-t", "held check"])
        .args(options)
        .args(paths)
        .env("LC_ALL", "C")
        .output()
        .expect("lp runs");
    assert!(out.status.success(), "lp: {}", String::from_utf8_lossy(&out.stderr));
}

#[test]
fn a_held_queue_keeps_printed_jobs_until_a_pass_takes_and_purges_them() {
    if std::env::var("SPECTRAPDF_LIVE_CUPS").ok().as_deref() != Some("1")
        || !Path::new("/usr/bin/lp").is_file()
    {
        eprintln!("cupsd not available; skipping");
        return;
    }
    let Some(scheduler) = SystemScheduler::open().ok() else {
        eprintln!("cupsd not available; skipping");
        return;
    };
    let user = current_user().expect("the test user has a passwd entry");
    let queue = format!("Spectra-PDF-check-{}", std::process::id());
    let ppd_dir = tempfile::tempdir().unwrap();
    let ppd = ppd_dir.path().join("queue.ppd");
    std::fs::write(&ppd, queue_ppd("iso_a4_210x297mm")).unwrap();
    // The queue of the releases that delivered over loopback TCP.
    let legacy: Vec<String> = [
        "-p",
        &queue,
        "-v",
        "ipp://127.0.0.1:9/ipp/print?contimeout=30",
        "-P",
        ppd.to_str().unwrap(),
        "-o",
        "printer-error-policy=abort-job",
        "-o",
        "printer-is-shared=false",
        "-u",
        &format!("allow:{user}"),
        "-E",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    match administer_direct(&legacy) {
        Ok(()) => {}
        Err(None) => {
            eprintln!("cupsd not available to this account for administration; skipping");
            return;
        }
        Err(Some(e)) => panic!("lpadmin refused the loopback queue: {e}"),
    }
    let _cleanup = LiveQueue(queue.clone());
    let facts = queue_facts(&scheduler, &queue, &user).unwrap();
    assert_eq!(classify(facts.as_ref(), &user), QueueKind::Legacy, "{facts:?}");

    let files = tempfile::tempdir().unwrap();
    let file = |name: &str, data: &[u8]| {
        let path = files.path().join(name);
        std::fs::write(&path, data).unwrap();
        path
    };
    lp(&queue, &[], &[file("zero.pdf", PDF)]);
    configure(&queue, &user, DEFAULT_LOCATION, false).expect("the install command replaces the loopback queue");
    let facts = queue_facts(&scheduler, &queue, &user).unwrap().expect("the queue exists");
    assert_eq!(classify(Some(&facts), &user), QueueKind::Held, "{facts:?}");
    assert!(fully_configured(&facts), "{facts:?}");

    lp(&queue, &[], &[file("one.pdf", PDF)]);
    lp(&queue, &[], &[file("two.ps", PS)]);
    // 'no-hold': the stopped queue keeps the job pending.
    lp(&queue, &["-H", "immediate"], &[file("three.pdf", PDF)]);
    lp(&queue, &[], &[file("four.pdf", PDF), file("five.ps", PS)]);
    lp(&queue, &[], &[file("six.txt", b"plain words\n")]);
    let listed = jobs_from(&call(&scheduler, &get_jobs_request(&queue, &user)).unwrap()).unwrap();
    assert_eq!(listed.len(), 6, "{listed:?}");
    for job in &listed {
        assert!(job_is_complete(job), "{job:?}");
        assert_eq!(job.owner.as_deref(), Some(user.as_str()));
    }
    // The job the loopback queue was sending and the 'no-hold' job wait
    // pending on the stopped queue; the others are held.
    assert_eq!(listed.iter().filter(|job| job.state == job_state::HELD).count(), 4, "{listed:?}");
    assert_eq!(listed.iter().filter(|job| job.state == job_state::PENDING).count(), 2, "{listed:?}");
    assert_eq!(listed.iter().filter(|job| job.documents == 2).count(), 1, "{listed:?}");

    let f = folders();
    let errors = RefCell::new(Vec::new());
    let record = |e: String| errors.borrow_mut().push(e);
    let expand = |from: &Path, to: &mut dyn Write, limit: u64| scheduler.cups.expand_into(from, to, limit);
    let pass = Pass {
        scheduler: &scheduler,
        user: &user,
        queue: &queue,
        staging: &f.staging,
        ledger: &f.ledger,
        record_error: &record,
        expand: &expand,
    };
    let mut taker = Taker::default();
    assert_eq!(take_jobs(&pass, &mut taker), Ok(QueueKind::Held));
    assert_eq!(
        *errors.borrow(),
        [format!(
            "a print job arrived as text/plain data, which Spectra PDF does not convert; it was removed from {queue}"
        )]
    );
    let staged = staged(&f);
    assert_eq!(staged.len(), 6, "{:?}", staged.keys());
    assert_eq!(staged.values().filter(|data| data.as_slice() == PDF).count(), 4);
    assert_eq!(staged.values().filter(|data| data.as_slice() == PS).count(), 2);
    assert_eq!(names(&f.ledger).len(), 6);
    let left = jobs_from(&call(&scheduler, &get_jobs_request(&queue, &user)).unwrap()).unwrap();
    assert!(left.is_empty(), "{left:?}");
    let mut completed = get_jobs_request(&queue, &user);
    for attr in &mut completed.groups[0].attrs {
        if attr.name == "which-jobs" {
            attr.values = vec![Value::Keyword("completed".into())];
        }
    }
    // A purged job's record goes once processes still working on it exit;
    // its documents go at once.
    let mut history = Vec::new();
    for _ in 0..8 {
        history = jobs_from(&call(&scheduler, &completed).unwrap()).unwrap();
        if history.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    assert!(history.iter().all(|job| job.documents == 0), "purged jobs keep no documents: {history:?}");
    assert_eq!(take_jobs(&pass, &mut taker), Ok(QueueKind::Held));
    assert!(names(&f.ledger).is_empty(), "a full listing without the jobs prunes their entries");
}

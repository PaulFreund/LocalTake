use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const DISK_LIMIT: u64 = 900_000_000;

pub fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}
pub fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub trait TelemetrySink: Send + Sync {
    fn enqueue(&self, record: Value) -> bool;
    fn status(&self) -> Value;
    fn shutdown(&self) {}
    fn finished(&self) -> bool {
        true
    }
}

pub fn truncate(value: &str, max: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}

pub fn redact(value: &str) -> String {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            (r"\beyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?\b", "[redacted]"),
            (r"(?i)\bBearer\s+[^\s]+", "Bearer [redacted]"),
            (r"(?i)(a=ice-(?:pwd|ufrag):)[^\r\n]+", "${1}[redacted]"),
            (r"(?i)(\bufrag\s+)\S+", "${1}[redacted]"),
            (
                r"(?i)((?:https?|turns?)://)[^\s/@]+:[^\s/@]+@",
                "${1}[redacted]@",
            ),
            (
                r"(?i)([?#&](?:invite|token|credential|secret)=)[^&#\s]+",
                "${1}[redacted]",
            ),
        ]
        .into_iter()
        .map(|(r, s)| (Regex::new(r).expect("redaction regex"), s))
        .collect()
    });
    let mut result = value.to_owned();
    for (regex, replacement) in rules {
        result = regex.replace_all(&result, *replacement).into_owned();
    }
    result
}

pub fn compact(value: Value, depth: usize) -> Value {
    match value {
        Value::String(s) => truncate(&redact(&s), 1024).into(),
        Value::Array(_) | Value::Object(_) if depth >= 10 => "[truncated]".into(),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .take(24)
                .map(|v| compact(v, depth + 1))
                .collect(),
        ),
        Value::Object(items) => {
            static SECRET: OnceLock<Regex> = OnceLock::new();
            let secret = SECRET.get_or_init(|| Regex::new(r"(?i)^(?:.*token|.*secret|.*password|credential|authorization|cookie|username|usernameFragment|base64Certificate|icePwd|iceUfrag)$").unwrap());
            Value::Object(
                items
                    .into_iter()
                    .take(24)
                    .map(|(key, value)| {
                        let filtered = if secret.is_match(&key) {
                            "[redacted]".into()
                        } else if ["sdp", "chat", "text", "mediaData"]
                            .iter()
                            .any(|k| key.eq_ignore_ascii_case(k))
                        {
                            "[omitted]".into()
                        } else {
                            compact(value, depth + 1)
                        };
                        (truncate(&key, 80), filtered)
                    })
                    .collect(),
            )
        }
        other => other,
    }
}

#[derive(Clone)]
pub struct Options {
    pub directory: PathBuf,
    pub max_bytes: u64,
    pub segment_bytes: u64,
    pub retention: Duration,
    pub queue_bytes: usize,
    pub min_free_bytes: u64,
}
impl Options {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            max_bytes: DISK_LIMIT,
            segment_bytes: 8_000_000,
            retention: Duration::from_secs(7 * 86400),
            queue_bytes: 2 * 1024 * 1024,
            min_free_bytes: 256 * 1024 * 1024,
        }
    }
}

// The I/O boundary permits exercising slow and failed disks without changing the
// production protocol or adding test-only environment variables.
pub trait Disk: Send + Sync + 'static {
    fn available(&self, directory: &Path) -> io::Result<u64> {
        fs2::available_space(directory)
    }
    fn append(&self, path: &Path, data: &[u8]) -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)?.write_all(data)
    }
}
struct LocalDisk;
impl Disk for LocalDisk {}

#[derive(Default)]
struct Queue {
    rows: VecDeque<String>,
    bytes: usize,
    in_flight: usize,
    closed: bool,
    dropped: u64,
    retry_at: u64,
}
#[derive(Default)]
struct Shared {
    queue: Mutex<Queue>,
    changed: Condvar,
    disk_bytes: AtomicU64,
    files: AtomicUsize,
    done: AtomicBool,
}
pub struct TelemetryStore {
    shared: Arc<Shared>,
    options: Options,
}
struct LogFile {
    path: PathBuf,
    bytes: u64,
    time: u64,
}
struct Writer {
    options: Options,
    shared: Arc<Shared>,
    files: VecDeque<LogFile>,
    active: Option<PathBuf>,
    disk: Arc<dyn Disk>,
    last_disk_check: u64,
}

pub fn managed_time(name: &str) -> Option<u64> {
    let rest = name.strip_prefix("telemetry-")?.strip_suffix(".jsonl")?;
    if rest.len() != 50
        || rest.as_bytes()[13] != b'-'
        || !rest.as_bytes()[..13].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let id = &rest[14..];
    if id.len() != 36
        || !id
            .as_bytes()
            .iter()
            .all(|b| b.is_ascii_hexdigit() || *b == b'-')
        || id.chars().any(|c| c.is_ascii_uppercase())
    {
        return None;
    }
    rest[..13].parse().ok()
}

impl TelemetryStore {
    pub fn open(options: Options) -> io::Result<Self> {
        Self::open_with_disk(options, Arc::new(LocalDisk))
    }
    pub fn open_with_disk(mut options: Options, disk: Arc<dyn Disk>) -> io::Result<Self> {
        options.max_bytes = options.max_bytes.clamp(1, DISK_LIMIT);
        options.segment_bytes = options.segment_bytes.clamp(1, options.max_bytes);
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&options.directory)?;
        let mut files = Vec::new();
        for entry in fs::read_dir(&options.directory)? {
            let entry = entry?;
            let Some(time) = managed_time(&entry.file_name().to_string_lossy()) else {
                continue;
            };
            let info = entry.path().symlink_metadata()?;
            if info.is_file() {
                files.push(LogFile {
                    path: entry.path(),
                    bytes: info.len(),
                    time,
                });
            }
        }
        files.sort_by(|a, b| a.time.cmp(&b.time).then_with(|| a.path.cmp(&b.path)));
        let shared = Arc::new(Shared::default());
        shared
            .disk_bytes
            .store(files.iter().map(|f| f.bytes).sum(), Ordering::Relaxed);
        shared.files.store(files.len(), Ordering::Relaxed);
        let mut writer = Writer {
            options: options.clone(),
            shared: shared.clone(),
            files: files.into(),
            active: None,
            disk,
            last_disk_check: 0,
        };
        writer.prune(0)?;
        std::thread::Builder::new()
            .name("telemetry".into())
            .stack_size(256 * 1024)
            .spawn(move || writer.run())?;
        Ok(Self { shared, options })
    }

    pub fn flush(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut queue = self.shared.queue.lock().unwrap();
        self.shared.changed.notify_all();
        while queue.bytes != 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            queue = self
                .shared
                .changed
                .wait_timeout(queue, remaining)
                .unwrap()
                .0;
        }
        true
    }
}

impl TelemetrySink for TelemetryStore {
    fn enqueue(&self, record: Value) -> bool {
        {
            let mut queue = self.shared.queue.lock().unwrap();
            if queue.closed
                || now_ms() < queue.retry_at
                || queue.rows.len() + queue.in_flight >= 512
            {
                queue.dropped += 1;
                return false;
            }
        }
        // Serialization is bounded by the HTTP/frame limits and compaction. No
        // caller waits for the writer's I/O; its queue lock only moves strings.
        let mut line = match serde_json::to_string(&compact(record, 0)) {
            Ok(line) => line,
            Err(_) => return false,
        };
        line.push('\n');
        let mut queue = self.shared.queue.lock().unwrap();
        if queue.closed
            || now_ms() < queue.retry_at
            || line.len() as u64
                > self
                    .options
                    .max_bytes
                    .min(self.options.segment_bytes)
                    .min(16_384)
            || queue.rows.len() + queue.in_flight >= 512
            || queue.bytes + line.len() > self.options.queue_bytes
        {
            queue.dropped += 1;
            return false;
        }
        queue.bytes += line.len();
        queue.rows.push_back(line);
        self.shared.changed.notify_one();
        true
    }
    fn status(&self) -> Value {
        let q = self.shared.queue.lock().unwrap();
        json!({"enabled": !q.closed, "dropped": q.dropped, "bytes": self.shared.disk_bytes.load(Ordering::Relaxed), "queuedBytes": q.bytes, "files": self.shared.files.load(Ordering::Relaxed), "retryAt": q.retry_at})
    }
    fn shutdown(&self) {
        self.shared.queue.lock().unwrap().closed = true;
        self.shared.changed.notify_all();
    }
    fn finished(&self) -> bool {
        self.shared.done.load(Ordering::Acquire)
    }
}
impl Drop for TelemetryStore {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Writer {
    fn prune(&mut self, incoming: u64) -> io::Result<()> {
        let cutoff = now_ms().saturating_sub(self.options.retention.as_millis() as u64);
        while self.files.front().is_some_and(|f| {
            f.time < cutoff
                || self
                    .shared
                    .disk_bytes
                    .load(Ordering::Relaxed)
                    .saturating_add(incoming)
                    > self.options.max_bytes
        }) {
            let file = self.files.front().unwrap();
            match fs::remove_file(&file.path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            if self.active.as_ref() == Some(&file.path) {
                self.active = None;
            }
            let bytes = file.bytes;
            self.files.pop_front();
            self.shared.disk_bytes.fetch_sub(bytes, Ordering::Relaxed);
        }
        self.shared.files.store(self.files.len(), Ordering::Relaxed);
        Ok(())
    }

    fn write(&mut self, buffer: &[u8]) -> io::Result<()> {
        self.prune(0)?;
        let now = now_ms();
        if now.saturating_sub(self.last_disk_check) >= 30_000 {
            if self.disk.available(&self.options.directory)? < self.options.min_free_bytes {
                return Err(io::Error::other("Low disk space"));
            }
            self.last_disk_check = now;
        }
        if buffer.is_empty() {
            return Ok(());
        }
        if self.files.back().is_some_and(|f| {
            f.bytes + buffer.len() as u64 > self.options.segment_bytes
                || now.saturating_sub(f.time) >= 86_400_000
        }) {
            self.active = None;
        }
        self.prune(buffer.len() as u64)?;
        if self.active.is_none() {
            let path = self
                .options
                .directory
                .join(format!("telemetry-{now}-{}.jsonl", Uuid::new_v4()));
            self.files.push_back(LogFile {
                path: path.clone(),
                bytes: 0,
                time: now,
            });
            self.active = Some(path);
            self.shared.files.store(self.files.len(), Ordering::Relaxed);
        }
        let file = self.files.back_mut().unwrap();
        // Reserve before append so a partial disk write also stays within cap.
        file.bytes += buffer.len() as u64;
        self.shared
            .disk_bytes
            .fetch_add(buffer.len() as u64, Ordering::Relaxed);
        self.disk.append(&file.path, buffer)
    }

    fn run(&mut self) {
        let mut buffer = Vec::with_capacity(65_536.min(self.options.segment_bytes as usize));
        loop {
            let mut q = self.shared.queue.lock().unwrap();
            if q.rows.is_empty() && !q.closed {
                let (next, result) = self
                    .shared
                    .changed
                    .wait_timeout(q, Duration::from_secs(60))
                    .unwrap();
                q = next;
                if !result.timed_out() && q.rows.is_empty() && !q.closed {
                    continue;
                }
            }
            if q.closed && q.rows.is_empty() {
                break;
            }
            if now_ms() < q.retry_at && !q.closed {
                let wait = Duration::from_millis(q.retry_at - now_ms().min(q.retry_at));
                drop(self.shared.changed.wait_timeout(q, wait).unwrap());
                continue;
            }
            buffer.clear();
            let mut count = 0;
            while q.rows.front().is_some_and(|r| {
                buffer.len() + r.len() <= 65_536.min(self.options.segment_bytes as usize)
            }) {
                buffer.extend_from_slice(q.rows.pop_front().unwrap().as_bytes());
                count += 1;
            }
            q.in_flight = count;
            drop(q);
            let result = self.write(&buffer);
            let mut q = self.shared.queue.lock().unwrap();
            if result.is_err() {
                q.dropped += (q.rows.len() + count) as u64;
                q.rows.clear();
                q.bytes = 0;
                q.retry_at = now_ms() + 60_000;
                self.last_disk_check = 0;
            } else {
                q.bytes -= buffer.len();
            }
            q.in_flight = 0;
            self.shared.changed.notify_all();
        }
        self.shared.done.store(true, Ordering::Release);
        self.shared.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options(directory: &Path) -> Options {
        let mut o = Options::new(directory);
        o.min_free_bytes = 0;
        o
    }
    fn rows(directory: &Path) -> Vec<Value> {
        let mut entries: Vec<_> = fs::read_dir(directory)
            .unwrap()
            .map(Result::unwrap)
            .filter(|e| managed_time(&e.file_name().to_string_lossy()).is_some())
            .collect();
        entries.sort_by_key(|e| e.file_name());
        entries
            .iter()
            .flat_map(|e| {
                fs::read_to_string(e.path())
                    .unwrap()
                    .lines()
                    .map(|s| serde_json::from_str(s).unwrap())
                    .collect::<Vec<_>>()
            })
            .collect()
    }
    #[test]
    fn rotation_restart_and_retention_preserve_other_files() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("keep.txt"), "keep").unwrap();
        let stale = format!(
            "telemetry-{}-{}.jsonl",
            now_ms() - 8 * 86_400_000,
            Uuid::new_v4()
        );
        fs::write(directory.path().join(stale), "stale").unwrap();
        let mut o = options(directory.path());
        o.max_bytes = 1000;
        o.segment_bytes = 300;
        let store = TelemetryStore::open(o.clone()).unwrap();
        for sequence in 0..24 {
            assert!(store.enqueue(json!({"sequence": sequence, "value": "x".repeat(100)})));
            assert!(store.flush(Duration::from_secs(2)));
            assert!(store.status()["bytes"].as_u64().unwrap() <= 1000);
        }
        let data = rows(directory.path());
        assert!(data.iter().any(|r| r["sequence"] == 23));
        assert!(!data.iter().any(|r| r["sequence"] == 0));
        store.shutdown();
        while !store.finished() {
            std::thread::yield_now();
        }
        o.max_bytes = 500;
        let store = TelemetryStore::open(o).unwrap();
        assert!(store.status()["bytes"].as_u64().unwrap() <= 500);
        assert!(store.enqueue(json!({"sequence": 24})));
        assert!(store.flush(Duration::from_secs(2)));
        assert!(rows(directory.path()).iter().any(|r| r["sequence"] == 24));
        assert_eq!(
            fs::read_to_string(directory.path().join("keep.txt")).unwrap(),
            "keep"
        );
        store.shutdown();
        while !store.finished() {
            std::thread::yield_now();
        }
    }
    struct FailingDisk;
    impl Disk for FailingDisk {
        fn append(&self, _: &Path, _: &[u8]) -> io::Result<()> {
            Err(io::ErrorKind::PermissionDenied.into())
        }
    }
    #[test]
    fn write_failure_backs_off_without_throwing() {
        let directory = tempfile::tempdir().unwrap();
        let store =
            TelemetryStore::open_with_disk(options(directory.path()), Arc::new(FailingDisk))
                .unwrap();
        assert!(store.enqueue(json!({"first": true})));
        assert!(store.flush(Duration::from_secs(2)));
        assert!(store.status()["retryAt"].as_u64().unwrap() > now_ms());
        assert!(!store.enqueue(json!({"later": true})));
        store.shutdown();
        while !store.finished() {
            std::thread::yield_now();
        }
    }
    #[test]
    fn redaction_compaction_and_record_limits() {
        let data = compact(
            json!({"token": "PRIVATE", "nested": {"sdp": "PRIVATE", "chat": "PRIVATE", "usernameFragment": "PRIVATE", "message": "Bearer PRIVATE and ?token=PRIVATE"}, "rows": vec!["x".repeat(2000); 100]}),
            0,
        );
        let text = data.to_string();
        assert!(!text.contains("PRIVATE"));
        assert_eq!(data["rows"].as_array().unwrap().len(), 24);
        assert_eq!(data["rows"][0].as_str().unwrap().len(), 1024);
        let directory = tempfile::tempdir().unwrap();
        let store = TelemetryStore::open(options(directory.path())).unwrap();
        assert!(!store.enqueue(json!({"rows": vec!["x".repeat(1024); 24]})));
        store.shutdown();
        while !store.finished() {
            std::thread::yield_now();
        }
    }
    struct StalledDisk {
        entered: AtomicBool,
        release: (Mutex<bool>, Condvar),
    }
    impl Disk for StalledDisk {
        fn append(&self, path: &Path, data: &[u8]) -> io::Result<()> {
            self.entered.store(true, Ordering::Release);
            let mut released = self.release.0.lock().unwrap();
            while !*released {
                released = self.release.1.wait(released).unwrap();
            }
            LocalDisk.append(path, data)
        }
    }
    #[test]
    fn stalled_disk_bounds_memory_including_in_flight_writes() {
        let directory = tempfile::tempdir().unwrap();
        let disk = Arc::new(StalledDisk {
            entered: AtomicBool::new(false),
            release: (Mutex::new(false), Condvar::new()),
        });
        let mut o = options(directory.path());
        o.queue_bytes = 400;
        let store = TelemetryStore::open_with_disk(o, disk.clone()).unwrap();
        assert!(store.enqueue(json!({"value": "x".repeat(150)})));
        let deadline = Instant::now() + Duration::from_secs(2);
        while !disk.entered.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        for _ in 0..1000 {
            store.enqueue(json!({"value": "x".repeat(150)}));
        }
        assert!(store.status()["queuedBytes"].as_u64().unwrap() <= 400);
        assert!(store.status()["dropped"].as_u64().unwrap() > 990);
        *disk.release.0.lock().unwrap() = true;
        disk.release.1.notify_all();
        assert!(store.flush(Duration::from_secs(2)));
        assert_eq!(store.status()["queuedBytes"], 0);
        store.shutdown();
        while !store.finished() {
            std::thread::yield_now();
        }
    }
    struct FullDisk;
    impl Disk for FullDisk {
        fn available(&self, _: &Path) -> io::Result<u64> {
            Ok(0)
        }
        fn append(&self, _: &Path, _: &[u8]) -> io::Result<()> {
            panic!("must check disk space before writing")
        }
    }
    #[test]
    fn low_disk_space_discards_and_backs_off() {
        let directory = tempfile::tempdir().unwrap();
        let mut o = options(directory.path());
        o.min_free_bytes = 1024;
        let store = TelemetryStore::open_with_disk(o, Arc::new(FullDisk)).unwrap();
        assert!(store.enqueue(json!({"event": "test"})));
        assert!(store.flush(Duration::from_secs(2)));
        assert_eq!(store.status()["dropped"], 1);
        assert!(store.status()["retryAt"].as_u64().unwrap() > now_ms());
        store.shutdown();
        while !store.finished() {
            std::thread::yield_now();
        }
    }
    #[test]
    fn existing_overhang_and_daily_rotation_obey_the_disk_cap() {
        let directory = tempfile::tempdir().unwrap();
        let name = format!("telemetry-{}-{}.jsonl", now_ms(), Uuid::new_v4());
        fs::write(directory.path().join(name), vec![b'x'; 1200]).unwrap();
        let mut o = options(directory.path());
        o.max_bytes = 1000;
        let store = TelemetryStore::open(o.clone()).unwrap();
        assert_eq!(store.status()["bytes"], 0);
        store.shutdown();
        while !store.finished() {
            std::thread::yield_now();
        }
        let shared = Arc::new(Shared::default());
        let mut writer = Writer {
            options: o,
            shared,
            files: VecDeque::new(),
            active: None,
            disk: Arc::new(LocalDisk),
            last_disk_check: 0,
        };
        writer.write(b"{\"first\":true}\n").unwrap();
        writer.files.back_mut().unwrap().time -= 86_400_001;
        writer.write(b"{\"second\":true}\n").unwrap();
        assert_eq!(writer.files.len(), 2);
    }
}

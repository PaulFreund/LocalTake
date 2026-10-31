use crate::telemetry::managed_time;
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs,
    io::{self, BufRead, BufReader, Write},
    path::Path,
};

pub fn read(
    directory: &Path,
    args: &[String],
    output: &mut impl Write,
) -> Result<(), Box<dyn std::error::Error>> {
    let usage = "Usage: localtake-server telemetry-read [--room UUID] [--participant UUID] [--recording UUID] [--page UUID]";
    let mut filters = Vec::new();
    for pair in args.chunks(2) {
        if pair.len() != 2
            || !["--room", "--participant", "--recording", "--page"].contains(&pair[0].as_str())
            || pair[1].len() != 36
            || !pair[1].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
        {
            return Err(usage.into());
        }
        filters.retain(|(key, _)| *key != pair[0].as_str());
        filters.push((pair[0].as_str(), pair[1].as_str()));
    }
    let mut files: Vec<_> = fs::read_dir(directory)?
        .filter_map(Result::ok)
        .filter(|e| managed_time(&e.file_name().to_string_lossy()).is_some())
        .collect();
    files.sort_by_key(|e| e.file_name());
    let mut rows = VecDeque::with_capacity(200);
    let start = files.len().saturating_sub(4);
    for entry in &files[start..] {
        let file = match fs::File::open(entry.path()) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        let mut input = BufReader::with_capacity(16_384, file);
        let mut line = Vec::with_capacity(16_384);
        loop {
            line.clear();
            let mut oversized = false;
            let mut read = false;
            // Never allocate for an entire malformed or externally edited line.
            loop {
                let buffer = input.fill_buf()?;
                if buffer.is_empty() {
                    break;
                }
                read = true;
                let count = buffer
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|n| n + 1)
                    .unwrap_or(buffer.len());
                let ended = buffer[count - 1] == b'\n';
                if line.len() + count > 16_385 {
                    oversized = true;
                }
                if !oversized {
                    line.extend_from_slice(&buffer[..count]);
                }
                input.consume(count);
                if ended {
                    break;
                }
            }
            if !read {
                break;
            }
            if oversized {
                continue;
            }
            let Ok(row) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if filters.iter().all(|(key, id)| {
                let found = match *key {
                    "--room" => &row["roomId"],
                    "--participant" => &row["participantId"],
                    "--page" => &row["batch"]["pageId"],
                    "--recording" => row
                        .get("recordingId")
                        .unwrap_or(&row["batch"]["sample"]["recording"]["recordingId"]),
                    _ => unreachable!(),
                };
                found.as_str() == Some(*id)
            }) {
                if rows.len() == 200 {
                    rows.pop_front();
                }
                while matches!(line.last(), Some(b'\r' | b'\n')) {
                    line.pop();
                }
                rows.push_back(line.clone());
            }
        }
    }
    for row in rows {
        output.write_all(&row)?;
        output.write_all(b"\n")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reader_filters_caps_output_and_skips_oversized_lines() {
        let dir = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let name = format!("telemetry-1700000000000-{}.jsonl", uuid::Uuid::new_v4());
        let mut contents = "x".repeat(100_000);
        contents.push('\n');
        for sequence in 0..250 {
            contents.push_str(&serde_json::json!({"roomId": id, "sequence": sequence}).to_string());
            contents.push('\n');
        }
        contents.push_str("unfinished{");
        fs::write(dir.path().join(name), contents).unwrap();
        let mut output = Vec::new();
        read(dir.path(), &["--room".into(), id], &mut output).unwrap();
        let output = String::from_utf8(output).unwrap();
        assert_eq!(output.lines().count(), 200);
        assert_eq!(
            serde_json::from_str::<Value>(output.lines().next().unwrap()).unwrap()["sequence"],
            50
        );
    }
}

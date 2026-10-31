use localtake_server::{
    coordinator::{Config, Coordinator},
    http,
    telemetry::{Options, TelemetryStore},
    telemetry_read,
};
use std::{
    env,
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    match dotenvy::dotenv() {
        Ok(_) => {}
        Err(dotenvy::Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let args: Vec<_> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("telemetry-read") => {
            let directory =
                env::var("TELEMETRY_DIR").map_err(|_| "TELEMETRY_DIR is not configured")?;
            return telemetry_read::read(
                &PathBuf::from(directory),
                &args[1..],
                &mut std::io::stdout().lock(),
            );
        }
        Some("healthcheck") => {
            let port = env::var("PORT")
                .unwrap_or_else(|_| "3000".into())
                .parse::<u16>()?;
            let mut socket = TcpStream::connect_timeout(
                &format!("127.0.0.1:{port}").parse()?,
                Duration::from_secs(3),
            )?;
            socket.set_read_timeout(Some(Duration::from_secs(3)))?;
            socket.write_all(
                b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )?;
            let mut buffer = [0; 128];
            let n = socket.read(&mut buffer)?;
            return if buffer[..n].starts_with(b"HTTP/1.1 200 ") {
                Ok(())
            } else {
                Err("Health check failed".into())
            };
        }
        Some("--version") => {
            println!("localtake-server {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some(_) => {
            return Err("Usage: localtake-server [healthcheck|telemetry-read|--version]".into());
        }
        None => {}
    }
    // One network event loop avoids allocating an OS thread/stack per CPU on
    // large hosts. File serving uses at most four lazily created blocking workers.
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(4)
        .thread_stack_size(256 * 1024)
        .build()?
        .block_on(serve())
}
async fn serve() -> Result<(), Box<dyn std::error::Error>> {
    let production = env::var("NODE_ENV").is_ok_and(|v| v == "production");
    let secret = env::var("ROOM_SIGNING_SECRET")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if production {
                String::new()
            } else {
                format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                )
            }
        });
    if secret.encode_utf16().count() < 32 {
        return Err("ROOM_SIGNING_SECRET muss mindestens 32 Zeichen lang sein.".into());
    }
    if production && secret.starts_with("replace-with-") {
        return Err("ROOM_SIGNING_SECRET ist noch ein Beispielwert.".into());
    }
    let port = env::var("PORT")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if production {
                "3000".into()
            } else {
                "43170".into()
            }
        })
        .parse::<u16>()?;
    let origin = env::var("PUBLIC_ORIGIN")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("http://localhost:{port}"));
    if production && !origin.starts_with("https://") {
        return Err("PUBLIC_ORIGIN muss in Produktion HTTPS verwenden.".into());
    }
    let mut config = Config::new(secret, origin);
    config.max_participants = env::var("MAX_PARTICIPANTS")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .map(|n| n.clamp(2.0, 4.0).ceil() as usize)
        .unwrap_or(4);
    config.turn_enabled = match env::var("TURN_ENABLED").as_deref().unwrap_or("true") {
        "true" => true,
        "false" => false,
        _ => return Err("TURN_ENABLED muss true oder false sein.".into()),
    };
    config.ice_transport_policy = env::var("ICE_TRANSPORT_POLICY").unwrap_or_else(|_| "all".into());
    config.turn_urls = env::var("TURN_URLS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    config.turn_secret = env::var("TURN_SHARED_SECRET")
        .ok()
        .filter(|s| !s.is_empty());
    config.validate()?;
    if config.turn_enabled
        && config
            .turn_urls
            .iter()
            .any(|u| u.starts_with("turn:") || u.starts_with("turns:"))
        && config
            .turn_secret
            .as_ref()
            .is_none_or(|s| s.starts_with("replace-with-"))
    {
        return Err("TURN-URLs erfordern ein echtes TURN_SHARED_SECRET.".into());
    }
    config.client_dir = Some(
        env::var("CLIENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("dist/client")),
    );
    if let Some(directory) = env::var("TELEMETRY_DIR").ok().filter(|s| !s.is_empty()) {
        let mut options = Options::new(directory);
        options.max_bytes = env::var("TELEMETRY_MAX_BYTES")
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v > 0.0)
            .map(|v| {
                v.floor()
                    .clamp(1.0, localtake_server::telemetry::DISK_LIMIT as f64)
                    as u64
            })
            .unwrap_or(localtake_server::telemetry::DISK_LIMIT);
        match TelemetryStore::open(options) {
            Ok(store) => config.telemetry = Some(Arc::new(store)),
            Err(_) => eprintln!(
                "Telemetrie konnte nicht geöffnet werden; der Dienst läuft ohne Diagnoseprotokoll weiter."
            ),
        }
    }
    let app = Coordinator::new(config)?;
    let host = env::var("HOST")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "127.0.0.1".into());
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    println!("LocalTake listening on http://{}", listener.local_addr()?);
    let signal_app = app.clone();
    axum::serve(
        listener,
        http::router(app.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        signal_app.shutdown();
    })
    .await?;
    if let Some(sink) = &app.config.telemetry {
        let _ = tokio::time::timeout(Duration::from_millis(1500), async {
            while !sink.finished() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
    }
    Ok(())
}

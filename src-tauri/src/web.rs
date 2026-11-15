//! What the Markdown preview needs from outside the page, each only after a user action the frontend has
//! confirmed: open a link in the system browser, and download one remote image. The frontend never makes
//! requests itself (strict CSP), so this is the only network code besides `ai::net`.

use std::{net::IpAddr, sync::OnceLock, time::Duration};

use reqwest::{Client, Url, redirect};
use tauri::ipc::Response;

use crate::files;

const MAX_LINK_LEN: usize = 2048;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IMAGE_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 3;

/// A link the preview may hand to the browser: http or https with a host, or mailto with an address. No
/// whitespace or control characters, no other scheme (file:, javascript:, data:, ...).
pub fn link_ok(url: &str) -> bool {
    if url.is_empty()
        || url.len() > MAX_LINK_LEN
        || url.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return false;
    }
    let Ok(u) = Url::parse(url) else { return false };
    match u.scheme() {
        "http" | "https" => u.host_str().is_some_and(|h| !h.is_empty()),
        "mailto" => !u.path().is_empty(),
        _ => false,
    }
}

/// Opens a link in the default browser / mail program. The frontend has asked the user first.
#[tauri::command]
pub fn open_link(url: String) -> Result<(), String> {
    if !link_ok(&url) {
        return Err("Only http, https and mailto links can be opened.".into());
    }
    files::spawn_open(&url)
}

fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
        }
        IpAddr::V6(v) => {
            v.is_loopback()
                || v.is_unspecified()
                || (v.segments()[0] & 0xfe00) == 0xfc00 // unique local
                || (v.segments()[0] & 0xffc0) == 0xfe80 // link local
                || v.to_ipv4_mapped().is_some_and(|m| private_ip(IpAddr::V4(m)))
        }
    }
}

/// An image address we will download: http(s), a public-looking host (not localhost, a `.local` name or a
/// private / loopback IP address), no user name or password. (A name that resolves to a private address is
/// not caught: the request is a plain GET the user asked for.)
pub fn image_url_ok(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if let Ok(ip) = host.parse::<IpAddr>() {
        return !private_ip(ip);
    }
    !(host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local"))
}

/// 1 PNG, 2 JPEG, 3 GIF, 4 WebP, by the file's first bytes. Anything else (SVG, HTML...) is refused.
pub fn sniff_image(b: &[u8]) -> Option<u8> {
    if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some(1)
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(2)
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some(3)
    } else if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(4)
    } else {
        None
    }
}

fn client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default(); // Err = already installed
            Client::builder()
                .user_agent("My-Note") // some image hosts refuse requests that have none
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(IMAGE_TIMEOUT)
                .redirect(redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= MAX_REDIRECTS || !image_url_ok(attempt.url()) {
                        attempt.stop()
                    } else {
                        attempt.follow()
                    }
                }))
                .build()
                .map_err(|e| format!("Could not set up networking: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Downloads `url` (at most `cap` bytes) and returns the image kind and bytes.
async fn download(c: &Client, url: Url, cap: usize) -> Result<(u8, Vec<u8>), String> {
    let mut resp = c
        .get(url)
        .header("Accept", "image/png,image/jpeg,image/gif,image/webp")
        .send()
        .await
        .map_err(|e| format!("Could not load the image: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("The server answered {}.", resp.status().as_u16()));
    }
    if resp.content_length().is_some_and(|n| n > cap as u64) {
        return Err("The image is too large (over 5 MB).".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Could not load the image: {e}"))?
    {
        if body.len() + chunk.len() > cap {
            return Err("The image is too large (over 5 MB).".into());
        }
        body.extend_from_slice(&chunk);
    }
    let kind = sniff_image(&body).ok_or("That address is not a PNG, JPEG, GIF or WebP image.")?;
    Ok((kind, body))
}

/// Downloads one remote image for the preview. Runs only after the user agreed, for that file, to load
/// remote images. The reply is one byte for the kind (1 PNG, 2 JPEG, 3 GIF, 4 WebP) and then the bytes.
#[tauri::command]
pub async fn fetch_image(url: String) -> Result<Response, String> {
    let u = Url::parse(&url).map_err(|_| "Not a valid address.".to_string())?;
    if !image_url_ok(&u) {
        return Err("That image address is not allowed.".into());
    }
    let (kind, bytes) = download(client()?, u, MAX_IMAGE_BYTES).await?;
    let mut out = Vec::with_capacity(bytes.len() + 1);
    out.push(kind);
    out.extend_from_slice(&bytes);
    Ok(Response::new(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };
    use tauri::async_runtime::block_on;

    #[test]
    fn only_http_https_and_mailto_links_open() {
        for ok in [
            "https://example.com/a?b=c#d",
            "http://example.com",
            "mailto:me@example.com",
            "mailto:me@example.com?subject=Hi%20there",
        ] {
            assert!(link_ok(ok), "{ok}");
        }
        for bad in [
            "",
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,<script>alert(1)</script>",
            "ftp://example.com/x",
            "vbscript:x",
            "ms-msdt:/id",
            "https://",
            "mailto:",
            "https://exa mple.com",
            "https://example.com/\nx",
            "//example.com",
            "example.com",
            "/relative/path",
            "#anchor",
        ] {
            assert!(!link_ok(bad), "{bad:?}");
        }
        assert!(!link_ok(&format!(
            "https://example.com/{}",
            "a".repeat(3000)
        )));
    }

    fn img_ok(s: &str) -> bool {
        image_url_ok(&Url::parse(s).unwrap())
    }

    #[test]
    fn image_hosts_must_look_public() {
        assert!(img_ok("https://example.com/a.png"));
        assert!(img_ok("http://93.184.216.34/a.png"));
        assert!(img_ok("https://[2606:2800:220:1::1]/a.png"));
        for bad in [
            "http://localhost/a.png",
            "http://foo.localhost/a.png",
            "http://printer.local/a.png",
            "http://127.0.0.1/a.png",
            "http://10.1.2.3/a.png",
            "http://192.168.0.1/a.png",
            "http://172.16.5.5/a.png",
            "http://169.254.169.254/latest/meta-data",
            "http://0.0.0.0/a.png",
            "http://[::1]/a.png",
            "http://[fe80::1]/a.png",
            "http://[fd00::1]/a.png",
            "http://[::ffff:127.0.0.1]/a.png",
            "https://user:pw@example.com/a.png",
            "ftp://example.com/a.png",
            "file:///C:/a.png",
        ] {
            assert!(!img_ok(bad), "{bad}");
        }
    }

    #[test]
    fn images_are_recognised_by_their_bytes_not_their_name() {
        assert_eq!(sniff_image(&[0x89, b'P', b'N', b'G', 13, 10]), Some(1));
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(2));
        assert_eq!(sniff_image(b"GIF89a...."), Some(3));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some(4));
        assert_eq!(
            sniff_image(b"<svg xmlns='http://www.w3.org/2000/svg' onload='x()'/>"),
            None
        );
        assert_eq!(sniff_image(b"<!doctype html><script>"), None);
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(sniff_image(b""), None);
    }

    /// A one-shot HTTP server that answers every request with `reply`.
    fn serve(reply: Vec<u8>) -> String {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { break };
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                let _ = s.write_all(&reply);
            }
        });
        format!("http://{addr}/img")
    }

    fn http(status: &str, body: &[u8]) -> Vec<u8> {
        let mut r = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        r.extend_from_slice(body);
        r
    }

    fn get(url: &str, cap: usize) -> Result<(u8, Vec<u8>), String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let c = Client::builder().no_proxy().build().unwrap();
        block_on(download(&c, Url::parse(url).unwrap(), cap))
    }

    #[test]
    fn download_returns_a_sniffed_image_and_refuses_the_rest() {
        let png = [0x89, b'P', b'N', b'G', 1, 2, 3, 4];
        assert_eq!(
            get(&serve(http("200 OK", &png)), 100),
            Ok((1, png.to_vec()))
        );
        let svg = b"<svg onload='alert(1)'></svg>";
        let e = get(&serve(http("200 OK", svg)), 100).unwrap_err();
        assert!(e.contains("not a PNG"), "{e}");
        let e = get(&serve(http("404 Not Found", b"nope")), 100).unwrap_err();
        assert!(e.contains("404"), "{e}");
        let big = [0x89, b'P', b'N', b'G', 0, 0, 0, 0, 0, 0];
        let e = get(&serve(http("200 OK", &big)), 8).unwrap_err();
        assert!(e.contains("too large"), "{e}");
    }

    #[test]
    fn a_body_over_the_cap_without_a_length_is_cut_off() {
        let mut r = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        r.extend_from_slice(&[0x89, b'P', b'N', b'G']);
        r.extend_from_slice(&vec![0u8; 5000]);
        let e = get(&serve(r), 1000).unwrap_err();
        assert!(e.contains("too large"), "{e}");
    }
}

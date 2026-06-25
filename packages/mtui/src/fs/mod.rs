use anyhow::Context;
use std::io::Write;
use std::path::Path;

pub fn compute_hash(content: &[u8]) -> String {
    blake3::hash(content).to_hex().to_string()
}

pub fn read_file_utf8(path: &Path) -> anyhow::Result<String> {
    let content =
        std::fs::read(path).with_context(|| format!("Failed to read file: {}", path.display()))?;
    String::from_utf8(content).context("File is not valid UTF-8")
}

pub fn read_file_bytes(path: &Path) -> anyhow::Result<Vec<u8>> {
    std::fs::read(path).with_context(|| format!("Failed to read file: {}", path.display()))
}

pub fn atomic_write(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    let parent = path.parent().context("No parent directory")?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(content)?;
    tmp.flush()?;
    tmp.persist(path)?;
    Ok(())
}

pub fn detect_newline_style(content: &str) -> &'static str {
    if content.contains("\r\n") {
        if content.contains('\n') && !content.contains("\r\n") {
            return "\n";
        }
        "\r\n"
    } else {
        "\n"
    }
}

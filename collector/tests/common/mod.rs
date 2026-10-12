#![allow(dead_code)]

use std::path::PathBuf;

/// La salida real de Nod que acompaña al contrato (8 sobres, 13 eventos).
pub fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/nod-v1-sesion-real.jsonl")
}

pub fn fixture_lines() -> Vec<String> {
    std::fs::read_to_string(fixture())
        .expect("fixture")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(String::from)
        .collect()
}

/// Un directorio vacío y propio de cada test.
pub fn tempdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nod-collector-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

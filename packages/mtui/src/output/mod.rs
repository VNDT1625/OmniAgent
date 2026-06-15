use serde::Serialize;

pub const SCHEMA_VERSION: u16 = 1;
pub const MTUI_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Serialize)]
pub struct SuccessResponse<T: Serialize> {
    pub ok: bool,
    pub schema_version: u16,
    pub mtui_version: &'static str,
    pub warnings: Vec<String>,
    #[serde(flatten)]
    pub data: T,
}

impl<T: Serialize> SuccessResponse<T> {
    pub fn new(data: T) -> Self {
        SuccessResponse {
            ok: true,
            schema_version: SCHEMA_VERSION,
            mtui_version: MTUI_VERSION,
            warnings: Vec::new(),
            data,
        }
    }
}

#[derive(Clone, Copy)]
pub enum OutputMode {
    Json,
    Human,
}

pub fn print_json<T: Serialize>(value: &T) {
    if let Ok(json) = serde_json::to_string_pretty(value) {
        println!("{}", json);
    }
}

pub fn print_error_json(err_response: &crate::error::ErrorResponse) {
    if let Ok(json) = serde_json::to_string_pretty(err_response) {
        eprintln!("{}", json);
    }
}

pub fn print_human_error(err: &crate::error::MtuiError) {
    eprintln!("Error: {}", err);
    if let Some(suggestion) = err.suggestion() {
        eprintln!("Hint: {}", suggestion);
    }
}

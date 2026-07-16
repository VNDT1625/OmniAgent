use serde::Serialize;

pub const SCHEMA_VERSION: u16 = 1;
pub const MTUI_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Serialize)]
pub struct SuccessResponse<T: Serialize> {
    pub ok: bool,
    pub schema_version: u16,
    pub mtui_version: &'static str,
    #[serde(skip_serializing_if = "Vec::is_empty")]
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
    if let Ok(json) = serde_json::to_string(value) {
        println!("{}", json);
    }
}

pub fn print_error_json(err_response: &crate::error::ErrorResponse) {
    if let Ok(json) = serde_json::to_string(err_response) {
        eprintln!("{}", json);
    }
}

pub fn print_human_error(err: &crate::error::MtuiError) {
    eprintln!("Error: {}", err);
    if let Some(suggestion) = err.suggestion() {
        eprintln!("Hint: {}", suggestion);
    }
}

#[cfg(test)]
mod tests {
    use super::SuccessResponse;

    #[test]
    fn success_response_omits_empty_warnings_and_serializes_compactly() {
        let response = SuccessResponse::new(serde_json::json!({ "command": "search" }));
        let json = serde_json::to_string(&response).expect("serialize response");

        assert!(!json.contains('\n'));
        assert!(!json.contains("warnings"));
        assert!(json.contains("\"command\":\"search\""));
    }
}

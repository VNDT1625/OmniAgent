use crate::error::MtuiError;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CACHE_TTL_SECS: u64 = 60 * 60;
const PRICING_ENDPOINT: &str = "https://llmprices.ai/api/pricing";

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct LlmPricesPricing {
    pub prompt: String,
    pub completion: String,
    pub input_cache_read: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct LlmPricesResponse {
    pub id: String,
    pub name: String,
    pub pricing: LlmPricesPricing,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CachedPricing {
    fetched_at: u64,
    source: String,
    data: LlmPricesResponse,
}

#[derive(Debug, Serialize)]
pub struct PricingModelResult {
    pub command: String,
    pub model: String,
    pub source: String,
    pub cached: bool,
    pub fetched_at: u64,
    pub cache_ttl_seconds: u64,
    pub id: String,
    pub name: String,
    pub prompt_per_token_usd: f64,
    pub completion_per_token_usd: f64,
    pub input_cache_read_per_token_usd: Option<f64>,
    pub prompt_per_million_usd: f64,
    pub completion_per_million_usd: f64,
    pub input_cache_read_per_million_usd: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct PricingEstimateResult {
    #[serde(flatten)]
    pub model: PricingModelResult,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    pub input_cost_usd: f64,
    pub output_cost_usd: f64,
    pub cached_input_cost_usd: f64,
    pub total_cost_usd: f64,
}

pub fn lookup_model(
    project_root: &Path,
    model: &str,
    refresh: bool,
) -> Result<PricingModelResult, MtuiError> {
    let cache_path = cache_path(project_root, model);
    if !refresh {
        if let Some(cached) = read_fresh_cache(&cache_path)? {
            return model_result(model, cached, true);
        }
    }

    let data = fetch_pricing(model)?;
    let cached = CachedPricing {
        fetched_at: unix_now(),
        source: PRICING_ENDPOINT.to_string(),
        data,
    };
    write_cache(&cache_path, &cached)?;
    model_result(model, cached, false)
}

pub fn estimate(
    project_root: &Path,
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    cached_input_tokens: u64,
    refresh: bool,
) -> Result<PricingEstimateResult, MtuiError> {
    let model_result = lookup_model(project_root, model, refresh)?;
    let normal_input_tokens = input_tokens.saturating_sub(cached_input_tokens);
    let cached_price = model_result
        .input_cache_read_per_token_usd
        .unwrap_or(model_result.prompt_per_token_usd);
    let input_cost = normal_input_tokens as f64 * model_result.prompt_per_token_usd;
    let output_cost = output_tokens as f64 * model_result.completion_per_token_usd;
    let cached_input_cost = cached_input_tokens as f64 * cached_price;
    Ok(PricingEstimateResult {
        model: model_result,
        input_tokens,
        output_tokens,
        cached_input_tokens,
        input_cost_usd: round_usd(input_cost),
        output_cost_usd: round_usd(output_cost),
        cached_input_cost_usd: round_usd(cached_input_cost),
        total_cost_usd: round_usd(input_cost + output_cost + cached_input_cost),
    })
}

fn model_result(
    requested_model: &str,
    cached: CachedPricing,
    from_cache: bool,
) -> Result<PricingModelResult, MtuiError> {
    let prompt = parse_price(&cached.data.pricing.prompt, "pricing.prompt")?;
    let completion = parse_price(&cached.data.pricing.completion, "pricing.completion")?;
    let input_cache_read = cached
        .data
        .pricing
        .input_cache_read
        .as_deref()
        .map(|value| parse_price(value, "pricing.input_cache_read"))
        .transpose()?;
    Ok(PricingModelResult {
        command: "pricing".to_string(),
        model: requested_model.to_string(),
        source: cached.source,
        cached: from_cache,
        fetched_at: cached.fetched_at,
        cache_ttl_seconds: CACHE_TTL_SECS,
        id: cached.data.id,
        name: cached.data.name,
        prompt_per_token_usd: prompt,
        completion_per_token_usd: completion,
        input_cache_read_per_token_usd: input_cache_read,
        prompt_per_million_usd: prompt * 1_000_000.0,
        completion_per_million_usd: completion * 1_000_000.0,
        input_cache_read_per_million_usd: input_cache_read.map(|value| value * 1_000_000.0),
    })
}

fn fetch_pricing(model: &str) -> Result<LlmPricesResponse, MtuiError> {
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| MtuiError::Internal {
            message: format!("Failed to create pricing HTTP client: {}", e),
        })?
        .get(PRICING_ENDPOINT)
        .query(&[("model", model)])
        .send()
        .map_err(|e| MtuiError::Internal {
            message: format!("Failed to fetch pricing from llmprices.ai: {}", e),
        })?;

    if !response.status().is_success() {
        return Err(MtuiError::NoMatch {
            message: format!(
                "llmprices.ai returned HTTP {} for model {}",
                response.status(),
                model
            ),
            suggestion: "Use a provider-qualified model id such as openai/gpt-4o or anthropic/claude-opus-4.5".to_string(),
        });
    }

    response
        .json::<LlmPricesResponse>()
        .map_err(|e| MtuiError::Internal {
            message: format!("Failed to parse llmprices.ai pricing response: {}", e),
        })
}

fn cache_path(project_root: &Path, model: &str) -> std::path::PathBuf {
    let safe_model = model
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    project_root
        .join(".mtui")
        .join("pricing-cache")
        .join(format!("{}.json", safe_model))
}

fn read_fresh_cache(path: &Path) -> Result<Option<CachedPricing>, MtuiError> {
    let text = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(MtuiError::Internal {
                message: format!("Failed to read pricing cache: {}", err),
            })
        }
    };
    let cached = serde_json::from_str::<CachedPricing>(&text).map_err(|e| MtuiError::Internal {
        message: format!("Failed to parse pricing cache: {}", e),
    })?;
    if unix_now().saturating_sub(cached.fetched_at) <= CACHE_TTL_SECS {
        Ok(Some(cached))
    } else {
        Ok(None)
    }
}

fn write_cache(path: &Path, cached: &CachedPricing) -> Result<(), MtuiError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| MtuiError::Internal {
            message: format!("Failed to create pricing cache directory: {}", e),
        })?;
    }
    let text = serde_json::to_string_pretty(cached).map_err(|e| MtuiError::Internal {
        message: format!("Failed to serialize pricing cache: {}", e),
    })?;
    std::fs::write(path, text).map_err(|e| MtuiError::Internal {
        message: format!("Failed to write pricing cache: {}", e),
    })
}

fn parse_price(value: &str, field: &str) -> Result<f64, MtuiError> {
    value.parse::<f64>().map_err(|_| MtuiError::Internal {
        message: format!("Invalid llmprices.ai {} value: {}", field, value),
    })
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn round_usd(value: f64) -> f64 {
    (value * 1_000_000_000.0).round() / 1_000_000_000.0
}

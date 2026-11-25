// SPDX-FileCopyrightText: 2025-2026 Nicolás Antinori <nico.antinori.7@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only
use std::{net::IpAddr, str::FromStr};

use serde::Deserialize;

#[derive(Deserialize)]
pub struct Config {
    /// Ip to serve the app
    #[serde(default = "Config::default_ip")]
    pub ip: IpAddr,

    /// Port to serve the app
    #[serde(default = "Config::default_port")]
    pub port: u16,

    /// Path where we save the data that changes (articles, images, database)
    #[serde(default = "Config::default_data_path")]
    pub data_path: String,

    /// Path where we save static apps data (migrations, templates, etc)
    #[serde(default = "Config::default_static_data_path")]
    pub static_data_path: String,

    /// Maximum HTML articles quantity to pre-download when adding a new feed
    /// If it is None, we download all, otherwise we download the specified quantity
    #[serde(default = "Config::max_articles_qty_to_download")]
    pub max_articles_qty_to_download: Option<u8>,

    /// How many minutes we should wait before checking the feed for new articles
    #[serde(default = "Config::minutes_to_check_for_updates")]
    pub minutes_to_check_for_updates: u16,

    /// URL path prefix the app is served under, e.g. `/rss` when a reverse proxy
    /// forwards `https://host/rss/...` to this app. Empty (the default) serves at `/`.
    /// Links to downloaded images and favicons are stored with this prefix, so set it
    /// before adding feeds.
    #[serde(default)]
    pub base_path: String,
}

impl Config {
    pub fn load() -> Self {
        match envy::from_env::<Config>() {
            Ok(mut config) => {
                config.base_path = Self::normalize_base_path(&config.base_path);
                config
            }
            Err(error) => panic!("{:#?}", error),
        }
    }

    /// Turns `rss`, `/rss/` or `/rss` into `/rss`, and `/` or an empty string into `""`.
    pub fn normalize_base_path(base_path: &str) -> String {
        let trimmed = base_path.trim().trim_matches('/');
        if trimmed.is_empty() {
            String::new()
        } else {
            format!("/{trimmed}")
        }
    }

    pub fn print_information(&self) {
        tracing::info!("Running on: {}:{}", self.ip, self.port);
        tracing::info!("Data path: {}", self.data_path);
        tracing::info!("Static data path: {}", self.static_data_path);
        tracing::info!("Base path: {:?}", self.base_path);
    }

    fn default_data_path() -> String {
        ".".to_owned()
    }

    fn default_static_data_path() -> String {
        ".".to_owned()
    }

    fn default_port() -> u16 {
        3000
    }

    fn default_ip() -> IpAddr {
        IpAddr::from_str("0.0.0.0").expect("there was an error creating the default ip")
    }

    fn max_articles_qty_to_download() -> Option<u8> {
        Some(0)
    }

    fn minutes_to_check_for_updates() -> u16 {
        120
    }
}

#[cfg(test)]
mod tests {
    use super::Config;

    #[test]
    fn normalize_base_path() {
        assert_eq!(Config::normalize_base_path(""), "");
        assert_eq!(Config::normalize_base_path("/"), "");
        assert_eq!(Config::normalize_base_path("rss"), "/rss");
        assert_eq!(Config::normalize_base_path("/rss"), "/rss");
        assert_eq!(Config::normalize_base_path("/rss/"), "/rss");
        assert_eq!(Config::normalize_base_path(" /apps/rss/ "), "/apps/rss");
    }
}

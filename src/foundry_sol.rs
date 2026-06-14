use std::{env, path::PathBuf};
use zed::LanguageServerId;
use zed_extension_api::{self as zed, Result};

const SERVER_PATH: &str = "node_modules/@nomicfoundation/solidity-language-server/out/index.js";
const PACKAGE_NAME: &str = "@nomicfoundation/solidity-language-server";

struct SolidityExtension {
    did_find_server: bool,
}

impl SolidityExtension {
    fn server_path() -> PathBuf {
        PathBuf::from(env::current_dir().unwrap()).join(SERVER_PATH)
    }

    fn server_exists() -> bool {
        Self::server_path()
            .metadata()
            .map_or(false, |stat| stat.is_file())
    }

    fn server_script_path(
        &mut self,
        language_server_id: &LanguageServerId,
    ) -> Result<String> {
        let server_exists = Self::server_exists();

        if self.did_find_server && server_exists {
            return Ok(SERVER_PATH.to_string());
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let version = zed::npm_package_latest_version(PACKAGE_NAME)?;

        let installed_version = zed::npm_package_installed_version(PACKAGE_NAME)?;

        if !server_exists || installed_version.as_ref() != Some(&version) {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            let result = zed::npm_install_package(PACKAGE_NAME, &version);
            match result {
                Ok(()) => {
                    if !Self::server_exists() {
                        Err(format!(
                            "installed package '{PACKAGE_NAME}' did not contain expected path '{SERVER_PATH}'",
                        ))?;
                    }
                }
                Err(error) => {
                    if !Self::server_exists() {
                        Err(error)?;
                    }
                }
            }
        }

        self.did_find_server = true;
        Ok(SERVER_PATH.to_string())
    }
}

impl zed::Extension for SolidityExtension {
    fn new() -> Self {
        Self {
            did_find_server: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        self.server_script_path(language_server_id)?;

        let node_path = zed::node_binary_path()?;

        let server_full_path = Self::server_path()
            .to_string_lossy()
            .to_string();

        Ok(zed::Command {
            command: node_path,
            args: vec![server_full_path, "--stdio".to_string()],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<Option<zed_extension_api::serde_json::Value>> {
        Ok(Some(zed_extension_api::serde_json::json!({
            "extensionName": "zed-solidity",
            "extensionVersion": env!("CARGO_PKG_VERSION"),
            "env": "production",
            "telemetryEnabled": false,
            "extensionConfig": {}
        })))
    }
}

zed::register_extension!(SolidityExtension);

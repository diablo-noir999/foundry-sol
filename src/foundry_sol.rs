use zed_extension_api::{self as zed, Result};
use std::process::Command;

struct FoundryExtension;

impl FoundryExtension {
    fn check_dependencies() -> Vec<String> {
        let mut missing = Vec::new();

        // Check forge
        if Command::new("forge").arg("--version").output().is_err() {
            missing.push("forge".to_string());
        }

        // Check node
        if Command::new("node").arg("--version").output().is_err() {
            missing.push("node".to_string());
        }

        missing
    }

    fn install_foundry() -> Result<()> {
        // Try to install foundry using foundryup
        let output = Command::new("curl")
            .args(["-L", "https://foundry.paradigm.xyz"])
            .stdout(std::process::Stdio::piped())
            .output();

        match output {
            Ok(output) => {
                let script = String::from_utf8_lossy(&output.stdout);
                let install = Command::new("bash")
                    .arg("-c")
                    .arg(&*script)
                    .output();

                match install {
                    Ok(_) => Ok(()),
                    Err(e) => Err(format!("Failed to run foundryup: {}", e).into()),
                }
            }
            Err(e) => Err(format!("Failed to download foundryup: {}", e).into()),
        }
    }
}

impl zed::Extension for FoundryExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        // Check dependencies on startup
        let missing = Self::check_dependencies();
        if !missing.is_empty() {
            let msg = format!(
                "Foundry Sol: Missing dependencies: {}. Please install them to use the LSP.",
                missing.join(", ")
            );
            eprintln!("{}", msg);

            // Try to auto-install foundry if it's the only missing dependency
            if missing.contains(&"forge".to_string()) && missing.len() == 1 {
                eprintln!("Foundry Sol: Attempting to install Foundry...");
                if let Err(e) = Self::install_foundry() {
                    eprintln!("Foundry Sol: Auto-install failed: {}", e);
                }
            }
        }

        // The server is bundled in the extension's installed directory
        let server_path = std::env::current_dir()
            .map_err(|e| format!("Failed to get current dir: {}", e))?
            .join("foundry-lsp")
            .join("out")
            .join("server.js");

        Ok(zed::Command {
            command: "node".to_string(),
            args: vec![server_path.to_string_lossy().to_string()],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<Option<zed_extension_api::serde_json::Value>> {
        // Check if forge is available and include in init options
        let forge_available = Command::new("forge").arg("--version").output().is_ok();
        let node_available = Command::new("node").arg("--version").output().is_ok();

        Ok(Some(zed_extension_api::serde_json::json!({
            "extensionName": "foundry-sol",
            "extensionVersion": env!("CARGO_PKG_VERSION"),
            "capabilities": {
                "forge": forge_available,
                "node": node_available
            }
        })))
    }
}

zed::register_extension!(FoundryExtension);

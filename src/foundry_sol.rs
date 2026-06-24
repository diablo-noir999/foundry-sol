use zed_extension_api::{self as zed, Result};
use std::path::Path;

struct FoundryExtension;

impl FoundryExtension {
    fn ensure_lsp_built(server_dir: &Path) -> Result<()> {
        let out_dir = server_dir.join("out");
        let server_js = out_dir.join("server.js");

        // Already built
        if server_js.exists() {
            return Ok(());
        }

        // Build LSP
        eprintln!("foundry-sol: Building LSP server...");

        // Run npm install if node_modules doesn't exist
        if !server_dir.join("node_modules").exists() {
            let status = std::process::Command::new("npm")
                .arg("install")
                .arg("--production")
                .current_dir(server_dir)
                .status();
            if status.is_err() || !status.unwrap().success() {
                return Err("Failed to run npm install for LSP".into());
            }
        }

        // Run tsc
        let status = std::process::Command::new("npx")
            .arg("tsc")
            .current_dir(server_dir)
            .status();

        match status {
            Ok(s) if s.success() => {
                eprintln!("foundry-sol: LSP built successfully");
                Ok(())
            }
            _ => Err("Failed to build LSP server (tsc failed)".into()),
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
        let server_dir = std::env::current_dir()
            .map_err(|e| format!("Failed to get current dir: {}", e))?
            .join("foundry-lsp");

        // Ensure LSP is built
        Self::ensure_lsp_built(&server_dir)?;

        // Find node binary
        let node_path = which::which("node")
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "/usr/bin/node".to_string());

        let server_path = server_dir.join("out").join("server.js");

        Ok(zed::Command {
            command: node_path,
            args: vec![server_path.to_string_lossy().to_string()],
            env: Default::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<Option<zed_extension_api::serde_json::Value>> {
        Ok(Some(zed_extension_api::serde_json::json!({
            "extensionName": "foundry-sol",
            "extensionVersion": env!("CARGO_PKG_VERSION"),
        })))
    }
}

zed::register_extension!(FoundryExtension);

use zed_extension_api::{self as zed, node_binary_path, Result};

const SERVER_JS: &str = include_str!("../foundry-lsp/out/server.js");

struct FoundryExtension;

impl zed::Extension for FoundryExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let server_path = "server.js";

        // Write the embedded server.js to the extension working directory (WASI sandbox)
        if std::fs::File::open(server_path).is_err() {
            std::fs::create_dir_all("foundry-lsp/out").ok();
            std::fs::write(server_path, SERVER_JS)
                .map_err(|e| format!("Failed to write LSP server: {e}"))?;
        }

        // Resolve to absolute path so node finds it regardless of process CWD
        let abs_path = std::env::current_dir()
            .map_err(|e| format!("Failed to get cwd: {e}"))?
            .join(server_path);
        let abs_str = abs_path.to_string_lossy().to_string();

        let node_path = node_binary_path()
            .map_err(|e| format!("Node.js not found: {e}"))?;

        Ok(zed::Command {
            command: node_path,
            args: vec![abs_str],
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

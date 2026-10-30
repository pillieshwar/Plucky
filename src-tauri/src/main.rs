// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `TodoCity --mcp`: the MCP server that AI apps launch. It runs
    // without any UI and hands tasks to the running app (see agents.rs).
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        std::process::exit(todocity_lib::run_mcp());
    }
    todocity_lib::run();
}

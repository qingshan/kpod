use std::process::Command;

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

fn main() {
    let branch =
        run("git", &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let commit = run("git", &["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let built_on = run("date", &["+%Y-%m-%d %H:%M:%S"]).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=GIT_BRANCH={branch}");
    println!("cargo:rustc-env=GIT_COMMIT={commit}");
    println!("cargo:rustc-env=BUILD_TIME={built_on}");
    // No `rerun-if-changed` directive: build scripts re-run on every build by
    // default, which is what we want here so BUILD_TIME/GIT info are fresh
    // even when only crate sources changed.
}

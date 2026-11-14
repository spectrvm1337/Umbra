fn main() {
    // The app's version lives in package.json alone (tauri.conf.json points there too); Rust gets it
    // as UMBRA_VERSION, so a release changes one line.
    println!("cargo:rerun-if-changed=../package.json");
    let package: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string("../package.json").expect("read ../package.json"))
            .expect("parse ../package.json");
    let version = package["version"].as_str().expect("package.json has a version");
    println!("cargo:rustc-env=UMBRA_VERSION={version}");
    tauri_build::build()
}

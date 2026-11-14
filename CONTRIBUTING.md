# Contributing to Umbra

Umbra is built with Node.js and Rust. The frontend is plain HTML/CSS/JS: there is no bundler, so `src\` is served as-is. The backend is in `src-tauri\`.

## Prerequisites

- Node.js
- Rust toolchain
- [Tauri prerequisites for Windows](https://tauri.app/start/prerequisites/)

## Build

```bash
git clone https://github.com/spectrvm1337/Umbra.git
cd Umbra
npm install

# Run in development mode
npm run dev

# Build for production (installer and umbra.exe)
npm run build
```

## Tests

```bash
npm test                                          # frontend
cargo test --manifest-path src-tauri/Cargo.toml   # backend
```

## Where things live

- **Version**: `package.json` only. `npm version 0.3.0` changes it there and in `package-lock.json`; `tauri.conf.json` points at `package.json`, and Rust gets it from `build.rs` (`Cargo.toml` stays at 0.0.0).
- **Values Rust and the page both use** (default hotkey, languages, blur maximum, dock width, repository, version): `src-tauri/src/shared.rs`. The page reads them as `window.UMBRA`. A new language also needs its strings in `src/i18n.js` and the tray labels in `src-tauri/src/tray.rs`.
- **Window size**: `tauri.conf.json`. Rust and the page start from it.
- **Scripts**: no `?v=` after the file names. WebView2 does not cache what Tauri serves, so an update always loads the new files.

## Themes

Custom themes and CSS are described in [THEMES.md](THEMES.md).

## Bugs and ideas

[Open an issue](https://github.com/spectrvm1337/Umbra/issues). For a rendering bug, include what Windows version you use and whether a game or another overlay was running.

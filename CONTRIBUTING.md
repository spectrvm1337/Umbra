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

## Themes

Custom themes and CSS are described in [THEMES.md](THEMES.md).

## Bugs and ideas

[Open an issue](https://github.com/spectrvm1337/Umbra/issues). For a rendering bug, include what Windows version you use and whether a game or another overlay was running.

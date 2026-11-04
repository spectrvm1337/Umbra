<div align="center">

<img width="1200" height="630" alt="main-banner" src="https://github.com/user-attachments/assets/f8a0ae03-8a41-4d4b-894d-0199e5d1ce64" />

</div>

A minimalist, highly customizable search launcher for Windows, built with Rust and Tauri.

[![Download Umbra](https://img.shields.io/badge/Download-Umbra_Beta-black?style=for-the-badge&logo=windows)](https://github.com/spectrvm1337/Umbra/releases/latest)

## Features

<div align="center">

<img width="1200" height="400" alt="instantsearch-banner" src="https://github.com/user-attachments/assets/bc9ede95-281b-4ad8-9191-cbce91ac8d31" />

</div>

**Instant Search**

Find applications, files, and folders across your system as you type. Results are ranked by how well the name matches and by what you open most. Type `D:\ report` to search one drive only. The selected result can open up into a card with a preview of the file (hold `Shift+Space`).

**Built-in Tools**

A calculator and currency converter right in the search box, power controls through text (`shutdown`, `restart`, `sleep`), process killing (`kill <name>`), a screen color picker, and web search (`!g`, `!yt`, `!gh` and more — type `!help`).

**Workflow Integration**

Pin frequently used items as a list under the search box or as a dock beside it. With **Fold favorites** on, the list stays folded until `↓` or the arrow under the search box opens it, and the search box waits in the middle of the screen. Drag and drop files straight from the results to other applications.

<div align="center">

<img width="1200" height="400" alt="themes-banner" src="https://github.com/user-attachments/assets/bee0429c-62c8-448a-83ba-b12eb6d5b2e8" />

</div>

**Deep Customization**

Themes and presets, accent and background colors, opacity, round or squircle corners, borders, glow, density, fonts, zoom and animations, plus custom CSS themes (see [THEMES.md](THEMES.md)). **Blur** shows what is behind the window blurred through the cards, with an adjustable strength. Every key Umbra answers to can be rebound in the Keybinds panel. English, Russian, German and Japanese.

**High Performance**

Powered by a native Rust backend. Build output and object stores (folders tagged with `CACHEDIR.TAG`, files named by their hash) are left out of the index, and while the window is hidden its web view is suspended and keeps as little memory as it can.

### Keys

| Key | Action |
| --- | --- |
| `Alt+Space` | Show Umbra (the global hotkey can be changed) |
| `↑` / `↓`, `Enter` | Pick a result, open it |
| `Tab` | Complete the suggestion |
| `Ctrl+1` … `Ctrl+9` | Open the result with that number |
| `Shift+Space` (hold) | Open the selected result up into a preview card |
| `↓` in the empty box | Unfold the favorites (with Fold favorites on) |
| `→` in the empty box | Open the settings |
| Right-click | Actions for a result: run as admin, open folder, copy path, pin |

## Installation

1. Open the [Releases](https://github.com/spectrvm1337/Umbra/releases) page.
2. Download the installer (`Umbra_<version>_x64-setup.exe`) or the portable build (`Umbra_<version>_x64-portable.exe`).
3. Run it and press `Alt+Space` to summon the search window.

Updates are checked from inside the app: **Settings → Check for updates**. When a newer release exists, it downloads in the background and the button turns into **Install & restart**. An installed copy updates with the installer; a portable copy updates to the portable build, which takes the old file's place, so shortcuts and autostart keep working.

## Where Umbra stores things

Everything lives in a single folder: `%APPDATA%\.Umbra-config`

| File | Purpose |
| --- | --- |
| `config.json` | Settings, theme, hotkey, keybinds, indexing filters |
| `pins.json` | Pinned launcher entries and their order |
| `frecency_stats.json` | Per-item usage scores used for ranking |
| `query_picks.json` | Which result you opened for a query, so it ranks first next time |
| `index.bin` | The file index from the last session, searched while the new one is built |
| `panic.log` | Errors, kept small, for bug reports |
| `themes\*.css` | Your custom themes (see [THEMES.md](THEMES.md)) |

Installations from before 0.1.3 used `%APPDATA%\SpotlightSearch`; those files are copied over automatically on first launch and the old folder is left untouched.

## Development

Umbra is built with Node.js and Rust. The frontend is plain HTML/CSS/JS — there is no bundler, so `src\` is served as-is.

### Prerequisites

- Node.js
- Rust toolchain
- [Tauri prerequisites for Windows](https://tauri.app/start/prerequisites/)

### Build Instructions

```bash
git clone https://github.com/spectrvm1337/Umbra.git
cd Umbra
npm install

# Run in development mode
npm run dev

# Build for production (installer and umbra.exe)
npm run build

# Faster build, unoptimised binary
npm run build:fast
```

Run the Rust unit tests with:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

## License

Available under the [MIT License](LICENSE).

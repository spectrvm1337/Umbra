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

Find applications, files, and folders across your system as you type, ranked by how well the name matches and by what you open most.

**Built-in Tools**

Calculator, currency converter, power commands (`shutdown`, `restart`, `sleep`), process killing (`kill <name>`), a screen color picker, and web search (`!g`, `!yt`, `!gh` and more — type `!help`).

**Workflow Integration**

Pin items as a list or a dock, optionally folded. Drag and drop files from the results into other applications.

<div align="center">

<img width="1200" height="400" alt="themes-banner" src="https://github.com/user-attachments/assets/bee0429c-62c8-448a-83ba-b12eb6d5b2e8" />

</div>

**Deep Customization**

Themes, colors, blur, fonts, animations, custom CSS ([THEMES.md](THEMES.md)). Rebindable keys. English, Russian, German, Japanese.

**High Performance**

Native Rust backend, low memory while hidden.

### Keys

| Key | Action |
| --- | --- |
| `Alt+Space` | Show Umbra (changeable) |
| `Tab` | Complete the suggestion |
| `Ctrl+1` … `Ctrl+9` | Open the result with that number |
| `Shift+Space` (hold) | Preview the selected result |
| `D:\ query` | Search one drive only |

## Installation

1. Open the [Releases](https://github.com/spectrvm1337/Umbra/releases) page.
2. Download the installer (`Umbra_<version>_x64-setup.exe`) or the portable build (`Umbra_<version>_x64-portable.exe`).
3. Run it and press `Alt+Space` to summon the search window.

Updates: **Settings → Check for updates**.

Config lives in `%APPDATA%\.Umbra-config`; custom themes go in its `themes\` folder.

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
```

Run the Rust unit tests with:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

## License

Available under the [MIT License](LICENSE).

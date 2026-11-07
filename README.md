<div align="center">

<img width="1280" alt="Umbra Open Beta Test" src="assets/umbra-obt-banner.png" />

</div>

A minimalist, highly customizable search launcher for Windows, built with Rust and Tauri.

[![Download Umbra](https://img.shields.io/badge/Download-Umbra_Beta-black?style=for-the-badge&logo=windows)](https://github.com/spectrvm1337/Umbra/releases/latest)

## Search and see

<div align="center">

<img width="1280" alt="Search and see" src="assets/search-and-see-banner.png" />

</div>

Find applications, files and folders across your system as you type, ranked by how well the name matches and by what you open most. A program is found by its file name too (`chrome` finds Google Chrome before `chrome_proxy.exe`), and a favourite that matches comes first.

Hold `Shift+Space` to preview the selected result. `Ctrl+1` … `Ctrl+9` opens the result with that number, `Tab` completes the suggestion, and `D:\ query` searches one drive only. Drag a result into another application to hand it the file.

## Everyday widgets

<div align="center">

<img width="1280" alt="Everyday widgets" src="assets/everyday-widgets-banner.png" />

</div>

Type, and the answer is already there:

- **Calculator**: `(2+3)*4`, `200+10%`
- **Currency converter**: `100 usd to eur`, with a rate chart and one-click alternatives
- **Color picker**: `#507090`, or pick any color on the screen; values in RGB and HSL, with history
- **Power commands**: `shutdown`, `restart`, `sleep`
- **Process killing**: `kill spot` finds Spotify, and nothing dies until you click
- **Web search**: `!g`, `!yt`, `!gh`, `!wiki` and more; type `!help` for the list

Pin items as a list or a dock, optionally folded away until you need them.

## Preferences over options

<div align="center">

<img width="1280" alt="Preferences over options" src="assets/preferences-over-options-banner.png" />

</div>

Few settings, each one meant. Language (English, Russian, German, Japanese), the global hotkey, start with Windows, where the window appears on the screen. Every key is rebindable, and every kind of motion (fade, move, size, color) can be switched off on its own.

| Key | Action |
| --- | --- |
| `Alt+Space` | Show Umbra (changeable) |
| `Tab` | Complete the suggestion |
| `Ctrl+1` … `Ctrl+9` | Open the result with that number |
| `Shift+Space` (hold) | Preview the selected result |
| `D:\ query` | Search one drive only |

The hotkey works over borderless and windowed full-screen games. Exclusive full-screen cannot show anything on top of it, in Umbra or any other launcher.

## Express it the way you want

<div align="center">

<img width="1280" alt="Express it the way you want" src="assets/express-banner.png" />

</div>

Themes, colors, blur, fonts and animations, down to custom CSS ([THEMES.md](THEMES.md)). The cards are blurred over whatever is behind the window, with rounded corners,, and the drag bar and the favorites arrow take their color from the wallpaper. A theme is a file in `%APPDATA%\.Umbra-config\themes`.

Native Rust backend; while the window is hidden Umbra uses next to no CPU.

## Installation

1. Open the [Releases](https://github.com/spectrvm1337/Umbra/releases) page.
2. Download the installer (`Umbra_<version>_x64-setup.exe`) or the portable build (`Umbra_<version>_x64-portable.exe`).
3. Run it and press `Alt+Space` to summon the search window.

Updates: **Settings → Check for updates**.

Config lives in `%APPDATA%\.Umbra-config`.

## Development

Umbra is built with Node.js and Rust. The frontend is plain HTML/CSS/JS: there is no bundler, so `src\` is served as-is.

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

### Tests

```bash
npm test                                          # frontend
cargo test --manifest-path src-tauri/Cargo.toml   # backend
```

## License

Available under the [MIT License](LICENSE).

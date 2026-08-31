# dsh-photo-pet — Photo Pet Plugin

[中文](README.md) | English

> Turn any photo into a floating pet inside the DeepSeek Harness (DSH) Web GUI.

Upload your photo and it becomes a pet that lives in the corner of your browser: draggable, one-click AI cutout for a clean background, nameable, with a hover fan menu, and it bubbles custom lines while the model is working. The photo IS the pet — no frames, no templates, shown as-is.

The plugin follows the official DSH plugin shape (cordis bundle: host half + client half in one package), mounts through the profile mechanism, and never patches DSH itself.

![Pet](docs/screenshot.png)

## Features

| Feature | Description |
|---|---|
| Photo as pet | The uploaded photo is the pet itself; width adjustable, height follows the photo's aspect ratio |
| AI auto cutout | After upload, the subject is detected and cut out automatically (denoise, decontaminate edges, auto-crop); the open-source model runs in the browser, images never leave your machine |
| Smart trim | Automatically removes solid-color borders around the photo on upload |
| Manual cutout editor | Built-in editor with eraser/brush plus a re-run AI cutout button |
| Drag to move | Drag the pet anywhere; the position is saved automatically |
| Naming | The pet has its own name shown in a hover nameplate; editable in settings |
| Working lines | Custom bubble lines (one per line) while the model works; swap interval configurable |
| Hover fan menu | Circular menu on hover; every item can be toggled, with show-all / hide-all shortcuts |
| State animations | Idle sway, click bounce, working sway with a cigarette smoke effect |
| Hide / summon | One-click hide; hovering the spot brings up a summon button |
| Settings panel | "My Pet" left-nav section: enable, visibility, name, size, position, trim/AI toggles, lines & menu config; renaming updates the menu live |

## How it works

- **Host half** (`lib/index.js`): registers the `photo-pet` settings namespace, serves `/api/photo-pet/*` routes (photo storage, activity polling) and the AI cutout proxy (`/api/photo-pet/ai/*`, model downloaded on demand and cached under `~/.dsh/photo-pet/ai/<version>/`).
- **Client half** (`lib/client.js`): renders the pet, animations, bubbles, fan menu and the cutout editor in the browser; registers "My Pet" as a first-level settings section through the `settings.section` slot.
- **Packaging**: profile dependency + `dsh.profile.bundles` registration; the plugin's `cordis.patch.yml` (`dsh.bundle.patch`) inserts its row into the web plugin roster.

## Installation

### Requirements

- DeepSeek Harness (DSH) Web GUI `>= 0.1.1-rc.1`
- Node.js 18+ (DSH bundles its own runtime)

### Install via npm (after publishing, simplest)

```bash
dsh plugin --profile web add dsh-photo-pet
```

DSH installs the plugin into the `web` profile and registers the bundle automatically; restart the web service and refresh the page.

### Install from GitHub

```bash
# 1. Clone the plugin
git clone https://github.com/tangkui/dsh-photo-pet.git
cd dsh-photo-pet
npm install
```

```bash
# 2. Link the plugin into the DSH profile
#    Edit ~/.dsh/profiles/web/package.json:
```

```jsonc
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    // ...existing dependencies
    "dsh-photo-pet": "link:/absolute/path/to/dsh-photo-pet"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...existing bundles
        "dsh-photo-pet"
      ]
    }
  }
}
```

```bash
# 3. Restart DSH Web (kill the process on port 3080; DSH restarts itself)
kill $(lsof -ti :3080)

# 4. Verify: refresh the page in your browser
#    - A pet appears in the bottom-right corner (built-in default look first)
#    - No console errors; the bundle is served at:
curl -s http://127.0.0.1:3080/plugins/dsh-photo-pet/client.js
```

### Configuration

Open **Settings → My Pet** in the left navigation:

- **Enable pet / Show pet** — master switch and hide (hover to summon when hidden)
- **Pet name** — shown on the nameplate; the left-nav menu follows it live
- **Size / Right offset / Bottom offset** — size and position
- **Smart trim / AI auto cutout** — automatic processing toggles on upload
- **Working lines / Swap interval** — bubble text and rotation pace while working
- **Hover menu items** — per-item toggles with show-all / hide-all shortcuts
- **Quick actions** — upload photo / AI cutout / reset photo, same actions as the fan menu

### Data & cache

- Pet photo & settings: `~/.dsh/photo-pet/`
- AI cutout model cache: `~/.dsh/photo-pet/ai/<version>/` (downloaded on first use, ~44 MB, offline afterwards)

## Development

```bash
# Smoke tests (headless jsdom: mount / menu / upload / AI path / work lines / settings card)
# Note: the test environment needs Node.js >= 22.19 (jsdom 30 pulls in undici 8)
cd test
npm install
npm test
```

GitHub Actions runs the same smoke suite on every push / PR (`.github/workflows/ci.yml`). **`main` is protected: all changes must come from other branches via Pull Request with at least 1 review and a green CI.**

Layout:

```
dsh-photo-pet/
├── lib/index.js        # Host half: routes / settings namespace / AI proxy
├── lib/client.js       # Client half: pet, animations, menu, editor
├── cordis.patch.yml    # Bundle patch: inserts the plugin row into the web roster
├── test/               # jsdom smoke tests
├── package.json
└── README.md
```

## License

[MIT](LICENSE)

A DeepSeek Harness ecosystem plugin, same license as [deepseek-ai/dsh](https://github.com/deepseek-ai/dsh).

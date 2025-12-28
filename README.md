<div align="center">

### 🌐 README Language : [English](README.md) | [한국어](README.ko.md)
<br>

# 🎥 Video Speed Controller

[![Chrome Web Store](https://img.shields.io/badge/Chrome-Web_Store-4285F4?logo=google-chrome&logoColor=white)](https://chromewebstore.google.com/detail/begolcfbgiopgodhfijbppokmnddchei)
[![Users](https://img.shields.io/chrome-web-store/users/begolcfbgiopgodhfijbppokmnddchei?color=blue)](https://chromewebstore.google.com/detail/begolcfbgiopgodhfijbppokmnddchei)
[![Version](https://img.shields.io/badge/Version-1.1.0-blue)](https://github.com/ataraxia7899/Video-Speed-Up-Chrome-Extension)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)
[![Language](https://img.shields.io/badge/Language-JavaScript-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)

**A powerful Chrome/Edge extension to control video playback speed with ease**

[**Download from Chrome Web Store**](https://chromewebstore.google.com/detail/%EB%B9%84%EB%94%94%EC%98%A4-%EC%86%8D%EB%8F%84-%EC%BB%A8%ED%8A%B8%EB%A1%A4%EB%9F%AC/begolcfbgiopgodhfijbppokmnddchei?authuser=6&hl=ko)

---
</div>

### 🛠 Tech Stack

| Item | Description |
| :--- | :--- |
| **Platform** | Chrome/Edge Extensions |
| **Manifest** | Manifest V3 |
| **Language** | JavaScript (ES6+) |
| **API** | Chrome Storage API, Commands API |
| **Core Tech** | MutationObserver, WeakSet, async/await |

---

### ✨ Features

* 🎚️ **Speed Control**: Support 0.1x ~ 16x playback speed range
* ⚡ **Preset Buttons**: Quick select 0.5x, 1.0x, 1.5x, 2.0x
* ➕➖ **Relative Speed Adjustment**: +/- 0.25, +/- 1 buttons
* ⌨️ **Keyboard Shortcuts**: `Ctrl + .` for quick speed input popup
* 🌙 **Dark Mode**: System theme integration and manual toggle
* 🌐 **Site-specific Auto Settings**: URL pattern-based auto speed application
* 🔒 **User Priority**: Manual settings override automatic settings

---

### ⌨️ Keyboard Shortcuts

| Shortcut | Function |
| :--- | :--- |
| `Ctrl + .` | Open/Close speed input popup |

---

### 📝 Usage

1. Install the extension and click the icon in the browser toolbar
2. Click the desired speed button or enter a custom value in the popup
3. Use `Ctrl + .` shortcut to quickly adjust speed
4. **Site-specific Auto Settings**: Register URL patterns for automatic speed application
   - URL pattern examples: `*.youtube.com`, `lecture.site.com/*`
   - Toggle each setting on/off
   - **Manual speed changes override automatic settings** (until page refresh)

---

### 📋 Recent Updates

#### v1.1.1 (2024-12-28)

**Code Optimization**
- 🔧 **Module Separation**: Split `content.js` (1,400+ lines) into 5 functional modules
  - `content-main.js`: State management, connection, message handler
  - `content-observer.js`: Video detection, initialization, URL monitoring
  - `content-youtube.js`: YouTube/Shorts specific logic
  - `content-popup.js`: In-page speed popup
  - `content-init.js`: Module initialization
- ⚡ **Memory Optimization**: Prevent memory leaks using WeakSet
- 🐛 **Bug Fix**: Fixed site-specific auto settings not applying

**Feature Improvements**
- 🖥️ **Fullscreen Popup**: Speed popup now displays correctly in fullscreen mode
- 🎨 **UI Improvement**: Removed spinner arrows from speed input field

#### v1.1.0 (2024-12-27)

**Bug Fixes**
- ✅ Fixed `Ctrl + .` shortcut popup appearing twice or closing immediately
- ✅ Fixed incorrect highlight of `+1` button at 1.0x speed
- ✅ Fixed speed reset issue on episode changes in SPA sites (e.g., Laftel)

**Feature Improvements**
- 🔒 **User Priority**: Manual speed changes won't be overridden by site-specific auto settings
- 🎨 **UI Improvement**: Dark mode toggle repositioning, border cleanup, background color adjustment
- ⚡ **Performance Optimization**: Regex caching, unified setInterval period, duplicate execution prevention

---

### 📂 File Structure

```
Video-Speed-Up-Chrome-Extension/
├── manifest.json          # Extension configuration
├── popup.html             # Popup UI
├── popup.css              # Popup styles
├── popup.js               # Popup controller
├── background.js          # Background worker
├── utils.js               # Common utilities
└── content/               # Content script modules
    ├── content-main.js    # State management, connection
    ├── content-observer.js # Video detection, URL monitoring
    ├── content-youtube.js # YouTube-specific logic
    ├── content-popup.js   # In-page popup
    └── content-init.js    # Initialization
```

---

### � Installation

#### **Chrome Web Store (Recommended)**
[Install from Chrome Web Store](https://chromewebstore.google.com/detail/%EB%B9%84%EB%94%94%EC%98%A4-%EC%86%8D%EB%8F%84-%EC%BB%A8%ED%8A%B8%EB%A1%A4%EB%9F%AC/begolcfbgiopgodhfijbppokmnddchei?authuser=6&hl=ko)

#### **Manual Installation (Development)**
1. Clone the repository
2. Navigate to `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the cloned folder

---

### 🤝 Contributing

1. Fork the repository
2. Create a new branch
3. Commit your changes
4. Create a Pull Request

---

### 📄 License

MIT License

---

### 🔧 Troubleshooting

If you encounter any issues, please create a new issue in the [Issues](https://github.com/ataraxia7899/Video-Speed-Up-Chrome-Extension/issues) tab.




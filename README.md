> **Latest Release (Android APK & Windows .exe):** [CutSync v0.2.0](https://github.com/Kpetrukhin/Webcut/releases/tag/v0.2.0)
> **Offline AI Models Pack (Whisper, VitTrack, MobileSAM):** [AI Models Pack v1](https://github.com/Kpetrukhin/Webcut/releases/tag/ai-models-v1)


https://github.com/user-attachments/assets/38d62424-1dbf-488e-9078-64442cbb5f7f

<div align="center">

# 🎬 CutSync

**Real-Time Collaborative Video Editor in the Style of CapCut**

Edit videos together simultaneously from desktop and mobile devices. Built with a Mobile-First UI, PWA support, and automated Android APK builds.

[![Node.js](https://shields.io)](https://nodejs.org)
[![React](https://shields.io)](https://react.dev)
[![TypeScript](https://shields.io)](https://typescriptlang.org)
[![Docker](https://shields.io)](#docker-deployment)
[![Android APK](https://shields.io)](#android-apk-github-actions)

[🇷🇺 Русская версия (Russian README)](./README.rus.md)

</div>

---

## ✨ Key Features

* **Real-Time Multiplayer (WebSocket):** Instant rooms via `/?room=CODE`, live cursors and playhead presence, active clip collision prevention, team chat, and project persistence.
* **CapCut-Inspired Mobile-First & Desktop UI:** Adaptive layout (`100dvh`), 4 dedicated tracks (Video, PIP, Text, Audio), precision editing (trimming, splitting, speed ramping `0.5x–2x`, undo/redo), color filters, transitions, and local media upload/export.
* **Installable PWA, Windows Desktop & Native Android App:** One-tap PWA installation, standalone Windows `.exe` via Electron, and LAN auto-discovery for instant phone-to-PC pairing over Wi-Fi.

## 🚀 Quick Start & Deployment

* **Prerequisites:** Node.js 22+ and npm 10+.
* **Local Run:** Clone the repository, run `npm install`, start the development server with `npm run dev`, and build via `npm run build && npm start`.
* **Docker:** Build and run the container mapping ports and persistent volumes (`uploads` and `data`).
* **Android APK:** Automatically built via GitHub Actions (`.github/workflows/ci.yml`) on pushes to `main`/`master` (artifact **`CutSync-APK`**) or compiled locally using Capacitor and Gradle.
* **Windows Desktop (`.exe`):**
  * **GitHub Actions:** Built automatically on pushes to `main`/`master` or via **Actions -> Build Windows Desktop (.exe) -> Run workflow**. Download **`CutSync-Windows-EXE`** from the workflow **Artifacts** (contains `CutSync-Portable.exe`, no installation required). Tag pushes (`v*`) also attach the `.exe` to **GitHub Releases**.
  * **Local Build (on Windows):** Run `npm install && npm run build:exe` — output is saved to `release/CutSync-Portable.exe`. User projects and uploaded media are stored in `%APPDATA%\CutSync\`.

## 🛠️ Tech Stack & Project Structure

* **Frontend:** React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Vite, PWA, Capacitor.
* **Backend:** Node.js 22, Express 4, WebSockets (`ws`), Multer.
* **Desktop Wrapper:** Electron + `electron-builder` (portable x64 `.exe` with embedded server bundled via `esbuild`).
* **Media & Rendering:** HTML5 Canvas 2D, MediaRecorder API, Web Audio API.
* **Structure:** Main server logic in `server.ts`, Electron entry in `electron/main.cjs`, frontend components and hooks in `src/`, and build/deployment scripts in `scripts/`, `.github/workflows/`, and `Dockerfile`.

*Полный исходный текст README со всеми подробными командами и блоками доступен в структуре проекта.*

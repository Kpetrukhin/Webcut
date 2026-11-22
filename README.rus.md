# CutSync — Совместный видеоредактор в стиле CapCut

Мобильный и десктопный видеоредактор с многопользовательским монтажом в реальном времени через WebSocket. Работает прямо в браузере на телефоне (iOS / Android) и ПК, устанавливается как PWA-приложение на экран телефона и позволяет нескольким людям одновременно редактировать один проект.

## Основные возможности

- **Совместный монтаж в реальном времени (WebSocket)**:
  - Комнаты по ссылке (`/?room=КОД`), вход с любого устройства (телефон + ПК).
  - Живые курсоры и линии воспроизведения других участников на таймлайне.
  - Подсветка клипов, которые сейчас редактируют другие участники.
  - Встроенный чат команды внутри комнаты и автосохранение проектов в `data/rooms.json`.
- **Интерфейс в стиле CapCut (Mobile-First + Desktop Studio)**:
  - Адаптация под телефон (сенсорное управление таймлайном, нижние шторки инструментов, `100dvh`) и полноэкранная студия на ПК.
  - 4 дорожки: **Видео**, **Слой (PIP)**, **Текст**, **Аудио**.
  - Обрезка краёв клипов перетаскиванием ручек, сдвиг по таймлайну, разделение по линии времени (`Разделить`), изменение скорости (`0.5x – 2x`), дублирование, Undo / Redo.
  - Загрузка реальных видео, фото и аудио с телефона или компьютера (`/api/upload`).
  - Фильтры (`Кино`, `Тёплый`, `Холод`, `Яркий`, `Винтаж`, `Ч/Б`), переходы (`Плавный`, `Зум`, `Слайд`), анимация камеры (`Ken Burns` / панорама), цветокоррекция.
  - Текстовые титры с перетаскиванием прямо по экрану предпросмотра.
  - Встроенные синтезированные саундтреки (Web Audio API) + экспорт готового видео через Canvas `MediaRecorder`.
- **PWA (Установка на телефон)**:
  - Кнопка установки приложения в интерфейсе для Android / Chrome и инструкция для iOS Safari (`На экран «Домой»`).

## Быстрый старт и проверка сборки

Требования: **Node.js 22+** (для нативного запуска `node server.ts` в production) и **npm 10+**.

```bash
# 1. Установка зависимостей
npm install

# 2. Запуск в режиме разработки (Express + WebSocket + Vite на порту 3000)
npm run dev

# 3. Проверка TypeScript
npm run lint

# 4. Сборка production-бандла
npm run build

# 5. Запуск собранного приложения
npm start
```

## Сборка и скачивание Android APK (через GitHub Actions)

При каждом пуше в `main` / `master` GitHub Actions автоматически собирает готовый **`.apk`** файл через Capacitor:

1. Откройте вкладку **Actions** в репозитории GitHub.
2. Зайдите в последний успешный запуск **Build Web & Android APK**.
3. В самом низу в разделе **Artifacts** скачайте **`CutSync-APK`** (внутри архива файл `CutSync-debug.apk`) и установите на Android.
4. Для совместного редактирования с друзьями откройте вкладку **Команда** в приложении и укажите адрес вашего запущенного сервера (`https://...` или `http://192.168.x.x:3000`).

Для локальной сборки APK (если установлен Android SDK и JDK 21):

```bash
npm run build
node scripts/prepare-android.mjs
cd android && ./gradlew assembleDebug
```

После запуска откройте `http://localhost:3000` на ПК. Чтобы подключиться с телефона в той же Wi-Fi сети, откройте вкладку **Команда** — там автоматически отобразится локальный LAN-адрес вида `http://192.168.x.x:3000/?room=studio-demo`.

## Сборка и скачивание Windows Desktop (.exe)

Автономное портативное приложение для Windows (Electron + встроенный сервер CutSync, не требует установки и Node.js на компьютере пользователя):

1. Откройте вкладку **Actions** в репозитории GitHub.
2. Выберите последний успешный запуск **Build Windows Desktop (.exe)** (запускается автоматически при `push` в `main`/`master` или вручную кнопкой **Run workflow**).
3. В разделе **Artifacts** скачайте архив **`CutSync-Windows-EXE`** (внутри находится **`CutSync-Portable.exe`**). При создании git-тега вида `v1.0.0` готовый `.exe` также прикрепляется к **GitHub Releases**.
4. Проекты (`data/rooms.json`) и загруженные медиафайлы (`uploads`) автоматически сохраняются в пользовательской папке Windows (`%APPDATA%\CutSync\`), а экспортированные видео сохраняются через стандартный диалог Windows.

Для локальной сборки `.exe` (на Windows):

```bash
npm install
npm run build:exe
# Готовый файл появится в release/CutSync-Portable.exe
```

## Стек

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Vite, `vite-plugin-pwa`
- **Backend**: Node.js, Express 4, `ws` (WebSocket), Multer (загрузка медиа)
- **Desktop / Mobile**: Electron + `electron-builder` (`.exe`), Capacitor (`.apk`)
- **Рендер и звук**: HTML5 Canvas 2D, `MediaRecorder` API, Web Audio API

## Структура проекта

- `server.ts` — Express-сервер, WebSocket-комнаты, загрузка файлов в `/uploads`, хранение комнат в `/data/rooms.json`
- `electron/main.cjs` — точка входа Electron: запуск локального сервера, права на камеру/микрофон, скачивание экспорта
- `src/shared/types.ts` — общие типы данных, протокол WebSocket и стартовые пресеты
- `src/lib/renderEngine.ts` — композитинг кадров на Canvas и экспорт видео
- `src/lib/audioEngine.ts` — синхронизация аудио и процедурный Web Audio синтезатор
- `src/hooks/useCollaborativeRoom.ts` — WebSocket-клиент, undo/redo и presence-синхронизация
- `src/components/` — `Timeline.tsx`, `PreviewCanvas.tsx`, `ToolSheets.tsx`, `PWAInstallButton.tsx`

## Деплой через Docker

```bash
docker build -t cutsync .
docker run -p 3000:3000 -v $(pwd)/uploads:/app/uploads -v $(pwd)/data:/app/data cutsync
```

import React, {useEffect, useState} from 'react';
import {
  Copy,
  Crown,
  Film,
  FolderOpen,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import type {
  AspectRatio,
  DiscoveredUdpRoom,
  NetworkInterfaceInfo,
  RoomSummary,
} from '../shared/types.ts';
import type {LocalProjectRecord} from '../lib/localProjects.ts';
import {
  isNativeCapacitorApp,
  scanLocalLanServers,
} from '../lib/serverConfig.ts';
import type {DiscoveredServer} from '../lib/serverConfig.ts';

export const BACKGROUND_PRESETS = [
  '#09090b',
  '#18181b',
  '#0f172a',
  '#1e1b4b',
  '#064e3b',
  '#450a0a',
  '#ffffff',
  '#f4f4f5',
];

const PROFILE_COLOR_PRESETS = [
  '#22d3ee',
  '#f97316',
  '#a78bfa',
  '#34d399',
  '#fb7185',
  '#facc15',
];

const ASPECT_OPTIONS: Array<{id: AspectRatio; label: string; hint: string}> = [
  {id: '9:16', label: '9:16', hint: 'Reels / Shorts'},
  {id: '16:9', label: '16:9', hint: 'YouTube'},
  {id: '1:1', label: '1:1', hint: 'Квадрат'},
  {id: '4:5', label: '4:5', hint: 'Лента'},
  {id: '3:4', label: '3:4', hint: 'Портрет'},
  {id: '21:9', label: '21:9', hint: 'Кино'},
];

interface HomeScreenProps {
  user: {id: string; name: string; color: string};
  serverUrl: string;
  p2pMode: 'idle' | 'host' | 'client';
  networkInterfaces: NetworkInterfaceInfo[];
  hostPort: number;
  udpRooms: DiscoveredUdpRoom[];
  status: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  availableRooms: RoomSummary[];
  localProjects: LocalProjectRecord[];
  onCreateProject: (opts: {
    title: string;
    aspectRatio: AspectRatio;
    backgroundColor: string;
    blank: boolean;
    isTeamHost: boolean;
  }) => Promise<void>;
  onJoinTeamRoom: (roomId: string) => void;
  onOpenLocalProject: (record: LocalProjectRecord) => void;
  onDeleteLocalProject: (roomId: string) => void;
  onUpdateProfile: (name: string, color: string) => void;
  onConnectServer: (url: string) => void;
  onStartHost: () => Promise<unknown>;
  onStopHost: () => Promise<void>;
  onConnectToHostIp: (ipOrUrl: string, targetRoomId?: string) => void;
  onRefreshNetwork: () => void;
  onRefreshRooms: () => void;
  onOpenSettings?: () => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  user,
  serverUrl,
  p2pMode,
  networkInterfaces,
  hostPort,
  udpRooms,
  status,
  availableRooms,
  localProjects,
  onCreateProject,
  onJoinTeamRoom,
  onOpenLocalProject,
  onDeleteLocalProject,
  onUpdateProfile,
  onConnectServer,
  onStartHost,
  onStopHost,
  onConnectToHostIp,
  onRefreshNetwork,
  onRefreshRooms,
  onOpenSettings,
}) => {
  const [activeTab, setActiveTab] = useState<'projects' | 'team'>('projects');
  const [showCreateModal, setShowCreateModal] = useState(false);

  const [title, setTitle] = useState('');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16');
  const [backgroundColor, setBackgroundColor] = useState('#09090b');
  const [blank, setBlank] = useState(true);
  const [isTeamHost, setIsTeamHost] = useState(false);
  const [creating, setCreating] = useState(false);

  const [nameInput, setNameInput] = useState(user.name);
  const [serverInput, setServerInput] = useState(
    serverUrl ? serverUrl.replace(/^https?:\/\//, '') : ''
  );
  const [scanningLan, setScanningLan] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>(
    []
  );
  const [subnetHint, setSubnetHint] = useState('');
  const [copiedIp, setCopiedIp] = useState<string | null>(null);
  const [startingHost, setStartingHost] = useState(false);
  const isNative = isNativeCapacitorApp();

  useEffect(() => {
    setNameInput(user.name);
  }, [user.name]);

  useEffect(() => {
    if (serverUrl) {
      setServerInput(serverUrl.replace(/^https?:\/\//, ''));
    }
  }, [serverUrl]);

  useEffect(() => {
    onRefreshRooms();
  }, [onRefreshRooms]);

  const handleCopyIp = async (ipWithPort: string) => {
    try {
      await navigator.clipboard.writeText(ipWithPort);
      setCopiedIp(ipWithPort);
      setTimeout(() => setCopiedIp(null), 1500);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleOpenCreateModal = (asTeamHost: boolean) => {
    setIsTeamHost(asTeamHost);
    setBlank(true);
    setShowCreateModal(true);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await onCreateProject({
        title:
          title.trim() ||
          (isTeamHost ? 'Командный монтаж' : 'Новый проект'),
        aspectRatio,
        backgroundColor,
        blank,
        isTeamHost,
      });
      setShowCreateModal(false);
      setTitle('');
    } finally {
      setCreating(false);
    }
  };

  const handleScanLan = async () => {
    setScanningLan(true);
    setDiscoveredServers([]);
    try {
      const results = await scanLocalLanServers(subnetHint, (found) => {
        setDiscoveredServers((prev) =>
          prev.some((s) => s.url === found.url) ? prev : [...prev, found]
        );
      });
      setDiscoveredServers(results);
    } finally {
      setScanningLan(false);
    }
  };

  const totalOnlineCount = availableRooms.length + udpRooms.length;

  return (
    <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#09090b] text-zinc-100">
      {/* Top Studio Home Header */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 bg-[#111114] px-3 py-2.5 sm:px-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-zinc-900">
            <img src="/icon.svg" alt="CutSync" className="h-6 w-6 rounded" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white sm:text-base">
              CutSync Studio
            </h1>
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
              <span
                className={`h-2 w-2 rounded-full ${
                  p2pMode === 'host'
                    ? 'bg-emerald-400 animate-pulse'
                    : status === 'connected'
                      ? 'bg-emerald-400'
                      : status === 'offline'
                        ? 'bg-zinc-500'
                        : 'bg-amber-400 animate-pulse'
                }`}
              />
              <span>
                {p2pMode === 'host'
                  ? `Хост активен (:${hostPort})`
                  : status === 'connected'
                    ? 'P2P подключён'
                    : status === 'offline'
                      ? 'Локальный режим'
                      : 'Подключение...'}
              </span>
            </div>
          </div>
        </div>

        {/* User Name & Color Quick Edit */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <div className="hidden items-center gap-1 sm:flex">
            {PROFILE_COLOR_PRESETS.slice(0, 4).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onUpdateProfile(nameInput, c)}
                style={{backgroundColor: c}}
                aria-label={`Цвет ${c}`}
                className={`h-5 w-5 rounded-full border-2 transition ${
                  user.color === c ? 'border-white scale-110' : 'border-transparent'
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-zinc-900 px-2 py-1">
            <input
              type="color"
              value={user.color}
              onChange={(e) => onUpdateProfile(nameInput, e.target.value)}
              title="Ваш цвет блокировки и курсора"
              aria-label="Ваш цвет участника"
              className="h-5 w-5 shrink-0 cursor-pointer rounded-full border border-white/20 bg-transparent p-0"
            />
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={() => onUpdateProfile(nameInput, user.color)}
              aria-label="Ваше имя"
              className="w-20 bg-transparent text-xs font-medium text-white focus:outline-none sm:w-28"
            />
          </div>
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              title="Настройки приложения (Giphy API)"
              aria-label="Настройки приложения"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-zinc-900 text-zinc-300 hover:border-cyan-400 hover:text-white active:scale-95"
            >
              <Settings className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {/* Main Navigation Tabs: Проекты | Команда */}
      <div className="shrink-0 border-b border-white/10 bg-[#111114] px-3 pt-2 pb-2 sm:px-5">
        <div className="mx-auto grid max-w-4xl grid-cols-2 gap-2 rounded-xl border border-white/10 bg-zinc-950 p-1">
          <button
            type="button"
            onClick={() => setActiveTab('projects')}
            className={`flex h-10 items-center justify-center gap-2 rounded-lg text-xs font-semibold transition sm:text-sm ${
              activeTab === 'projects'
                ? 'bg-cyan-500 text-zinc-950 shadow'
                : 'text-zinc-300 hover:text-white'
            }`}
          >
            <FolderOpen className="h-4 w-4" />
            <span>Проекты</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('team')}
            className={`flex h-10 items-center justify-center gap-2 rounded-lg text-xs font-semibold transition sm:text-sm ${
              activeTab === 'team'
                ? 'bg-emerald-500 text-zinc-950 shadow'
                : 'text-zinc-300 hover:text-white'
            }`}
          >
            <Users className="h-4 w-4" />
            <span>Команда</span>
            {totalOnlineCount > 0 && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  activeTab === 'team'
                    ? 'bg-zinc-950/20 text-zinc-950'
                    : 'bg-emerald-500/20 text-emerald-400'
                }`}
              >
                {totalOnlineCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Scrollable Home Body */}
      <main className="studio-scrollbar flex-1 overflow-y-auto px-3 py-4 sm:px-5">
        <div className="mx-auto max-w-4xl space-y-6">
          {activeTab === 'projects' ? (
            <>
              {/* Hero Create Project Button */}
              <div className="flex flex-col gap-2.5 sm:flex-row">
                <button
                  type="button"
                  onClick={() => handleOpenCreateModal(false)}
                  className="flex min-h-[60px] flex-1 items-center justify-center gap-2.5 rounded-2xl bg-gradient-to-r from-cyan-400 to-cyan-500 px-5 py-3.5 text-sm font-bold text-zinc-950 shadow-lg shadow-cyan-500/15 transition hover:brightness-105 active:scale-[0.99] sm:text-base"
                >
                  <Plus className="h-5 w-5 stroke-[2.5]" />
                  <span>Создать проект</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleOpenCreateModal(true)}
                  className="flex min-h-[54px] items-center justify-center gap-2 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 active:scale-[0.99] sm:text-sm"
                >
                  <Crown className="h-4 w-4 text-emerald-400" />
                  <span>Создать командный (Глава)</span>
                </button>
              </div>

              {/* Online Team Projects in GREEN BORDER */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-pulse" />
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
                      Проекты команды в сети ({totalOnlineCount})
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={onRefreshRooms}
                    className="flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-300 hover:text-white"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Обновить
                  </button>
                </div>

                {totalOnlineCount === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-zinc-900/40 p-4 text-xs text-zinc-400">
                    {status === 'offline'
                      ? 'Нет подключения к хосту. Перейдите во вкладку «Команда», чтобы создать комнату (Хост) или подключиться по IP / UDP 8081.'
                      : 'Пока нет активных командных комнат. Глава команды может создать проект и он сразу появится здесь в зелёной рамке.'}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {udpRooms.map((ur) => (
                      <button
                        key={`udp-${ur.ip}-${ur.roomId}`}
                        type="button"
                        onClick={() =>
                          onConnectToHostIp(`${ur.ip}:${ur.port}`, ur.roomId)
                        }
                        className="group flex items-stretch gap-3 rounded-2xl border-2 border-emerald-500 bg-emerald-950/25 p-3.5 text-left shadow-[0_0_24px_rgba(16,185,129,0.16)] transition hover:bg-emerald-950/40 active:scale-[0.99]"
                      >
                        <div className="flex h-16 w-12 shrink-0 items-center justify-center rounded-xl border border-emerald-400/40 bg-zinc-950 font-mono text-[10px] font-bold text-emerald-300">
                          {ur.aspectRatio}
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col justify-between">
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <h3 className="truncate text-sm font-bold text-white group-hover:text-emerald-200">
                                {ur.title}
                              </h3>
                              <span className="flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                                <Crown className="h-2.5 w-2.5" />
                                {ur.hostName}
                              </span>
                            </div>
                            <p className="mt-0.5 font-mono text-[10px] text-zinc-400">
                              UDP 8081 · {ur.ip}:{ur.port}
                            </p>
                          </div>
                          <div className="mt-2 flex items-center justify-between">
                            <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-400">
                              <span className="h-2 w-2 rounded-full bg-emerald-400" />
                              • online ({ur.participants})
                            </span>
                            <span className="rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-bold text-zinc-950">
                              Войти
                            </span>
                          </div>
                        </div>
                      </button>
                    ))}
                    {availableRooms.map((room) => (
                      <button
                        key={room.roomId}
                        type="button"
                        onClick={() => onJoinTeamRoom(room.roomId)}
                        className="group flex items-stretch gap-3 rounded-2xl border-2 border-emerald-500 bg-emerald-950/20 p-3.5 text-left shadow-[0_0_24px_rgba(16,185,129,0.14)] transition hover:bg-emerald-950/35 active:scale-[0.99]"
                      >
                        {/* Canvas color + aspect preview */}
                        <div
                          style={{
                            backgroundColor: room.backgroundColor || '#09090b',
                          }}
                          className="flex h-16 w-12 shrink-0 items-center justify-center rounded-xl border border-emerald-400/40 font-mono text-[10px] font-bold text-zinc-300 shadow-inner"
                        >
                          {room.aspectRatio}
                        </div>

                        <div className="flex min-w-0 flex-1 flex-col justify-between">
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <h3 className="truncate text-sm font-bold text-white group-hover:text-emerald-200">
                                {room.title}
                              </h3>
                              {room.hostName && (
                                <span className="flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                                  <Crown className="h-2.5 w-2.5" />
                                  {room.hostName}
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-[11px] text-zinc-400">
                              {room.tracksCount} дор. · {room.clipsCount} клип. ·{' '}
                              <span className="font-mono text-zinc-500">
                                #{room.roomId}
                              </span>
                            </p>
                          </div>

                          <div className="mt-2 flex items-center justify-between">
                            <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-400">
                              <span className="h-2 w-2 rounded-full bg-emerald-400" />
                              • online
                              {room.collaboratorsCount > 0 &&
                                ` (${room.collaboratorsCount})`}
                            </span>
                            <span className="rounded-lg bg-emerald-500 px-2.5 py-1 text-[11px] font-bold text-zinc-950">
                              Войти
                            </span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {/* Personal Local Projects */}
              <section className="space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  Мои проекты ({localProjects.length})
                </h2>

                {localProjects.length === 0 ? (
                  <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-6 text-center text-xs text-zinc-400">
                    <Film className="mx-auto mb-2 h-7 w-7 text-zinc-600" />
                    У вас пока нет сохранённых проектов — нажмите «Создать проект» выше.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {localProjects.map((proj) => (
                      <div
                        key={proj.roomId}
                        className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#141418] p-3 hover:border-white/25"
                      >
                        <button
                          type="button"
                          onClick={() => onOpenLocalProject(proj)}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        >
                          <div
                            style={{
                              backgroundColor: proj.backgroundColor || '#09090b',
                            }}
                            className="flex h-14 w-11 shrink-0 items-center justify-center rounded-xl border border-white/15 font-mono text-[10px] font-semibold text-zinc-300"
                          >
                            {proj.aspectRatio}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-white">
                              {proj.title}
                            </p>
                            <p className="mt-0.5 text-[11px] text-zinc-400">
                              {proj.tracksCount} дор. · {proj.clipsCount} клип.
                            </p>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteLocalProject(proj.roomId)}
                          aria-label="Удалить проект"
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-500 hover:bg-rose-500/15 hover:text-rose-400"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : (
            /* TEAM TAB («Команда») */
            <div className="space-y-5">
              {/* Admin / Team Lead Card */}
              <div className="rounded-2xl border border-emerald-500/35 bg-gradient-to-br from-emerald-950/30 via-[#141418] to-[#141418] p-4 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-400">
                      <Crown className="h-5 w-5" />
                    </div>
                    <div>
                      <h2 className="text-sm font-bold text-white">
                        Режим Главы команды (Админ)
                      </h2>
                      <p className="text-[11px] text-zinc-400">
                        Создайте общий проект — он сразу появится в зелёной рамке на главном экране у всех участников с чатом и всеми инструментами.
                      </p>
                    </div>
                  </div>
                </div>

                <form onSubmit={handleCreateSubmit} className="space-y-3">
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Название командного проекта (например: Клип 2026)"
                    className="h-11 w-full rounded-xl border border-white/15 bg-zinc-950 px-3 text-sm text-white placeholder:text-zinc-500 focus:border-emerald-400 focus:outline-none"
                  />

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <p className="mb-1.5 text-[11px] font-medium text-zinc-400">
                        Соотношение сторон
                      </p>
                      <div className="grid grid-cols-3 gap-1.5">
                        {ASPECT_OPTIONS.map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => setAspectRatio(opt.id)}
                            className={`h-9 rounded-lg font-mono text-xs font-semibold transition ${
                              aspectRatio === opt.id
                                ? 'bg-emerald-500 text-zinc-950'
                                : 'border border-white/10 bg-zinc-900 text-zinc-300'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="mb-1.5 text-[11px] font-medium text-zinc-400">
                        Цвет фона пустого холста
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {BACKGROUND_PRESETS.map((bg) => (
                          <button
                            key={bg}
                            type="button"
                            onClick={() => setBackgroundColor(bg)}
                            style={{backgroundColor: bg}}
                            aria-label={`Цвет фона ${bg}`}
                            className={`h-8 w-8 rounded-lg border-2 transition ${
                              backgroundColor === bg
                                ? 'border-emerald-400 scale-110'
                                : 'border-white/20'
                            }`}
                          />
                        ))}
                        <input
                          type="color"
                          value={backgroundColor}
                          onChange={(e) => setBackgroundColor(e.target.value)}
                          title="Свой цвет фона"
                          className="h-8 w-8 cursor-pointer rounded-lg border border-white/20 bg-transparent p-0.5"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={blank}
                        onChange={(e) => setBlank(e.target.checked)}
                        className="h-4 w-4 accent-emerald-400"
                      />
                      Начать с пустого холста
                    </label>
                    <button
                      type="submit"
                      disabled={creating}
                      onClick={() => setIsTeamHost(true)}
                      className="flex h-11 items-center gap-2 rounded-xl bg-emerald-500 px-5 text-xs font-bold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
                    >
                      <Crown className="h-4 w-4" />
                      {creating ? 'Запуск...' : 'Создать и открыть команде'}
                    </button>
                  </div>
                </form>
              </div>

              {/* Active Team Projects & UDP 8081 Rooms List */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
                    Доступные комнаты команды ({totalOnlineCount})
                  </h3>
                  <button
                    type="button"
                    onClick={onRefreshRooms}
                    className="flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-300"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Обновить
                  </button>
                </div>

                {udpRooms.map((ur) => (
                  <div
                    key={`team-udp-${ur.ip}-${ur.roomId}`}
                    className="flex items-center justify-between gap-3 rounded-2xl border-2 border-emerald-500 bg-emerald-950/25 p-3.5 shadow-[0_0_20px_rgba(16,185,129,0.14)]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-12 w-10 shrink-0 items-center justify-center rounded-lg border border-emerald-400/40 bg-zinc-950 font-mono text-[10px] font-bold text-emerald-300">
                        {ur.aspectRatio}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-bold text-white">
                            {ur.title}
                          </p>
                          <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">
                            Глава: {ur.hostName}
                          </span>
                        </div>
                        <p className="mt-0.5 flex items-center gap-2 text-xs font-semibold text-emerald-400">
                          <span>• online</span>
                          <span className="font-mono text-[11px] font-normal text-zinc-400">
                            UDP 8081 · {ur.ip}:{ur.port}
                          </span>
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        onConnectToHostIp(`${ur.ip}:${ur.port}`, ur.roomId)
                      }
                      className="h-10 shrink-0 rounded-xl bg-emerald-500 px-4 text-xs font-bold text-zinc-950 hover:bg-emerald-400"
                    >
                      Подключиться
                    </button>
                  </div>
                ))}

                {availableRooms.map((room) => (
                  <div
                    key={room.roomId}
                    className="flex items-center justify-between gap-3 rounded-2xl border-2 border-emerald-500 bg-emerald-950/20 p-3.5 shadow-[0_0_20px_rgba(16,185,129,0.12)]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        style={{
                          backgroundColor: room.backgroundColor || '#09090b',
                        }}
                        className="flex h-12 w-10 shrink-0 items-center justify-center rounded-lg border border-emerald-400/40 font-mono text-[10px] font-bold text-zinc-300"
                      >
                        {room.aspectRatio}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-bold text-white">
                            {room.title}
                          </p>
                          {room.hostName && (
                            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">
                              Глава: {room.hostName}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 flex items-center gap-2 text-xs font-semibold text-emerald-400">
                          <span>• online</span>
                          <span className="text-zinc-400 font-normal">
                            · {room.collaboratorsCount} в сети · {room.clipsCount}{' '}
                            клип.
                          </span>
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onJoinTeamRoom(room.roomId)}
                      className="h-10 shrink-0 rounded-xl bg-emerald-500 px-4 text-xs font-bold text-zinc-950 hover:bg-emerald-400"
                    >
                      Подключиться
                    </button>
                  </div>
                ))}
              </div>

              {/* P2P Ktor Host & LAN / ZeroTier One Connection */}
              <div className="rounded-2xl border border-white/10 bg-[#141418] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Wifi className="h-4 w-4 text-cyan-400" />
                    <div>
                      <h3 className="text-xs font-semibold text-white">
                        Локальный мультиплеер P2P (LAN / ZeroTier One)
                      </h3>
                      <p className="text-[10px] text-zinc-400">
                        Ktor порт {hostPort} (WebSocket /sync + HTTP /media) · UDP 8081 маячок
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {p2pMode === 'host' ? (
                      <button
                        type="button"
                        onClick={() => void onStopHost()}
                        className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/25"
                      >
                        Стоп хоста
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={startingHost}
                        onClick={async () => {
                          setStartingHost(true);
                          try {
                            await onStartHost();
                          } finally {
                            setStartingHost(false);
                          }
                        }}
                        className="rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-bold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
                      >
                        {startingHost ? 'Запуск...' : 'Создать комнату (Хост)'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onRefreshNetwork}
                      className="rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-[11px] text-zinc-200"
                    >
                      IP
                    </button>
                    <button
                      type="button"
                      onClick={handleScanLan}
                      disabled={scanningLan}
                      className="flex items-center gap-1 rounded-lg border border-cyan-500/35 bg-cyan-500/10 px-2.5 py-1.5 text-[11px] font-medium text-cyan-300 hover:bg-cyan-500/20"
                    >
                      <Search className="h-3 w-3" />
                      {scanningLan ? 'Поиск...' : 'Скан'}
                    </button>
                  </div>
                </div>

                {/* Local & ZeroTier interfaces */}
                {networkInterfaces.length > 0 && (
                  <div className="space-y-1.5 rounded-xl border border-white/10 bg-zinc-950/75 p-2.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                      Ваши локальные IP (Wi-Fi / ZeroTier zt*):
                    </p>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {networkInterfaces.map((iface) => {
                        const full = `${iface.ip}:${hostPort}`;
                        return (
                          <button
                            key={`${iface.name}-${iface.ip}`}
                            type="button"
                            onClick={() => void handleCopyIp(full)}
                            className="flex items-center justify-between rounded-lg border border-white/5 bg-zinc-900 px-2.5 py-1.5 text-left hover:border-cyan-400/50"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span
                                className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                                  iface.type === 'zerotier'
                                    ? 'bg-violet-500/25 text-violet-300'
                                    : iface.type === 'wifi'
                                      ? 'bg-emerald-500/20 text-emerald-300'
                                      : 'bg-zinc-800 text-zinc-300'
                                }`}
                              >
                                {iface.type === 'zerotier'
                                  ? 'ZeroTier'
                                  : iface.type === 'wifi'
                                    ? 'Wi-Fi'
                                    : 'LAN'}
                              </span>
                              <span className="truncate font-mono text-xs text-white">
                                {full}
                              </span>
                            </div>
                            <span className="flex items-center gap-1 text-[10px] text-cyan-400">
                              <Copy className="h-3 w-3" />
                              {copiedIp === full ? 'OK' : ''}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {discoveredServers.length > 0 && (
                  <div className="space-y-1.5">
                    {discoveredServers.map((srv) => {
                      const active =
                        serverUrl === srv.url ||
                        (!isNative && window.location.origin === srv.url);
                      return (
                        <button
                          key={srv.url}
                          type="button"
                          onClick={() => {
                            onConnectServer(srv.url);
                            setServerInput(srv.url.replace(/^https?:\/\//, ''));
                          }}
                          className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-xs ${
                            active
                              ? 'border-emerald-400/60 bg-emerald-500/10'
                              : 'border-white/10 bg-zinc-950'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Radio className="h-3.5 w-3.5 text-emerald-400" />
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-white">
                                {srv.host} · {srv.roomsCount} комн.
                              </p>
                              <p className="truncate font-mono text-[10px] text-zinc-400">
                                {srv.url}
                              </p>
                            </div>
                          </div>
                          <span className="text-[11px] font-semibold text-emerald-400">
                            {active ? 'Подключено' : 'Выбрать'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={subnetHint}
                    onChange={(e) => setSubnetHint(e.target.value)}
                    placeholder="Подсеть (напр. 192.168.1)"
                    className="h-10 rounded-xl border border-white/10 bg-zinc-950 px-3 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none sm:w-44"
                  />
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!serverInput.trim()) return;
                      onConnectToHostIp(serverInput.trim());
                    }}
                    className="flex flex-1 gap-2"
                  >
                    <input
                      type="text"
                      value={serverInput}
                      onChange={(e) => setServerInput(e.target.value)}
                      placeholder="IP хоста (10.147.x.x ZeroTier или 192.168.x.x)"
                      className="h-10 flex-1 rounded-xl border border-white/10 bg-zinc-950 px-3 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="h-10 rounded-xl bg-cyan-500 px-3.5 text-xs font-bold text-zinc-950 hover:bg-cyan-400"
                    >
                      Подкл.
                    </button>
                  </form>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Create Project Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-xs sm:items-center sm:p-4">
          <form
            onSubmit={handleCreateSubmit}
            className="w-full max-w-md space-y-4 rounded-t-3xl border border-white/15 bg-[#141418] p-5 shadow-2xl sm:rounded-2xl"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-white">
                {isTeamHost ? 'Новый командный проект (Глава)' : 'Создать проект'}
              </h2>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800 text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">
                Название проекта
              </label>
              <input
                type="text"
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Например: Ночной ролик или Влог"
                className="h-11 w-full rounded-xl border border-white/15 bg-zinc-950 px-3 text-sm text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">
                Соотношение сторон
              </label>
              <div className="grid grid-cols-3 gap-2">
                {ASPECT_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setAspectRatio(opt.id)}
                    className={`flex flex-col items-center justify-center rounded-xl border py-2 transition ${
                      aspectRatio === opt.id
                        ? 'border-cyan-400 bg-cyan-500/15 text-cyan-300'
                        : 'border-white/10 bg-zinc-900 text-zinc-300'
                    }`}
                  >
                    <span className="font-mono text-xs font-bold">
                      {opt.label}
                    </span>
                    <span className="mt-0.5 text-[9px] text-zinc-400">
                      {opt.hint.split('/')[0].trim()}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-400">
                Цвет фона пустого холста
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {BACKGROUND_PRESETS.map((bg) => (
                  <button
                    key={bg}
                    type="button"
                    onClick={() => setBackgroundColor(bg)}
                    style={{backgroundColor: bg}}
                    aria-label={`Выбрать фон ${bg}`}
                    className={`h-9 w-9 rounded-xl border-2 transition ${
                      backgroundColor === bg
                        ? 'border-cyan-400 scale-110'
                        : 'border-white/20'
                    }`}
                  />
                ))}
                <input
                  type="color"
                  value={backgroundColor}
                  onChange={(e) => setBackgroundColor(e.target.value)}
                  className="h-9 w-9 cursor-pointer rounded-xl border border-white/20 bg-transparent p-0.5"
                />
              </div>
            </div>

            <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
              <label className="flex items-center justify-between text-xs text-zinc-200 cursor-pointer">
                <span>Пустой холст (без демо-клипов)</span>
                <input
                  type="checkbox"
                  checked={blank}
                  onChange={(e) => setBlank(e.target.checked)}
                  className="h-4 w-4 accent-cyan-400"
                />
              </label>
              <label className="flex items-center justify-between text-xs text-emerald-300 cursor-pointer">
                <span>Открыть для команды (как Глава комнаты)</span>
                <input
                  type="checkbox"
                  checked={isTeamHost}
                  onChange={(e) => setIsTeamHost(e.target.checked)}
                  className="h-4 w-4 accent-emerald-400"
                />
              </label>
            </div>

            <button
              type="submit"
              disabled={creating}
              className={`flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-bold text-zinc-950 transition disabled:opacity-50 ${
                isTeamHost
                  ? 'bg-emerald-500 hover:bg-emerald-400'
                  : 'bg-cyan-500 hover:bg-cyan-400'
              }`}
            >
              {creating ? 'Создаётся...' : 'Открыть в редакторе'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
};

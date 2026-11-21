import React, {useEffect, useState} from 'react';
import {
  Check,
  Crown,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import type {AspectRatio, RoomSummary} from '../shared/types.ts';
import {
  getApiUrl,
  isNativeCapacitorApp,
  scanLocalLanServers,
} from '../lib/serverConfig.ts';
import type {DiscoveredServer} from '../lib/serverConfig.ts';
import {BACKGROUND_PRESETS} from './HomeScreen.tsx';

interface RoomsLobbyModalProps {
  currentRoomId: string;
  serverUrl: string;
  status: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  availableRooms: RoomSummary[];
  onSelectRoom: (roomId: string) => void;
  onCreateRoom: (opts: {
    title: string;
    aspectRatio: AspectRatio;
    backgroundColor: string;
    blank: boolean;
    isPublicLan: boolean;
  }) => Promise<void>;
  onRefreshRooms: () => void;
  onConnectServer: (url: string) => void;
  onClose: () => void;
}

export const RoomsLobbyModal: React.FC<RoomsLobbyModalProps> = ({
  currentRoomId,
  serverUrl,
  status,
  availableRooms,
  onSelectRoom,
  onCreateRoom,
  onRefreshRooms,
  onConnectServer,
  onClose,
}) => {
  const [newTitle, setNewTitle] = useState('');
  const [newAspect, setNewAspect] = useState<AspectRatio>('9:16');
  const [newBg, setNewBg] = useState('#09090b');
  const [newBlank, setNewBlank] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [scanningLan, setScanningLan] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>(
    []
  );
  const [subnetHint, setSubnetHint] = useState('');
  const [manualHost, setManualHost] = useState(serverUrl);
  const isNative = isNativeCapacitorApp();

  useEffect(() => {
    onRefreshRooms();
    const netUrl = getApiUrl('/api/network-info');
    if (netUrl) {
      fetch(netUrl)
        .then((r) => r.json())
        .then((d: {lanUrls?: string[]}) => {
          if (Array.isArray(d.lanUrls)) setLanUrls(d.lanUrls);
        })
        .catch(() => {});
    }
  }, [onRefreshRooms, serverUrl]);

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

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await onCreateRoom({
        title: newTitle.trim() || 'Командный монтаж',
        aspectRatio: newAspect,
        backgroundColor: newBg,
        blank: newBlank,
        isPublicLan: true,
      });
      onClose();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-xs sm:items-center sm:p-4">
      <div className="flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-white/15 bg-[#121216] shadow-2xl sm:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
              <Wifi className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white sm:text-base">
                Комнаты команды в сети
              </h2>
              <p className="text-[11px] text-zinc-400">
                Выберите комнату в зелёной рамке или откройте новую
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть список комнат"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="studio-scrollbar flex-1 space-y-4 overflow-y-auto p-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowCreateForm((v) => !v)}
              className="flex min-h-[42px] flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-3 text-xs font-bold text-zinc-950 hover:bg-emerald-400 active:scale-[0.98]"
            >
              <Plus className="h-4 w-4" />
              Открыть комнату (Глава)
            </button>
            <button
              type="button"
              onClick={onRefreshRooms}
              className="flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-zinc-900 px-3 text-xs font-medium text-zinc-200 hover:bg-zinc-800"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Обновить
            </button>
            <button
              type="button"
              onClick={handleScanLan}
              disabled={scanningLan}
              className="flex min-h-[42px] items-center justify-center gap-1.5 rounded-xl border border-cyan-500/35 bg-cyan-500/10 px-3 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50"
            >
              <Search className="h-3.5 w-3.5" />
              {scanningLan ? 'Поиск в Wi-Fi...' : 'Найти в Wi-Fi'}
            </button>
          </div>

          {showCreateForm && (
            <form
              onSubmit={handleCreateSubmit}
              className="space-y-3 rounded-xl border border-emerald-500/35 bg-emerald-500/5 p-3.5"
            >
              <p className="text-xs font-semibold text-emerald-200">
                Создать командную комнату
              </p>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Название проекта (например: Влог за выходные)"
                className="h-10 w-full rounded-lg border border-white/15 bg-zinc-950 px-3 text-xs text-white placeholder:text-zinc-500 focus:border-emerald-400 focus:outline-none"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-1">
                  {(['9:16', '16:9', '1:1', '4:5'] as AspectRatio[]).map(
                    (ar) => (
                      <button
                        key={ar}
                        type="button"
                        onClick={() => setNewAspect(ar)}
                        className={`rounded-lg px-2.5 py-1.5 font-mono text-[11px] font-medium ${
                          newAspect === ar
                            ? 'bg-emerald-500 text-zinc-950'
                            : 'bg-zinc-900 text-zinc-300 border border-white/10'
                        }`}
                      >
                        {ar}
                      </button>
                    )
                  )}
                </div>
                <label className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newBlank}
                    onChange={(e) => setNewBlank(e.target.checked)}
                    className="accent-emerald-400"
                  />
                  Пустой
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-zinc-400 mr-1">Фон:</span>
                {BACKGROUND_PRESETS.slice(0, 6).map((bg) => (
                  <button
                    key={bg}
                    type="button"
                    onClick={() => setNewBg(bg)}
                    style={{backgroundColor: bg}}
                    className={`h-6 w-6 rounded-md border ${
                      newBg === bg ? 'border-emerald-400 scale-110' : 'border-white/20'
                    }`}
                  />
                ))}
                <input
                  type="color"
                  value={newBg}
                  onChange={(e) => setNewBg(e.target.value)}
                  className="h-6 w-6 cursor-pointer rounded bg-transparent p-0"
                />
              </div>
              <button
                type="submit"
                disabled={creating}
                className="h-10 w-full rounded-lg bg-emerald-500 text-xs font-bold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {creating ? 'Создаётся...' : 'Создать и открыть команде'}
              </button>
            </form>
          )}

          {(scanningLan ||
            discoveredServers.length > 0 ||
            isNative ||
            status === 'offline') && (
            <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-200">
                  <Radio
                    className={`h-3.5 w-3.5 ${
                      scanningLan
                        ? 'text-emerald-400 animate-pulse'
                        : 'text-zinc-400'
                    }`}
                  />
                  Серверы в локальной Wi-Fi сети
                </span>
                <input
                  type="text"
                  value={subnetHint}
                  onChange={(e) => setSubnetHint(e.target.value)}
                  placeholder="Подсеть 192.168.1"
                  className="h-7 w-32 rounded-md border border-white/10 bg-zinc-950 px-2 font-mono text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:border-cyan-400 focus:outline-none"
                />
              </div>

              {discoveredServers.length > 0 ? (
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
                          setManualHost(srv.url);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${
                          active
                            ? 'border-emerald-400/60 bg-emerald-500/10'
                            : 'border-white/10 bg-zinc-950 hover:border-cyan-400/50'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium text-white">
                            {srv.host} · {srv.roomsCount} комн.
                          </p>
                          <p className="truncate font-mono text-[10px] text-zinc-400">
                            {srv.url}
                          </p>
                        </div>
                        <span className="shrink-0 text-[11px] font-semibold text-emerald-400">
                          {active ? 'Подключено' : 'Выбрать'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[11px] text-zinc-500">
                  {scanningLan
                    ? 'Сканируем локальную сеть на порту 3000...'
                    : 'Нажмите «Найти в Wi-Fi» или введите IP компьютера (например 192.168.1.15).'}
                </p>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onConnectServer(manualHost);
                }}
                className="flex gap-2 pt-1"
              >
                <input
                  type="text"
                  value={manualHost}
                  onChange={(e) => setManualHost(e.target.value)}
                  placeholder="IP сервера или URL (192.168.1.15)"
                  className="h-9 flex-1 rounded-lg border border-white/10 bg-zinc-950 px-2.5 font-mono text-xs text-white placeholder:text-zinc-500 focus:border-cyan-400 focus:outline-none"
                />
                <button
                  type="submit"
                  className="h-9 rounded-lg bg-zinc-800 px-3 text-xs font-medium text-white hover:bg-zinc-700"
                >
                  Подключить
                </button>
              </form>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>Доступные комнаты ({availableRooms.length})</span>
              {lanUrls.length > 0 && (
                <span className="font-mono text-[10px] text-zinc-500">
                  Wi-Fi хост: {lanUrls[0]}
                </span>
              )}
            </div>

            {availableRooms.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-zinc-900/50 p-5 text-center text-xs text-zinc-400">
                {status === 'offline'
                  ? 'Вы сейчас в локальном режиме. Подключите сервер выше, чтобы увидеть комнаты в сети.'
                  : 'Открытых комнат пока нет — нажмите «Открыть комнату».'}
              </div>
            ) : (
              <div className="space-y-2">
                {availableRooms.map((room) => {
                  const isCurrent = room.roomId === currentRoomId;
                  return (
                    <div
                      key={room.roomId}
                      className={`flex items-center justify-between gap-3 rounded-xl border-2 p-3 transition ${
                        isCurrent
                          ? 'border-cyan-400 bg-cyan-500/10'
                          : 'border-emerald-500/80 bg-emerald-950/20 hover:bg-emerald-950/35'
                      }`}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        <div
                          style={{
                            backgroundColor: room.backgroundColor || '#09090b',
                          }}
                          className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg border border-white/15 font-mono text-[10px] font-bold text-zinc-300"
                        >
                          {room.aspectRatio}
                        </div>
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-white">
                              {room.title}
                            </span>
                            {room.hostName && (
                              <span className="flex shrink-0 items-center gap-0.5 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">
                                <Crown className="h-2.5 w-2.5" />
                                {room.hostName}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                            <span className="font-semibold text-emerald-400">
                              • online
                            </span>
                            <span>
                              <Users className="mr-0.5 inline h-3 w-3" />
                              {room.collaboratorsCount}
                            </span>
                            <span>
                              {room.tracksCount} дор. / {room.clipsCount} клип.
                            </span>
                          </div>
                        </div>
                      </div>

                      {isCurrent ? (
                        <span className="flex h-10 shrink-0 items-center gap-1 rounded-xl bg-cyan-500/20 px-3 text-xs font-semibold text-cyan-300">
                          <Check className="h-3.5 w-3.5" />
                          Вы тут
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            onSelectRoom(room.roomId);
                            onClose();
                          }}
                          className="h-10 shrink-0 rounded-xl bg-emerald-500 px-4 text-xs font-bold text-zinc-950 hover:bg-emerald-400 active:scale-95"
                        >
                          Войти
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

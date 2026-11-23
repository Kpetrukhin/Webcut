import path from 'node:path';

export interface StoragePathValidationResult {
  valid: boolean;
  resolvedPath?: string;
  isRelativeToAppRoot?: boolean;
  error?: string;
}

const POSIX_FORBIDDEN_EXACT = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var',
]);

const POSIX_FORBIDDEN_PREFIXES = [
  '/bin/',
  '/boot/',
  '/dev/',
  '/etc/',
  '/lib/',
  '/lib32/',
  '/lib64/',
  '/proc/',
  '/sbin/',
  '/sys/',
  '/usr/',
];

function isWindowsDriveRoot(p: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(p.trim());
}

function isWindowsAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

export function validateServerStorageDir(
  rawInput: string,
  appRootDir: string
): StoragePathValidationResult {
  if (typeof rawInput !== 'string') {
    return {valid: false, error: 'Путь должен быть строкой'};
  }
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {valid: false, error: 'Укажите путь к папке'};
  }
  if (trimmed.length > 512) {
    return {valid: false, error: 'Путь слишком длинный (максимум 512 символов)'};
  }
  if (trimmed.includes('\0') || /[\r\n]/.test(trimmed)) {
    return {valid: false, error: 'Недопустимые символы в пути'};
  }

  const normalizedRoot = path.resolve(appRootDir);
  const isWinAbs = isWindowsAbsolute(trimmed);
  const isAbs = path.isAbsolute(trimmed) || isWinAbs;

  let resolved: string;
  if (!isAbs) {
    resolved = path.resolve(normalizedRoot, trimmed);
    const inRoot =
      resolved === normalizedRoot ||
      resolved.startsWith(normalizedRoot + path.sep);
    if (!inRoot) {
      return {
        valid: false,
        error:
          'Относительный путь не может выходить за пределы корневой папки приложения',
      };
    }
  } else if (isWinAbs && process.platform !== 'win32') {
    resolved = path.win32.resolve(trimmed);
  } else {
    resolved = path.resolve(trimmed);
  }

  const normalizedSlashes = resolved.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const lowerPosix = normalizedSlashes.toLowerCase();

  if (POSIX_FORBIDDEN_EXACT.has(lowerPosix)) {
    return {
      valid: false,
      error: 'Нельзя выбирать системную корневую папку операционной системы',
    };
  }
  for (const prefix of POSIX_FORBIDDEN_PREFIXES) {
    if (lowerPosix.startsWith(prefix)) {
      return {
        valid: false,
        error: 'Нельзя сохранять медиафайлы в системные каталоги ОС',
      };
    }
  }

  if (isWindowsDriveRoot(resolved)) {
    return {
      valid: false,
      error: 'Укажите конкретную папку на диске, а не корень диска целиком',
    };
  }
  if (
    /^[a-z]:\/(windows|program files|program files \(x86\)|programdata)(\/|$)/i.test(
      normalizedSlashes
    )
  ) {
    return {
      valid: false,
      error: 'Нельзя сохранять медиафайлы в системную папку Windows',
    };
  }

  const segments = lowerPosix.split('/');
  if (
    segments.includes('node_modules') ||
    segments.includes('.git')
  ) {
    return {
      valid: false,
      error: 'Нельзя использовать служебные каталоги .git или node_modules',
    };
  }

  const isRelativeToAppRoot =
    resolved === normalizedRoot ||
    resolved.startsWith(normalizedRoot + path.sep);

  return {
    valid: true,
    resolvedPath: resolved,
    isRelativeToAppRoot,
  };
}

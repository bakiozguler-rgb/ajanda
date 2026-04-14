import type { MobileSyncConfig } from '../types';

const SYNC_PAIRING_PREFIX = 'zennotes-sync:';

type SyncPairingPayload = {
  authKey: string;
  generatedAt: number;
  serverUrl: string;
  serverUrls?: string[];
};

const encodeBase64Url = (value: string) => (
  btoa(unescape(encodeURIComponent(value)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
);

const decodeBase64Url = (value: string) => {
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');

  return decodeURIComponent(escape(atob(normalized)));
};

export const buildSyncPairingValue = (config: MobileSyncConfig) => {
  const fallbackServerUrls = Array.isArray(config.fallbackServerUrls)
    ? config.fallbackServerUrls
      .filter((url) => typeof url === 'string')
      .map((url) => url.trim().replace(/\/+$/g, ''))
      .filter(Boolean)
      .filter((url, index, items) => items.indexOf(url) === index)
    : [];
  const payload: SyncPairingPayload = {
    serverUrl: config.serverUrl.trim().replace(/\/+$/g, ''),
    authKey: config.authKey.trim(),
    generatedAt: Date.now(),
    serverUrls: fallbackServerUrls,
  };

  return `${SYNC_PAIRING_PREFIX}${encodeBase64Url(JSON.stringify(payload))}`;
};

export const parseSyncPairingValue = (rawValue: string): MobileSyncConfig | null => {
  if (!rawValue.startsWith(SYNC_PAIRING_PREFIX)) {
    return null;
  }

  try {
    const encodedPayload = rawValue.slice(SYNC_PAIRING_PREFIX.length);
    const payload = JSON.parse(decodeBase64Url(encodedPayload)) as Partial<SyncPairingPayload>;

    if (typeof payload.serverUrl !== 'string' || typeof payload.authKey !== 'string') {
      return null;
    }

    const serverUrl = payload.serverUrl.trim().replace(/\/+$/g, '');
    const authKey = payload.authKey.trim();
    if (!serverUrl || !authKey) {
      return null;
    }

    const fallbackServerUrls = Array.isArray(payload.serverUrls)
      ? payload.serverUrls
        .filter((url): url is string => typeof url === 'string')
        .map((url) => url.trim().replace(/\/+$/g, ''))
        .filter((url) => !!url && url !== serverUrl)
        .filter((url, index, items) => items.indexOf(url) === index)
      : undefined;

    return { serverUrl, authKey, fallbackServerUrls };
  } catch {
    return null;
  }
};

import type { Participant } from '../domain/game';
import type { AdminSession } from '../domain/admin';

export interface ParticipantSession extends Participant {
  readonly code: string;
  readonly token: string;
}

export interface HostSession {
  readonly roomId: string;
  readonly code: string;
  readonly token: string;
  readonly gameId?: string;
  readonly gameRevision?: number;
  readonly gameName?: string;
}

const PARTICIPANT_KEY = 'name-that:participant';
const HOST_KEY = 'name-that:host';
const ADMIN_KEY = 'name-that:admin';

function read<T>(key: string): T | null {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function write<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export const participantSession = {
  get: (code?: string) => {
    const session = read<ParticipantSession>(PARTICIPANT_KEY);
    return !code || session?.code === code ? session : null;
  },
  set: (session: ParticipantSession) => write(PARTICIPANT_KEY, session),
  clear: () => localStorage.removeItem(PARTICIPANT_KEY),
};

export const hostSession = {
  get: () => read<HostSession>(HOST_KEY),
  set: (session: HostSession) => write(HOST_KEY, session),
  clear: () => localStorage.removeItem(HOST_KEY),
};

export const adminSession = {
  get: () => read<AdminSession>(ADMIN_KEY),
  set: (session: AdminSession) => write(ADMIN_KEY, session),
  clear: () => localStorage.removeItem(ADMIN_KEY),
};

/** Authoritative phases. Clients render these values; only trusted host actions advance them. */
export const gamePhases = [
  'lobby',
  'question_open',
  'answers_locked',
  'employee_revealed',
  'results_displayed',
  'complete',
] as const;

export type GamePhase = (typeof gamePhases)[number];

export const clientRoles = ['participant', 'host', 'display'] as const;

export type ClientRole = (typeof clientRoles)[number];

export interface Employee {
  readonly id: string;
  readonly displayName: string;
  readonly imageUrl: string;
  readonly team?: string;
  readonly funFact?: string;
}

export interface Round {
  readonly id: string;
  readonly employeeId: Employee['id'];
  readonly answerEmployeeIds: readonly [string, string, string, string];
}

export interface GameSnapshot {
  readonly roomCode: string;
  readonly phase: GamePhase;
  readonly roundIndex: number | null;
  readonly roundCount: number;
  readonly connectedParticipantCount: number;
  readonly submittedAnswerCount: number;
  readonly version: number;
}

export function isGamePhase(value: unknown): value is GamePhase {
  return typeof value === 'string' && gamePhases.some((phase) => phase === value);
}


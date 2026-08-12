export const gamePhases = [
  'lobby',
  'question_open',
  'answers_locked',
  'employee_revealed',
  'results_displayed',
  'complete',
] as const;

export type GamePhase = (typeof gamePhases)[number];
export type HostAction = 'start' | 'lock' | 'reveal' | 'show_results' | 'next_round' | 'end';

export interface Choice {
  readonly id: string;
  readonly displayName: string;
  readonly position: number;
}

export interface RevealedEmployee {
  readonly id: string;
  readonly displayName: string;
  readonly team: string | null;
  readonly funFact: string | null;
  readonly mediaAvailable: boolean;
}

export interface ChoiceResult {
  readonly employeeId: string;
  readonly count: number;
}

export interface GameResults {
  readonly totalAnswers: number;
  readonly correctAnswers: number;
  readonly choices: readonly ChoiceResult[];
}

export interface GameSnapshot {
  readonly roomCode: string;
  readonly phase: GamePhase;
  readonly roundIndex: number | null;
  readonly roundCount: number;
  readonly connectedParticipantCount: number;
  readonly submittedAnswerCount: number;
  readonly version: number;
  readonly choices: readonly Choice[];
  readonly revealedEmployee: RevealedEmployee | null;
  readonly results: GameResults | null;
  readonly updatedAt: string;
}

export interface Participant {
  readonly playerId: string;
  readonly roomId: string;
  readonly displayName: string;
}

export interface ParticipantSnapshot {
  readonly playerId: string;
  readonly answerEmployeeId: string | null;
}

export interface HostRoom {
  readonly roomId: string;
  readonly code: string;
  readonly phase: GamePhase;
  readonly currentRound: number | null;
  readonly roundCount: number;
  readonly isFinalRound: boolean;
  readonly correctEmployee: { readonly id: string; readonly displayName: string; readonly team: string | null } | null;
  readonly version: number;
}

export function isGamePhase(value: unknown): value is GamePhase {
  return typeof value === 'string' && gamePhases.some((phase) => phase === value);
}

export const phaseLabels: Record<GamePhase, string> = {
  lobby: 'Lobby open',
  question_open: 'Answers open',
  answers_locked: 'Answers locked',
  employee_revealed: 'Teammate revealed',
  results_displayed: 'Results live',
  complete: 'Game complete',
};

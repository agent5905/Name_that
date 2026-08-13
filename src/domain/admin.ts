export interface GameChoiceDefinition {
  readonly id?: string;
  readonly position?: number;
  readonly text: string;
  readonly isCorrect: boolean;
}

export interface GameQuestionDefinition {
  readonly id?: string;
  readonly position?: number;
  readonly prompt: string;
  readonly revealName: string;
  readonly funFact: string | null;
  readonly mysteryMediaAssetId: string | null;
  readonly revealMediaAssetId: string | null;
  readonly mysteryMediaPreviewUrl?: string | null;
  readonly revealMediaPreviewUrl?: string | null;
  readonly choices: readonly GameChoiceDefinition[];
}

export interface GameDefinition {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly questions: readonly GameQuestionDefinition[];
}

export interface GameSummary {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly questionCount: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface AdminSession {
  readonly id: string;
  readonly token: string;
}

export interface CreatedRoom {
  readonly roomId: string;
  readonly code: string;
  readonly gameId?: string;
  readonly gameRevision?: number;
  readonly gameName?: string;
}

export interface SessionCreationOperation {
  readonly hostToken: string;
  readonly idempotencyKey: string;
}

export interface ParticipantJoinOperation {
  readonly participantToken: string;
  readonly idempotencyKey: string;
}

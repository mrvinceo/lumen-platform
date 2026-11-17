export type Change =
  | { type: "upsert"; externalId: string; title: string; mimeType: string; modifiedAt?: Date; url?: string }
  | { type: "delete"; externalId: string };

export interface FetchedFile {
  bytes: Uint8Array;
  mimeType: string;
  title: string;
  url?: string;
  modifiedAt?: Date;
}

export interface ChangePage {
  changes: Change[];
  /** Cursor to persist once the page is fully processed (Drive page token / Graph delta link). */
  nextCursor?: string;
}

export interface SourceConnector {
  readonly type: "upload" | "gdrive" | "onedrive";
  authorizeUrl?(state: string, redirectUri: string): string;
  exchangeCode?(code: string, redirectUri: string): Promise<{ refreshToken: string }>;
  /** With no cursor, enumerates everything (full sync). */
  listChanges(cursor?: string): AsyncIterable<ChangePage>;
  fetch(externalId: string): Promise<FetchedFile>;
}

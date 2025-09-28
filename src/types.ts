export type Role = "system" | "user" | "assistant";
export type Actor = "orchestrator" | "child" | "external" | "user";

export interface MessageRecord {
  role: Role;
  content: string;
  ts: number;
  actor?: Actor;
}

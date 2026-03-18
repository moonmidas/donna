import type { GatewaySkill } from "./skills.js";

export interface RpcEvent {
  id?: number;
  type: string;
  [key: string]: unknown;
}

export interface PromptResult {
  events: RpcEvent[];
  text: string;
}

export interface PromptOptions {
  images?: string[];
  idleTimeout?: number;
  skills?: GatewaySkill[];
  onEvent?: (event: RpcEvent) => void | Promise<void>;
}

export interface AgentSession {
  readonly alive: boolean;
  promptAndWait(message: string, options?: PromptOptions): Promise<PromptResult>;
  stop(): void;
  onExit(listener: (code: number, signal: string) => void): void;
}

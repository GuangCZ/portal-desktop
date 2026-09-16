// Ported line by line from BeingDesktop 0.8.26 src/desktop-terminal-tools.cjs on 2026-09-16.
// A conversation can automate only the shared terminals it created itself.
// DesktopTerminal itself belongs to another migration unit, so it arrives through
// `getTerminal`. See docs/interfaces.md §3「DesktopTools」and the terminal scope frame
// in src/desktop-message-context.cjs (message-context.ts).
import { randomUUID } from 'node:crypto';
import type { DesktopTerminalLike, TerminalSession } from './types';

export interface TerminalToolsOptions {
  getTerminal: () => DesktopTerminalLike | null;
  showTerminal: (terminalId: string) => unknown;
}
/** The session binding a message carries so retries stay inside one conversation. */
// A type alias, not an interface: TS grants it the implicit index signature that
// lets a scope be spread straight into TerminalToolArguments at call sites.
export type TerminalScope = { sessionId: string; sessionToken: string };
export interface TerminalToolArguments {
  sessionId?: string;
  sessionToken?: string;
  terminalId?: string;
  cwd?: string;
  data?: string;
  afterSequence?: number;
  requestId?: string;
  [key: string]: unknown;
}
interface ScopeState {
  sessionToken: string;
  terminals: Set<string>;
  requests: Map<string, { fingerprint: string; promise: Promise<unknown> }>;
}

// A conversation can automate only the shared terminals it created itself.
export class DesktopTerminalTools {
  getTerminal: () => DesktopTerminalLike | null;
  showTerminal: (terminalId: string) => unknown;
  scopes: Map<string, ScopeState>;
  constructor({getTerminal,showTerminal}: TerminalToolsOptions) {
    this.getTerminal=getTerminal;this.showTerminal=showTerminal;this.scopes=new Map();
  }
  scope(sessionId: string): TerminalScope {
    let scope=this.scopes.get(sessionId);
    if(!scope) {
      scope={sessionToken:randomUUID(),terminals:new Set<string>(),requests:new Map()};
      this.scopes.set(sessionId,scope);
    }
    return {sessionId,sessionToken:scope.sessionToken};
  }
  sessions(sessionId: string | undefined): TerminalSession[] {
    const owned=sessionId===undefined?undefined:this.scopes.get(sessionId)?.terminals;
    return (this.getTerminal()?.snapshot().sessions || []).filter(item=>owned?.has(item.id));
  }
  reset(): void { this.scopes.clear(); }
  async invoke(name: string,args: TerminalToolArguments,{signal}: { signal?: AbortSignal } = {}): Promise<unknown> {
    const scope=args.sessionId===undefined?undefined:this.scopes.get(args.sessionId),terminal=this.getTerminal();
    const check=()=>{
      if(signal?.aborted || !scope || (args.sessionId!==undefined && this.scopes.get(args.sessionId)!==scope) || scope.sessionToken!==args.sessionToken)throw new Error('终端调用不属于当前桌面会话，请使用当前消息中的会话绑定。');
      if(!terminal)throw new Error('交互终端尚未就绪。');
    };
    check();
    if(name==='desktop_terminal_list')return {sessions:this.sessions(args.sessionId)};
    if(name!=='desktop_terminal_create' && !scope!.terminals.has(args.terminalId!))throw new Error('只能操作本会话创建的终端，不能接管其他会话或用户单独创建的终端。');
    const execute=async(): Promise<unknown>=>{
      check();
      switch(name) {
        case 'desktop_terminal_create': {
          const result=await terminal!.create({cwd:args.cwd});
          try { check(); } catch(error) { await terminal!.close(result.sessionId);throw error; }
          scope!.terminals.add(result.sessionId);
          await this.showTerminal(result.sessionId);
          return {terminalId:result.sessionId,shell:terminal!.shell || 'PowerShell',interactive:true,visible:true,...terminal!.readSince(result.sessionId,0)};
        }
        case 'desktop_terminal_write': {
          const result=terminal!.write({id:args.terminalId!,data:args.data!});
          return {...result,terminalId:args.terminalId,status:terminal!.snapshot().sessions.find(item=>item.id===args.terminalId)?.status};
        }
        case 'desktop_terminal_read':return {...terminal!.readSince(args.terminalId!,args.afterSequence || 0),terminal:terminal!.snapshot().sessions.find(item=>item.id===args.terminalId)};
        case 'desktop_terminal_show':terminal!.activate(args.terminalId!);await this.showTerminal(args.terminalId!);return {terminalId:args.terminalId,visible:true};
        case 'desktop_terminal_close':return terminal!.close(args.terminalId!);
        default:throw new Error('终端工具不可用。');
      }
    };
    if(!['desktop_terminal_create','desktop_terminal_write','desktop_terminal_close'].includes(name))return execute();
    if(typeof args.requestId!=='string' || !args.requestId)throw new Error('终端操作需要 requestId，重试时沿用同一个值。');
    const fingerprint=JSON.stringify([name,args.terminalId || '',args.cwd || '',args.data || '']);
    const prior=scope!.requests.get(args.requestId);
    if(prior) {
      if(prior.fingerprint!==fingerprint)throw new Error('同一 requestId 不能用于不同终端操作。');
      return prior.promise;
    }
    if(scope!.requests.size>=10000)throw new Error('当前会话的终端操作记录已满，请新建对话。');
    const promise=Promise.resolve().then(execute);
    scope!.requests.set(args.requestId,{fingerprint,promise});
    return promise;
  }
}

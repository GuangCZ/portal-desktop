// Ported line by line from BeingDesktop 0.8.26 src/desktop-network.cjs on 2026-09-16.
// The Portal installer needs Node-shaped requests with manually observable
// redirects; `net.request` is injected so the adapter is testable without Electron.
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

/** The Electron `net.request` surface this adapter drives. */
export interface NativeRequest {
  on(event: string, listener: (...args: any[]) => void): unknown;
  setHeader(name: string, value: string): unknown;
  end(): unknown;
  abort(): unknown;
}
export type NativeRequestFactory = (options: {
  url: string; method: string; redirect: string; credentials: string; useSessionCookies: boolean; referrerPolicy: string;
}) => NativeRequest;
export interface PortalDownloadRequest extends EventEmitter {
  destroy(): PortalDownloadRequest;
  end(): void;
}
export type PortalRequestAdapter = (url: URL, options: unknown, callback: (response: any) => void) => PortalDownloadRequest;

// Electron fetch rejects manual redirects. ClientRequest exposes them before following.
export function portalRequestAdapter(requestImpl: NativeRequestFactory): PortalRequestAdapter {
  return (url, options, callback) => {
    const request = new EventEmitter() as PortalDownloadRequest;
    let ended=false, delivered=false, nativeRequest: NativeRequest | undefined;
    const fail = () => {
      if (!delivered) { delivered=true; request.emit('error', new Error('Portal download failed')); }
    };
    request.destroy = () => {
      // Cancel native I/O as well as the installer promise, including before headers.
      ended=true; delivered=true; nativeRequest?.abort();
      return request;
    };
    request.end = () => {
      if (ended) return;
      ended=true;
      try {
        nativeRequest=requestImpl({url:url.href,method:'GET',redirect:'manual',credentials:'omit',useSessionCookies:false,referrerPolicy:'no-referrer'});
        nativeRequest.on('error',fail);
        nativeRequest.on('redirect',(statusCode: number,method: string,redirectUrl: string)=>{
          if (delivered) return;
          delivered=true;
          const response=Readable.from([]) as Readable & { statusCode?: number; headers?: Record<string, unknown> };
          response.statusCode=statusCode;
          response.headers={location:redirectUrl};
          try { callback(response); } finally { nativeRequest!.abort(); }
        });
        nativeRequest.on('response',(response: any)=>{
          if (delivered) { response.resume(); return; }
          delivered=true;
          // Body errors remain attached to the actual response stream.
          callback(response);
        });
        nativeRequest.setHeader('User-Agent','Being-Desktop-Portal-Installer');
        nativeRequest.setHeader('Accept','application/octet-stream');
        nativeRequest.end();
      } catch { fail(); }
    };
    return request;
  };
}

import http from 'node:http';

/** OpenAI's documented example port for this callback; later sign-ins may use another, so a taken port falls back to any free one. */
export const CALLBACK_PORT=1455;

/**
 * ChatGPT sign-in returns to plain HTTP on 127.0.0.1, but an engine serving TLS itself (STUDIO_TLS=engine) speaks only TLS on its port.
 * This listener binds 127.0.0.1 alone, serves GET /auth/callback and nothing else, and runs only while a sign-in can still return to it.
 * State, PKCE and the signed ID token are checked by the sign-in itself, exactly as on the engine's own port.
 */
export class LoopbackCallback {
  constructor({handle,headers=()=>{},pendingUntil,port=CALLBACK_PORT}){this.handle=handle;this.headers=headers;this.pendingUntil=pendingUntil;this.port=port;this.listening=null;this.timer=null;this.held=0;}
  /**
   * Opens the listener when needed and returns the redirect URI. It stays open until the matching release(), so an attempt being
   * registered is never closed under; the address is fixed while any attempt is pending, so each attempt keeps its exact URI.
   */
  async open(){
    this.held++;
    try {
      this.listening ||= this.listen().catch(error=>{this.listening=null;throw error;});
      return `http://127.0.0.1:${(await this.listening).address().port}/auth/callback`;
    } catch(error){this.release();throw error;}
  }
  release(){this.held--;this.settle();}
  async listen(){
    const server=http.createServer((req,res)=>this.request(req,res));
    server.requestTimeout=30_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;
    const bind=port=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
    try{await bind(this.port);}catch(error){if(error.code!=='EADDRINUSE')throw error;await bind(0);}
    return server;
  }
  async request(req,res){
    this.held++;
    try {
      this.headers(res);res.setHeader('Connection','close');
      const address=`127.0.0.1:${req.socket.localPort}`;let url=null;
      try{url=new URL(req.url,`http://${address}`);}catch{}
      // Exact loopback Host and Origin, so another site (for example through DNS rebinding) cannot address it.
      if(req.method!=='GET' || url?.pathname!=='/auth/callback' || req.headers.host!==address || (req.headers.origin && req.headers.origin!==`http://${address}`)){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found.');return;}
      await this.handle(req,res,url);
    } catch {if(!res.headersSent){res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});res.end('Sign-in could not be completed.');}else res.end();}
    finally {this.release();}
  }
  /** Closes the listener once no pending attempt can return to it. Runs after each start, callback, cancel and sign-out, and at expiry. */
  settle(){
    clearTimeout(this.timer);this.timer=null;
    if(!this.listening || this.held)return;
    const until=this.pendingUntil();
    if(until>Date.now()){this.timer=setTimeout(()=>this.settle(),until-Date.now()+1000);this.timer.unref?.();return;}
    void this.close();
  }
  async close(){
    clearTimeout(this.timer);this.timer=null;
    const listening=this.listening;this.listening=null;
    const server=await listening?.catch(()=>null);if(!server)return;
    const closed=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();
    const force=setTimeout(()=>server.closeAllConnections(),2000);force.unref?.();
    await closed;clearTimeout(force);
  }
}

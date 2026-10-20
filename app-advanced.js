(() => {
  'use strict';
  const api=window.SquarewiseAPI;
  if(!api){console.error('Squarewise core API was not loaded.');return;}
  const $=(selector,root=document)=>root.querySelector(selector);
  const $$=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
  const esc=(value)=>String(value??'').replace(/[&<>"']/g,(ch)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const getState=()=>api.state;
  let ChessClass=null;
  let chessLoadError='';
  const chessReady=import('./vendor/chess/chess.mjs').then(module=>{
    ChessClass=module.Chess;
    if(getState().page==='play'||getState().page==='drills')api.render();
    return ChessClass;
  }).catch(error=>{
    chessLoadError=error?.message||'Could not load chess rules library.';
    console.error('Squarewise chess rules library failed to load:',error);
    if(getState().page==='play'||getState().page==='drills')api.render();
    throw error;
  });
  // Avoid an unhandled rejection if the chess module is blocked in a static file preview.
  chessReady.catch(()=>{});
  if(!Array.isArray(getState().drills))getState().drills=[];
  if(!Array.isArray(getState().importedGames))getState().importedGames=[];
  if(!getState().profile) getState().profile={};

  class StockfishClient{
    constructor(){this.worker=null;this.readyPromise=null;this.status='idle';this.current=null;this.queue=Promise.resolve();this.onStatus=null;}
    notify(){if(typeof this.onStatus==='function')this.onStatus(this.status);}
    async init(){
      if(this.readyPromise)return this.readyPromise;
      this.status='loading';this.notify();
      this.readyPromise=new Promise((resolve,reject)=>{
        if(typeof Worker==='undefined'){this.status='error';this.notify();reject(new Error('Web Workers are not available in this browser.'));return;}
        let settled=false;
        const timeout=setTimeout(()=>{
          if(!settled){settled=true;this.status='error';this.notify();this.readyPromise=null;reject(new Error('Stockfish took too long to start.'));
          try{this.worker?.terminate();}catch(_){}}
        },25000);
        try{
          const workerUrl=new URL('./vendor/stockfish/stockfish-19-lite-single.js',document.baseURI);
          this.worker=new Worker(workerUrl);
          this.worker.onmessage=(event)=>this.handleLine(String(event.data??'').trim(),{resolve,reject,timeout,markSettled:()=>{settled=true;}});
          this.worker.onerror=(event)=>{
            if(!settled){settled=true;clearTimeout(timeout);this.status='error';this.notify();this.readyPromise=null;reject(new Error(event.message||'Stockfish worker failed to load.'));}
            if(this.current){const current=this.current;this.current=null;clearTimeout(current.timer);current.reject(new Error(event.message||'Stockfish worker failed.'));}
          };
          this.worker.postMessage('uci');
        }catch(error){
          settled=true;clearTimeout(timeout);this.status='error';this.notify();this.readyPromise=null;reject(error);
        }
      });
      return this.readyPromise;
    }
    handleLine(line,ready){
      if(!line)return;
      if(line==='uciok'){
        try{this.worker?.postMessage('isready');}catch(_){}
        return;
      }
      if(line==='readyok'&&this.status==='loading'){
        if(!ready.markSettled()){} // marker is intentionally side-effect-only
        clearTimeout(ready.timeout);this.status='ready';this.notify();ready.resolve();return;
      }
      if(line.startsWith('info ')){
        const info=parseEngineInfo(line);
        if(this.current){
          const rank=info.multipv||1,previous=this.current.candidates.get(rank);
          if(!previous||info.depth>=previous.depth)this.current.candidates.set(rank,info);
          if(rank===1)this.current.latest=info;
          if(this.current.onInfo)this.current.onInfo(info);
        }
        return;
      }
      if(line.startsWith('bestmove ')){
        if(!this.current)return;
        const current=this.current;this.current=null;clearTimeout(current.timer);
        const move=line.match(/^bestmove\s+(\S+)/)?.[1]||'';
        const candidates=Array.from(current.candidates.entries()).sort((a,b)=>a[0]-b[0]).map(([multipv,info])=>({...info,multipv,bestMove:info.pv?.trim().split(/\s+/)[0]||''}));
        current.resolve({...current.latest,bestMove:move,candidates,raw:line});
      }
    }
    search(fen,{depth=10,movetime=0,skill=20,multipv=1,onInfo=null,timeoutMs=45000}={}){
      const task=()=>this._search(fen,{depth,movetime,skill,multipv,onInfo,timeoutMs});
      const result=this.queue.then(task,task);
      this.queue=result.catch(()=>{});
      return result;
    }
    async _search(fen,{depth,movetime,skill,multipv,onInfo,timeoutMs}){
      await this.init();
      if(!this.worker)throw new Error('Stockfish worker is unavailable.');
      return new Promise((resolve,reject)=>{
        const safeDepth=Math.max(1,Math.min(18,Number(depth)||10));
        const requestedMoveTime=Number(movetime);
        const safeMoveTime=Number.isFinite(requestedMoveTime)&&requestedMoveTime>0?Math.max(50,Math.min(5000,requestedMoveTime)):0;
        const safeSkill=Math.max(0,Math.min(20,Number(skill)||0));
        const safeMultiPv=Math.max(1,Math.min(3,Math.round(Number(multipv)||1)));
        const timer=setTimeout(()=>{
          if(this.current?.resolve===resolve){this.current=null;try{this.worker?.postMessage('stop');}catch(_){}reject(new Error('Engine search timed out. Try a lower depth.'));}
        },timeoutMs);
        this.current={resolve,reject,timer,onInfo,latest:{depth:0,score:{type:'cp',value:0},pv:'',nodes:0},candidates:new Map()};
        try{
          this.worker.postMessage('setoption name Threads value 1');
          this.worker.postMessage('setoption name Hash value 64');
          this.worker.postMessage(`setoption name Skill Level value ${safeSkill}`);
          this.worker.postMessage(`setoption name MultiPV value ${safeMultiPv}`);
          this.worker.postMessage('ucinewgame');
          this.worker.postMessage(`position fen ${fen}`);
          this.worker.postMessage(safeMoveTime?`go movetime ${safeMoveTime}`:`go depth ${safeDepth}`);
        }catch(error){this.current=null;clearTimeout(timer);reject(error);}
      });
    }
    stop(){try{this.worker?.postMessage('stop');}catch(_){}}
  }
  function parseEngineInfo(line){
    const depth=Number(line.match(/\bdepth\s+(\d+)/)?.[1]||0);
    const nodes=Number(line.match(/\bnodes\s+(\d+)/)?.[1]||0);
    const multipv=Number(line.match(/\bmultipv\s+(\d+)/)?.[1]||1);
    const scoreMatch=line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
    const pv=line.match(/\bpv\s+(.+)$/)?.[1]||'';
    return {depth,nodes,multipv,score:scoreMatch?{type:scoreMatch[1],value:Number(scoreMatch[2])}:{type:'cp',value:0},pv,raw:line};
  }
  const engine=new StockfishClient();
  function engineStatusMarkup(){
    const labels={idle:'Stockfish loads on demand',loading:'Loading Stockfish Lite…',ready:'Stockfish Lite ready',error:'Engine unavailable'};
    return `<span class="engine-status ${engine.status==='loading'?'loading':''} ${engine.status==='error'?'error':''}"><i class="engine-dot"></i>${labels[engine.status]||'Stockfish'}</span>`;
  }
  engine.onStatus=()=>{if(getState().page==='play')api.render();};

  const glyphs={wk:'♔',wq:'♕',wr:'♖',wb:'♗',wn:'♘',wp:'♙',bk:'♚',bq:'♛',br:'♜',bb:'♝',bn:'♞',bp:'♟'};
  function uciMove(uci){
    if(!uci||uci==='0000'||uci==='(none)')return null;
    return {from:uci.slice(0,2),to:uci.slice(2,4),...(uci.length>4?{promotion:uci[4].toLowerCase()}: {})};
  }
  function moveToUci(move){return move?`${move.from}${move.to}${move.promotion||''}`:'';}
  const sessionPuzzleBank=[
    {id:'fork-c4-e5',title:'Find the knight fork',stage:'TACTICAL WARM-UP',fen:'8/3k1q2/8/8/2N5/8/8/4K3 w - - 0 1',bestMoveUci:'c4e5',bestMoveSan:'Ne5+',hint:'Look for a knight jump that checks the king while attacking the queen.',explanation:'Ne5+ forks the king on d7 and queen on f7. The check wins a tempo and leaves the queen attacked.',difficulty:1},
    {id:'loose-queen',title:'Take the undefended queen',stage:'FORCING CAPTURE',fen:'4k3/8/8/8/3q4/8/3Q4/4K3 w - - 0 1',bestMoveUci:'d2d4',bestMoveSan:'Qxd4',hint:'Before calculating a long line, scan for an undefended high-value piece.',explanation:'Qxd4 removes the loose queen. Always scan checks, captures, and threats before choosing a quiet move.',difficulty:1},
    {id:'promotion-check',title:'Promote with check',stage:'PAWN RACE',fen:'7k/1PK5/8/8/8/8/8/8 w - - 0 1',bestMoveUci:'b7b8q',bestMoveSan:'b8=Q+',hint:'Choose the promotion that checks the distant king along the back rank.',explanation:'b8=Q+ checks along the eighth rank, and your king protects the promotion square. Promotion with tempo keeps the initiative.',difficulty:2},
    {id:'mate-in-one',title:'Spot the mating net',stage:'MATING PATTERN',fen:'7k/8/5KQ1/8/8/8/8/8 w - - 0 1',bestMoveUci:'g6g7',bestMoveSan:'Qg7#',hint:'Look for a queen move that covers the king’s escape squares and is protected by your king.',explanation:'Qg7# is mate: the queen controls the escape squares and the white king protects the queen on g7.',difficulty:2}
  ];
  const focusQuestionBank={
    tactics:{title:'What should your candidate scan include?',prompt:'Before committing to a move, which scan is most reliable?',options:[['forcing','Checks, captures, and threats—for both sides.'],['attack','Only the attacking idea I want to play.'],['familiar','The first move that feels familiar.']],correct:'forcing',explanation:'A forcing-move scan makes you test your own idea against the opponent’s strongest reply.'},
    endgame:{title:'Activate before you advance',prompt:'You are in a rook ending with a passive king and a supported passer. What comes first?',options:[['king','Improve king and rook activity, then advance when supported.'],['push','Push the pawn immediately, regardless of the rook.'],['trade','Offer a rook trade without checking the pawn ending.']],correct:'king',explanation:'Active pieces create the conditions for a safe pawn advance. Avoid rushing the passer.'},
    opening:{title:'When preparation runs out',prompt:'Your opponent leaves your known opening line. What should guide the next move?',options:[['principles','Develop, contest the center, and keep king safety in view.'],['memorize','Spend time trying to recall a line no matter what.'],['flank','Start a flank pawn attack before developing.']],correct:'principles',explanation:'Use the position’s needs and opening principles, then add the new branch to your repertoire.'},
    clock:{title:'Spend the last 20 seconds well',prompt:'The position is quiet and you have about 20 seconds. What is a practical approach?',options:[['scan','Check forcing candidates, choose a safe improving move, and keep a reserve.'],['rush','Move instantly to save time.'],['calculate','Calculate every branch until the clock runs out.']],correct:'scan',explanation:'Spend the time on forcing options and a safe improvement, while preserving a small reserve.'},
    defense:{title:'Find active defense',prompt:'You are a pawn down, but your pieces are active. What gives you practical chances?',options:[['counterplay','Create a threat that makes the opponent respond.'],['passive','Trade every active piece and wait.'],['resign','Assume the position is lost without checking resources.']],correct:'counterplay',explanation:'Active counterplay makes the opponent solve problems and can create drawing chances.'},
    positional:{title:'Improve the position',prompt:'There is no immediate tactic. What is a useful planning question?',options:[['worst','Which of my pieces is least active, and where can it improve?'],['pawn','Which pawn can I push fastest?'],['trade','Which piece can I trade without checking the resulting structure?']],correct:'worst',explanation:'Improving the least active piece is a reliable plan when forcing moves are not available.'}
  };
  function boardMarkup(fen,{orientation='w',interactive='',selected='',targets=[],lastMove=null}={}){
    if(!ChessClass)return '<div class="play-loading">Loading the chess rules library…</div>';
    let chess;
    try{chess=new ChessClass(fen);}catch(_){chess=new ChessClass();}
    const files=orientation==='b'?'hgfedcba':'abcdefgh';
    const targetMap=new Map((targets||[]).map(item=>typeof item==='string'?[item,{capture:false}]:[item.to,item]));
    let html='<div class="board-area"><div class="chessboard" role="grid" aria-label="Chess position">';
    for(let row=0;row<8;row++){
      const rank=orientation==='b'?row+1:8-row;
      for(let col=0;col<8;col++){
        const file=files[col],square=file+rank,piece=chess.get(square),dark=(row+col)%2===1;
        const target=targetMap.get(square),isSelected=selected===square;
        const last=lastMove&&(lastMove.from===square||lastMove.to===square);
        const pieceCode=piece?piece.color+piece.type:'';
        const glyph=piece?glyphs[pieceCode]:'';
        const aria=`${square}${piece?` ${piece.color==='w'?'white':'black'} ${piece.type}`:''}`;
        const tag=interactive?'button':'button';
        const attrs=interactive?`data-${interactive}-square="${square}"`:'tabindex="-1"';
        const targetClass=target?(target.capture?'legal-capture':'legal-square'):'';
        const coord=(col===0?`<span class="coord">${rank}</span>`:'')+(row===7?`<span class="coord" style="left:auto;right:3px">${file}</span>`:'');
        html+=`<${tag} type="button" class="square ${dark?'dark':'light'} ${isSelected?'play-selected':''} ${last?'last-move':''} ${targetClass}" ${attrs} role="gridcell" aria-label="${aria}">${glyph?`<span class="piece ${piece.color==='w'?'white-piece':'black-piece'}">${glyph}</span>`:''}${coord}</${tag}>`;
      }
    }
    return html+'</div></div>';
  }
  function engineCandidateMoves(info,fen){
    if(!ChessClass||!info)return [];
    const source=Array.isArray(info.candidates)&&info.candidates.length?info.candidates:[{multipv:1,bestMove:info.bestMove,pv:info.pv,score:info.score}];
    return source.slice(0,3).map((candidate,index)=>{
      const bestMove=candidate.bestMove||candidate.pv?.trim().split(/\s+/)[0]||'';
      const move=uciMove(bestMove);if(!move)return null;
      let san='';try{san=new ChessClass(fen).move(move)?.san||'';}catch(_){}
      return {...candidate,bestMove,multipv:candidate.multipv||index+1,san,from:move.from,to:move.to};
    }).filter(Boolean);
  }
  function reviewArrows(gameViewer,options){
    const arrows=new Map(options.map(option=>[option.bestMove,{from:option.from,to:option.to,color:'green'}]));
    const played=gameViewer.moves[gameViewer.ply];
    const verdict=gameViewer.moveVerdicts?.find(item=>item.ply===gameViewer.ply+1)||gameViewer.report?.find(item=>item.ply===gameViewer.ply+1);
    if(played&&verdict){
      const uci=moveToUci(played);
      arrows.set(uci,{from:played.from,to:played.to,color:verdict.lossCp>=70?'red':'green'});
    }
    return Array.from(arrows.values());
  }
  function arrowSvgMarkup(arrows){
    const point=square=>{
      if(!/^[a-h][1-8]$/.test(square||''))return null;
      const file=square.charCodeAt(0)-97,rank=Number(square[1]);
      return [file+.5,8-rank+.5];
    };
    const lines=arrows.map(arrow=>{
      const from=point(arrow.from),to=point(arrow.to);if(!from||!to)return '';
      const color=arrow.color==='red'?'red':'green';
      const stroke=color==='red'?'#d43f3a':'#258447';
      return `<line x1="${from[0]}" y1="${from[1]}" x2="${to[0]}" y2="${to[1]}" stroke="${stroke}" stroke-width=".13" stroke-linecap="round" opacity=".88" marker-end="url(#squarewise-arrow-${color})"/>`;
    }).join('');
    if(!lines)return '';
    return `<svg aria-hidden="true" viewBox="0 0 8 8" style="position:absolute;inset:5px;width:calc(100% - 10px);height:calc(100% - 10px);pointer-events:none;z-index:4;overflow:visible"><defs><marker id="squarewise-arrow-green" viewBox="0 0 1 1" refX=".86" refY=".5" markerWidth=".8" markerHeight=".8" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 1 .5 L 0 1 z" fill="#258447"/></marker><marker id="squarewise-arrow-red" viewBox="0 0 1 1" refX=".86" refY=".5" markerWidth=".8" markerHeight=".8" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 0 L 1 .5 L 0 1 z" fill="#d43f3a"/></marker></defs>${lines}</svg>`;
  }
  function sanLineFromUci(fen,line){
    if(!ChessClass||!line)return '';
    const chess=new ChessClass(fen),tokens=[];
    for(const token of line.trim().split(/\s+/).slice(0,10)){
      const move=uciMove(token);if(!move)break;
      try{const result=chess.move(move);if(!result)break;tokens.push(result.san);}catch(_){break;}
    }
    return tokens.join(' ');
  }
  function whiteScore(info,fen){
    const side=(fen.split(' ')[1]||'w');
    let value=info?.score?.value??0;
    if(info?.score?.type==='mate')value=value>=0?100000-Math.min(1000,Math.abs(value))*10:-100000+Math.min(1000,Math.abs(value))*10;
    return side==='w'?value:-value;
  }
  function scoreLabel(score){
    if(Math.abs(score)>=95000){const mate=Math.max(1,Math.round((100000-Math.abs(score))/10));return `${score>0?'+':'−'}M${mate}`;}
    const pawns=Math.abs(score)/100;return `${score>=0?'+':'−'}${pawns.toFixed(2)}`;
  }
  function pawnLoss(cps){return `${(Math.max(0,cps)/100).toFixed(2)} pawns`}
  function scoreSideLabel(info,fen){return scoreLabel(whiteScore(info,fen));}

  // Register the full-play mode and the local game-derived drill page with the existing UI.
  const moduleList=api.modules;
  if(!moduleList.some(module=>module.id==='engine-play'))moduleList.push({id:'engine-play',title:'Play vs Stockfish',cat:'Games',icon:'♚',badge:'Full legal game',desc:'Play a complete game against Stockfish in your browser, with hints and analysis.',time:'Anytime',level:'Local engine'});
  const importTabs={paste:'PGN file / paste',chesscom:'Chess.com',lichess:'Lichess'};
  let importInitial='';
  let playGame=null;
  let viewer=null;
  let activeDrill=null;
  let activeSession=null;

  function openImportModal(initial=''){
    const tab=typeof initial==='object'&&initial?.tab?initial.tab:'paste';
    importInitial=typeof initial==='string'?initial:'';
    const profile=getState().profile;
    const panel=(key,label,contents)=>`<div class="import-panel ${tab===key?'active':''}" data-import-panel="${key}">${contents}</div>`;
    $('#modal-root').innerHTML=`<div class="modal-backdrop" data-action="backdrop-close"><section class="modal-panel modal-wide" role="dialog" aria-modal="true" aria-labelledby="unified-import-title"><div class="modal-head"><div><div class="eyebrow">PRIVATE GAME IMPORT</div><h2 id="unified-import-title">Bring in your games</h2><p>Import a PGN file, paste text, or fetch recent public games from your chess account.</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Close">×</button></div><div class="import-tabs">${Object.entries(importTabs).map(([key,label])=>`<button class="import-tab ${tab===key?'active':''}" data-action="import-tab" data-tab="${key}">${label}</button>`).join('')}</div>
      ${panel('paste','PGN',`<div class="form-field"><label for="pgn-input">PGN text</label><textarea id="pgn-input" placeholder="[Event &quot;Casual Game&quot;]\n[White &quot;Player&quot;]\n[Black &quot;Opponent&quot;]\n[Result &quot;1-0&quot;]\n\n1. e4 e5 2. Nf3 Nc6 1-0">${esc(importInitial)}</textarea><div class="form-help">Standard PGN with move text is replayable and can be analyzed with Stockfish. Your original PGN stays on this device.</div></div><div class="drop-zone">Choose a PGN file from your device<input id="pgn-file" type="file" accept=".pgn,text/plain"></div><div id="pgn-error" class="error-text" aria-live="polite"></div><div class="modal-actions"><button class="quiet-button" data-action="load-example">Use example PGN</button><button class="primary-button" data-action="import-pgn-submit">Import PGN</button></div>`)}
      ${panel('chesscom','Chess.com',`<div class="form-field"><label for="chesscom-user">Chess.com username</label><input id="chesscom-user" maxlength="40" value="${esc(profile.chesscomUsername||'')}" placeholder="Your public username"></div><div class="form-field"><label for="chesscom-limit">Recent games to fetch</label><select id="chesscom-limit"><option value="25">25 games</option><option value="50" selected>50 games</option><option value="100">100 games</option><option value="200">200 games</option></select><div class="form-help">Imports public standard-chess games from recent monthly archives. Chess.com’s published API is read-only. Username sync needs the configured Squarewise import API; static hosting alone cannot fetch platform games.</div></div><div id="chesscom-status" class="api-status" aria-live="polite"></div><div class="modal-actions"><button class="quiet-button" data-action="close-modal">Cancel</button><button class="primary-button" data-action="sync-chesscom">Fetch Chess.com games</button></div>`)}
      ${panel('lichess','Lichess',`<div class="form-field"><label for="lichess-user">Lichess username</label><input id="lichess-user" maxlength="40" value="${esc(profile.lichessUsername||'')}" placeholder="Your Lichess username"></div><div class="form-field"><label for="lichess-limit">Recent games to fetch</label><select id="lichess-limit"><option value="25">25 games</option><option value="50" selected>50 games</option><option value="100">100 games</option><option value="200">200 games</option></select></div><div class="form-field"><label for="lichess-token">Optional personal API token</label><input id="lichess-token" type="password" autocomplete="off" placeholder="Only needed for private/own-game access"></div><div class="token-note">The token is sent to the configured import API only for this request and is never saved to the profile or browser storage. Public deployments should use HTTPS. For public games, leave this blank. Username sync needs the configured Squarewise import API; static hosting alone cannot fetch games.</div><div id="lichess-status" class="api-status" aria-live="polite"></div><div class="modal-actions"><button class="quiet-button" data-action="close-modal">Cancel</button><button class="primary-button" data-action="sync-lichess">Fetch Lichess games</button></div>`)}
      </section></div>`;
  }
  function setImportTab(tab){
    if(!importTabs[tab])return;
    $$('.import-tab').forEach(button=>button.classList.toggle('active',button.dataset.tab===tab));
    $$('.import-panel').forEach(panel=>panel.classList.toggle('active',panel.dataset.importPanel===tab));
  }
  function importParsedGames(games,provider='pgn',username=''){
    const valid=games.filter(game=>game&&game.pgn&&game.pgn.trim());
    if(!valid.length)throw new Error('No readable games with PGN move text were found.');
    const state=getState();
    api.clearIllustrativeData();
    const existing=new Set(state.importedGames.map(game=>`${game.white}|${game.black}|${game.date}|${game.result}|${game.pgn?.slice(-120)||''}`));
    const fresh=[];
    for(const game of valid){
      const key=`${game.white}|${game.black}|${game.date}|${game.result}|${game.pgn?.slice(-120)||''}`;
      if(existing.has(key))continue;
      existing.add(key);fresh.push({...game,provider,account:username||'',importedAt:new Date().toISOString()});
    }
    state.importedGames=[...fresh,...state.importedGames].slice(0,400);
    state.demo=false;
    if(provider==='chess.com'&&username)state.profile.chesscomUsername=username;
    if(provider==='lichess'&&username)state.profile.lichessUsername=username;
    state.tasks.review=true;
    $('#modal-root').innerHTML='';viewer=null;activeDrill=null;
    api.persist();api.setPage('games');
    api.showToast(`${fresh.length} new game${fresh.length===1?'':'s'} added. ${valid.length-fresh.length?`${valid.length-fresh.length} duplicate(s) skipped.`:''}`);
  }
  function statusMessage(provider,message,type=''){
    const node=$(`#${provider}-status`);if(!node)return;
    node.textContent=message;node.className=`api-status ${type}`;
  }
  async function syncAccount(provider){
    const input=provider==='chess.com'?'#chesscom-user':'#lichess-user';
    const prefix=provider==='chess.com'?'chesscom':'lichess';
    const username=$(input)?.value.trim()||'';
    const maxGames=Number($(`#${prefix}-limit`)?.value||50);
    const token=provider==='lichess'?($('#lichess-token')?.value.trim()||''):'';
    if(!username){statusMessage(prefix,'Enter a username first.','error');return;}
    const endpoint=provider==='chess.com'?'/api/import/chesscom':'/api/import/lichess';
    const button=$(`[data-action="sync-${prefix}"]`);
    if(button){button.disabled=true;button.textContent='Fetching games…';}
    statusMessage(prefix,`Requesting up to ${maxGames} recent games from ${provider}…`);
    try{
      let requestUrl=endpoint;
      const configuredOrigin=String(window.SQUAREWISE_CONFIG?.importApiBaseUrl||'').trim();
      if(configuredOrigin){
        let parsedOrigin;
        try{parsedOrigin=new URL(configuredOrigin);}catch(_){throw new Error('The import API URL in squarewise-config.js is invalid.');}
        if(parsedOrigin.protocol!=='https:'&&!(parsedOrigin.protocol==='http:'&&['localhost','127.0.0.1'].includes(parsedOrigin.hostname)))throw new Error('The deployed import API must use HTTPS.');
        requestUrl=`${parsedOrigin.origin}${endpoint}`;
      }
      const response=await fetch(requestUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,maxGames,token})});
      const contentType=(response.headers.get('content-type')||'').toLowerCase();
      let data;
      try{data=await response.json();}
      catch(_){
        const staticPreview=contentType.includes('text/html')||!contentType.includes('application/json');
        throw new Error(staticPreview?'No import API responded with JSON. In a public build, set importApiBaseUrl in squarewise-config.js; locally, start `python3 server.py`.':'The import API returned an unreadable response.');
      }
      if(!response.ok)throw new Error(data.error||`Import failed (${response.status}).`);
      const games=api.parsePgn(data.pgn||'');
      if(!games.length)throw new Error('The service returned no readable PGN games.');
      const s=getState();
      if(provider==='chess.com')s.profile.chesscomUsername=username;else s.profile.lichessUsername=username;
      importParsedGames(games,provider,username);
    }catch(error){
      const message=error?.message||'Game import failed.';
      statusMessage(prefix,message.toLowerCase().includes('fetch')?'Could not reach the import API. Check squarewise-config.js and the backend CORS allowlist; locally, run `python3 server.py`.':message,'error');
    }finally{
      if(button&&document.body.contains(button)){button.disabled=false;button.textContent=provider==='chess.com'?'Fetch Chess.com games':'Fetch Lichess games';}
    }
  }
  function importPgnFromModal(){
    const text=$('#pgn-input')?.value||'';
    const games=api.parsePgn(text);
    const error=$('#pgn-error');
    if(!games.length){if(error)error.textContent='No readable PGN games found. Check the headers and moves, or use the example PGN.';return;}
    try{importParsedGames(games,'pgn','');}catch(err){if(error)error.textContent=err.message;}
  }

  function createPlayGame(color='w',skill=8){
    if(!ChessClass)return null;
    const requestedSkill=Number(skill);
    playGame={chess:new ChessClass(),userColor:color==='b'?'b':'w',skill:Math.max(0,Math.min(20,Number.isFinite(requestedSkill)?requestedSkill:8)),selected:'',targets:[],thinking:false,resigned:false,message:'Your move. Make a move by selecting a piece and destination.',hint:'',createdAt:new Date().toISOString()};
    return playGame;
  }
  function ensurePlayGame(){if(!playGame&&ChessClass)createPlayGame('w',8);return playGame;}
  function gameStatus(game){
    if(game.resigned)return 'Resigned · start a new game when ready.';
    if(game.chess.isCheckmate())return `${game.chess.turn()==='w'?'Black':'White'} wins by checkmate.`;
    if(game.chess.isDraw())return 'Draw · the game is over.';
    if(game.thinking)return 'Stockfish is thinking…';
    if(game.message)return game.message;
    if(game.chess.turn()===game.userColor)return game.chess.isCheck()?'Your king is in check · find a reply.':'Your move.';
    return 'Engine to move.';
  }
  function renderMovePairs(history,{clickable=false,currentPly=0}={}){
    if(!history.length)return '<div class="small-muted" style="padding:15px 3px">The move list will appear as the game begins.</div>';
    let html='';
    for(let i=0;i<history.length;i+=2){
      const number=Math.floor(i/2)+1,white=history[i],black=history[i+1];
      const w=clickable?`<button class="move-token ${currentPly===i+1?'current':''}" data-view-ply="${i+1}">${esc(white.san)}</button>`:`<span class="move-token">${esc(white.san)}</span>`;
      const b=black?(clickable?`<button class="move-token ${currentPly===i+2?'current':''}" data-view-ply="${i+2}">${esc(black.san)}</button>`:`<span class="move-token">${esc(black.san)}</span>`):'<span></span>';
      html+=`<div class="move-pair"><span class="move-number">${number}.</span>${w}${b}</div>`;
    }
    return html;
  }
  function renderPlayPage(){
    if(!ChessClass)return `<div class="page-heading"><div><p class="eyebrow">FULL LEGAL CHESS · LOCAL ENGINE</p><h1>Play vs Stockfish</h1><p class="page-subtitle">${chessLoadError?'The chess rules library could not load. Refresh the app or check the local vendor files.':'Loading the legal chessboard…'}</p></div>${engineStatusMarkup()}</div><div class="card play-loading">${esc(chessLoadError||'Preparing the chessboard and local engine tools…')}</div>`;
    const game=ensurePlayGame();
    const history=game.chess.history({verbose:true});
    const last=history.length?history[history.length-1]:null;
    const legalTargets=game.selected?game.chess.moves({square:game.selected,verbose:true}).map(move=>({to:move.to,capture:Boolean(move.captured)})):[];
    const status=gameStatus(game);
    return `<div class="page-heading"><div><p class="eyebrow">FULL LEGAL CHESS · RUNS ON THIS DEVICE</p><h1>Play vs Stockfish</h1><p class="page-subtitle">A complete game against a local Stockfish engine. No game moves leave your browser.</p></div>${engineStatusMarkup()}</div>
      <div class="info-strip"><span class="info-icon">♚</span><div><strong>Local engine opponent.</strong> Stockfish Lite runs in a Web Worker. Choose your color and strength; use a hint when you want to compare your candidate with the engine.</div></div>
      <section class="play-layout"><div class="card play-card"><div class="play-toolbar"><div class="play-selects"><label class="small-muted">Play as <select id="engine-color" aria-label="Choose your color"><option value="w" ${game.userColor==='w'?'selected':''}>White</option><option value="b" ${game.userColor==='b'?'selected':''}>Black</option></select></label><label class="small-muted">Engine strength <select id="engine-skill" aria-label="Engine strength">${[0,3,6,8,10,12,15,18,20].map(level=>`<option value="${level}" ${game.skill===level?'selected':''}>${level===0?'Beginner':level===20?'Maximum':`Level ${level}`}</option>`).join('')}</select></label></div><button class="primary-button" data-action="new-engine-game">New game</button></div><div class="play-board-shell"><div class="play-board">${boardMarkup(game.chess.fen(),{orientation:game.userColor,interactive:'play',selected:game.selected,targets:legalTargets,lastMove:last})}</div><div class="play-status"><span><strong>${esc(status)}</strong></span><span>${game.chess.isCheck()&&!game.chess.isGameOver()?'Check':'Standard chess'}</span></div></div><div class="play-actions"><button class="outline-button" data-action="engine-hint" ${game.thinking||game.chess.turn()!==game.userColor||game.resigned?'disabled':''}>Ask for a hint</button><button class="outline-button" data-action="engine-undo" ${game.thinking||history.length===0?'disabled':''}>Undo turn</button><button class="quiet-button" data-action="engine-resign" ${game.chess.isGameOver()||game.resigned?'disabled':''}>Resign</button><button class="quiet-button" data-action="save-engine-game" ${history.length===0?'disabled':''}>Save to games</button><button class="quiet-button" data-action="download-engine-pgn" ${history.length===0?'disabled':''}>Download PGN</button></div></div>
      <aside class="card move-panel"><div class="panel-head"><div><h2>Move list</h2><p>${history.length} half-moves · ${game.chess.turn()==='w'?'White':'Black'} to move</p></div><span class="sample-tag">LOCAL GAME</span></div><div class="move-list">${renderMovePairs(history)}</div><div class="engine-tip"><strong>${game.hint?'Engine hint':'A practical reminder'}</strong>${esc(game.hint||'Before choosing, check forcing moves and your opponent’s best reply. The engine can suggest a line; understanding the plan is your job.')}</div><div class="engine-tip"><strong>Engine details</strong>Stockfish 19 Lite · single-threaded WebAssembly · GPL-3.0. Engine strength is adjustable; deeper analysis takes longer.</div></aside></section>`;
  }
  function uciObjectForMove(from,to,chess){
    const legal=chess.moves({square:from,verbose:true}).find(move=>move.to===to);
    if(!legal)return null;
    return {from,to,...(legal.promotion?{promotion:'q'}:{})};
  }
  async function engineTurn(game){
    if(!game||playGame!==game||game.resigned||game.chess.isGameOver()||game.chess.turn()===game.userColor)return;
    game.thinking=true;game.message='Stockfish is thinking…';game.hint='';api.render();
    const fen=game.chess.fen();
    try{
      const depth=Math.max(5,Math.min(15,Math.round(6+game.skill*.42)));
      const result=await engine.search(fen,{depth,skill:game.skill,timeoutMs:60000});
      if(playGame!==game||game.chess.fen()!==fen)return;
      const move=uciMove(result.bestMove);
      if(move){const played=game.chess.move(move);game.message=played?`Stockfish played ${played.san}. Your move.`:'Engine returned an invalid move.';}
    }catch(error){if(playGame===game)game.message=error?.message||'Engine search failed.';}
    finally{if(playGame===game){game.thinking=false;api.render();}}
  }
  function handlePlaySquare(square){
    const game=playGame;if(!game||game.thinking||game.resigned||game.chess.isGameOver()||game.chess.turn()!==game.userColor)return;
    const piece=game.chess.get(square);
    if(!game.selected){
      if(piece&&piece.color===game.userColor){game.selected=square;game.message='Choose a highlighted legal destination.';}
      else{game.message='Select one of your own pieces.';}
      api.render();return;
    }
    const legal=game.chess.moves({square:game.selected,verbose:true});
    const targetMove=legal.find(move=>move.to===square);
    if(targetMove){
      try{
        game.chess.move({from:game.selected,to:square,...(targetMove.promotion?{promotion:'q'}:{})});
        game.selected='';game.message=gameStatus(game);game.hint='';
        if(game.chess.turn()!==game.userColor&&!game.chess.isGameOver())setTimeout(()=>engineTurn(game),80);
      }catch(_){game.message='That move was not legal.';game.selected='';}
    }else if(piece&&piece.color===game.userColor){game.selected=square;game.message='Piece selected. Choose a highlighted legal destination.';}
    else{game.selected='';game.message='That square is not a legal destination.';}
    api.render();
  }
  async function askEngineHint(){
    const game=playGame;if(!game||game.thinking||game.chess.turn()!==game.userColor||game.chess.isGameOver())return;
    game.thinking=true;game.message='Checking candidate moves…';api.render();
    const fen=game.chess.fen();
    try{
      const result=await engine.search(fen,{depth:13,skill:20,timeoutMs:60000});
      if(playGame!==game||game.chess.fen()!==fen)return;
      const move=uciMove(result.bestMove);const san=move?sanLineFromUci(fen,result.bestMove).split(' ')[0]:'';
      game.hint=san?`Stockfish suggests ${san} (${scoreSideLabel(result,fen)}). Compare the idea with your own candidate.`:'No engine move was returned.';
      game.message='Hint ready. Your move.';
    }catch(error){game.message=error?.message||'Could not get an engine hint.';}
    finally{if(playGame===game){game.thinking=false;api.render();}}
  }
  function setNewEngineGame(){
    if(!ChessClass){api.showToast('Chessboard is still loading.');return;}
    const color=$('#engine-color')?.value||'w',skill=Number($('#engine-skill')?.value||8);
    const game=createPlayGame(color,skill);api.render();
    if(color==='b')setTimeout(()=>engineTurn(game),100);
  }
  function undoEngineTurn(){
    const game=playGame;if(!game||game.thinking)return;
    if(game.chess.history().length){game.chess.undo();if(game.chess.turn()!==game.userColor&&game.chess.history().length)game.chess.undo();}
    game.selected='';game.hint='';game.message='Turn undone. Your move.';api.render();
  }
  function engineGameResult(game){
    if(game.resigned)return game.userColor==='w'?'0-1':'1-0';
    if(game.chess.isCheckmate())return game.chess.turn()==='w'?'0-1':'1-0';
    if(game.chess.isDraw())return '1/2-1/2';
    return '*';
  }
  function engineGamePgn(game){
    const chess=game.chess;
    chess.setHeader('Event','Squarewise vs Stockfish');chess.setHeader('Site','Squarewise local');
    chess.setHeader('Date',new Date().toISOString().slice(0,10).replaceAll('-','.'));
    chess.setHeader('White',game.userColor==='w'?(getState().profile.name||'Player'):'Stockfish Lite');
    chess.setHeader('Black',game.userColor==='b'?(getState().profile.name||'Player'):'Stockfish Lite');
    chess.setHeader('Result',engineGameResult(game));
    return chess.pgn({maxWidth:100});
  }
  function saveEngineGame(){
    const game=playGame;if(!game||!game.chess.history().length){api.showToast('Make at least one move before saving.');return;}
    const games=api.parsePgn(engineGamePgn(game));
    if(!games.length){api.showToast('Could not format this game as PGN.');return;}
    importParsedGames(games,'squarewise-engine','');
  }
  function downloadText(filename,text,type='text/plain'){
    const blob=new Blob([text],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
  }

  function positionFenAt(gameViewer,ply){
    if(ply<=0)return gameViewer.moves.length?gameViewer.moves[0].before:new ChessClass().fen();
    return gameViewer.moves[Math.min(ply,gameViewer.moves.length)-1].after;
  }
  async function openGameViewer(index){
    if(!ChessClass){try{await chessReady;}catch(_){api.showToast('Chess library failed to load.');return;}}
    const game=getState().importedGames[Number(index)];
    if(!game?.pgn){api.showToast('This row does not contain a replayable PGN. Import the move text first.');return;}
    try{
      const chess=new ChessClass();chess.loadPgn(game.pgn,{strict:false});
      const moves=chess.history({verbose:true});
      const report=game.engineReview?.mistakes||null,positionCache=new Map();
      for(const item of report||[])if(item.fen)positionCache.set(item.fen,{fen:item.fen,bestMove:item.bestMoveUci,pv:item.pv,candidates:item.candidates||[{multipv:1,bestMove:item.bestMoveUci,pv:item.pv}]});
      const initialFen=moves.length?moves[0].before:new ChessClass().fen();
      viewer={index:Number(index),game,moves,ply:0,positionAnalysis:positionCache.get(initialFen)||null,positionCache,moveVerdicts:game.engineReview?.moveVerdicts||[],report,analyzing:false,progressText:'',budgetMs:game.engineReview?.budgetMs||250,analysisBudget:game.engineReview?.budgetMs||null,truncated:false};
      renderGameViewer();
    }catch(error){api.showToast(`Could not replay this PGN: ${error?.message||'invalid move text'}`);}
  }
  function reportMarkup(gameViewer){
    if(gameViewer.analyzing)return `<div class="viewer-engine-card"><div class="viewer-engine-head"><strong>Full-game analysis</strong>${engineStatusMarkup()}</div><div id="game-analysis-progress" class="analysis-progress">${esc(gameViewer.progressText||'Preparing Stockfish…')}</div></div>`;
    if(!gameViewer.report)return '';
    const report=gameViewer.report;
    if(!report.length)return `<div class="viewer-engine-card"><div class="viewer-engine-head"><strong>Full-game review</strong><span class="source-badge">${gameViewer.analysisBudget||gameViewer.budgetMs||250} ms / position</span></div><p class="small-muted" style="margin:8px 0 0">No large evaluation drops were found in this quick scan. This is not a guarantee that every move is perfect.</p>${gameViewer.truncated?'<p class="small-muted">The scan was limited to the first 100 plies for speed.</p>':''}</div>`;
    return `<div class="viewer-engine-card"><div class="viewer-engine-head"><strong>Key moments · ${report.length}</strong><span class="source-badge">${gameViewer.analysisBudget||gameViewer.budgetMs||250} ms / position</span><button class="text-link" data-action="build-all-drills">Save high-impact drills →</button></div><div class="mistake-list">${report.map((item,index)=>`<div class="mistake-item"><span class="mistake-badge ${item.severity==='Inaccuracy'?'inaccuracy':''}">${esc(item.severity)}</span><div class="mistake-copy"><strong>${Math.ceil(item.ply/2)}.${item.ply%2?'':'…'} ${esc(item.move)} · −${pawnLoss(item.lossCp)}</strong><span>Engine choice ${esc(item.bestMoveSan||item.bestMoveUci||'—')} · ${esc(item.coach)}</span></div><button class="outline-button" data-action="build-drill" data-mistake-index="${index}">Make drill</button></div>`).join('')}</div>${gameViewer.truncated?'<p class="small-muted" style="margin:8px 0 0">Analysis was limited to the first 100 plies for speed.</p>':''}</div>`;
  }
  function renderGameViewerMarkup(){
    if(!viewer)return;
    const gameViewer=viewer;
    const fen=positionFenAt(gameViewer,gameViewer.ply);
    const currentMove=gameViewer.ply?gameViewer.moves[gameViewer.ply-1]:null;
    const result=gameViewer.positionAnalysis?`<div class="engine-score">${scoreSideLabel(gameViewer.positionAnalysis,fen)}</div><div class="engine-pv">${esc(sanLineFromUci(fen,gameViewer.positionAnalysis.pv||gameViewer.positionAnalysis.bestMove||''))||`Best move ${esc(gameViewer.positionAnalysis.bestMove||'—')}`}</div>`:`<div class="small-muted" style="margin-top:8px">Analyze this position to see an evaluation and best line.</div>`;
    const moveGrid=gameViewer.moves.length?`<div class="viewer-moves">${gameViewer.moves.map((move,index)=>`<div class="viewer-move-row"><span>${index%2===0?`${Math.floor(index/2)+1}.`:''}</span><button class="${gameViewer.ply===index+1?'current':''}" data-view-ply="${index+1}">${esc(move.san)}</button>${index%2===1?'<span></span>':''}</div>`).join('')}</div>`:'<p class="small-muted">No moves were found in this PGN.</p>';
    $('#modal-root').innerHTML=`<div class="modal-backdrop" data-action="backdrop-close"><section class="modal-panel modal-wide" role="dialog" aria-modal="true" aria-labelledby="viewer-title"><div class="modal-head"><div><div class="eyebrow">${esc(gameViewer.game.opening||'GAME REPLAY')} · LOCAL ENGINE REVIEW</div><h2 id="viewer-title">${esc(gameViewer.game.white)} <span style="color:#98a295">vs</span> ${esc(gameViewer.game.black)}</h2><p>${esc(gameViewer.game.date||'Date not set')} · ${gameViewer.moves.length} half-moves · result ${esc(gameViewer.game.result||'—')}</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Close">×</button></div><div class="viewer-layout"><div class="viewer-board-column"><div class="drill-board">${boardMarkup(fen,{orientation:'w',lastMove:currentMove})}</div><div class="viewer-controls"><button data-action="viewer-first" aria-label="First position">|◀</button><button data-action="viewer-prev" aria-label="Previous move">◀</button><span>${gameViewer.ply===0?'Start':`${Math.ceil(gameViewer.ply/2)}.${gameViewer.ply%2?'…':' white'}`} / ${gameViewer.moves.length}</span><button data-action="viewer-next" aria-label="Next move">▶</button><button data-action="viewer-last" aria-label="Last position">▶|</button></div></div><div><div class="viewer-engine-card"><div class="viewer-engine-head"><strong>Position analysis</strong>${engineStatusMarkup()}</div>${result}<div class="analysis-actions"><label class="small-muted">Full-game budget <select class="depth-select" id="analysis-depth"><option value="120" ${gameViewer.budgetMs===120?'selected':''}>Quick · 120 ms</option><option value="250" ${gameViewer.budgetMs===250?'selected':''}>Standard · 250 ms</option><option value="500" ${gameViewer.budgetMs===500?'selected':''}>Deep · 500 ms</option></select></label><button class="primary-button" data-action="analyze-position" ${gameViewer.analyzing?'disabled':''}>Analyze position</button><button class="outline-button" data-action="analyze-game" ${gameViewer.analyzing?'disabled':''}>Analyze full game</button></div><div id="analysis-progress" class="analysis-progress">${esc(gameViewer.progressText||'Engine analysis stays local in your browser.')}</div></div>${reportMarkup(gameViewer)}<div class="panel-head" style="margin:15px 0 7px"><div><h3>Moves</h3><p>Tap any move to replay that position.</p></div></div>${moveGrid}<div class="analysis-actions" style="margin-top:10px"><button class="quiet-button" data-action="go-to-drills">Personal game drills (${getState().drills.length}) →</button></div></div></div></section></div>`;
  }
  function renderGameViewer(){
    renderGameViewerMarkup();
    if(!viewer)return;
    const gameViewer=viewer,fen=positionFenAt(gameViewer,gameViewer.ply);
    const info=gameViewer.positionCache.get(fen)||(gameViewer.positionAnalysis?.fen===fen?gameViewer.positionAnalysis:null);
    const options=engineCandidateMoves(info,fen);
    const board=$('#modal-root .viewer-board-column .chessboard');
    if(board){
      const arrows=reviewArrows(gameViewer,options);
      if(arrows.length){board.style.position='relative';board.insertAdjacentHTML('beforeend',arrowSvgMarkup(arrows));}
    }
    const card=$('#modal-root .viewer-board-column')?.nextElementSibling?.querySelector('.viewer-engine-card');
    if(card&&options.length){
      const summary=document.createElement('div');summary.className='engine-options small-muted';summary.style.cssText='margin-top:10px;display:grid;gap:5px';
      summary.innerHTML=`<strong>Stockfish options</strong>${options.map(option=>`<span>${option.multipv}. ${esc(option.san||option.bestMove)} · ${scoreSideLabel(option,fen)}</span>`).join('')}<span>Green: engine candidate or move within 0.70 pawns. Red: played move losing at least 0.70 pawns.</span>`;
      card.appendChild(summary);
    }
    $$('.mistake-copy').forEach((copy,index)=>{
      const button=document.createElement('button');button.type='button';button.className='text-link';button.dataset.action='show-mistake';button.dataset.mistakeIndex=String(index);button.textContent='Show on board';copy.appendChild(button);
    });
  }
  async function analyzeViewerPosition(){
    if(!viewer||viewer.analyzing)return;
    const session=viewer,fen=positionFenAt(session,session.ply),cached=session.positionCache.get(fen);
    if(cached){session.positionAnalysis=cached;session.progressText=`Cached Stockfish analysis · depth ${cached.depth}`;renderGameViewer();return;}
    session.analyzing=true;session.progressText='Loading Stockfish Lite…';renderGameViewer();
    try{
      const depth=13;
      const info=await engine.search(fen,{depth,skill:20,multipv:3,timeoutMs:60000,onInfo:(line)=>{if(viewer===session){session.progressText=`Searching position · depth ${line.depth||0}…`;const node=$('#analysis-progress');if(node)node.textContent=session.progressText;}}});
      info.fen=fen;session.positionCache.set(fen,info);
      if(viewer===session){session.positionAnalysis=info;session.progressText=`Finished at depth ${info.depth||depth}.`;}
    }catch(error){if(viewer===session)session.progressText=error?.message||'Position analysis failed.';}
    finally{if(viewer===session){session.analyzing=false;renderGameViewer();}}
  }
  async function analyzeViewerGame(){
    if(!viewer||viewer.analyzing)return;
    const session=viewer;
    const budgetMs=Number($('#analysis-depth')?.value||session.budgetMs||250);session.budgetMs=budgetMs;
    const total=Math.min(session.moves.length+1,100);
    session.analyzing=true;session.report=null;session.progressText='Loading Stockfish Lite…';session.analysisBudget=budgetMs;session.truncated=session.moves.length+1>total;renderGameViewer();
    try{
      await engine.init();
      const positions=[];
      for(let index=0;index<total;index++){
        if(viewer!==session)return;
        const fen=index===0?(session.moves[0]?.before||new ChessClass().fen()):session.moves[index-1].after;
        session.progressText=`Analyzing position ${index+1} of ${total} · ${budgetMs} ms budget`;
        const progress=$('#game-analysis-progress');if(progress)progress.textContent=session.progressText;
        const info=await engine.search(fen,{movetime:budgetMs,skill:20,multipv:3,timeoutMs:60000,onInfo:(line)=>{if(viewer===session&&index===total-1){const node=$('#game-analysis-progress');if(node)node.textContent=`Position ${index+1}/${total} · depth ${line.depth||0}`;}}});
        info.fen=fen;session.positionCache.set(fen,info);
        positions.push({fen,info,whiteScore:whiteScore(info,fen)});
      }
      const mistakes=[],moveVerdicts=[];
      const moveCount=Math.min(session.moves.length,positions.length-1);
      for(let index=0;index<moveCount;index++){
        const move=session.moves[index];
        const before=positions[index].whiteScore,after=positions[index+1].whiteScore;
        const lossCp=Math.max(0,Math.round(move.color==='w'?before-after:after-before));
        moveVerdicts.push({ply:index+1,lossCp});
        if(lossCp<70)continue;
        const bestMove=positions[index].info.bestMove;
        const bestMoveSan=sanLineFromUci(positions[index].fen,bestMove).split(' ')[0]||'—';
        const severity=lossCp>=300?'Blunder':lossCp>=150?'Mistake':'Inaccuracy';
        const coach=lossCp>=300?'Large evaluation swing; review this decision first.':lossCp>=150?'A meaningful opportunity was missed.':'A smaller improvement is available.';
        mistakes.push({ply:index+1,move:move.san,color:move.color,lossCp,severity,bestMoveUci:bestMove,bestMoveSan,fen:positions[index].fen,pv:positions[index].info.pv,candidates:positions[index].info.candidates||[],coach});
      }
      mistakes.sort((a,b)=>b.lossCp-a.lossCp);
      const limited=mistakes.slice(0,20);
      session.positions=positions;session.moveVerdicts=moveVerdicts;session.report=limited;session.analysisBudget=budgetMs;session.positionAnalysis=session.positionCache.get(positionFenAt(session,session.ply))||null;session.progressText=`Complete · ${positions.length} positions reviewed.`;
      const state=getState();const stored=state.importedGames[session.index];
      if(stored)stored.engineReview={budgetMs,analyzedAt:new Date().toISOString(),mistakes:limited,moveVerdicts};
      api.persist();
    }catch(error){session.progressText=error?.message||'Full-game analysis failed.';session.report=null;}
    finally{if(viewer===session){session.analyzing=false;renderGameViewer();}}
  }
  function buildDrillFromMistake(index,quiet=false){
    if(!viewer?.report)return false;
    const item=viewer.report[Number(index)];if(!item?.fen||!item.bestMoveUci||item.bestMoveUci==='0000'){if(!quiet)api.showToast('No training move was available for this position.');return false;}
    if(!Array.isArray(getState().drills))getState().drills=[];
    const exists=getState().drills.some(drill=>drill.sourceGame===viewer.game.id&&drill.sourcePly===item.ply);
    if(exists){if(!quiet)api.showToast('A drill for this move is already saved.');return false;}
    const position=new ChessClass(item.fen);let best;
    try{best=position.move(uciMove(item.bestMoveUci));}catch(_){best=null;}
    if(!best){if(!quiet)api.showToast('Could not validate the engine’s suggested move.');return false;}
    const drill={id:`drill-${Date.now()}-${Math.random().toString(16).slice(2,6)}`,fen:item.fen,bestMoveUci:item.bestMoveUci,bestMoveSan:best.san,sourceGame:viewer.game.id,sourcePlayers:`${viewer.game.white} vs ${viewer.game.black}`,sourceOpening:viewer.game.opening||'Game review',sourcePly:item.ply,originalMove:item.move,lossCp:item.lossCp,severity:item.severity,pv:item.pv||'',coach:item.coach,createdAt:new Date().toISOString(),completed:0};
    getState().drills.unshift(drill);if(!quiet){api.persist();api.showToast('Personal game puzzle saved to your training library.');}return true;
  }
  function buildAllDrills(){
    if(!viewer?.report)return;
    let count=0;for(let i=0;i<viewer.report.length;i++)if(buildDrillFromMistake(i,true))count++;
    api.persist();api.showToast(`${count} new game drill${count===1?'':'s'} saved.`);
  }
  function renderDrillsPage(){
    if(!ChessClass)return `<div class="page-heading"><div><p class="eyebrow">PERSONALIZED FROM YOUR OWN GAMES</p><h1>Game-derived drills</h1><p class="page-subtitle">${esc(chessLoadError||'Loading chess rules…')}</p></div></div>`;
    const drills=getState().drills;
    return `<div class="page-heading"><div><p class="eyebrow">YOUR MISTAKES → YOUR PRACTICE</p><h1>Game-derived drills</h1><p class="page-subtitle">Positions from your imported games, turned into legal “find the best move” puzzles using local Stockfish analysis.</p></div><button class="outline-button" data-page="games">Review a game →</button></div><div class="info-strip"><span class="info-icon">✦</span><div><strong>${drills.length} saved position${drills.length===1?'':'s'} · no limits.</strong>Analyze a PGN in Game Review, then save the engine’s best move as a repeatable personal drill. The engine line is a suggestion at the analysis depth shown.</div></div>${drills.length?`<div class="personal-drill-grid">${drills.map((drill,index)=>`<article class="card personal-drill-card"><div class="drill-meta">${esc(drill.severity||'PERSONAL DRILL')} · ${esc(drill.sourceOpening||'Your game')}</div><h3>${esc(drill.sourcePlayers||'Imported game')}</h3><p>At move ${Math.ceil((drill.sourcePly||1)/2)}, you played <strong>${esc(drill.originalMove||'—')}</strong>. Try the engine’s candidate in the original position.</p><div class="drill-footer"><span class="sample-tag">${drill.completed?`REPEATED ${drill.completed}×`:'NOT YET SOLVED'}</span><button class="primary-button" data-action="start-drill" data-index="${index}">Solve puzzle →</button></div></article>`).join('')}</div>`:`<div class="card empty-state" style="margin-top:15px"><div class="empty-icon">♞</div><strong>No game drills yet</strong><p>Import or sync games, open a game, run a full Stockfish review, and save a key moment as a puzzle. The first game-derived positions will appear here.</p><button class="primary-button" data-page="games">Go to game review</button></div>`}`;
  }
  async function startDrill(index){
    if(!ChessClass){try{await chessReady;}catch(_){api.showToast('Chess rules library is unavailable.');return;}}
    const drill=getState().drills[Number(index)];if(!drill)return;
    try{activeDrill={index:Number(index),data:drill,chess:new ChessClass(drill.fen),selected:'',targets:[],solved:false,message:'Find the best move for the side to move.',playedSan:'',mistakes:0};renderDrillModal();}
    catch(error){api.showToast(`This saved position could not be loaded: ${error.message}`);}
  }
  function renderDrillModal(){
    if(!activeDrill)return;
    const current=activeDrill;
    const side=current.chess.turn()==='w'?'White':'Black';
    const history=current.chess.history({verbose:true});
    const last=history.length?history[history.length-1]:null;
    const body=current.solved?`<div class="activity-complete"><div class="complete-mark">✓</div><h3>Good find.</h3><p>${esc(current.data.bestMoveSan)} is the engine’s top move at the saved search depth. ${esc(current.data.coach||'Review the position and compare the move with your original decision.')}</p><div class="engine-pv">${esc(sanLineFromUci(current.data.fen,current.data.pv||current.data.bestMoveUci))}</div><button class="primary-button" data-action="finish-personal-drill">Save this practice <span class="button-arrow">→</span></button></div>`:`<div class="board-area drill-board">${boardMarkup(current.chess.fen(),{orientation:current.chess.turn(),interactive:'drill',selected:current.selected,targets:current.targets,lastMove:last})}</div><div class="board-help"><span>${side} to move</span><span>Select a piece, then its destination</span></div>${current.message?`<div class="feedback-box ${current.message.startsWith('Correct')?'success':'retry'}">${esc(current.message)}</div>`:''}`;
    $('#modal-root').innerHTML=`<div class="modal-backdrop" data-action="backdrop-close"><section class="modal-panel modal-wide" role="dialog" aria-modal="true" aria-labelledby="personal-drill-title"><div class="modal-head"><div><div class="eyebrow">FROM ${esc(current.data.sourceOpening||'YOUR GAME')} · MOVE ${Math.ceil((current.data.sourcePly||1)/2)}</div><h2 id="personal-drill-title" class="activity-title">Find a better move</h2><p class="activity-instruction">You played ${esc(current.data.originalMove||'a different move')} in this position. Find the engine’s candidate without looking at the answer.</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Close">×</button></div><div class="activity-shell"><div class="activity-main">${body}<div class="activity-footer"><span>✦ From your PGN · Stockfish verified</span>${current.solved?'':`<button class="quiet-button" data-action="drill-hint">Show hint</button>`}</div></div><aside class="activity-aside"><p class="eyebrow">WHY THIS ONE?</p><h3>${esc(current.data.severity||'Key moment')} · −${pawnLoss(current.data.lossCp||0)}</h3><p>${esc(current.data.coach||'Compare your move to the engine’s top line and save the lesson.')}</p><p style="margin-top:10px;border-top:1px solid #e7ebe1;padding-top:9px">Engine: Stockfish Lite · local analysis. A single engine line can miss human factors; use it as a review prompt.</p></aside></div></section></div>`;
  }
  function handleDrillSquare(square){
    const current=activeDrill;if(!current||current.solved)return;
    const chess=current.chess,piece=chess.get(square);
    if(!current.selected){
      if(piece&&piece.color===chess.turn()){
        const legal=chess.moves({square,verbose:true});
        if(!legal.length){current.message='That piece has no legal moves in this position.';current.selected='';current.targets=[];}
        else{current.selected=square;current.targets=legal.map(move=>({to:move.to,capture:Boolean(move.captured)}));current.message='Choose one of the legal destinations.';}
      }else{current.message=`Select a ${chess.turn()==='w'?'white':'black'} piece.`;}
      renderDrillModal();return;
    }
    const legal=chess.moves({square:current.selected,verbose:true});
    const candidate=legal.find(move=>move.to===square);
    if(candidate){
      const chosenUci=moveToUci(candidate),expected=current.data.bestMoveUci;
      if(chosenUci===expected){const played=chess.move({from:candidate.from,to:candidate.to,...(candidate.promotion?{promotion:candidate.promotion}:{})});current.solved=true;current.playedSan=played?.san||candidate.san;current.message=`Correct — ${current.playedSan}.`;}
      else{current.mistakes=(Number(current.mistakes)||0)+1;current.selected='';current.targets=[];current.message='Legal move, but not the saved best move. Look for a more forcing or active candidate.';}
    }else if(piece&&piece.color===chess.turn()){
      const possible=chess.moves({square,verbose:true});current.selected=possible.length?square:'';current.targets=possible.map(move=>({to:move.to,capture:Boolean(move.captured)}));current.message=possible.length?'Piece selected. Choose a highlighted square.':'That piece has no legal moves.';
    }else{current.mistakes=(Number(current.mistakes)||0)+1;current.selected='';current.targets=[];current.message='That is not a legal destination.';}
    renderDrillModal();
  }
  function finishPersonalDrill(){
    if(!activeDrill)return;
    const state=getState();api.clearIllustrativeData();
    const trainingDate=api.recordTrainingScore(Math.round(100/(1+(Number(activeDrill.mistakes)||0))));
    state.progress.sessions=(Number(state.progress.sessions)||0)+1;
    state.progress.puzzles=(Number(state.progress.puzzles)||0)+1;
    state.progress.minutes=(Number(state.progress.minutes)||0)+4;
    state.progress.activity=Array.isArray(state.progress.activity)?state.progress.activity:[];
    state.progress.activity.unshift({module:'game-derived-drill',date:trainingDate,minutes:4});
    const drill=state.drills[activeDrill.index];if(drill)drill.completed=(Number(drill.completed)||0)+1;
    api.persist();activeDrill=null;$('#modal-root').innerHTML='';api.render();api.showToast('Game-derived drill logged.');
  }

  function focusKeyFromProfile(value){
    const focus=String(value||'').toLowerCase();
    if(focus.includes('endgame'))return 'endgame';
    if(focus.includes('opening'))return 'opening';
    if(focus.includes('clock'))return 'clock';
    if(focus.includes('defen'))return 'defense';
    if(focus.includes('position'))return 'positional';
    return 'tactics';
  }
  function openGuidedSessionBuilder(){
    activeSession=null;
    const state=getState(),drills=(Array.isArray(state.drills)?state.drills:[]).filter(item=>item.fen&&item.bestMoveUci&&item.bestMoveUci!=='0000');
    const suggestedFocus=focusKeyFromProfile(state.profile?.focus);
    $('#modal-root').innerHTML=`<div class="modal-backdrop" data-action="backdrop-close"><section class="modal-panel session-modal" role="dialog" aria-modal="true" aria-labelledby="session-builder-title"><div class="modal-head"><div><div class="eyebrow">YOUR GAMES · YOUR FOCUS · YOUR PACE</div><h2 id="session-builder-title">Build a focused session</h2><p>A guided set of legal board puzzles and short decision reps—not a single demo question.</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Close">×</button></div><div class="session-builder-grid"><div class="form-field"><label for="guided-focus">What do you want to train?</label><select id="guided-focus"><option value="tactics" ${suggestedFocus==='tactics'?'selected':''}>Tactics and calculation</option><option value="endgame" ${suggestedFocus==='endgame'?'selected':''}>Endgame technique</option><option value="opening" ${suggestedFocus==='opening'?'selected':''}>Opening decisions</option><option value="clock" ${suggestedFocus==='clock'?'selected':''}>Clock and decision habits</option><option value="defense" ${suggestedFocus==='defense'?'selected':''}>Defensive resourcefulness</option><option value="positional" ${suggestedFocus==='positional'?'selected':''}>Positional understanding</option></select></div><div class="form-field"><label for="guided-length">Session length</label><select id="guided-length"><option value="10">10 minutes · 3 rounds</option><option value="15" selected>15 minutes · 4 rounds</option><option value="20">20 minutes · 5 rounds</option></select></div></div><div class="session-plan-preview"><div class="session-plan-icon">♞</div><div><strong>${drills.length?`${drills.length} game-derived position${drills.length===1?'':'s'} ready for your plan`:'A balanced practice set is ready'}</strong><span>${drills.length?'Your least-practiced, high-impact positions will be woven into the session.':'Built-in board puzzles adapt to your recent session accuracy.'}</span></div></div>${drills.length?`<label class="session-toggle"><input id="guided-use-games" type="checkbox" checked><span>Include positions saved from my games</span></label>`:`<div class="session-builder-note">For a more personal plan, import games, run a Stockfish review, and save a few moments as drills. Your first session can start now.</div>`}<div class="session-builder-steps"><div><b>01</b><span>Warm up on a real board</span></div><div><b>02</b><span>Practice your chosen focus</span></div><div><b>03</b><span>Review your result and log it</span></div></div><div class="modal-actions"><button class="quiet-button" data-action="close-modal">Not now</button><button class="primary-button" data-action="guided-session-start">Start my session <span class="button-arrow">→</span></button></div></section></div>`;
  }
  function buildSessionRounds(focus,length,useGames){
    const state=getState(),count=length===10?3:length===20?5:4;
    const rounds=[],drills=useGames?(Array.isArray(state.drills)?state.drills:[]).filter(item=>item.fen&&item.bestMoveUci&&item.bestMoveUci!=='0000').sort((a,b)=>(Number(a.completed)||0)-(Number(b.completed)||0)||(Number(b.lossCp)||0)-(Number(a.lossCp)||0)):[];
    const recent=(Array.isArray(state.progress.activity)?state.progress.activity:[]).filter(item=>item.module==='guided-session'&&Number.isFinite(Number(item.accuracy))).slice(0,3);
    const avg=recent.length?recent.reduce((sum,item)=>sum+Number(item.accuracy),0)/recent.length:null;
    const order=avg!==null&&avg<60?['fork-c4-e5','loose-queen','mate-in-one','promotion-check']:avg!==null&&avg>85?['promotion-check','mate-in-one','loose-queen','fork-c4-e5']:['fork-c4-e5','loose-queen','promotion-check','mate-in-one'];
    const puzzleById=new Map(sessionPuzzleBank.map(item=>[item.id,item]));
    const pushPuzzle=id=>{const p=puzzleById.get(id);if(p&&!rounds.some(round=>round.id===p.id))rounds.push({type:'board',...p,source:'SQUAREWISE PUZZLE',mistakes:0,hinted:false,selected:'',targets:[],solved:false,message:''});};
    const focusQuestion=focusQuestionBank[focus]||focusQuestionBank.tactics;
    const questionRound={type:'choice',id:`focus-${focus}`,source:'FOCUS REP',stage:'YOUR FOCUS',title:focusQuestion.title,subtitle:focusQuestion.prompt,options:focusQuestion.options,correct:focusQuestion.correct,explanation:focusQuestion.explanation,mistakes:0,hinted:false,solved:false,message:''};
    // Start with a personal position when available; otherwise begin with a curated warm-up.
    if(drills.length&&rounds.length<count){
      const drill=drills.shift();
      rounds.push({type:'board',id:`personal-${drill.id}`,source:'FROM YOUR GAME',stage:'YOUR GAME PATTERN',title:`Revisit a ${String(drill.severity||'key').toLowerCase()} moment`,subtitle:`${drill.sourcePlayers||'Your imported game'} · move ${Math.ceil((Number(drill.sourcePly)||1)/2)}. Find the stronger move.`,fen:drill.fen,bestMoveUci:String(drill.bestMoveUci).toLowerCase(),bestMoveSan:drill.bestMoveSan||uciMove(drill.bestMoveUci)?.from+'–'+uciMove(drill.bestMoveUci)?.to,hint:`Look for a forcing move. Your saved engine candidate is ${drill.bestMoveSan||drill.bestMoveUci}.`,explanation:drill.coach||'Compare the engine candidate with your original move and look for the idea that makes it work.',sourceDrillId:drill.id,mistakes:0,hinted:false,selected:'',targets:[],solved:false,message:''});
    }else pushPuzzle(order[0]);
    if(rounds.length<count)rounds.push(questionRound);
    let puzzleIndex=rounds.some(round=>round.id==='fork-c4-e5')?1:0;
    while(rounds.length<count){
      if(drills.length&&rounds.filter(round=>round.sourceDrillId).length<Math.min(2,Math.floor(count/2))){
        const drill=drills.shift();
        rounds.push({type:'board',id:`personal-${drill.id}`,source:'FROM YOUR GAME',stage:'YOUR GAME PATTERN',title:`Review another ${String(drill.severity||'key').toLowerCase()} moment`,subtitle:`${drill.sourcePlayers||'Your imported game'} · move ${Math.ceil((Number(drill.sourcePly)||1)/2)}. Find the stronger move.`,fen:drill.fen,bestMoveUci:String(drill.bestMoveUci).toLowerCase(),bestMoveSan:drill.bestMoveSan||drill.bestMoveUci,hint:`Scan checks, captures, and threats before choosing. Engine candidate: ${drill.bestMoveSan||drill.bestMoveUci}.`,explanation:drill.coach||'Compare the candidate with your original decision and name the key tactical or positional idea.',sourceDrillId:drill.id,mistakes:0,hinted:false,selected:'',targets:[],solved:false,message:''});
      }else{
        const id=order[puzzleIndex%order.length];puzzleIndex++;if(rounds.some(round=>round.id===id)){if(puzzleIndex>order.length+2)break;continue;}pushPuzzle(id);
      }
    }
    return rounds.slice(0,count);
  }
  async function startGuidedSession(){
    if(!ChessClass){try{await chessReady;}catch(_){api.showToast('Chess rules are unavailable. Try the live server preview and reload.');return;}}
    const focus=$('#guided-focus')?.value||focusKeyFromProfile(getState().profile?.focus);
    const length=Number($('#guided-length')?.value)||15;
    const useGames=Boolean($('#guided-use-games')?.checked);
    const rounds=buildSessionRounds(focus,length,useGames);
    try{
      for(const round of rounds)if(round.type==='board')round.chess=new ChessClass(round.fen);
      activeSession={focus,length,rounds,index:0,startedAt:Date.now(),mistakes:0,solved:0,firstTry:0,completedDrills:[],finished:false};
      renderGuidedSession();
    }catch(error){api.showToast(`Could not prepare this session: ${error.message}`);}
  }
  function completeSessionRound(round){
    if(round.solved)return;
    round.solved=true;round.firstTry=round.mistakes===0&&!round.hinted;
    activeSession.solved++;
    if(round.firstTry)activeSession.firstTry++;
    if(round.sourceDrillId)activeSession.completedDrills.push(round.sourceDrillId);
  }
  function renderGuidedSession(){
    if(!activeSession)return;
    if(activeSession.finished){renderGuidedSessionResults();return;}
    const session=activeSession,round=session.rounds[session.index],number=session.index+1,total=session.rounds.length;
    const percent=Math.round((session.index/total)*100);
    let task='';
    if(round.type==='board'){
      const history=round.chess.history({verbose:true}),last=history[history.length-1]||null;
      const side=round.chess.turn()==='w'?'White':'Black';
      task=`<div class="session-board-wrap">${boardMarkup(round.chess.fen(),{orientation:round.chess.turn(),interactive:'session',selected:round.selected,targets:round.targets,lastMove:last})}<div class="board-help"><span>${side} to move</span><span>Select a piece, then its destination</span></div></div>`;
    }else{
      task=`<div class="session-choice-list">${round.options.map((option,index)=>`<button class="session-choice ${round.solved&&option[0]===round.correct?'correct':''}" data-action="guided-session-answer" data-answer="${esc(option[0])}" ${round.solved?'disabled':''}><span class="session-choice-letter">${String.fromCharCode(65+index)}</span><span>${esc(option[1])}</span></button>`).join('')}</div>`;
    }
    const feedback=round.message?`<div class="session-feedback ${round.solved?'success':'retry'}">${esc(round.message)}</div>`:'';
    const controls=round.solved?`<div class="session-round-footer"><span>${round.firstTry?'First-try solve · excellent focus':'Solved · keep the lesson'}</span><button class="primary-button" data-action="guided-session-next">${number===total?'See my session results':'Next exercise'} <span class="button-arrow">→</span></button></div>`:`<div class="session-round-footer"><span>${round.mistakes?`${round.mistakes} attempt${round.mistakes===1?'':'s'} · take a breath and recalculate`:'No rush · calculate before you move'}</span><button class="quiet-button" data-action="guided-session-hint">Need a hint?</button></div>`;
    $('#modal-root').innerHTML=`<div class="modal-backdrop" data-action="backdrop-close"><section class="modal-panel modal-wide session-modal session-active" role="dialog" aria-modal="true" aria-labelledby="guided-session-title"><div class="modal-head"><div><div class="eyebrow">ROUND ${String(number).padStart(2,'0')} OF ${String(total).padStart(2,'0')} · ${esc(round.stage||round.source||'FOCUSED PRACTICE')}</div><h2 id="guided-session-title">${esc(round.title)}</h2><p>${esc(round.subtitle||'Look for the move that best fits the position.')}</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Exit session">×</button></div><div class="session-progress"><span style="width:${percent}%"></span></div><div class="session-meta-row"><span>${esc(session.focus.replace(/-/g,' '))} focus</span><span>${session.length} min plan · ${session.rounds.filter(item=>item.sourceDrillId).length} personal game drill${session.rounds.filter(item=>item.sourceDrillId).length===1?'':'s'}</span></div>${task}${feedback}${controls}</section></div>`;
  }
  function renderGuidedSessionResults(){
    const session=activeSession,rounds=session.rounds.length,accuracy=Math.round((session.firstTry/rounds)*100),minutes=Math.max(1,Math.round((Date.now()-session.startedAt)/60000));
    const missed=rounds-session.firstTry;
    $('#modal-root').innerHTML=`<div class="modal-backdrop"><section class="modal-panel session-modal" role="dialog" aria-modal="true" aria-labelledby="guided-results-title"><div class="modal-head"><div><div class="eyebrow">SESSION COMPLETE · ${esc(session.focus.toUpperCase())}</div><h2 id="guided-results-title">Good work. Review what you learned.</h2><p>Your results are saved to your local training log.${window.SquarewiseCloud?.isSignedIn?.()?' Your account will sync the session automatically.':''}</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Close results">×</button></div><div class="session-result-grid"><div><strong>${session.firstTry}/${rounds}</strong><span>first-try solves</span></div><div><strong>${accuracy}%</strong><span>first-try rate</span></div><div><strong>${minutes}m</strong><span>time invested</span></div><div><strong>${session.mistakes}</strong><span>recalculation reps</span></div></div><div class="session-review-card"><div class="eyebrow">NEXT PRACTICE PROMPT</div><strong>${missed?'Slow down before the move; name your opponent’s best reply.':'Keep the same calculation routine in your next game.'}</strong><p>${session.completedDrills.length?`${session.completedDrills.length} position${session.completedDrills.length===1?'':'s'} from your games revisited.`:'Save a game-derived drill after reviewing a PGN to make the next session more personal.'}</p></div><div class="modal-actions"><button class="quiet-button" data-action="close-modal">Close</button><button class="primary-button" data-action="start-session">Train another focus <span class="button-arrow">→</span></button></div></section></div>`;
  }
  function handleSessionSquare(square){
    const session=activeSession;if(!session||session.finished)return;
    const round=session.rounds[session.index];if(!round||round.type!=='board'||round.solved)return;
    const chess=round.chess,piece=chess.get(square);
    if(!round.selected){
      if(piece&&piece.color===chess.turn()){
        const legal=chess.moves({square,verbose:true});
        if(legal.length){round.selected=square;round.targets=legal.map(move=>({to:move.to,capture:Boolean(move.captured)}));round.message='Choose a legal destination, then check the opponent’s reply.';}
        else round.message='That piece has no legal moves in this position.';
      }else round.message=`Select a ${chess.turn()==='w'?'white':'black'} piece.`;
      renderGuidedSession();return;
    }
    const legal=chess.moves({square:round.selected,verbose:true});
    const expected=String(round.bestMoveUci||'').toLowerCase();
    const matching=legal.filter(move=>move.to===square);
    const candidate=matching.find(move=>moveToUci(move).toLowerCase()===expected)||matching[0];
    if(candidate){
      const chosen=moveToUci(candidate).toLowerCase();
      if(chosen===expected){
        const played=chess.move({from:candidate.from,to:candidate.to,...(candidate.promotion?{promotion:candidate.promotion}:{})});
        round.playedSan=played?.san||candidate.san;round.message=round.explanation||`Correct — ${round.playedSan}.`;round.selected='';round.targets=[];completeSessionRound(round);
      }else{
        round.mistakes++;session.mistakes++;round.selected='';round.targets=[];
        round.message='That move is legal, but it misses the key idea. Check forcing moves and the opponent’s best reply.';
      }
    }else if(piece&&piece.color===chess.turn()){
      const options=chess.moves({square,verbose:true});round.selected=options.length?square:'';round.targets=options.map(move=>({to:move.to,capture:Boolean(move.captured)}));round.message=options.length?'Piece selected. Choose a highlighted square.':'That piece has no legal moves.';
    }else{
      round.mistakes++;session.mistakes++;round.selected='';round.targets=[];round.message='That is not a legal destination. Reset your candidate and calculate again.';
    }
    renderGuidedSession();
  }
  function answerSessionQuestion(answer){
    const session=activeSession;if(!session||session.finished)return;
    const round=session.rounds[session.index];if(!round||round.type!=='choice'||round.solved)return;
    if(answer===round.correct){round.message=round.explanation;completeSessionRound(round);}
    else{round.mistakes++;session.mistakes++;round.message='Not quite. Recheck the position’s priority and try again.';}
    renderGuidedSession();
  }
  function hintSessionRound(){
    if(!activeSession||activeSession.finished)return;
    const round=activeSession.rounds[activeSession.index];if(!round||round.solved)return;
    round.hinted=true;round.message=round.hint||'Pause and look for forcing moves before choosing.';renderGuidedSession();
  }
  function nextSessionRound(){
    if(!activeSession)return;
    const round=activeSession.rounds[activeSession.index];if(!round?.solved)return;
    if(activeSession.index>=activeSession.rounds.length-1){finishGuidedSession();return;}
    activeSession.index++;renderGuidedSession();
  }
  function finishGuidedSession(){
    if(!activeSession||activeSession.finished)return;
    const session=activeSession,state=getState();
    const total=session.rounds.length,accuracy=Math.round((session.firstTry/total)*100),minutes=Math.max(1,Math.round((Date.now()-session.startedAt)/60000));
    api.clearIllustrativeData();
    const trainingDate=api.recordTrainingScore(accuracy);
    state.progress.sessions=(Number(state.progress.sessions)||0)+1;
    state.progress.puzzles=(Number(state.progress.puzzles)||0)+session.rounds.filter(round=>round.type==='board').length;
    state.progress.minutes=(Number(state.progress.minutes)||0)+minutes;
    state.progress.completedToday=(Number(state.progress.completedToday)||0)+1;
    state.progress.activity=Array.isArray(state.progress.activity)?state.progress.activity:[];
    state.progress.activity.unshift({module:'guided-session',date:trainingDate,minutes,accuracy,firstTry:session.firstTry,rounds:total,focus:session.focus,mistakes:session.mistakes});
    if(session.focus==='tactics')state.tasks.tactics=true;
    if(session.focus==='endgame')state.tasks.endgame=true;
    if(session.rounds.some(round=>round.sourceDrillId))state.tasks.review=true;
    for(const drillId of session.completedDrills){const drill=state.drills.find(item=>item.id===drillId);if(drill)drill.completed=(Number(drill.completed)||0)+1;}
    session.finished=true;api.persist();api.render();renderGuidedSessionResults();api.showToast('Guided training session saved.');
  }

  const extra={
    pages:{play:renderPlayPage,drills:renderDrillsPage},
    pageNames:{play:'PLAY VS ENGINE',drills:'GAME-DERIVED DRILLS'},
    openModule(id){
      if(id==='guided-session'){openGuidedSessionBuilder();return true;}
      if(id==='engine-play'){api.setPage('play');return true;}
      if(id==='game-puzzles'){
        if(getState().drills.length)api.setPage('drills');
        else{api.setPage('games');api.showToast('Analyze a game and save a position to create your first personal drill.');}
        return true;
      }
      return false;
    },
    openImportModal,
    handleAction(action,element){
      switch(action){
        case 'guided-session-start':startGuidedSession();break;
        case 'guided-session-next':nextSessionRound();break;
        case 'guided-session-hint':hintSessionRound();break;
        case 'guided-session-answer':answerSessionQuestion(element.dataset.answer);break;
        case 'import-tab':setImportTab(element.dataset.tab);break;
        case 'import-pgn-submit':importPgnFromModal();break;
        case 'sync-chesscom':if($('#chesscom-user'))syncAccount('chess.com');else openImportModal({tab:'chesscom'});break;
        case 'sync-lichess':if($('#lichess-user'))syncAccount('lichess');else openImportModal({tab:'lichess'});break;
        case 'new-engine-game':setNewEngineGame();break;
        case 'engine-hint':askEngineHint();break;
        case 'engine-undo':undoEngineTurn();break;
        case 'engine-resign':if(playGame&&!playGame.chess.isGameOver()){playGame.resigned=true;playGame.message='Game resigned. Save the PGN or start a new game.';api.render();}break;
        case 'save-engine-game':saveEngineGame();break;
        case 'download-engine-pgn':if(playGame)downloadText('squarewise-engine-game.pgn',engineGamePgn(playGame),'application/x-chess-pgn');break;
        case 'view-game':openGameViewer(element.dataset.index);break;
        case 'viewer-first':if(viewer){viewer.ply=0;viewer.positionAnalysis=null;renderGameViewer();}break;
        case 'viewer-prev':if(viewer){viewer.ply=Math.max(0,viewer.ply-1);viewer.positionAnalysis=viewer.positionCache.get(positionFenAt(viewer,viewer.ply))||null;renderGameViewer();}break;
        case 'viewer-next':if(viewer){viewer.ply=Math.min(viewer.moves.length,viewer.ply+1);viewer.positionAnalysis=viewer.positionCache.get(positionFenAt(viewer,viewer.ply))||null;renderGameViewer();}break;
        case 'viewer-last':if(viewer){viewer.ply=viewer.moves.length;viewer.positionAnalysis=viewer.positionCache.get(positionFenAt(viewer,viewer.ply))||null;renderGameViewer();}break;
        case 'analyze-position':analyzeViewerPosition();break;
        case 'analyze-game':analyzeViewerGame();break;
        case 'show-mistake':{
          const item=viewer?.report?.[Number(element.dataset.mistakeIndex)];
          if(item){viewer.ply=Math.max(0,item.ply-1);viewer.positionAnalysis=viewer.positionCache.get(item.fen)||null;renderGameViewer();}
          break;
        }
        case 'build-drill':buildDrillFromMistake(element.dataset.mistakeIndex);break;
        case 'build-all-drills':buildAllDrills();break;
        case 'go-to-drills':$('#modal-root').innerHTML='';viewer=null;api.setPage('drills');break;
        case 'start-drill':startDrill(element.dataset.index);break;
        case 'drill-hint':if(activeDrill){activeDrill.message=`Hint: engine candidate ${activeDrill.data.bestMoveSan}.`;renderDrillModal();}break;
        case 'finish-personal-drill':finishPersonalDrill();break;
        default:break;
      }
    }
  };
  window.SquarewiseExtras=extra;

  document.addEventListener('click',(event)=>{
    const close=event.target.closest?.('[data-action="close-modal"]');
    if(close){viewer=null;activeDrill=null;activeSession=null;return;}
    if(event.target.classList?.contains('modal-backdrop')){viewer=null;activeDrill=null;activeSession=null;return;}
    const movePly=event.target.closest?.('[data-view-ply]');
    if(movePly&&viewer){viewer.ply=Math.max(0,Math.min(viewer.moves.length,Number(movePly.dataset.viewPly)||0));viewer.positionAnalysis=viewer.positionCache.get(positionFenAt(viewer,viewer.ply))||null;renderGameViewer();return;}
    const playSquare=event.target.closest?.('[data-play-square]');
    if(playSquare){handlePlaySquare(playSquare.dataset.playSquare);return;}
    const sessionSquare=event.target.closest?.('[data-session-square]');
    if(sessionSquare){handleSessionSquare(sessionSquare.dataset.sessionSquare);return;}
    const drillSquare=event.target.closest?.('[data-drill-square]');
    if(drillSquare){handleDrillSquare(drillSquare.dataset.drillSquare);return;}
  });
  document.addEventListener('change',(event)=>{
    if(event.target.id==='analysis-depth'&&viewer)viewer.budgetMs=Number(event.target.value)||250;
    if(event.target.id==='engine-skill'&&playGame)playGame.skill=Number(event.target.value)||0;
  });

  // The extra code is loaded after the first dashboard render. Re-render only when the user is on an added page.
  if(getState().page==='play'||getState().page==='drills')api.render();
})();

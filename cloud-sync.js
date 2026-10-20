(() => {
  'use strict';
  const api=window.SquarewiseAPI;
  if(!api){console.error('Squarewise core was not loaded before cloud-sync.js.');return;}

  const CONFIG_KEY='squarewise-supabase-config-v1';
  const SESSION_KEY='squarewise-supabase-session-v1';
  const META_KEY='squarewise-cloud-sync-meta-v1';
  const LOCAL_STATE_KEY='squarewise-personal-v1';
  const TABLE='squarewise_data';
  const $=(selector,root=document)=>root.querySelector(selector);
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const readJson=(key,fallback=null)=>{try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch(_){return fallback;}};
  const writeJson=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));return true;}catch(_){return false;}};
  let config=readJson(CONFIG_KEY,{url:'',anonKey:''})||{url:'',anonKey:''};
  let session=readJson(SESSION_KEY,null);
  let meta=readJson(META_KEY,{userId:'',dirty:false,lastSyncedAt:''})||{userId:'',dirty:false,lastSyncedAt:''};
  let authMode='signin',showConfig=false,busy=false,notice='',noticeType='',syncTimer=0,syncPromise=null,revision=0;
  let applyingRemote=false,conflictPending=false,pendingRemote=null;

  function normalizedUrl(value){return String(value||'').trim().replace(/\/+$/,'');}
  function configured(){return Boolean(config?.url&&config?.anonKey);}
  function saveMeta(next){meta={...meta,...next};writeJson(META_KEY,meta);refreshIndicator();}
  function localStateSaved(){try{return Boolean(localStorage.getItem(LOCAL_STATE_KEY));}catch(_){return false;}}
  function stateFingerprint(payload=syncableData()){
    const copy={...payload};delete copy.savedAt;
    const text=JSON.stringify(copy);let hash=2166136261;
    for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}
    return `${text.length}-${(hash>>>0).toString(16)}`;
  }
  function cloudPayload(){
    const state=api.state;
    return {
      schemaVersion:1,
      savedAt:new Date().toISOString(),
      profile:JSON.parse(JSON.stringify(state.profile||{})),
      progress:JSON.parse(JSON.stringify(state.progress||{})),
      tasks:JSON.parse(JSON.stringify(state.tasks||{})),
      repertoire:JSON.parse(JSON.stringify(Array.isArray(state.repertoire)?state.repertoire:[])),
      studies:JSON.parse(JSON.stringify(Array.isArray(state.studies)?state.studies:[])),
      drills:JSON.parse(JSON.stringify(Array.isArray(state.drills)?state.drills:[]))
    };
  }
  function refreshIndicator(){
    const button=$('[data-action="cloud-account"]');
    const label=$('#profile-save-status');
    const email=session?.user?.email||'';
    if(button){
      const connected=Boolean(session?.access_token&&session?.user?.id);
      button.classList.toggle('connected',connected);
      button.textContent=connected?'☁✓':'☁';
      button.title=connected?`Cloud sync · ${email}`:(configured()?'Sign in to sync your Squarewise profile':'Set up cloud sync');
      button.setAttribute('aria-label',connected?`Cloud sync active for ${email}`:'Set up sign-in and cloud sync');
    }
    if(label){
      if(conflictPending)label.textContent='Resolve cloud sync choice';
      else if(session?.user?.id)label.textContent=meta.dirty?'Cloud sync pending…':'Cloud sync on';
      else label.textContent=configured()?'Local autosave · cloud sign-in optional':'Local autosave · cloud not configured';
    }
  }
  function renderModal(){
    const root=$('#modal-root');if(!root)return;
    if(conflictPending&&pendingRemote){renderConflict();return;}
    let body='';
    if(showConfig||!configured())body=renderConfigForm();
    else if(session?.user?.id)body=renderAccount();
    else body=renderAuthForm();
    root.innerHTML=`<div class="modal-backdrop" data-action="backdrop-close"><section class="modal-panel cloud-modal" role="dialog" aria-modal="true" aria-labelledby="cloud-title"><div class="modal-head"><div><div class="eyebrow">OPTIONAL · PRIVATE CLOUD SYNC</div><h2 id="cloud-title">${showConfig||!configured()?'Connect Supabase':session?.user?.id?'Your Squarewise account':'Save progress across devices'}</h2><p>${showConfig||!configured()?'Connect your own Supabase project. Local autosave continues either way.':session?.user?.id?'Your training record is linked to your account.':'Create an account or sign in to sync your training record.'}</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Close">×</button></div><div class="cloud-privacy-note"><strong>Your game PGNs stay local.</strong> Cloud sync includes your profile, progress, tasks, repertoire, study notes, and saved drills—not imported PGN files. Passwords are handled by Supabase and are never stored by Squarewise.</div>${notice?`<div class="cloud-message ${noticeType==='error'?'error':noticeType==='success'?'success':''}" role="status">${esc(notice)}</div>`:''}${body}</section></div>`;
    refreshIndicator();
  }
  function renderConfigForm(){
    let host='';try{if(config?.url)host=new URL(config.url).hostname;}catch(_){}
    return `<div class="cloud-config-form"><div class="form-field"><label for="supabase-url">Supabase project URL</label><input id="supabase-url" type="url" inputmode="url" autocomplete="url" value="${esc(config?.url||'')}" placeholder="https://your-project.supabase.co"></div><div class="form-field"><label for="supabase-key">Publishable / anon key</label><input id="supabase-key" type="password" autocomplete="off" value="${esc(config?.anonKey||'')}" placeholder="Paste the public client key"></div><p class="cloud-help">In Supabase, find these under <strong>Project Settings → API</strong>. Use the public publishable/anon key only—never the service-role secret. Run the SQL in <code>SUPABASE_SETUP.md</code> before signing in.</p>${host?`<p class="cloud-help">Current project host: ${esc(host)}</p>`:''}<div class="cloud-actions"><button class="quiet-button" data-cloud-action="cancel-config" ${configured()?'':'hidden'}>Back</button><button class="primary-button" data-cloud-action="save-config" ${busy?'disabled':''}>Save project settings</button></div></div>`;
  }
  function renderAuthForm(){
    const signingUp=authMode==='signup';
    return `<div class="cloud-mode-tabs"><button class="${!signingUp?'active':''}" data-cloud-action="set-mode" data-mode="signin">Sign in</button><button class="${signingUp?'active':''}" data-cloud-action="set-mode" data-mode="signup">Create account</button></div><div class="form-field"><label for="cloud-email">Email</label><input id="cloud-email" type="email" autocomplete="email" placeholder="you@example.com"></div><div class="form-field"><label for="cloud-password">Password</label><input id="cloud-password" type="password" autocomplete="${signingUp?'new-password':'current-password'}" placeholder="${signingUp?'At least 8 characters':'Your password'}"></div><p class="cloud-help">${signingUp?'Supabase may email you a confirmation link before your first sign-in.':'Your password is sent directly to your configured Supabase project over HTTPS.'}</p><div class="cloud-actions"><button class="quiet-button" data-cloud-action="edit-config">Project settings</button><button class="primary-button" data-cloud-action="${signingUp?'signup':'signin'}" ${busy?'disabled':''}>${busy?'Please wait…':signingUp?'Create account':'Sign in and sync'}</button></div>${!signingUp?`<button class="cloud-link" data-cloud-action="reset-password" ${busy?'disabled':''}>Forgot password?</button>`:''}`;
  }
  function renderAccount(){
    const email=session?.user?.email||'Signed-in user';
    const syncLabel=conflictPending?'Needs your choice':meta.dirty?'Sync pending':'Up to date';
    return `<div class="cloud-account-card"><div class="cloud-account-icon">☁</div><div><strong>${esc(email)}</strong><span>${esc(syncLabel)}</span></div></div><p class="cloud-help">Your profile and training records are protected by your Supabase account’s row-level security. Imported PGN files remain local to this browser.</p><div class="cloud-actions"><button class="quiet-button" data-cloud-action="edit-config">Project settings</button><button class="outline-button" data-cloud-action="sync-now" ${busy?'disabled':''}>Sync now</button><button class="primary-button" data-cloud-action="signout" ${busy?'disabled':''}>Sign out</button></div>`;
  }
  function renderConflict(){
    const hasCloudCopy=Boolean(pendingRemote);
    const title=hasCloudCopy?'Choose which copy to use':'Start a new cloud profile?';
    const description=hasCloudCopy?'This account already has a cloud save, and this browser also has local data that has not been confirmed as synced.':'This account has no Squarewise cloud save yet, but this browser has data linked to a different account. Choose before carrying that data over.';
    $('#modal-root').innerHTML=`<div class="modal-backdrop"><section class="modal-panel cloud-modal" role="dialog" aria-modal="true" aria-labelledby="cloud-conflict-title"><div class="modal-head"><div><div class="eyebrow">KEEP YOUR DATA SAFE</div><h2 id="cloud-conflict-title">${title}</h2><p>${description}</p></div></div><div class="cloud-privacy-note"><strong>Imported PGNs are not part of this choice.</strong> They stay on this device. This choice covers profile settings, progress, tasks, repertoire, study notes, and saved drills.</div><div class="cloud-actions cloud-conflict-actions"><button class="outline-button" data-cloud-action="use-local">${hasCloudCopy?'Upload this device’s synced data':'Copy this device’s synced data to this account'}</button>${hasCloudCopy?'<button class="primary-button" data-cloud-action="use-cloud">Use the cloud copy on this device</button>':''}</div><button class="cloud-link" data-cloud-action="signout">Cancel and sign out</button></section></div>`;
  }
  function openModal(){
    notice='';noticeType='';showConfig=!configured();authMode='signin';
    renderModal();
  }
  function showNotice(message,type=''){
    notice=message;noticeType=type;
    if($('#cloud-title'))renderModal();
    if(type==='success')api.showToast(message);
  }
  async function parseResponse(response){
    const raw=await response.text();let data={};
    try{data=raw?JSON.parse(raw):{};}catch(_){throw new Error('Supabase returned an unreadable response. Check your project URL and preview connection.');}
    if(!response.ok){
      const message=data.msg||data.message||data.error_description||data.error||data.hint||`Supabase request failed (${response.status}).`;
      if(response.status===404&&String(message).toLowerCase().includes('squarewise_data'))throw new Error('Cloud table missing. Run the SQL from SUPABASE_SETUP.md in your Supabase SQL Editor.');
      throw new Error(String(message));
    }
    return data;
  }
  async function authRequest(path,body){
    if(!configured())throw new Error('Set up your Supabase project first.');
    const response=await fetch(`${normalizedUrl(config.url)}${path}`,{method:'POST',headers:{'Content-Type':'application/json','apikey':config.anonKey},body:JSON.stringify(body)});
    return parseResponse(response);
  }
  function saveSession(data){
    if(!data?.access_token||!data?.user?.id)throw new Error('Supabase did not return a valid sign-in session.');
    const expiresAt=Number(data.expires_at)?Number(data.expires_at)*1000:Date.now()+(Number(data.expires_in)||3600)*1000;
    session={access_token:data.access_token,refresh_token:data.refresh_token||'',expires_at:expiresAt,user:data.user};
    writeJson(SESSION_KEY,session);refreshIndicator();
  }
  function clearSession(){session=null;localStorage.removeItem(SESSION_KEY);conflictPending=false;pendingRemote=null;refreshIndicator();}
  async function refreshSession(){
    if(!session?.refresh_token)throw new Error('Your cloud session expired. Please sign in again.');
    const data=await authRequest('/auth/v1/token?grant_type=refresh_token',{refresh_token:session.refresh_token});
    saveSession(data);return session;
  }
  async function accessToken(){
    if(!session?.access_token)throw new Error('Please sign in first.');
    if(Number(session.expires_at||0)<Date.now()+60_000)await refreshSession();
    return session.access_token;
  }
  async function protectedFetch(url,options={},retry=true){
    const token=await accessToken();
    const headers={...(options.headers||{}),apikey:config.anonKey,Authorization:`Bearer ${token}`};
    const response=await fetch(url,{...options,headers});
    if(response.status===401&&retry){await refreshSession();return protectedFetch(url,options,false);}
    return response;
  }
  function syncableData(){
    const s=api.state;
    return {
      schemaVersion:1,
      savedAt:new Date().toISOString(),
      profile:JSON.parse(JSON.stringify(s.profile||{})),
      progress:JSON.parse(JSON.stringify(s.progress||{})),
      tasks:JSON.parse(JSON.stringify(s.tasks||{})),
      repertoire:JSON.parse(JSON.stringify(Array.isArray(s.repertoire)?s.repertoire:[])),
      studies:JSON.parse(JSON.stringify(Array.isArray(s.studies)?s.studies:[])),
      drills:JSON.parse(JSON.stringify(Array.isArray(s.drills)?s.drills:[]))
    };
  }
  async function fetchRemote(){
    const id=encodeURIComponent(session.user.id);
    const url=`${normalizedUrl(config.url)}/rest/v1/${TABLE}?select=payload,updated_at&user_id=eq.${id}`;
    const response=await protectedFetch(url,{headers:{Accept:'application/json'}});
    const rows=await parseResponse(response);
    return Array.isArray(rows)&&rows.length?rows[0]:null;
  }
  async function writeRemote(payload=syncableData()){
    const now=new Date().toISOString();payload={...payload,savedAt:now};
    const row={user_id:session.user.id,payload,updated_at:now};
    const url=`${normalizedUrl(config.url)}/rest/v1/${TABLE}?on_conflict=user_id`;
    const response=await protectedFetch(url,{method:'POST',headers:{'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(row)});
    await parseResponse(response);
    return now;
  }
  function saveLocalStateQuietly(){
    applyingRemote=true;
    try{api.persist();}finally{applyingRemote=false;}
  }
  function applyRemote(payload){
    if(!payload||payload.schemaVersion!==1)throw new Error('This cloud save uses an unsupported data version. Update Squarewise before syncing.');
    const s=api.state,page=s.page;
    if(payload.profile)s.profile={...s.profile,...payload.profile};
    if(payload.progress)s.progress={...s.progress,...payload.progress};
    if(payload.tasks)s.tasks={...s.tasks,...payload.tasks};
    if(Array.isArray(payload.repertoire))s.repertoire=payload.repertoire;
    if(Array.isArray(payload.studies))s.studies=payload.studies;
    if(Array.isArray(payload.drills))s.drills=payload.drills;
    s.demo=false;s.page=page;
    saveMeta({userId:session.user.id,dirty:false,lastSyncedAt:payload.savedAt||new Date().toISOString(),fingerprint:stateFingerprint()});
    saveLocalStateQuietly();api.render();
  }
  function makeBackup(){
    try{
      const raw=localStorage.getItem(LOCAL_STATE_KEY);
      if(raw)localStorage.setItem(`squarewise-before-cloud-${Date.now()}`,raw);
    }catch(_){/* Existing local state remains in the main storage key until replaced. */}
  }
  function isLocalCopyAvailable(){return localStateSaved();}
  async function reconcileLogin(){
    if(!session?.user?.id)return;
    const remote=await fetchRemote();
    const switchingAccount=Boolean(meta.userId&&meta.userId!==session.user.id&&isLocalCopyAvailable());
    if(switchingAccount&&!remote){pendingRemote=null;conflictPending=true;refreshIndicator();renderConflict();return;}
    if(!remote){
      if(api.state.demo)api.clearIllustrativeData();
      const payload=syncableData();await writeRemote(payload);
      saveMeta({userId:session.user.id,dirty:false,lastSyncedAt:new Date().toISOString(),fingerprint:stateFingerprint(payload)});
      saveLocalStateQuietly();api.render();
      showNotice('Account connected. Your training data is now syncing.','success');
      return;
    }
    if(meta.dirty||switchingAccount){
      pendingRemote=remote.payload;conflictPending=true;refreshIndicator();renderConflict();return;
    }
    applyRemote(remote.payload);
    notice='Cloud profile loaded on this device.';noticeType='success';
  }
  async function completeSignIn(data){
    saveSession(data);meta=readJson(META_KEY,{userId:'',dirty:false,lastSyncedAt:''})||{userId:'',dirty:false,lastSyncedAt:''};
    await reconcileLogin();
    if(!conflictPending){renderModal();if(noticeType==='success')api.showToast(notice);}
  }
  async function doSignIn(){
    const email=$('#cloud-email')?.value.trim()||'',password=$('#cloud-password')?.value||'';
    if(!email||!password){showNotice('Enter your email and password.','error');return;}
    busy=true;notice='Signing in…';noticeType='';renderModal();
    try{const data=await authRequest('/auth/v1/token?grant_type=password',{email,password});await completeSignIn(data);}
    catch(error){busy=false;showNotice(error.message||'Sign-in failed. Check the email and password.','error');renderModal();}
    finally{busy=false;refreshIndicator();}
  }
  async function doSignUp(){
    const email=$('#cloud-email')?.value.trim()||'',password=$('#cloud-password')?.value||'';
    if(!email||!password){showNotice('Enter an email and choose a password.','error');return;}
    if(password.length<8){showNotice('Use a password with at least 8 characters.','error');return;}
    busy=true;notice='Creating your account…';noticeType='';renderModal();
    try{
      const data=await authRequest('/auth/v1/signup',{email,password,data:{display_name:api.state.profile.name||'Chess Player'}});
      if(data.access_token&&data.user?.id){await completeSignIn(data);}
      else{authMode='signin';notice='Account created. Check your email for Supabase’s confirmation link, then sign in here.';noticeType='success';}
    }catch(error){notice=error.message||'Account creation failed.';noticeType='error';}
    finally{busy=false;renderModal();refreshIndicator();}
  }
  async function resetPassword(){
    const email=$('#cloud-email')?.value.trim()||'';
    if(!email){showNotice('Enter your email first so Supabase knows where to send the reset link.','error');return;}
    busy=true;renderModal();
    try{
      const resetTarget=new URL(window.location.href);
      resetTarget.search='';resetTarget.hash='';
      const redirect=encodeURIComponent(resetTarget.href);
      await authRequest(`/auth/v1/recover?redirect_to=${redirect}`,{email});
      notice='If that email belongs to an account, Supabase will send a password-reset link.';noticeType='success';
    }catch(error){notice=error.message||'Could not request a password reset.';noticeType='error';}
    finally{busy=false;renderModal();}
  }
  async function signOut(){
    const old=session;
    busy=true;refreshIndicator();
    try{
      if(old?.access_token&&configured()){
        await fetch(`${normalizedUrl(config.url)}/auth/v1/logout`,{method:'POST',headers:{apikey:config.anonKey,Authorization:`Bearer ${old.access_token}`}}).catch(()=>{});
      }
    }finally{
      clearSession();saveMeta({dirty:false});busy=false;notice='Signed out. This device’s local save is still available.';noticeType='success';renderModal();api.showToast(notice);
    }
  }
  function localReset(){
    const old=session;clearTimeout(syncTimer);conflictPending=false;pendingRemote=null;clearSession();saveMeta({dirty:false});
    if(old?.access_token&&configured())fetch(`${normalizedUrl(config.url)}/auth/v1/logout`,{method:'POST',headers:{apikey:config.anonKey,Authorization:`Bearer ${old.access_token}`}}).catch(()=>{});
  }
  async function uploadCurrent({quiet=false}={}){
    if(!session?.user?.id)return false;
    if(syncPromise)return syncPromise;
    const startedAt=revision;
    syncPromise=(async()=>{
      try{
        const payload=syncableData(),uploadedFingerprint=stateFingerprint(payload);
        await writeRemote(payload);
        const changedDuringUpload=revision!==startedAt;
        saveMeta({userId:session.user.id,dirty:changedDuringUpload,lastSyncedAt:new Date().toISOString(),fingerprint:uploadedFingerprint});
        if(!quiet)api.showToast(changedDuringUpload?'Cloud saved; syncing the latest edit…':'Cloud progress saved.');
        if(changedDuringUpload)scheduleSync(200);
        return true;
      }catch(error){
        saveMeta({userId:session.user.id,dirty:true});
        if(!quiet)api.showToast(`Cloud sync failed; local save is safe. ${error.message||''}`);
        else if(!meta.errorShown){meta.errorShown=true;writeJson(META_KEY,meta);}
        return false;
      }finally{syncPromise=null;}
    })();
    return syncPromise;
  }
  async function syncNow({quiet=false}={}){
    if(!session?.user?.id){if(!quiet)api.showToast('Sign in to sync this profile.');return false;}
    if(conflictPending){if(!quiet)renderConflict();return false;}
    busy=true;if($('#cloud-title'))renderModal();
    const ok=await uploadCurrent({quiet});
    busy=false;if($('#cloud-title'))renderModal();
    return ok;
  }
  function scheduleSync(delay=1300){
    clearTimeout(syncTimer);syncTimer=setTimeout(()=>syncNow({quiet:true}),delay);
  }
  function onLocalChange(){
    if(applyingRemote)return;
    const currentFingerprint=stateFingerprint();
    if(!meta.fingerprint){saveMeta({fingerprint:currentFingerprint});return;}
    if(currentFingerprint===meta.fingerprint)return;
    revision++;saveMeta({userId:session?.user?.id||meta.userId||'',dirty:true});
    if(session?.user?.id&&!conflictPending)scheduleSync();
  }
  function initializeFingerprint(){
    if(!meta.fingerprint){
      meta={...meta,fingerprint:stateFingerprint(),dirty:Boolean(meta.dirty||localStateSaved())};
      writeJson(META_KEY,meta);
    }
  }
  async function useCloudCopy(){
    if(!pendingRemote)return;
    try{makeBackup();const copy=pendingRemote;pendingRemote=null;conflictPending=false;applyRemote(copy);notice='Cloud copy loaded. A device backup was kept when storage allowed.';noticeType='success';renderModal();api.showToast('Cloud profile restored on this device.');}
    catch(error){notice=error.message||'Could not apply the cloud copy.';noticeType='error';renderConflict();}
  }
  async function useLocalCopy(){
    pendingRemote=null;conflictPending=false;saveMeta({userId:session.user.id,dirty:true});
    const ok=await syncNow({quiet:false});
    if(ok){notice='This device’s synced data has replaced the cloud copy.';noticeType='success';renderModal();}
    else{notice='Could not upload this device’s copy. Local autosave is safe; check the project setup and retry.';noticeType='error';renderModal();}
  }
  function validateConfig(){
    const url=normalizedUrl($('#supabase-url')?.value||'');
    const key=$('#supabase-key')?.value.trim()||'';
    if(!url||!key)throw new Error('Enter both the Supabase project URL and its public anon/publishable key.');
    let parsed;try{parsed=new URL(url);}catch(_){throw new Error('Enter a valid Supabase project URL, including https://.');}
    if(!['https:','http:'].includes(parsed.protocol))throw new Error('The Supabase URL must use HTTPS (HTTP is allowed only for local development).');
    if(parsed.protocol==='http:'&&!['localhost','127.0.0.1'].includes(parsed.hostname))throw new Error('Use HTTPS for a remote Supabase project.');
    if(/service[_-]?role|sb_secret_/i.test(key))throw new Error('Do not use the Supabase service-role/secret key. Use the public anon/publishable key.');
    return{url,anonKey:key};
  }
  function handleCloudAction(action,element){
    if(action==='save-config'){
      try{config=validateConfig();writeJson(CONFIG_KEY,config);showConfig=false;notice='Supabase project settings saved on this device.';noticeType='success';renderModal();}
      catch(error){notice=error.message;noticeType='error';renderModal();}
      return;
    }
    if(action==='cancel-config'){showConfig=false;notice='';noticeType='';renderModal();return;}
    if(action==='edit-config'){showConfig=true;notice='';noticeType='';renderModal();return;}
    if(action==='set-mode'){authMode=element.dataset.mode==='signup'?'signup':'signin';notice='';noticeType='';renderModal();return;}
    if(action==='signin'){doSignIn();return;}
    if(action==='signup'){doSignUp();return;}
    if(action==='reset-password'){resetPassword();return;}
    if(action==='signout'){signOut();return;}
    if(action==='sync-now'){syncNow({quiet:false});return;}
    if(action==='use-cloud'){useCloudCopy();return;}
    if(action==='use-local'){useLocalCopy();return;}
  }
  async function resumeSession(){
    if(!session?.user?.id||!configured())return;
    try{
      await accessToken();
      await reconcileLogin();
      if(!conflictPending){refreshIndicator();}
    }catch(error){
      notice=error.message||'Cloud reconnect failed; local autosave is still available.';noticeType='error';
      if(/session expired|sign in again/i.test(notice))clearSession();
      refreshIndicator();
    }
  }

  window.SquarewiseCloud={
    onLocalChange,
    refreshIndicator,
    isSignedIn:()=>Boolean(session?.user?.id),
    signOut,
    localReset,
    syncNow:()=>syncNow({quiet:false})
  };
  document.addEventListener('click',event=>{
    const account=event.target.closest?.('[data-action="cloud-account"]');
    if(account){event.preventDefault();openModal();return;}
    const action=event.target.closest?.('[data-cloud-action]');
    if(action){event.preventDefault();handleCloudAction(action.dataset.cloudAction,action);}
  });
  initializeFingerprint();
  refreshIndicator();
  resumeSession();
})();
